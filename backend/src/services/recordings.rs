/// Check whether session recording is enabled in the DB.
pub struct RecordingConfig {
    pub enabled: bool,
    #[allow(dead_code)]
    pub retention_days: u32,
}

pub async fn get_config(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> anyhow::Result<RecordingConfig> {
    let enabled = crate::services::settings::get(pool, "recordings_enabled")
        .await?
        .unwrap_or_else(|| "false".into())
        == "true";

    let retention_days: u32 = crate::services::settings::get(pool, "recordings_retention_days")
        .await?
        .unwrap_or_else(|| "30".into())
        .parse()
        .unwrap_or(30);

    Ok(RecordingConfig {
        enabled,
        retention_days,
    })
}
