//! Edge-header HMAC signer — Phase 2d.
//!
//! Implements [`crate::proxy::EdgeSigner`] by populating the
//! `x-strata-edge-*` header bundle that the internal node verifies
//! via [`strata_protocol::edge_header::verify`]. The MAC is computed
//! by [`strata_protocol::edge_header::sign`] over the canonical
//! header order, keyed by [`crate::config::DmzConfig::edge_hmac_key`].
//!
//! ## Field sources
//!
//! | Header                            | Source                                                                                  |
//! |-----------------------------------|-----------------------------------------------------------------------------------------|
//! | `x-strata-edge-client-ip`         | Trusted `X-Forwarded-For` (rightmost untrusted hop) if peer ∈ `trust_forwarded_from`, else socket peer. |
//! | `x-strata-edge-tls-version`       | Set by the public TLS listener (Phase 2e). Empty in 2d.                                |
//! | `x-strata-edge-tls-cipher`        | Set by the public TLS listener (Phase 2e). Empty in 2d.                                |
//! | `x-strata-edge-tls-ja3`           | Optional. Empty in 2d.                                                                  |
//! | `x-strata-edge-user-agent`        | Public request `User-Agent` header verbatim (truncated to 1 KiB).                       |
//! | `x-strata-edge-request-id`        | Existing `x-request-id` if present, ≤ 128 chars and `[A-Za-z0-9_-]` only; else minted v4. |
//! | `x-strata-edge-link-id`           | DMZ `node_id` from config.                                                              |
//! | `x-strata-edge-timestamp-ms`      | `SystemTime::now()` as unix-ms.                                                         |
//!
//! The signer **always strips** any incoming `x-strata-edge-*` headers
//! from the public request before populating its own — a malicious
//! client must not be able to inject pre-signed values.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::{SystemTime, UNIX_EPOCH};

use http::header::{HeaderMap, HeaderName, HeaderValue};
use strata_protocol::edge_header::{sign, EDGE_HEADERS_CANONICAL, EDGE_HEADER_MAC};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::proxy::EdgeSigner;

/// Cap on the user-agent value forwarded to the internal node. Long
/// strings would inflate the MAC input pointlessly.
const MAX_UA_LEN: usize = 1024;

/// Cap on a forwarded request id.
const MAX_REQUEST_ID_LEN: usize = 128;

/// A trusted-proxy entry: either a single IP (host route) or a CIDR
/// network. The `contains` method does prefix-length matching so that
/// upstream load balancers behind a SNAT pool can be expressed as a
/// single `10.0.0.0/24` entry rather than 256 individual addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedNet {
    network: IpAddr,
    /// Prefix length in bits. For a bare IPv4 host route this is 32,
    /// for an IPv6 host route it is 128.
    prefix: u8,
}

impl TrustedNet {
    /// Build from an `IpAddr`/prefix pair. Returns `None` if the
    /// prefix exceeds the address family width.
    pub fn new(network: IpAddr, prefix: u8) -> Option<Self> {
        let max = match network {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        if prefix > max {
            return None;
        }
        Some(Self {
            network: mask_addr(network, prefix),
            prefix,
        })
    }

    /// Parse `1.2.3.0/24`, `2001:db8::/32`, or a bare `1.2.3.4` (treated
    /// as a `/32` or `/128` host route).
    pub fn parse(s: &str) -> Option<Self> {
        match s.split_once('/') {
            None => {
                let ip: IpAddr = s.parse().ok()?;
                let prefix = if ip.is_ipv4() { 32 } else { 128 };
                Self::new(ip, prefix)
            }
            Some((ip_part, prefix_part)) => {
                let ip: IpAddr = ip_part.parse().ok()?;
                let prefix: u8 = prefix_part.parse().ok()?;
                Self::new(ip, prefix)
            }
        }
    }

    /// True if `addr` falls inside this network. Address-family
    /// mismatch always returns false.
    pub fn contains(&self, addr: &IpAddr) -> bool {
        match (self.network, addr) {
            (IpAddr::V4(_), IpAddr::V4(_)) | (IpAddr::V6(_), IpAddr::V6(_)) => {
                mask_addr(*addr, self.prefix) == self.network
            }
            _ => false,
        }
    }
}

/// Apply the high-order `prefix` bits of `addr` and zero the rest.
fn mask_addr(addr: IpAddr, prefix: u8) -> IpAddr {
    match addr {
        IpAddr::V4(v4) => {
            let bits = u32::from(v4);
            let mask = if prefix == 0 {
                0u32
            } else {
                u32::MAX.checked_shl(32 - prefix as u32).unwrap_or(0)
            };
            IpAddr::V4(std::net::Ipv4Addr::from(bits & mask))
        }
        IpAddr::V6(v6) => {
            let bits = u128::from(v6);
            let mask = if prefix == 0 {
                0u128
            } else {
                u128::MAX.checked_shl(128 - prefix as u32).unwrap_or(0)
            };
            IpAddr::V6(std::net::Ipv6Addr::from(bits & mask))
        }
    }
}

/// HMAC signer. Holds the secret in [`Zeroizing`] so a heap dump
/// after process exit can't recover it.
pub struct HmacEdgeSigner {
    key: Zeroizing<Vec<u8>>,
    link_id: String,
    /// Set of upstream load-balancer networks whose `X-Forwarded-For`
    /// header is trusted. Anything outside this set causes XFF to
    /// be ignored and the socket peer to be used instead.
    trusted_proxies: Vec<TrustedNet>,
}

impl HmacEdgeSigner {
    /// Construct from raw key bytes + link id + a trusted-proxy list
    /// of bare `IpAddr`s. Each entry is treated as a host route
    /// (`/32` for IPv4, `/128` for IPv6).
    pub fn new(key: Zeroizing<Vec<u8>>, link_id: String, trusted_proxies: Vec<IpAddr>) -> Self {
        let nets = trusted_proxies
            .into_iter()
            .filter_map(|ip| {
                let prefix = if ip.is_ipv4() { 32 } else { 128 };
                TrustedNet::new(ip, prefix)
            })
            .collect();
        Self::with_networks(key, link_id, nets)
    }

    /// Construct from pre-parsed CIDR networks.
    pub fn with_networks(
        key: Zeroizing<Vec<u8>>,
        link_id: String,
        trusted_proxies: Vec<TrustedNet>,
    ) -> Self {
        Self {
            key,
            link_id,
            trusted_proxies,
        }
    }

    /// Convenience constructor that parses the trusted-proxy list
    /// from `DmzConfig::trust_forwarded_from`. Entries may be either
    /// bare IPs (`10.0.0.1`) or CIDR networks (`10.0.0.0/24`).
    /// Entries that don't parse are dropped with a warning.
    pub fn from_config(
        key: Zeroizing<Vec<u8>>,
        link_id: String,
        trust_forwarded_from: &[String],
    ) -> Self {
        let trusted_proxies = trust_forwarded_from
            .iter()
            .filter_map(|s| match TrustedNet::parse(s) {
                Some(n) => Some(n),
                None => {
                    tracing::warn!(
                        entry = %s,
                        "STRATA_DMZ_TRUST_FORWARDED_FROM entry is not a valid IP or CIDR; ignoring"
                    );
                    None
                }
            })
            .collect();
        Self::with_networks(key, link_id, trusted_proxies)
    }
}

impl EdgeSigner for HmacEdgeSigner {
    fn sign(
        &self,
        headers: &mut HeaderMap,
        peer: Option<SocketAddr>,
        _method: &http::Method,
        _uri: &http::Uri,
    ) {
        // Step 1: strip any pre-existing edge headers a malicious
        // client might have injected. We drop the entire `x-strata-edge-*`
        // namespace, not just the canonical names, so future header
        // additions are also defended retroactively.
        let to_remove: Vec<HeaderName> = headers
            .keys()
            .filter(|n| n.as_str().starts_with("x-strata-edge-"))
            .cloned()
            .collect();
        for n in to_remove {
            headers.remove(&n);
        }

        // Step 2: compute each canonical field.
        let client_ip = resolve_client_ip(headers, peer, &self.trusted_proxies);
        let user_agent = headers
            .get(http::header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(|s| {
                if s.len() > MAX_UA_LEN {
                    s[..MAX_UA_LEN].to_string()
                } else {
                    s.to_string()
                }
            })
            .unwrap_or_default();

        let request_id = headers
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .filter(|s| {
                // Restrict to a strict subset that is safe to drop into
                // structured logs and cannot be confused with a key/value
                // pair. Previously we accepted any printable ASCII
                // (0x21–0x7e), which let a public client smuggle
                // characters like `=`, `,`, ` ` into the trusted
                // audit context (the value is MACed by the edge
                // signer, so the backend trusts it verbatim). The
                // narrow set below covers UUIDs (with or without
                // hyphens), short hex tokens, and trace ids while
                // refusing punctuation operators commonly used as
                // log-field separators.
                !s.is_empty()
                    && s.len() <= MAX_REQUEST_ID_LEN
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
            .to_string();

        // Step 3: build the canonical map (TLS fields empty until 2e).
        let mut canon: HashMap<String, String> =
            HashMap::with_capacity(EDGE_HEADERS_CANONICAL.len());
        canon.insert("x-strata-edge-client-ip".into(), client_ip);
        canon.insert("x-strata-edge-tls-version".into(), String::new());
        canon.insert("x-strata-edge-tls-cipher".into(), String::new());
        canon.insert("x-strata-edge-tls-ja3".into(), String::new());
        canon.insert("x-strata-edge-user-agent".into(), user_agent);
        canon.insert("x-strata-edge-request-id".into(), request_id);
        canon.insert("x-strata-edge-link-id".into(), self.link_id.clone());
        canon.insert("x-strata-edge-timestamp-ms".into(), timestamp_ms);

        // Step 4: emit the canonical fields. Non-empty fields only —
        // the verifier treats absent fields as empty, which is what
        // we MAC. If a value contains bytes that
        // `HeaderValue::from_str` rejects, sanitise it down to ASCII
        // first so the MAC matches what actually goes on the wire.
        for name in EDGE_HEADERS_CANONICAL {
            let v = canon.get(*name).cloned().unwrap_or_default();
            if v.is_empty() {
                continue;
            }
            if HeaderValue::from_str(&v).is_err() {
                let cleaned: String = v
                    .chars()
                    .filter(|c| c.is_ascii() && !c.is_control())
                    .collect();
                canon.insert((*name).to_string(), cleaned);
            }
        }

        let mac = sign(&canon, &self.key);

        for name in EDGE_HEADERS_CANONICAL {
            let v = match canon.get(*name) {
                Some(v) if !v.is_empty() => v,
                _ => continue,
            };
            let header_name = HeaderName::from_static(*name);
            if let Ok(hv) = HeaderValue::from_str(v) {
                headers.insert(header_name, hv);
            }
        }

        headers.insert(
            HeaderName::from_static(EDGE_HEADER_MAC),
            HeaderValue::from_str(&mac).expect("base64 output is ASCII"),
        );
    }
}

fn resolve_client_ip(
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
    trusted_proxies: &[TrustedNet],
) -> String {
    let peer_ip = peer.map(|sa| sa.ip());

    // Only consult XFF if the immediate peer is in the trusted set.
    if let Some(pip) = peer_ip {
        if trusted_proxies.iter().any(|n| n.contains(&pip)) {
            if let Some(xff) = headers
                .get(http::header::FORWARDED)
                .or_else(|| headers.get("x-forwarded-for"))
                .and_then(|v| v.to_str().ok())
            {
                // Take the rightmost untrusted hop. XFF is "left-to-
                // right" client first; we walk from right to left
                // skipping trusted-proxy hops until we hit something
                // untrusted, which is the client we want to log.
                for hop in xff.split(',').rev().map(str::trim) {
                    if hop.is_empty() {
                        continue;
                    }
                    // Strip optional IPv6 zone identifier (e.g. `fe80::1%eth0`)
                    // before parsing; `IpAddr::from_str` rejects them.
                    let hop_no_zone = hop.split('%').next().unwrap_or(hop);
                    match hop_no_zone.parse::<IpAddr>() {
                        Ok(ip) if trusted_proxies.iter().any(|n| n.contains(&ip)) => continue,
                        Ok(ip) => return ip.to_string(),
                        Err(_) => continue,
                    }
                }
            }
        }
    }

    peer_ip
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| String::from("0.0.0.0"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    use strata_protocol::edge_header::{verify, EDGE_HEADERS_CANONICAL};

    fn signer() -> HmacEdgeSigner {
        HmacEdgeSigner::new(
            Zeroizing::new(b"k".repeat(32)),
            "dmz-test".to_string(),
            vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))],
        )
    }

    fn extract_canon(headers: &HeaderMap) -> HashMap<String, String> {
        let mut m = HashMap::new();
        for name in EDGE_HEADERS_CANONICAL {
            let v = headers
                .get(*name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            m.insert((*name).to_string(), v);
        }
        m
    }

    #[test]
    fn sign_emits_mac_that_verifies() {
        let s = signer();
        let mut h = HeaderMap::new();
        h.insert(http::header::USER_AGENT, "curl/8".parse().unwrap());
        s.sign(
            &mut h,
            Some(SocketAddr::from(([198, 51, 100, 7], 5555))),
            &http::Method::GET,
            &"/foo".parse().unwrap(),
        );
        let canon = extract_canon(&h);
        let mac = h
            .get(EDGE_HEADER_MAC)
            .expect("mac present")
            .to_str()
            .unwrap();
        verify(&canon, mac, &[b"k".repeat(32).as_slice()]).expect("verify");
    }

    #[test]
    fn pre_existing_edge_headers_are_stripped() {
        let s = signer();
        let mut h = HeaderMap::new();
        h.insert(
            HeaderName::from_static("x-strata-edge-client-ip"),
            "1.2.3.4".parse().unwrap(),
        );
        h.insert(
            HeaderName::from_static("x-strata-edge-trusted-mac"),
            "fake".parse().unwrap(),
        );
        s.sign(
            &mut h,
            Some(SocketAddr::from(([198, 51, 100, 7], 5555))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        // Client IP must be the socket peer, not the injected value.
        assert_eq!(
            h.get("x-strata-edge-client-ip").unwrap().to_str().unwrap(),
            "198.51.100.7"
        );
        // MAC must verify (i.e. must have been re-computed).
        let canon = extract_canon(&h);
        let mac = h.get(EDGE_HEADER_MAC).unwrap().to_str().unwrap();
        verify(&canon, mac, &[b"k".repeat(32).as_slice()]).expect("verify");
    }

    #[test]
    fn untrusted_peer_xff_is_ignored() {
        let s = signer();
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.99".parse().unwrap());
        // Peer 198.51.100.7 is NOT in trusted_proxies.
        s.sign(
            &mut h,
            Some(SocketAddr::from(([198, 51, 100, 7], 5555))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        assert_eq!(
            h.get("x-strata-edge-client-ip").unwrap().to_str().unwrap(),
            "198.51.100.7"
        );
    }

    #[test]
    fn trusted_peer_xff_extracts_rightmost_untrusted_hop() {
        let s = signer();
        let mut h = HeaderMap::new();
        // Trusted proxy 10.0.0.1 forwarded a chain "client, lb1, 10.0.0.1".
        h.insert(
            "x-forwarded-for",
            "203.0.113.99, 192.0.2.5, 10.0.0.1".parse().unwrap(),
        );
        s.sign(
            &mut h,
            Some(SocketAddr::from(([10, 0, 0, 1], 80))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        // Walking right→left: 10.0.0.1 trusted → skip; 192.0.2.5 untrusted → take it.
        assert_eq!(
            h.get("x-strata-edge-client-ip").unwrap().to_str().unwrap(),
            "192.0.2.5"
        );
    }

    #[test]
    fn malformed_request_id_is_replaced_with_minted_uuid() {
        let s = signer();
        let mut h = HeaderMap::new();
        h.insert("x-request-id", "has spaces and \t".parse().unwrap());
        s.sign(
            &mut h,
            Some(SocketAddr::from(([1, 2, 3, 4], 1))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        let id = h.get("x-strata-edge-request-id").unwrap().to_str().unwrap();
        // UUID v4 is 36 chars with dashes.
        assert_eq!(id.len(), 36);
    }

    #[test]
    fn well_formed_request_id_is_preserved() {
        let s = signer();
        let mut h = HeaderMap::new();
        h.insert("x-request-id", "01J0000ABCDEF".parse().unwrap());
        s.sign(
            &mut h,
            Some(SocketAddr::from(([1, 2, 3, 4], 1))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        assert_eq!(
            h.get("x-strata-edge-request-id").unwrap().to_str().unwrap(),
            "01J0000ABCDEF"
        );
    }

    #[test]
    fn punctuation_request_id_is_replaced_with_minted_uuid() {
        // The previous filter accepted any printable ASCII, which let a
        // public client smuggle log-field separators (=, ,, ;, etc.)
        // into the trusted edge audit context. Each of these MUST now
        // be rejected and replaced with a freshly minted UUID.
        for bad in ["a=b", "foo,bar", "foo;bar", "foo bar", "foo/bar", "foo:bar"] {
            let s = signer();
            let mut h = HeaderMap::new();
            h.insert("x-request-id", bad.parse().unwrap());
            s.sign(
                &mut h,
                Some(SocketAddr::from(([1, 2, 3, 4], 1))),
                &http::Method::GET,
                &"/".parse().unwrap(),
            );
            let id = h.get("x-strata-edge-request-id").unwrap().to_str().unwrap();
            assert_ne!(id, bad, "rejected id {bad:?} should not be echoed");
            assert_eq!(
                id.len(),
                36,
                "rejected id {bad:?} should be replaced with a v4 UUID"
            );
        }
    }

    #[test]
    fn well_formed_uuid_request_id_is_preserved() {
        let s = signer();
        let mut h = HeaderMap::new();
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        h.insert("x-request-id", uuid.parse().unwrap());
        s.sign(
            &mut h,
            Some(SocketAddr::from(([1, 2, 3, 4], 1))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        assert_eq!(
            h.get("x-strata-edge-request-id").unwrap().to_str().unwrap(),
            uuid
        );
    }

    #[test]
    fn user_agent_truncates_at_1k() {
        let s = signer();
        let huge = "A".repeat(2048);
        let mut h = HeaderMap::new();
        h.insert(http::header::USER_AGENT, huge.parse().unwrap());
        s.sign(
            &mut h,
            Some(SocketAddr::from(([1, 2, 3, 4], 1))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        let ua = h.get("x-strata-edge-user-agent").unwrap().to_str().unwrap();
        assert_eq!(ua.len(), MAX_UA_LEN);
    }

    #[test]
    fn link_id_matches_node_id() {
        let s = signer();
        let mut h = HeaderMap::new();
        s.sign(
            &mut h,
            Some(SocketAddr::from(([1, 2, 3, 4], 1))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        assert_eq!(
            h.get("x-strata-edge-link-id").unwrap().to_str().unwrap(),
            "dmz-test"
        );
    }

    #[test]
    fn timestamp_is_recent() {
        let s = signer();
        let mut h = HeaderMap::new();
        s.sign(
            &mut h,
            Some(SocketAddr::from(([1, 2, 3, 4], 1))),
            &http::Method::GET,
            &"/".parse().unwrap(),
        );
        let ts: i64 = h
            .get("x-strata-edge-timestamp-ms")
            .unwrap()
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!((now - ts).abs() < 5_000, "ts={} now={}", ts, now);
    }

    #[test]
    fn from_config_drops_invalid_proxy_entries() {
        let s = HmacEdgeSigner::from_config(
            Zeroizing::new(b"k".repeat(32)),
            "dmz-test".to_string(),
            &["10.0.0.1".to_string(), "not-an-ip".to_string()],
        );
        assert_eq!(s.trusted_proxies.len(), 1);
    }
}
