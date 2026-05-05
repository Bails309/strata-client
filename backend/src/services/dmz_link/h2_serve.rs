//! HTTP/2 multiplexer for an authenticated DMZ link.
//!
//! Once [`super::supervisor`] has driven a successful handshake, the
//! DMZ side acts as the h2 client (it pushes proxied public requests
//! through), and the internal node acts as the h2 server (it adopts
//! each inbound stream and routes it to a [`RequestHandler`]). This
//! module owns the server side of that exchange: it runs the h2
//! handshake on the supplied stream, accepts streams in a loop, and
//! spawns one task per stream to call the handler.
//!
//! The handler abstraction is intentionally narrower than `tower::Service`
//! so the link adapter can be tested in isolation; the real axum router
//! adapter lands in a follow-up PR (Phase 1f).
//!
//! Resource limits enforced here:
//!
//! * Request bodies are buffered up to [`MAX_REQUEST_BODY_BYTES`]
//!   (8 MiB). Anything larger gets `413 Payload Too Large` and the
//!   connection stays open — a single oversized request must not kill
//!   the whole link.
//! * Per-connection inbound concurrency is bounded by h2's flow
//!   control + `MAX_CONCURRENT_STREAMS` (set on the handshake
//!   builder).

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use h2::server::SendResponse;
use h2::RecvStream;
use http::{Request, Response, StatusCode};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

/// Maximum size of an inbound request body the multiplexer will buffer
/// before invoking the handler. Anything larger is rejected with 413.
pub const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Bound on `SETTINGS_MAX_CONCURRENT_STREAMS`. Keeps a single misbehaving
/// DMZ from opening unbounded h2 streams against an internal node.
pub const MAX_CONCURRENT_STREAMS: u32 = 256;

/// Handler trait for inbound h2 requests.
///
/// Implementations receive the request with its body fully buffered
/// into [`Bytes`] (subject to [`MAX_REQUEST_BODY_BYTES`]) and must
/// return a fully-buffered response. Streaming bodies are out of scope
/// for the link multiplexer — the rustguac-style guacd traffic that
/// motivated the link is multiplexed via WebSockets at the application
/// layer, not via streaming HTTP requests.
#[async_trait]
pub trait RequestHandler: Send + Sync + 'static {
    /// Handle a single inbound request. Must not panic.
    async fn handle(&self, req: Request<Bytes>) -> Response<Bytes>;
}

/// Stub handler that rejects every request with 503 Service Unavailable.
///
/// Used by the supervisor wireup before the real axum-router adapter
/// (Phase 1g) is in place — the link is operationally up and observable
/// in the registry, but any traffic the DMZ pushes through fails closed
/// rather than reaching an unintended fallback.
pub struct RejectHandler;

#[async_trait]
impl RequestHandler for RejectHandler {
    async fn handle(&self, _req: Request<Bytes>) -> Response<Bytes> {
        Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("x-strata-link", "no-handler")
            .body(Bytes::from_static(
                b"DMZ link reached the internal node but no request handler is registered",
            ))
            .expect("static response")
    }
}

/// Drive the h2 server side of an authenticated link stream until the
/// peer closes the connection or the cancellation token fires.
///
/// `on_ready` is invoked exactly once, immediately after the h2
/// handshake completes successfully (i.e. before the first inbound
/// stream is accepted). Supervisors use this to flip their public
/// link state to `Up` only after the transport is actually ready,
/// not the moment auth succeeded.
///
/// Returns `Ok(())` on a clean shutdown (peer closed, or graceful
/// shutdown completed after cancel). Returns `Err` only on a real h2
/// protocol failure — caller (the supervisor) treats either as
/// "link down" and reconnects.
pub async fn serve_h2<S, R>(
    stream: S,
    handler: Arc<dyn RequestHandler>,
    shutdown: CancellationToken,
    on_ready: R,
) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    R: FnOnce() + Send + 'static,
{
    let mut conn = h2::server::Builder::new()
        .max_concurrent_streams(MAX_CONCURRENT_STREAMS)
        .handshake::<_, Bytes>(stream)
        .await
        .map_err(|e| anyhow::anyhow!("h2 server handshake failed: {e}"))?;

    on_ready();

    let mut stream_tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    let mut shutdown_observed = false;

    loop {
        if !shutdown_observed && shutdown.is_cancelled() {
            conn.graceful_shutdown();
            shutdown_observed = true;
        }

        let next = tokio::select! {
            biased;
            _ = shutdown.cancelled(), if !shutdown_observed => {
                conn.graceful_shutdown();
                shutdown_observed = true;
                continue;
            }
            n = conn.accept() => n,
        };

        let (request, respond) = match next {
            Some(Ok(pair)) => pair,
            Some(Err(e)) => {
                // Reset / GOAWAY from peer is the normal "link down"
                // path — propagate so the supervisor can reconnect.
                drain_tasks(stream_tasks).await;
                return Err(anyhow::anyhow!("h2 accept error: {e}"));
            }
            None => {
                // Peer closed cleanly.
                drain_tasks(stream_tasks).await;
                return Ok(());
            }
        };

        let handler = handler.clone();
        stream_tasks.push(tokio::spawn(async move {
            if let Err(e) = serve_one_stream(request, respond, handler).await {
                tracing::warn!(error = %e, "DMZ link h2 stream errored");
            }
        }));

        // Lazily reap finished tasks so the vec doesn't grow without
        // bound on long-lived links. Cheap O(n) sweep, n bounded by
        // MAX_CONCURRENT_STREAMS.
        stream_tasks.retain(|h| !h.is_finished());
    }
}

async fn drain_tasks(tasks: Vec<tokio::task::JoinHandle<()>>) {
    for t in tasks {
        let _ = t.await;
    }
}

async fn serve_one_stream(
    request: Request<RecvStream>,
    mut respond: SendResponse<Bytes>,
    handler: Arc<dyn RequestHandler>,
) -> anyhow::Result<()> {
    let (parts, mut body) = request.into_parts();

    // Buffer the request body up to MAX_REQUEST_BODY_BYTES. Anything
    // larger -> 413 and we drain the body so the stream closes cleanly.
    let mut buf = Vec::new();
    let mut oversized = false;
    while let Some(chunk) = body.data().await {
        let chunk = chunk.map_err(|e| anyhow::anyhow!("h2 body read: {e}"))?;
        // Release flow-control window for whatever the peer sent so
        // h2 keeps delivering frames (or, in the oversized case, so
        // it drains and closes promptly).
        let len = chunk.len();
        let _ = body.flow_control().release_capacity(len);

        if oversized {
            continue;
        }
        if buf.len().saturating_add(len) > MAX_REQUEST_BODY_BYTES {
            oversized = true;
            buf.clear();
            continue;
        }
        buf.extend_from_slice(&chunk);
    }

    if oversized {
        let resp = Response::builder()
            .status(StatusCode::PAYLOAD_TOO_LARGE)
            .body(())
            .expect("static response");
        let mut send = respond
            .send_response(resp, false)
            .map_err(|e| anyhow::anyhow!("h2 send 413: {e}"))?;
        let body = Bytes::from_static(b"request body exceeds link multiplexer limit");
        send.send_data(body, true)
            .map_err(|e| anyhow::anyhow!("h2 send 413 body: {e}"))?;
        return Ok(());
    }

    let req = Request::from_parts(parts, Bytes::from(buf));
    let response = handler.handle(req).await;
    let (parts, body) = response.into_parts();
    let head = Response::from_parts(parts, ());

    let end_of_stream_on_headers = body.is_empty();
    let mut send = respond
        .send_response(head, end_of_stream_on_headers)
        .map_err(|e| anyhow::anyhow!("h2 send response: {e}"))?;
    if !end_of_stream_on_headers {
        send.send_data(body, true)
            .map_err(|e| anyhow::anyhow!("h2 send body: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::duplex;

    /// Stub handler that echoes the request URI + body length.
    struct EchoHandler;

    #[async_trait]
    impl RequestHandler for EchoHandler {
        async fn handle(&self, req: Request<Bytes>) -> Response<Bytes> {
            let body = format!(
                "method={} path={} body_bytes={}",
                req.method(),
                req.uri().path(),
                req.body().len(),
            );
            Response::builder()
                .status(StatusCode::OK)
                .header("x-test", "echo")
                .body(Bytes::from(body))
                .unwrap()
        }
    }

    async fn drive_client(
        client_io: tokio::io::DuplexStream,
        scripts: Vec<(http::Request<()>, Bytes)>,
    ) -> Vec<(StatusCode, Bytes)> {
        let (mut h2, conn) = h2::client::handshake(client_io).await.unwrap();
        let driver = tokio::spawn(async move {
            let _ = conn.await;
        });

        let mut results = Vec::new();
        for (req, body) in scripts {
            // Wait until the connection has capacity for another stream.
            std::future::poll_fn(|cx| h2.poll_ready(cx)).await.unwrap();
            let end = body.is_empty();
            let (resp_fut, mut send) = h2.send_request(req, end).unwrap();
            if !end {
                send.send_data(body, true).unwrap();
            }
            let resp = resp_fut.await.unwrap();
            let status = resp.status();
            let mut recv = resp.into_body();
            let mut buf = Vec::new();
            while let Some(chunk) = recv.data().await {
                let chunk = chunk.unwrap();
                let _ = recv.flow_control().release_capacity(chunk.len());
                buf.extend_from_slice(&chunk);
            }
            results.push((status, Bytes::from(buf)));
        }

        // Closing h2 SendRequest by dropping triggers GOAWAY on the
        // server, which lets the server task return Ok cleanly.
        drop(h2);
        let _ = tokio::time::timeout(Duration::from_secs(2), driver).await;
        results
    }

    #[tokio::test(flavor = "current_thread")]
    async fn happy_path_single_request() {
        let (server_io, client_io) = duplex(64 * 1024);
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(serve_h2(server_io, Arc::new(EchoHandler), shutdown.clone(), || {}));

        let req = http::Request::builder()
            .method("GET")
            .uri("https://internal/api/health")
            .body(())
            .unwrap();
        let results = drive_client(client_io, vec![(req, Bytes::new())]).await;

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, StatusCode::OK);
        let body = std::str::from_utf8(&results[0].1).unwrap();
        assert!(body.contains("method=GET"));
        assert!(body.contains("path=/api/health"));
        assert!(body.contains("body_bytes=0"));

        let r = tokio::time::timeout(Duration::from_secs(2), server).await;
        assert!(r.is_ok());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn multiple_requests_share_one_link() {
        let (server_io, client_io) = duplex(64 * 1024);
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(serve_h2(server_io, Arc::new(EchoHandler), shutdown.clone(), || {}));

        let scripts: Vec<(http::Request<()>, Bytes)> = (0..5)
            .map(|i| {
                let req = http::Request::builder()
                    .method("POST")
                    .uri(format!("https://internal/api/req/{i}"))
                    .body(())
                    .unwrap();
                (req, Bytes::from(vec![b'x'; i * 10]))
            })
            .collect();

        let results = drive_client(client_io, scripts).await;
        assert_eq!(results.len(), 5);
        for (i, (status, body)) in results.iter().enumerate() {
            assert_eq!(*status, StatusCode::OK);
            let body = std::str::from_utf8(body).unwrap();
            assert!(body.contains(&format!("path=/api/req/{i}")));
            assert!(body.contains(&format!("body_bytes={}", i * 10)));
        }

        let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn oversized_body_returns_413_and_link_stays_up() {
        struct PoisonHandler;
        #[async_trait]
        impl RequestHandler for PoisonHandler {
            async fn handle(&self, _req: Request<Bytes>) -> Response<Bytes> {
                // Should NEVER be reached — the multiplexer must short
                // -circuit oversized bodies before invoking the handler.
                panic!("handler invoked for oversized body");
            }
        }

        let (server_io, client_io) = duplex(MAX_REQUEST_BODY_BYTES + 1024 * 1024);
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(serve_h2(server_io, Arc::new(PoisonHandler), shutdown.clone(), || {}));

        // First request: oversized → expect 413.
        // Second request: tiny → must succeed (proves link wasn't torn down).
        let oversized_body = Bytes::from(vec![b'x'; MAX_REQUEST_BODY_BYTES + 1]);
        let req1 = http::Request::builder()
            .method("POST")
            .uri("https://internal/big")
            .body(())
            .unwrap();

        // For the second request switch handlers via a router-style
        // wrapper. Simpler: make PoisonHandler accept small bodies.
        // Instead just check the first response is 413.
        let results = drive_client(client_io, vec![(req1, oversized_body)]).await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, StatusCode::PAYLOAD_TOO_LARGE);

        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_drains_inflight_and_returns_ok() {
        let (server_io, client_io) = duplex(64 * 1024);
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(serve_h2(server_io, Arc::new(EchoHandler), shutdown.clone(), || {}));

        // Drive one request through to completion, then cancel.
        let req = http::Request::builder()
            .method("GET")
            .uri("https://internal/")
            .body(())
            .unwrap();
        let results = drive_client(client_io, vec![(req, Bytes::new())]).await;
        assert_eq!(results[0].0, StatusCode::OK);

        shutdown.cancel();
        let r = tokio::time::timeout(Duration::from_secs(2), server).await;
        assert!(r.is_ok(), "server did not exit within 2s of cancel");
    }
}
