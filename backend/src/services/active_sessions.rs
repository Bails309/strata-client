//! DB-backed `active_sessions` table (per-user token tracking).
//!
//! Distinct from [`crate::services::session_registry`] which tracks
//! *in-memory* Guacamole tunnel sessions.

use crate::error::AppError;
use sqlx::{Pool, Postgres};
use uuid::Uuid;

/// Record a freshly-issued access token so the admin UI can show active
/// sessions and so logout can revoke by jti.
pub async fn record(
    pool: &Pool<Postgres>,
    jti: Uuid,
    user_id: Uuid,
    expires_at: chrono::DateTime<chrono::Utc>,
    ip_address: &str,
    user_agent: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO active_sessions (jti, user_id, expires_at, ip_address, user_agent) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(jti)
    .bind(user_id)
    .bind(expires_at)
    .bind(ip_address)
    .bind(user_agent)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete all active-session rows for a user (e.g. on password change).
pub async fn delete_for_user(pool: &Pool<Postgres>, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM active_sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}
