//! Trusted-edge HTTP header verification (DMZ deployment mode).
//!
//! The DMZ node injects a bundle of `x-strata-edge-*` headers into every
//! request it forwards through the link, signed with an HMAC-SHA-256 tag
//! keyed by [`STRATA_DMZ_EDGE_HMAC_KEYS`]. This middleware:
//!
//! 1. If `STRATA_DMZ_EDGE_HMAC_KEYS` is **not** set in the environment,
//!    strips any `x-strata-edge-*` headers from the inbound request
//!    (defence-in-depth: a direct-to-internal client must not be able to
//!    smuggle them) and passes through. This is the default for
//!    standalone deployments.
//!
//! 2. If the env var **is** set:
//!    - Verify [`EDGE_HEADER_MAC`] against the canonicalised header set
//!      using any of the configured keys.
//!    - Verify the timestamp is within
//!      [`strata_protocol::edge_header::MAX_TIMESTAMP_SKEW_MS`].
//!    - On success, attach a [`TrustedEdgeContext`] request extension
//!      that downstream handlers / audit can prefer over the immediate
//!      socket peer.
//!    - On failure, **strip** the headers and pass through. We never
//!      reject the request — that would let a stray malformed request
//!      take a user offline. The downstream audit pipeline simply
//!      treats it as untrusted (same shape as standalone).
//!
//! ## Configuration
//!
//! | Env var | Meaning |
//! |---|---|
//! | `STRATA_DMZ_EDGE_HMAC_KEYS` | Comma-separated list of base64-encoded keys. First entry is the active key; subsequent entries are accepted during rotation windows. |
//!
//! ## Logging
//!
//! Verification outcomes are logged at `debug` (per-request) and surface
//! as Prometheus counters (Phase 1b) so an operator can spot a sudden
//! spike in failed-MAC traffic that might indicate key drift.

use std::collections::HashMap;
use std::sync::OnceLock;

use axum::{extract::Request, middleware::Next, response::Response};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use strata_protocol::edge_header::{
    self, EDGE_HEADERS_CANONICAL, EDGE_HEADER_MAC,
};
use zeroize::Zeroizing;

/// Verified, attacker-resistant edge metadata. Attached to the request
/// extensions when MAC verification succeeds.
#[derive(Debug, Clone)]
pub struct TrustedEdgeContext {
    /// Real client IP as seen by the DMZ.
    pub client_ip: String,
    /// Negotiated TLS version at the DMZ edge (e.g. `"1.3"`).
    pub tls_version: Option<String>,
    /// Negotiated TLS cipher suite at the DMZ edge.
    pub tls_cipher: Option<String>,
    /// JA3 fingerprint of the client TLS hello, if computed by the DMZ.
    pub tls_ja3: Option<String>,
    /// User-Agent verbatim.
    pub user_agent: Option<String>,
    /// DMZ-stamped request id (preferred over the local `x-request-id`).
    pub request_id: Option<String>,
    /// Stable id of the DMZ node that forwarded this request.
    pub link_id: Option<String>,
}

/// One-shot cache of the configured HMAC keys, parsed from
/// `STRATA_DMZ_EDGE_HMAC_KEYS` at first use.
///
/// `Zeroizing` ensures that if the env var is rotated and the process
/// restarts, the old keys do not linger in freed heap pages.
static KEYS: OnceLock<Vec<Zeroizing<Vec<u8>>>> = OnceLock::new();

/// Parse `STRATA_DMZ_EDGE_HMAC_KEYS` into a list of raw key bytes.
/// Empty / unset env var → empty list (verification disabled).
fn load_keys() -> Vec<Zeroizing<Vec<u8>>> {
    let raw = match std::env::var("STRATA_DMZ_EDGE_HMAC_KEYS") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return Vec::new(),
    };
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| B64.decode(s).ok())
        .map(Zeroizing::new)
        .collect()
}

fn keys() -> &'static [Zeroizing<Vec<u8>>] {
    KEYS.get_or_init(load_keys)
}

/// True when edge-header verification is enabled at startup.
pub fn is_enabled() -> bool {
    !keys().is_empty()
}

/// Collect every `x-strata-edge-*` header into a `HashMap<lower-case name, value>`.
/// Headers with non-UTF-8 values are dropped (treated as missing).
fn extract_edge_headers(req: &Request) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, value) in req.headers().iter() {
        let n = name.as_str();
        if n.starts_with("x-strata-edge-") {
            if let Ok(v) = value.to_str() {
                out.insert(n.to_ascii_lowercase(), v.to_string());
            }
        }
    }
    out
}

/// Remove every `x-strata-edge-*` header from the request.
fn strip_edge_headers(req: &mut Request) {
    let to_remove: Vec<_> = req
        .headers()
        .iter()
        .filter_map(|(n, _)| {
            if n.as_str().starts_with("x-strata-edge-") {
                Some(n.clone())
            } else {
                None
            }
        })
        .collect();
    for n in to_remove {
        req.headers_mut().remove(&n);
    }
}

/// Build a [`TrustedEdgeContext`] from a verified header set.
fn build_context(headers: &HashMap<String, String>) -> Option<TrustedEdgeContext> {
    let client_ip = headers.get("x-strata-edge-client-ip")?.clone();
    Some(TrustedEdgeContext {
        client_ip,
        tls_version: headers.get("x-strata-edge-tls-version").cloned(),
        tls_cipher: headers.get("x-strata-edge-tls-cipher").cloned(),
        tls_ja3: headers.get("x-strata-edge-tls-ja3").cloned(),
        user_agent: headers.get("x-strata-edge-user-agent").cloned(),
        request_id: headers.get("x-strata-edge-request-id").cloned(),
        link_id: headers.get("x-strata-edge-link-id").cloned(),
    })
}

/// Axum middleware: verify the trusted-edge header bundle if configured,
/// strip on failure, attach [`TrustedEdgeContext`] on success.
pub async fn verify_edge_headers(mut req: Request, next: Next) -> Response {
    let configured = keys();

    // Standalone deployment: never trust any edge headers a client
    // might send directly. Strip and continue.
    if configured.is_empty() {
        strip_edge_headers(&mut req);
        return next.run(req).await;
    }

    let headers = extract_edge_headers(&req);
    let mac = match headers.get(EDGE_HEADER_MAC) {
        Some(m) => m.clone(),
        None => {
            // No MAC header — could be a request that bypassed the DMZ.
            // Strip the others (if any) and continue untrusted.
            strip_edge_headers(&mut req);
            tracing::debug!("edge headers absent; treating request as untrusted");
            return next.run(req).await;
        }
    };

    // Verify MAC under any configured key.
    let key_refs: Vec<&[u8]> = configured.iter().map(|k| k.as_slice()).collect();

    // The MAC header itself is NOT part of the canonical input — only
    // the EDGE_HEADERS_CANONICAL bundle is. Build a clean copy without
    // the MAC field for verification.
    let mut signed = headers.clone();
    signed.remove(EDGE_HEADER_MAC);
    // Filter to the canonical names so spurious `x-strata-edge-foo`
    // entries that future versions might add cannot affect the MAC.
    signed.retain(|k, _| EDGE_HEADERS_CANONICAL.contains(&k.as_str()));

    if let Err(e) = edge_header::verify(&signed, &mac, &key_refs) {
        tracing::warn!(error = %e, "edge header MAC verification failed; stripping");
        strip_edge_headers(&mut req);
        return next.run(req).await;
    }

    let now_ms = Utc::now().timestamp_millis();
    if let Err(e) = edge_header::check_timestamp(&signed, now_ms) {
        tracing::warn!(error = %e, "edge header timestamp outside skew; stripping");
        strip_edge_headers(&mut req);
        return next.run(req).await;
    }

    // MAC + timestamp ok — attach context for the audit pipeline.
    if let Some(ctx) = build_context(&signed) {
        tracing::debug!(
            client_ip = %ctx.client_ip,
            link_id = ?ctx.link_id,
            "trusted edge context attached"
        );
        req.extensions_mut().insert(ctx);
    }

    // Strip the raw headers — downstream code MUST go through the
    // `TrustedEdgeContext` extension, not re-read the headers, so a
    // future routing layer cannot accidentally surface unverified data.
    strip_edge_headers(&mut req);
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{HeaderMap, HeaderName, HeaderValue, Request as HttpRequest};

    fn make_req(headers: &[(&str, &str)]) -> Request {
        let mut req = HttpRequest::builder().uri("/").body(Body::empty()).unwrap();
        let h: &mut HeaderMap = req.headers_mut();
        for (k, v) in headers {
            h.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        req
    }

    #[test]
    fn strip_removes_only_strata_edge_headers() {
        let mut req = make_req(&[
            ("x-strata-edge-client-ip", "1.2.3.4"),
            ("x-real-ip", "9.9.9.9"),
            ("user-agent", "ua"),
            ("x-strata-edge-trusted-mac", "deadbeef"),
        ]);
        strip_edge_headers(&mut req);
        let h = req.headers();
        assert!(h.get("x-strata-edge-client-ip").is_none());
        assert!(h.get("x-strata-edge-trusted-mac").is_none());
        assert_eq!(h.get("x-real-ip").unwrap(), "9.9.9.9");
        assert_eq!(h.get("user-agent").unwrap(), "ua");
    }

    #[test]
    fn extract_lowercases_and_filters() {
        let req = make_req(&[
            ("X-Strata-Edge-Client-IP", "1.2.3.4"),
            ("X-Strata-Edge-Link-Id", "dmz-1"),
            ("authorization", "Bearer x"),
        ]);
        let map = extract_edge_headers(&req);
        assert_eq!(map.get("x-strata-edge-client-ip").unwrap(), "1.2.3.4");
        assert_eq!(map.get("x-strata-edge-link-id").unwrap(), "dmz-1");
        assert!(map.get("authorization").is_none());
    }

    #[test]
    fn build_context_requires_client_ip() {
        let mut h = HashMap::new();
        h.insert("x-strata-edge-link-id".into(), "dmz-1".into());
        assert!(build_context(&h).is_none());

        h.insert("x-strata-edge-client-ip".into(), "1.2.3.4".into());
        let ctx = build_context(&h).unwrap();
        assert_eq!(ctx.client_ip, "1.2.3.4");
        assert_eq!(ctx.link_id.as_deref(), Some("dmz-1"));
    }
}
