use sha2::{Digest, Sha256};
use sqlx::{Pool, Postgres};
use uuid::Uuid;

/// Append an immutable, hash-chained audit log entry.
pub async fn log(
    pool: &Pool<Postgres>,
    user_id: Option<Uuid>,
    action_type: &str,
    details: &serde_json::Value,
) -> anyhow::Result<()> {
    // Fetch hash of the most recent entry (or empty string for the first)
    let previous_hash: String = sqlx::query_scalar(
        "SELECT current_hash FROM audit_logs ORDER BY id DESC LIMIT 1",
    )
    .fetch_optional(pool)
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
    .execute(pool)
    .await?;

    Ok(())
}
