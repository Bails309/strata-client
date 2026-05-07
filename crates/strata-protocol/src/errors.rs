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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_messages_are_stable() {
        // These strings appear in operator-facing logs and dashboards;
        // changing them silently would break log-based alerting.
        assert_eq!(
            ProtocolError::Malformed("x".into()).to_string(),
            "malformed message: x"
        );
        assert_eq!(ProtocolError::BadMac.to_string(), "hmac verification failed");
        assert_eq!(
            ProtocolError::AuthFailed("bad psk".into()).to_string(),
            "authentication failed: bad psk"
        );
        assert_eq!(
            ProtocolError::Skew.to_string(),
            "timestamp outside accepted skew window"
        );
        assert_eq!(ProtocolError::Replay.to_string(), "replayed nonce");
        assert_eq!(
            ProtocolError::InvalidResumeToken.to_string(),
            "invalid or expired resume token"
        );
    }

    #[test]
    fn version_mismatch_includes_both_sides() {
        let s = ProtocolError::VersionMismatch {
            peer: "2.0".into(),
            ours: "1.0".into(),
        }
        .to_string();
        assert!(s.contains("peer=2.0"));
        assert!(s.contains("ours=1.0"));
    }
}
