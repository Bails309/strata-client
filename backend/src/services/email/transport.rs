//! `EmailTransport` trait plus a test stub.
//!
//! The real SMTP implementation lives in [`super::smtp`] and is added in
//! P3; keeping the trait in its own module lets tests wire a stub
//! transport without pulling `lettre` into the test binary.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use super::message::EmailMessage;

/// Errors that a transport can surface to the dispatcher.
///
/// The dispatcher distinguishes [`SendError::Transient`] (retry) from
/// [`SendError::Permanent`] (give up, write `failed` row) so the
/// background retry worker does not churn on addresses that no amount of
/// re-sending will rescue (e.g. `550 User Unknown`).
#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("transient transport error: {0}")]
    Transient(String),

    #[error("permanent transport error: {0}")]
    Permanent(String),

    #[error("transport disabled: {0}")]
    Disabled(String),
}

impl SendError {
    pub fn is_retryable(&self) -> bool {
        matches!(self, SendError::Transient(_))
    }
}

/// Neutral send abstraction.  Transports must be cheap to `clone` (they
/// live behind an `Arc` in `AppState`) and safe to call concurrently.
#[async_trait]
pub trait EmailTransport: Send + Sync {
    async fn send(&self, message: &EmailMessage) -> Result<(), SendError>;

    /// Human-readable name used in audit log context (e.g. `"smtp:mail.corp.local:587"`).
    #[allow(dead_code)] // Consumed by the P8 admin UI delivery-view row formatter.
    fn describe(&self) -> String;
}

#[allow(dead_code)] // Alias used by P8/P9 dependency-injection wiring.
pub type BoxedTransport = Arc<dyn EmailTransport>;

// ── Stub transport (tests) ───────────────────────────────────

/// In-memory transport that records every message it was asked to send.
///
/// Used by unit tests and by the `/api/admin/notifications/test-send`
/// preview endpoint's dry-run mode.
#[allow(dead_code)] // Reserved for the P8 test-send dry-run + integration tests.
/// Used by unit tests and by the `/api/admin/notifications/test-send`
/// preview endpoint's dry-run mode.
#[allow(dead_code)] // Reserved for the P8 test-send dry-run + integration tests.
#[derive(Default, Clone)]
pub struct StubTransport {
    sent: Arc<Mutex<Vec<EmailMessage>>>,
    /// When set, every call to [`send`](Self::send) returns this error.
    fail_with: Arc<Mutex<Option<SendError>>>,
}

#[allow(dead_code)] // Test/preview helpers; wired in by P8 test-send dry-run.
impl StubTransport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Program the stub to fail the next N sends with the given error.
    pub async fn fail_next(&self, err: SendError) {
        *self.fail_with.lock().await = Some(err);
    }

    pub async fn sent_messages(&self) -> Vec<EmailMessage> {
        self.sent.lock().await.clone()
    }
}

#[async_trait]
impl EmailTransport for StubTransport {
    async fn send(&self, message: &EmailMessage) -> Result<(), SendError> {
        if let Some(err) = self.fail_with.lock().await.take() {
            return Err(err);
        }
        self.sent.lock().await.push(message.clone());
        Ok(())
    }

    fn describe(&self) -> String {
        "stub".into()
    }
}

#[cfg(test)]
mod tests {
    use super::super::message::EmailAddress;
    use super::*;

    fn mkmsg() -> EmailMessage {
        EmailMessage::builder(
            EmailAddress::new("a@example.com"),
            EmailAddress::new("b@example.com"),
            "subj",
        )
        .build()
    }

    #[tokio::test]
    async fn stub_records_sent_messages() {
        let t = StubTransport::new();
        t.send(&mkmsg()).await.unwrap();
        t.send(&mkmsg()).await.unwrap();
        assert_eq!(t.sent_messages().await.len(), 2);
    }

    #[tokio::test]
    async fn stub_fail_next_returns_programmed_error_once() {
        let t = StubTransport::new();
        t.fail_next(SendError::Transient("network".into())).await;
        let err = t.send(&mkmsg()).await.unwrap_err();
        assert!(matches!(err, SendError::Transient(_)));
        assert!(err.is_retryable());

        // Second call succeeds — fail_next is one-shot.
        t.send(&mkmsg()).await.unwrap();
    }

    #[tokio::test]
    async fn permanent_error_is_not_retryable() {
        let err = SendError::Permanent("550 mailbox unavailable".into());
        assert!(!err.is_retryable());
    }

    #[tokio::test]
    async fn disabled_error_is_not_retryable() {
        let err = SendError::Disabled("smtp_enabled=false".into());
        assert!(!err.is_retryable());
    }
}
