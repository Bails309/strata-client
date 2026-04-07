use sqlx::{Pool, Postgres};

/// Read a setting value from the `system_settings` table.
pub async fn get(pool: &Pool<Postgres>, key: &str) -> anyhow::Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM system_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|r| r.0))
}

/// Upsert a setting value.
pub async fn set(pool: &Pool<Postgres>, key: &str, value: &str) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

/// Read all settings as key-value pairs.
pub async fn get_all(pool: &Pool<Postgres>) -> anyhow::Result<Vec<(String, String)>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM system_settings ORDER BY key")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}
