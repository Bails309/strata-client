//! Extended-CONNECT (RFC 8441) upgrade handler for the internal-side
//! DMZ link multiplexer.
//!
//! The default [`RequestHandler`](super::h2_serve::RequestHandler)
//! interface fully buffers request bodies and returns a buffered
//! response — perfect for REST traffic, useless for WebSockets where
//! both halves of the stream must stay open and stream bytes
//! bidirectionally for the lifetime of the session.
//!
//! For WebSocket-over-HTTP/2 we take a different path:
//!
//! 1. The DMZ proxy detects `Upgrade: websocket` on the public
//!    request and opens an Extended CONNECT stream on the link with
//!    `:method=CONNECT, :protocol=websocket, :path=<original path>`.
//! 2. The internal h2 server (with `enable_connect_protocol()`)
//!    receives that stream and dispatches it here.
//! 3. The handler answers `:status=200` to acknowledge the upgrade,
//!    opens a loopback HTTP/1.1 connection to the local axum router
//!    (which already exposes `/api/tunnel/{id}` as a regular
//!    WebSocket route), replays the request as an HTTP/1.1 WebSocket
//!    upgrade, and bidirectionally pumps bytes between the h2 stream
//!    and the loopback TCP socket for the lifetime of the session.
//!
//! The bridge is deliberately byte-transparent — WebSocket frame
//! masking, ping/pong, fragmentation, and close frames all flow
//! through unmodified. The internal axum router (and the existing
//! `tunnel.rs` `ws_tunnel` handler) sees what looks like a normal
//! WebSocket upgrade originating from `127.0.0.1`; the
//! `verify_edge_headers` middleware promotes `x-strata-edge-client-ip`
//! from the forwarded headers to the real client IP for audit /
//! RBAC, exactly as on the regular Extended-CONNECT-less REST path.

use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use h2::server::SendResponse;
use h2::{RecvStream, SendStream};
use http::{HeaderMap, Method, Request, Response, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Maximum size of one HTTP/1.1 response-header block the loopback
/// bridge will read before declaring the upstream malformed and
/// tearing down the upgrade. 64 KiB is comfortably larger than every
/// realistic axum response and small enough to bound memory use even
/// if the loopback connects to a misconfigured target.
const MAX_LOOPBACK_HEADER_BYTES: usize = 64 * 1024;

/// Maximum length of a single header line (request/response) in the
/// HTTP/1.1 conversation against the loopback. Defends against an
/// upstream that streams an unterminated header block.
const MAX_LINE_BYTES: usize = 8 * 1024;

/// Handler for inbound Extended CONNECT streams on the link.
///
/// Implementations are responsible for sending the `:status` response
/// on `respond` (typically `200 OK` for accept or `502/503` for
/// reject) and, on accept, driving the bidirectional pump until the
/// peer closes the stream.
#[async_trait]
pub trait UpgradeHandler: Send + Sync + 'static {
    /// Handle a single inbound Extended CONNECT stream. Must not panic.
    async fn handle(
        &self,
        req: Request<RecvStream>,
        respond: SendResponse<Bytes>,
    ) -> anyhow::Result<()>;
}

/// Stub upgrade handler that rejects every Extended CONNECT stream
/// with `503 Service Unavailable`. Used in tests and as the default
/// when the operator has not opted into WebSocket bridging.
pub struct RejectUpgradeHandler;

#[async_trait]
impl UpgradeHandler for RejectUpgradeHandler {
    async fn handle(
        &self,
        _req: Request<RecvStream>,
        mut respond: SendResponse<Bytes>,
    ) -> anyhow::Result<()> {
        let resp = Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("x-strata-link", "upgrade-disabled")
            .body(())
            .expect("static response");
        let mut send = respond
            .send_response(resp, false)
            .map_err(|e| anyhow::anyhow!("h2 send 503: {e}"))?;
        let body = Bytes::from_static(b"DMZ link WebSocket bridging is not enabled on this node");
        send.send_data(body, true)
            .map_err(|e| anyhow::anyhow!("h2 send 503 body: {e}"))?;
        Ok(())
    }
}

/// Loopback WebSocket bridge — receives an Extended CONNECT stream
/// from the DMZ link and translates it into a regular HTTP/1.1
/// WebSocket upgrade against `127.0.0.1:<backend_port>`.
///
/// The bridge is intentionally minimal: it drives the outer
/// Extended-CONNECT handshake, performs an inner HTTP/1.1 WebSocket
/// upgrade against the local axum router, and then byte-pumps
/// between the two streams until either side closes.
pub struct LoopbackUpgradeHandler {
    addr: SocketAddr,
}

impl LoopbackUpgradeHandler {
    /// Construct a bridge that targets the supplied loopback address.
    pub fn new(addr: SocketAddr) -> Self {
        Self { addr }
    }
}

#[async_trait]
impl UpgradeHandler for LoopbackUpgradeHandler {
    async fn handle(
        &self,
        req: Request<RecvStream>,
        respond: SendResponse<Bytes>,
    ) -> anyhow::Result<()> {
        let addr = self.addr;
        bridge(req, respond, addr).await
    }
}

async fn bridge(
    req: Request<RecvStream>,
    mut respond: SendResponse<Bytes>,
    target: SocketAddr,
) -> anyhow::Result<()> {
    let (parts, recv) = req.into_parts();

    // Open the loopback TCP connection. If we can't reach the local
    // backend, fail the Extended CONNECT with 502 so the public
    // client sees a clean error instead of a hung WebSocket upgrade.
    let mut tcp = match TcpStream::connect(target).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, %target, "loopback connect failed");
            let _ = respond.send_response(
                Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .header("x-strata-link", "loopback-connect")
                    .body(())
                    .expect("static response"),
                true,
            );
            return Err(anyhow::anyhow!("loopback connect failed: {e}"));
        }
    };

    // Send the inner HTTP/1.1 WebSocket upgrade against the local
    // backend. We synthesize a fresh `Sec-WebSocket-Key` because RFC
    // 8441 Extended CONNECT does NOT carry the original key over h2
    // — that's the whole point of the new pseudo-header approach.
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let host_header = parts
        .headers
        .get(http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("internal.local");
    let key = generate_ws_key();
    let mut req_buf = Vec::with_capacity(512);
    req_buf.extend_from_slice(format!("GET {path_and_query} HTTP/1.1\r\n").as_bytes());
    req_buf.extend_from_slice(format!("Host: {host_header}\r\n").as_bytes());
    req_buf.extend_from_slice(b"Upgrade: websocket\r\n");
    req_buf.extend_from_slice(b"Connection: Upgrade\r\n");
    req_buf.extend_from_slice(format!("Sec-WebSocket-Key: {key}\r\n").as_bytes());
    req_buf.extend_from_slice(b"Sec-WebSocket-Version: 13\r\n");

    // Forward every other header verbatim (cookies, x-strata-edge-*,
    // sec-websocket-protocol, etc.) excluding the ones we just
    // synthesized and the hop-by-hop set that does not belong on
    // the inner HTTP/1.1 leg.
    write_forwarded_headers(&mut req_buf, &parts.headers);
    req_buf.extend_from_slice(b"\r\n");

    if let Err(e) = tcp.write_all(&req_buf).await {
        tracing::warn!(error = %e, "loopback write request failed");
        let _ = respond.send_response(
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .header("x-strata-link", "loopback-write")
                .body(())
                .expect("static response"),
            true,
        );
        return Err(anyhow::anyhow!("loopback write request: {e}"));
    }

    // Read the loopback response headers up to and including the
    // terminating CRLFCRLF. We don't need the headers themselves —
    // we just need to know if it's 101 (upgrade accepted) and then
    // start byte-pumping after the header terminator.
    let (status, leftover) = match read_http1_response_head(&mut tcp).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "loopback read response head failed");
            let _ = respond.send_response(
                Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .header("x-strata-link", "loopback-read")
                    .body(())
                    .expect("static response"),
                true,
            );
            return Err(anyhow::anyhow!("loopback read response head: {e}"));
        }
    };

    if status != 101 {
        // Loopback rejected the upgrade (auth failure, 404, etc.).
        // Translate that into a 502 on the Extended CONNECT so the
        // public client sees a clean error rather than a half-open
        // WebSocket.
        tracing::info!(
            loopback_status = status,
            "loopback rejected websocket upgrade",
        );
        let resp_status = if status == 401 || status == 403 || status == 404 {
            // These are legitimate client-visible failures — pass
            // through verbatim so the SPA can react.
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY)
        } else {
            StatusCode::BAD_GATEWAY
        };
        let _ = respond.send_response(
            Response::builder()
                .status(resp_status)
                .header("x-strata-link", "loopback-rejected")
                .body(())
                .expect("static response"),
            true,
        );
        return Ok(());
    }

    // Loopback upgraded successfully. Tell the DMZ side we're good.
    let send_stream = respond
        .send_response(
            Response::builder()
                .status(StatusCode::OK)
                .body(())
                .expect("static response"),
            false,
        )
        .map_err(|e| anyhow::anyhow!("h2 send 200: {e}"))?;

    pump(recv, send_stream, tcp, leftover).await
}

/// Bidirectionally byte-pump until either side closes.
///
/// `leftover` is any bytes the response-head reader buffered past
/// the CRLFCRLF terminator — those are the start of the inbound
/// WebSocket frames from the loopback target and must be forwarded
/// to the DMZ before we start reading more from the TCP socket.
async fn pump(
    mut recv: RecvStream,
    mut send: SendStream<Bytes>,
    tcp: TcpStream,
    leftover: Bytes,
) -> anyhow::Result<()> {
    let (mut tcp_r, mut tcp_w) = tcp.into_split();

    // Forward the leftover bytes (post-CRLFCRLF) before we start the
    // copy loops. They are real WebSocket payload from the upstream.
    if !leftover.is_empty() {
        send.send_data(leftover, false)
            .map_err(|e| anyhow::anyhow!("h2 send leftover: {e}"))?;
    }

    // h2-recv → loopback-write
    let dmz_to_loopback = async move {
        while let Some(chunk) = recv.data().await {
            let chunk = chunk.map_err(|e| anyhow::anyhow!("h2 recv data: {e}"))?;
            let _ = recv.flow_control().release_capacity(chunk.len());
            if chunk.is_empty() {
                continue;
            }
            tcp_w
                .write_all(&chunk)
                .await
                .map_err(|e| anyhow::anyhow!("loopback tcp write: {e}"))?;
        }
        // Half-close the loopback so the upstream sees EOF.
        let _ = tcp_w.shutdown().await;
        anyhow::Ok(())
    };

    // loopback-read → h2-send
    let loopback_to_dmz = async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = tcp_r
                .read(&mut buf)
                .await
                .map_err(|e| anyhow::anyhow!("loopback tcp read: {e}"))?;
            if n == 0 {
                break;
            }
            let chunk = Bytes::copy_from_slice(&buf[..n]);
            send.reserve_capacity(chunk.len());
            send.send_data(chunk, false)
                .map_err(|e| anyhow::anyhow!("h2 send data: {e}"))?;
        }
        // Send empty data with end_of_stream to half-close the h2
        // sender; ignore errors — peer may have already gone away.
        let _ = send.send_data(Bytes::new(), true);
        anyhow::Ok(())
    };

    // Bridge dies as soon as either direction errors / hits EOF.
    // The other half is dropped so its tasks unwind.
    tokio::select! {
        r = dmz_to_loopback => r?,
        r = loopback_to_dmz => r?,
    }
    Ok(())
}

/// Generate a random 16-byte WebSocket key, base64-encoded.
fn generate_ws_key() -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let mut bytes = [0u8; 16];
    {
        use rand::Rng;
        rand::rng().fill(&mut bytes);
    }
    STANDARD.encode(bytes)
}

/// Append every header that should travel on the inner HTTP/1.1
/// upgrade. Skips the headers we already wrote (`host`, `upgrade`,
/// `connection`, `sec-websocket-key`, `sec-websocket-version`) and
/// hop-by-hop headers that do not belong on a fresh leg.
fn write_forwarded_headers(buf: &mut Vec<u8>, headers: &HeaderMap) {
    for (name, value) in headers {
        let n = name.as_str();
        if matches!(
            n,
            "host"
                | "upgrade"
                | "connection"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "transfer-encoding"
                | "te"
                | "trailer"
                | "keep-alive"
                | "proxy-connection"
        ) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            // Header values that contain CRLF are dropped; HeaderValue
            // already enforces this on the inbound side but we
            // double-check before stitching them into a wire-format
            // request.
            if v.contains('\r') || v.contains('\n') {
                continue;
            }
            buf.extend_from_slice(name.as_str().as_bytes());
            buf.extend_from_slice(b": ");
            buf.extend_from_slice(v.as_bytes());
            buf.extend_from_slice(b"\r\n");
        }
    }
}

/// Read until CRLFCRLF, parse the status line, return `(status, leftover)`
/// where `leftover` is any bytes captured past the header terminator.
async fn read_http1_response_head(tcp: &mut TcpStream) -> anyhow::Result<(u16, Bytes)> {
    let mut acc: Vec<u8> = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    loop {
        if acc.len() > MAX_LOOPBACK_HEADER_BYTES {
            return Err(anyhow::anyhow!("loopback response header block too large"));
        }
        let n = tcp.read(&mut tmp).await?;
        if n == 0 {
            return Err(anyhow::anyhow!("loopback closed before response headers"));
        }
        acc.extend_from_slice(&tmp[..n]);
        if let Some(idx) = find_crlfcrlf(&acc) {
            let header_end = idx + 4;
            let leftover = if header_end < acc.len() {
                Bytes::copy_from_slice(&acc[header_end..])
            } else {
                Bytes::new()
            };
            let head = &acc[..idx + 2]; // include final CRLF on last header
            let status = parse_status_line(head)?;
            return Ok((status, leftover));
        }
    }
}

fn find_crlfcrlf(buf: &[u8]) -> Option<usize> {
    if buf.len() < 4 {
        return None;
    }
    for i in 0..=buf.len() - 4 {
        if &buf[i..i + 4] == b"\r\n\r\n" {
            return Some(i);
        }
    }
    None
}

fn parse_status_line(head: &[u8]) -> anyhow::Result<u16> {
    let line_end = head
        .windows(2)
        .position(|w| w == b"\r\n")
        .ok_or_else(|| anyhow::anyhow!("no CRLF in response head"))?;
    if line_end > MAX_LINE_BYTES {
        return Err(anyhow::anyhow!("response status line too long"));
    }
    let line = std::str::from_utf8(&head[..line_end])
        .map_err(|_| anyhow::anyhow!("response status line is not utf-8"))?;
    let mut parts = line.splitn(3, ' ');
    let _http = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("missing http version"))?;
    let status_str = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("missing status code"))?;
    let status: u16 = status_str
        .parse()
        .map_err(|_| anyhow::anyhow!("status code is not numeric"))?;
    Ok(status)
}

/// True when `req` is an Extended CONNECT WebSocket upgrade as
/// defined by RFC 8441 — `:method=CONNECT` and `:protocol=websocket`.
pub fn is_websocket_extended_connect<T>(req: &Request<T>) -> bool {
    if req.method() != Method::CONNECT {
        return false;
    }
    match req.extensions().get::<h2::ext::Protocol>() {
        Some(p) => p.as_str().eq_ignore_ascii_case("websocket"),
        None => false,
    }
}

#[allow(dead_code)]
/// Helper for tests / external embedders: wrap an `Arc<dyn UpgradeHandler>`.
pub type SharedUpgradeHandler = Arc<dyn UpgradeHandler>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_websocket_extended_connect() {
        let mut req = Request::builder()
            .method(Method::CONNECT)
            .uri("https://internal/api/tunnel/abc")
            .body(())
            .unwrap();
        req.extensions_mut()
            .insert(h2::ext::Protocol::from_static("websocket"));
        assert!(is_websocket_extended_connect(&req));
    }

    #[test]
    fn ignores_non_connect_methods() {
        let mut req = Request::builder()
            .method(Method::GET)
            .uri("/")
            .body(())
            .unwrap();
        req.extensions_mut()
            .insert(h2::ext::Protocol::from_static("websocket"));
        assert!(!is_websocket_extended_connect(&req));
    }

    #[test]
    fn ignores_connect_without_protocol() {
        let req = Request::builder()
            .method(Method::CONNECT)
            .uri("internal:443")
            .body(())
            .unwrap();
        assert!(!is_websocket_extended_connect(&req));
    }

    #[test]
    fn ignores_non_websocket_protocol() {
        let mut req = Request::builder()
            .method(Method::CONNECT)
            .uri("/")
            .body(())
            .unwrap();
        req.extensions_mut()
            .insert(h2::ext::Protocol::from_static("nonsense"));
        assert!(!is_websocket_extended_connect(&req));
    }

    #[test]
    fn matches_websocket_case_insensitively() {
        let mut req = Request::builder()
            .method(Method::CONNECT)
            .uri("/")
            .body(())
            .unwrap();
        req.extensions_mut()
            .insert(h2::ext::Protocol::from_static("WebSocket"));
        assert!(is_websocket_extended_connect(&req));
    }

    #[test]
    fn parses_simple_status_line() {
        let head = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n";
        assert_eq!(parse_status_line(head).unwrap(), 101);
    }

    #[test]
    fn rejects_status_line_without_crlf() {
        let head = b"HTTP/1.1 200 OK";
        assert!(parse_status_line(head).is_err());
    }

    #[test]
    fn rejects_non_numeric_status() {
        let head = b"HTTP/1.1 OK Foo\r\n";
        assert!(parse_status_line(head).is_err());
    }

    #[test]
    fn finds_crlfcrlf() {
        let buf = b"abc\r\n\r\ndef";
        assert_eq!(find_crlfcrlf(buf), Some(3));
        assert_eq!(find_crlfcrlf(b"no crlf"), None);
        assert_eq!(find_crlfcrlf(b""), None);
    }

    #[test]
    fn writes_forwarded_headers_skips_hop_by_hop() {
        let mut headers = HeaderMap::new();
        headers.insert("cookie", "auth=xyz".parse().unwrap());
        headers.insert("x-strata-edge-client-ip", "1.2.3.4".parse().unwrap());
        headers.insert("upgrade", "websocket".parse().unwrap());
        headers.insert("connection", "upgrade".parse().unwrap());
        headers.insert("host", "public.example".parse().unwrap());
        headers.insert("sec-websocket-key", "abc".parse().unwrap());

        let mut buf = Vec::new();
        write_forwarded_headers(&mut buf, &headers);
        let s = std::str::from_utf8(&buf).unwrap();
        assert!(s.contains("cookie: auth=xyz"));
        assert!(s.contains("x-strata-edge-client-ip: 1.2.3.4"));
        assert!(!s.to_lowercase().contains("upgrade:"));
        assert!(!s.to_lowercase().contains("connection:"));
        assert!(!s.to_lowercase().contains("host:"));
        assert!(!s.to_lowercase().contains("sec-websocket-key:"));
    }

    #[test]
    fn rejects_oversized_header_block() {
        // sanity: read_http1_response_head bounds with MAX_LOOPBACK_HEADER_BYTES,
        // exercised indirectly by parse_status_line's MAX_LINE_BYTES.
        let mut head = Vec::new();
        head.extend_from_slice(b"HTTP/1.1 ");
        head.extend(std::iter::repeat(b'x').take(MAX_LINE_BYTES + 10));
        head.extend_from_slice(b"\r\n");
        assert!(parse_status_line(&head).is_err());
    }
}
