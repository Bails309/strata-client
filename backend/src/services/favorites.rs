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

/// Atomically toggle a `(user_id, connection_id)` favorite.
///
/// Returns `true` when the row was just inserted (now favorited) and
/// `false` when the row was just removed (no longer favorited). Wrapped
/// in a single transaction so two concurrent toggles can't both observe
/// the same starting state and race past each other — without this, a
/// double-click could end with the row inserted by one request and
/// immediately deleted by the other, leaving the UI showing the wrong
/// state. The PK on `(user_id, connection_id)` guarantees serialisation.
pub async fn toggle(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let removed: Option<(Uuid,)> = sqlx::query_as(
        "DELETE FROM user_favorites
         WHERE user_id = $1 AND connection_id = $2
         RETURNING connection_id",
    )
    .bind(user_id)
    .bind(connection_id)
    .fetch_optional(&mut *tx)
    .await?;

    let now_favorited = if removed.is_some() {
        false
    } else {
        sqlx::query(
            "INSERT INTO user_favorites (user_id, connection_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(user_id)
        .bind(connection_id)
        .execute(&mut *tx)
        .await?;
        true
    };
    tx.commit().await?;
    Ok(now_favorited)
}
