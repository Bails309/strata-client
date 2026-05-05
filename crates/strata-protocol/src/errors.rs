//! Protocol-level errors shared between internal and DMZ.

use thiserror::Error;

/// Errors raised by handshake, edge-header verification, or token decode.
#[derive(Debug, Error)]
pub enum ProtocolError {
    /// Wire-format / serde failure.
    #[error("malformed message: {0}")]
    Malformed(String),

    /// Protocol-version mismatch between peers.
    #[error("incompatible protocol version: peer={peer}, ours={ours}")]
    VersionMismatch {
        /// Version string the remote peer advertised.
        peer: String,
        /// Version string we advertised.
        ours: String,
    },

    /// HMAC verification failed (edge header, AUTH_HELLO challenge, etc.).
    #[error("hmac verification failed")]
    BadMac,

    /// Authentication failed (challenge wrong, PSK unknown, cert untrusted).
    #[error("authentication failed: {0}")]
    AuthFailed(String),

    /// A timestamp was outside the accepted skew window.
    #[error("timestamp outside accepted skew window")]
    Skew,

    /// A nonce was already seen.
    #[error("replayed nonce")]
    Replay,

    /// Resume token was unknown, expired, or tampered with.
    #[error("invalid or expired resume token")]
    InvalidResumeToken,
}
