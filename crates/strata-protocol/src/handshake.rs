//! Link handshake (`AUTH_HELLO` / `AUTH_CHALLENGE` / `AUTH_RESPONSE`).
//!
//! The internal node initiates an outbound mTLS connection, then performs
//! an app-layer challenge-response keyed by a shared PSK. mTLS proves
//! "this is the right host"; the PSK proves "this is the right peering
//! relationship" and gives a rotation knob independent of certificate
//! lifetime.
//!
//! Module is intentionally a stub at Phase 0. Phase 1 fills in the
//! actual `serde` types and `hmac` verification.

use serde::{Deserialize, Serialize};

/// Initial frame sent by the internal node identifying itself to the DMZ.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthHello {
    /// Protocol version the internal node is advertising (e.g. `"strata-link/1.0"`).
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthChallenge {
    /// 32-byte server nonce, base64-encoded.
    pub server_nonce_b64: String,
    /// Identifier of the PSK the DMZ wants the response to be MAC'd with
    /// (`"current"` or `"previous"` during rotation).
    pub psk_id: String,
}

/// Internal node's response — HMAC of `(client_nonce || server_nonce || cluster_id || node_id)`
/// keyed by the named PSK.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    /// HMAC-SHA-256 over the bound transcript, base64-encoded.
    pub mac_b64: String,
}
