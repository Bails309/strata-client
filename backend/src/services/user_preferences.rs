//! Per-user UI preferences (keybindings, etc.).
//!
//! Stored as a single JSONB blob per user in `user_preferences`. Keeping
//! the schema open-ended lets us add new preferences without further
//! migrations — the frontend is the source of truth for the shape of the
//! object. The backend treats it as opaque JSON with one validation rule:
//! the top-level value must be a JSON object.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;

/// Fetch the preferences object for a user, or `{}` if no row exists.
pub async fn get(pool: &PgPool, user_id: Uuid) -> Result<Value, AppError> {
    let row: Option<(Value,)> =
        sqlx::query_as("SELECT preferences FROM user_preferences WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| AppError::Internal(format!("user_preferences fetch: {e}")))?;
    Ok(row.map(|(v,)| v).unwrap_or_else(|| json!({})))
}

/// Replace the entire preferences object for a user (upsert).
pub async fn set(pool: &PgPool, user_id: Uuid, prefs: &Value) -> Result<(), AppError> {
    if !prefs.is_object() {
        return Err(AppError::Validation(
            "preferences must be a JSON object".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO user_preferences (user_id, preferences, updated_at) \
         VALUES ($1, $2, NOW()) \
         ON CONFLICT (user_id) DO UPDATE \
         SET preferences = EXCLUDED.preferences, updated_at = NOW()",
    )
    .bind(user_id)
    .bind(prefs)
    .execute(pool)
    .await
    .map_err(|e| AppError::Internal(format!("user_preferences upsert: {e}")))?;
    Ok(())
}
