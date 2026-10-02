use crate::services::app_state::{BootPhase, SharedState};
use futures_util::StreamExt;
use sqlx::{Pool, Postgres};
use std::net::IpAddr;
use std::time::Duration;
use tokio::net::TcpStream;
use uuid::Uuid;

/// Probes in flight at once; enough to finish a large estate inside the
/// pass budget without a burst of sockets and DNS queries.
const PROBE_CONCURRENCY: usize = 32;

/// `worker_leases` row that lets one replica run each pass.
const LEASE: &str = "connection_health";
/// Outlives the 90 s pass budget, so a claim lapses only if its holder died.
const LEASE_TTL: Duration = Duration::from_secs(100);
/// Passes are 120 s apart on each replica; a replica running a little behind
/// another must not start a second pass.
const MIN_PASS_GAP: Duration = Duration::from_secs(110);
/// An unchanged result is written again only this often.
const REFRESH_AFTER_SECS: f64 = 300.0;
/// A result not confirmed for this long is reported as unknown.
const STALE_AFTER_SECS: f64 = 900.0;

/// This process, as a lease holder.
static REPLICA: std::sync::LazyLock<Uuid> = std::sync::LazyLock::new(Uuid::new_v4);

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
    use rand::RngExt;
    // Replicas started together would otherwise race for every pass.
    let jitter = Duration::from_secs(rand::rng().random_range(0..60));
    spawn_periodic(
        PeriodicConfig {
            label: "connection_health_check",
            initial_delay: Duration::from_secs(15) + jitter,
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
    web_url: Option<String>,
}

/// Only the columns a probe needs; `extra` can be large.
const TARGET_COLUMNS: &str = "id, protocol, hostname, port, extra->>'url' AS web_url";

impl ConnTarget {
    /// For `web` connections the operator-typed hostname/port is a no-op
    /// placeholder (the runtime spawns Xvnc on a private port), so the
    /// target comes from `extra.url`. `None` means there is nothing to probe.
    fn host_port(&self) -> Option<(String, u16)> {
        if self.protocol == "web" {
            web_probe_target(self.web_url.as_deref())
        } else {
            u16::try_from(self.port)
                .ok()
                .map(|p| (self.hostname.clone(), p))
        }
    }

    /// Host, address and port to probe, resolved the way session creation
    /// resolves them: custom DNS for everything but `web`, which Chromium
    /// resolves for itself.
    async fn resolve(
        &self,
        dns: Option<&crate::services::dns::DnsSettings>,
    ) -> Option<(String, Option<IpAddr>, u16)> {
        let (host, port) = self.host_port()?;
        let addr = match dns {
            Some(cfg) if self.protocol != "web" => crate::services::dns::resolve(cfg, &host).await,
            _ => None,
        };
        Some((host, addr, port))
    }
}

async fn run_health_checks(state: SharedState) -> anyhow::Result<()> {
    let pool = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        s.db.clone().ok_or_else(|| anyhow::anyhow!("No DB"))?.pool
    };

    let holder = *REPLICA;
    if !crate::services::worker_lease::try_claim(&pool, LEASE, holder, LEASE_TTL, MIN_PASS_GAP)
        .await?
    {
        // Another replica has this pass.
        return Ok(());
    }

    let targets: Vec<ConnTarget> = sqlx::query_as(&format!(
        "SELECT {TARGET_COLUMNS} FROM connections WHERE soft_deleted_at IS NULL"
    ))
    .fetch_all(&pool)
    .await?;
    let dns = crate::services::dns::load(&pool).await;

    // Futures, not spawned tasks: when the worker's pass timeout or shutdown
    // drops this function, every probe in flight is dropped with it.
    let results: Vec<(Uuid, &'static str)> = futures_util::stream::iter(targets)
        .map(|t| {
            let dns = dns.as_ref();
            async move {
                let status = match t.resolve(dns).await {
                    Some((host, addr, port)) => probe_addr(&host, addr, port).await,
                    None => "unknown",
                };
                (t.id, status)
            }
        })
        .buffer_unordered(PROBE_CONCURRENCY)
        .collect()
        .await;

    let written = store_results(&pool, &results, holder).await?;
    let expired = expire_stale(&pool).await?;
    crate::services::worker_lease::complete(&pool, LEASE, holder).await?;
    tracing::debug!(
        probed = results.len(),
        written,
        expired,
        "connection health pass complete"
    );
    Ok(())
}

/// Record the results that changed, or were last confirmed long enough ago,
/// in one statement, and only while this replica still holds the pass.
/// Returns the rows written.
async fn store_results(
    pool: &Pool<Postgres>,
    results: &[(Uuid, &str)],
    holder: Uuid,
) -> anyhow::Result<u64> {
    if results.is_empty() {
        return Ok(0);
    }
    let (ids, statuses): (Vec<Uuid>, Vec<&str>) = results.iter().copied().unzip();
    let done = sqlx::query(
        "UPDATE connections AS c
         SET health_status = r.status, health_checked_at = now()
         FROM unnest($1::uuid[], $2::text[]) AS r(id, status)
         WHERE c.id = r.id
           AND (c.health_status IS DISTINCT FROM r.status
                OR c.health_checked_at IS NULL
                OR c.health_checked_at < now() - make_interval(secs => $3))
           AND EXISTS (SELECT 1 FROM worker_leases l
                       WHERE l.name = $4 AND l.holder = $5 AND l.expires_at > now())",
    )
    .bind(&ids)
    .bind(&statuses)
    .bind(REFRESH_AFTER_SECS)
    .bind(LEASE)
    .bind(holder)
    .execute(pool)
    .await?;
    Ok(done.rows_affected())
}

/// Report results nobody has confirmed for [`STALE_AFTER_SECS`] as unknown,
/// e.g. targets a pass never reached. Returns the rows changed.
async fn expire_stale(pool: &Pool<Postgres>) -> anyhow::Result<u64> {
    let done = sqlx::query(
        "UPDATE connections SET health_status = 'unknown'
         WHERE soft_deleted_at IS NULL AND health_status <> 'unknown'
           AND health_checked_at < now() - make_interval(secs => $1)",
    )
    .bind(STALE_AFTER_SECS)
    .execute(pool)
    .await?;
    Ok(done.rows_affected())
}

/// Probe `addr` when a resolver produced one, else let the system resolve `host`.
async fn probe_addr(host: &str, addr: Option<IpAddr>, port: u16) -> &'static str {
    match addr {
        Some(ip) => probe_tcp(&ip.to_string(), port).await,
        None => probe_tcp(host, port).await,
    }
}

/// Attempt a TCP connect to hostname:port with a 5-second timeout.
async fn probe_tcp(hostname: &str, port: u16) -> &'static str {
    let result = if let Ok(ip) = hostname.parse::<IpAddr>() {
        tokio::time::timeout(Duration::from_secs(5), TcpStream::connect((ip, port))).await
    } else {
        tokio::time::timeout(
            Duration::from_secs(5),
            TcpStream::connect(format!("{hostname}:{port}")),
        )
        .await
    };
    match result {
        Ok(Ok(_stream)) => "online",
        _ => "offline",
    }
}

/// Resolve the (host, port) pair to TCP-probe for a `web` connection from
/// its `extra.url`. Falls back to scheme-default ports (443 for `https`,
/// 80 for `http`). Returns `None` when the URL is missing, unparsable, or
/// has no host — callers should record `unknown` in that case rather than
/// misleadingly probing the placeholder VNC port.
fn web_probe_target(url: Option<&str>) -> Option<(String, u16)> {
    let raw = url?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    let host = parsed.host_str()?.to_owned();
    let port = parsed
        .port_or_known_default()
        .or_else(|| match parsed.scheme() {
            "https" => Some(443),
            "http" => Some(80),
            _ => None,
        })?;
    Some((host, port))
}

/// Result of an on-demand probe of a single connection.
#[derive(serde::Serialize, Debug)]
pub struct ProbeOutcome {
    pub id: Uuid,
    pub health_status: String,
    /// TCP connect time; only set when the target answered.
    pub latency_ms: Option<u64>,
    pub health_checked_at: chrono::DateTime<chrono::Utc>,
}

/// Probe one connection now, using the same target rules as the periodic
/// sweep, and store the result. `None` when the connection does not exist.
pub async fn probe_one(pool: &Pool<Postgres>, id: Uuid) -> anyhow::Result<Option<ProbeOutcome>> {
    let target: Option<ConnTarget> = sqlx::query_as(&format!(
        "SELECT {TARGET_COLUMNS} FROM connections WHERE id = $1 AND soft_deleted_at IS NULL"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let Some(t) = target else {
        return Ok(None);
    };

    let dns = crate::services::dns::load(pool).await;
    let (status, latency_ms) = match t.resolve(dns.as_ref()).await {
        Some((host, addr, port)) => timed_probe(&host, addr, port).await,
        None => ("unknown", None),
    };

    let checked_at: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "UPDATE connections SET health_status = $1, health_checked_at = now() \
         WHERE id = $2 RETURNING health_checked_at",
    )
    .bind(status)
    .bind(t.id)
    .fetch_one(pool)
    .await?;

    Ok(Some(ProbeOutcome {
        id: t.id,
        health_status: status.to_owned(),
        latency_ms,
        health_checked_at: checked_at,
    }))
}

async fn timed_probe(host: &str, addr: Option<IpAddr>, port: u16) -> (&'static str, Option<u64>) {
    let started = std::time::Instant::now();
    let status = probe_addr(host, addr, port).await;
    let elapsed = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    (status, (status == "online").then_some(elapsed))
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

    #[tokio::test]
    async fn timed_probe_reports_no_latency_when_offline() {
        let (status, latency) = timed_probe("127.0.0.1", None, 54321).await;
        assert_eq!(status, "offline");
        assert!(latency.is_none());
    }

    #[tokio::test]
    async fn timed_probe_reports_latency_when_online() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (status, latency) = timed_probe("127.0.0.1", None, port).await;
        assert_eq!(status, "online");
        assert!(latency.is_some());
    }

    #[test]
    fn web_probe_target_https_default_port() {
        let (h, p) = web_probe_target(Some("https://example.com/login")).unwrap();
        assert_eq!(h, "example.com");
        assert_eq!(p, 443);
    }

    #[test]
    fn web_probe_target_http_default_port() {
        let (h, p) = web_probe_target(Some("http://example.com/")).unwrap();
        assert_eq!(h, "example.com");
        assert_eq!(p, 80);
    }

    #[test]
    fn web_probe_target_explicit_port() {
        let (h, p) = web_probe_target(Some("https://example.com:8443/app")).unwrap();
        assert_eq!(h, "example.com");
        assert_eq!(p, 8443);
    }

    #[test]
    fn web_probe_target_missing_url() {
        assert!(web_probe_target(None).is_none());
        assert!(web_probe_target(Some("  ")).is_none());
    }

    #[test]
    fn web_probe_target_unparsable() {
        assert!(web_probe_target(Some("not a url")).is_none());
    }

    #[tokio::test]
    async fn an_ipv6_target_is_probed_as_an_address() {
        let listener = tokio::net::TcpListener::bind("[::1]:0").await;
        let Ok(listener) = listener else {
            return; // no IPv6 loopback in this environment
        };
        let port = listener.local_addr().unwrap().port();
        assert_eq!(probe_tcp("::1", port).await, "online");
    }

    #[test]
    fn a_port_out_of_range_has_nothing_to_probe() {
        let t = ConnTarget {
            id: Uuid::nil(),
            protocol: "rdp".into(),
            hostname: "h".into(),
            port: 70_000,
            web_url: None,
        };
        assert!(t.host_port().is_none());
    }

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database. Uses the
    /// real lease row, so it must not run beside a live backend on that database.
    #[tokio::test]
    async fn a_pass_writes_only_changes_and_only_while_it_holds_the_lease() {
        let Some(pool) = std::env::var("TEST_DATABASE_URL")
            .ok()
            .and_then(|url| sqlx::PgPool::connect_lazy(&url).ok())
        else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let tag = Uuid::new_v4().simple().to_string();
        let mut ids = Vec::new();
        for n in 0..2 {
            ids.push(
                sqlx::query_scalar::<_, Uuid>(
                    "INSERT INTO connections (name, protocol, hostname, port)
                     VALUES ($1, 'ssh', 'h', 22) RETURNING id",
                )
                .bind(format!("{tag}-{n}"))
                .fetch_one(&pool)
                .await
                .unwrap(),
            );
        }
        let (a, b) = (ids[0], ids[1]);
        let (holder, other) = (Uuid::new_v4(), Uuid::new_v4());
        sqlx::query("DELETE FROM worker_leases WHERE name = $1")
            .bind(LEASE)
            .execute(&pool)
            .await
            .unwrap();
        assert!(crate::services::worker_lease::try_claim(
            &pool,
            LEASE,
            holder,
            LEASE_TTL,
            MIN_PASS_GAP
        )
        .await
        .unwrap());

        let first = [(a, "online"), (b, "offline")];
        assert_eq!(store_results(&pool, &first, holder).await.unwrap(), 2);
        assert_eq!(store_results(&pool, &first, holder).await.unwrap(), 0);
        let changed = [(a, "online"), (b, "online")];
        assert_eq!(store_results(&pool, &changed, other).await.unwrap(), 0);
        assert_eq!(store_results(&pool, &changed, holder).await.unwrap(), 1);

        sqlx::query(
            "UPDATE connections SET health_checked_at = now() - interval '1 hour' WHERE id = $1",
        )
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
        assert!(expire_stale(&pool).await.unwrap() >= 1);
        let statuses: Vec<(Uuid, String)> =
            sqlx::query_as("SELECT id, health_status FROM connections WHERE id = ANY($1)")
                .bind(&ids)
                .fetch_all(&pool)
                .await
                .unwrap();
        for (id, status) in statuses {
            assert_eq!(status, if id == a { "unknown" } else { "online" });
        }

        crate::services::worker_lease::complete(&pool, LEASE, holder)
            .await
            .unwrap();
        sqlx::query("DELETE FROM connections WHERE id = ANY($1)")
            .bind(&ids)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM worker_leases WHERE name = $1")
            .bind(LEASE)
            .execute(&pool)
            .await
            .unwrap();
    }
}
