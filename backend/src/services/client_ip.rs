//! Canonical client-IP resolution (SEC-20).
//!
//! One middleware resolves the originating address for every request and
//! stamps it into [`CLIENT_IP_HEADER`], overwriting anything the client sent.
//! Rate limiting, audit and session attribution read only that header.
//!
//! Precedence:
//! 1. A verified DMZ edge context (`x-strata-edge-client-ip`, HMAC-checked).
//! 2. `X-Forwarded-For`, only when `STRATA_TRUST_XFF=1` **and** the socket
//!    peer is in `STRATA_TRUSTED_PROXIES`. The chain is walked right to left,
//!    skipping trusted hops; the first untrusted address is the client.
//! 3. The socket peer.

use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;

use axum::extract::{ConnectInfo, Request};
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;
use ipnet::IpNet;

use crate::services::edge_header::TrustedEdgeContext;

/// Internal header carrying the resolved client IP. Never trusted from clients.
pub const CLIENT_IP_HEADER: &str = "x-strata-client-ip";

/// Longest `X-Forwarded-For` chain we will walk.
const MAX_XFF_HOPS: usize = 20;

#[derive(Debug, Default)]
struct Config {
    trust_xff: bool,
    trusted: Vec<IpNet>,
}

static CONFIG: OnceLock<Config> = OnceLock::new();

/// Parse a comma-separated list of CIDRs or bare IPs.
pub fn parse_trusted_proxies(raw: &str) -> Result<Vec<IpNet>, String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<IpNet>()
                .or_else(|_| s.parse::<IpAddr>().map(IpNet::from))
                .map_err(|_| format!("invalid STRATA_TRUSTED_PROXIES entry: {s:?}"))
        })
        .collect()
}

/// Load configuration from the environment. Call once at startup; an invalid
/// trusted-proxy list is a fatal configuration error.
pub fn init_from_env() -> Result<(), String> {
    let trust_xff = std::env::var("STRATA_TRUST_XFF").as_deref() == Ok("1");
    let trusted =
        parse_trusted_proxies(&std::env::var("STRATA_TRUSTED_PROXIES").unwrap_or_default())?;
    if trust_xff && trusted.is_empty() {
        tracing::error!(
            "STRATA_TRUST_XFF=1 but STRATA_TRUSTED_PROXIES is empty: \
             X-Forwarded-For will be ignored and the socket peer used instead."
        );
    }
    let _ = CONFIG.set(Config { trust_xff, trusted });
    Ok(())
}

fn is_trusted(ip: IpAddr, trusted: &[IpNet]) -> bool {
    trusted.iter().any(|net| net.contains(&ip))
}

/// Resolve the client address from the socket peer and an optional XFF value.
fn resolve(peer: IpAddr, xff: Option<&str>, trust_xff: bool, trusted: &[IpNet]) -> IpAddr {
    if !trust_xff || !is_trusted(peer, trusted) {
        return peer;
    }
    let Some(xff) = xff else { return peer };
    let mut client = peer;
    for hop in xff.rsplit(',').map(str::trim).take(MAX_XFF_HOPS) {
        if hop.is_empty() {
            continue;
        }
        let Ok(ip) = hop.parse::<IpAddr>() else {
            // A malformed hop ends the part of the chain we can vouch for.
            return client;
        };
        client = ip;
        if !is_trusted(ip, trusted) {
            return ip;
        }
    }
    client
}

/// Axum middleware. Must run after `verify_edge_headers`.
pub async fn resolve_client_ip(mut req: Request, next: Next) -> Response {
    let resolved = if let Some(edge) = req.extensions().get::<TrustedEdgeContext>() {
        Some(edge.client_ip.clone())
    } else {
        req.extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| {
                let cfg = CONFIG.get_or_init(Config::default);
                let xff = req
                    .headers()
                    .get("x-forwarded-for")
                    .and_then(|v| v.to_str().ok());
                resolve(addr.ip(), xff, cfg.trust_xff, &cfg.trusted).to_string()
            })
    };

    let headers = req.headers_mut();
    headers.remove(CLIENT_IP_HEADER);
    if let Some(ip) = resolved.and_then(|ip| HeaderValue::from_str(&ip).ok()) {
        headers.insert(CLIENT_IP_HEADER, ip);
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn nets(s: &str) -> Vec<IpNet> {
        parse_trusted_proxies(s).unwrap()
    }

    #[test]
    fn parses_cidrs_and_bare_ips() {
        let n = nets("10.0.0.0/8, 192.168.1.5 ,::1");
        assert_eq!(n.len(), 3);
        assert!(is_trusted(ip("192.168.1.5"), &n));
        assert!(is_trusted(ip("::1"), &n));
        assert!(!is_trusted(ip("192.168.1.6"), &n));
    }

    #[test]
    fn rejects_invalid_entries() {
        assert!(parse_trusted_proxies("10.0.0.0/8,not-an-ip").is_err());
    }

    #[test]
    fn direct_caller_cannot_forge_xff() {
        let trusted = nets("172.16.0.0/12");
        let got = resolve(ip("203.0.113.9"), Some("1.2.3.4"), true, &trusted);
        assert_eq!(got, ip("203.0.113.9"));
    }

    #[test]
    fn xff_ignored_when_not_enabled() {
        let trusted = nets("172.16.0.0/12");
        let got = resolve(ip("172.18.0.5"), Some("1.2.3.4"), false, &trusted);
        assert_eq!(got, ip("172.18.0.5"));
    }

    #[test]
    fn trusted_proxy_supplies_client() {
        let trusted = nets("172.16.0.0/12");
        let got = resolve(ip("172.18.0.5"), Some("198.51.100.7"), true, &trusted);
        assert_eq!(got, ip("198.51.100.7"));
    }

    #[test]
    fn walks_past_trusted_hops_only() {
        let trusted = nets("172.16.0.0/12,10.0.0.0/8");
        // Client-supplied spoof, then real client, then an internal LB.
        let got = resolve(
            ip("172.18.0.5"),
            Some("6.6.6.6, 198.51.100.7, 10.1.2.3"),
            true,
            &trusted,
        );
        assert_eq!(got, ip("198.51.100.7"));
    }

    #[test]
    fn malformed_hop_stops_the_walk() {
        let trusted = nets("172.16.0.0/12");
        let got = resolve(ip("172.18.0.5"), Some("1.2.3.4, garbage"), true, &trusted);
        assert_eq!(got, ip("172.18.0.5"));
    }

    #[test]
    fn empty_trusted_list_uses_peer() {
        let got = resolve(ip("172.18.0.5"), Some("1.2.3.4"), true, &[]);
        assert_eq!(got, ip("172.18.0.5"));
    }
}
