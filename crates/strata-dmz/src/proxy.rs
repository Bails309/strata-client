//! Reverse-proxy adapter — forwards a public HTTP request through one
//! of the registered link sessions.
//!
//! ## Flow
//!
//! 1. Pick an h2 `SendRequest<Bytes>` from
//!    [`crate::link_server::LinkSessionRegistry`]. If none is up,
//!    return `503 service unavailable` with body
//!    `no internal links available`.
//! 2. Wait for the picked sender to become ready
//!    ([`SendRequest::ready`]). If it fails (the underlying
//!    connection went away after the pick but before send), evict
//!    the entry and try once more. We don't loop indefinitely — the
//!    public client should retry instead of us holding a request
//!    open across multiple h2 reconnects.
//! 3. Build a `http::Request<()>` mirroring the incoming request:
//!    method, path-and-query, hop-by-hop headers stripped, plus the
//!    edge-header bundle injected by Phase 2d (no-op until 2d lands —
//!    the adapter accepts an `EdgeSigner` trait so 2d can drop in).
//! 4. Send the request with `end_of_stream = false` and stream the
//!    request body upstream as the public client supplies it,
//!    honoring h2 flow control via
//!    [`SendStream::reserve_capacity`] / [`SendStream::poll_capacity`].
//!    The pump is a spawned task so the response head can be awaited
//!    concurrently (e.g. for early 4xx replies).
//! 5. Read response headers, then stream body frames back to the
//!    public client up to [`MAX_PROXY_BODY_BYTES`]; trailers are
//!    dropped (axum can't stream HTTP/1.1 trailers reliably to all
//!    clients and this proxy is HTTP/1.1 + h2 to public).
//!
//! ## Body caps
//!
//! Neither direction is buffered in full. Per-request memory is
//! bounded by the negotiated h2 flow-control windows (typically ~64
//! KiB) rather than [`MAX_PROXY_BODY_BYTES`]. The cap is still
//! enforced byte-by-byte as data flows; over-cap requests are
//! refused upfront when `Content-Length` is present and the upstream
//! stream is reset mid-transfer otherwise. Over-cap responses are
//! refused upfront when upstream advertises `Content-Length`;
//! mid-stream overshoot truncates the response and the public
//! connection is closed by the body stream returning an error.
//!
//! ## Hop-by-hop headers
//!
//! Per RFC 7230 §6.1, hop-by-hop headers MUST NOT be forwarded:
//! `connection`, `proxy-connection`, `keep-alive`, `transfer-encoding`,
//! `te`, `trailer`, `upgrade`. Plus `host` (h2 uses `:authority`).
//! Any header listed in the value of `connection:` is also hop-by-hop.

use std::future::poll_fn;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::extract::Request as AxumRequest;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use h2::client::SendRequest;
use h2::{RecvStream, SendStream};
use http::{Request as HttpRequest, Uri};

use crate::link_server::LinkSessionRegistry;

/// Maximum total bytes the proxy will buffer / forward in either
/// direction per request. Symmetric on the request body and response
/// body so neither direction can be used to amplify the other.
pub const MAX_PROXY_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Hop-by-hop header names that must be stripped before forwarding
/// the request through the link, per RFC 7230 §6.1. `host` is also
/// stripped because h2 uses the `:authority` pseudo-header instead.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "host",
];

/// Trait the reverse-proxy uses to ask Phase 2d to attach the
/// `x-strata-edge-*` header bundle. Phase 2c ships with a no-op
/// signer ([`NoopEdgeSigner`]) so the adapter is wire-compatible
/// with the eventual signer drop-in.
pub trait EdgeSigner: Send + Sync + 'static {
    /// Mutate `headers` to add the signed edge bundle. The signer
    /// is given the original public-facing socket peer, the original
    /// request URI, and the request method so it can include them
    /// in the HMAC transcript.
    fn sign(
        &self,
        headers: &mut HeaderMap,
        peer: Option<std::net::SocketAddr>,
        method: &http::Method,
        uri: &Uri,
    );
}

/// No-op signer — used until Phase 2d. Adds nothing.
#[derive(Default, Clone, Copy)]
#[allow(dead_code)]
pub struct NoopEdgeSigner;

impl EdgeSigner for NoopEdgeSigner {
    fn sign(
        &self,
        _headers: &mut HeaderMap,
        _peer: Option<std::net::SocketAddr>,
        _method: &http::Method,
        _uri: &Uri,
    ) {
    }
}

/// Shared state for the reverse-proxy adapter.
#[derive(Clone)]
pub struct ProxyState {
    pub registry: LinkSessionRegistry,
    pub signer: Arc<dyn EdgeSigner>,
}

impl ProxyState {
    pub fn new(registry: LinkSessionRegistry, signer: Arc<dyn EdgeSigner>) -> Self {
        Self { registry, signer }
    }
}

/// Axum handler. Wire as a fallback under the public `Router`:
///
/// ```ignore
/// Router::new().fallback(proxy_handler).with_state(state)
/// ```
pub async fn proxy_handler(
    axum::extract::State(state): axum::extract::State<ProxyState>,
    req: AxumRequest,
) -> Response {
    // RFC 8441 / RFC 6455: WebSocket upgrades cannot be buffered like
    // regular requests — they need a long-lived bidirectional bytes
    // pipe over the link. Dispatch to the WS-specific path before
    // touching the body.
    if crate::ws_proxy::is_websocket_upgrade(req.headers()) {
        return match crate::ws_proxy::proxy_websocket(state, req).await {
            Ok(resp) => resp,
            Err(e) => e.into_response(),
        };
    }
    match proxy(state, req).await {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    }
}

/// Errors that the proxy converts into HTTP responses for the public
/// client. Each variant has a fixed status + short body — we never
/// leak link-session details to the public side.
#[derive(Debug)]
enum ProxyError {
    NoLinkUp,
    LinkSendUnavailable,
    UpstreamHandshake,
    UpstreamProtocol,
    UpstreamTooLarge,
    InvalidRequestUri,
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ProxyError::NoLinkUp => (
                StatusCode::SERVICE_UNAVAILABLE,
                "no internal links available",
            ),
            ProxyError::LinkSendUnavailable => {
                (StatusCode::BAD_GATEWAY, "link session lost during request")
            }
            ProxyError::UpstreamHandshake => {
                (StatusCode::BAD_GATEWAY, "upstream link handshake failed")
            }
            ProxyError::UpstreamProtocol => {
                (StatusCode::BAD_GATEWAY, "upstream link protocol error")
            }
            ProxyError::UpstreamTooLarge => (
                StatusCode::INSUFFICIENT_STORAGE,
                "upstream response exceeded proxy body limit",
            ),
            ProxyError::InvalidRequestUri => (StatusCode::BAD_REQUEST, "invalid request uri"),
        };
        let mut resp = (status, msg).into_response();
        resp.headers_mut().insert(
            HeaderName::from_static("x-strata-link"),
            HeaderValue::from_static("dmz-proxy"),
        );
        resp
    }
}

async fn proxy(state: ProxyState, req: AxumRequest) -> Result<Response, ProxyError> {
    // Take peer-extension info BEFORE consuming the request.
    let peer: Option<std::net::SocketAddr> = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0);

    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let uri = parts.uri.clone();

    // h2 requires `:authority`; pull from Host header if the URI is
    // missing it (HTTP/1.1 origin-form is the common case).
    let authority: Option<http::uri::Authority> = uri.authority().cloned().or_else(|| {
        parts
            .headers
            .get(http::header::HOST)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
    });
    let path_and_query = uri
        .path_and_query()
        .cloned()
        .unwrap_or_else(|| http::uri::PathAndQuery::from_static("/"));

    // Build the upstream URI: scheme = http (the link is plaintext
    // h2 inside mTLS — there's no second TLS layer), authority from
    // the public request, path+query verbatim.
    let upstream_uri: Uri = {
        let mut b = Uri::builder().scheme("http").path_and_query(path_and_query);
        if let Some(auth) = authority {
            b = b.authority(auth);
        } else {
            // No authority anywhere → can't build a valid h2 :authority.
            return Err(ProxyError::InvalidRequestUri);
        }
        b.build().map_err(|_| ProxyError::InvalidRequestUri)?
    };

    // Strip hop-by-hop headers and anything listed in `connection:`.
    let mut headers = parts.headers.clone();
    strip_hop_by_hop(&mut headers);

    // Phase 2d will inject the signed edge-header bundle here.
    state.signer.sign(&mut headers, peer, &method, &uri);

    // Pre-flight: if the client advertised a Content-Length larger
    // than the cap, refuse before touching the link. This is the
    // honest-client fast path; bodies without a CL (chunked uploads)
    // are still capped byte-by-byte by the streaming pump below.
    if let Some(declared) = parts
        .headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        if declared > MAX_PROXY_BODY_BYTES as u64 {
            return Ok((StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response());
        }
    }

    // Pick a ready sender. Body is not consumed until after we have
    // one, so we can retry the pick if the first sender is dead.
    // Once `send_request` is called we can no longer replay the body
    // — any subsequent failure is fatal to this request (the public
    // client must retry).
    let mut last_err: Option<ProxyError> = None;
    let mut chosen: Option<(crate::link_server::LinkSessionInfo, h2::client::SendRequest<Bytes>)> =
        None;
    for _ in 0..2 {
        let (info, sender) = match state.registry.pick_any() {
            Some(p) => p,
            None => return Err(ProxyError::NoLinkUp),
        };
        match sender.ready().await {
            Ok(ready) => {
                chosen = Some((info, ready));
                break;
            }
            Err(e) => {
                tracing::debug!(error = %e, link_id = %info.link_id, "link sender not ready, evicting");
                state.registry.remove(&info.link_id);
                last_err = Some(ProxyError::LinkSendUnavailable);
                continue;
            }
        }
    }
    let (info, sender) = match chosen {
        Some(c) => c,
        None => return Err(last_err.unwrap_or(ProxyError::LinkSendUnavailable)),
    };

    match forward_streaming(sender, &method, &upstream_uri, &headers, body).await {
        Ok(resp) => {
            tracing::debug!(
                link_id = %info.link_id,
                node_id = %info.node_id,
                method = %method,
                path = %upstream_uri.path(),
                "DMZ proxied request"
            );
            Ok(resp)
        }
        Err(e) => {
            // We already burned the body — evict the (possibly bad)
            // sender so the next request doesn't pick it again, but
            // no in-flight retry is possible.
            if matches!(
                e,
                ProxyError::LinkSendUnavailable | ProxyError::UpstreamHandshake
            ) {
                state.registry.remove(&info.link_id);
            }
            Err(e)
        }
    }
}

async fn forward_streaming(
    mut sender: SendRequest<Bytes>,
    method: &http::Method,
    upstream_uri: &Uri,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response, ProxyError> {
    // Build the upstream request.
    let mut up_req = HttpRequest::builder()
        .method(method.clone())
        .uri(upstream_uri.clone())
        .version(http::Version::HTTP_2);
    {
        let h = up_req.headers_mut().expect("fresh builder has headers map");
        for (k, v) in headers.iter() {
            h.append(k.clone(), v.clone());
        }
    }
    let up_req = up_req.body(()).map_err(|e| {
        tracing::warn!(error = %e, "failed to build upstream h2 request");
        ProxyError::UpstreamProtocol
    })?;

    // Always send with end_of_stream=false and let the pump task
    // close the stream after streaming any body bytes. For methods
    // without a body (GET/HEAD/...) the pump sees an immediate
    // end-of-stream from axum and sends an empty DATA frame with
    // EOS, which is well-formed h2.
    let (resp_fut, send_stream) = sender.send_request(up_req, false).map_err(|e| {
        tracing::debug!(error = %e, "send_request failed");
        ProxyError::LinkSendUnavailable
    })?;

    // Pump request body upstream concurrently with awaiting the
    // response head. Spawned so an upstream server that responds
    // before reading the full body (e.g. early 4xx) is not blocked.
    // Lifetime is bounded by: body stream EOF, peer reset (causes
    // send_data to error), or cap exceeded (we send_reset).
    let pump = tokio::spawn(pump_request_body_upstream(body, send_stream));

    // Receive the response head.
    let resp = match resp_fut.await {
        Ok(r) => r,
        Err(e) => {
            // Cancel the pump if it's still running — peer is gone.
            pump.abort();
            tracing::debug!(error = %e, "upstream h2 response future errored");
            return Err(ProxyError::UpstreamHandshake);
        }
    };

    let (head, recv) = resp.into_parts();

    // Pre-flight: if upstream advertised an over-cap Content-Length,
    // refuse before forwarding any bytes to the public client.
    // Mid-stream overshoot is handled by the body stream below.
    if let Some(declared) = head
        .headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        if declared > MAX_PROXY_BODY_BYTES as u64 {
            pump.abort();
            // Dropping `recv` will close the response stream.
            drop(recv);
            return Err(ProxyError::UpstreamTooLarge);
        }
    }

    // Build the public response with the upstream status + headers,
    // minus hop-by-hop fields. The body is a streaming adapter over
    // the h2 RecvStream that releases flow-control window per chunk
    // and enforces the byte cap as data flows.
    let mut public = Response::builder().status(head.status);
    {
        let h = public.headers_mut().expect("fresh builder has headers map");
        for (k, v) in head.headers.iter() {
            if !is_hop_by_hop(k) {
                h.append(k.clone(), v.clone());
            }
        }
    }
    let stream_body = RecvStreamBody {
        recv,
        remaining: MAX_PROXY_BODY_BYTES,
    };
    public
        .body(Body::from_stream(stream_body))
        .map_err(|e| {
            tracing::warn!(error = %e, "failed to build public response");
            ProxyError::UpstreamProtocol
        })
}

/// Pump the public-client request body upstream over an h2
/// [`SendStream`], honoring flow control and enforcing the proxy
/// body cap byte-by-byte. On error (cap exceeded, body read failure,
/// or upstream stream gone) the upstream stream is reset and the
/// task exits. Always terminates the stream with an EOS frame on
/// success.
async fn pump_request_body_upstream(body: Body, mut send: SendStream<Bytes>) {
    use http_body_util::BodyDataStream;
    let mut stream = BodyDataStream::new(body);
    let mut total: usize = 0;
    while let Some(next) = stream.next().await {
        let chunk = match next {
            Ok(c) => c,
            Err(e) => {
                tracing::debug!(error = %e, "request body read errored mid-stream");
                send.send_reset(h2::Reason::INTERNAL_ERROR);
                return;
            }
        };
        if total.saturating_add(chunk.len()) > MAX_PROXY_BODY_BYTES {
            tracing::debug!(
                total,
                chunk_len = chunk.len(),
                cap = MAX_PROXY_BODY_BYTES,
                "request body exceeded cap mid-stream"
            );
            send.send_reset(h2::Reason::CANCEL);
            return;
        }
        // Reserve flow-control window for the full chunk; the peer
        // may grant it in smaller increments, so loop on poll_capacity
        // until the chunk is fully sent.
        send.reserve_capacity(chunk.len());
        let mut remaining = chunk;
        while !remaining.is_empty() {
            let granted = match poll_fn(|cx| send.poll_capacity(cx)).await {
                Some(Ok(n)) => n,
                Some(Err(e)) => {
                    tracing::debug!(error = %e, "poll_capacity errored");
                    return;
                }
                None => {
                    // Stream closed by peer.
                    return;
                }
            };
            let take = granted.min(remaining.len());
            let to_send = remaining.split_to(take);
            if let Err(e) = send.send_data(to_send, false) {
                tracing::debug!(error = %e, "send_data errored");
                return;
            }
            total = total.saturating_add(take);
        }
    }
    // End of stream — empty DATA with EOS flag.
    if let Err(e) = send.send_data(Bytes::new(), true) {
        tracing::debug!(error = %e, "send_data EOS errored");
    }
}

/// Axum response body adapter over an h2 [`RecvStream`]. Releases
/// flow-control window per chunk and enforces the proxy body cap.
/// On cap overshoot or upstream error, yields an `Err` which axum
/// converts into a premature connection close on the public side.
struct RecvStreamBody {
    recv: RecvStream,
    remaining: usize,
}

impl Stream for RecvStreamBody {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        match Pin::new(&mut this.recv).poll_data(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Ready(Some(Err(e))) => {
                tracing::debug!(error = %e, "upstream response data frame errored");
                Poll::Ready(Some(Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "upstream response stream error",
                ))))
            }
            Poll::Ready(Some(Ok(chunk))) => {
                let len = chunk.len();
                if len > this.remaining {
                    tracing::debug!(
                        len,
                        remaining = this.remaining,
                        "upstream response exceeded proxy body cap mid-stream"
                    );
                    return Poll::Ready(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "upstream response exceeded proxy body cap",
                    ))));
                }
                this.remaining -= len;
                if let Err(e) = this.recv.flow_control().release_capacity(len) {
                    tracing::debug!(error = %e, "release_capacity failed");
                }
                Poll::Ready(Some(Ok(chunk)))
            }
        }
    }
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    let s = name.as_str();
    HOP_BY_HOP.iter().any(|h| h.eq_ignore_ascii_case(s))
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    // First, collect any header names listed inside `connection:`.
    let mut connection_listed: Vec<HeaderName> = Vec::new();
    if let Some(v) = headers.get(http::header::CONNECTION) {
        if let Ok(s) = v.to_str() {
            for token in s.split(',') {
                let token = token.trim();
                if let Ok(name) = HeaderName::try_from(token) {
                    connection_listed.push(name);
                }
            }
        }
    }
    for name in connection_listed {
        headers.remove(&name);
    }
    for h in HOP_BY_HOP {
        // HeaderName::from_static panics on non-lowercase; our list
        // is already lowercase.
        headers.remove(*h);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_link_up_returns_503() {
        let err = ProxyError::NoLinkUp.into_response();
        assert_eq!(err.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            err.headers().get("x-strata-link").map(|v| v.as_bytes()),
            Some(b"dmz-proxy".as_ref())
        );
    }

    #[test]
    fn link_send_unavailable_returns_502() {
        let err = ProxyError::LinkSendUnavailable.into_response();
        assert_eq!(err.status(), StatusCode::BAD_GATEWAY);
    }

    #[test]
    fn upstream_too_large_returns_507() {
        let err = ProxyError::UpstreamTooLarge.into_response();
        assert_eq!(err.status(), StatusCode::INSUFFICIENT_STORAGE);
    }

    #[test]
    fn invalid_uri_returns_400() {
        let err = ProxyError::InvalidRequestUri.into_response();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn strip_hop_by_hop_removes_standard_set() {
        let mut h = HeaderMap::new();
        h.insert(
            http::header::CONNECTION,
            "close, x-private".parse().unwrap(),
        );
        h.insert(http::header::TE, "trailers".parse().unwrap());
        h.insert(http::header::HOST, "example.com".parse().unwrap());
        h.insert(http::header::TRANSFER_ENCODING, "chunked".parse().unwrap());
        h.insert("x-private", "secret".parse().unwrap());
        h.insert("x-keep", "yes".parse().unwrap());
        strip_hop_by_hop(&mut h);
        assert!(h.get(http::header::CONNECTION).is_none());
        assert!(h.get(http::header::TE).is_none());
        assert!(h.get(http::header::HOST).is_none());
        assert!(h.get(http::header::TRANSFER_ENCODING).is_none());
        // `x-private` was listed in `connection:` so it's hop-by-hop too.
        assert!(h.get("x-private").is_none());
        assert_eq!(h.get("x-keep").map(|v| v.as_bytes()), Some(b"yes".as_ref()));
    }

    #[test]
    fn is_hop_by_hop_is_case_insensitive() {
        assert!(is_hop_by_hop(&HeaderName::from_static("connection")));
        assert!(is_hop_by_hop(&HeaderName::from_static("transfer-encoding")));
        assert!(!is_hop_by_hop(&HeaderName::from_static("x-anything")));
    }

    #[test]
    fn noop_signer_does_not_mutate_headers() {
        let signer = NoopEdgeSigner;
        let mut h = HeaderMap::new();
        h.insert("x-existing", "1".parse().unwrap());
        let uri: Uri = "/foo".parse().unwrap();
        signer.sign(&mut h, None, &http::Method::GET, &uri);
        assert_eq!(h.len(), 1);
        assert_eq!(
            h.get("x-existing").map(|v| v.as_bytes()),
            Some(b"1".as_ref())
        );
    }

    // ── End-to-end round-trip ────────────────────────────────────────
    //
    // Exercises the full proxy path: pick session from registry →
    // sign edge headers → send via h2 → drive a fake "internal" h2
    // server → stream the response body back. This is the integration
    // test that covers the gap between the unit tests for each module
    // and the (deferred) docker-compose end-to-end test.

    use crate::edge_signer::HmacEdgeSigner;
    use crate::link_server::{LinkSessionInfo, LinkSessionRegistry};
    use h2::server::Builder as H2ServerBuilder;
    use http::Response as HttpResponse;
    use tokio::io::duplex;
    use zeroize::Zeroizing;

    /// Run a tiny "internal-side" h2 server on `stream` that accepts
    /// exactly one request, hands its parts back via `tx`, and replies
    /// with 200 + body `"hello from internal"`.
    async fn run_fake_internal_server<S>(
        stream: S,
        tx: tokio::sync::oneshot::Sender<http::request::Parts>,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let mut conn = H2ServerBuilder::new()
            .handshake::<_, Bytes>(stream)
            .await
            .expect("h2 server handshake");
        let mut tx = Some(tx);
        while let Some(item) = conn.accept().await {
            let (request, mut respond) = item.expect("h2 accept");
            let (parts, mut body) = request.into_parts();
            // Drain the request body so the client can finish its
            // send_data; we don't care about the contents here.
            while let Some(chunk) = body.data().await {
                let chunk = chunk.expect("body chunk");
                let _ = body.flow_control().release_capacity(chunk.len());
            }
            if let Some(tx) = tx.take() {
                let _ = tx.send(parts);
            }
            let resp = HttpResponse::builder()
                .status(200)
                .header("content-type", "text/plain")
                .body(())
                .unwrap();
            let mut send = respond.send_response(resp, false).expect("send response");
            send.send_data(Bytes::from_static(b"hello from internal"), true)
                .expect("send body");
        }
    }

    #[tokio::test]
    async fn end_to_end_roundtrip_signs_and_forwards() {
        // Wide buffer so neither half ever back-pressures during the
        // test.
        let (server_io, client_io) = duplex(64 * 1024);

        let (req_tx, req_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(run_fake_internal_server(server_io, req_tx));

        // Client side — equivalent of what link_server does after the
        // strata-link/1.0 handshake completes.
        let (sender, h2_conn) = h2::client::Builder::new()
            .handshake::<_, Bytes>(client_io)
            .await
            .expect("h2 client handshake");
        // Drive the connection in the background until either side
        // closes.
        let conn_task = tokio::spawn(async move {
            let _ = h2_conn.await;
        });
        // Wait for the sender to be ready before we register it —
        // otherwise the proxy's first .ready() can race the
        // handshake.
        let sender = sender.ready().await.expect("sender ready");

        // Build a registry with our one fake session.
        let registry = LinkSessionRegistry::new();
        registry.insert(
            LinkSessionInfo {
                link_id: "test-link".into(),
                cluster_id: "test-cluster".into(),
                node_id: "test-node".into(),
                software_version: "0.0.0-test".into(),
                since: std::time::Instant::now(),
            },
            sender,
        );

        // Real HMAC signer with a 32-byte key. The integration test
        // doesn't currently verify the MAC — that's covered in
        // edge_signer's unit tests — but using a real signer ensures
        // the canonical bundle is well-formed and reaches the
        // internal side.
        let signer = HmacEdgeSigner::from_config(
            Zeroizing::new(b"a-32-char-or-longer-edge-hmac-key!!".to_vec()),
            "test-node".into(),
            &[],
        );

        let state = ProxyState::new(registry, Arc::new(signer));

        // Construct a public-side request. No ConnectInfo extension
        // — peer falls back to "0.0.0.0", which is what the signer
        // emits for non-trusted-proxy peers without a forwarded-from
        // header.
        let req = http::Request::builder()
            .method("GET")
            .uri("/api/echo?q=1")
            .header("host", "public.example.com")
            .header("user-agent", "strata-test/0.1")
            .body(Body::empty())
            .unwrap();

        let resp = proxy(state, req).await.expect("proxy ok");
        assert_eq!(resp.status(), StatusCode::OK);

        let body = axum::body::to_bytes(resp.into_body(), MAX_PROXY_BODY_BYTES)
            .await
            .expect("collect body");
        assert_eq!(&body[..], b"hello from internal");

        // Assert the internal side saw the request with edge headers
        // injected and hop-by-hop headers stripped.
        let upstream_parts = req_rx.await.expect("internal received request");
        assert_eq!(upstream_parts.method, http::Method::GET);
        assert_eq!(
            upstream_parts.uri.path_and_query().map(|p| p.as_str()),
            Some("/api/echo?q=1")
        );
        // Edge headers MUST be present.
        for h in [
            "x-strata-edge-client-ip",
            "x-strata-edge-user-agent",
            "x-strata-edge-request-id",
            "x-strata-edge-link-id",
            "x-strata-edge-timestamp-ms",
            "x-strata-edge-trusted-mac",
        ] {
            assert!(
                upstream_parts.headers.get(h).is_some(),
                "missing edge header: {h}"
            );
        }
        // Host header MUST have been stripped (h2 uses :authority).
        assert!(upstream_parts.headers.get("host").is_none());
        // user-agent forwarded through edge bundle, not as raw header
        // (the proxy doesn't strip it but the canonical UA lives in
        // x-strata-edge-user-agent for sig).
        assert_eq!(
            upstream_parts
                .headers
                .get("x-strata-edge-user-agent")
                .map(|v| v.as_bytes()),
            Some(b"strata-test/0.1".as_ref()),
        );
        assert_eq!(
            upstream_parts
                .headers
                .get("x-strata-edge-link-id")
                .map(|v| v.as_bytes()),
            Some(b"test-node".as_ref()),
        );

        // Cleanup.
        let _ = server_task.await;
        let _ = conn_task.await;
    }

    /// Build a one-shot DMZ proxy state + h2 transport pair for
    /// security tests. The fake internal server runs as a spawned
    /// task and forwards the first incoming request `parts` over the
    /// returned oneshot channel.
    async fn make_proxy_with_fake_internal(
        node_id: &str,
        trust_forwarded_from: &[String],
    ) -> (
        ProxyState,
        tokio::sync::oneshot::Receiver<http::request::Parts>,
        tokio::task::JoinHandle<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let (server_io, client_io) = duplex(64 * 1024);
        let (req_tx, req_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(run_fake_internal_server(server_io, req_tx));
        let (sender, h2_conn) = h2::client::Builder::new()
            .handshake::<_, Bytes>(client_io)
            .await
            .expect("h2 client handshake");
        let conn_task = tokio::spawn(async move {
            let _ = h2_conn.await;
        });
        let sender = sender.ready().await.expect("sender ready");

        let registry = LinkSessionRegistry::new();
        registry.insert(
            LinkSessionInfo {
                link_id: "test-link".into(),
                cluster_id: "test-cluster".into(),
                node_id: node_id.into(),
                software_version: "0.0.0-test".into(),
                since: std::time::Instant::now(),
            },
            sender,
        );
        let signer = HmacEdgeSigner::from_config(
            Zeroizing::new(b"a-32-char-or-longer-edge-hmac-key!!".to_vec()),
            node_id.into(),
            trust_forwarded_from,
        );
        let state = ProxyState::new(registry, Arc::new(signer));
        (state, req_rx, server_task, conn_task)
    }

    #[tokio::test]
    async fn forged_edge_headers_from_public_are_overwritten() {
        // A malicious public client tries to inject pre-signed edge
        // headers, claiming to be a trusted DMZ peer. The proxy MUST
        // strip every incoming `x-strata-edge-*` header before
        // signing; what reaches the upstream MUST be the proxy's own
        // freshly-signed bundle, not the attacker's.
        let (state, req_rx, server_task, conn_task) =
            make_proxy_with_fake_internal("real-dmz-node", &[]).await;

        let req = http::Request::builder()
            .method("GET")
            .uri("/api/me")
            .header("host", "public.example.com")
            // Forged edge bundle the attacker hopes the internal node
            // will trust as-is:
            .header("x-strata-edge-client-ip", "10.0.0.1")
            .header("x-strata-edge-user-agent", "attacker/1.0")
            .header("x-strata-edge-link-id", "spoofed-node")
            .header("x-strata-edge-timestamp-ms", "1")
            .header("x-strata-edge-trusted-mac", "AAAA")
            // Real UA the proxy should propagate:
            .header("user-agent", "honest-client/1.0")
            .body(Body::empty())
            .unwrap();

        let resp = proxy(state, req).await.expect("proxy ok");
        assert_eq!(resp.status(), StatusCode::OK);

        let parts = req_rx.await.expect("internal received");
        // link-id MUST be the proxy's configured node_id, not the
        // attacker's "spoofed-node".
        assert_eq!(
            parts
                .headers
                .get("x-strata-edge-link-id")
                .map(|v| v.as_bytes()),
            Some(b"real-dmz-node".as_ref()),
        );
        // user-agent MUST be the honest client's, not "attacker/1.0".
        assert_eq!(
            parts
                .headers
                .get("x-strata-edge-user-agent")
                .map(|v| v.as_bytes()),
            Some(b"honest-client/1.0".as_ref()),
        );
        // timestamp MUST NOT be the attacker's "1" — it's stamped by
        // the signer at sign time, well after the unix epoch.
        let ts: i64 = std::str::from_utf8(
            parts
                .headers
                .get("x-strata-edge-timestamp-ms")
                .expect("timestamp present")
                .as_bytes(),
        )
        .unwrap()
        .parse()
        .unwrap();
        assert!(ts > 1_700_000_000_000, "timestamp not freshly signed: {ts}");
        // MAC MUST NOT be the attacker's "AAAA".
        let mac = parts
            .headers
            .get("x-strata-edge-trusted-mac")
            .expect("mac present");
        assert_ne!(mac.as_bytes(), b"AAAA");

        let _ = server_task.await;
        let _ = conn_task.await;
    }

    #[tokio::test]
    async fn xff_from_untrusted_peer_is_ignored() {
        // The proxy's trust list is empty here, so any X-Forwarded-For
        // from the public client must be ignored when computing
        // x-strata-edge-client-ip. Without ConnectInfo on the request
        // the signer falls back to "0.0.0.0".
        let (state, req_rx, server_task, conn_task) =
            make_proxy_with_fake_internal("real-dmz-node", &[]).await;

        let req = http::Request::builder()
            .method("GET")
            .uri("/api/me")
            .header("host", "public.example.com")
            .header("x-forwarded-for", "203.0.113.99, 192.0.2.5")
            .body(Body::empty())
            .unwrap();

        let resp = proxy(state, req).await.expect("proxy ok");
        assert_eq!(resp.status(), StatusCode::OK);

        let parts = req_rx.await.expect("internal received");
        // No ConnectInfo + untrusted XFF source → fallback "0.0.0.0".
        assert_eq!(
            parts
                .headers
                .get("x-strata-edge-client-ip")
                .map(|v| v.as_bytes()),
            Some(b"0.0.0.0".as_ref()),
        );

        let _ = server_task.await;
        let _ = conn_task.await;
    }

    #[tokio::test]
    async fn each_request_gets_a_fresh_signed_bundle() {
        // Replay protection at the proxy boundary: a single public
        // request produces a single signed bundle. A second pass
        // through the proxy MUST mint a fresh timestamp + MAC, even
        // if the public request bytes are byte-identical. (The
        // internal-side replay window is asserted by
        // strata-protocol::edge_header::check_timestamp; here we
        // only need the proxy to never reuse a stamp.)
        let (state1, rx1, st1, ct1) = make_proxy_with_fake_internal("real-dmz-node", &[]).await;
        let (state2, rx2, st2, ct2) = make_proxy_with_fake_internal("real-dmz-node", &[]).await;

        let make_req = || {
            http::Request::builder()
                .method("GET")
                .uri("/api/me")
                .header("host", "public.example.com")
                .header("user-agent", "rep/1.0")
                .body(Body::empty())
                .unwrap()
        };

        let _ = proxy(state1, make_req()).await.expect("proxy ok 1");
        // Sleep at least 2ms so the second timestamp is guaranteed to
        // differ from the first even if the system clock is coarse.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let _ = proxy(state2, make_req()).await.expect("proxy ok 2");

        let p1 = rx1.await.expect("internal 1 received");
        let p2 = rx2.await.expect("internal 2 received");

        let ts1 = p1.headers.get("x-strata-edge-timestamp-ms").unwrap();
        let ts2 = p2.headers.get("x-strata-edge-timestamp-ms").unwrap();
        let mac1 = p1.headers.get("x-strata-edge-trusted-mac").unwrap();
        let mac2 = p2.headers.get("x-strata-edge-trusted-mac").unwrap();
        let rid1 = p1.headers.get("x-strata-edge-request-id").unwrap();
        let rid2 = p2.headers.get("x-strata-edge-request-id").unwrap();
        // Timestamps MUST advance.
        assert_ne!(ts1.as_bytes(), ts2.as_bytes(), "timestamp reused");
        // MACs MUST differ (different bundle → different MAC).
        assert_ne!(mac1.as_bytes(), mac2.as_bytes(), "MAC reused");
        // Request IDs MUST be freshly minted UUIDs (no incoming
        // header was supplied).
        assert_ne!(rid1.as_bytes(), rid2.as_bytes(), "request-id reused");

        let _ = st1.await;
        let _ = ct1.await;
        let _ = st2.await;
        let _ = ct2.await;
    }

    // ── Streaming-specific tests (M5) ────────────────────────────────

    /// Build a `ProxyState` with an empty registry and a real HMAC
    /// signer. Used by tests that exercise paths which short-circuit
    /// before touching the link (e.g. Content-Length pre-flight).
    fn empty_registry_state() -> ProxyState {
        let registry = LinkSessionRegistry::new();
        let signer = HmacEdgeSigner::from_config(
            Zeroizing::new(b"a-32-char-or-longer-edge-hmac-key!!".to_vec()),
            "test-node".into(),
            &[],
        );
        ProxyState::new(registry, Arc::new(signer))
    }

    #[tokio::test]
    async fn request_oversized_content_length_returns_413_before_pick() {
        // A request advertising a Content-Length larger than
        // MAX_PROXY_BODY_BYTES must be refused with 413 *before* the
        // proxy picks a link. Proof: the registry is empty — if the
        // pre-flight didn't trigger, the next step would be NoLinkUp
        // (503), not 413.
        let state = empty_registry_state();

        let too_big = (MAX_PROXY_BODY_BYTES as u64) + 1;
        let req = http::Request::builder()
            .method("POST")
            .uri("/api/upload")
            .header("host", "public.example.com")
            .header("content-length", too_big.to_string())
            .body(Body::empty())
            .unwrap();

        let resp = proxy(state, req).await.expect("proxy returns response");
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn request_body_streams_intact_to_upstream() {
        // A moderate (1 MiB) request body without a Content-Length
        // hint, delivered as many small chunks, must arrive at the
        // upstream byte-for-byte identical. This proves the pump
        // task correctly stitches `poll_capacity`-granted slices.
        let (server_io, client_io) = duplex(256 * 1024);

        // Fake internal server: drain the body, ship it back to us
        // for comparison, reply 200 with empty body.
        let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        let server_task = tokio::spawn(async move {
            let mut conn = H2ServerBuilder::new()
                .handshake::<_, Bytes>(server_io)
                .await
                .expect("h2 server handshake");
            if let Some(item) = conn.accept().await {
                let (request, mut respond) = item.expect("h2 accept");
                let (_p, mut body) = request.into_parts();
                let mut buf = Vec::new();
                while let Some(chunk) = body.data().await {
                    let chunk = chunk.expect("body chunk");
                    let _ = body.flow_control().release_capacity(chunk.len());
                    buf.extend_from_slice(&chunk);
                }
                let _ = body_tx.send(buf);
                let resp = HttpResponse::builder().status(200).body(()).unwrap();
                let mut send = respond.send_response(resp, false).expect("send response");
                send.send_data(Bytes::new(), true).expect("send EOS");
            }
            while conn.accept().await.is_some() {}
        });

        let (sender, h2_conn) = h2::client::Builder::new()
            .handshake::<_, Bytes>(client_io)
            .await
            .expect("h2 client handshake");
        let conn_task = tokio::spawn(async move {
            let _ = h2_conn.await;
        });
        let sender = sender.ready().await.expect("sender ready");

        let registry = LinkSessionRegistry::new();
        registry.insert(
            LinkSessionInfo {
                link_id: "test-link".into(),
                cluster_id: "test-cluster".into(),
                node_id: "test-node".into(),
                software_version: "0.0.0-test".into(),
                since: std::time::Instant::now(),
            },
            sender,
        );
        let signer = HmacEdgeSigner::from_config(
            Zeroizing::new(b"a-32-char-or-longer-edge-hmac-key!!".to_vec()),
            "test-node".into(),
            &[],
        );
        let state = ProxyState::new(registry, Arc::new(signer));

        // Build a 1 MiB body as 1024 chunks of 1 KiB each, no CL.
        let chunks: Vec<Result<Bytes, std::io::Error>> = (0..1024)
            .map(|i| {
                let mut v = vec![0u8; 1024];
                v[0] = (i & 0xff) as u8;
                v[1] = ((i >> 8) & 0xff) as u8;
                Ok(Bytes::from(v))
            })
            .collect();
        let expected_total: usize = chunks.iter().map(|c| c.as_ref().unwrap().len()).sum();
        let body = Body::from_stream(futures_util::stream::iter(chunks));

        let req = http::Request::builder()
            .method("POST")
            .uri("/api/upload")
            .header("host", "public.example.com")
            .body(body)
            .unwrap();

        let resp = proxy(state, req).await.expect("proxy ok");
        assert_eq!(resp.status(), StatusCode::OK);
        // Drain the (empty) response body to let upstream finish.
        let _ = axum::body::to_bytes(resp.into_body(), MAX_PROXY_BODY_BYTES).await;

        let upstream_body = body_rx.await.expect("upstream captured body");
        assert_eq!(
            upstream_body.len(),
            expected_total,
            "byte count mismatch: upstream got {}, sent {}",
            upstream_body.len(),
            expected_total
        );
        // Spot-check: first byte of every 1 KiB chunk encodes chunk index.
        for i in 0..1024 {
            let offset = i * 1024;
            assert_eq!(upstream_body[offset], (i & 0xff) as u8, "chunk {i} hi byte");
            assert_eq!(
                upstream_body[offset + 1],
                ((i >> 8) & 0xff) as u8,
                "chunk {i} lo byte"
            );
        }

        let _ = server_task.await;
        let _ = conn_task.await;
    }

    #[tokio::test]
    async fn request_body_oversize_without_cl_is_capped_and_request_fails() {
        // A request body that is over-cap and has no Content-Length
        // (so the pre-flight 413 path cannot fire) must be stopped
        // mid-stream by the pump task issuing send_reset. The public
        // client sees an error (not 200) because the upstream stream
        // was reset before producing a successful response head.
        let (server_io, client_io) = duplex(64 * 1024);

        // Fake upstream: try to drain the body. If the client resets
        // the stream, body.data() yields an Err — we just exit. We
        // do NOT send a response because the request was aborted.
        let server_task = tokio::spawn(async move {
            let mut conn = H2ServerBuilder::new()
                .handshake::<_, Bytes>(server_io)
                .await
                .expect("h2 server handshake");
            if let Some(item) = conn.accept().await {
                let (request, _respond) = item.expect("h2 accept");
                let (_p, mut body) = request.into_parts();
                while let Some(chunk) = body.data().await {
                    match chunk {
                        Ok(c) => {
                            let _ = body.flow_control().release_capacity(c.len());
                        }
                        Err(_) => return, // client reset — expected
                    }
                }
            }
        });

        let (sender, h2_conn) = h2::client::Builder::new()
            .handshake::<_, Bytes>(client_io)
            .await
            .expect("h2 client handshake");
        let conn_task = tokio::spawn(async move {
            let _ = h2_conn.await;
        });
        let sender = sender.ready().await.expect("sender ready");

        let registry = LinkSessionRegistry::new();
        registry.insert(
            LinkSessionInfo {
                link_id: "test-link".into(),
                cluster_id: "test-cluster".into(),
                node_id: "test-node".into(),
                software_version: "0.0.0-test".into(),
                since: std::time::Instant::now(),
            },
            sender,
        );
        let signer = HmacEdgeSigner::from_config(
            Zeroizing::new(b"a-32-char-or-longer-edge-hmac-key!!".to_vec()),
            "test-node".into(),
            &[],
        );
        let state = ProxyState::new(registry, Arc::new(signer));

        // 9 MiB body (cap is 8 MiB), no Content-Length, in 9 chunks
        // of 1 MiB. Pre-flight cannot save us; the pump must.
        let chunks: Vec<Result<Bytes, std::io::Error>> =
            (0..9).map(|_| Ok(Bytes::from(vec![0u8; 1024 * 1024]))).collect();
        let body = Body::from_stream(futures_util::stream::iter(chunks));

        let req = http::Request::builder()
            .method("POST")
            .uri("/api/upload")
            .header("host", "public.example.com")
            .body(body)
            .unwrap();

        // We allow either an outright Err (resp_fut failed because
        // upstream stream was reset) or a Response with a non-2xx
        // status — both are valid "request was killed mid-stream"
        // outcomes. The key property is that no 200 OK reaches the
        // public client because the upstream never produced one.
        match proxy(state, req).await {
            Err(e) => {
                assert!(
                    matches!(
                        e,
                        ProxyError::UpstreamHandshake | ProxyError::UpstreamProtocol
                    ),
                    "unexpected error variant: {e:?}"
                );
            }
            Ok(resp) => {
                assert_ne!(
                    resp.status(),
                    StatusCode::OK,
                    "over-cap streamed body must not produce 200"
                );
            }
        }

        let _ = server_task.await;
        let _ = conn_task.await;
    }

    #[tokio::test]
    async fn upstream_response_oversize_content_length_returns_507() {
        // Upstream advertises an over-cap Content-Length on the
        // response. The proxy must refuse with 507 before forwarding
        // any body bytes to the public client. The CL on the wire is
        // a lie (we send EOS immediately) but that's fine — the
        // check is on the header only.
        let (server_io, client_io) = duplex(64 * 1024);

        let too_big = (MAX_PROXY_BODY_BYTES as u64) + 1;
        let server_task = tokio::spawn(async move {
            let mut conn = H2ServerBuilder::new()
                .handshake::<_, Bytes>(server_io)
                .await
                .expect("h2 server handshake");
            if let Some(item) = conn.accept().await {
                let (request, mut respond) = item.expect("h2 accept");
                let (_p, mut body) = request.into_parts();
                while let Some(chunk) = body.data().await {
                    if let Ok(c) = chunk {
                        let _ = body.flow_control().release_capacity(c.len());
                    }
                }
                let resp = HttpResponse::builder()
                    .status(200)
                    .header("content-length", too_big.to_string())
                    .body(())
                    .unwrap();
                // EOS on headers — no body frames. The lying CL is
                // what we want the proxy to react to.
                let _ = respond.send_response(resp, true);
            }
            while conn.accept().await.is_some() {}
        });

        let (sender, h2_conn) = h2::client::Builder::new()
            .handshake::<_, Bytes>(client_io)
            .await
            .expect("h2 client handshake");
        let conn_task = tokio::spawn(async move {
            let _ = h2_conn.await;
        });
        let sender = sender.ready().await.expect("sender ready");

        let registry = LinkSessionRegistry::new();
        registry.insert(
            LinkSessionInfo {
                link_id: "test-link".into(),
                cluster_id: "test-cluster".into(),
                node_id: "test-node".into(),
                software_version: "0.0.0-test".into(),
                since: std::time::Instant::now(),
            },
            sender,
        );
        let signer = HmacEdgeSigner::from_config(
            Zeroizing::new(b"a-32-char-or-longer-edge-hmac-key!!".to_vec()),
            "test-node".into(),
            &[],
        );
        let state = ProxyState::new(registry, Arc::new(signer));

        let req = http::Request::builder()
            .method("GET")
            .uri("/api/big")
            .header("host", "public.example.com")
            .body(Body::empty())
            .unwrap();

        // `proxy` maps UpstreamTooLarge → 507. But because the
        // handler in tests calls `proxy(...)` directly (not
        // proxy_handler), we receive the raw error.
        let err = proxy(state, req).await.expect_err("expected error");
        assert!(
            matches!(err, ProxyError::UpstreamTooLarge),
            "unexpected error variant: {err:?}"
        );
        // Sanity: IntoResponse maps it to 507.
        assert_eq!(
            err.into_response().status(),
            StatusCode::INSUFFICIENT_STORAGE
        );

        let _ = server_task.await;
        let _ = conn_task.await;
    }
}
