//! Opaque resume tokens for WebSocket session continuity across short
//! link drops. The token is a sealed reference to an in-memory map on
//! the internal node; the DMZ never inspects it. After a 30-second
//! grace window the internal node tears down the held guacd connection.
//!
//! Phase 0: stub.

use std::time::Duration;

/// Default grace window during which a dropped WebSocket can be resumed.
pub const DEFAULT_RESUME_WINDOW: Duration = Duration::from_secs(30);

/// Length, in bytes, of a raw resume-token before encoding.
pub const RESUME_TOKEN_LEN_BYTES: usize = 32;
