use crate::services::app_state::{BootPhase, SharedState};
use sqlx::{Pool, Postgres};
use std::time::Duration;
use tokio::net::TcpStream;
use uuid::Uuid;

/// Spawn the connection health-check worker.
/// Runs every 120 seconds, TCP-probes each connection's hostname:port.
///
/// W2-6 / W2-7 — driven by the shared worker harness: listens on the
/// shutdown token, bounds each iteration with a timeout, and backs off with
/// jitter after an error.
pub fn spawn_health_check_worker(
    state: SharedState,
    shutdown: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    use crate::services::worker::{spawn_periodic, PeriodicConfig};
    spawn_periodic(
        PeriodicConfig {
            label: "connection_health_check",
            initial_delay: Duration::from_secs(15),
            interval: Duration::from_secs(120),
            // Each target has its own 5s TCP timeout; cap the whole pass at 90s.
            iteration_timeout: Duration::from_secs(90),
            error_backoff_base: Duration::from_secs(10),
        },
        shutdown,
        move || {
            let state = state.clone();
            async move { run_health_checks(state).await }
        },
    )
}

#[derive(sqlx::FromRow)]
struct ConnTarget {
    id: Uuid,
    protocol: String,
    hostname: String,
    port: i32,
    extra: serde_json::Value,
}

async fn run_health_checks(state: SharedState) -> anyhow::Result<()> {
    let pool = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        s.db.clone().ok_or_else(|| anyhow::anyhow!("No DB"))?.pool
    };

    let targets: Vec<ConnTarget> = sqlx::query_as(
        "SELECT id, protocol, hostname, port, extra FROM connections WHERE soft_deleted_at IS NULL",
    )
    .fetch_all(&pool)
    .await?;

    // Probe all connections concurrently with a per-connection timeout
    let handles: Vec<_> = targets
        .into_iter()
        .map(|t| {
            let pool = pool.clone();
            tokio::spawn(async move {
                // For `web` connections the operator-typed hostname/port is a
                // no-op placeholder (the runtime spawns Xvnc on a private
                // 5900+display port). Probing that is meaningless, so for
                // `web` we resolve the *target* host/port from the
                // `extra.url` field — defaulting to 443 for `https://` and
                // 80 for `http://` when no explicit port is present.
                let (host, port) = if t.protocol == "web" {
                    match web_probe_target(&t.extra) {
                        Some(hp) => hp,
                        None => {
                            let _ = update_health(&pool, t.id, "unknown").await;
                            return;
                        }
                    }
                } else {
                    (t.hostname.clone(), t.port as u16)
                };
                let status = probe_tcp(&host, port).await;
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

/// Resolve the (host, port) pair to TCP-probe for a `web` connection by
/// parsing its `extra.url` field. Falls back to scheme-default ports
/// (443 for `https`, 80 for `http`). Returns `None` when the URL is
/// missing, unparsable, or has no host — callers should record
/// `unknown` in that case rather than misleadingly probing the
/// placeholder VNC port.
fn web_probe_target(extra: &serde_json::Value) -> Option<(String, u16)> {
    let raw = extra.get("url")?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    let host = parsed.host_str()?.to_owned();
    let port = parsed.port_or_known_default().or_else(|| match parsed.scheme() {
        "https" => Some(443),
        "http" => Some(80),
        _ => None,
    })?;
    Some((host, port))
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

    #[test]
    fn web_probe_target_https_default_port() {
        let extra = serde_json::json!({ "url": "https://example.com/login" });
        let (h, p) = web_probe_target(&extra).unwrap();
        assert_eq!(h, "example.com");
        assert_eq!(p, 443);
    }

    #[test]
    fn web_probe_target_http_default_port() {
        let extra = serde_json::json!({ "url": "http://example.com/" });
        let (h, p) = web_probe_target(&extra).unwrap();
        assert_eq!(h, "example.com");
        assert_eq!(p, 80);
    }

    #[test]
    fn web_probe_target_explicit_port() {
        let extra = serde_json::json!({ "url": "https://example.com:8443/app" });
        let (h, p) = web_probe_target(&extra).unwrap();
        assert_eq!(h, "example.com");
        assert_eq!(p, 8443);
    }

    #[test]
    fn web_probe_target_missing_url() {
        let extra = serde_json::json!({});
        assert!(web_probe_target(&extra).is_none());
    }

    #[test]
    fn web_probe_target_unparsable() {
        let extra = serde_json::json!({ "url": "not a url" });
        assert!(web_probe_target(&extra).is_none());
    }
}
