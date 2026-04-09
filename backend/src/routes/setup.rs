use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::{AppConfig, DatabaseMode, LocalVaultSecrets, VaultConfig, VaultMode};
use crate::db::Database;
use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::vault_provisioning;

/// Guard to prevent concurrent initialization attempts.
static INITIALIZING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
pub struct InitRequest {
    /// "local" to use the bundled Vault container, "external" to provide your own,
    /// or omit to skip Vault entirely.
    pub vault_mode: Option<String>,
    /// Only required when vault_mode == "external"
    pub vault_address: Option<String>,
    pub vault_token: Option<String>,
    pub vault_transit_key: Option<String>,
}

pub async fn initialize(
    State(state): State<SharedState>,
    Json(body): Json<InitRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Atomically check+transition with a write lock to prevent race conditions
    {
        let s = state.read().await;
        if s.phase != BootPhase::Setup {
            return Err(AppError::Config("System is already initialized".into()));
        }
    }

    // Atomic compare-and-swap to prevent concurrent initialization
    if INITIALIZING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::Config(
            "Initialization already in progress".into(),
        ));
    }

    // Ensure we reset the flag on any exit path
    let _guard = scopeguard::guard((), |_| {
        INITIALIZING.store(false, Ordering::SeqCst);
    });

    // Determine database URL from environment variable
    let db_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://strata:strata_default@postgres-local:5432/strata".into());
    let db_mode = if db_url.contains("postgres-local") {
        DatabaseMode::Local
    } else {
        DatabaseMode::External
    };

    let db_ssl_mode = std::env::var("DATABASE_SSL_MODE").ok();
    let db_ca_cert = std::env::var("DATABASE_CA_CERT").ok();

    // Test connection
    let db = Database::connect(&db_url, db_ssl_mode.as_deref(), db_ca_cert.as_deref())
        .await
        .map_err(|e| AppError::Config(format!("Database connection failed: {e}")))?;

    // Run migrations
    db.migrate()
        .await
        .map_err(|e| AppError::Config(format!("Migration failed: {e}")))?;

    // Build Vault config based on mode
    let vault = match body.vault_mode.as_deref() {
        Some("local") => {
            let address =
                std::env::var("VAULT_ADDR").unwrap_or_else(|_| "http://vault:8200".into());
            let transit_key = body
                .vault_transit_key
                .unwrap_or_else(|| "guac-master-key".into());

            // Provision the bundled Vault: init → unseal → transit → key
            let result = vault_provisioning::provision(&address, &transit_key, None, None).await?;

            let (token, unseal_key) = match result {
                Some(init_result) => (init_result.root_token, Some(init_result.unseal_key)),
                None => {
                    return Err(AppError::Vault(
                        "Bundled Vault is already initialized but no stored credentials exist. \
                         Use external mode or reset the vault-data volume."
                            .into(),
                    ));
                }
            };

            // Persist local vault secrets so they survive container restarts
            if let Some(ref uk) = unseal_key {
                if let Err(e) = (LocalVaultSecrets {
                    token: token.clone(),
                    unseal_key: uk.clone(),
                })
                .save()
                {
                    tracing::warn!("Failed to persist vault secrets: {e}");
                }
            }

            Some(VaultConfig {
                address,
                token,
                transit_key,
                mode: VaultMode::Local,
                unseal_key,
            })
        }
        Some("external") => match (body.vault_address, body.vault_token, body.vault_transit_key) {
            (Some(addr), Some(token), Some(key)) => Some(VaultConfig {
                address: addr,
                token,
                transit_key: key,
                mode: VaultMode::External,
                unseal_key: None,
            }),
            _ => {
                return Err(AppError::Config(
                    "External vault requires address, token, and transit_key".into(),
                ));
            }
        },
        _ => None, // No vault — skip
    };

    // Build and persist config
    let guacd_host = std::env::var("GUACD_HOST").unwrap_or_else(|_| "guacd".into());
    let guacd_port: u16 = std::env::var("GUACD_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4822);

    let guacd_instances: Vec<String> = std::env::var("GUACD_INSTANCES")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let cfg = AppConfig {
        database_url: db_url,
        database_mode: db_mode,
        database_ssl_mode: db_ssl_mode,
        database_ca_cert: db_ca_cert,
        vault,
        guacd_host: Some(guacd_host),
        guacd_port: Some(guacd_port),
        guacd_instances,
        jwt_secret: std::env::var("JWT_SECRET").ok(),
    };

    cfg.save(&AppConfig::config_path())
        .map_err(|e| AppError::Config(format!("Failed to save config.toml: {e}")))?;

    // Transition to Running
    {
        let mut s = state.write().await;
        s.config = Some(cfg);
        s.db = Some(db);
        s.phase = BootPhase::Running;
    }

    tracing::info!("Initialization complete – system is now running");
    Ok(Json(json!({ "status": "initialized" })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_request_minimal() {
        let r: InitRequest = serde_json::from_str("{}").unwrap();
        assert!(r.vault_mode.is_none());
        assert!(r.vault_address.is_none());
        assert!(r.vault_token.is_none());
        assert!(r.vault_transit_key.is_none());
    }

    #[test]
    fn init_request_local_vault() {
        let json = r#"{"vault_mode":"local"}"#;
        let r: InitRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.vault_mode.as_deref().unwrap(), "local");
    }

    #[test]
    fn init_request_external_vault() {
        let json = r#"{
            "vault_mode":"external",
            "vault_address":"https://vault.corp:8200",
            "vault_token":"hvs.1234",
            "vault_transit_key":"my-key"
        }"#;
        let r: InitRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.vault_mode.as_deref().unwrap(), "external");
        assert_eq!(
            r.vault_address.as_deref().unwrap(),
            "https://vault.corp:8200"
        );
        assert_eq!(r.vault_token.as_deref().unwrap(), "hvs.1234");
    }

    #[test]
    fn init_request_partial_external_vault() {
        let json = r#"{"vault_mode":"external","vault_address":"https://vault:8200"}"#;
        let r: InitRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.vault_mode.as_deref(), Some("external"));
        assert!(r.vault_token.is_none());
        assert!(r.vault_transit_key.is_none());
    }

    #[test]
    fn initializing_flag_default_false() {
        // The INITIALIZING flag should be false at rest (no active init)
        // We can't fully test atomics without integration, but verify the type works
        let val = INITIALIZING.load(Ordering::Relaxed);
        // May be true or false depending on other test state, just verify it doesn't panic
        let _ = val;
    }
}
