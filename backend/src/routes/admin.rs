use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::{audit, kerberos, settings};

// ── Helpers ────────────────────────────────────────────────────────────

async fn require_running(state: &SharedState) -> Result<crate::db::Database, AppError> {
    let s = state.read().await;
    if s.phase != BootPhase::Running {
        return Err(AppError::SetupRequired);
    }
    s.db.clone().ok_or(AppError::SetupRequired)
}

/// Validate that a string looks like a safe hostname/realm (prevent injection in krb5.conf).
fn is_safe_hostname(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == ':' || c == '_')
}

// ── Settings ───────────────────────────────────────────────────────────

/// Settings keys whose values must be redacted from API responses.
const SENSITIVE_SETTINGS: &[&str] = &[
    "sso_client_secret",
    "ad_bind_password",
    "azure_storage_access_key",
    "vault_token",
    "vault_unseal_key",
];

pub async fn get_settings(
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let all = settings::get_all(&db.pool).await?;
    let map: serde_json::Map<String, serde_json::Value> = all
        .into_iter()
        .map(|(k, v)| {
            if SENSITIVE_SETTINGS.iter().any(|s| k.contains(s)) {
                (k, serde_json::Value::String("********".into()))
            } else {
                (k, serde_json::Value::String(v))
            }
        })
        .collect();
    Ok(Json(serde_json::Value::Object(map)))
}

#[derive(Deserialize)]
pub struct SettingsUpdateRequest {
    pub settings: Vec<SettingKV>,
}

#[derive(Deserialize)]
pub struct SettingKV {
    pub key: String,
    pub value: String,
}

/// Settings keys that cannot be updated via the generic settings endpoint.
/// These must be updated through their dedicated endpoints (SSO, Kerberos, Vault, etc).
const RESTRICTED_SETTINGS: &[&str] = &[
    "jwt_secret",
    "sso_client_secret",
    "sso_issuer_url",
    "sso_client_id",
    "sso_enabled",
    "ad_bind_password",
    "vault_token",
    "vault_unseal_key",
    "kerberos_realm",
    "kerberos_kdc",
    "kerberos_admin_server",
    "local_auth_enabled",
];

pub async fn update_settings(
    State(state): State<SharedState>,
    Json(body): Json<SettingsUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Block restricted keys — must use dedicated endpoints
    for kv in &body.settings {
        if RESTRICTED_SETTINGS.iter().any(|r| kv.key == *r) {
            return Err(AppError::Validation(format!(
                "Setting '{}' cannot be updated through this endpoint",
                kv.key
            )));
        }
    }

    for kv in &body.settings {
        settings::set(&db.pool, &kv.key, &kv.value).await?;
    }
    audit::log(
        &db.pool,
        None,
        "settings.updated",
        &json!({ "count": body.settings.len() }),
    )
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

// ── SSO ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SsoUpdateRequest {
    pub issuer_url: String,
    pub client_id: String,
    pub client_secret: String,
}

pub async fn update_sso(
    State(state): State<SharedState>,
    Json(body): Json<SsoUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Validate issuer URL uses HTTPS
    if !body.issuer_url.starts_with("https://") {
        return Err(AppError::Validation(
            "SSO issuer URL must use HTTPS".into(),
        ));
    }

    settings::set(&db.pool, "sso_enabled", "true").await?;
    settings::set(&db.pool, "sso_issuer_url", &body.issuer_url).await?;
    settings::set(&db.pool, "sso_client_id", &body.client_id).await?;

    // Encrypt client secret before storing — require Vault
    let vault_cfg = {
        let s = state.read().await;
        s.config.as_ref().and_then(|c| c.vault.clone())
    };
    if let Some(ref vc) = vault_cfg {
        let sealed = crate::services::vault::seal(vc, body.client_secret.as_bytes())
            .await
            .map_err(|e| AppError::Vault(format!("Failed to encrypt SSO secret: {e}")))?;
        use base64::Engine;
        let encoded = serde_json::json!({
            "ct": base64::engine::general_purpose::STANDARD.encode(&sealed.ciphertext),
            "dek": base64::engine::general_purpose::STANDARD.encode(&sealed.encrypted_dek),
            "n": base64::engine::general_purpose::STANDARD.encode(&sealed.nonce),
        });
        settings::set(
            &db.pool,
            "sso_client_secret",
            &format!("vault:{}", encoded.to_string()),
        )
        .await?;
    } else {
        return Err(AppError::Config(
            "Vault must be configured before enabling SSO. Client secrets require encrypted storage.".into(),
        ));
    }

    audit::log(&db.pool, None, "sso.configured", &json!({})).await?;
    Ok(Json(json!({ "status": "sso_updated" })))
}

// ── Auth Methods ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AuthMethodsUpdateRequest {
    pub sso_enabled: bool,
    pub local_auth_enabled: bool,
}

pub async fn update_auth_methods(
    State(state): State<SharedState>,
    Json(body): Json<AuthMethodsUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Ensure at least one method is enabled
    if !body.sso_enabled && !body.local_auth_enabled {
        return Err(AppError::Validation(
            "At least one authentication method must be enabled.".into(),
        ));
    }

    // If enabling SSO, verify it has been configured (issuer_url and client_id exist)
    if body.sso_enabled {
        let issuer = settings::get(&db.pool, "sso_issuer_url")
            .await?
            .unwrap_or_default();
        let client_id = settings::get(&db.pool, "sso_client_id")
            .await?
            .unwrap_or_default();
        if issuer.is_empty() || client_id.is_empty() {
            return Err(AppError::Validation(
                "SSO cannot be enabled until it is configured in the SSO tab.".into(),
            ));
        }
    }

    settings::set(
        &db.pool,
        "sso_enabled",
        if body.sso_enabled { "true" } else { "false" },
    )
    .await?;
    settings::set(
        &db.pool,
        "local_auth_enabled",
        if body.local_auth_enabled {
            "true"
        } else {
            "false"
        },
    )
    .await?;

    audit::log(
        &db.pool,
        None,
        "settings.auth_methods_updated",
        &json!({
            "sso_enabled": body.sso_enabled,
            "local_auth_enabled": body.local_auth_enabled
        }),
    )
    .await?;

    Ok(Json(json!({ "status": "updated" })))
}

// ── Vault ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct VaultUpdateRequest {
    /// "local" or "external"
    pub mode: String,
    /// Required for external mode
    pub address: Option<String>,
    pub token: Option<String>,
    pub transit_key: Option<String>,
}

pub async fn update_vault(
    State(state): State<SharedState>,
    Json(body): Json<VaultUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _db = require_running(&state).await?;

    use crate::config::{VaultConfig, VaultMode};

    let vault_cfg = match body.mode.as_str() {
        "local" => {
            let address =
                std::env::var("VAULT_ADDR").unwrap_or_else(|_| "http://vault:8200".into());
            let transit_key = body.transit_key.unwrap_or_else(|| "guac-master-key".into());

            // Check if we already have local vault credentials stored
            let existing = {
                let s = state.read().await;
                s.config.as_ref().and_then(|c| c.vault.clone())
            };

            let (token, unseal_key) = if let Some(ref existing) = existing {
                if existing.mode == VaultMode::Local {
                    // Already local — re-provision (unseal if needed)
                    let _ = crate::services::vault_provisioning::provision(
                        &address,
                        &transit_key,
                        existing.unseal_key.as_deref(),
                        Some(&existing.token),
                    )
                    .await?;
                    (existing.token.clone(), existing.unseal_key.clone())
                } else {
                    // Switching from external to local — fresh init
                    let result = crate::services::vault_provisioning::provision(
                        &address,
                        &transit_key,
                        None,
                        None,
                    )
                    .await?;
                    match result {
                        Some(init_result) => (init_result.root_token, Some(init_result.unseal_key)),
                        None => {
                            return Err(AppError::Vault(
                                "Bundled Vault is already initialized. Provide stored credentials or reset vault-data volume.".into(),
                            ));
                        }
                    }
                }
            } else {
                // No existing vault config — fresh init
                let result = crate::services::vault_provisioning::provision(
                    &address, &transit_key, None, None,
                )
                .await?;
                match result {
                    Some(init_result) => (init_result.root_token, Some(init_result.unseal_key)),
                    None => {
                        return Err(AppError::Vault(
                            "Bundled Vault already initialized but no credentials stored.".into(),
                        ));
                    }
                }
            };

            VaultConfig {
                address,
                token,
                transit_key,
                mode: VaultMode::Local,
                unseal_key,
            }
        }
        "external" => {
            let address = body
                .address
                .ok_or_else(|| AppError::Config("External vault requires an address".into()))?;
            let token = body
                .token
                .ok_or_else(|| AppError::Config("External vault requires a token".into()))?;
            let transit_key = body.transit_key.ok_or_else(|| {
                AppError::Config("External vault requires a transit key name".into())
            })?;

            VaultConfig {
                address,
                token,
                transit_key,
                mode: VaultMode::External,
                unseal_key: None,
            }
        }
        _ => {
            return Err(AppError::Config(
                "vault mode must be 'local' or 'external'".into(),
            ));
        }
    };

    let audit_address = vault_cfg.address.clone();

    // Persist local vault secrets so they survive container restarts
    if vault_cfg.mode == VaultMode::Local {
        if let Some(ref uk) = vault_cfg.unseal_key {
            if let Err(e) = (crate::config::LocalVaultSecrets {
                token: vault_cfg.token.clone(),
                unseal_key: uk.clone(),
            })
            .save()
            {
                tracing::warn!("Failed to persist vault secrets: {e}");
            }
        }
    }

    // Update config and persist
    {
        let mut s = state.write().await;
        if let Some(ref mut cfg) = s.config {
            cfg.vault = Some(vault_cfg);
            cfg.save(&AppConfig::config_path())
                .map_err(|e| AppError::Config(format!("Config save failed: {e}")))?;
        }
    }

    let db = require_running(&state).await?;
    audit::log(
        &db.pool,
        None,
        "vault.configured",
        &json!({ "address": audit_address }),
    )
    .await?;
    Ok(Json(json!({ "status": "vault_updated" })))
}

// ── Kerberos ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct KerberosUpdateRequest {
    pub realm: String,
    pub kdc: Vec<String>,
    pub admin_server: String,
    pub ticket_lifetime: Option<String>,
    pub renew_lifetime: Option<String>,
}

pub async fn update_kerberos(
    State(state): State<SharedState>,
    Json(body): Json<KerberosUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Validate hostname-like values to prevent injection
    if !is_safe_hostname(&body.realm)
        || body.kdc.iter().any(|k| !is_safe_hostname(k))
        || !is_safe_hostname(&body.admin_server)
    {
        return Err(AppError::Validation(
            "Kerberos hostnames must contain only alphanumeric characters, dots, hyphens, and colons".into(),
        ));
    }

    let ticket_lifetime = body.ticket_lifetime.as_deref().unwrap_or("10h");
    let renew_lifetime = body.renew_lifetime.as_deref().unwrap_or("7d");

    settings::set(&db.pool, "kerberos_enabled", "true").await?;
    settings::set(&db.pool, "kerberos_realm", &body.realm).await?;
    settings::set(&db.pool, "kerberos_kdc", &body.kdc.join(",")).await?;
    settings::set(&db.pool, "kerberos_admin_server", &body.admin_server).await?;
    settings::set(&db.pool, "kerberos_ticket_lifetime", ticket_lifetime).await?;
    settings::set(&db.pool, "kerberos_renew_lifetime", renew_lifetime).await?;

    // Generate krb5.conf to shared volume
    kerberos::write_krb5_conf(
        &body.realm,
        &body.kdc,
        &body.admin_server,
        ticket_lifetime,
        renew_lifetime,
        "/etc/krb5/krb5.conf",
    )
    .map_err(|e| AppError::Internal(format!("krb5.conf write failed: {e}")))?;

    audit::log(
        &db.pool,
        None,
        "kerberos.configured",
        &json!({ "realm": body.realm }),
    )
    .await?;
    Ok(Json(json!({ "status": "kerberos_updated" })))
}

// ── Kerberos Realms (multi-domain) ─────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct KerberosRealmRow {
    pub id: Uuid,
    pub realm: String,
    pub kdc_servers: String,
    pub admin_server: String,
    pub ticket_lifetime: String,
    pub renew_lifetime: String,
    pub is_default: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

pub async fn list_kerberos_realms(
    State(state): State<SharedState>,
) -> Result<Json<Vec<KerberosRealmRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<KerberosRealmRow> = sqlx::query_as(
        "SELECT id, realm, kdc_servers, admin_server, ticket_lifetime, renew_lifetime, is_default, created_at, updated_at
         FROM kerberos_realms ORDER BY is_default DESC, realm",
    )
    .fetch_all(&db.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateKerberosRealmRequest {
    pub realm: String,
    pub kdc_servers: Vec<String>,
    pub admin_server: String,
    pub ticket_lifetime: Option<String>,
    pub renew_lifetime: Option<String>,
    pub is_default: Option<bool>,
}

pub async fn create_kerberos_realm(
    State(state): State<SharedState>,
    Json(body): Json<CreateKerberosRealmRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Validate hostname-like values
    if !is_safe_hostname(&body.realm)
        || body.kdc_servers.iter().any(|k| !is_safe_hostname(k))
        || !is_safe_hostname(&body.admin_server)
    {
        return Err(AppError::Validation(
            "Kerberos hostnames must contain only alphanumeric characters, dots, hyphens, and colons".into(),
        ));
    }

    let ticket_lifetime = body.ticket_lifetime.as_deref().unwrap_or("10h");
    let renew_lifetime = body.renew_lifetime.as_deref().unwrap_or("7d");
    let is_default = body.is_default.unwrap_or(false);

    // Use a transaction so unset-others + insert is atomic
    let mut tx = db.pool.begin().await?;

    // If marking as default, unset other defaults
    if is_default {
        sqlx::query("UPDATE kerberos_realms SET is_default = false WHERE is_default = true")
            .execute(&mut *tx)
            .await?;
    }

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO kerberos_realms (realm, kdc_servers, admin_server, ticket_lifetime, renew_lifetime, is_default)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id",
    )
    .bind(&body.realm)
    .bind(body.kdc_servers.join(","))
    .bind(&body.admin_server)
    .bind(ticket_lifetime)
    .bind(renew_lifetime)
    .bind(is_default)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    // Keep kerberos_enabled in sync
    settings::set(&db.pool, "kerberos_enabled", "true").await?;

    regenerate_krb5_conf(&db.pool).await?;
    audit::log(
        &db.pool,
        None,
        "kerberos.realm_created",
        &json!({ "realm": body.realm }),
    )
    .await?;
    Ok(Json(json!({ "id": id, "status": "created" })))
}

#[derive(Deserialize)]
pub struct UpdateKerberosRealmRequest {
    pub realm: Option<String>,
    pub kdc_servers: Option<Vec<String>>,
    pub admin_server: Option<String>,
    pub ticket_lifetime: Option<String>,
    pub renew_lifetime: Option<String>,
    pub is_default: Option<bool>,
}

pub async fn update_kerberos_realm(
    State(state): State<SharedState>,
    Path(realm_id): Path<Uuid>,
    Json(body): Json<UpdateKerberosRealmRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Validate hostname-like values (parity with create)
    if let Some(ref realm) = body.realm {
        if !is_safe_hostname(realm) {
            return Err(AppError::Validation(
                "Kerberos realm must contain only alphanumeric characters, dots, hyphens, and colons".into(),
            ));
        }
    }
    if let Some(ref kdcs) = body.kdc_servers {
        if kdcs.iter().any(|k| !is_safe_hostname(k)) {
            return Err(AppError::Validation(
                "Kerberos KDC hostnames must contain only alphanumeric characters, dots, hyphens, and colons".into(),
            ));
        }
    }
    if let Some(ref admin) = body.admin_server {
        if !is_safe_hostname(admin) {
            return Err(AppError::Validation(
                "Kerberos admin server must contain only alphanumeric characters, dots, hyphens, and colons".into(),
            ));
        }
    }

    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM kerberos_realms WHERE id = $1)")
            .bind(realm_id)
            .fetch_one(&db.pool)
            .await
            .unwrap_or(false);
    if !exists {
        return Err(AppError::NotFound("Kerberos realm not found".into()));
    }

    // Use a transaction so unset-others + field updates are atomic
    let mut tx = db.pool.begin().await?;

    // If marking as default, unset other defaults
    if body.is_default == Some(true) {
        sqlx::query(
            "UPDATE kerberos_realms SET is_default = false WHERE is_default = true AND id != $1",
        )
        .bind(realm_id)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(ref realm) = body.realm {
        sqlx::query("UPDATE kerberos_realms SET realm = $1, updated_at = now() WHERE id = $2")
            .bind(realm)
            .bind(realm_id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(ref kdc) = body.kdc_servers {
        sqlx::query(
            "UPDATE kerberos_realms SET kdc_servers = $1, updated_at = now() WHERE id = $2",
        )
        .bind(kdc.join(","))
        .bind(realm_id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref admin) = body.admin_server {
        sqlx::query(
            "UPDATE kerberos_realms SET admin_server = $1, updated_at = now() WHERE id = $2",
        )
        .bind(admin)
        .bind(realm_id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref tl) = body.ticket_lifetime {
        sqlx::query(
            "UPDATE kerberos_realms SET ticket_lifetime = $1, updated_at = now() WHERE id = $2",
        )
        .bind(tl)
        .bind(realm_id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref rl) = body.renew_lifetime {
        sqlx::query(
            "UPDATE kerberos_realms SET renew_lifetime = $1, updated_at = now() WHERE id = $2",
        )
        .bind(rl)
        .bind(realm_id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(d) = body.is_default {
        sqlx::query("UPDATE kerberos_realms SET is_default = $1, updated_at = now() WHERE id = $2")
            .bind(d)
            .bind(realm_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    regenerate_krb5_conf(&db.pool).await?;
    audit::log(
        &db.pool,
        None,
        "kerberos.realm_updated",
        &json!({ "realm_id": realm_id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

pub async fn delete_kerberos_realm(
    State(state): State<SharedState>,
    Path(realm_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    let deleted = sqlx::query("DELETE FROM kerberos_realms WHERE id = $1")
        .bind(realm_id)
        .execute(&db.pool)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound("Kerberos realm not found".into()));
    }

    // Check if any realms remain
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM kerberos_realms")
        .fetch_one(&db.pool)
        .await
        .unwrap_or(0);
    if count == 0 {
        settings::set(&db.pool, "kerberos_enabled", "false").await?;
    }

    regenerate_krb5_conf(&db.pool).await?;
    audit::log(
        &db.pool,
        None,
        "kerberos.realm_deleted",
        &json!({ "realm_id": realm_id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "deleted" })))
}

/// Re-read all realms from DB and regenerate krb5.conf.
async fn regenerate_krb5_conf(pool: &sqlx::Pool<sqlx::Postgres>) -> Result<(), AppError> {
    let rows: Vec<KerberosRealmRow> = sqlx::query_as(
        "SELECT id, realm, kdc_servers, admin_server, ticket_lifetime, renew_lifetime, is_default, created_at, updated_at
         FROM kerberos_realms ORDER BY is_default DESC, realm",
    )
    .fetch_all(pool)
    .await?;

    let configs: Vec<kerberos::RealmConfig> = rows
        .iter()
        .map(|r| kerberos::RealmConfig {
            realm: r.realm.clone(),
            kdcs: r
                .kdc_servers
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            admin_server: r.admin_server.clone(),
            ticket_lifetime: r.ticket_lifetime.clone(),
            renew_lifetime: r.renew_lifetime.clone(),
            is_default: r.is_default,
        })
        .collect();

    kerberos::write_krb5_conf_multi(&configs, "/etc/krb5/krb5.conf")
        .map_err(|e| AppError::Internal(format!("krb5.conf write failed: {e}")))?;

    Ok(())
}

// ── Recordings ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct RecordingsUpdateRequest {
    pub enabled: bool,
    pub retention_days: Option<u32>,
    pub storage_type: Option<String>,
    pub azure_account_name: Option<String>,
    pub azure_container_name: Option<String>,
    pub azure_access_key: Option<String>,
}

pub async fn update_recordings(
    State(state): State<SharedState>,
    Json(body): Json<RecordingsUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    settings::set(
        &db.pool,
        "recordings_enabled",
        if body.enabled { "true" } else { "false" },
    )
    .await?;
    if let Some(days) = body.retention_days {
        settings::set(&db.pool, "recordings_retention_days", &days.to_string())
            .await?;
    }
    if let Some(ref st) = body.storage_type {
        settings::set(&db.pool, "recordings_storage_type", st).await?;
    }
    if let Some(ref name) = body.azure_account_name {
        settings::set(&db.pool, "recordings_azure_account_name", name)
            .await?;
    }
    if let Some(ref container) = body.azure_container_name {
        settings::set(&db.pool, "recordings_azure_container_name", container)
            .await?;
    }
    if let Some(ref key) = body.azure_access_key {
        // Encrypt access key via Vault if configured
        let stored = if !key.is_empty() {
            let vault_cfg = {
                let s = state.read().await;
                s.config.as_ref().and_then(|c| c.vault.clone())
            };
            if let Some(ref vc) = vault_cfg {
                crate::services::vault::seal_setting(vc, key).await?
            } else {
                key.clone()
            }
        } else {
            String::new()
        };
        settings::set(&db.pool, "recordings_azure_access_key", &stored).await?;
    }
    audit::log(
        &db.pool,
        None,
        "recordings.configured",
        &json!({ "enabled": body.enabled }),
    )
    .await?;
    Ok(Json(json!({ "status": "recordings_updated" })))
}

// ── Roles ──────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct RoleRow {
    pub id: Uuid,
    pub name: String,
}

pub async fn list_roles(
    State(state): State<SharedState>,
) -> Result<Json<Vec<RoleRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<RoleRow> = sqlx::query_as("SELECT id, name FROM roles ORDER BY name")
        .fetch_all(&db.pool)
        .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
}

pub async fn create_role(
    State(state): State<SharedState>,
    Json(body): Json<CreateRoleRequest>,
) -> Result<Json<RoleRow>, AppError> {
    let db = require_running(&state).await?;
    let row: RoleRow = sqlx::query_as("INSERT INTO roles (name) VALUES ($1) RETURNING id, name")
        .bind(&body.name)
        .fetch_one(&db.pool)
        .await?;
    audit::log(
        &db.pool,
        None,
        "role.created",
        &json!({ "name": body.name }),
    )
    .await?;
    Ok(Json(row))
}

// ── Connections ────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct ConnectionRow {
    pub id: Uuid,
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: i32,
    pub domain: Option<String>,
    pub description: String,
    pub group_id: Option<Uuid>,
    pub extra: serde_json::Value,
    pub last_accessed: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn list_connections(
    State(state): State<SharedState>,
) -> Result<Json<Vec<ConnectionRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<ConnectionRow> = sqlx::query_as(
        "SELECT id, name, protocol, hostname, port, domain, description, group_id, extra, last_accessed FROM connections WHERE soft_deleted_at IS NULL ORDER BY name",
    )
    .fetch_all(&db.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateConnectionRequest {
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: Option<i32>,
    pub domain: Option<String>,
    #[serde(default)]
    pub description: String,
    pub group_id: Option<Uuid>,
    #[serde(default)]
    pub extra: serde_json::Value,
}

pub async fn create_connection(
    State(state): State<SharedState>,
    Json(body): Json<CreateConnectionRequest>,
) -> Result<Json<ConnectionRow>, AppError> {
    let db = require_running(&state).await?;
    let port = body.port.unwrap_or(3389);
    let extra = if body.extra.is_null() { serde_json::json!({}) } else { body.extra.clone() };
    let row: ConnectionRow = sqlx::query_as(
        "INSERT INTO connections (name, protocol, hostname, port, domain, description, group_id, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, protocol, hostname, port, domain, description, group_id, extra, last_accessed",
    )
    .bind(&body.name)
    .bind(&body.protocol)
    .bind(&body.hostname)
    .bind(port)
    .bind(&body.domain)
    .bind(&body.description)
    .bind(body.group_id)
    .bind(&extra)
    .fetch_one(&db.pool)
    .await?;
    audit::log(
        &db.pool,
        None,
        "connection.created",
        &json!({ "name": body.name }),
    )
    .await?;
    Ok(Json(row))
}

pub async fn update_connection(
    State(state): State<SharedState>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(body): Json<CreateConnectionRequest>,
) -> Result<Json<ConnectionRow>, AppError> {
    let db = require_running(&state).await?;
    let port = body.port.unwrap_or(3389);
    let extra = if body.extra.is_null() { serde_json::json!({}) } else { body.extra.clone() };
    let row: ConnectionRow = sqlx::query_as(
        "UPDATE connections SET name = $1, protocol = $2, hostname = $3, port = $4, domain = $5, description = $6, group_id = $7, extra = $8, updated_at = now()
         WHERE id = $9 AND soft_deleted_at IS NULL
         RETURNING id, name, protocol, hostname, port, domain, description, group_id, extra, last_accessed",
    )
    .bind(&body.name)
    .bind(&body.protocol)
    .bind(&body.hostname)
    .bind(port)
    .bind(&body.domain)
    .bind(&body.description)
    .bind(body.group_id)
    .bind(&extra)
    .bind(id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;
    audit::log(
        &db.pool,
        None,
        "connection.updated",
        &json!({ "id": id.to_string(), "name": body.name }),
    )
    .await?;
    Ok(Json(row))
}

pub async fn delete_connection(
    State(state): State<SharedState>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let result = sqlx::query(
        "UPDATE connections SET soft_deleted_at = now() WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(id)
    .execute(&db.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Connection not found".into()));
    }
    audit::log(
        &db.pool,
        None,
        "connection.deleted",
        &json!({ "id": id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "deleted" })))
}

// ── Role-Connection mapping ────────────────────────────────────────────

#[derive(Deserialize)]
pub struct RoleConnectionUpdate {
    pub role_id: Uuid,
    pub connection_ids: Vec<Uuid>,
}

pub async fn update_role_connections(
    State(state): State<SharedState>,
    Json(body): Json<RoleConnectionUpdate>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Replace all mappings for this role
    let mut tx = db.pool.begin().await?;
    sqlx::query("DELETE FROM role_connections WHERE role_id = $1")
        .bind(body.role_id)
        .execute(&mut *tx)
        .await?;
    for cid in &body.connection_ids {
        sqlx::query("INSERT INTO role_connections (role_id, connection_id) VALUES ($1, $2)")
            .bind(body.role_id)
            .bind(cid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    audit::log(
        &db.pool,
        None,
        "role_connections.updated",
        &json!({ "role_id": body.role_id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

// ── Users ──────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
    pub sub: Option<String>,
    pub role_name: String,
}

pub async fn list_users(
    State(state): State<SharedState>,
) -> Result<Json<Vec<UserRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<UserRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.sub, r.name as role_name
         FROM users u JOIN roles r ON u.role_id = r.id
         ORDER BY u.username",
    )
    .fetch_all(&db.pool)
    .await?;
    Ok(Json(rows))
}

// ── Audit Logs ─────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct AuditLogRow {
    pub id: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub user_id: Option<Uuid>,
    pub username: Option<String>,
    pub action_type: String,
    pub details: serde_json::Value,
    pub current_hash: String,
}

#[derive(Deserialize)]
pub struct AuditLogQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

pub async fn list_audit_logs(
    State(state): State<SharedState>,
    axum::extract::Query(query): axum::extract::Query<AuditLogQuery>,
) -> Result<Json<Vec<AuditLogRow>>, AppError> {
    let db = require_running(&state).await?;
    let per_page = query.per_page.unwrap_or(50).clamp(1, 200);
    let offset = (query.page.unwrap_or(1).max(1) - 1) * per_page;

    let rows: Vec<AuditLogRow> = sqlx::query_as(
        "SELECT a.id, a.created_at, a.user_id, u.username, a.action_type, a.details, a.current_hash
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.id DESC LIMIT $1 OFFSET $2",
    )
    .bind(per_page)
    .bind(offset)
    .fetch_all(&db.pool)
    .await?;
    Ok(Json(rows))
}

// ── Connection Groups ──────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct ConnectionGroupRow {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

pub async fn list_connection_groups(
    State(state): State<SharedState>,
) -> Result<Json<Vec<ConnectionGroupRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<ConnectionGroupRow> =
        sqlx::query_as("SELECT id, name, parent_id FROM connection_groups ORDER BY name")
            .fetch_all(&db.pool)
            .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub parent_id: Option<Uuid>,
}

pub async fn create_connection_group(
    State(state): State<SharedState>,
    Json(body): Json<CreateGroupRequest>,
) -> Result<Json<ConnectionGroupRow>, AppError> {
    let db = require_running(&state).await?;
    let row: ConnectionGroupRow = sqlx::query_as(
        "INSERT INTO connection_groups (name, parent_id) VALUES ($1, $2) RETURNING id, name, parent_id",
    )
    .bind(&body.name)
    .bind(body.parent_id)
    .fetch_one(&db.pool)
    .await?;
    audit::log(
        &db.pool,
        None,
        "connection_group.created",
        &json!({ "name": body.name }),
    )
    .await?;
    Ok(Json(row))
}

#[derive(Deserialize)]
pub struct UpdateGroupRequest {
    pub name: String,
    pub parent_id: Option<Uuid>,
}

pub async fn update_connection_group(
    State(state): State<SharedState>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(body): Json<UpdateGroupRequest>,
) -> Result<Json<ConnectionGroupRow>, AppError> {
    let db = require_running(&state).await?;
    let row: ConnectionGroupRow = sqlx::query_as(
        "UPDATE connection_groups SET name = $1, parent_id = $2 WHERE id = $3 RETURNING id, name, parent_id",
    )
    .bind(&body.name)
    .bind(body.parent_id)
    .bind(id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Group not found".into()))?;
    Ok(Json(row))
}

pub async fn delete_connection_group(
    State(state): State<SharedState>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let result = sqlx::query("DELETE FROM connection_groups WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Group not found".into()));
    }
    audit::log(
        &db.pool,
        None,
        "connection_group.deleted",
        &json!({ "id": id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "deleted" })))
}

// ── Active Sessions (NVR) ──────────────────────────────────────────

pub async fn list_active_sessions(
    State(state): State<SharedState>,
) -> Result<Json<Vec<crate::services::session_registry::SessionInfo>>, AppError> {
    let _db = require_running(&state).await?;
    let registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };
    Ok(Json(registry.list().await))
}

#[derive(Deserialize)]
pub struct ObserveQuery {
    /// How many seconds back to replay (0 = live only, 300 = full 5-min buffer)
    pub offset: Option<u64>,
}

pub async fn observe_session(
    ws: axum::extract::WebSocketUpgrade,
    State(state): State<SharedState>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<ObserveQuery>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let _db = require_running(&state).await?;
    let registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };

    let session = registry
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::NotFound("Active session not found".into()))?;

    let offset = query.offset.unwrap_or(300); // default: replay full buffer

    // Snapshot the buffer and subscribe to live frames
    let (buffered_frames, mut rx) = {
        let buffer = session.buffer.read().await;
        let mut frames = Vec::new();

        // Always inject the last known size instruction first
        if let Some(size_inst) = buffer.last_size() {
            frames.push(size_inst.to_string());
        }

        // Add buffered frames from the requested offset
        if offset > 0 {
            frames.extend(buffer.frames_from_offset(offset));
        }

        let rx = session.broadcast_tx.subscribe();
        (frames, rx)
    };

    Ok(ws.protocols(["guacamole"]).on_upgrade(
        move |mut socket| async move {
            use axum::extract::ws::Message;

            // Phase 1: Replay buffered frames as fast as possible
            for frame in buffered_frames {
                if socket.send(Message::Text(frame)).await.is_err() {
                    return;
                }
            }

            // Phase 2: Forward live frames from the broadcast channel
            loop {
                match rx.recv().await {
                    Ok(frame) => {
                        if socket.send(Message::Text((*frame).clone())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("NVR observer lagged {n} frames, skipping");
                    }
                    Err(_) => break, // channel closed (session ended)
                }
            }
        },
    ))
}

// ── Metrics ────────────────────────────────────────────────────────────

pub async fn get_metrics(
    State(state): State<SharedState>,
) -> Result<Json<crate::services::session_registry::MetricsSummary>, AppError> {
    let _db = require_running(&state).await?;
    let (registry, pool_size) = {
        let s = state.read().await;
        let size = s.guacd_pool.as_ref().map(|p| p.len() as u32).unwrap_or(1);
        (s.session_registry.clone(), size)
    };
    let mut metrics = registry.metrics().await;
    metrics.guacd_pool_size = pool_size;
    Ok(Json(metrics))
}

// ── AD Sync Config CRUD ────────────────────────────────────────────────

use crate::services::ad_sync::{AdSyncConfig, AdSyncRun};

pub async fn list_ad_sync_configs(
    State(state): State<SharedState>,
) -> Result<Json<Vec<AdSyncConfig>>, AppError> {
    let db = require_running(&state).await?;
    let mut rows: Vec<AdSyncConfig> =
        sqlx::query_as("SELECT * FROM ad_sync_configs ORDER BY label")
            .fetch_all(&db.pool)
            .await?;
    // Redact bind_password — never expose encrypted or plaintext secrets to clients
    for r in &mut rows {
        if !r.bind_password.is_empty() {
            r.bind_password = "••••••••".into();
        }
    }
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateAdSyncConfigRequest {
    pub label: String,
    pub ldap_url: String,
    pub bind_dn: Option<String>,
    pub bind_password: Option<String>,
    pub search_bases: Vec<String>,
    pub search_filter: Option<String>,
    pub search_scope: Option<String>,
    pub protocol: Option<String>,
    pub default_port: Option<i32>,
    pub domain_override: Option<String>,
    pub group_id: Option<Uuid>,
    pub tls_skip_verify: Option<bool>,
    pub sync_interval_minutes: Option<i32>,
    pub enabled: Option<bool>,
    pub auth_method: Option<String>,
    pub keytab_path: Option<String>,
    pub krb5_principal: Option<String>,
    pub ca_cert_pem: Option<String>,
}

pub async fn create_ad_sync_config(
    State(state): State<SharedState>,
    Json(body): Json<CreateAdSyncConfigRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Validate LDAP URL uses a safe scheme
    if !body.ldap_url.starts_with("ldap://") && !body.ldap_url.starts_with("ldaps://") {
        return Err(AppError::Validation("LDAP URL must use ldap:// or ldaps://".into()));
    }

    // Validate search filter has balanced parentheses (basic LDAP filter sanity)
    if let Some(ref filter) = body.search_filter {
        let opens = filter.chars().filter(|c| *c == '(').count();
        let closes = filter.chars().filter(|c| *c == ')').count();
        if opens != closes || opens == 0 {
            return Err(AppError::Validation("Invalid LDAP search filter — unbalanced parentheses".into()));
        }
    }

    // Encrypt bind_password via Vault if configured
    let bind_password = body.bind_password.as_deref().unwrap_or("");
    let stored_password = if !bind_password.is_empty() {
        let vault_cfg = {
            let s = state.read().await;
            s.config.as_ref().and_then(|c| c.vault.clone())
        };
        if let Some(ref vc) = vault_cfg {
            crate::services::vault::seal_setting(vc, bind_password).await?
        } else {
            bind_password.to_string()
        }
    } else {
        String::new()
    };

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO ad_sync_configs (label, ldap_url, bind_dn, bind_password, search_bases, search_filter, search_scope, protocol, default_port, domain_override, group_id, tls_skip_verify, sync_interval_minutes, enabled, auth_method, keytab_path, krb5_principal, ca_cert_pem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id",
    )
    .bind(&body.label)
    .bind(&body.ldap_url)
    .bind(body.bind_dn.as_deref().unwrap_or(""))
    .bind(&stored_password)
    .bind(&body.search_bases)
    .bind(body.search_filter.as_deref().unwrap_or("(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))"))
    .bind(body.search_scope.as_deref().unwrap_or("subtree"))
    .bind(body.protocol.as_deref().unwrap_or("rdp"))
    .bind(body.default_port.unwrap_or(3389))
    .bind(body.domain_override.as_deref())
    .bind(body.group_id)
    .bind(body.tls_skip_verify.unwrap_or(false))
    .bind(body.sync_interval_minutes.unwrap_or(60))
    .bind(body.enabled.unwrap_or(true))
    .bind(body.auth_method.as_deref().unwrap_or("simple"))
    .bind(body.keytab_path.as_deref())
    .bind(body.krb5_principal.as_deref())
    .bind(body.ca_cert_pem.as_deref())
    .fetch_one(&db.pool)
    .await?;

    settings::set(&db.pool, "ad_sync_enabled", "true").await?;
    audit::log(
        &db.pool,
        None,
        "ad_sync.config_created",
        &json!({ "label": body.label }),
    )
    .await?;
    Ok(Json(json!({ "id": id, "status": "created" })))
}

#[derive(Deserialize)]
pub struct UpdateAdSyncConfigRequest {
    pub label: Option<String>,
    pub ldap_url: Option<String>,
    pub bind_dn: Option<String>,
    pub bind_password: Option<String>,
    pub search_bases: Option<Vec<String>>,
    pub search_filter: Option<String>,
    pub search_scope: Option<String>,
    pub protocol: Option<String>,
    pub default_port: Option<i32>,
    pub domain_override: Option<String>,
    pub group_id: Option<Uuid>,
    pub tls_skip_verify: Option<bool>,
    pub sync_interval_minutes: Option<i32>,
    pub enabled: Option<bool>,
    pub auth_method: Option<String>,
    pub keytab_path: Option<String>,
    pub krb5_principal: Option<String>,
    pub ca_cert_pem: Option<String>,
}

pub async fn update_ad_sync_config(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateAdSyncConfigRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Verify exists
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ad_sync_configs WHERE id = $1)")
            .bind(id)
            .fetch_one(&db.pool)
            .await?;
    if !exists {
        return Err(AppError::NotFound("AD sync config not found".into()));
    }

    // Validate ldap_url if being updated (parity with create)
    if let Some(ref v) = body.ldap_url {
        if !v.starts_with("ldap://") && !v.starts_with("ldaps://") {
            return Err(AppError::Validation("LDAP URL must use ldap:// or ldaps://".into()));
        }
    }

    // Validate search_filter if being updated (parity with create)
    if let Some(ref filter) = body.search_filter {
        let opens = filter.chars().filter(|c| *c == '(').count();
        let closes = filter.chars().filter(|c| *c == ')').count();
        if opens != closes || opens == 0 {
            return Err(AppError::Validation("Invalid LDAP search filter — unbalanced parentheses".into()));
        }
    }

    // Apply partial updates within a transaction for atomicity
    let mut tx = db.pool.begin().await?;

    if let Some(ref v) = body.label {
        sqlx::query("UPDATE ad_sync_configs SET label = $1, updated_at = now() WHERE id = $2")
            .bind(v)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(ref v) = body.ldap_url {
        sqlx::query("UPDATE ad_sync_configs SET ldap_url = $1, updated_at = now() WHERE id = $2")
            .bind(v)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(ref v) = body.bind_dn {
        sqlx::query("UPDATE ad_sync_configs SET bind_dn = $1, updated_at = now() WHERE id = $2")
            .bind(v)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(ref v) = body.bind_password {
        // Encrypt bind_password via Vault if configured
        let stored = if !v.is_empty() {
            let vault_cfg = {
                let s = state.read().await;
                s.config.as_ref().and_then(|c| c.vault.clone())
            };
            if let Some(ref vc) = vault_cfg {
                crate::services::vault::seal_setting(vc, v).await?
            } else {
                v.clone()
            }
        } else {
            String::new()
        };
        sqlx::query(
            "UPDATE ad_sync_configs SET bind_password = $1, updated_at = now() WHERE id = $2",
        )
        .bind(&stored)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref v) = body.search_bases {
        sqlx::query(
            "UPDATE ad_sync_configs SET search_bases = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref v) = body.search_filter {
        sqlx::query(
            "UPDATE ad_sync_configs SET search_filter = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref v) = body.search_scope {
        sqlx::query(
            "UPDATE ad_sync_configs SET search_scope = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref v) = body.protocol {
        sqlx::query("UPDATE ad_sync_configs SET protocol = $1, updated_at = now() WHERE id = $2")
            .bind(v)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(v) = body.default_port {
        sqlx::query(
            "UPDATE ad_sync_configs SET default_port = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref v) = body.domain_override {
        sqlx::query(
            "UPDATE ad_sync_configs SET domain_override = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(v) = body.group_id {
        sqlx::query("UPDATE ad_sync_configs SET group_id = $1, updated_at = now() WHERE id = $2")
            .bind(v)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(v) = body.tls_skip_verify {
        sqlx::query(
            "UPDATE ad_sync_configs SET tls_skip_verify = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(v) = body.sync_interval_minutes {
        sqlx::query(
            "UPDATE ad_sync_configs SET sync_interval_minutes = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(v) = body.enabled {
        sqlx::query("UPDATE ad_sync_configs SET enabled = $1, updated_at = now() WHERE id = $2")
            .bind(v)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(ref v) = body.auth_method {
        sqlx::query(
            "UPDATE ad_sync_configs SET auth_method = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref v) = body.keytab_path {
        sqlx::query(
            "UPDATE ad_sync_configs SET keytab_path = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref v) = body.krb5_principal {
        sqlx::query(
            "UPDATE ad_sync_configs SET krb5_principal = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(ref v) = body.ca_cert_pem {
        let val = if v.is_empty() { None } else { Some(v.as_str()) };
        sqlx::query(
            "UPDATE ad_sync_configs SET ca_cert_pem = $1, updated_at = now() WHERE id = $2",
        )
        .bind(val)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    audit::log(
        &db.pool,
        None,
        "ad_sync.config_updated",
        &json!({ "id": id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

pub async fn delete_ad_sync_config(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let result = sqlx::query("DELETE FROM ad_sync_configs WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("AD sync config not found".into()));
    }

    // Disable global sync if no configs remaining
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ad_sync_configs")
        .fetch_one(&db.pool)
        .await?;
    if count == 0 {
        settings::set(&db.pool, "ad_sync_enabled", "false").await?;
    }

    audit::log(
        &db.pool,
        None,
        "ad_sync.config_deleted",
        &json!({ "id": id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "deleted" })))
}

// ── Trigger manual sync ────────────────────────────────────────────────

pub async fn trigger_ad_sync(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let mut config: AdSyncConfig =
        sqlx::query_as("SELECT * FROM ad_sync_configs WHERE id = $1")
            .bind(id)
            .fetch_optional(&db.pool)
            .await?
            .ok_or_else(|| AppError::NotFound("AD sync config not found".into()))?;

    // Decrypt bind_password if vault-encrypted
    if config.bind_password.starts_with("vault:") {
        let vault_cfg = {
            let s = state.read().await;
            s.config.as_ref().and_then(|c| c.vault.clone())
        };
        if let Some(ref vc) = vault_cfg {
            config.bind_password =
                crate::services::vault::unseal_setting(vc, &config.bind_password).await?;
        }
    }

    let run_id = crate::services::ad_sync::run_sync(&db.pool, &config)
        .await
        .map_err(|e| AppError::Internal(format!("Sync failed: {e}")))?;

    Ok(Json(json!({ "run_id": run_id, "status": "completed" })))
}

// ── Test AD sync connection ────────────────────────────────────────────

pub async fn test_ad_sync_connection(
    State(state): State<SharedState>,
    Json(body): Json<CreateAdSyncConfigRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _db = require_running(&state).await?;

    // Build a temporary AdSyncConfig from the request body
    let config = AdSyncConfig {
        id: Uuid::nil(),
        label: body.label.clone(),
        ldap_url: body.ldap_url.clone(),
        bind_dn: body.bind_dn.clone().unwrap_or_default(),
        bind_password: body.bind_password.clone().unwrap_or_default(),
        search_bases: body.search_bases.clone(),
        search_filter: body.search_filter.clone().unwrap_or_else(|| {
            "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))".into()
        }),
        search_scope: body.search_scope.clone().unwrap_or_else(|| "subtree".into()),
        protocol: body.protocol.clone().unwrap_or_else(|| "rdp".into()),
        default_port: body.default_port.unwrap_or(3389),
        domain_override: body.domain_override.clone(),
        group_id: body.group_id,
        tls_skip_verify: body.tls_skip_verify.unwrap_or(false),
        sync_interval_minutes: body.sync_interval_minutes.unwrap_or(60),
        enabled: body.enabled.unwrap_or(true),
        auth_method: body.auth_method.clone().unwrap_or_else(|| "simple".into()),
        keytab_path: body.keytab_path.clone(),
        krb5_principal: body.krb5_principal.clone(),
        ca_cert_pem: body.ca_cert_pem.clone(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };

    match crate::services::ad_sync::test_connection(&config).await {
        Ok((count, sample)) => Ok(Json(json!({
            "status": "success",
            "message": format!("Connection successful — found {} object(s)", count),
            "count": count,
            "sample": sample,
        }))),
        Err(e) => Ok(Json(json!({
            "status": "error",
            "message": format!("{e:#}"),
        }))),
    }
}

// ── Sync run history ───────────────────────────────────────────────────

pub async fn list_ad_sync_runs(
    State(state): State<SharedState>,
    Path(config_id): Path<Uuid>,
) -> Result<Json<Vec<AdSyncRun>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<AdSyncRun> = sqlx::query_as(
        "SELECT * FROM ad_sync_runs WHERE config_id = $1 ORDER BY started_at DESC LIMIT 50",
    )
    .bind(config_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_safe_hostname ───────────────────────────────────────────
    #[test]
    fn safe_hostname_valid() {
        assert!(is_safe_hostname("dc1.corp.local"));
        assert!(is_safe_hostname("kdc-primary"));
        assert!(is_safe_hostname("host.example.com:88"));
        assert!(is_safe_hostname("CORP.LOCAL"));
        assert!(is_safe_hostname("a"));
        assert!(is_safe_hostname("host_name"));
    }

    #[test]
    fn safe_hostname_rejects_empty() {
        assert!(!is_safe_hostname(""));
    }

    #[test]
    fn safe_hostname_rejects_injection() {
        assert!(!is_safe_hostname("host; rm -rf /"));
        assert!(!is_safe_hostname("host\nrealm = EVIL"));
        assert!(!is_safe_hostname("host$(cmd)"));
        assert!(!is_safe_hostname("host`cmd`"));
        assert!(!is_safe_hostname("host/path"));
        assert!(!is_safe_hostname("host name"));
    }

    #[test]
    fn safe_hostname_rejects_too_long() {
        let long = "a".repeat(256);
        assert!(!is_safe_hostname(&long));
        // 255 is ok
        let ok = "a".repeat(255);
        assert!(is_safe_hostname(&ok));
    }

    // ── SENSITIVE_SETTINGS ─────────────────────────────────────────
    #[test]
    fn sensitive_settings_contains_known_keys() {
        assert!(SENSITIVE_SETTINGS.contains(&"sso_client_secret"));
        assert!(SENSITIVE_SETTINGS.contains(&"vault_token"));
        assert!(SENSITIVE_SETTINGS.contains(&"vault_unseal_key"));
        assert!(SENSITIVE_SETTINGS.contains(&"ad_bind_password"));
    }

    // ── RESTRICTED_SETTINGS ────────────────────────────────────────
    #[test]
    fn restricted_settings_contains_known_keys() {
        assert!(RESTRICTED_SETTINGS.contains(&"jwt_secret"));
        assert!(RESTRICTED_SETTINGS.contains(&"sso_client_secret"));
        assert!(RESTRICTED_SETTINGS.contains(&"sso_issuer_url"));
        assert!(RESTRICTED_SETTINGS.contains(&"kerberos_realm"));
        assert!(RESTRICTED_SETTINGS.contains(&"local_auth_enabled"));
    }

    #[test]
    fn restricted_and_sensitive_overlap() {
        // sso_client_secret must be in both lists
        assert!(SENSITIVE_SETTINGS.contains(&"sso_client_secret"));
        assert!(RESTRICTED_SETTINGS.contains(&"sso_client_secret"));
    }

    // ── Struct deserialization ──────────────────────────────────────
    #[test]
    fn sso_update_request_deser() {
        let json =
            r#"{"issuer_url":"https://sso.example.com","client_id":"id","client_secret":"s"}"#;
        let r: SsoUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.issuer_url, "https://sso.example.com");
        assert_eq!(r.client_id, "id");
    }

    #[test]
    fn auth_methods_update_request_deser() {
        let json = r#"{"sso_enabled":true,"local_auth_enabled":false}"#;
        let r: AuthMethodsUpdateRequest = serde_json::from_str(json).unwrap();
        assert!(r.sso_enabled);
        assert!(!r.local_auth_enabled);
    }

    #[test]
    fn kerberos_update_request_deser() {
        let json = r#"{"realm":"CORP.LOCAL","kdc":["kdc1.corp.local"],"admin_server":"admin.corp.local"}"#;
        let r: KerberosUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.realm, "CORP.LOCAL");
        assert_eq!(r.kdc.len(), 1);
        assert!(r.ticket_lifetime.is_none());
    }

    #[test]
    fn create_connection_request_defaults() {
        let json = r#"{"name":"test","protocol":"rdp","hostname":"10.0.0.1"}"#;
        let r: CreateConnectionRequest = serde_json::from_str(json).unwrap();
        assert!(r.port.is_none());
        assert!(r.domain.is_none());
        assert_eq!(r.description, "");
        assert!(r.extra.is_null());
    }

    #[test]
    fn create_connection_request_full() {
        let json = r#"{
            "name":"prod-server",
            "protocol":"ssh",
            "hostname":"192.168.1.100",
            "port":22,
            "domain":"CORP",
            "description":"Production server",
            "extra":{"color-depth":"24"}
        }"#;
        let r: CreateConnectionRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.port.unwrap(), 22);
        assert_eq!(r.domain.as_deref().unwrap(), "CORP");
        assert_eq!(r.extra["color-depth"], "24");
    }

    #[test]
    fn role_connection_update_deser() {
        let json = r#"{"role_id":"550e8400-e29b-41d4-a716-446655440000","connection_ids":[]}"#;
        let r: RoleConnectionUpdate = serde_json::from_str(json).unwrap();
        assert!(r.connection_ids.is_empty());
    }

    #[test]
    fn audit_log_query_defaults() {
        let q: AuditLogQuery = serde_json::from_str("{}").unwrap();
        assert!(q.page.is_none());
        assert!(q.per_page.is_none());
    }

    #[test]
    fn audit_log_query_values() {
        let q: AuditLogQuery = serde_json::from_str(r#"{"page":2,"per_page":100}"#).unwrap();
        assert_eq!(q.page.unwrap(), 2);
        assert_eq!(q.per_page.unwrap(), 100);
    }

    #[test]
    fn recordings_update_request_minimal() {
        let r: RecordingsUpdateRequest = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(r.enabled);
        assert!(r.retention_days.is_none());
        assert!(r.storage_type.is_none());
    }

    #[test]
    fn create_role_request_deser() {
        let r: CreateRoleRequest = serde_json::from_str(r#"{"name":"viewer"}"#).unwrap();
        assert_eq!(r.name, "viewer");
    }

    #[test]
    fn create_kerberos_realm_request_deser() {
        let json = r#"{"realm":"CORP","kdc_servers":["kdc1","kdc2"],"admin_server":"admin"}"#;
        let r: CreateKerberosRealmRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.realm, "CORP");
        assert_eq!(r.kdc_servers.len(), 2);
        assert!(r.is_default.is_none());
    }

    #[test]
    fn create_group_request_deser() {
        let r: CreateGroupRequest = serde_json::from_str(r#"{"name":"servers"}"#).unwrap();
        assert_eq!(r.name, "servers");
        assert!(r.parent_id.is_none());
    }

    #[test]
    fn vault_update_request_local() {
        let json = r#"{"mode":"local"}"#;
        let r: VaultUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.mode, "local");
        assert!(r.address.is_none());
        assert!(r.token.is_none());
    }

    #[test]
    fn vault_update_request_external() {
        let json = r#"{"mode":"external","address":"https://vault:8200","token":"tok","transit_key":"key"}"#;
        let r: VaultUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.mode, "external");
        assert_eq!(r.address.unwrap(), "https://vault:8200");
    }

    #[test]
    fn settings_update_request_deser() {
        let json = r#"{"settings":[{"key":"theme","value":"dark"},{"key":"timeout","value":"30"}]}"#;
        let r: SettingsUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.settings.len(), 2);
        assert_eq!(r.settings[0].key, "theme");
        assert_eq!(r.settings[1].value, "30");
    }

    #[test]
    fn create_ad_sync_config_request_minimal() {
        let json = r#"{"label":"Corp AD","ldap_url":"ldap://dc.corp.local","search_bases":["dc=corp,dc=local"]}"#;
        let r: CreateAdSyncConfigRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.label, "Corp AD");
        assert!(r.bind_dn.is_none());
        assert!(r.protocol.is_none());
        assert!(r.tls_skip_verify.is_none());
    }

    #[test]
    fn observe_query_defaults() {
        let q: ObserveQuery = serde_json::from_str("{}").unwrap();
        assert!(q.offset.is_none());
    }
}
