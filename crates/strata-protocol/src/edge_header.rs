//! Trusted-edge HTTP headers injected by the DMZ and verified by the
//! internal node.
//!
//! ## Threat
//!
//! A malicious client connecting **directly** to the internal node
//! (bypassing the DMZ entirely, e.g. via a network mis-configuration or
//! a leaked internal hostname) must not be able to forge their own
//! `x-strata-edge-client-ip` and have it land in the audit log. The
//! defence is an HMAC-SHA-256 tag computed by the DMZ over a
//! canonicalised representation of the header set, keyed by a secret
//! shared between DMZ and internal: `STRATA_DMZ_EDGE_HMAC_KEY`.
//!
//! ## Canonicalisation
//!
//! Header names are lower-cased; values are taken verbatim. The MAC
//! input is a length-prefixed concatenation:
//!
//! ```text
//!   for h in CANONICAL_ORDER:
//!       write u32_be(name.len()) || name
//!       write u32_be(value.len()) || value
//! ```
//!
//! Length-prefixing prevents the classic
//! `("a", "bc")` vs `("ab", "c")` ambiguity in naive concatenation.
//!
//! ## Key rotation
//!
//! [`verify`] accepts multiple keys; the verifier returns success if the
//! tag matches under **any** of the supplied keys. During rotation the
//! operator pushes the new key as the first entry on both sides, then
//! removes the old one after the cut-over window.

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hmac::{digest::KeyInit, Hmac, Mac};
use sha2::Sha256;

use crate::errors::ProtocolError;

type HmacSha256 = Hmac<Sha256>;

/// Canonical names of the trusted edge headers, in the order they are
/// fed into the HMAC. Order MUST be stable across releases — changing
/// it is a wire-protocol break.
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

/// Header name that carries the HMAC tag (base64-encoded).
pub const EDGE_HEADER_MAC: &str = "x-strata-edge-trusted-mac";

/// Maximum acceptable clock skew between DMZ and internal node, in ms.
pub const MAX_TIMESTAMP_SKEW_MS: i64 = 60_000;

/// Build the canonical MAC input for the supplied header set.
fn canonical_input(headers: &HashMap<String, String>) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);
    for name in EDGE_HEADERS_CANONICAL {
        let value = headers.get(*name).map(String::as_str).unwrap_or("");
        buf.extend_from_slice(&(name.len() as u32).to_be_bytes());
        buf.extend_from_slice(name.as_bytes());
        buf.extend_from_slice(&(value.len() as u32).to_be_bytes());
        buf.extend_from_slice(value.as_bytes());
    }
    buf
}

/// Sign the canonicalised header set, returning the base64-encoded MAC
/// to put in [`EDGE_HEADER_MAC`].
///
/// Used by the DMZ. The internal node never calls this.
pub fn sign(headers: &HashMap<String, String>, key: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(key)
        .expect("HMAC-SHA-256 accepts any key length");
    mac.update(&canonical_input(headers));
    B64.encode(mac.finalize().into_bytes())
}

/// Verify the supplied MAC against the canonicalised header set under
/// **any** of the provided keys. Returns `Ok(())` on a match.
pub fn verify(
    headers: &HashMap<String, String>,
    mac_b64: &str,
    keys: &[&[u8]],
) -> Result<(), ProtocolError> {
    if keys.is_empty() {
        return Err(ProtocolError::AuthFailed(
            "no edge-hmac keys configured".into(),
        ));
    }
    let tag = B64
        .decode(mac_b64.as_bytes())
        .map_err(|_| ProtocolError::Malformed("edge mac is not valid base64".into()))?;
    let input = canonical_input(headers);

    for key in keys {
        let mut mac = HmacSha256::new_from_slice(key)
            .expect("HMAC-SHA-256 accepts any key length");
        mac.update(&input);
        if mac.verify_slice(&tag).is_ok() {
            return Ok(());
        }
    }
    Err(ProtocolError::BadMac)
}

/// Confirm the `x-strata-edge-timestamp-ms` value is within
/// [`MAX_TIMESTAMP_SKEW_MS`] of `now_ms`. Call **after** [`verify`].
pub fn check_timestamp(
    headers: &HashMap<String, String>,
    now_ms: i64,
) -> Result<(), ProtocolError> {
    let ts: i64 = headers
        .get("x-strata-edge-timestamp-ms")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| {
            ProtocolError::Malformed("x-strata-edge-timestamp-ms missing or not a number".into())
        })?;
    if (now_ms - ts).abs() > MAX_TIMESTAMP_SKEW_MS {
        return Err(ProtocolError::Skew);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_headers() -> HashMap<String, String> {
        let mut h = HashMap::new();
        h.insert("x-strata-edge-client-ip".into(), "203.0.113.42".into());
        h.insert("x-strata-edge-tls-version".into(), "1.3".into());
        h.insert(
            "x-strata-edge-tls-cipher".into(),
            "TLS_AES_128_GCM_SHA256".into(),
        );
        h.insert("x-strata-edge-tls-ja3".into(), "769,47-53-5".into());
        h.insert("x-strata-edge-user-agent".into(), "Mozilla/5.0".into());
        h.insert(
            "x-strata-edge-request-id".into(),
            "01J000000000000000".into(),
        );
        h.insert("x-strata-edge-link-id".into(), "dmz-1".into());
        h.insert("x-strata-edge-timestamp-ms".into(), "1700000000000".into());
        h
    }

    #[test]
    fn sign_then_verify_roundtrips() {
        let key = b"super-secret-edge-hmac-key";
        let h = sample_headers();
        let mac = sign(&h, key);
        assert!(verify(&h, &mac, &[key]).is_ok());
    }

    #[test]
    fn verify_rejects_tampered_value() {
        let key = b"k";
        let h = sample_headers();
        let mac = sign(&h, key);

        let mut tampered = h.clone();
        tampered.insert("x-strata-edge-client-ip".into(), "10.0.0.1".into());

        assert!(matches!(
            verify(&tampered, &mac, &[key]),
            Err(ProtocolError::BadMac)
        ));
    }

    #[test]
    fn verify_rejects_wrong_key() {
        let h = sample_headers();
        let mac = sign(&h, b"alice");
        assert!(matches!(
            verify(&h, &mac, &[b"bob".as_ref()]),
            Err(ProtocolError::BadMac)
        ));
    }

    #[test]
    fn verify_accepts_secondary_key_during_rotation() {
        let h = sample_headers();
        let old: &[u8] = b"old-key";
        let new: &[u8] = b"new-key";

        let mac = sign(&h, old);
        assert!(verify(&h, &mac, &[new, old]).is_ok());
    }

    #[test]
    fn verify_rejects_when_no_keys_configured() {
        let h = sample_headers();
        let mac = sign(&h, b"k");
        assert!(matches!(
            verify(&h, &mac, &[]),
            Err(ProtocolError::AuthFailed(_))
        ));
    }

    #[test]
    fn verify_rejects_non_base64_mac() {
        let h = sample_headers();
        assert!(matches!(
            verify(&h, "!!!not base64!!!", &[b"k".as_ref()]),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn length_prefix_prevents_field_aliasing() {
        let key = b"k";

        let mut h1 = sample_headers();
        h1.insert("x-strata-edge-client-ip".into(), "ab".into());
        h1.insert("x-strata-edge-tls-version".into(), "c".into());

        let mut h2 = sample_headers();
        h2.insert("x-strata-edge-client-ip".into(), "a".into());
        h2.insert("x-strata-edge-tls-version".into(), "bc".into());

        let m1 = sign(&h1, key);
        let m2 = sign(&h2, key);
        assert_ne!(m1, m2, "field aliasing not prevented");
    }

    #[test]
    fn timestamp_within_skew_passes() {
        let now = 1_700_000_000_000_i64;
        let mut h = sample_headers();
        h.insert("x-strata-edge-timestamp-ms".into(), now.to_string());
        assert!(check_timestamp(&h, now + 30_000).is_ok());
    }

    #[test]
    fn timestamp_outside_skew_fails() {
        let now = 1_700_000_000_000_i64;
        let mut h = sample_headers();
        h.insert("x-strata-edge-timestamp-ms".into(), now.to_string());
        assert!(matches!(
            check_timestamp(&h, now + MAX_TIMESTAMP_SKEW_MS + 1),
            Err(ProtocolError::Skew)
        ));
    }

    #[test]
    fn timestamp_missing_is_malformed() {
        let mut h = sample_headers();
        h.remove("x-strata-edge-timestamp-ms");
        assert!(matches!(
            check_timestamp(&h, 0),
            Err(ProtocolError::Malformed(_))
        ));
    }
}
