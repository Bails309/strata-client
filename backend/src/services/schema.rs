//! Schema / migration introspection helpers for health endpoints.

use crate::error::AppError;
use sqlx::{Pool, Postgres};

/// Count applied migrations recorded in `_sqlx_migrations`.
pub async fn count_applied_migrations(pool: &Pool<Postgres>) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await?;
    Ok(count)
}
