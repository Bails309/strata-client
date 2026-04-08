use sqlx::{Pool, Postgres};

/// Lightweight wrapper for health-checking the pool.
pub async fn check(pool: &Pool<Postgres>) -> bool {
    sqlx::query("SELECT 1").execute(pool).await.is_ok()
}
