//! Session registry and edge admission control.
//!
//! Every connection arriving from [`strata-dmz`](strata_protocol) carries
//! a signed canonical header set. The manager verifies that signature
//! before any target connection is attempted, so an unauthenticated peer
//! can never cause a credential to be checked out of Vault.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use strata_protocol::edge_header;
use tokio::sync::mpsc;

use crate::actor::audit::AuditSink;
use crate::actor::session::{
    CredentialGuard, InputModerator, RecordingPolicy, SessionActor, SessionConfig, SessionHandle,
};
use crate::engine::{EngineFactory, TargetSpec};
use crate::error::SessionError;
use crate::transport::{ClientFrame, FrameEncoder};

/// Options for a single session, beyond the target itself.
pub struct SessionOptions {
    /// Session identifier. Must be unique across live sessions.
    pub id: String,
    /// Downstream encoder for the negotiated streaming mode.
    pub encoder: Box<dyn FrameEncoder>,
    /// Recording sink.
    pub audit: Box<dyn AuditSink>,
    /// What that recording must contain.
    pub recording: RecordingPolicy,
    /// Optional dual-control gate.
    pub moderator: Option<Box<dyn InputModerator>>,
    /// Optional credential to revoke on teardown.
    pub credential: Option<Box<dyn CredentialGuard>>,
}

/// Tracks live sessions and admits new ones.
pub struct SessionManager {
    factory: Arc<dyn EngineFactory>,
    edge_keys: Vec<Vec<u8>>,
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl SessionManager {
    /// Create a manager that builds engines with `factory` and accepts
    /// edge headers signed by any of `edge_keys`.
    ///
    /// Multiple keys are supported so an edge HMAC key can be rotated
    /// without a flag day.
    #[must_use]
    pub fn new(factory: Arc<dyn EngineFactory>, edge_keys: Vec<Vec<u8>>) -> Self {
        Self {
            factory,
            edge_keys,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Verify the signed edge header set and its freshness.
    pub fn verify_edge(
        &self,
        headers: &HashMap<String, String>,
        now_ms: i64,
    ) -> Result<(), SessionError> {
        let mac = headers
            .get(edge_header::EDGE_HEADER_MAC)
            .ok_or_else(|| SessionError::EdgeAuth("edge mac header missing".to_owned()))?;
        let keys: Vec<&[u8]> = self.edge_keys.iter().map(Vec::as_slice).collect();
        edge_header::verify(headers, mac, &keys)
            .map_err(|e| SessionError::EdgeAuth(e.to_string()))?;
        edge_header::check_timestamp(headers, now_ms)
            .map_err(|e| SessionError::EdgeAuth(e.to_string()))
    }

    /// Connect to `spec` and start a session actor.
    pub async fn open(
        &self,
        spec: TargetSpec,
        options: SessionOptions,
    ) -> Result<(SessionHandle, mpsc::Receiver<ClientFrame>), SessionError> {
        let engine = self.factory.connect(spec).await?;
        let (handle, frames) = SessionActor::spawn(SessionConfig {
            id: options.id,
            engine,
            encoder: options.encoder,
            audit: options.audit,
            recording: options.recording,
            moderator: options.moderator,
            credential: options.credential,
        });
        self.sessions
            .lock()
            .expect("session registry poisoned")
            .insert(handle.id().to_owned(), handle.clone());
        Ok((handle, frames))
    }

    /// Look up a live session.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<SessionHandle> {
        self.sessions
            .lock()
            .expect("session registry poisoned")
            .get(id)
            .cloned()
    }

    /// Terminate a session and drop it from the registry.
    pub async fn close(&self, id: &str, reason: &str) -> Result<(), SessionError> {
        let handle = self
            .sessions
            .lock()
            .expect("session registry poisoned")
            .remove(id)
            .ok_or_else(|| SessionError::UnknownSession(id.to_owned()))?;
        handle.terminate(reason).await
    }

    /// Number of registered sessions.
    #[must_use]
    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .expect("session registry poisoned")
            .len()
    }

    /// Whether any session is registered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actor::audit::NullAuditSink;
    use crate::engine::mock::MockEngineFactory;
    use crate::engine::Protocol;
    use crate::transport::GuacWireEncoder;
    use secrecy::SecretString;

    const KEY: &[u8] = b"edge-hmac-key-for-tests";

    fn manager() -> SessionManager {
        SessionManager::new(Arc::new(MockEngineFactory), vec![KEY.to_vec()])
    }

    fn signed_headers(now_ms: i64) -> HashMap<String, String> {
        let mut headers = HashMap::new();
        headers.insert("x-strata-edge-client-ip".into(), "203.0.113.7".into());
        headers.insert("x-strata-edge-timestamp-ms".into(), now_ms.to_string());
        let mac = edge_header::sign(&headers, KEY);
        headers.insert(edge_header::EDGE_HEADER_MAC.into(), mac);
        headers
    }

    fn spec() -> TargetSpec {
        TargetSpec {
            connect_addr: None,
            protocol: Protocol::Rdp,
            hostname: "host.internal".to_owned(),
            port: 3389,
            username: "svc-admin".to_owned(),
            secret: SecretString::from("ephemeral"),
            width: 1920,
            height: 1080,
        }
    }

    fn options(id: &str) -> SessionOptions {
        SessionOptions {
            id: id.to_owned(),
            encoder: Box::new(GuacWireEncoder::new()),
            audit: Box::new(NullAuditSink),
            recording: RecordingPolicy::default(),
            moderator: None,
            credential: None,
        }
    }

    #[test]
    fn accepts_a_correctly_signed_edge_header_set() {
        let now = 1_726_000_000_000;
        assert!(manager().verify_edge(&signed_headers(now), now).is_ok());
    }

    #[test]
    fn rejects_a_tampered_edge_header_set() {
        let now = 1_726_000_000_000;
        let mut headers = signed_headers(now);
        headers.insert("x-strata-edge-client-ip".into(), "198.51.100.1".into());
        assert!(matches!(
            manager().verify_edge(&headers, now),
            Err(SessionError::EdgeAuth(_))
        ));
    }

    #[test]
    fn rejects_a_replayed_edge_header_set() {
        let signed_at = 1_726_000_000_000;
        let headers = signed_headers(signed_at);
        let much_later = signed_at + 10 * 60 * 1000;
        assert!(matches!(
            manager().verify_edge(&headers, much_later),
            Err(SessionError::EdgeAuth(_))
        ));
    }

    #[test]
    fn rejects_an_unsigned_edge_header_set() {
        let mut headers = signed_headers(0);
        headers.remove(edge_header::EDGE_HEADER_MAC);
        assert!(matches!(
            manager().verify_edge(&headers, 0),
            Err(SessionError::EdgeAuth(_))
        ));
    }

    #[tokio::test]
    async fn opens_and_closes_sessions() {
        let manager = manager();
        assert!(manager.is_empty());

        let (handle, _frames) = manager.open(spec(), options("s-1")).await.unwrap();
        assert_eq!(manager.len(), 1);
        assert!(manager.get("s-1").is_some());
        assert_eq!(handle.id(), "s-1");

        manager.close("s-1", "operator ended").await.unwrap();
        assert!(manager.is_empty());
    }

    #[tokio::test]
    async fn closing_an_unknown_session_is_an_error() {
        assert!(matches!(
            manager().close("nope", "n/a").await,
            Err(SessionError::UnknownSession(_))
        ));
    }

    #[test]
    fn target_spec_never_debug_prints_the_secret() {
        let rendered = format!("{:?}", spec());
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains("ephemeral"));
    }
}
