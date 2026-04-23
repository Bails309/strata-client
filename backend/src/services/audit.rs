use crate::error::AppError;
use sha2::{Digest, Sha256};
use sqlx::{Pool, Postgres};
use uuid::Uuid;

/// Paginated audit-log row as returned to admin clients. Joins the author's
/// username and any connection referenced via `details->>'connection_id'`.
#[derive(serde::Serialize, sqlx::FromRow)]
pub struct AuditLogRow {
    pub id: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub user_id: Option<Uuid>,
    pub username: Option<String>,
    pub action_type: String,
    pub details: serde_json::Value,
    pub current_hash: String,
    pub connection_name: Option<String>,
}

/// Fetch audit rows in reverse-chronological order (newest first), joined
/// with `users` and `connections` for display.
pub async fn list_paginated(
    pool: &Pool<Postgres>,
    limit: i64,
    offset: i64,
) -> Result<Vec<AuditLogRow>, AppError> {
    let rows = sqlx::query_as(
        "SELECT a.id, a.created_at, a.user_id, u.username, a.action_type, a.details, a.current_hash,
                c.name AS connection_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN connections c ON c.id = (a.details->>'connection_id')::uuid
         ORDER BY a.id DESC LIMIT $1 OFFSET $2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Compute the chain hash: SHA-256(previous_hash || action_type || details).
pub fn compute_chain_hash(previous_hash: &str, action_type: &str, details: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(previous_hash.as_bytes());
    hasher.update(action_type.as_bytes());
    hasher.update(details.as_bytes());
    hex::encode(hasher.finalize())
}

/// Append an immutable, hash-chained audit log entry.
///
/// Uses a PostgreSQL advisory lock to serialise inserts, preventing
/// concurrent requests from reading the same previous_hash and forking
/// the chain.  This handles the empty-table case correctly (FOR UPDATE
/// on zero rows is a no-op and provides no serialisation).
pub async fn log(
    pool: &Pool<Postgres>,
    user_id: Option<Uuid>,
    action_type: &str,
    details: &serde_json::Value,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    // Advisory lock serialises all audit inserts (key chosen to avoid collisions)
    const AUDIT_LOCK_KEY: i64 = 0x5354_4155_4449_5400; // "STRAUDIT"
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(AUDIT_LOCK_KEY)
        .execute(&mut *tx)
        .await?;

    let previous_hash: String =
        sqlx::query_scalar("SELECT current_hash FROM audit_logs ORDER BY id DESC LIMIT 1")
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or_default();

    let current_hash = compute_chain_hash(&previous_hash, action_type, &details.to_string());

    sqlx::query(
        "INSERT INTO audit_logs (user_id, action_type, details, previous_hash, current_hash)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(user_id)
    .bind(action_type)
    .bind(details)
    .bind(&previous_hash)
    .bind(&current_hash)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_chain_deterministic() {
        let details = serde_json::json!({"username": "admin"});
        let hash1 = compute_chain_hash("", "auth.login", &details.to_string());
        let hash2 = compute_chain_hash("", "auth.login", &details.to_string());
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 64); // SHA-256 = 64 hex chars
    }

    #[test]
    fn hash_chain_differs_on_action() {
        let details = serde_json::json!({});
        let h1 = compute_chain_hash("abc123", "auth.login", &details.to_string());
        let h2 = compute_chain_hash("abc123", "auth.logout", &details.to_string());
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_chain_differs_on_previous() {
        let details = serde_json::json!({"id": "123"});
        let h1 = compute_chain_hash("", "user.create", &details.to_string());
        let h2 = compute_chain_hash("previous-hash-xyz", "user.create", &details.to_string());
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_chain_differs_on_details() {
        let d1 = serde_json::json!({"key": "a"});
        let d2 = serde_json::json!({"key": "b"});
        let h1 = compute_chain_hash("", "settings.update", &d1.to_string());
        let h2 = compute_chain_hash("", "settings.update", &d2.to_string());
        assert_ne!(h1, h2);
    }
}
