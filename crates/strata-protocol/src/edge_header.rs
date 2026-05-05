//! Trusted-edge HTTP headers injected by the DMZ and verified by the
//! internal node. The DMZ HMACs the canonicalised header set with
//! `STRATA_DMZ_EDGE_HMAC_KEY`; the internal node strips any
//! `x-strata-edge-*` header bundle that fails verification before the
//! request reaches the router.
//!
//! Phase 0: stub.  Phase 1: actual canonicalisation + verification.

/// Canonical names of the trusted edge headers, in the order they are
/// fed into the HMAC. Order MUST be stable across the codebase.
pub const EDGE_HEADERS_CANONICAL: &[&str] = &[
    "x-strata-edge-client-ip",
    "x-strata-edge-tls-version",
    "x-strata-edge-tls-cipher",
    "x-strata-edge-tls-ja3",
    "x-strata-edge-user-agent",
    "x-strata-edge-request-id",
    "x-strata-edge-link-id",
    "x-strata-edge-timestamp-ms",
];

/// Header name that carries the HMAC tag.
pub const EDGE_HEADER_MAC: &str = "x-strata-edge-trusted-mac";
