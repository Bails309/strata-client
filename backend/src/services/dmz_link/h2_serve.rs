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
//! so the link adapter can be tested in isolation; production uses
//! [`super::RouterHandler`].
//!
//! Bodies stream in both directions (PERF-02); nothing buffers a whole
//! request or response. Resource limits enforced here:
//!
//! * Unread request body is bounded by h2 flow control: at most
//!   [`STREAM_WINDOW`] per stream and [`CONNECTION_WINDOW`] across the
//!   link. Window is released only as the handler consumes the body, so
//!   a slow consumer slows the sender instead of growing memory.
//! * Request bodies over [`MAX_REQUEST_BODY_BYTES`] are refused: with
//!   `413` up front when `Content-Length` declares it, otherwise by
//!   failing the body and resetting the stream as soon as the limit is
//!   crossed. Routes apply their own, smaller limits; the handler sees
//!   the request head first, so authentication runs before any body is
//!   read and an early response resets the stream instead of draining it.
//! * Response bodies are sent only as the peer grants window.
//! * A body that makes no progress for [`BODY_IDLE_TIMEOUT`], or a stream
//!   open longer than [`STREAM_DEADLINE`], is reset.
//! * Per-connection concurrency is bounded by `MAX_CONCURRENT_STREAMS`.
//! * Request trailers are not passed to the handler; response trailers
//!   are forwarded.

use std::future::poll_fn;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use bytes::Bytes;
use h2::server::SendResponse;
use h2::{RecvStream, SendStream};
use http::{Request, Response, StatusCode};
use http_body_util::BodyExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

use super::upgrade_handler::{is_websocket_extended_connect, UpgradeHandler};

/// Largest request body the link carries. Above the biggest route limit
/// (500 MiB uploads) with room for multipart overhead.
pub const MAX_REQUEST_BODY_BYTES: u64 = 512 * 1024 * 1024;

/// Bound on `SETTINGS_MAX_CONCURRENT_STREAMS`. Keeps a single misbehaving
/// DMZ from opening unbounded h2 streams against an internal node.
pub const MAX_CONCURRENT_STREAMS: u32 = 256;

/// Request body a stream may have in flight before its handler reads it.
pub const STREAM_WINDOW: u32 = 1024 * 1024;

/// Request body all streams on the link may have in flight together.
pub const CONNECTION_WINDOW: u32 = 16 * 1024 * 1024;

/// Longest a request or response body may go without progress.
pub const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Longest a regular (non-WebSocket) stream may stay open.
pub const STREAM_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// Handler trait for inbound h2 requests. The request body streams from
/// the link as the handler reads it; the response body is streamed back.
#[async_trait]
pub trait RequestHandler: Send + Sync + 'static {
    /// Handle a single inbound request. Must not panic.
    async fn handle(&self, req: Request<Body>) -> Response<Body>;
}

/// Stub handler that rejects every request with 503 Service Unavailable.
///
/// Used by the supervisor wireup before the real axum-router adapter
/// (Phase 1g) is in place — the link is operationally up and observable
/// in the registry, but any traffic the DMZ pushes through fails closed
/// rather than reaching an unintended fallback.
#[allow(dead_code)]
pub struct RejectHandler;

#[async_trait]
impl RequestHandler for RejectHandler {
    async fn handle(&self, _req: Request<Body>) -> Response<Body> {
        Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("x-strata-link", "no-handler")
            .body(Body::from(
                "DMZ link reached the internal node but no request handler is registered",
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
    upgrade: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
    on_ready: R,
) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    R: FnOnce() + Send + 'static,
{
    let mut builder = h2::server::Builder::new();
    builder
        .max_concurrent_streams(MAX_CONCURRENT_STREAMS)
        .initial_window_size(STREAM_WINDOW)
        .initial_connection_window_size(CONNECTION_WINDOW);
    // RFC 8441 Extended CONNECT — required so the DMZ side can
    // multiplex WebSocket upgrades over the same h2 link as REST
    // traffic. Without this, the peer is told `:protocol` is
    // unsupported and websocket forwarding falls back to a 503.
    builder.enable_connect_protocol();
    let mut conn = builder
        .handshake::<_, Bytes>(stream)
        .await
        .map_err(|e| anyhow::anyhow!("h2 server handshake failed: {e}"))?;

    on_ready();

    // Active liveness probe: drive an h2 PING every PING_INTERVAL with
    // a PING_TIMEOUT deadline. If the peer fails to respond in time
    // we cancel the supplied `shutdown` token, which both (a) makes
    // the main loop initiate a graceful shutdown of `conn` and
    // (b) — because the supervisor passes its per-cycle token here —
    // causes the supervisor to redial. Without this, a half-open
    // TCP socket (DMZ container restart, NAT rebind, firewall reload)
    // can leave the link "Up" against a dead peer until TCP keepalive
    // eventually surfaces it; the PING shortens that window to tens
    // of seconds even in environments where keepalive is filtered.
    let ping_task = conn.ping_pong().map(|pp| {
        let tok = shutdown.clone();
        tokio::spawn(ping_watchdog(pp, tok))
    });

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
                if let Some(t) = ping_task {
                    t.abort();
                }
                drain_tasks(stream_tasks).await;
                return Err(anyhow::anyhow!("h2 accept error: {e}"));
            }
            None => {
                // Peer closed cleanly.
                if let Some(t) = ping_task {
                    t.abort();
                }
                drain_tasks(stream_tasks).await;
                return Ok(());
            }
        };

        let handler = handler.clone();
        let upgrade = upgrade.clone();
        stream_tasks.push(tokio::spawn(async move {
            if is_websocket_extended_connect(&request) {
                // WebSocket bridges are intentionally long-lived; the
                // upgrade handler owns its own idle/keepalive logic
                // and we must not bound it from the outside.
                if let Err(e) = upgrade.handle(request, respond).await {
                    let err_str = e.to_string();
                    tracing::warn!("DMZ link h2 upgrade stream errored: {}", err_str);
                }
            } else {
                // Bodies have their own idle deadline; this bounds how
                // long one stream can hold a slot against
                // MAX_CONCURRENT_STREAMS. Dropping the stream on expiry
                // resets it.
                match tokio::time::timeout(
                    STREAM_DEADLINE,
                    serve_one_stream(request, respond, handler),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        let err_str = e.to_string();
                        tracing::warn!("DMZ link h2 stream errored: {}", err_str);
                    }
                    Err(_) => {
                        tracing::warn!(
                            timeout_secs = STREAM_DEADLINE.as_secs(),
                            "DMZ link h2 stream timed out; resetting"
                        );
                    }
                }
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

/// Active liveness probe for the h2 link. See `serve_h2` for the
/// rationale. Exits as soon as `shutdown` fires or a ping fails /
/// times out (after cancelling `shutdown` so the parent loop redials).
async fn ping_watchdog(mut pp: h2::PingPong, shutdown: CancellationToken) {
    const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
    const PING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    let mut tick = tokio::time::interval(PING_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Burn the immediate first tick so we don't ping the peer the
    // microsecond the handshake completes.
    tick.tick().await;

    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            _ = tick.tick() => {}
        }

        let send = pp.ping(h2::Ping::opaque());
        match tokio::time::timeout(PING_TIMEOUT, send).await {
            Ok(Ok(_pong)) => {}
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "DMZ link h2 PING failed; tearing down link");
                shutdown.cancel();
                return;
            }
            Err(_) => {
                tracing::warn!(
                    timeout_secs = PING_TIMEOUT.as_secs(),
                    "DMZ link h2 PING timed out; tearing down link"
                );
                shutdown.cancel();
                return;
            }
        }
    }
}

async fn serve_one_stream(
    request: Request<RecvStream>,
    mut respond: SendResponse<Bytes>,
    handler: Arc<dyn RequestHandler>,
) -> anyhow::Result<()> {
    let declared = request
        .headers()
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    if declared.is_some_and(|n| n > MAX_REQUEST_BODY_BYTES) {
        // Returning drops the body unread, which resets the stream so
        // the peer stops sending.
        let resp = Response::builder()
            .status(StatusCode::PAYLOAD_TOO_LARGE)
            .body(())
            .expect("static response");
        let mut send = respond
            .send_response(resp, false)
            .map_err(|e| anyhow::anyhow!("h2 send 413: {e}"))?;
        send.send_data(Bytes::from_static(b"request body exceeds link limit"), true)
            .map_err(|e| anyhow::anyhow!("h2 send 413 body: {e}"))?;
        return Ok(());
    }

    let (parts, recv) = request.into_parts();
    let req = Request::from_parts(parts, request_body(recv));
    let response = handler.handle(req).await;
    send_response(respond, response).await
}

/// The request body as the handler sees it. Window is released for each
/// chunk as the handler takes it; going over [`MAX_REQUEST_BODY_BYTES`]
/// or stalling for [`BODY_IDLE_TIMEOUT`] fails the body and resets the
/// stream.
fn request_body(recv: RecvStream) -> Body {
    let chunks = futures_util::stream::try_unfold((recv, 0u64), |(mut recv, total)| async move {
        let next = tokio::time::timeout(BODY_IDLE_TIMEOUT, recv.data())
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "request body idle"))?;
        let Some(chunk) = next else {
            return Ok(None);
        };
        let chunk = chunk.map_err(std::io::Error::other)?;
        let total = total + chunk.len() as u64;
        if total > MAX_REQUEST_BODY_BYTES {
            return Err(std::io::Error::other("request body exceeds link limit"));
        }
        let _ = recv.flow_control().release_capacity(chunk.len());
        Ok(Some((chunk, (recv, total))))
    });
    Body::from_stream(chunks)
}

/// Send `response`, streaming its body as the peer grants window.
async fn send_response(
    mut respond: SendResponse<Bytes>,
    response: Response<Body>,
) -> anyhow::Result<()> {
    use http_body::Body as _;

    let (parts, mut body) = response.into_parts();
    let head = Response::from_parts(parts, ());
    if body.is_end_stream() {
        respond
            .send_response(head, true)
            .map_err(|e| anyhow::anyhow!("h2 send response: {e}"))?;
        return Ok(());
    }
    let mut send = respond
        .send_response(head, false)
        .map_err(|e| anyhow::anyhow!("h2 send response: {e}"))?;

    loop {
        let frame = match tokio::time::timeout(BODY_IDLE_TIMEOUT, body.frame()).await {
            Err(_) => {
                send.send_reset(h2::Reason::CANCEL);
                anyhow::bail!("response body idle");
            }
            Ok(None) => {
                send.send_data(Bytes::new(), true)
                    .map_err(|e| anyhow::anyhow!("h2 send end of body: {e}"))?;
                return Ok(());
            }
            Ok(Some(Err(e))) => {
                send.send_reset(h2::Reason::INTERNAL_ERROR);
                anyhow::bail!("response body: {e}");
            }
            Ok(Some(Ok(frame))) => frame,
        };
        match frame.into_data() {
            Ok(data) => send_data(&mut send, data).await?,
            Err(frame) => {
                if let Ok(trailers) = frame.into_trailers() {
                    send.send_trailers(trailers)
                        .map_err(|e| anyhow::anyhow!("h2 send trailers: {e}"))?;
                    return Ok(());
                }
            }
        }
    }
}

/// Send `data` in pieces no larger than the window the peer has granted.
async fn send_data(send: &mut SendStream<Bytes>, mut data: Bytes) -> anyhow::Result<()> {
    while !data.is_empty() {
        send.reserve_capacity(data.len());
        let granted =
            match tokio::time::timeout(BODY_IDLE_TIMEOUT, poll_fn(|cx| send.poll_capacity(cx)))
                .await
            {
                Err(_) => {
                    send.send_reset(h2::Reason::CANCEL);
                    anyhow::bail!("peer stopped reading the response");
                }
                Ok(None) => anyhow::bail!("response stream closed by peer"),
                Ok(Some(Err(e))) => anyhow::bail!("h2 capacity: {e}"),
                Ok(Some(Ok(n))) => n,
            };
        let piece = data.split_to(granted.min(data.len()));
        if !piece.is_empty() {
            send.send_data(piece, false)
                .map_err(|e| anyhow::anyhow!("h2 send body: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::dmz_link::upgrade_handler::RejectUpgradeHandler;
    use tokio::io::duplex;

    /// Stub handler that echoes the request URI + body length.
    struct EchoHandler;

    #[async_trait]
    impl RequestHandler for EchoHandler {
        async fn handle(&self, req: Request<Body>) -> Response<Body> {
            let (parts, body) = req.into_parts();
            let len = body.collect().await.map(|b| b.to_bytes().len());
            let body = format!(
                "method={} path={} body_bytes={}",
                parts.method,
                parts.uri.path(),
                len.unwrap_or(usize::MAX),
            );
            Response::builder()
                .status(StatusCode::OK)
                .header("x-test", "echo")
                .body(Body::from(body))
                .unwrap()
        }
    }

    /// Streams the request body straight back as the response body.
    struct MirrorHandler;

    #[async_trait]
    impl RequestHandler for MirrorHandler {
        async fn handle(&self, req: Request<Body>) -> Response<Body> {
            Response::new(req.into_body())
        }
    }

    /// Answers 401 without reading the body, as an auth layer would.
    struct DenyHandler;

    #[async_trait]
    impl RequestHandler for DenyHandler {
        async fn handle(&self, _req: Request<Body>) -> Response<Body> {
            Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Body::empty())
                .unwrap()
        }
    }

    /// 200 if the whole body could be read, 400 if reading it failed.
    struct ReadAllHandler;

    #[async_trait]
    impl RequestHandler for ReadAllHandler {
        async fn handle(&self, req: Request<Body>) -> Response<Body> {
            let status = match req.into_body().collect().await {
                Ok(_) => StatusCode::OK,
                Err(_) => StatusCode::BAD_REQUEST,
            };
            Response::builder()
                .status(status)
                .body(Body::empty())
                .unwrap()
        }
    }

    fn serve(handler: impl RequestHandler) -> tokio::io::DuplexStream {
        let (server_io, client_io) = duplex(64 * 1024);
        tokio::spawn(serve_h2(
            server_io,
            Arc::new(handler),
            Arc::new(RejectUpgradeHandler),
            CancellationToken::new(),
            || {},
        ));
        client_io
    }

    async fn connect(client_io: tokio::io::DuplexStream) -> h2::client::SendRequest<Bytes> {
        let (h2, conn) = h2::client::handshake(client_io).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        h2.ready().await.unwrap()
    }

    fn post(len: Option<u64>) -> http::Request<()> {
        let mut req = http::Request::builder()
            .method("POST")
            .uri("https://internal/api/upload");
        if let Some(len) = len {
            req = req.header(http::header::CONTENT_LENGTH, len);
        }
        req.body(()).unwrap()
    }

    async fn read_body(mut recv: RecvStream) -> Vec<u8> {
        let mut buf = Vec::new();
        while let Some(chunk) = recv.data().await {
            let chunk = chunk.unwrap();
            let _ = recv.flow_control().release_capacity(chunk.len());
            buf.extend_from_slice(&chunk);
        }
        buf
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
        let server = tokio::spawn(serve_h2(
            server_io,
            Arc::new(EchoHandler),
            Arc::new(RejectUpgradeHandler),
            shutdown.clone(),
            || {},
        ));

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
        let server = tokio::spawn(serve_h2(
            server_io,
            Arc::new(EchoHandler),
            Arc::new(RejectUpgradeHandler),
            shutdown.clone(),
            || {},
        ));

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
    async fn bodies_larger_than_the_old_buffer_stream_both_ways() {
        let mut h2 = connect(serve(MirrorHandler)).await;
        let data: Bytes = (0..20 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        let (resp, mut send) = h2
            .send_request(post(Some(data.len() as u64)), false)
            .unwrap();
        send.send_data(data.clone(), true).unwrap();
        let resp = resp.await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(read_body(resp.into_body()).await == data);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn handler_answers_before_the_body_is_sent() {
        let mut h2 = connect(serve(DenyHandler)).await;
        let (resp, mut send) = h2
            .send_request(post(Some(100 * 1024 * 1024)), false)
            .unwrap();
        send.send_data(Bytes::from(vec![0u8; 64 * 1024]), false)
            .unwrap();
        let resp = tokio::time::timeout(Duration::from_secs(5), resp)
            .await
            .expect("answered without the rest of the body")
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_declared_oversize_body_is_refused_up_front() {
        struct PoisonHandler;
        #[async_trait]
        impl RequestHandler for PoisonHandler {
            async fn handle(&self, _req: Request<Body>) -> Response<Body> {
                panic!("handler invoked for an oversized body");
            }
        }

        let mut h2 = connect(serve(PoisonHandler)).await;
        let (resp, _send) = h2
            .send_request(post(Some(MAX_REQUEST_BODY_BYTES + 1)), false)
            .unwrap();
        assert_eq!(resp.await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);

        // The link survives for the next request.
        let mut h2 = h2.ready().await.unwrap();
        let (resp, _send) = h2
            .send_request(post(Some(MAX_REQUEST_BODY_BYTES + 1)), false)
            .unwrap();
        assert_eq!(resp.await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_stalled_request_body_fails_after_the_idle_timeout() {
        let mut h2 = connect(serve(ReadAllHandler)).await;
        let (resp, mut send) = h2.send_request(post(None), false).unwrap();
        send.send_data(Bytes::from_static(b"partial"), false)
            .unwrap();
        let resp = resp.await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        drop(send);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_drains_inflight_and_returns_ok() {
        let (server_io, client_io) = duplex(64 * 1024);
        let shutdown = CancellationToken::new();
        let server = tokio::spawn(serve_h2(
            server_io,
            Arc::new(EchoHandler),
            Arc::new(RejectUpgradeHandler),
            shutdown.clone(),
            || {},
        ));

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
