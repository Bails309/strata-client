//! W2-10 — Idempotency-Key support for mutating routes.
//!
//! Clients opt in by sending `Idempotency-Key: <opaque-string>` on a POST.
//! The first time we see `(user_id, route, key)` we run the handler and
//! cache the `(status_code, body)` pair for 24 hours; subsequent requests
//! with the same triple short-circuit to the cached response.
//!
//! This lets a client retry on a network failure (e.g. load-balancer reset
//! mid-activation) without risking a second password reset against AD.

use sqlx::{Pool, Postgres};
use uuid::Uuid;

/// TTL for cached idempotent responses. 24h is plenty for user-driven
/// retries without letting the table grow unbounded.
pub const IDEMPOTENCY_TTL_HOURS: i64 = 24;

/// Maximum accepted header length. Enough for UUIDs, request IDs, and
/// similar opaque tokens without letting a malicious client bloat the table.
pub const MAX_KEY_LEN: usize = 200;

#[derive(Debug)]
pub struct CachedResponse {
    pub status_code: i32,
    pub body: serde_json::Value,
}

/// Extract and validate the `Idempotency-Key` header. Returns `None` if the
/// header is absent; returns `Err` if it is present but malformed.
pub fn extract_key(headers: &axum::http::HeaderMap) -> Result<Option<String>, crate::error::AppError> {
    let Some(v) = headers.get("Idempotency-Key") else {
        return Ok(None);
    };
    let s = v
        .to_str()
        .map_err(|_| crate::error::AppError::Validation("Idempotency-Key must be ASCII".into()))?
        .trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.len() > MAX_KEY_LEN {
        return Err(crate::error::AppError::Validation(format!(
            "Idempotency-Key exceeds {MAX_KEY_LEN} bytes"
        )));
    }
    Ok(Some(s.to_string()))
}

/// Look up a cached response for this triple. Expired rows are ignored.
pub async fn lookup(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    route: &str,
    key: &str,
) -> Result<Option<CachedResponse>, sqlx::Error> {
    let row: Option<(i32, serde_json::Value)> = sqlx::query_as(
        "SELECT status_code, response_body
         FROM idempotency_keys
         WHERE key = $1 AND user_id = $2 AND route = $3 AND expires_at > now()",
    )
    .bind(key)
    .bind(user_id)
    .bind(route)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(status_code, body)| CachedResponse { status_code, body }))
}

/// Cache a successful (or failed) response for future retries. Duplicate
/// inserts (same primary key) are treated as a no-op so concurrent first-time
/// requests don't fight each other.
pub async fn store(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    route: &str,
    key: &str,
    status_code: i32,
    body: &serde_json::Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO idempotency_keys
            (key, user_id, route, status_code, response_body, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::INTERVAL)
         ON CONFLICT (key) DO NOTHING",
    )
    .bind(key)
    .bind(user_id)
    .bind(route)
    .bind(status_code)
    .bind(body)
    .bind(IDEMPOTENCY_TTL_HOURS.to_string())
    .execute(pool)
    .await?;
    Ok(())
}
