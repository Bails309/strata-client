use std::time::Duration;
use crate::services::app_state::{SharedState, BootPhase};

pub fn spawn_cleanup_task(state: SharedState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(24 * 3600)); // Once a day
        loop {
            interval.tick().await;
            if let Err(e) = run_cleanup(state.clone()).await {
                tracing::error!("User cleanup task failed: {e}");
            }
        }
    });
}

async fn run_cleanup(state: SharedState) -> anyhow::Result<()> {
    let db = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        s.db.clone().ok_or_else(|| anyhow::anyhow!("DB not found"))?
    };

    tracing::info!("Running user cleanup (hard-deleting users soft-deleted for >7 days) ...");

    let result = sqlx::query(
        "DELETE FROM users WHERE deleted_at < now() - INTERVAL '7 days'"
    )
    .execute(&db.pool)
    .await?;

    if result.rows_affected() > 0 {
        tracing::info!("Hard-deleted {} user(s)", result.rows_affected());
    }

    Ok(())
}
