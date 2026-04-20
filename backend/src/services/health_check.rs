use crate::services::app_state::{BootPhase, SharedState};
use sqlx::{Pool, Postgres};
use std::time::Duration;
use tokio::net::TcpStream;
use uuid::Uuid;

/// Spawn the connection health-check worker.
/// Runs every 120 seconds, TCP-probes each connection's hostname:port.
pub fn spawn_health_check_worker(state: SharedState) {
    tokio::spawn(async move {
        // Wait 15s after boot before first run
        tokio::time::sleep(Duration::from_secs(15)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(120));
        loop {
            interval.tick().await;
            if let Err(e) = run_health_checks(state.clone()).await {
                tracing::error!("Connection health-check worker error: {e}");
            }
        }
    });
}

#[derive(sqlx::FromRow)]
struct ConnTarget {
    id: Uuid,
    hostname: String,
    port: i32,
}

async fn run_health_checks(state: SharedState) -> anyhow::Result<()> {
    let pool = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        s.db.clone().ok_or_else(|| anyhow::anyhow!("No DB"))?.pool
    };

    let targets: Vec<ConnTarget> =
        sqlx::query_as("SELECT id, hostname, port FROM connections WHERE soft_deleted_at IS NULL")
            .fetch_all(&pool)
            .await?;

    // Probe all connections concurrently with a per-connection timeout
    let handles: Vec<_> = targets
        .into_iter()
        .map(|t| {
            let pool = pool.clone();
            tokio::spawn(async move {
                let status = probe_tcp(&t.hostname, t.port as u16).await;
                let _ = update_health(&pool, t.id, status).await;
            })
        })
        .collect();

    for h in handles {
        let _ = h.await;
    }

    Ok(())
}

/// Attempt a TCP connect to hostname:port with a 5-second timeout.
async fn probe_tcp(hostname: &str, port: u16) -> &'static str {
    let addr = format!("{}:{}", hostname, port);
    match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr)).await {
        Ok(Ok(_stream)) => "online",
        _ => "offline",
    }
}

async fn update_health(
    pool: &Pool<Postgres>,
    connection_id: Uuid,
    status: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE connections SET health_status = $1, health_checked_at = now() WHERE id = $2",
    )
    .bind(status)
    .bind(connection_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_probe_tcp_offline() {
        // Use a port that is unlikely to be open
        let status = probe_tcp("127.0.0.1", 54321).await;
        assert_eq!(status, "offline");
    }

    #[tokio::test]
    async fn test_probe_tcp_invalid_host() {
        let status = probe_tcp("invalid-host-name-123", 80).await;
        assert_eq!(status, "offline");
    }
}
