use sha2::{Digest, Sha256};
use sqlx::{Pool, Postgres};
use uuid::Uuid;

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
