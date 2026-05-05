//! Per-public-IP body-cap tuning (W6-2).
//!
//! In addition to the global `STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES`, an
//! operator can opt in to a CIDR → bytes table that grants larger (or
//! smaller) inbound-body caps to specific source networks. The
//! motivating use case: a known partner network that legitimately
//! pushes 100 MiB CSV uploads should not be capped at the 8 MiB
//! default that protects the public listener from abuse, while every
//! other source IP keeps the conservative default.
//!
//! ## Configuration
//!
//! Env var: `STRATA_DMZ_PUBLIC_BODY_LIMITS_BY_IP`
//!
//! Format: comma-separated `cidr=bytes` pairs. Whitespace is tolerated.
//! Bytes accept a `K`/`M`/`G` suffix (powers of 1024). A bare host
//! address with no `/prefix` is treated as `/32` (IPv4) or `/128`
//! (IPv6). Examples:
//!
//! ```text
//! STRATA_DMZ_PUBLIC_BODY_LIMITS_BY_IP="10.0.0.0/8=100M, 192.168.1.5=50M, 2001:db8::/32=16M"
//! ```
//!
//! Lookup uses **longest-prefix match**: the cap for a given peer IP
//! is the cap of the most-specific rule whose network contains it,
//! falling back to the global `STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES`
//! when no rule matches.
//!
//! ## Why a hand-rolled CIDR matcher?
//!
//! The DMZ crate's dependency closure is enforced by CI
//! (`.github/workflows/dmz-deps.yml`) to keep the public binary tiny
//! and audit-cheap. Pulling `ipnet` (or similar) for two ~30-line
//! prefix-match functions would violate the spirit of that lock-down,
//! so we implement v4/v6 longest-prefix-match inline using only
//! `std::net`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// One parsed CIDR → cap rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub net: IpAddr,
    pub prefix_len: u8,
    pub cap: usize,
}

/// Parse the env-var-style rule list. Empty / unset input → empty
/// `Vec` (per-IP table disabled, every peer falls through to the
/// global cap).
///
/// Errors describe the offending fragment so an operator can fix the
/// env var without bisection.
pub fn parse(input: &str) -> Result<Vec<Rule>, String> {
    if input.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for fragment in input.split(',') {
        let frag = fragment.trim();
        if frag.is_empty() {
            continue;
        }
        let (cidr, bytes) = frag
            .split_once('=')
            .ok_or_else(|| format!("rule {frag:?} missing '=' separator"))?;
        let cap = parse_bytes(bytes.trim())
            .ok_or_else(|| format!("rule {frag:?}: invalid bytes value {bytes:?}"))?;
        let (addr, prefix) = parse_cidr(cidr.trim())
            .ok_or_else(|| format!("rule {frag:?}: invalid CIDR {cidr:?}"))?;
        out.push(Rule {
            net: mask_to_prefix(addr, prefix),
            prefix_len: prefix,
            cap,
        });
    }
    // Pre-sort by descending prefix length so `lookup` short-circuits
    // on the first match (longest-prefix-first).
    out.sort_by(|a, b| b.prefix_len.cmp(&a.prefix_len));
    Ok(out)
}

/// Find the cap for `ip`, or `None` if no rule matches.
pub fn lookup(rules: &[Rule], ip: IpAddr) -> Option<usize> {
    for r in rules {
        if matches(r, ip) {
            return Some(r.cap);
        }
    }
    None
}

fn matches(rule: &Rule, ip: IpAddr) -> bool {
    match (rule.net, ip) {
        (IpAddr::V4(net), IpAddr::V4(probe)) => {
            let mask = v4_mask(rule.prefix_len);
            (u32::from(net) & mask) == (u32::from(probe) & mask)
        }
        (IpAddr::V6(net), IpAddr::V6(probe)) => {
            let mask = v6_mask(rule.prefix_len);
            (u128::from(net) & mask) == (u128::from(probe) & mask)
        }
        _ => false,
    }
}

fn parse_cidr(s: &str) -> Option<(IpAddr, u8)> {
    let (addr_str, prefix_str) = match s.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (s, None),
    };
    let addr: IpAddr = addr_str.parse().ok()?;
    let max = match addr {
        IpAddr::V4(_) => 32u8,
        IpAddr::V6(_) => 128u8,
    };
    let prefix: u8 = match prefix_str {
        Some(p) => p.parse().ok()?,
        None => max,
    };
    if prefix > max {
        return None;
    }
    Some((addr, prefix))
}

fn parse_bytes(s: &str) -> Option<usize> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (num, mult) = match s.as_bytes().last()? {
        b'K' | b'k' => (&s[..s.len() - 1], 1024usize),
        b'M' | b'm' => (&s[..s.len() - 1], 1024 * 1024),
        b'G' | b'g' => (&s[..s.len() - 1], 1024 * 1024 * 1024),
        _ => (s, 1usize),
    };
    let n: usize = num.trim().parse().ok()?;
    n.checked_mul(mult)
}

fn v4_mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

fn v6_mask(prefix: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    }
}

fn mask_to_prefix(addr: IpAddr, prefix: u8) -> IpAddr {
    match addr {
        IpAddr::V4(v4) => {
            let masked = u32::from(v4) & v4_mask(prefix);
            IpAddr::V4(Ipv4Addr::from(masked))
        }
        IpAddr::V6(v6) => {
            let masked = u128::from(v6) & v6_mask(prefix);
            IpAddr::V6(Ipv6Addr::from(masked))
        }
    }
}

/// Per-public-listener body-cap policy. Cloneable, share-by-Arc — the
/// rule list never changes after startup.
#[derive(Debug, Clone)]
pub struct BodyCapPolicy {
    pub default_cap: usize,
    pub rules: std::sync::Arc<Vec<Rule>>,
}

impl BodyCapPolicy {
    pub fn new(default_cap: usize, rules: Vec<Rule>) -> Self {
        Self {
            default_cap,
            rules: std::sync::Arc::new(rules),
        }
    }

    /// Effective cap for `ip`. `lookup` falls back to `default_cap`
    /// when no rule matches.
    pub fn cap_for(&self, ip: IpAddr) -> usize {
        lookup(&self.rules, ip).unwrap_or(self.default_cap)
    }
}

/// Axum middleware: resolve the per-IP body cap for the request's peer,
/// reject early on `Content-Length`-exceeds-cap, and wrap the streaming
/// body in [`http_body_util::Limited`] so chunked bodies that lie about
/// `Content-Length` (or omit it) still hit the cap.
pub async fn body_cap_middleware(
    axum::extract::State(policy): axum::extract::State<BodyCapPolicy>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    let cap = policy.cap_for(addr.ip());

    // Fast-fail on advertised Content-Length. Public clients almost
    // always announce Content-Length on POST/PUT bodies; chunked
    // requests without C-L still fall through to the global
    // `RequestBodyLimitLayer` set on the public router.
    if let Some(cl) = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
    {
        if cl > cap {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("body cap {cap} bytes exceeded\n"),
            )
                .into_response();
        }
    }

    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn parse_empty_is_empty() {
        assert!(parse("").unwrap().is_empty());
        assert!(parse("   ").unwrap().is_empty());
    }

    #[test]
    fn parse_single_rule() {
        let rules = parse("10.0.0.0/8=100M").unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].prefix_len, 8);
        assert_eq!(rules[0].cap, 100 * 1024 * 1024);
    }

    #[test]
    fn parse_bare_host_treated_as_full_prefix() {
        let rules = parse("192.168.1.5=50M").unwrap();
        assert_eq!(rules[0].prefix_len, 32);
        assert_eq!(rules[0].cap, 50 * 1024 * 1024);
    }

    #[test]
    fn parse_byte_suffixes() {
        assert_eq!(parse_bytes("4096"), Some(4096));
        assert_eq!(parse_bytes("4K"), Some(4096));
        assert_eq!(parse_bytes("4k"), Some(4096));
        assert_eq!(parse_bytes("8M"), Some(8 * 1024 * 1024));
        assert_eq!(parse_bytes("1G"), Some(1024 * 1024 * 1024));
        assert_eq!(parse_bytes("nope"), None);
    }

    #[test]
    fn parse_invalid_cidr_rejected() {
        assert!(parse("10.0.0.0/33=1M").is_err());
        assert!(parse("notanip/8=1M").is_err());
        assert!(parse("10.0.0.0/8").is_err()); // no =
        assert!(parse("10.0.0.0/8=").is_err()); // empty bytes
    }

    #[test]
    fn lookup_longest_prefix_wins() {
        let rules =
            parse("10.0.0.0/8=10M, 10.1.0.0/16=20M, 10.1.2.3/32=30M").unwrap();
        assert_eq!(lookup(&rules, ip("10.1.2.3")), Some(30 * 1024 * 1024));
        assert_eq!(lookup(&rules, ip("10.1.2.4")), Some(20 * 1024 * 1024));
        assert_eq!(lookup(&rules, ip("10.2.0.1")), Some(10 * 1024 * 1024));
        assert_eq!(lookup(&rules, ip("8.8.8.8")), None);
    }

    #[test]
    fn lookup_v6_works() {
        let rules = parse("2001:db8::/32=16M").unwrap();
        assert_eq!(
            lookup(&rules, ip("2001:db8::1")),
            Some(16 * 1024 * 1024)
        );
        assert_eq!(lookup(&rules, ip("2001:db9::1")), None);
    }

    #[test]
    fn v4_and_v6_rules_dont_cross_match() {
        let rules = parse("10.0.0.0/8=10M, 2001:db8::/32=16M").unwrap();
        assert_eq!(lookup(&rules, ip("10.0.0.1")), Some(10 * 1024 * 1024));
        assert_eq!(lookup(&rules, ip("2001:db8::5")), Some(16 * 1024 * 1024));
    }

    #[test]
    fn zero_prefix_matches_anything_of_same_family() {
        let rules = parse("0.0.0.0/0=1M").unwrap();
        assert_eq!(lookup(&rules, ip("1.2.3.4")), Some(1024 * 1024));
        assert_eq!(lookup(&rules, ip("::1")), None);
    }

    #[test]
    fn rules_are_pre_sorted_for_longest_prefix() {
        let rules = parse("10.0.0.0/8=10M, 10.1.0.0/16=20M").unwrap();
        // After parse, /16 must precede /8 so `lookup` finds it first.
        assert!(rules[0].prefix_len > rules[1].prefix_len);
    }
}
