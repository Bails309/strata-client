//! Error types for the session engine.
//!
//! Every failure mode is typed so the session actor can decide between
//! "tell the client and carry on" and "tear the session down, rotate the
//! credential, finalise the audit log".

use thiserror::Error;

/// A failure decoding or interpreting the Guacamole wire protocol.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum WireError {
    /// The byte stream is not a valid instruction and never will be.
    #[error("malformed guacamole instruction")]
    Malformed,

    /// The peer sent more unparsed bytes than the decoder will buffer.
    #[error("instruction exceeds the {limit}-byte decode buffer")]
    BufferOverflow {
        /// Configured buffer ceiling, in bytes.
        limit: usize,
    },

    /// A required argument was absent.
    #[error("`{opcode}` is missing argument {index}")]
    MissingArgument {
        /// Instruction that was short.
        opcode: String,
        /// Zero-based argument position.
        index: usize,
    },

    /// An argument was present but could not be interpreted.
    #[error("`{opcode}` argument {index} is not valid")]
    BadArgument {
        /// Instruction carrying the bad argument.
        opcode: String,
        /// Zero-based argument position.
        index: usize,
    },
}

/// A failure inside a protocol engine (RDP, SSH, VNC).
#[derive(Debug, Error)]
pub enum EngineError {
    /// The target refused the credentials we presented.
    #[error("authentication rejected by target")]
    AuthRejected,

    /// The transport to the target failed.
    #[error("target transport failed: {0}")]
    Transport(#[from] std::io::Error),

    /// The target spoke the protocol incorrectly.
    #[error("target protocol violation: {0}")]
    Protocol(String),

    /// The requested protocol has no engine compiled in.
    #[error("no engine available for protocol `{0}`")]
    Unsupported(&'static str),

    /// The target closed the connection.
    #[error("target closed the connection: {0}")]
    Closed(String),
}

/// Anything that can end a session.
#[derive(Debug, Error)]
pub enum SessionError {
    /// The client's wire traffic was unusable.
    #[error(transparent)]
    Wire(#[from] WireError),

    /// The protocol engine failed.
    #[error(transparent)]
    Engine(#[from] EngineError),

    /// The edge did not present a valid signed header.
    #[error("edge authentication failed: {0}")]
    EdgeAuth(String),

    /// The session id is unknown or already torn down.
    #[error("no such session: {0}")]
    UnknownSession(String),

    /// An internal channel closed because its peer task exited.
    #[error("session pipeline closed: {0}")]
    PipelineClosed(&'static str),

    /// The audit sink could not durably record the session.
    #[error("audit sink failed: {0}")]
    Audit(String),
}
