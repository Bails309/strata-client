use crate::services::app_state::{BootPhase, SharedState};
use crate::services::recordings;
use crate::services::worker::{spawn_periodic, PeriodicConfig};
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// W2-4 / W2-7 — shared worker harness: cancellation, per-iteration timeout,
/// jittered error backoff.
pub fn spawn_cleanup_task(state: SharedState, shutdown: CancellationToken) -> JoinHandle<()> {
    spawn_periodic(
        PeriodicConfig {
            label: "user_cleanup",
            initial_delay: Duration::from_secs(60),
            interval: Duration::from_secs(24 * 3600),
            iteration_timeout: Duration::from_secs(30 * 60),
            error_backoff_base: Duration::from_secs(60),
        },
        shutdown,
        move || {
            let state = state.clone();
            async move { run_cleanup(state).await }
        },
    )
}

// CodeQL note: `rust/unused-variable` misfires on `e` bindings interpolated
// into `tracing::warn!("… {e}")` inside `async move` blocks (alerts #76, #77).
// Suppress.
#[allow(unused_variables)]
async fn run_cleanup(state: SharedState) -> anyhow::Result<()> {
    let (db, vault) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        let db =
            s.db.clone()
                .ok_or_else(|| anyhow::anyhow!("DB not found"))?;
        let vault = s.config.as_ref().and_then(|c| c.vault.clone());
        (db, vault)
    };

    // W5-2: window is configurable via the `user_hard_delete_days` setting;
    // defaults to 90 days when unset or malformed. Operators can set it to a
    // smaller value for shorter retention; zero or negative values fall back
    // to the default so a misconfiguration cannot hard-delete everything.
    let days = crate::services::settings::get(&db.pool, "user_hard_delete_days")
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|d| *d > 0)
        .unwrap_or(90);

    tracing::info!("Running user cleanup (hard-deleting users soft-deleted for >{days} days) ...");

    // ── Stale-account soft-delete sweep ──
    //
    // Operators can configure `user_stale_days` to auto-soft-delete any
    // live user whose `last_login_at` is older than the threshold. The
    // sweep deliberately skips users with NULL `last_login_at` so that
    // freshly-provisioned accounts (e.g. AD-sync imports that have never
    // signed in) are not aged out solely on the basis of their creation
    // time — the clock only starts ticking once the user has logged in
    // at least once. A value of 0 (the default) disables the sweep.
    //
    // The bootstrap admin account (matched case-insensitively against
    // `DEFAULT_ADMIN_USERNAME`, default "admin") is *always* excluded from
    // the sweep — losing it would leave the deployment with no way to
    // recover. Operators who genuinely want to retire that account can
    // still soft-delete it manually from the Users blade.
    let stale_days = crate::services::settings::get(&db.pool, "user_stale_days")
        .await
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|d| *d > 0);

    if let Some(stale_days) = stale_days {
        let default_admin_username =
            std::env::var("DEFAULT_ADMIN_USERNAME").unwrap_or_else(|_| "admin".into());

        let (stale, swept) =
            sweep_stale_users(&db.pool, stale_days, &default_admin_username).await?;

        if !stale.is_empty() {
            tracing::info!(
                "Soft-deleted {} stale user(s) (no login in >{} days)",
                swept,
                stale_days
            );

            for (uid, uname) in &stale {
                let _ = crate::services::audit::log(
                    &db.pool,
                    None,
                    "user.stale_auto_deleted",
                    &serde_json::json!({
                        "user_id": uid.to_string(),
                        "username": uname,
                        "stale_days": stale_days,
                    }),
                )
                .await;
            }
        }
    }

    // ── Purge recording files for users about to be hard-deleted ──
    let doomed_recordings: Vec<(String, String)> = sqlx::query_as(
        "SELECT r.storage_path, r.storage_type
         FROM recordings r
         JOIN users u ON r.user_id = u.id
         WHERE u.deleted_at < now() - make_interval(days => $1)",
    )
    .bind(days)
    .fetch_all(&db.pool)
    .await?;

    if !doomed_recordings.is_empty() {
        let azure_cfg = recordings::get_azure_config(&db.pool, vault.as_ref())
            .await
            .ok()
            .flatten();
        let recordings_dir = "/var/lib/guacamole/recordings";

        // Parallelise file deletions using concurrent futures
        let mut delete_futures = Vec::with_capacity(doomed_recordings.len());
        for (storage_path, storage_type) in &doomed_recordings {
            let path = storage_path.clone();
            let stype = storage_type.clone();
            let cfg = azure_cfg.clone();
            let rdir = recordings_dir.to_string();
            delete_futures.push(async move {
                match stype.as_str() {
                    "local" => {
                        let full_path = format!("{rdir}/{path}");
                        if let Err(e) = tokio::fs::remove_file(&full_path).await {
                            let err_str = e.to_string();
                            tracing::warn!(
                                "Failed to delete local recording {}: {}",
                                path,
                                err_str
                            );
                        }
                    }
                    "azure" | "azure_blob" => {
                        if let Some(ref cfg) = cfg {
                            if let Err(e) = recordings::delete_from_azure(cfg, &path).await {
                                let err_str = e.to_string();
                                tracing::warn!(
                                    "Failed to delete Azure recording {}: {}",
                                    path,
                                    err_str
                                );
                            }
                        }
                    }
                    _ => {}
                }
            });
        }
        futures_util::future::join_all(delete_futures).await;

        tracing::info!(
            "Purged {} recording file(s) for users pending hard-delete",
            doomed_recordings.len()
        );
    }

    // ── Hard-delete the users (CASCADE removes DB rows for recordings, tags, etc.) ──
    let deleted = hard_delete_users(&db.pool, days).await?;
    if deleted > 0 {
        tracing::info!("Hard-deleted {} user(s)", deleted);
    }

    // Keep one-shot Safeguard enrolment codes bounded over time.
    if let Ok(purged) = crate::services::safeguard::enrolment::purge_expired(&db.pool).await {
        if purged > 0 {
            tracing::info!("Purged {} expired Safeguard enrolment code(s)", purged);
        }
    }

    // Same for one-shot outbound-share ingest tokens.
    if let Ok(purged) = crate::services::outbound_share_ingest::purge_expired(&db.pool).await {
        if purged > 0 {
            tracing::info!("Purged {} expired outbound-share ingest token(s)", purged);
        }
    }

    Ok(())
}

/// Soft-delete live users whose last login is older than `stale_days`.
///
/// Returns the swept users (collected first so the caller can audit each
/// one; the worker has no acting-user id) and the number of rows updated.
async fn sweep_stale_users(
    pool: &sqlx::PgPool,
    stale_days: i32,
    default_admin_username: &str,
) -> sqlx::Result<(Vec<(uuid::Uuid, String)>, u64)> {
    let stale: Vec<(uuid::Uuid, String)> = sqlx::query_as(
        "SELECT id, username
         FROM users
         WHERE deleted_at IS NULL
           AND last_login_at IS NOT NULL
           AND last_login_at < now() - make_interval(days => $1)
           AND LOWER(username) <> LOWER($2)",
    )
    .bind(stale_days)
    .bind(default_admin_username)
    .fetch_all(pool)
    .await?;
    if stale.is_empty() {
        return Ok((stale, 0));
    }

    let result = sqlx::query(
        "UPDATE users
         SET deleted_at = now()
         WHERE deleted_at IS NULL
           AND last_login_at IS NOT NULL
           AND last_login_at < now() - make_interval(days => $1)
           AND LOWER(username) <> LOWER($2)",
    )
    .bind(stale_days)
    .bind(default_admin_username)
    .execute(pool)
    .await?;
    Ok((stale, result.rows_affected()))
}

/// Hard-delete users soft-deleted more than `days` ago.
async fn hard_delete_users(pool: &sqlx::PgPool, days: i32) -> sqlx::Result<u64> {
    let result =
        sqlx::query("DELETE FROM users WHERE deleted_at < now() - make_interval(days => $1)")
            .bind(days)
            .execute(pool)
            .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database. The
    /// windows are years long so rows from other tests are never swept.
    #[tokio::test]
    async fn the_sweep_spares_the_admin_and_unused_accounts_and_purges_after_the_window() {
        let Some(pool) = std::env::var("TEST_DATABASE_URL")
            .ok()
            .and_then(|url| sqlx::PgPool::connect_lazy(&url).ok())
        else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let tag = Uuid::new_v4().simple().to_string();
        let role: Uuid = sqlx::query_scalar("INSERT INTO roles (name) VALUES ($1) RETURNING id")
            .bind(format!("cleanup-{tag}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        let user = |name: &'static str, last_login: Option<i32>| {
            let pool = pool.clone();
            let tag = tag.clone();
            async move {
                sqlx::query_scalar::<_, Uuid>(
                    "INSERT INTO users (username, email, role_id, last_login_at)
                     VALUES ($1, $2, $3, now() - make_interval(days => $4)) RETURNING id",
                )
                .bind(format!("{name}-{tag}"))
                .bind(format!("{name}-{tag}@example.test"))
                .bind(role)
                .bind(last_login)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        let stale = user("stale", Some(4000)).await;
        let recent = user("recent", Some(1)).await;
        let never = user("never", None).await;
        let admin = user("admin", Some(4000)).await;
        let deleted_at = |id: Uuid| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
                    "SELECT deleted_at FROM users WHERE id = $1",
                )
                .bind(id)
                .fetch_optional(&pool)
                .await
                .unwrap()
            }
        };

        // The admin match is case-insensitive.
        let (swept, count) = sweep_stale_users(&pool, 3650, &format!("ADMIN-{tag}"))
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(swept, vec![(stale, format!("stale-{tag}"))]);
        assert!(deleted_at(stale).await.flatten().is_some());
        for kept in [recent, never, admin] {
            assert_eq!(deleted_at(kept).await, Some(None), "{kept} was swept");
        }

        // Soft-deleted rows stay until the retention window has passed.
        assert_eq!(hard_delete_users(&pool, 3650).await.unwrap(), 0);
        sqlx::query("UPDATE users SET deleted_at = now() - interval '4000 days' WHERE id = $1")
            .bind(stale)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(hard_delete_users(&pool, 3650).await.unwrap(), 1);
        assert_eq!(deleted_at(stale).await, None);

        sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(vec![recent, never, admin])
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM roles WHERE id = $1")
            .bind(role)
            .execute(&pool)
            .await
            .unwrap();
    }
}
