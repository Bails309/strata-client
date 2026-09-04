//! # strata-session
//!
//! Native Rust remote-session engine, replacing the Apache Guacamole C
//! daemon (`guacd`).
//!
//! ## Why
//!
//! `guacd` brings three problems this crate exists to remove:
//!
//! 1. **Memory safety.** FreeRDP and `libvncclient` are C, and the
//!    session tier is the platform's largest attack surface. Keeping
//!    them alive costs us a patch queue in `guacd/patches/` and pinned
//!    image digests.
//! 2. **Double encoding.** `guacd` decodes H.264 from RDP EGFX, composites
//!    onto a Cairo surface, diffs it, then re-encodes to PNG/WebP. The
//!    browser then decodes *again*. See [`transport::binary`] for the
//!    pipeline that deletes that round trip.
//! 3. **Lifecycle mismatch.** Strata is Tokio; `guacd` is threads and
//!    `fork()`, reached over a socket that needs plaintext credentials in
//!    its connection parameters.
//!
//! ## Where this runs
//!
//! In the **trusted internal zone**, alongside the backend — never in the
//! DMZ. `strata-dmz` reaches it over a signed internal socket and must
//! not depend on this crate. See
//! `docs/adr/ADR-0015-native-rust-session-engine.md`.
//!
//! ## Shape
//!
//! ```text
//!   client bytes ─► transport::GuacDecoder ─► actor::SessionActor
//!                                                  │
//!                                     engine::ProtocolEngine ─► target
//!                                                  │
//!                        transport::FrameEncoder ──┼──► operator
//!                                                  ├──► observers
//!                                                  └──► actor::AuditSink
//! ```
//!
//! ## Status
//!
//! Phase 2 of the migration. The wire protocol, actor pipeline,
//! dual-mode transport and engine abstraction are complete; the SSH
//! engine ([`engine::ssh`]) is real, and [`routing`] owns the dual-stack
//! decision that keeps everything else on `guacd` until its engine
//! lands. RDP (`ironrdp`) and VNC are still to come.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod actor;
pub mod engine;
pub mod error;
pub mod protocol;
pub mod routing;
pub mod transport;

pub use error::{EngineError, SessionError, WireError};
