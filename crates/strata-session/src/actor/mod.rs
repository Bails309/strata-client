//! Actor pipeline: session registry, per-session task, audit tap.

pub mod audit;
pub mod manager;
pub mod session;

pub use audit::{AuditRecord, AuditSink, FileAuditSink, NullAuditSink};
pub use manager::{SessionManager, SessionOptions};
pub use session::{
    CredentialGuard, InputModerator, Moderation, SessionActor, SessionCommand, SessionConfig,
    SessionFrame, SessionHandle,
};
