use axum::extract::State;
use axum::{Extension, Json};
use chrono::{DateTime, NaiveDateTime, Utc};
use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock as TokioRwLock;

use crate::config::DatabaseMode;
use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::av::FailMode as AvFailMode;
use crate::services::middleware::AuthUser;
use crate::services::settings;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

pub async fn health_check() -> Json<HealthResponse> {
    tracing::info!("Health check requested");
    Json(HealthResponse { status: "ok" })
}

#[derive(Serialize)]
pub struct SsoProviderInfo {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub phase: String,
    pub sso_enabled: bool,
    pub local_auth_enabled: bool,
    pub vault_configured: bool,
    pub sso_providers: Vec<SsoProviderInfo>,
    pub version: String,
}

pub async fn status(State(state): State<SharedState>) -> Json<StatusResponse> {
    let s = state.read().await;

    let (sso, local, providers) = if let Some(ref db) = s.db {
        let sso = settings::get(&db.pool, "sso_enabled")
            .await
            .unwrap_or(None)
            .map(|v| v == "true")
            .unwrap_or(false);
        let local = settings::get(&db.pool, "local_auth_enabled")
            .await
            .unwrap_or(None)
            .map(|v| v == "true")
            .unwrap_or(true); // Default to local auth enabled

        let provider_rows: Vec<(uuid::Uuid, String)> =
            sqlx::query_as("SELECT id, name FROM sso_providers ORDER BY created_at ASC")
                .fetch_all(&db.pool)
                .await
                .unwrap_or_default();

        let providers: Vec<SsoProviderInfo> = provider_rows
            .into_iter()
            .map(|(id, name)| SsoProviderInfo {
                id: id.to_string(),
                name,
            })
            .collect();

        (sso, local, providers)
    } else {
        (false, true, vec![])
    };

    let vault_configured = { s.config.as_ref().and_then(|c| c.vault.as_ref()).is_some() };

    Json(StatusResponse {
        phase: match s.phase {
            BootPhase::Setup => "setup".into(),
            BootPhase::Running => "running".into(),
        },
        sso_enabled: sso,
        local_auth_enabled: local,
        vault_configured,
        sso_providers: providers,
        version: env!("STRATA_VERSION").to_string(),
    })
}

/// Service-health response for the admin dashboard.
#[derive(Serialize)]
pub struct ServiceHealth {
    pub version: &'static str,
    pub database: DatabaseHealth,
    pub guacd: GuacdHealth,
    pub vault: VaultHealth,
    pub schema: SchemaHealth,
    pub av: AvHealth,
    pub uptime_secs: u64,
    pub environment: String,
}

#[derive(Serialize)]
pub struct DatabaseHealth {
    pub connected: bool,
    pub mode: String,
    /// Sanitized – host:port/dbname only, no credentials
    pub host: String,
    pub latency_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct GuacdHealth {
    pub reachable: bool,
    pub host: String,
    pub port: u16,
}

#[derive(Serialize)]
pub struct VaultHealth {
    pub configured: bool,
    pub address: String,
    pub mode: String,
}

#[derive(Serialize)]
pub struct SchemaHealth {
    pub status: String,
    pub applied_migrations: i64,
    pub expected_migrations: i64,
}

/// Antivirus scanner health (v1.12.0+).
///
/// `backend` mirrors the boot-time `STRATA_AV_BACKEND` value (`off`,
/// `clamav`, or `command`). `enabled` is `true` whenever the backend
/// is anything other than `off`. For `clamav`, `reachable` is the
/// result of a 2-second TCP probe against the configured clamd
/// address; for `command`, `reachable` mirrors `enabled` (we cannot
/// usefully liveness-probe an exec-driven scanner without invoking
/// the binary, which would have real side-effects); for `off` it is
/// always `false`. `address` is the clamd `host:port` (clamav backend)
/// or the redacted first token of `STRATA_AV_COMMAND` (command
/// backend); `None` for `off`.
///
/// For the `clamav` backend, when the TCP probe succeeds we also send
/// a `VERSION` command to populate `engine_version`, `signatures_version`,
/// and `signatures_built`. Independently, a 6-hour-cached HEAD against
/// `database.clamav.net/daily.cvd` populates `upstream_version` and
/// `upstream_checked_at`; comparing the two yields `status`
/// (`"current"` / `"behind"` / `"unknown"`). All metadata fields are
/// `None` for the `off` and `command` backends.
#[derive(Serialize)]
pub struct AvHealth {
    pub backend: &'static str,
    pub enabled: bool,
    pub reachable: bool,
    pub fail_mode: &'static str,
    pub address: Option<String>,
    /// ClamAV engine version (e.g. `"1.4.1"`). `None` when the backend is
    /// not `clamav` or the version probe failed.
    pub engine_version: Option<String>,
    /// Daily signature DB version currently loaded by clamd (e.g. `27468`).
    pub signatures_version: Option<u32>,
    /// RFC 3339 timestamp of the loaded daily DB's build time.
    pub signatures_built: Option<String>,
    /// Latest published daily DB version from `database.clamav.net`,
    /// cached for 6 hours. `None` until the first successful upstream
    /// check completes (refresh is fired off in the background so the
    /// health endpoint never blocks on it).
    pub upstream_version: Option<u32>,
    /// RFC 3339 timestamp of the last successful upstream fetch.
    pub upstream_checked_at: Option<String>,
    /// `"current"` when `signatures_version >= upstream_version`,
    /// `"behind"` when local is older, `"unknown"` when one side is
    /// missing. `None` when the upstream check has never succeeded.
    pub status: Option<&'static str>,
}

/// GET /api/admin/health – read-only service health for the admin dashboard.
pub async fn service_health(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ServiceHealth>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let s = state.read().await;

    // ── Uptime ──
    let uptime_secs = s.started_at.elapsed().as_secs();

    // ── Environment ──
    let environment = std::env::var("STRATA_ENV")
        .or_else(|_| std::env::var("NODE_ENV"))
        .unwrap_or_else(|_| "production".into());

    // ── Database ──
    let (db_connected, db_latency_ms) = if let Some(ref db) = s.db {
        let start = std::time::Instant::now();
        let ok = crate::db::pool::check(&db.pool).await;
        let latency = if ok {
            Some(start.elapsed().as_millis() as u64)
        } else {
            None
        };
        (ok, latency)
    } else {
        (false, None)
    };

    let (db_mode, db_host) = if let Some(ref cfg) = s.config {
        let mode = match cfg.database_mode {
            DatabaseMode::Local => "local".into(),
            DatabaseMode::External => "external".into(),
        };
        // Sanitize: extract host from URL, strip credentials
        let host = sanitize_db_url(&cfg.database_url);
        (mode, host)
    } else {
        ("unknown".into(), "—".into())
    };

    // ── Schema ──
    let expected_migrations = sqlx::migrate!("./migrations").migrations.len() as i64;
    let (applied_migrations, schema_status) = if let Some(ref db) = s.db {
        let count = crate::services::schema::count_applied_migrations(&db.pool)
            .await
            .unwrap_or(0);
        let status = if count == expected_migrations {
            "in_sync".into()
        } else {
            "out_of_sync".into()
        };
        (count, status)
    } else {
        (0, "unavailable".into())
    };

    // ── guacd ──
    let guacd_host = s
        .config
        .as_ref()
        .and_then(|c| c.guacd_host.clone())
        .unwrap_or_else(|| "guacd".into());
    let guacd_port = s.config.as_ref().and_then(|c| c.guacd_port).unwrap_or(4822);
    let guacd_reachable = check_tcp(&guacd_host, guacd_port).await;

    // ── Vault ──
    let (vault_configured, vault_addr, vault_mode) = if let Some(ref cfg) = s.config {
        if let Some(ref v) = cfg.vault {
            let mode = match v.mode {
                crate::config::VaultMode::Local => "local".to_string(),
                crate::config::VaultMode::External => "external".to_string(),
            };
            (true, v.address.clone(), mode)
        } else {
            (false, String::new(), String::new())
        }
    } else {
        (false, String::new(), String::new())
    };

    // ── Antivirus (v1.12.0+) ──
    let av_backend = s.av_scanner.backend_tag();
    let av_fail_mode = match s.av_fail_mode {
        AvFailMode::Block => "block",
        AvFailMode::Allow => "allow",
    };
    let (av_enabled, av_reachable, av_address) = match av_backend {
        "clamav" => {
            let addr =
                std::env::var("STRATA_AV_CLAMD_ADDR").unwrap_or_else(|_| "clamav:3310".to_string());
            let (host, port) = parse_host_port(&addr, 3310);
            let reachable = check_tcp(&host, port).await;
            (true, reachable, Some(addr))
        }
        "command" => {
            // First whitespace-delimited token only — never echo args /
            // {path} placeholders to the dashboard.
            let cmd = std::env::var("STRATA_AV_COMMAND").unwrap_or_default();
            let display = cmd.split_whitespace().next().unwrap_or("").to_string();
            let enabled = !display.is_empty();
            (enabled, enabled, if enabled { Some(display) } else { None })
        }
        _ => (false, false, None),
    };

    // Metadata probes (clamav-only). The `VERSION` round-trip reuses
    // the same address we just TCP-probed; the upstream lookup is
    // served from a 6-hour cache so the health endpoint never blocks
    // on database.clamav.net (a stale-while-revalidate refresh is
    // fired off in the background when the cache is cold or stale).
    let (av_engine_version, av_signatures_version, av_signatures_built) =
        if av_backend == "clamav" && av_reachable {
            match av_address.as_deref() {
                Some(addr) => match probe_clamd_version(addr, Duration::from_secs(2)).await {
                    Some(v) => (
                        Some(v.engine),
                        Some(v.signatures),
                        Some(v.signatures_built.to_rfc3339()),
                    ),
                    None => (None, None, None),
                },
                None => (None, None, None),
            }
        } else {
            (None, None, None)
        };

    let (av_upstream_version, av_upstream_checked_at, av_status) =
        if av_backend == "clamav" && av_enabled {
            match get_upstream_version_cached().await {
                Some((upstream, checked_at)) => {
                    let status = match av_signatures_version {
                        Some(local) if local >= upstream => "current",
                        Some(_) => "behind",
                        None => "unknown",
                    };
                    (Some(upstream), Some(checked_at.to_rfc3339()), Some(status))
                }
                None => (None, None, None),
            }
        } else {
            (None, None, None)
        };

    Ok(Json(ServiceHealth {
        version: env!("STRATA_VERSION"),
        database: DatabaseHealth {
            connected: db_connected,
            mode: db_mode,
            host: db_host,
            latency_ms: db_latency_ms,
        },
        guacd: GuacdHealth {
            reachable: guacd_reachable,
            host: guacd_host,
            port: guacd_port,
        },
        vault: VaultHealth {
            configured: vault_configured,
            address: vault_addr,
            mode: vault_mode,
        },
        schema: SchemaHealth {
            status: schema_status,
            applied_migrations,
            expected_migrations,
        },
        av: AvHealth {
            backend: av_backend,
            enabled: av_enabled,
            reachable: av_reachable,
            fail_mode: av_fail_mode,
            address: av_address,
            engine_version: av_engine_version,
            signatures_version: av_signatures_version,
            signatures_built: av_signatures_built,
            upstream_version: av_upstream_version,
            upstream_checked_at: av_upstream_checked_at,
            status: av_status,
        },
        uptime_secs,
        environment,
    }))
}

/// Split `host:port` into its parts, falling back to `default_port` if
/// the port is missing or unparseable. Bracketed IPv6 literals are not
/// stripped — the dashboard renders the raw configured value.
fn parse_host_port(addr: &str, default_port: u16) -> (String, u16) {
    match addr.rsplit_once(':') {
        Some((host, port_str)) => match port_str.parse::<u16>() {
            Ok(port) => (host.to_string(), port),
            Err(_) => (addr.to_string(), default_port),
        },
        None => (addr.to_string(), default_port),
    }
}

/// Strip credentials from a postgres URL, returning host:port/dbname.
fn sanitize_db_url(url: &str) -> String {
    // postgresql://user:pass@host:port/db -> host:port/db
    if let Some(at) = url.rfind('@') {
        url[at + 1..].to_string()
    } else {
        url.to_string()
    }
}

/// Quick TCP connectivity check (non-blocking, 2s timeout).
async fn check_tcp(host: &str, port: u16) -> bool {
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(format!("{host}:{port}")),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

// ── ClamAV metadata helpers (v1.12.0+) ──

/// Parsed `VERSION` reply from clamd.
///
/// Wire format is a single line like
/// `ClamAV 1.4.1/27468/Tue Jun  3 09:18:33 2026` — engine version,
/// daily.cvd version number, and the build timestamp of the loaded
/// signature DB.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClamdVersion {
    engine: String,
    signatures: u32,
    signatures_built: DateTime<Utc>,
}

fn parse_clamd_version_line(line: &str) -> Option<ClamdVersion> {
    let mut parts = line.splitn(3, '/');
    let header = parts.next()?;
    let sigs = parts.next()?.trim();
    let date = parts.next()?.trim();

    let engine = header.trim().strip_prefix("ClamAV")?.trim().to_string();
    if engine.is_empty() {
        return None;
    }
    let signatures = sigs.parse::<u32>().ok()?;
    // clamd's date is `Day Mon DD HH:MM:SS YYYY`. Single-digit days
    // are space-padded (`Jun  3`), which chrono's `%e` does not
    // strip cleanly when preceded by the literal space in our format
    // string — collapse all runs of whitespace to single spaces and
    // parse with `%d` so the same format works for both 1- and
    // 2-digit days.
    let date_normalized: String = date.split_whitespace().collect::<Vec<_>>().join(" ");
    let naive = NaiveDateTime::parse_from_str(&date_normalized, "%a %b %d %H:%M:%S %Y").ok()?;
    Some(ClamdVersion {
        engine,
        signatures,
        signatures_built: DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc),
    })
}

/// Send `zVERSION\0` to clamd and parse the reply. Returns `None` on
/// any I/O error, timeout, or unparseable response — the dashboard
/// degrades to showing just `Backend: ClamAV` without the version row.
async fn probe_clamd_version(addr: &str, timeout: Duration) -> Option<ClamdVersion> {
    let fut = async {
        let mut stream = tokio::net::TcpStream::connect(addr).await.ok()?;
        stream.write_all(b"zVERSION\0").await.ok()?;
        let mut buf = Vec::with_capacity(256);
        stream.read_to_end(&mut buf).await.ok()?;
        let text = String::from_utf8_lossy(&buf);
        let line = text.trim_end_matches('\0').trim();
        parse_clamd_version_line(line)
    };
    tokio::time::timeout(timeout, fut).await.ok().flatten()
}

/// Parse the version field out of a CVD header.
///
/// CVD files begin with a 512-byte ASCII header:
/// `ClamAV-VDB:Day Mon DD HH:MM:SS YYYY:VERSION:NUMSIGS:FLEVEL:MD5:BUILDER:BUILDTIME:`
/// followed by space padding. We only care about field index 2 (version).
fn parse_cvd_header_version(header: &str) -> Option<u32> {
    let mut parts = header.split(':');
    if parts.next()? != "ClamAV-VDB" {
        return None;
    }
    let _date = parts.next()?;
    parts.next()?.trim().parse::<u32>().ok()
}

/// Range-fetch the first 512 bytes of `daily.cvd` from the public
/// ClamAV mirror and return the published version number. Uses the
/// shared `default_client()` (30s overall / 5s connect). Returns
/// `None` on any network or parse error — callers treat that as
/// “we don't know what the latest version is right now” and skip
/// the up-to-date comparison.
async fn fetch_upstream_daily_version() -> Option<u32> {
    let client = crate::services::http_client::default_client();
    let resp = client
        .get("https://database.clamav.net/daily.cvd")
        .header("Range", "bytes=0-511")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    let header_slice = &bytes[..bytes.len().min(512)];
    let header = std::str::from_utf8(header_slice).ok()?;
    parse_cvd_header_version(header)
}

/// 6 h TTL — clamav.net publishes daily DB updates a few times per
/// day during active threat windows; checking more often than every
/// 6 h yields no useful operator signal and wastes bandwidth.
const UPSTREAM_CACHE_TTL_SECS: i64 = 6 * 60 * 60;

/// Cached `(version, fetched_at)` pair from the public ClamAV mirror,
/// or `None` while the first probe is still in flight.
type UpstreamCache = Option<(u32, DateTime<Utc>)>;

static UPSTREAM_CACHE: OnceLock<TokioRwLock<UpstreamCache>> = OnceLock::new();

fn upstream_cache() -> &'static TokioRwLock<UpstreamCache> {
    UPSTREAM_CACHE.get_or_init(|| TokioRwLock::new(None))
}

/// Stale-while-revalidate read of the upstream version cache.
///
/// - Cache fresh (< 6 h)  → return cached value, no network.
/// - Cache stale or cold  → spawn a background refresh task and
///   return whatever is currently cached (possibly `None`).
///
/// The health endpoint thus never blocks on the upstream HTTP call.
/// The very first call after boot returns `None`; a few seconds
/// later the cache is warm and subsequent calls return the value.
async fn get_upstream_version_cached() -> Option<(u32, DateTime<Utc>)> {
    let snapshot = *upstream_cache().read().await;
    let needs_refresh = match snapshot {
        Some((_, fetched)) => (Utc::now() - fetched).num_seconds() > UPSTREAM_CACHE_TTL_SECS,
        None => true,
    };
    if needs_refresh {
        tokio::spawn(async {
            if let Some(v) = fetch_upstream_daily_version().await {
                *upstream_cache().write().await = Some((v, Utc::now()));
            }
        });
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_db_url_strips_credentials() {
        let url = "postgresql://admin:s3cret@db.example.com:5432/strata";
        assert_eq!(sanitize_db_url(url), "db.example.com:5432/strata");
    }

    #[test]
    fn sanitize_db_url_no_credentials() {
        let url = "db.example.com:5432/strata";
        assert_eq!(sanitize_db_url(url), url);
    }

    #[test]
    fn sanitize_db_url_at_sign_in_password() {
        let url = "postgresql://user:p%40ss@host:5432/db";
        // rfind('@') finds the last @, which is the delimiter
        assert_eq!(sanitize_db_url(url), "host:5432/db");
    }

    #[test]
    fn health_response_serializes() {
        let resp = HealthResponse { status: "ok" };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["status"], "ok");
    }

    #[test]
    fn status_response_serializes() {
        let resp = StatusResponse {
            phase: "running".into(),
            sso_enabled: true,
            local_auth_enabled: false,
            vault_configured: true,
            sso_providers: vec![],
            version: "1.9.3".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["phase"], "running");
        assert_eq!(json["sso_enabled"], true);
        assert_eq!(json["local_auth_enabled"], false);
    }

    #[test]
    fn service_health_serializes() {
        let health = ServiceHealth {
            version: "0.11.2",
            database: DatabaseHealth {
                connected: true,
                mode: "local".into(),
                host: "localhost:5432/strata".into(),
                latency_ms: Some(5),
            },
            guacd: GuacdHealth {
                reachable: false,
                host: "guacd".into(),
                port: 4822,
            },
            vault: VaultHealth {
                configured: true,
                address: "http://vault:8200".into(),
                mode: "local".into(),
            },
            schema: SchemaHealth {
                status: "in_sync".into(),
                applied_migrations: 28,
                expected_migrations: 28,
            },
            av: AvHealth {
                backend: "off",
                enabled: false,
                reachable: false,
                fail_mode: "block",
                address: None,
                engine_version: None,
                signatures_version: None,
                signatures_built: None,
                upstream_version: None,
                upstream_checked_at: None,
                status: None,
            },
            uptime_secs: 3600,
            environment: "production".into(),
        };
        let json = serde_json::to_value(&health).unwrap();
        assert_eq!(json["database"]["connected"], true);
        assert_eq!(json["database"]["latency_ms"], 5);
        assert_eq!(json["guacd"]["port"], 4822);
        assert_eq!(json["vault"]["mode"], "local");
        assert_eq!(json["schema"]["status"], "in_sync");
        assert_eq!(json["av"]["backend"], "off");
        assert_eq!(json["av"]["enabled"], false);
        assert_eq!(json["av"]["fail_mode"], "block");
        assert_eq!(json["av"]["signatures_version"], serde_json::Value::Null);
        assert_eq!(json["av"]["status"], serde_json::Value::Null);
        assert_eq!(json["uptime_secs"], 3600);
        assert_eq!(json["environment"], "production");
    }

    #[test]
    fn parse_host_port_splits_clamav_default() {
        assert_eq!(
            parse_host_port("clamav:3310", 3310),
            ("clamav".to_string(), 3310)
        );
    }

    #[test]
    fn parse_host_port_falls_back_when_no_port() {
        assert_eq!(
            parse_host_port("clamav", 3310),
            ("clamav".to_string(), 3310)
        );
    }

    #[test]
    fn parse_host_port_falls_back_when_port_unparseable() {
        assert_eq!(
            parse_host_port("clamav:not-a-number", 3310),
            ("clamav:not-a-number".to_string(), 3310)
        );
    }

    #[tokio::test]
    async fn check_tcp_unreachable_returns_false() {
        // Connect to a port that's almost certainly not listening
        let result = check_tcp("127.0.0.1", 19999).await;
        assert!(!result);
    }

    #[test]
    fn parse_clamd_version_line_typical_reply() {
        // Jun 3 2026 is a Wednesday — chrono's %a validates the weekday
        // strictly, so the fixture must match the real calendar.
        let line = "ClamAV 1.4.1/27468/Wed Jun  3 09:18:33 2026";
        let v = parse_clamd_version_line(line).expect("must parse");
        assert_eq!(v.engine, "1.4.1");
        assert_eq!(v.signatures, 27468);
        // 2026-06-03T09:18:33Z
        assert_eq!(v.signatures_built.to_rfc3339(), "2026-06-03T09:18:33+00:00");
    }

    #[test]
    fn parse_clamd_version_line_double_digit_day() {
        let line = "ClamAV 1.0.5/27500/Mon Dec 15 11:00:00 2025";
        let v = parse_clamd_version_line(line).expect("must parse");
        assert_eq!(v.signatures, 27500);
        assert_eq!(v.signatures_built.to_rfc3339(), "2025-12-15T11:00:00+00:00");
    }

    #[test]
    fn parse_clamd_version_line_rejects_garbage() {
        assert!(parse_clamd_version_line("PONG").is_none());
        assert!(parse_clamd_version_line("ClamAV-no-slashes").is_none());
        assert!(parse_clamd_version_line("ClamAV 1/notanumber/Tue Jun 3 09:18:33 2026").is_none());
        assert!(parse_clamd_version_line("ClamAV /27468/Tue Jun 3 09:18:33 2026").is_none());
    }

    #[test]
    fn parse_cvd_header_version_extracts_field_2() {
        // Real CVD headers use HYPHENS in the time component
        // (`06-25` not `06:25`) precisely so colon-splitting works.
        let header =
            "ClamAV-VDB:Tue Jun  3 09-18-33 2026:27500:5400000:90:abcdef0123:builder:1717405113:";
        assert_eq!(parse_cvd_header_version(header), Some(27500));
    }

    #[test]
    fn parse_cvd_header_version_rejects_wrong_tag() {
        let header = "NotACVD:Tue Jun  3 09-18-33 2026:27500:5400000:90:abc:b:1:";
        assert_eq!(parse_cvd_header_version(header), None);
    }

    #[test]
    fn parse_cvd_header_version_rejects_non_numeric() {
        let header = "ClamAV-VDB:Tue Jun  3 09-18-33 2026:not-a-number:5400000:90:abc:b:1:";
        assert_eq!(parse_cvd_header_version(header), None);
    }

    #[test]
    fn sanitize_db_url_complex_password() {
        let url = "postgresql://admin:p%40ss%23w0rd@db.host:5432/mydb";
        assert_eq!(sanitize_db_url(url), "db.host:5432/mydb");
    }

    #[test]
    fn sanitize_db_url_empty_string() {
        assert_eq!(sanitize_db_url(""), "");
    }

    #[test]
    fn sanitize_db_url_just_host() {
        assert_eq!(sanitize_db_url("localhost"), "localhost");
    }

    #[test]
    fn health_response_debug_status() {
        let resp = HealthResponse { status: "ok" };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("ok"));
    }

    #[test]
    fn database_health_serializes() {
        let h = DatabaseHealth {
            connected: false,
            mode: "external".into(),
            host: "remote:5432/db".into(),
            latency_ms: None,
        };
        let json = serde_json::to_value(&h).unwrap();
        assert_eq!(json["connected"], false);
        assert_eq!(json["mode"], "external");
        assert_eq!(json["host"], "remote:5432/db");
    }

    #[test]
    fn guacd_health_serializes() {
        let h = GuacdHealth {
            reachable: true,
            host: "guacd".into(),
            port: 4822,
        };
        let json = serde_json::to_value(&h).unwrap();
        assert_eq!(json["reachable"], true);
        assert_eq!(json["host"], "guacd");
    }

    #[test]
    fn vault_health_serializes() {
        let h = VaultHealth {
            configured: false,
            address: String::new(),
            mode: String::new(),
        };
        let json = serde_json::to_value(&h).unwrap();
        assert_eq!(json["configured"], false);
    }

    #[test]
    fn status_response_setup_phase() {
        let resp = StatusResponse {
            phase: "setup".into(),
            sso_enabled: false,
            local_auth_enabled: true,
            vault_configured: false,
            sso_providers: vec![],
            version: "1.9.3".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["phase"], "setup");
        assert_eq!(json["sso_enabled"], false);
        assert_eq!(json["local_auth_enabled"], true);
    }

    #[tokio::test]
    async fn health_check_returns_ok() {
        let result = health_check().await;
        assert_eq!(result.status, "ok");
    }

    #[tokio::test]
    async fn status_in_setup_phase() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let state: SharedState = Arc::new(RwLock::new(crate::services::app_state::AppState {
            phase: BootPhase::Setup,
            config: None,
            db: None,
            session_registry: crate::services::session_registry::SessionRegistry::new(),
            guacd_pool: None,
            file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                "/tmp/strata-files",
            ))
            .await,
            web_displays: std::sync::Arc::new(
                crate::services::web_session::WebDisplayAllocator::new(),
            ),
            web_runtime: std::sync::Arc::new(
                crate::services::web_runtime::WebRuntimeRegistry::new(std::sync::Arc::new(
                    crate::services::web_session::WebDisplayAllocator::new(),
                )),
            ),
            vdi_driver: std::sync::Arc::new(crate::services::vdi::NoopVdiDriver),
            dmz_link_registry: None,
            av_scanner: std::sync::Arc::new(crate::services::av::OffScanner),
            av_fail_mode: crate::services::av::FailMode::Block,
            started_at: std::time::Instant::now(),
        }));
        let result = status(axum::extract::State(state)).await;
        assert_eq!(result.phase, "setup");
        assert!(!result.sso_enabled);
        assert!(result.local_auth_enabled);
    }

    fn admin_user() -> crate::services::middleware::AuthUser {
        crate::services::middleware::AuthUser {
            id: uuid::Uuid::nil(),
            sub: "test".into(),
            username: "admin".into(),
            full_name: None,
            role: "admin".into(),
            can_manage_system: true,
            can_manage_users: false,
            can_manage_connections: false,
            can_view_audit_logs: false,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_sharing_profiles: false,
            can_view_sessions: false,
            can_use_quick_share: false,
            can_use_quick_share_outbound: false,
        }
    }

    #[tokio::test]
    async fn service_health_no_config_no_db() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let state: SharedState = Arc::new(RwLock::new(crate::services::app_state::AppState {
            phase: BootPhase::Setup,
            config: None,
            db: None,
            session_registry: crate::services::session_registry::SessionRegistry::new(),
            guacd_pool: None,
            file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                "/tmp/strata-files",
            ))
            .await,
            web_displays: std::sync::Arc::new(
                crate::services::web_session::WebDisplayAllocator::new(),
            ),
            web_runtime: std::sync::Arc::new(
                crate::services::web_runtime::WebRuntimeRegistry::new(std::sync::Arc::new(
                    crate::services::web_session::WebDisplayAllocator::new(),
                )),
            ),
            vdi_driver: std::sync::Arc::new(crate::services::vdi::NoopVdiDriver),
            dmz_link_registry: None,
            av_scanner: std::sync::Arc::new(crate::services::av::OffScanner),
            av_fail_mode: crate::services::av::FailMode::Block,
            started_at: std::time::Instant::now(),
        }));
        let axum::Json(result) =
            service_health(axum::extract::State(state), axum::Extension(admin_user()))
                .await
                .expect("service_health");
        assert!(!result.database.connected);
        assert_eq!(result.database.mode, "unknown");
        assert_eq!(result.database.host, "—");
        assert!(result.database.latency_ms.is_none());
        assert_eq!(result.guacd.host, "guacd");
        assert_eq!(result.guacd.port, 4822);
        assert!(!result.guacd.reachable);
        assert!(!result.vault.configured);
        assert_eq!(result.schema.status, "unavailable");
        assert_eq!(result.environment, "production");
    }

    #[tokio::test]
    async fn service_health_with_config_no_vault() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let cfg = crate::config::AppConfig {
            database_url: "postgresql://user:pass@dbhost:5432/testdb".into(),
            database_mode: crate::config::DatabaseMode::External,
            database_ssl_mode: None,
            database_ca_cert: None,
            vault: None,
            guacd_host: Some("my-guacd".into()),
            guacd_port: Some(9999),
            guacd_instances: vec![],
            jwt_secret: None,
        };
        let state: SharedState = Arc::new(RwLock::new(crate::services::app_state::AppState {
            phase: BootPhase::Running,
            config: Some(cfg),
            db: None,
            session_registry: crate::services::session_registry::SessionRegistry::new(),
            guacd_pool: None,
            file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                "/tmp/strata-files",
            ))
            .await,
            web_displays: std::sync::Arc::new(
                crate::services::web_session::WebDisplayAllocator::new(),
            ),
            web_runtime: std::sync::Arc::new(
                crate::services::web_runtime::WebRuntimeRegistry::new(std::sync::Arc::new(
                    crate::services::web_session::WebDisplayAllocator::new(),
                )),
            ),
            vdi_driver: std::sync::Arc::new(crate::services::vdi::NoopVdiDriver),
            dmz_link_registry: None,
            av_scanner: std::sync::Arc::new(crate::services::av::OffScanner),
            av_fail_mode: crate::services::av::FailMode::Block,
            started_at: std::time::Instant::now(),
        }));
        let axum::Json(result) =
            service_health(axum::extract::State(state), axum::Extension(admin_user()))
                .await
                .expect("service_health");
        assert!(!result.database.connected);
        assert_eq!(result.database.mode, "external");
        assert_eq!(result.database.host, "dbhost:5432/testdb");
        assert_eq!(result.guacd.host, "my-guacd");
        assert_eq!(result.guacd.port, 9999);
        assert!(!result.vault.configured);
    }

    #[tokio::test]
    async fn service_health_with_local_vault() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let cfg = crate::config::AppConfig {
            database_url: "postgresql://u:p@host:5432/db".into(),
            database_mode: crate::config::DatabaseMode::Local,
            database_ssl_mode: None,
            database_ca_cert: None,
            vault: Some(crate::config::VaultConfig {
                address: "http://vault:8200".into(),
                token: String::new(),
                transit_key: "strata".into(),
                mode: crate::config::VaultMode::Local,
                unseal_key: None,
            }),
            guacd_host: None,
            guacd_port: None,
            guacd_instances: vec![],
            jwt_secret: None,
        };
        let state: SharedState = Arc::new(RwLock::new(crate::services::app_state::AppState {
            phase: BootPhase::Running,
            config: Some(cfg),
            db: None,
            session_registry: crate::services::session_registry::SessionRegistry::new(),
            guacd_pool: None,
            file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                "/tmp/strata-files",
            ))
            .await,
            web_displays: std::sync::Arc::new(
                crate::services::web_session::WebDisplayAllocator::new(),
            ),
            web_runtime: std::sync::Arc::new(
                crate::services::web_runtime::WebRuntimeRegistry::new(std::sync::Arc::new(
                    crate::services::web_session::WebDisplayAllocator::new(),
                )),
            ),
            vdi_driver: std::sync::Arc::new(crate::services::vdi::NoopVdiDriver),
            dmz_link_registry: None,
            av_scanner: std::sync::Arc::new(crate::services::av::OffScanner),
            av_fail_mode: crate::services::av::FailMode::Block,
            started_at: std::time::Instant::now(),
        }));
        let axum::Json(result) =
            service_health(axum::extract::State(state), axum::Extension(admin_user()))
                .await
                .expect("service_health");
        assert_eq!(result.database.mode, "local");
        assert_eq!(result.database.host, "host:5432/db");
        assert!(result.vault.configured);
        assert_eq!(result.vault.address, "http://vault:8200");
        assert_eq!(result.vault.mode, "local");
        // Default guacd values
        assert_eq!(result.guacd.host, "guacd");
        assert_eq!(result.guacd.port, 4822);
    }
}
