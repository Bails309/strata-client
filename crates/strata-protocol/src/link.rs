//! Link handshake drivers (transport-agnostic).
//!
//! Both sides operate over a duplex byte stream that implements
//! [`AsyncRead`] + [`AsyncWrite`]. In production the stream is an mTLS
//! connection (Phase 1c); in tests it is [`tokio::io::duplex`].
//!
//! ## Wire flow (handshake only)
//!
//! ```text
//!   internal --> dmz : AuthHello
//!   internal <-- dmz : AuthChallenge
//!   internal --> dmz : AuthResponse
//!   internal <-- dmz : AuthOutcome::{Accept | Reject}
//! ```
//!
//! After [`AuthOutcome::Accept`] the link is "up" and the byte stream
//! is handed back to the caller for HTTP/2 framing.

use chrono::Utc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::timeout;

use crate::errors::ProtocolError;
use crate::frame::{read_frame, write_frame};
use crate::handshake::{
    compute_response, fresh_nonce_b64, verify_response, AuthChallenge, AuthHello, AuthOutcome,
    AuthResponse,
};
use crate::versioning::PROTOCOL_VERSION_STR;

/// Wall-clock time budget for completing the entire handshake. If the
/// peer is silent this caps how long we sit on a half-open socket.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Inputs the internal node provides to drive its side of the handshake.
#[derive(Debug, Clone)]
pub struct ClientHandshakeConfig {
    /// Logical cluster id (e.g. `"production"`).
    pub cluster_id: String,
    /// Stable id of this internal node (e.g. `"internal-1"`).
    pub node_id: String,
    /// Strata software version, advertised in `AuthHello`.
    pub software_version: String,
    /// Map of `psk_id` → raw PSK bytes. Multiple entries support PSK
    /// rotation (current + previous) — the DMZ chooses which one we
    /// must MAC under via [`AuthChallenge::psk_id`].
    pub psks: std::collections::HashMap<String, Vec<u8>>,
}

/// Outcome of a successful client-side handshake.
#[derive(Debug, Clone)]
pub struct LinkAccepted {
    /// Stable identifier the DMZ assigned to this link instance.
    pub link_id: String,
}

/// Drive the internal node's side of the handshake to completion.
///
/// On success returns the [`LinkAccepted`] description; the underlying
/// stream is left open at the boundary where HTTP/2 framing begins.
pub async fn client_handshake<S>(
    stream: &mut S,
    cfg: &ClientHandshakeConfig,
) -> Result<LinkAccepted, ProtocolError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let fut = async {
        let hello = AuthHello {
            protocol_version: PROTOCOL_VERSION_STR.to_string(),
            cluster_id: cfg.cluster_id.clone(),
            node_id: cfg.node_id.clone(),
            software_version: cfg.software_version.clone(),
            client_nonce_b64: fresh_nonce_b64(),
            timestamp_ms: Utc::now().timestamp_millis(),
        };
        write_frame(stream, &hello).await?;

        let challenge: AuthChallenge = read_frame(stream).await?;
        let psk = cfg
            .psks
            .get(&challenge.psk_id)
            .ok_or_else(|| {
                ProtocolError::AuthFailed(format!(
                    "DMZ requested psk_id={:?}, not configured",
                    challenge.psk_id
                ))
            })?;

        let response = compute_response(&hello, &challenge, psk)?;
        write_frame(stream, &response).await?;

        let outcome: AuthOutcome = read_frame(stream).await?;
        match outcome {
            AuthOutcome::Accept { link_id } => Ok(LinkAccepted { link_id }),
            AuthOutcome::Reject { reason } => Err(ProtocolError::AuthFailed(reason)),
        }
    };

    match timeout(HANDSHAKE_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(ProtocolError::AuthFailed("handshake timed out".into())),
    }
}

/// Inputs the DMZ provides to drive its side of the handshake.
#[derive(Debug, Clone)]
pub struct ServerHandshakeConfig {
    /// Identifier the DMZ should put in the challenge.
    /// During PSK rotation set to `"current"` to make every internal
    /// node migrate to the new key.
    pub psk_id: String,
    /// Map of `psk_id` → raw PSK bytes. The server tells the client
    /// which one to use (`psk_id` above), then verifies under that key.
    pub psks: std::collections::HashMap<String, Vec<u8>>,
    /// Stable identifier this DMZ instance assigns to the link.
    pub link_id: String,
}

/// Outcome of a successful server-side handshake.
#[derive(Debug, Clone)]
pub struct LinkPeer {
    /// Cluster id the internal node advertised.
    pub cluster_id: String,
    /// Node id the internal node advertised.
    pub node_id: String,
    /// Software version the internal node advertised.
    pub software_version: String,
}

/// Drive the DMZ's side of the handshake to completion.
pub async fn server_handshake<S>(
    stream: &mut S,
    cfg: &ServerHandshakeConfig,
) -> Result<LinkPeer, ProtocolError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let fut = async {
        let hello: AuthHello = read_frame(stream).await?;

        // Pick the PSK we want the client to MAC under.
        let psk = cfg
            .psks
            .get(&cfg.psk_id)
            .ok_or_else(|| {
                ProtocolError::AuthFailed(format!(
                    "configured psk_id={:?} missing from psk map",
                    cfg.psk_id
                ))
            })?
            .clone();

        let challenge = AuthChallenge {
            server_nonce_b64: fresh_nonce_b64(),
            psk_id: cfg.psk_id.clone(),
        };
        write_frame(stream, &challenge).await?;

        let response: AuthResponse = read_frame(stream).await?;
        let now_ms = Utc::now().timestamp_millis();
        let verify_result = verify_response(&hello, &challenge, &response, &psk, now_ms);

        match verify_result {
            Ok(()) => {
                write_frame(
                    stream,
                    &AuthOutcome::Accept {
                        link_id: cfg.link_id.clone(),
                    },
                )
                .await?;
                Ok(LinkPeer {
                    cluster_id: hello.cluster_id,
                    node_id: hello.node_id,
                    software_version: hello.software_version,
                })
            }
            Err(e) => {
                // Send a generic reject — the DMZ logs the detailed
                // reason server-side. Fire-and-forget on the write
                // since the peer is about to disconnect anyway.
                let _ = write_frame(
                    stream,
                    &AuthOutcome::Reject {
                        reason: "authentication failed".into(),
                    },
                )
                .await;
                Err(e)
            }
        }
    };

    match timeout(HANDSHAKE_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => Err(ProtocolError::AuthFailed("handshake timed out".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn psk_map(id: &str, key: &[u8]) -> HashMap<String, Vec<u8>> {
        let mut m = HashMap::new();
        m.insert(id.to_string(), key.to_vec());
        m
    }

    fn client_cfg() -> ClientHandshakeConfig {
        ClientHandshakeConfig {
            cluster_id: "production".into(),
            node_id: "internal-1".into(),
            software_version: "1.5.0".into(),
            psks: psk_map("current", b"shared-link-psk"),
        }
    }

    fn server_cfg() -> ServerHandshakeConfig {
        ServerHandshakeConfig {
            psk_id: "current".into(),
            psks: psk_map("current", b"shared-link-psk"),
            link_id: "dmz-1#42".into(),
        }
    }

    #[tokio::test]
    async fn handshake_succeeds() {
        let (mut a, mut b) = tokio::io::duplex(8192);
        let cc = client_cfg();
        let sc = server_cfg();

        let client = tokio::spawn(async move { client_handshake(&mut a, &cc).await });
        let server = tokio::spawn(async move { server_handshake(&mut b, &sc).await });

        let (cr, sr) = tokio::join!(client, server);
        let cr = cr.unwrap().unwrap();
        let sr = sr.unwrap().unwrap();
        assert_eq!(cr.link_id, "dmz-1#42");
        assert_eq!(sr.cluster_id, "production");
        assert_eq!(sr.node_id, "internal-1");
    }

    #[tokio::test]
    async fn rejects_wrong_psk_on_client() {
        let (mut a, mut b) = tokio::io::duplex(8192);
        let cc = ClientHandshakeConfig {
            psks: psk_map("current", b"WRONG"),
            ..client_cfg()
        };
        let sc = server_cfg();

        let client = tokio::spawn(async move { client_handshake(&mut a, &cc).await });
        let server = tokio::spawn(async move { server_handshake(&mut b, &sc).await });

        let (cr, sr) = tokio::join!(client, server);
        assert!(matches!(
            cr.unwrap(),
            Err(ProtocolError::AuthFailed(_))
        ));
        assert!(matches!(
            sr.unwrap(),
            Err(ProtocolError::AuthFailed(_))
        ));
    }

    #[tokio::test]
    async fn client_rejects_unknown_psk_id() {
        let (mut a, mut b) = tokio::io::duplex(8192);
        // Server demands "current" but the client only knows "ancient".
        let cc = ClientHandshakeConfig {
            psks: psk_map("ancient", b"shared-link-psk"),
            ..client_cfg()
        };
        let sc = server_cfg();

        let client = tokio::spawn(async move { client_handshake(&mut a, &cc).await });
        let server = tokio::spawn(async move { server_handshake(&mut b, &sc).await });

        let (cr, _sr) = tokio::join!(client, server);
        assert!(matches!(
            cr.unwrap(),
            Err(ProtocolError::AuthFailed(_))
        ));
    }
}
