//! Link handshake — `AUTH_HELLO` / `AUTH_CHALLENGE` / `AUTH_RESPONSE`.
//!
//! The internal node initiates an outbound mTLS connection, then performs
//! an app-layer challenge-response keyed by a shared PSK. mTLS proves
//! "this is the right host"; the PSK proves "this is the right peering
//! relationship" and gives a rotation knob independent of certificate
//! lifetime.
//!
//! ## Wire flow
//!
//! ```text
//!   internal --> dmz : AuthHello       (cluster_id, node_id, client_nonce, ts)
//!   internal <-- dmz : AuthChallenge   (server_nonce, psk_id)
//!   internal --> dmz : AuthResponse    (HMAC over transcript, keyed by named PSK)
//!   internal <-- dmz : AuthAccept | AuthReject
//! ```
//!
//! ## Transcript binding
//!
//! The HMAC input is a length-prefixed concatenation of every byte the
//! peer has seen so far:
//!
//! ```text
//!   PROTOCOL_VERSION_STR
//!   client_nonce  (raw bytes after base64 decode)
//!   server_nonce  (raw bytes after base64 decode)
//!   cluster_id
//!   node_id
//!   timestamp_ms (big-endian i64)
//!   psk_id
//! ```
//!
//! Each field is preceded by its `u32_be` length. This binds the
//! response to a specific session — replaying it under a different
//! `cluster_id` or different timestamp will not verify.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::errors::ProtocolError;
use crate::versioning::PROTOCOL_VERSION_STR;

type HmacSha256 = Hmac<Sha256>;

/// Length, in bytes, of the random nonces exchanged during handshake.
pub const NONCE_LEN: usize = 32;

/// Maximum acceptable clock skew between peers during handshake.
/// Wider than [`crate::edge_header::MAX_TIMESTAMP_SKEW_MS`] because the
/// handshake happens once per link lifetime, not per-request.
pub const HANDSHAKE_MAX_SKEW_MS: i64 = 30_000;

/// Initial frame sent by the internal node identifying itself to the DMZ.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthHello {
    /// Protocol version this peer speaks (e.g. `"strata-link/1.0"`).
    pub protocol_version: String,
    /// Logical cluster identifier — DMZ load-balances across nodes sharing this id.
    pub cluster_id: String,
    /// Stable identifier for this internal node.
    pub node_id: String,
    /// Strata software version (e.g. `"1.5.0"`) for compat diagnostics.
    pub software_version: String,
    /// 32-byte client nonce, base64-encoded.
    pub client_nonce_b64: String,
    /// Unix epoch milliseconds at the internal node when the hello was emitted.
    pub timestamp_ms: i64,
}

/// DMZ's challenge back to the internal node.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthChallenge {
    /// 32-byte server nonce, base64-encoded.
    pub server_nonce_b64: String,
    /// Identifier of the PSK the DMZ wants the response to be MAC'd with.
    /// During rotation: `"current"` or `"previous"`.
    pub psk_id: String,
}

/// Internal node's response — HMAC over the transcript keyed by the named PSK.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthResponse {
    /// HMAC-SHA-256 over the bound transcript, base64-encoded.
    pub mac_b64: String,
}

/// DMZ's terminal frame indicating handshake outcome.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum AuthOutcome {
    /// Link is now active; the supplied id can be used in audit / logs.
    Accept {
        /// Stable id assigned by the DMZ to this link instance.
        link_id: String,
    },
    /// Link rejected.
    Reject {
        /// Operator-readable reason. MUST NOT leak which check failed
        /// (key vs version vs PSK id) at granularity finer than is
        /// necessary for debugging — DMZ logs the detail server-side.
        reason: String,
    },
}

/// Generate a fresh 32-byte random nonce, base64-encoded.
pub fn fresh_nonce_b64() -> String {
    let mut buf = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut buf);
    B64.encode(buf)
}

/// Length-prefix-encode each field of the transcript and return the bytes.
fn transcript(
    client_nonce: &[u8],
    server_nonce: &[u8],
    cluster_id: &str,
    node_id: &str,
    timestamp_ms: i64,
    psk_id: &str,
) -> Vec<u8> {
    fn push(buf: &mut Vec<u8>, b: &[u8]) {
        buf.extend_from_slice(&(b.len() as u32).to_be_bytes());
        buf.extend_from_slice(b);
    }
    let mut buf = Vec::with_capacity(256);
    push(&mut buf, PROTOCOL_VERSION_STR.as_bytes());
    push(&mut buf, client_nonce);
    push(&mut buf, server_nonce);
    push(&mut buf, cluster_id.as_bytes());
    push(&mut buf, node_id.as_bytes());
    push(&mut buf, &timestamp_ms.to_be_bytes());
    push(&mut buf, psk_id.as_bytes());
    buf
}

/// Compute the HMAC tag the internal node should put in [`AuthResponse::mac_b64`].
///
/// `psk` is the raw PSK bytes for the named `psk_id` (the DMZ told us
/// which one to use in [`AuthChallenge::psk_id`]).
pub fn compute_response(
    hello: &AuthHello,
    challenge: &AuthChallenge,
    psk: &[u8],
) -> Result<AuthResponse, ProtocolError> {
    let client_nonce = B64
        .decode(&hello.client_nonce_b64)
        .map_err(|_| ProtocolError::Malformed("client_nonce_b64".into()))?;
    let server_nonce = B64
        .decode(&challenge.server_nonce_b64)
        .map_err(|_| ProtocolError::Malformed("server_nonce_b64".into()))?;
    if client_nonce.len() != NONCE_LEN || server_nonce.len() != NONCE_LEN {
        return Err(ProtocolError::Malformed("nonce length".into()));
    }

    let input = transcript(
        &client_nonce,
        &server_nonce,
        &hello.cluster_id,
        &hello.node_id,
        hello.timestamp_ms,
        &challenge.psk_id,
    );

    let mut mac = <HmacSha256 as Mac>::new_from_slice(psk)
        .expect("HMAC-SHA-256 accepts any key length");
    mac.update(&input);
    Ok(AuthResponse {
        mac_b64: B64.encode(mac.finalize().into_bytes()),
    })
}

/// Verify a response against the transcript keyed by `psk`.
///
/// Used by the DMZ. Constant-time comparison is performed by the
/// underlying [`Mac::verify_slice`].
pub fn verify_response(
    hello: &AuthHello,
    challenge: &AuthChallenge,
    response: &AuthResponse,
    psk: &[u8],
    now_ms: i64,
) -> Result<(), ProtocolError> {
    if hello.protocol_version != PROTOCOL_VERSION_STR {
        return Err(ProtocolError::VersionMismatch {
            peer: hello.protocol_version.clone(),
            ours: PROTOCOL_VERSION_STR.to_string(),
        });
    }
    if (now_ms - hello.timestamp_ms).abs() > HANDSHAKE_MAX_SKEW_MS {
        return Err(ProtocolError::Skew);
    }

    let client_nonce = B64
        .decode(&hello.client_nonce_b64)
        .map_err(|_| ProtocolError::Malformed("client_nonce_b64".into()))?;
    let server_nonce = B64
        .decode(&challenge.server_nonce_b64)
        .map_err(|_| ProtocolError::Malformed("server_nonce_b64".into()))?;
    if client_nonce.len() != NONCE_LEN || server_nonce.len() != NONCE_LEN {
        return Err(ProtocolError::Malformed("nonce length".into()));
    }
    let tag = B64
        .decode(&response.mac_b64)
        .map_err(|_| ProtocolError::Malformed("mac_b64".into()))?;

    let input = transcript(
        &client_nonce,
        &server_nonce,
        &hello.cluster_id,
        &hello.node_id,
        hello.timestamp_ms,
        &challenge.psk_id,
    );

    let mut mac = <HmacSha256 as Mac>::new_from_slice(psk)
        .expect("HMAC-SHA-256 accepts any key length");
    mac.update(&input);
    mac.verify_slice(&tag)
        .map_err(|_| ProtocolError::AuthFailed("response mac mismatch".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (AuthHello, AuthChallenge) {
        let hello = AuthHello {
            protocol_version: PROTOCOL_VERSION_STR.into(),
            cluster_id: "production".into(),
            node_id: "internal-1".into(),
            software_version: "1.5.0".into(),
            client_nonce_b64: fresh_nonce_b64(),
            timestamp_ms: 1_700_000_000_000,
        };
        let challenge = AuthChallenge {
            server_nonce_b64: fresh_nonce_b64(),
            psk_id: "current".into(),
        };
        (hello, challenge)
    }

    #[test]
    fn handshake_roundtrips() {
        let (hello, challenge) = pair();
        let psk = b"shared-link-psk";
        let resp = compute_response(&hello, &challenge, psk).unwrap();
        assert!(verify_response(&hello, &challenge, &resp, psk, hello.timestamp_ms).is_ok());
    }

    #[test]
    fn rejects_wrong_psk() {
        let (hello, challenge) = pair();
        let resp = compute_response(&hello, &challenge, b"alice").unwrap();
        assert!(matches!(
            verify_response(&hello, &challenge, &resp, b"bob", hello.timestamp_ms),
            Err(ProtocolError::AuthFailed(_))
        ));
    }

    #[test]
    fn rejects_replay_under_different_cluster() {
        let (hello, challenge) = pair();
        let psk = b"k";
        let resp = compute_response(&hello, &challenge, psk).unwrap();

        let mut other = hello.clone();
        other.cluster_id = "staging".into();
        assert!(matches!(
            verify_response(&other, &challenge, &resp, psk, hello.timestamp_ms),
            Err(ProtocolError::AuthFailed(_))
        ));
    }

    #[test]
    fn rejects_version_mismatch() {
        let (mut hello, challenge) = pair();
        hello.protocol_version = "strata-link/99.0".into();
        let psk = b"k";
        let resp = compute_response(&hello, &challenge, psk).unwrap();
        assert!(matches!(
            verify_response(&hello, &challenge, &resp, psk, hello.timestamp_ms),
            Err(ProtocolError::VersionMismatch { .. })
        ));
    }

    #[test]
    fn rejects_clock_skew() {
        let (hello, challenge) = pair();
        let psk = b"k";
        let resp = compute_response(&hello, &challenge, psk).unwrap();
        let too_late = hello.timestamp_ms + HANDSHAKE_MAX_SKEW_MS + 1;
        assert!(matches!(
            verify_response(&hello, &challenge, &resp, psk, too_late),
            Err(ProtocolError::Skew)
        ));
    }

    #[test]
    fn rejects_changed_psk_id() {
        let (hello, mut challenge) = pair();
        let psk = b"k";
        let resp = compute_response(&hello, &challenge, psk).unwrap();

        // DMZ tries to verify under a different psk_id label — must fail
        // because the label is bound into the transcript.
        challenge.psk_id = "previous".into();
        assert!(matches!(
            verify_response(&hello, &challenge, &resp, psk, hello.timestamp_ms),
            Err(ProtocolError::AuthFailed(_))
        ));
    }

    #[test]
    fn fresh_nonce_is_correct_length() {
        let n = fresh_nonce_b64();
        let raw = B64.decode(n).unwrap();
        assert_eq!(raw.len(), NONCE_LEN);
    }
}
