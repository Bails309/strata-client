use crate::services::app_state::{BootPhase, SharedState};
use crate::services::recordings;
use std::time::Duration;

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
    let (db, vault) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        let db = s.db.clone()
            .ok_or_else(|| anyhow::anyhow!("DB not found"))?;
        let vault = s.config.as_ref().and_then(|c| c.vault.clone());
        (db, vault)
    };

    tracing::info!("Running user cleanup (hard-deleting users soft-deleted for >7 days) ...");

    // ── Purge recording files for users about to be hard-deleted ──
    let doomed_recordings: Vec<(String, String)> = sqlx::query_as(
        "SELECT r.storage_path, r.storage_type
         FROM recordings r
         JOIN users u ON r.user_id = u.id
         WHERE u.deleted_at < now() - INTERVAL '7 days'",
    )
    .fetch_all(&db.pool)
    .await?;

    if !doomed_recordings.is_empty() {
        let azure_cfg = recordings::get_azure_config(&db.pool, vault.as_ref()).await.ok().flatten();
        let recordings_dir = "/var/lib/guacamole/recordings";

        for (storage_path, storage_type) in &doomed_recordings {
            match storage_type.as_str() {
                "local" => {
                    let path = format!("{recordings_dir}/{storage_path}");
                    if let Err(e) = tokio::fs::remove_file(&path).await {
                        tracing::warn!("Failed to delete local recording {storage_path}: {e}");
                    }
                }
                "azure" | "azure_blob" => {
                    if let Some(ref cfg) = azure_cfg {
                        if let Err(e) = recordings::delete_from_azure(cfg, storage_path).await {
                            tracing::warn!("Failed to delete Azure recording {storage_path}: {e}");
                        }
                    }
                }
                _ => {}
            }
        }

        tracing::info!("Purged {} recording file(s) for users pending hard-delete", doomed_recordings.len());
    }

    // ── Hard-delete the users (CASCADE removes DB rows for recordings, tags, etc.) ──
    let result = sqlx::query("DELETE FROM users WHERE deleted_at < now() - INTERVAL '7 days'")
        .execute(&db.pool)
        .await?;

    if result.rows_affected() > 0 {
        tracing::info!("Hard-deleted {} user(s)", result.rows_affected());
    }

    Ok(())
}
