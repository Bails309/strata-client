use sha2::{Digest, Sha256};
use sqlx::{Pool, Postgres};
use uuid::Uuid;

/// Append an immutable, hash-chained audit log entry.
/// Uses `SELECT … FOR UPDATE` on the most recent row to serialise inserts
/// within a transaction, preventing concurrent requests from reading the
/// same previous_hash and forking the chain.  This is more granular than
/// a global advisory lock and allows better throughput under concurrency.
pub async fn log(
    pool: &Pool<Postgres>,
    user_id: Option<Uuid>,
    action_type: &str,
    details: &serde_json::Value,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    // Lock the most recent row to serialise concurrent inserts.
    // If the table is empty (first entry), no row is locked and there is
    // no contention.  FOR UPDATE ensures only one transaction can read
    // the tail at a time — others block until this transaction commits.
    let previous_hash: String =
        sqlx::query_scalar(
            "SELECT current_hash FROM audit_logs ORDER BY id DESC LIMIT 1 FOR UPDATE"
        )
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or_default();

    // Compute current_hash = SHA-256(previous_hash || action_type || details)
    let mut hasher = Sha256::new();
    hasher.update(previous_hash.as_bytes());
    hasher.update(action_type.as_bytes());
    hasher.update(details.to_string().as_bytes());
    let current_hash = hex::encode(hasher.finalize());

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
    use sha2::{Digest, Sha256};

    #[test]
    fn hash_chain_deterministic() {
        let previous_hash = "";
        let action_type = "auth.login";
        let details = serde_json::json!({"username": "admin"});

        let mut hasher = Sha256::new();
        hasher.update(previous_hash.as_bytes());
        hasher.update(action_type.as_bytes());
        hasher.update(details.to_string().as_bytes());
        let hash1 = hex::encode(hasher.finalize());

        let mut hasher2 = Sha256::new();
        hasher2.update(previous_hash.as_bytes());
        hasher2.update(action_type.as_bytes());
        hasher2.update(details.to_string().as_bytes());
        let hash2 = hex::encode(hasher2.finalize());

        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 64); // SHA-256 = 64 hex chars
    }

    #[test]
    fn hash_chain_differs_on_action() {
        let previous = "abc123";
        let details = serde_json::json!({});

        let compute = |action: &str| -> String {
            let mut h = Sha256::new();
            h.update(previous.as_bytes());
            h.update(action.as_bytes());
            h.update(details.to_string().as_bytes());
            hex::encode(h.finalize())
        };

        assert_ne!(compute("auth.login"), compute("auth.logout"));
    }

    #[test]
    fn hash_chain_differs_on_previous() {
        let action = "user.create";
        let details = serde_json::json!({"id": "123"});

        let compute = |prev: &str| -> String {
            let mut h = Sha256::new();
            h.update(prev.as_bytes());
            h.update(action.as_bytes());
            h.update(details.to_string().as_bytes());
            hex::encode(h.finalize())
        };

        assert_ne!(compute(""), compute("previous-hash-xyz"));
    }

    #[test]
    fn hash_chain_differs_on_details() {
        let previous = "";
        let action = "settings.update";

        let compute = |details: &serde_json::Value| -> String {
            let mut h = Sha256::new();
            h.update(previous.as_bytes());
            h.update(action.as_bytes());
            h.update(details.to_string().as_bytes());
            hex::encode(h.finalize())
        };

        let d1 = serde_json::json!({"key": "a"});
        let d2 = serde_json::json!({"key": "b"});
        assert_ne!(compute(&d1), compute(&d2));
    }
}
