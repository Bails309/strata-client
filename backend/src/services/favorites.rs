//! DB operations for per-user favorites.
//!
//! Extracted from [`crate::routes::user`] so route handlers can be thin
//! orchestration layers over a typed service boundary (§3.1 / W4-6).

use crate::error::AppError;
use sqlx::{Pool, Postgres};
use uuid::Uuid;

/// List the connection ids a user has favorited.
pub async fn list(pool: &Pool<Postgres>, user_id: Uuid) -> Result<Vec<Uuid>, AppError> {
    let ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT connection_id FROM user_favorites WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    Ok(ids)
}

/// Check whether a `(user, connection)` pair is favorited.
/// DB errors are swallowed to `false` to preserve the prior behaviour
/// of the handler (which used `.unwrap_or(false)`).
pub async fn is_favorite(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<bool, AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM user_favorites WHERE user_id = $1 AND connection_id = $2)",
    )
    .bind(user_id)
    .bind(connection_id)
    .fetch_one(pool)
    .await
    .unwrap_or(false);
    Ok(exists)
}

pub async fn remove(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM user_favorites WHERE user_id = $1 AND connection_id = $2")
        .bind(user_id)
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn add(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO user_favorites (user_id, connection_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .bind(connection_id)
    .execute(pool)
    .await?;
    Ok(())
}
