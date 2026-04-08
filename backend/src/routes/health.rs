use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::config::DatabaseMode;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::settings;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

pub async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub phase: String,
    pub sso_enabled: bool,
    pub local_auth_enabled: bool,
}

pub async fn status(State(state): State<SharedState>) -> Json<StatusResponse> {
    let s = state.read().await;

    let (sso, local) = if let Some(ref db) = s.db {
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
        (sso, local)
    } else {
        (false, true)
    };

    Json(StatusResponse {
        phase: match s.phase {
            BootPhase::Setup => "setup".into(),
            BootPhase::Running => "running".into(),
        },
        sso_enabled: sso,
        local_auth_enabled: local,
    })
}

/// Service-health response for the admin dashboard.
#[derive(Serialize)]
pub struct ServiceHealth {
    pub database: DatabaseHealth,
    pub guacd: GuacdHealth,
    pub vault: VaultHealth,
}

#[derive(Serialize)]
pub struct DatabaseHealth {
    pub connected: bool,
    pub mode: String,
    /// Sanitized – host:port/dbname only, no credentials
    pub host: String,
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

/// GET /api/admin/health – read-only service health for the admin dashboard.
pub async fn service_health(State(state): State<SharedState>) -> Json<ServiceHealth> {
    let s = state.read().await;

    // ── Database ──
    let db_connected = if let Some(ref db) = s.db {
        crate::db::pool::check(&db.pool).await
    } else {
        false
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

    Json(ServiceHealth {
        database: DatabaseHealth {
            connected: db_connected,
            mode: db_mode,
            host: db_host,
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
    })
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
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["phase"], "running");
        assert_eq!(json["sso_enabled"], true);
        assert_eq!(json["local_auth_enabled"], false);
    }

    #[test]
    fn service_health_serializes() {
        let health = ServiceHealth {
            database: DatabaseHealth {
                connected: true,
                mode: "local".into(),
                host: "localhost:5432/strata".into(),
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
        };
        let json = serde_json::to_value(&health).unwrap();
        assert_eq!(json["database"]["connected"], true);
        assert_eq!(json["guacd"]["port"], 4822);
        assert_eq!(json["vault"]["mode"], "local");
    }

    #[tokio::test]
    async fn check_tcp_unreachable_returns_false() {
        // Connect to a port that's almost certainly not listening
        let result = check_tcp("127.0.0.1", 19999).await;
        assert!(!result);
    }
}
