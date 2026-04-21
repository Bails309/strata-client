//! Periodic sweeper that hard-deletes expired rows from `active_sessions`.
//!
//! Split out of `main.rs` (W2-5 / W2-8) so it (a) uses the shared worker
//! harness with timeout + jittered backoff + cancellation, and (b) does not
//! silently drop errors via `let _ = sqlx::query(...)`.

use std::time::Duration;

use sqlx::{Pool, Postgres};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

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
