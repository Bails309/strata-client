//! Actor pipeline: session registry, per-session task, audit tap.

pub mod audit;
pub mod manager;
pub mod session;

pub use audit::{AuditRecord, AuditSink, FileAuditSink, GuacRecordingSink, NullAuditSink};
pub use manager::{SessionManager, SessionOptions};
pub use session::{
    clipboard_bytes_in_use, CredentialGuard, InputModerator, Moderation, RecordingPolicy,
    SessionActor, SessionCommand, SessionConfig, SessionFrame, SessionHandle,
};
