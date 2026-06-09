use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::config::DatabaseMode;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::av::FailMode as AvFailMode;
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
#[derive(Serialize)]
pub struct AvHealth {
    pub backend: &'static str,
    pub enabled: bool,
    pub reachable: bool,
    pub fail_mode: &'static str,
    pub address: Option<String>,
}

/// GET /api/admin/health – read-only service health for the admin dashboard.
pub async fn service_health(State(state): State<SharedState>) -> Json<ServiceHealth> {
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
    let av_backend = s.av_scanner.backend_name();
    let av_fail_mode = match s.av_fail_mode {
        AvFailMode::Block => "block",
        AvFailMode::Allow => "allow",
    };
    let (av_enabled, av_reachable, av_address) = match av_backend {
        "clamav" => {
            let addr = std::env::var("STRATA_AV_CLAMD_ADDR")
                .unwrap_or_else(|_| "clamav:3310".to_string());
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

    Json(ServiceHealth {
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
        },
        uptime_secs,
        environment,
    })
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
        let axum::Json(result) = service_health(axum::extract::State(state)).await;
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
        let axum::Json(result) = service_health(axum::extract::State(state)).await;
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
        let axum::Json(result) = service_health(axum::extract::State(state)).await;
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
