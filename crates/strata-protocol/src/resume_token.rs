//! Opaque resume tokens for WebSocket session continuity across short
//! link drops.
//!
//! When the link between internal and DMZ blips, the internal node holds
//! the underlying guacd connection open for [`DEFAULT_RESUME_WINDOW`]
//! and hands the user an opaque `resume_token`. On reconnect the user
//! presents the token; the internal node verifies the HMAC tag, looks
//! up the held connection by `token_id`, and re-attaches the WebSocket.
//!
//! The DMZ never inspects the token — it is opaque ciphertext on the wire.
//!
//! ## Token layout
//!
//! ```text
//!   bytes  0..16  token_id        (random; map key on the internal node)
//!   bytes 16..24  expiry_ms       (i64 big-endian, unix ms)
//!   bytes 24..56  hmac-sha-256    (over the preceding 24 bytes)
//! ```
//!
//! Total 56 bytes raw, 76 chars base64 (URL-safe, no padding).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use hmac::{digest::KeyInit, Hmac, Mac};
use rand::Rng;
use sha2::Sha256;
use std::time::Duration;

use crate::errors::ProtocolError;

type HmacSha256 = Hmac<Sha256>;

/// Default grace window during which a dropped WebSocket can be resumed.
pub const DEFAULT_RESUME_WINDOW: Duration = Duration::from_secs(30);

/// Length, in bytes, of the random token id.
pub const TOKEN_ID_LEN: usize = 16;

/// Length, in bytes, of the HMAC tag.
pub const MAC_LEN: usize = 32;

/// Total raw token length in bytes.
pub const TOKEN_RAW_LEN: usize = TOKEN_ID_LEN + 8 + MAC_LEN;

/// A decoded resume token, ready for lookup in the internal node's
/// resume map. Constructible only via [`unseal`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeToken {
    /// Random identifier — used as the map key.
    pub token_id: [u8; TOKEN_ID_LEN],
    /// Unix-ms at which this token expires.
    pub expiry_ms: i64,
}

/// Mint a fresh resume token for the supplied expiry. Returns the
/// [`ResumeToken`] (for the internal node to insert into its map) and
/// the wire-encoded string (for handing to the user).
pub fn seal(expiry_ms: i64, key: &[u8]) -> (ResumeToken, String) {
    let mut token_id = [0u8; TOKEN_ID_LEN];
    rand::rng().fill_bytes(&mut token_id);

    let mut buf = [0u8; TOKEN_RAW_LEN];
    buf[..TOKEN_ID_LEN].copy_from_slice(&token_id);
    buf[TOKEN_ID_LEN..TOKEN_ID_LEN + 8].copy_from_slice(&expiry_ms.to_be_bytes());

    let mut mac = HmacSha256::new_from_slice(key)
        .expect("HMAC-SHA-256 accepts any key length");
    mac.update(&buf[..TOKEN_ID_LEN + 8]);
    let tag = mac.finalize().into_bytes();
    buf[TOKEN_ID_LEN + 8..].copy_from_slice(&tag);

    (
        ResumeToken {
            token_id,
            expiry_ms,
        },
        B64URL.encode(buf),
    )
}

/// Decode and verify a wire-encoded resume token.
///
/// Verifies the HMAC tag and the expiry against `now_ms`. Returns
/// [`ProtocolError::InvalidResumeToken`] on any failure (length, base64,
/// MAC, or expiry) — callers MUST NOT distinguish these reasons to the
/// user, to avoid an oracle.
pub fn unseal(token: &str, key: &[u8], now_ms: i64) -> Result<ResumeToken, ProtocolError> {
    let raw = B64URL
        .decode(token.as_bytes())
        .map_err(|_| ProtocolError::InvalidResumeToken)?;
    if raw.len() != TOKEN_RAW_LEN {
        return Err(ProtocolError::InvalidResumeToken);
    }

    let mut mac = HmacSha256::new_from_slice(key)
        .expect("HMAC-SHA-256 accepts any key length");
    mac.update(&raw[..TOKEN_ID_LEN + 8]);
    mac.verify_slice(&raw[TOKEN_ID_LEN + 8..])
        .map_err(|_| ProtocolError::InvalidResumeToken)?;

    let mut token_id = [0u8; TOKEN_ID_LEN];
    token_id.copy_from_slice(&raw[..TOKEN_ID_LEN]);

    let mut ts_bytes = [0u8; 8];
    ts_bytes.copy_from_slice(&raw[TOKEN_ID_LEN..TOKEN_ID_LEN + 8]);
    let expiry_ms = i64::from_be_bytes(ts_bytes);

    if now_ms > expiry_ms {
        return Err(ProtocolError::InvalidResumeToken);
    }
    Ok(ResumeToken {
        token_id,
        expiry_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_then_unseal_roundtrips() {
        let key = b"resume-token-key";
        let now = 1_700_000_000_000_i64;
        let (minted, wire) = seal(now + 30_000, key);
        let unsealed = unseal(&wire, key, now).unwrap();
        assert_eq!(minted, unsealed);
    }

    #[test]
    fn rejects_wrong_key() {
        let now = 1_700_000_000_000_i64;
        let (_minted, wire) = seal(now + 30_000, b"alice");
        assert!(matches!(
            unseal(&wire, b"bob", now),
            Err(ProtocolError::InvalidResumeToken)
        ));
    }

    #[test]
    fn rejects_expired_token() {
        let key = b"k";
        let now = 1_700_000_000_000_i64;
        let (_minted, wire) = seal(now - 1, key);
        assert!(matches!(
            unseal(&wire, key, now),
            Err(ProtocolError::InvalidResumeToken)
        ));
    }

    #[test]
    fn rejects_truncated_token() {
        let key = b"k";
        let now = 1_700_000_000_000_i64;
        let (_minted, wire) = seal(now + 30_000, key);
        let truncated = &wire[..wire.len() - 4];
        assert!(matches!(
            unseal(truncated, key, now),
            Err(ProtocolError::InvalidResumeToken)
        ));
    }

    #[test]
    fn rejects_garbage_token() {
        let key = b"k";
        assert!(matches!(
            unseal("not a real token", key, 0),
            Err(ProtocolError::InvalidResumeToken)
        ));
    }

    #[test]
    fn fresh_tokens_are_unique() {
        let key = b"k";
        let (a, _) = seal(1_700_000_000_000, key);
        let (b, _) = seal(1_700_000_000_000, key);
        assert_ne!(a.token_id, b.token_id);
    }

    #[test]
    fn flipped_bit_in_token_id_fails_verification() {
        let key = b"k";
        let now = 1_700_000_000_000_i64;
        let (_minted, wire) = seal(now + 30_000, key);
        let mut raw = B64URL.decode(wire.as_bytes()).unwrap();
        raw[0] ^= 0x01;
        let tampered = B64URL.encode(raw);
        assert!(matches!(
            unseal(&tampered, key, now),
            Err(ProtocolError::InvalidResumeToken)
        ));
    }
}
