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
//! 4. Send the request with `end_of_stream = false` whenever the
//!    incoming body is non-empty; stream the body up via
//!    `SendStream::send_data` with backpressure honored by
//!    `reserve_capacity` / `poll_capacity`.
//! 5. Read response headers, then stream body frames back to the
//!    public client up to [`MAX_PROXY_BODY_BYTES`]; trailers are
//!    dropped (axum can't stream HTTP/1.1 trailers reliably to all
//!    clients and this proxy is HTTP/1.1 + h2 to public).
//!
//! ## Hop-by-hop headers
//!
//! Per RFC 7230 §6.1, hop-by-hop headers MUST NOT be forwarded:
//! `connection`, `proxy-connection`, `keep-alive`, `transfer-encoding`,
//! `te`, `trailer`, `upgrade`. Plus `host` (h2 uses `:authority`).
//! Any header listed in the value of `connection:` is also hop-by-hop.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::Request as AxumRequest;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use h2::client::SendRequest;
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
    BodyReadFailed,
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ProxyError::NoLinkUp => (StatusCode::SERVICE_UNAVAILABLE, "no internal links available"),
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
            ProxyError::BodyReadFailed => (StatusCode::BAD_REQUEST, "request body read failed"),
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

    // Eagerly buffer the request body up to the limit. Streaming a
    // partially-read body through h2 is supported by the h2 crate
    // but adds a second backpressure axis we don't need for the v1
    // surface (admin UI, OIDC callbacks, REST). If a future workload
    // needs streaming uploads, this is the seam to extend.
    let body_bytes = match read_body_capped(body, MAX_PROXY_BODY_BYTES).await {
        Ok(b) => b,
        Err(BodyReadError::TooLarge) => {
            // Refuse before touching the link.
            return Ok((StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response());
        }
        Err(BodyReadError::Io) => return Err(ProxyError::BodyReadFailed),
    };

    // Try twice: once with the first pick, once with a fresh pick if
    // the first sender was already broken.
    let mut last_err: Option<ProxyError> = None;
    for attempt in 0..2 {
        let (info, sender) = match state.registry.pick_any() {
            Some(p) => p,
            None => return Err(ProxyError::NoLinkUp),
        };

        match forward_one(sender, &method, &upstream_uri, &headers, &body_bytes).await {
            Ok(resp) => {
                tracing::debug!(
                    link_id = %info.link_id,
                    node_id = %info.node_id,
                    method = %method,
                    path = %upstream_uri.path(),
                    attempt,
                    "DMZ proxied request"
                );
                return Ok(resp);
            }
            Err(e @ ProxyError::LinkSendUnavailable) | Err(e @ ProxyError::UpstreamHandshake) => {
                // Sender was broken. Evict it and try again.
                state.registry.remove(&info.link_id);
                last_err = Some(e);
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or(ProxyError::LinkSendUnavailable))
}

async fn forward_one(
    sender: SendRequest<Bytes>,
    method: &http::Method,
    upstream_uri: &Uri,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Response, ProxyError> {
    // Wait for the sender to become ready. If it errors, the
    // connection went away — caller will retry with another pick.
    let mut sender = sender.ready().await.map_err(|e| {
        tracing::debug!(error = %e, "link sender not ready (eviction will follow)");
        ProxyError::LinkSendUnavailable
    })?;

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

    let end_of_stream = body.is_empty();
    let (resp_fut, mut send_stream) = sender.send_request(up_req, end_of_stream).map_err(|e| {
        tracing::debug!(error = %e, "send_request failed");
        ProxyError::LinkSendUnavailable
    })?;

    // Push the body up. Honors h2 flow control via reserve_capacity.
    if !body.is_empty() {
        send_stream.reserve_capacity(body.len());
        // We send the entire pre-buffered body as a single DATA frame;
        // h2 will fragment per the negotiated MAX_FRAME_SIZE.
        send_stream
            .send_data(body.clone(), true)
            .map_err(|e| {
                tracing::debug!(error = %e, "send_data failed");
                ProxyError::UpstreamProtocol
            })?;
    }

    // Receive the response head.
    let resp = resp_fut.await.map_err(|e| {
        tracing::debug!(error = %e, "upstream h2 response future errored");
        ProxyError::UpstreamHandshake
    })?;

    let (head, mut recv) = resp.into_parts();

    // Stream / accumulate response body up to the cap.
    let mut buf = BytesMut::new();
    while let Some(frame) = recv.data().await {
        let chunk = frame.map_err(|e| {
            tracing::debug!(error = %e, "upstream response data frame errored");
            ProxyError::UpstreamProtocol
        })?;
        if buf.len().saturating_add(chunk.len()) > MAX_PROXY_BODY_BYTES {
            return Err(ProxyError::UpstreamTooLarge);
        }
        let len = chunk.len();
        buf.extend_from_slice(&chunk);
        // Release flow-control window for the chunk we just consumed.
        if let Err(e) = recv.flow_control().release_capacity(len) {
            tracing::debug!(error = %e, "release_capacity failed");
        }
    }

    // Drop trailers — see module docs.

    // Build the public response with the upstream status + headers,
    // minus hop-by-hop fields.
    let mut public = Response::builder().status(head.status);
    {
        let h = public.headers_mut().expect("fresh builder has headers map");
        for (k, v) in head.headers.iter() {
            if !is_hop_by_hop(k) {
                h.append(k.clone(), v.clone());
            }
        }
    }
    public
        .body(Body::from(buf.freeze()))
        .map_err(|e| {
            tracing::warn!(error = %e, "failed to build public response");
            ProxyError::UpstreamProtocol
        })
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

#[derive(Debug)]
enum BodyReadError {
    TooLarge,
    Io,
}

async fn read_body_capped(body: Body, cap: usize) -> Result<Bytes, BodyReadError> {
    use http_body_util::BodyDataStream;
    let mut stream = BodyDataStream::new(body);
    let mut buf = BytesMut::new();
    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|e| {
            tracing::debug!(error = %e, "request body read errored");
            BodyReadError::Io
        })?;
        if buf.len().saturating_add(chunk.len()) > cap {
            return Err(BodyReadError::TooLarge);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf.freeze())
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
        h.insert(http::header::CONNECTION, "close, x-private".parse().unwrap());
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
        assert_eq!(h.get("x-existing").map(|v| v.as_bytes()), Some(b"1".as_ref()));
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
            parts.headers.get("x-strata-edge-link-id").map(|v| v.as_bytes()),
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
        let (state1, rx1, st1, ct1) =
            make_proxy_with_fake_internal("real-dmz-node", &[]).await;
        let (state2, rx2, st2, ct2) =
            make_proxy_with_fake_internal("real-dmz-node", &[]).await;

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
}
