//! WebSocket-over-h2 (RFC 8441 Extended CONNECT) forwarding for the
//! DMZ link.
//!
//! The plain REST [`super::proxy`] flow buffers every request and
//! response — fine for the admin UI / OIDC callbacks, useless for
//! `/api/tunnel/{id}` which is a long-lived bidirectional WebSocket
//! carrying Guacamole protocol traffic.
//!
//! When the public-side hyper listener receives a WebSocket upgrade
//! we:
//!
//! 1. Capture `hyper::upgrade::on(&mut req)` so that, once we return
//!    a 101 response, hyper hands us the upgraded TCP socket as a
//!    plain bidirectional byte stream.
//! 2. Open an Extended CONNECT stream on a registered link sender
//!    (`:method=CONNECT`, `:protocol=websocket`, `:path=<original>`,
//!    plus the signed edge-header bundle and any non-hop-by-hop
//!    headers from the original request). The internal-side
//!    `LoopbackUpgradeHandler` accepts that stream and bridges it
//!    to the in-process `/api/tunnel/{id}` axum handler.
//! 3. Wait for the inner `:status=200` so we know the tunnel is up
//!    end-to-end before we acknowledge the upgrade publicly.
//! 4. Return a `101 Switching Protocols` response with the
//!    correctly-computed `Sec-WebSocket-Accept` so the public
//!    client transitions into WebSocket mode.
//! 5. Spawn a bidirectional byte-pump that copies frames between
//!    the public TCP socket and the h2 stream. We are deliberately
//!    transparent — frame masking, ping/pong, fragmentation, and
//!    close frames flow through unmodified.

use axum::body::Body;
use axum::extract::Request as AxumRequest;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use bytes::Bytes;
use h2::client::SendRequest;
use http::{Request as HttpRequest, Uri};
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::proxy::{ProxyState, MAX_PROXY_BODY_BYTES};

/// RFC 6455 magic GUID concatenated with `Sec-WebSocket-Key` before
/// SHA-1 + base64 to form `Sec-WebSocket-Accept`.
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Headers we never forward through the inner Extended CONNECT —
/// either because they are hop-by-hop, because the inner h2 stream
/// uses pseudo-headers instead, or because RFC 8441 §5.1 explicitly
/// forbids carrying the WebSocket handshake-marker headers.
const SKIP_FORWARD: &[&str] = &[
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "proxy-connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-accept",
    "sec-websocket-extensions",
];

/// Returns true when `headers` describe an HTTP/1.1 WebSocket upgrade
/// request (RFC 6455 §4.1).
pub fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let upgrade_is_ws = headers
        .get(http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    if !upgrade_is_ws {
        return false;
    }
    let connection_has_upgrade = headers
        .get(http::header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            s.split(',')
                .any(|tok| tok.trim().eq_ignore_ascii_case("upgrade"))
        })
        .unwrap_or(false);
    if !connection_has_upgrade {
        return false;
    }
    if headers.get("sec-websocket-key").is_none() {
        return false;
    }
    // RFC 6455 §1.2 — the only protocol version a server is required
    // to accept is 13. Older drafts (8, 12) are obsolete and pre-date
    // the framing/masking we rely on; treating them as a valid upgrade
    // would create asymmetry between what the DMZ accepts publicly and
    // what the inner backend accepts on the loopback side, which is
    // the building block for a smuggling attack.
    headers
        .get("sec-websocket-version")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim() == "13")
        .unwrap_or(false)
}

/// Compute the `Sec-WebSocket-Accept` value for a given client
/// `Sec-WebSocket-Key` (RFC 6455 §1.3).
pub fn compute_accept(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(WS_GUID.as_bytes());
    let digest = hasher.finalize();
    STANDARD.encode(digest)
}

/// Errors specific to the WebSocket forwarding path. Each variant
/// maps to a short HTTP response we send to the public client BEFORE
/// the upgrade — once we've returned 101 the connection is hijacked
/// and only the bridge task can observe further failures.
#[derive(Debug)]
pub(crate) enum WsProxyError {
    NoLinkUp,
    LinkSendUnavailable,
    UpstreamHandshake,
    UpstreamRejected(StatusCode),
    InvalidRequest,
}

impl IntoResponse for WsProxyError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            WsProxyError::NoLinkUp => (
                StatusCode::SERVICE_UNAVAILABLE,
                "no internal links available",
            ),
            WsProxyError::LinkSendUnavailable => {
                (StatusCode::BAD_GATEWAY, "link session lost during upgrade")
            }
            WsProxyError::UpstreamHandshake => {
                (StatusCode::BAD_GATEWAY, "upstream link upgrade failed")
            }
            WsProxyError::UpstreamRejected(s) => {
                let msg = match s.as_u16() {
                    401 => "upstream rejected websocket: unauthorized",
                    403 => "upstream rejected websocket: forbidden",
                    404 => "upstream rejected websocket: not found",
                    _ => "upstream rejected websocket upgrade",
                };
                (s, msg)
            }
            WsProxyError::InvalidRequest => {
                (StatusCode::BAD_REQUEST, "invalid websocket upgrade request")
            }
        };
        let mut resp = (status, msg).into_response();
        resp.headers_mut().insert(
            HeaderName::from_static("x-strata-link"),
            HeaderValue::from_static("dmz-proxy-ws"),
        );
        resp
    }
}

/// Drive the public-side WebSocket upgrade through the link.
///
/// The caller is expected to have already verified
/// [`is_websocket_upgrade`]; non-WS requests should take the regular
/// REST path.
pub(crate) async fn proxy_websocket(
    state: ProxyState,
    mut req: AxumRequest,
) -> Result<Response, WsProxyError> {
    // Capture peer info BEFORE consuming the request.
    let peer: Option<std::net::SocketAddr> = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|c| c.0);

    // Take the upgrade future first — once we destructure into
    // parts the OnUpgrade extension is gone.
    let on_upgrade = hyper::upgrade::on(&mut req);

    let (parts, _body) = req.into_parts();
    let method = parts.method.clone();
    let uri = parts.uri.clone();
    let headers = parts.headers.clone();

    // RFC 6455 — server MUST echo back Sec-WebSocket-Accept derived
    // from the client's Sec-WebSocket-Key. Without this, no compliant
    // client will treat the 101 as a successful upgrade.
    let client_key = headers
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .ok_or(WsProxyError::InvalidRequest)?;
    let accept = compute_accept(&client_key);

    // Build the upstream URI. h2 needs a non-empty `:authority`;
    // mirror the same logic the REST proxy uses.
    let authority: Option<http::uri::Authority> = uri.authority().cloned().or_else(|| {
        headers
            .get(http::header::HOST)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
    });
    let path_and_query = uri
        .path_and_query()
        .cloned()
        .unwrap_or_else(|| http::uri::PathAndQuery::from_static("/"));
    let upstream_uri: Uri = {
        let mut b = Uri::builder().scheme("http").path_and_query(path_and_query);
        if let Some(auth) = authority {
            b = b.authority(auth);
        } else {
            return Err(WsProxyError::InvalidRequest);
        }
        b.build().map_err(|_| WsProxyError::InvalidRequest)?
    };

    // Forward all non-skipped headers (cookies, sec-websocket-protocol,
    // x-forwarded-* if any) plus the signed edge-header bundle.
    let mut forward_headers = HeaderMap::new();
    for (name, value) in headers.iter() {
        if SKIP_FORWARD
            .iter()
            .any(|s| s.eq_ignore_ascii_case(name.as_str()))
        {
            continue;
        }
        forward_headers.append(name.clone(), value.clone());
    }
    state.signer.sign(&mut forward_headers, peer, &method, &uri);

    // Pick a link sender. Try twice on a stale-pick failure — same
    // pattern as the REST proxy.
    let (info, recv_body, send_stream, upstream_headers) = {
        let mut last_err: Option<WsProxyError> = None;
        let mut acquired: Option<(_, _, _, _)> = None;
        for _attempt in 0..2 {
            let (info, sender) = match state.registry.pick_any() {
                Some(p) => p,
                None => return Err(WsProxyError::NoLinkUp),
            };
            match start_extended_connect(sender, &upstream_uri, &forward_headers).await {
                Ok((recv, send, hdrs)) => {
                    acquired = Some((info, recv, send, hdrs));
                    break;
                }
                Err(e @ WsProxyError::LinkSendUnavailable)
                | Err(e @ WsProxyError::UpstreamHandshake) => {
                    state.registry.remove(&info.link_id);
                    last_err = Some(e);
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        match acquired {
            Some(t) => t,
            None => return Err(last_err.unwrap_or(WsProxyError::LinkSendUnavailable)),
        }
    };

    tracing::debug!(
        link_id = %info.link_id,
        node_id = %info.node_id,
        path = %upstream_uri.path(),
        "DMZ websocket upgraded over link",
    );

    // Spawn the bridge task. It will await the upgraded public TCP
    // socket and start byte-pumping once hyper completes the
    // protocol switch. Any error here is logged but cannot reach
    // the public client (we've already sent 101).
    tokio::spawn(async move {
        let upgraded = match on_upgrade.await {
            Ok(u) => u,
            Err(e) => {
                let err_str = e.to_string();
                tracing::warn!("public websocket upgrade future errored: {}", err_str);
                return;
            }
        };
        if let Err(e) = pump(upgraded, recv_body, send_stream).await {
            let err_str = e.to_string();
            tracing::debug!("DMZ websocket bridge ended: {}", err_str);
        }
    });

    // 101 Switching Protocols back to the public client. RFC 6455
    // §4.2.2 requires us to echo the negotiated `sec-websocket-protocol`
    // (and any `sec-websocket-extensions`) the upstream selected — if
    // we don't, browsers fail the WebSocket connection immediately.
    let mut builder = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(http::header::UPGRADE, "websocket")
        .header(http::header::CONNECTION, "upgrade")
        .header("sec-websocket-accept", accept);
    for (name, value) in upstream_headers.iter() {
        if matches!(
            name.as_str(),
            "sec-websocket-protocol" | "sec-websocket-extensions"
        ) {
            builder = builder.header(name, value);
        }
    }
    let resp = builder
        .body(Body::empty())
        .map_err(|_| WsProxyError::UpstreamHandshake)?;
    Ok(resp)
}

/// Send the inner Extended CONNECT request and wait for the 200
/// acknowledgement from the internal node. Returns the inbound h2
/// halves plus the upstream's response headers (used to propagate
/// `sec-websocket-protocol` / `sec-websocket-extensions` onto the
/// public 101 — RFC 6455 §4.2.2).
async fn start_extended_connect(
    sender: SendRequest<Bytes>,
    upstream_uri: &Uri,
    headers: &HeaderMap,
) -> Result<(h2::RecvStream, h2::SendStream<Bytes>, HeaderMap), WsProxyError> {
    let mut sender = sender.ready().await.map_err(|e| {
        tracing::debug!(error = %e, "link sender not ready (eviction will follow)");
        WsProxyError::LinkSendUnavailable
    })?;

    let mut up_req = HttpRequest::builder()
        .method(http::Method::CONNECT)
        .uri(upstream_uri.clone())
        .version(http::Version::HTTP_2);
    {
        let h = up_req.headers_mut().expect("fresh builder has headers map");
        for (k, v) in headers.iter() {
            h.append(k.clone(), v.clone());
        }
    }
    let mut up_req = up_req
        .body(())
        .map_err(|_| WsProxyError::UpstreamHandshake)?;
    // RFC 8441: tell h2 to emit the `:protocol=websocket` pseudo-header.
    up_req
        .extensions_mut()
        .insert(h2::ext::Protocol::from_static("websocket"));

    let (resp_fut, send_stream) = sender.send_request(up_req, false).map_err(|e| {
        tracing::debug!(error = %e, "send_request (extended connect) failed");
        WsProxyError::LinkSendUnavailable
    })?;

    let resp = resp_fut.await.map_err(|e| {
        tracing::debug!(error = %e, "upstream extended-connect response errored");
        WsProxyError::UpstreamHandshake
    })?;
    let (head, recv) = resp.into_parts();
    if head.status != StatusCode::OK {
        return Err(WsProxyError::UpstreamRejected(head.status));
    }

    Ok((recv, send_stream, head.headers))
}

/// Bidirectional byte-pump between the public hyper-upgraded TCP
/// stream and the h2 send/recv halves.
async fn pump(
    upgraded: hyper::upgrade::Upgraded,
    mut recv: h2::RecvStream,
    mut send: h2::SendStream<Bytes>,
) -> anyhow::Result<()> {
    // Wrap the `Upgraded` so it implements tokio's IO traits.
    let upgraded = hyper_util::rt::TokioIo::new(upgraded);
    let (mut tcp_r, mut tcp_w) = tokio::io::split(upgraded);

    // Per-IO timeout so a slow/idle peer can't pin an h2 stream
    // indefinitely. The websocket layer above us is expected to issue
    // its own ping/pong; this is a belt-and-braces upper bound.
    const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

    // public TCP -> h2
    let pub_to_link = async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = match tokio::time::timeout(IO_TIMEOUT, tcp_r.read(&mut buf)).await {
                Ok(Ok(n)) => n,
                Ok(Err(e)) => {
                    let err_str = e.to_string();
                    return Err(anyhow::anyhow!("public tcp read: {}", err_str));
                }
                Err(_) => return Err(anyhow::anyhow!("ws bridge: public→link read idle for 60s")),
            };
            if n == 0 {
                break;
            }
            let chunk = Bytes::copy_from_slice(&buf[..n]);
            send.reserve_capacity(chunk.len());
            send.send_data(chunk, false)
                .map_err(|e| anyhow::anyhow!("h2 send_data: {}", e))?;
        }
        let _ = send.send_data(Bytes::new(), true);
        anyhow::Ok(())
    };

    // h2 -> public TCP
    let link_to_pub = async move {
        loop {
            let next = match tokio::time::timeout(IO_TIMEOUT, recv.data()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => return Err(anyhow::anyhow!("ws bridge: link→public read idle for 60s")),
            };
            let chunk = next.map_err(|e| anyhow::anyhow!("h2 recv data: {}", e))?;
            let _ = recv.flow_control().release_capacity(chunk.len());
            if chunk.is_empty() {
                continue;
            }
            // Cap how big a single frame we'll relay so a malicious
            // internal node can't make us buffer arbitrary memory in
            // userspace before write() drains.
            if chunk.len() > MAX_PROXY_BODY_BYTES {
                return Err(anyhow::anyhow!("oversized h2 frame on websocket bridge"));
            }
            match tokio::time::timeout(IO_TIMEOUT, tcp_w.write_all(&chunk)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    let err_str = e.to_string();
                    return Err(anyhow::anyhow!("public tcp write: {}", err_str));
                }
                Err(_) => return Err(anyhow::anyhow!("ws bridge: public write idle for 60s")),
            }
        }
        let _ = tcp_w.shutdown().await;
        anyhow::Ok(())
    };

    tokio::select! {
        r = pub_to_link => r?,
        r = link_to_pub => r?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6455_accept_example() {
        // RFC 6455 §1.3 worked example.
        assert_eq!(
            compute_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        );
    }

    fn req_headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn detects_canonical_websocket_upgrade() {
        let h = req_headers(&[
            ("upgrade", "websocket"),
            ("connection", "Upgrade"),
            ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("sec-websocket-version", "13"),
        ]);
        assert!(is_websocket_upgrade(&h));
    }

    #[test]
    fn detects_websocket_in_multi_token_connection() {
        let h = req_headers(&[
            ("upgrade", "websocket"),
            ("connection", "keep-alive, Upgrade"),
            ("sec-websocket-key", "abc=="),
            ("sec-websocket-version", "13"),
        ]);
        assert!(is_websocket_upgrade(&h));
    }

    #[test]
    fn rejects_non_websocket_upgrade() {
        let h = req_headers(&[
            ("upgrade", "h2c"),
            ("connection", "Upgrade"),
            ("sec-websocket-key", "abc=="),
        ]);
        assert!(!is_websocket_upgrade(&h));
    }

    #[test]
    fn rejects_missing_connection_upgrade() {
        let h = req_headers(&[
            ("upgrade", "websocket"),
            ("connection", "keep-alive"),
            ("sec-websocket-key", "abc=="),
        ]);
        assert!(!is_websocket_upgrade(&h));
    }

    #[test]
    fn rejects_missing_websocket_key() {
        let h = req_headers(&[("upgrade", "websocket"), ("connection", "Upgrade")]);
        assert!(!is_websocket_upgrade(&h));
    }

    #[test]
    fn ws_upgrade_detection_is_case_insensitive() {
        let h = req_headers(&[
            ("upgrade", "WebSocket"),
            ("connection", "UPGRADE"),
            ("sec-websocket-key", "abc=="),
            ("sec-websocket-version", "13"),
        ]);
        assert!(is_websocket_upgrade(&h));
    }

    #[test]
    fn rejects_obsolete_websocket_version() {
        // Drafts 8 and 12 of RFC 6455 are obsolete and use a different
        // framing layer. Treating them as a valid upgrade publicly
        // while the inner backend rejects them is a smuggling primitive.
        for version in ["", "8", "12", "7", "foo"] {
            let h = req_headers(&[
                ("upgrade", "websocket"),
                ("connection", "Upgrade"),
                ("sec-websocket-key", "abc=="),
                ("sec-websocket-version", version),
            ]);
            assert!(
                !is_websocket_upgrade(&h),
                "version {version:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_missing_websocket_version() {
        // Even with everything else correct, an absent version header
        // means the client has not signalled RFC 6455 compliance.
        let h = req_headers(&[
            ("upgrade", "websocket"),
            ("connection", "Upgrade"),
            ("sec-websocket-key", "abc=="),
        ]);
        assert!(!is_websocket_upgrade(&h));
    }

    #[test]
    fn ws_proxy_error_response_status_codes() {
        assert_eq!(
            WsProxyError::NoLinkUp.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE,
        );
        assert_eq!(
            WsProxyError::LinkSendUnavailable.into_response().status(),
            StatusCode::BAD_GATEWAY,
        );
        assert_eq!(
            WsProxyError::UpstreamHandshake.into_response().status(),
            StatusCode::BAD_GATEWAY,
        );
        assert_eq!(
            WsProxyError::UpstreamRejected(StatusCode::FORBIDDEN)
                .into_response()
                .status(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            WsProxyError::InvalidRequest.into_response().status(),
            StatusCode::BAD_REQUEST,
        );
    }

    #[test]
    fn ws_proxy_response_carries_link_marker() {
        let resp = WsProxyError::NoLinkUp.into_response();
        assert_eq!(
            resp.headers().get("x-strata-link").map(|v| v.as_bytes()),
            Some(b"dmz-proxy-ws".as_ref()),
        );
    }
}
