//! Periodic sweepers.
//!
//! Two workers live here:
//!
//! 1. `active_sessions` row expiry — hard-deletes rows whose
//!    `expires_at < now()`. Split out of `main.rs` (W2-5 / W2-8) so it
//!    (a) uses the shared worker harness with timeout + jittered
//!    backoff + cancellation, and (b) does not silently drop errors
//!    via `let _ = sqlx::query(...)`.
//!
//! 2. VDI container reaper (rustguac parity, Phase 3) — destroys
//!    containers that are idle past their per-connection
//!    `idle_timeout_mins` and cleans up orphans (containers carrying
//!    the `strata.managed=true` label that have no matching row in
//!    `vdi_containers` — typically left behind across a backend
//!    restart). The reaper is a no-op when the configured
//!    [`crate::services::vdi::VdiDriver`] is the
//!    [`crate::services::vdi::NoopVdiDriver`] —
//!    `list_managed_containers` returns an empty vec and there's
//!    nothing to do.

use std::sync::Arc;
use std::time::Duration;

use sqlx::{Pool, Postgres};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::services::app_state::SharedState;
use crate::services::vdi::{AUDIT_VDI_CONTAINER_DESTROY, VdiDriver};
use crate::services::worker::{spawn_periodic, PeriodicConfig};

/// Spawn the active-sessions expiry sweeper. Runs every 5 minutes with a
/// 2-minute per-iteration budget.
pub fn spawn_session_cleanup_task(
    pool: Pool<Postgres>,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    spawn_periodic(
        PeriodicConfig {
            label: "active_sessions_cleanup",
            initial_delay: Duration::from_secs(60),
            interval: Duration::from_secs(300),
            iteration_timeout: Duration::from_secs(120),
            error_backoff_base: Duration::from_secs(10),
        },
        shutdown,
        move || {
            let pool = pool.clone();
            async move { run_once(&pool).await }
        },
    )
}

async fn run_once(pool: &Pool<Postgres>) -> anyhow::Result<()> {
    let deleted = sqlx::query("DELETE FROM active_sessions WHERE expires_at < now()")
        .execute(pool)
        .await?
        .rows_affected();
    if deleted > 0 {
        tracing::debug!("active_sessions sweep: {deleted} expired rows deleted");
    }
    Ok(())
}

// ─── VDI container reaper ──────────────────────────────────────────

/// Spawn the VDI container reaper. Runs every 60 seconds with a
/// 90-second per-iteration budget.
///
/// Two responsibilities:
///
/// 1. **Idle reap.** Containers whose `vdi_containers.last_seen_at`
///    is older than the connection's `extra->>'idle_timeout_mins'`
///    (defaulting to 30) are destroyed. The destroy call is
///    best-effort — the row is hard-deleted from `vdi_containers`
///    regardless so a stale row never blocks re-spawn of the same
///    `(connection, user)` pair.
///
/// 2. **Orphan reap.** Any container carrying the
///    `strata.managed=true` label that does **not** match a current
///    row in `vdi_containers` is destroyed. Catches containers left
///    behind across a backend restart, an interrupted destroy, or a
///    container created out-of-band against the same docker daemon.
///
/// Both paths emit `vdi.container.destroy` audit events with the
/// reason in `details` (`idle_timeout` / `orphan_reaper`). When the
/// configured driver is the [`crate::services::vdi::NoopVdiDriver`]
/// the reaper is a free no-op — `list_managed_containers` returns an
/// empty vec and the idle query finds no rows because no spawn has
/// ever populated `vdi_containers`.
pub fn spawn_vdi_reaper(state: SharedState, shutdown: CancellationToken) -> JoinHandle<()> {
    spawn_periodic(
        PeriodicConfig {
            label: "vdi_container_reaper",
            initial_delay: Duration::from_secs(120),
            interval: Duration::from_secs(60),
            iteration_timeout: Duration::from_secs(90),
            error_backoff_base: Duration::from_secs(15),
        },
        shutdown,
        move || {
            let state = state.clone();
            async move { run_vdi_reaper_once(&state).await }
        },
    )
}

async fn run_vdi_reaper_once(state: &SharedState) -> anyhow::Result<()> {
    // Snapshot what we need so the read lock is held for the
    // minimum time.
    let (pool, driver) = {
        let s = state.read().await;
        let pool = s
            .db
            .as_ref()
            .map(|db| db.pool.clone())
            .ok_or_else(|| anyhow::anyhow!("vdi reaper: no db pool available"))?;
        let driver: Arc<dyn VdiDriver> = s.vdi_driver.clone();
        (pool, driver)
    };

    // ── 1. Idle reap ────────────────────────────────────────────────
    let idle_rows: Vec<IdleVdiRow> = sqlx::query_as(
        r#"
        SELECT
            v.container_name AS container_name,
            v.user_id        AS user_id,
            COALESCE(
                NULLIF(c.extra->>'idle_timeout_mins', '')::int,
                30
            ) AS idle_timeout_mins,
            EXTRACT(EPOCH FROM (now() - v.last_seen_at))::bigint AS idle_secs
        FROM vdi_containers v
        LEFT JOIN connections c ON c.id = v.connection_id
        WHERE v.state IN ('running', 'starting')
          AND v.last_seen_at < now() - INTERVAL '1 minute'
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| anyhow::anyhow!("vdi reaper: idle query failed: {e}"))?;

    for row in &idle_rows {
        let timeout_secs = (row.idle_timeout_mins.max(1) as i64) * 60;
        if row.idle_secs < timeout_secs {
            continue;
        }
        match driver.destroy_container(&row.container_name).await {
            Ok(()) => {
                tracing::info!(
                    container = %row.container_name,
                    idle_secs = row.idle_secs,
                    "vdi reaper: destroyed idle container"
                );
            }
            Err(e) => {
                tracing::warn!(
                    container = %row.container_name,
                    error = %e,
                    "vdi reaper: idle destroy failed (continuing — row will be cleared)"
                );
            }
        }
        // Hard-delete the row regardless — a stale row would otherwise
        // block re-spawn of the same (connection, user) pair.
        let _ = sqlx::query("DELETE FROM vdi_containers WHERE container_name = $1")
            .bind(&row.container_name)
            .execute(&pool)
            .await;
        let details = serde_json::json!({
            "container_name": row.container_name,
            "reason": "idle_timeout",
            "idle_secs": row.idle_secs,
            "idle_timeout_mins": row.idle_timeout_mins,
        });
        let _ = crate::services::audit::log(
            &pool,
            Some(row.user_id),
            AUDIT_VDI_CONTAINER_DESTROY,
            &details,
        )
        .await;
    }

    // ── 2. Orphan reap ──────────────────────────────────────────────
    let managed = match driver.list_managed_containers().await {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!(
                error = %e,
                "vdi reaper: list_managed_containers failed (driver may not be configured)"
            );
            Vec::new()
        }
    };

    if !managed.is_empty() {
        let known: Vec<(String,)> = sqlx::query_as(
            "SELECT container_name FROM vdi_containers \
             WHERE state IN ('running','starting','stopping')",
        )
        .fetch_all(&pool)
        .await
        .map_err(|e| anyhow::anyhow!("vdi reaper: known-set query failed: {e}"))?;
        let known: std::collections::HashSet<String> =
            known.into_iter().map(|(n,)| n).collect();

        for name in managed {
            if known.contains(&name) {
                continue;
            }
            match driver.destroy_container(&name).await {
                Ok(()) => {
                    tracing::info!(container = %name, "vdi reaper: destroyed orphan");
                    let details = serde_json::json!({
                        "container_name": name,
                        "reason": "orphan_reaper",
                    });
                    let _ = crate::services::audit::log(
                        &pool,
                        None,
                        AUDIT_VDI_CONTAINER_DESTROY,
                        &details,
                    )
                    .await;
                }
                Err(e) => {
                    tracing::warn!(
                        container = %name,
                        error = %e,
                        "vdi reaper: orphan destroy failed"
                    );
                }
            }
        }
    }

    Ok(())
}

#[derive(sqlx::FromRow)]
struct IdleVdiRow {
    container_name: String,
    user_id: uuid::Uuid,
    idle_timeout_mins: i32,
    idle_secs: i64,
}
