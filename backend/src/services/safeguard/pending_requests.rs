//! Persistent record of Safeguard access requests that came back
//! `PendingApproval` and are still waiting for approver action.
//!
//! Before v1.12.11 the pending request-id lived only in the SPA's
//! React `useState`. When the pending request originated from the
//! auto-request path (direct-connect JIT in `routes::tunnel`) no
//! state was persisted anywhere the SPA could read back, so the
//! Credentials → Request Checkout tab could not surface the yellow
//! "Awaiting approval" badge, the Refresh button, or the background
//! poll for that request. This module gives every JIT pending outcome
//! a persistent home so the Credentials tab hydrates itself
//! automatically on every mount.
//!
//! Rows are inserted by every path that observes
//! [`crate::services::safeguard::JitOutcome::PendingApproval`]:
//!   - `routes::tunnel::open` (auto-request on direct-connect)
//!   - `routes::user::bulk_safeguard_checkout` (manual bulk-checkout)
//!
//! Rows are deleted on the two termination paths:
//!   - `services::safeguard::release_pending` succeeded (approver
//!     acted; the caller now writes a `safeguard_cached_passwords`
//!     row so the pending marker is redundant).
//!   - `safeguard_checkin` released the profile (user gave up or
//!     the approver denied).
//!
//! The (user_id, profile_id) primary key mirrors
//! `safeguard_cached_passwords`, giving the same per-user-per-profile
//! uniqueness contract and cascade semantics.

use crate::error::AppError;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// Lightweight status row for the bulk-checkout UI. Mirrors
/// [`password_cache::CachedStatus`](super::password_cache::CachedStatus)
/// so both queries can hydrate the same `results` slot on the SPA.
#[derive(serde::Serialize, Debug, Clone)]
pub struct PendingStatus {
    pub profile_id: Uuid,
    pub request_id: String,
    pub account_id: String,
    pub asset: String,
    pub created_at: DateTime<Utc>,
}

/// Row layout returned by [`status_for_user`]'s query.
type PendingRow = (Uuid, String, String, String, DateTime<Utc>);

/// Replace any existing pending row for `(user_id, profile_id)`.
///
/// If the appliance reused a stale request-id (via the `jit_checkout`
/// preflight) the row is idempotently overwritten — the composite
/// primary key ON CONFLICT clause keeps only the latest.
pub async fn store(
    pool: &PgPool,
    user_id: Uuid,
    profile_id: Uuid,
    request_id: &str,
    account_id: &str,
    asset: &str,
) -> Result<(), AppError> {
    if request_id.trim().is_empty() {
        return Err(AppError::Validation(
            "pending request_id must be non-empty".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO safeguard_pending_requests
            (user_id, profile_id, request_id, account_id, asset, created_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id, profile_id) DO UPDATE SET
            request_id = EXCLUDED.request_id,
            account_id = EXCLUDED.account_id,
            asset      = EXCLUDED.asset,
            created_at = now()",
    )
    .bind(user_id)
    .bind(profile_id)
    .bind(request_id)
    .bind(account_id)
    .bind(asset)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove the pending row for `(user_id, profile_id)`. Idempotent —
/// missing rows are silently ignored, so callers can invoke this on
/// every terminal path without a pre-check.
pub async fn clear(pool: &PgPool, user_id: Uuid, profile_id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM safeguard_pending_requests WHERE user_id = $1 AND profile_id = $2")
        .bind(user_id)
        .bind(profile_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Return every pending row for the user, newest-first. Called by the
/// Credentials → Request Checkout tab on mount to reconstruct the
/// `results` state after a page reload or a direct-connect
/// auto-request that the user did not initiate from this tab.
pub async fn status_for_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<PendingStatus>, AppError> {
    let rows: Vec<PendingRow> = sqlx::query_as(
        "SELECT profile_id, request_id, account_id, asset, created_at
           FROM safeguard_pending_requests
          WHERE user_id = $1
          ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(profile_id, request_id, account_id, asset, created_at)| PendingStatus {
                profile_id,
                request_id,
                account_id,
                asset,
                created_at,
            },
        )
        .collect())
}
