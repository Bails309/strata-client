//! OneIdentity Safeguard JIT credential checkout.
//!
//! Adds support for resolving a Strata credential profile of `kind =
//! 'safeguard'` against a Safeguard appliance at tunnel-open time so
//! the actual password never lives in Strata's DB.
//!
//! Three layers:
//!  - [`config`]: DAO for the singleton `safeguard_config` row.
//!  - [`client`]: thin reqwest wrapper around the 4 REST endpoints we
//!    consume (LoginResponse, AccessRequests CRUD, CheckoutPassword,
//!    Checkin).
//!
//! Everything is opt-in: when [`config::load`] returns `enabled =
//! false` the rest of the system behaves as if Safeguard never existed.

pub mod client;
pub mod config;

#[allow(unused_imports)]
pub use config::SafeguardConfig;

use crate::error::AppError;
use sqlx::PgPool;

/// Convenience: returns `true` iff Safeguard JIT is enabled in the DB.
/// Mirrors the multiplayer kill-switch pattern (`settings::get` lookup
/// at every entry point). Errors are mapped to `false` — a corrupted
/// row should fail closed.
#[allow(dead_code)] // Wired into resolve_credentials in a follow-up commit.
pub async fn kill_switch_enabled(pool: &PgPool) -> bool {
    config::load(pool)
        .await
        .map(|c| c.enabled)
        .unwrap_or(false)
}

/// Returned by the test-connection endpoint. Stable JSON shape; the
/// admin tab depends on these field names.
#[derive(serde::Serialize)]
pub struct TestConnectionOutcome {
    /// True iff every probed step succeeded.
    pub ok: bool,
    /// Short human-readable summary suitable for the admin toast.
    pub message: String,
    /// Per-step results, ordered: TCP, TLS, REST handshake.
    pub steps: Vec<TestStep>,
}

#[derive(serde::Serialize)]
pub struct TestStep {
    pub name: &'static str,
    pub ok: bool,
    pub detail: Option<String>,
}

impl TestConnectionOutcome {
    pub(crate) fn fail(message: impl Into<String>, steps: Vec<TestStep>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            steps,
        }
    }
    pub(crate) fn success(message: impl Into<String>, steps: Vec<TestStep>) -> Self {
        Self {
            ok: true,
            message: message.into(),
            steps,
        }
    }
}

/// Re-export so callers don't need to import the error module too.
#[allow(dead_code)] // Used by the follow-up tunnel-integration commit.
pub type Result<T> = std::result::Result<T, AppError>;
