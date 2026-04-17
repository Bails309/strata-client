use axum::extract::{Path, State};
use axum::Extension;
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::error::AppError;
use crate::routes::auth;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::{audit, kerberos, settings};

pub mod recordings;

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

/// Validate that an LDAP URL uses a safe scheme (ldap:// or ldaps://).
fn validate_ldap_url(url: &str) -> Result<(), AppError> {
    if !url.starts_with("ldap://") && !url.starts_with("ldaps://") {
        return Err(AppError::Validation(
            "LDAP URL must use ldap:// or ldaps://".into(),
        ));
    }
    Ok(())
}

/// Validate that an LDAP search filter has balanced parentheses.
fn validate_ldap_filter(filter: &str) -> Result<(), AppError> {
    let opens = filter.chars().filter(|c| *c == '(').count();
    let closes = filter.chars().filter(|c| *c == ')').count();
    if opens != closes || opens == 0 {
        return Err(AppError::Validation(
            "Invalid LDAP search filter — unbalanced parentheses".into(),
        ));
    }
    Ok(())
}

/// Build the OIDC discovery URL from an issuer URL, handling trailing slashes.
fn build_oidc_discovery_url(issuer_url: &str) -> String {
    if issuer_url.ends_with('/') {
        format!("{}.well-known/openid-configuration", issuer_url)
    } else {
        format!("{}/.well-known/openid-configuration", issuer_url)
    }
}

/// Validate that an OIDC configuration JSON contains the required endpoints.
fn validate_oidc_config(config: &serde_json::Value) -> Result<(), AppError> {
    let has_auth = config
        .get("authorization_endpoint")
        .and_then(|v| v.as_str())
        .is_some();
    let has_token = config
        .get("token_endpoint")
        .and_then(|v| v.as_str())
        .is_some();
    let has_jwks = config.get("jwks_uri").and_then(|v| v.as_str()).is_some();

    if !has_auth || !has_token || !has_jwks {
        return Err(AppError::Validation(
            "OIDC configuration is missing required endpoints (authorization, token, or jwks)."
                .into(),
        ));
    }
    Ok(())
}

/// Determine whether a setting update should be skipped because it's a
/// sensitive key whose value matches a redaction mask (the UI re-sent
/// the placeholder, meaning the user didn't actually change it).
fn should_skip_masked_setting(key: &str, value: &str) -> bool {
    SENSITIVE_SETTINGS.iter().any(|s| key.contains(s)) && (value == DOT_MASK || value == STAR_MASK)
}

/// Convert Kerberos realm DB rows into `RealmConfig` values suitable for
/// writing a krb5.conf file.
fn realm_rows_to_configs(rows: &[KerberosRealmRow]) -> Vec<kerberos::RealmConfig> {
    rows.iter()
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
        .collect()
}

/// Validate a batch of Kerberos hostname-like values against `is_safe_hostname`.
/// Returns an error naming the field if any value fails.
fn validate_kerberos_hostnames(
    realm: Option<&str>,
    kdcs: Option<&[String]>,
    admin_server: Option<&str>,
) -> Result<(), AppError> {
    if let Some(r) = realm {
        if !is_safe_hostname(r) {
            return Err(AppError::Validation(
                "Kerberos realm must contain only alphanumeric characters, dots, hyphens, and colons".into(),
            ));
        }
    }
    if let Some(kdc_list) = kdcs {
        if kdc_list.iter().any(|k| !is_safe_hostname(k)) {
            return Err(AppError::Validation(
                "Kerberos KDC hostnames must contain only alphanumeric characters, dots, hyphens, and colons".into(),
            ));
        }
    }
    if let Some(admin) = admin_server {
        if !is_safe_hostname(admin) {
            return Err(AppError::Validation(
                "Kerberos admin server must contain only alphanumeric characters, dots, hyphens, and colons".into(),
            ));
        }
    }
    Ok(())
}

/// Compute per_page and offset from optional page/per_page query params.
/// `per_page` is clamped to [1, max_per_page], page to >= 1.
fn paginate(page: Option<i64>, per_page: Option<i64>, max_per_page: i64) -> (i64, i64) {
    let per_page = per_page.unwrap_or(50).clamp(1, max_per_page);
    let offset = (page.unwrap_or(1).max(1) - 1) * per_page;
    (per_page, offset)
}

/// Normalise the `extra` JSON field: turn `null` into an empty object `{}`.
fn normalize_extra(extra: &serde_json::Value) -> serde_json::Value {
    if extra.is_null() {
        serde_json::json!({})
    } else {
        extra.clone()
    }
}

/// Build a share URL string from a token and mode.
pub fn build_share_url(token: &str, mode: &str) -> String {
    if mode == "control" {
        format!("/shared/{}?mode=control", token)
    } else {
        format!("/shared/{}", token)
    }
}

/// Validate that a share mode value is either "view" or "control".
pub fn validate_share_mode(mode: &str) -> Result<String, AppError> {
    match mode {
        "view" | "control" => Ok(mode.to_string()),
        _ => Err(AppError::Validation(
            "mode must be 'view' or 'control'".into(),
        )),
    }
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

const DOT_MASK: &str = "••••••••";
const STAR_MASK: &str = "********";

/// Redact sensitive setting values for API responses.
fn redact_settings(settings: Vec<(String, String)>) -> Vec<(String, String)> {
    settings
        .into_iter()
        .map(|(k, v)| {
            if SENSITIVE_SETTINGS.iter().any(|s| k.contains(s)) {
                (k, STAR_MASK.to_string())
            } else {
                (k, v)
            }
        })
        .collect()
}

/// Validate that no restricted keys appear in the update payload.
fn validate_no_restricted_keys(settings: &[SettingKV]) -> Result<(), AppError> {
    for kv in settings {
        if RESTRICTED_SETTINGS.iter().any(|r| kv.key == *r) {
            return Err(AppError::Validation(format!(
                "Setting '{}' cannot be updated through this endpoint",
                kv.key
            )));
        }
    }
    Ok(())
}

pub async fn get_settings(
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let all = settings::get_all(&db.pool).await?;
    let redacted = redact_settings(all);
    let map: serde_json::Map<String, serde_json::Value> = redacted
        .into_iter()
        .map(|(k, v)| (k, serde_json::Value::String(v)))
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
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SettingsUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Block restricted keys — must use dedicated endpoints
    validate_no_restricted_keys(&body.settings)?;

    for kv in &body.settings {
        // If it's a sensitive key and matches a redaction mask, skip updating it
        if should_skip_masked_setting(&kv.key, &kv.value) {
            continue;
        }
        settings::set(&db.pool, &kv.key, &kv.value).await?;
    }
    audit::log(
        &db.pool,
        Some(user.id),
        "settings.updated",
        &json!({ "count": body.settings.len() }),
    )
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

// ── SSO ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SsoTestRequest {
    pub issuer_url: String,
    pub client_id: String,
    pub client_secret: String,
}

pub async fn test_sso_connection(
    State(state): State<SharedState>,
    Json(body): Json<SsoTestRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Validate issuer URL uses HTTPS
    if !body.issuer_url.starts_with("https://") {
        return Err(AppError::Validation("SSO issuer URL must use HTTPS".into()));
    }

    let mut client_secret = body.client_secret.clone();

    // If secret is masked or empty, try to recover from saved settings
    if client_secret == "********" || client_secret.is_empty() {
        let db = require_running(&state).await?;
        if let Some(saved) = settings::get(&db.pool, "sso_client_secret").await? {
            if saved.starts_with("vault:") {
                let vault_cfg = {
                    let s = state.read().await;
                    s.config.as_ref().and_then(|c| c.vault.clone())
                };
                if let Some(ref vc) = vault_cfg {
                    client_secret = crate::services::vault::unseal_setting(vc, &saved).await?;
                } else {
                    return Err(AppError::Validation(
                        "Vault must be configured to retrieve saved credentials".into(),
                    ));
                }
            } else {
                client_secret = saved;
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let discovery_url = build_oidc_discovery_url(&body.issuer_url);

    let resp = client.get(&discovery_url).send().await?;

    if !resp.status().is_success() {
        return Err(AppError::Validation(format!(
            "Failed to fetch OIDC configuration: HTTP {}",
            resp.status()
        )));
    }

    let config: serde_json::Value = resp.json().await?;

    // Basic validation of the OIDC configuration
    validate_oidc_config(&config)?;

    let token_endpoint = config.get("token_endpoint").and_then(|v| v.as_str());

    // Attempt to validate credentials if we have a secret
    if !client_secret.is_empty() && client_secret != "********" {
        if let Some(token_url) = token_endpoint {
            let token_resp = client
                .post(token_url)
                .basic_auth(&body.client_id, Some(&client_secret))
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("code", "verify-secret-test"),
                    ("redirect_uri", "http://localhost/callback"),
                ])
                .send()
                .await?;

            let status = token_resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err(AppError::Validation(
                    "OIDC provider rejected credentials (401 Unauthorized). Check Client ID and Secret.".into(),
                ));
            }

            // If we get 400 Bad Request with an invalid_grant error, it means the
            // Client ID and Secret were accepted, but the dummy code was rejected.
            // This counts as a successful credential verification.
            if status.is_client_error() && status != reqwest::StatusCode::UNAUTHORIZED {
                let error_body: serde_json::Value = token_resp.json().await.unwrap_or_default();
                let error_code = error_body
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // If it's a client authentication error, it's a failure.
                // Otherwise, if it's a grant/code error, it means the secret was correct.
                if error_code == "invalid_client" || error_code == "unauthorized_client" {
                    return Err(AppError::Validation(format!(
                        "OIDC provider rejected client: {error_code}. Check settings in Keycloak."
                    )));
                }
            }
        }
    }

    Ok(Json(json!({
        "status": "success",
        "message": "Successfully connected to OIDC issuer and validated configuration."
    })))
}

#[derive(Deserialize)]
pub struct SsoUpdateRequest {
    pub issuer_url: String,
    pub client_id: String,
    pub client_secret: String,
}

pub async fn update_sso(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SsoUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Validate issuer URL uses HTTPS
    if !body.issuer_url.starts_with("https://") {
        return Err(AppError::Validation("SSO issuer URL must use HTTPS".into()));
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
        settings::set(&db.pool, "sso_client_secret", &format!("vault:{}", encoded)).await?;
    } else {
        return Err(AppError::Config(
            "Vault must be configured before enabling SSO. Client secrets require encrypted storage.".into(),
        ));
    }

    audit::log(&db.pool, Some(user.id), "sso.configured", &json!({})).await?;
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
    Extension(user): Extension<AuthUser>,
    Json(body): Json<AuthMethodsUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
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
        Some(user.id),
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
    Extension(user): Extension<AuthUser>,
    Json(body): Json<VaultUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
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
        Some(user.id),
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
    Extension(user): Extension<AuthUser>,
    Json(body): Json<KerberosUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
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
        Some(user.id),
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
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateKerberosRealmRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Validate hostname-like values
    validate_kerberos_hostnames(
        Some(&body.realm),
        Some(&body.kdc_servers),
        Some(&body.admin_server),
    )?;

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
        Some(user.id),
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
    Extension(user): Extension<AuthUser>,
    Path(realm_id): Path<Uuid>,
    Json(body): Json<UpdateKerberosRealmRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Validate hostname-like values (parity with create)
    validate_kerberos_hostnames(
        body.realm.as_deref(),
        body.kdc_servers.as_deref(),
        body.admin_server.as_deref(),
    )?;

    // Use a transaction so unset-others + field update are atomic
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

    // Single UPDATE with COALESCE for each optional field
    let kdc_csv = body.kdc_servers.as_ref().map(|v| v.join(","));
    let result = sqlx::query(
        "UPDATE kerberos_realms SET
            realm = COALESCE($2, realm),
            kdc_servers = COALESCE($3, kdc_servers),
            admin_server = COALESCE($4, admin_server),
            ticket_lifetime = COALESCE($5, ticket_lifetime),
            renew_lifetime = COALESCE($6, renew_lifetime),
            is_default = COALESCE($7, is_default),
            updated_at = now()
         WHERE id = $1",
    )
    .bind(realm_id)
    .bind(body.realm.as_deref())
    .bind(kdc_csv.as_deref())
    .bind(body.admin_server.as_deref())
    .bind(body.ticket_lifetime.as_deref())
    .bind(body.renew_lifetime.as_deref())
    .bind(body.is_default)
    .execute(&mut *tx)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Kerberos realm not found".into()));
    }

    tx.commit().await?;

    regenerate_krb5_conf(&db.pool).await?;
    audit::log(
        &db.pool,
        Some(user.id),
        "kerberos.realm_updated",
        &json!({ "realm_id": realm_id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

pub async fn delete_kerberos_realm(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(realm_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
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
        Some(user.id),
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

    let configs = realm_rows_to_configs(&rows);

    tokio::task::spawn_blocking(move || {
        kerberos::write_krb5_conf_multi(&configs, "/etc/krb5/krb5.conf")
    })
    .await
    .map_err(|e| AppError::Internal(format!("krb5.conf task failed: {e}")))?
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
    Extension(user): Extension<AuthUser>,
    Json(body): Json<RecordingsUpdateRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;
    settings::set(
        &db.pool,
        "recordings_enabled",
        if body.enabled { "true" } else { "false" },
    )
    .await?;
    if let Some(days) = body.retention_days {
        settings::set(&db.pool, "recordings_retention_days", &days.to_string()).await?;
    }
    if let Some(ref st) = body.storage_type {
        settings::set(&db.pool, "recordings_storage_type", st).await?;
    }
    if let Some(ref name) = body.azure_account_name {
        settings::set(&db.pool, "recordings_azure_account_name", name).await?;
    }
    if let Some(ref container) = body.azure_container_name {
        settings::set(&db.pool, "recordings_azure_container_name", container).await?;
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
        Some(user.id),
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
    pub can_manage_system: bool,
    pub can_manage_users: bool,
    pub can_manage_connections: bool,
    pub can_view_audit_logs: bool,
    pub can_create_users: bool,
    pub can_create_user_groups: bool,
    pub can_create_connections: bool,
    pub can_create_connection_folders: bool,
    pub can_create_sharing_profiles: bool,
    pub can_view_sessions: bool,
}

pub async fn list_roles(State(state): State<SharedState>) -> Result<Json<Vec<RoleRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<RoleRow> =
        sqlx::query_as("SELECT id, name, can_manage_system, can_manage_users, can_manage_connections, can_view_audit_logs, can_create_users, can_create_user_groups, can_create_connections, can_create_connection_folders, can_create_sharing_profiles, can_view_sessions FROM roles ORDER BY name")
            .fetch_all(&db.pool)
            .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    pub can_manage_system: Option<bool>,
    pub can_manage_users: Option<bool>,
    pub can_manage_connections: Option<bool>,
    pub can_view_audit_logs: Option<bool>,
    pub can_create_users: Option<bool>,
    pub can_create_user_groups: Option<bool>,
    pub can_create_connections: Option<bool>,
    pub can_create_connection_folders: Option<bool>,
    pub can_create_sharing_profiles: Option<bool>,
    pub can_view_sessions: Option<bool>,
}

pub async fn create_role(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateRoleRequest>,
) -> Result<Json<RoleRow>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;
    let row: RoleRow = sqlx::query_as(
        "INSERT INTO roles (name, can_manage_system, can_manage_users, can_manage_connections, can_view_audit_logs, can_create_users, can_create_user_groups, can_create_connections, can_create_connection_folders, can_create_sharing_profiles, can_view_sessions) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
         RETURNING id, name, can_manage_system, can_manage_users, can_manage_connections, can_view_audit_logs, can_create_users, can_create_user_groups, can_create_connections, can_create_connection_folders, can_create_sharing_profiles, can_view_sessions",
    )
    .bind(&body.name)
    .bind(body.can_manage_system.unwrap_or(false))
    .bind(body.can_manage_users.unwrap_or(false))
    .bind(body.can_manage_connections.unwrap_or(false))
    .bind(body.can_view_audit_logs.unwrap_or(false))
    .bind(body.can_create_users.unwrap_or(false))
    .bind(body.can_create_user_groups.unwrap_or(false))
    .bind(body.can_create_connections.unwrap_or(false))
    .bind(body.can_create_connection_folders.unwrap_or(false))
    .bind(body.can_create_sharing_profiles.unwrap_or(false))
    .bind(body.can_view_sessions.unwrap_or(false))
    .fetch_one(&db.pool)
    .await?;
    audit::log(
        &db.pool,
        Some(user.id),
        "role.created",
        &json!({ "name": body.name }),
    )
    .await?;
    Ok(Json(row))
}

#[derive(Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    pub can_manage_system: Option<bool>,
    pub can_manage_users: Option<bool>,
    pub can_manage_connections: Option<bool>,
    pub can_view_audit_logs: Option<bool>,
    pub can_create_users: Option<bool>,
    pub can_create_user_groups: Option<bool>,
    pub can_create_connections: Option<bool>,
    pub can_create_connection_folders: Option<bool>,
    pub can_create_sharing_profiles: Option<bool>,
    pub can_view_sessions: Option<bool>,
}

pub async fn update_role(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(body): Json<UpdateRoleRequest>,
) -> Result<Json<RoleRow>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Single UPDATE with COALESCE for each optional field
    let row: RoleRow = sqlx::query_as(
        "UPDATE roles SET
            name = COALESCE($2, name),
            can_manage_system = COALESCE($3, can_manage_system),
            can_manage_users = COALESCE($4, can_manage_users),
            can_manage_connections = COALESCE($5, can_manage_connections),
            can_view_audit_logs = COALESCE($6, can_view_audit_logs),
            can_create_users = COALESCE($7, can_create_users),
            can_create_user_groups = COALESCE($8, can_create_user_groups),
            can_create_connections = COALESCE($9, can_create_connections),
            can_create_connection_folders = COALESCE($10, can_create_connection_folders),
            can_create_sharing_profiles = COALESCE($11, can_create_sharing_profiles),
            can_view_sessions = COALESCE($12, can_view_sessions)
         WHERE id = $1
         RETURNING id, name, can_manage_system, can_manage_users, can_manage_connections,
                   can_view_audit_logs, can_create_users, can_create_user_groups,
                   can_create_connections, can_create_connection_folders,
                   can_create_sharing_profiles, can_view_sessions",
    )
    .bind(id)
    .bind(body.name.as_deref())
    .bind(body.can_manage_system)
    .bind(body.can_manage_users)
    .bind(body.can_manage_connections)
    .bind(body.can_view_audit_logs)
    .bind(body.can_create_users)
    .bind(body.can_create_user_groups)
    .bind(body.can_create_connections)
    .bind(body.can_create_connection_folders)
    .bind(body.can_create_sharing_profiles)
    .bind(body.can_view_sessions)
    .fetch_one(&db.pool)
    .await?;

    audit::log(
        &db.pool,
        Some(user.id),
        "role.updated",
        &json!({ "id": id.to_string(), "name": row.name }),
    )
    .await?;

    Ok(Json(row))
}

pub async fn delete_role(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Protect system roles
    let role_name: String = sqlx::query_scalar("SELECT name FROM roles WHERE id = $1")
        .bind(id)
        .fetch_optional(&db.pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Role not found".into()))?;

    if role_name == "admin" || role_name == "user" {
        return Err(AppError::Validation(
            "System roles cannot be deleted".into(),
        ));
    }

    // Check if any users are using this role
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role_id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await?;

    if count > 0 {
        return Err(AppError::Validation(
            "Cannot delete role while users are assigned to it".into(),
        ));
    }

    sqlx::query("DELETE FROM roles WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;

    audit::log(
        &db.pool,
        Some(user.id),
        "role.deleted",
        &json!({ "id": id.to_string(), "name": role_name }),
    )
    .await?;

    Ok(Json(json!({ "status": "deleted" })))
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
    pub folder_id: Option<Uuid>,
    pub extra: serde_json::Value,
    pub last_accessed: Option<chrono::DateTime<chrono::Utc>>,
    pub watermark: String,
}

pub async fn list_connections(
    State(state): State<SharedState>,
) -> Result<Json<Vec<ConnectionRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<ConnectionRow> = sqlx::query_as(
        "SELECT id, name, protocol, hostname, port, domain, description, folder_id, extra, last_accessed, watermark FROM connections WHERE soft_deleted_at IS NULL ORDER BY name",
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
    pub folder_id: Option<Uuid>,
    #[serde(default)]
    pub extra: serde_json::Value,
    #[serde(default = "default_watermark")]
    pub watermark: String,
}

fn default_watermark() -> String {
    "inherit".to_string()
}

pub async fn create_connection(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateConnectionRequest>,
) -> Result<Json<ConnectionRow>, AppError> {
    crate::services::middleware::check_connection_management_permission(&user)?;
    let db = require_running(&state).await?;
    let port = body.port.unwrap_or(3389);
    let extra = normalize_extra(&body.extra);
    let row: ConnectionRow = sqlx::query_as(
        "INSERT INTO connections (name, protocol, hostname, port, domain, description, folder_id, extra, watermark)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, protocol, hostname, port, domain, description, folder_id, extra, last_accessed, watermark",
    )
    .bind(&body.name)
    .bind(&body.protocol)
    .bind(&body.hostname)
    .bind(port)
    .bind(&body.domain)
    .bind(&body.description)
    .bind(body.folder_id)
    .bind(&extra)
    .bind(&body.watermark)
    .fetch_one(&db.pool)
    .await?;
    audit::log(
        &db.pool,
        Some(user.id),
        "connection.created",
        &json!({ "name": body.name }),
    )
    .await?;
    Ok(Json(row))
}

pub async fn update_connection(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(body): Json<CreateConnectionRequest>,
) -> Result<Json<ConnectionRow>, AppError> {
    crate::services::middleware::check_connection_management_permission(&user)?;
    let db = require_running(&state).await?;
    let port = body.port.unwrap_or(3389);
    let extra = normalize_extra(&body.extra);
    let row: ConnectionRow = sqlx::query_as(
        "UPDATE connections SET name = $1, protocol = $2, hostname = $3, port = $4, domain = $5, description = $6, folder_id = $7, extra = $8, watermark = $9, updated_at = now()
         WHERE id = $10 AND soft_deleted_at IS NULL
         RETURNING id, name, protocol, hostname, port, domain, description, folder_id, extra, last_accessed, watermark",
    )
    .bind(&body.name)
    .bind(&body.protocol)
    .bind(&body.hostname)
    .bind(port)
    .bind(&body.domain)
    .bind(&body.description)
    .bind(body.folder_id)
    .bind(&extra)
    .bind(&body.watermark)
    .bind(id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;
    audit::log(
        &db.pool,
        Some(user.id),
        "connection.updated",
        &json!({ "id": id.to_string(), "name": body.name }),
    )
    .await?;
    Ok(Json(row))
}

pub async fn delete_connection(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_connection_management_permission(&user)?;
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
        Some(user.id),
        "connection.deleted",
        &json!({ "id": id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "deleted" })))
}

// ── Role-Connection mapping ────────────────────────────────────────────

#[derive(Deserialize)]
pub struct RoleMappingUpdate {
    pub connection_ids: Vec<Uuid>,
    pub folder_ids: Vec<Uuid>,
}

#[derive(Serialize)]
pub struct RoleMappings {
    pub connection_ids: Vec<Uuid>,
    pub folder_ids: Vec<Uuid>,
}

pub async fn get_role_mappings(
    State(state): State<SharedState>,
    axum::extract::Path(role_id): axum::extract::Path<Uuid>,
) -> Result<Json<RoleMappings>, AppError> {
    let db = require_running(&state).await?;

    let connection_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT connection_id FROM role_connections WHERE role_id = $1")
            .bind(role_id)
            .fetch_all(&db.pool)
            .await?;

    let folder_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT folder_id FROM role_folders WHERE role_id = $1")
            .bind(role_id)
            .fetch_all(&db.pool)
            .await?;

    Ok(Json(RoleMappings {
        connection_ids,
        folder_ids,
    }))
}

pub async fn update_role_mappings(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(role_id): axum::extract::Path<Uuid>,
    Json(body): Json<RoleMappingUpdate>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Replace all mappings for this role
    let mut tx = db.pool.begin().await?;

    // Connections
    sqlx::query("DELETE FROM role_connections WHERE role_id = $1")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    for cid in &body.connection_ids {
        sqlx::query("INSERT INTO role_connections (role_id, connection_id) VALUES ($1, $2)")
            .bind(role_id)
            .bind(cid)
            .execute(&mut *tx)
            .await?;
    }

    // Folders
    sqlx::query("DELETE FROM role_folders WHERE role_id = $1")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    for fid in &body.folder_ids {
        sqlx::query("INSERT INTO role_folders (role_id, folder_id) VALUES ($1, $2)")
            .bind(role_id)
            .bind(fid)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    audit::log(
        &db.pool,
        Some(user.id),
        "role_mappings.updated",
        &json!({ "role_id": role_id.to_string() }),
    )
    .await?;

    Ok(Json(json!({ "status": "updated" })))
}

// ── Users ──────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub full_name: Option<String>,
    pub auth_type: String,
    pub sub: Option<String>,
    pub role_name: String,
    pub deleted_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub email: String,
    pub full_name: Option<String>,
    pub role_id: Uuid,
    pub auth_type: String, // "local" or "sso"
}

#[derive(Deserialize)]
pub struct UpdateUserRequest {
    pub role_id: Uuid,
}

#[derive(Deserialize)]
pub struct UserListQuery {
    pub include_deleted: Option<bool>,
}

pub async fn list_users(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Query(query): axum::extract::Query<UserListQuery>,
) -> Result<Json<Vec<UserRow>>, AppError> {
    crate::services::middleware::check_user_management_permission(&user)?;
    let db = require_running(&state).await?;
    let include_deleted = query.include_deleted.unwrap_or(false);

    let rows: Vec<UserRow> = if include_deleted {
        sqlx::query_as(
            "SELECT u.id, u.username, u.email, u.full_name, u.auth_type, u.sub, r.name as role_name, u.deleted_at
             FROM users u JOIN roles r ON u.role_id = r.id
             WHERE u.deleted_at IS NOT NULL
             ORDER BY u.deleted_at DESC",
        )
        .fetch_all(&db.pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT u.id, u.username, u.email, u.full_name, u.auth_type, u.sub, r.name as role_name, u.deleted_at
             FROM users u JOIN roles r ON u.role_id = r.id
             WHERE u.deleted_at IS NULL
             ORDER BY u.email",
        )
        .fetch_all(&db.pool)
        .await?
    };
    Ok(Json(rows))
}

pub async fn restore_user(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_user_management_permission(&user)?;
    let db = require_running(&state).await?;
    let result =
        sqlx::query("UPDATE users SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL")
            .bind(id)
            .execute(&db.pool)
            .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Deleted user not found".into()));
    }

    audit::log(
        &db.pool,
        Some(user.id),
        "user.restored",
        &json!({ "id": id.to_string() }),
    )
    .await?;

    Ok(Json(json!({ "status": "restored" })))
}

pub async fn delete_user(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_user_management_permission(&user)?;
    let db = require_running(&state).await?;
    let result =
        sqlx::query("UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL")
            .bind(id)
            .execute(&db.pool)
            .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("User not found".into()));
    }

    audit::log(
        &db.pool,
        Some(user.id),
        "user.deleted",
        &json!({ "id": id.to_string() }),
    )
    .await?;

    Ok(Json(json!({ "status": "deleted" })))
}

pub async fn update_user(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(body): Json<UpdateUserRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_user_management_permission(&user)?;
    let db = require_running(&state).await?;

    // Verify the target role exists
    let role_exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM roles WHERE id = $1")
        .bind(body.role_id)
        .fetch_optional(&db.pool)
        .await?;

    if role_exists.is_none() {
        return Err(AppError::NotFound("Role not found".into()));
    }

    let result = sqlx::query("UPDATE users SET role_id = $1 WHERE id = $2 AND deleted_at IS NULL")
        .bind(body.role_id)
        .bind(id)
        .execute(&db.pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("User not found".into()));
    }

    audit::log(
        &db.pool,
        Some(user.id),
        "user.role_changed",
        &json!({ "user_id": id.to_string(), "role_id": body.role_id.to_string() }),
    )
    .await?;

    Ok(Json(json!({ "status": "updated" })))
}

pub async fn create_user(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateUserRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_user_management_permission(&user)?;
    let db = require_running(&state).await?;

    // Normalize email and username to lowercase for case-insensitive matching
    let email = body.email.to_lowercase();
    let username = body.username.to_lowercase();

    // Check if user already exists
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $2")
            .bind(&email)
            .bind(&username)
            .fetch_optional(&db.pool)
            .await?;

    if existing.is_some() {
        return Err(AppError::Validation(format!(
            "User with email {} already exists",
            email
        )));
    }

    let (password_hash, plaintext_password) = if body.auth_type == "local" {
        use rand::{distr::Alphanumeric, Rng};
        let gen_len = auth::MIN_PASSWORD_LENGTH.max(16);
        let plain: String = rand::rng()
            .sample_iter(Alphanumeric)
            .take(gen_len)
            .map(char::from)
            .collect();

        auth::validate_password(&plain)?;

        use argon2::{password_hash::SaltString, PasswordHasher};
        let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
        let hash = argon2::Argon2::default()
            .hash_password(plain.as_bytes(), &salt)
            .map_err(|e| AppError::Internal(format!("Argon2 error: {e}")))?
            .to_string();

        (Some(hash), Some(plain))
    } else {
        (None, None)
    };

    let user_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, username, email, full_name, password_hash, auth_type, role_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(user_id)
    .bind(&username)
    .bind(&email)
    .bind(&body.full_name)
    .bind(&password_hash)
    .bind(&body.auth_type)
    .bind(body.role_id)
    .execute(&db.pool)
    .await?;

    audit::log(
        &db.pool,
        Some(user.id),
        "user.created",
        &json!({
            "user_id": user_id,
            "email": body.email,
            "auth_type": body.auth_type
        }),
    )
    .await?;

    Ok(Json(json!({
        "id": user_id,
        "username": username,
        "password": plaintext_password // Returned only once for local users
    })))
}

/// POST /api/admin/users/:id/reset-password – generate a new password for a local user.
pub async fn reset_user_password(
    State(state): State<SharedState>,
    Extension(admin): Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_user_management_permission(&admin)?;
    let db = require_running(&state).await?;

    // Verify user exists and is a local account
    let auth_type: Option<String> =
        sqlx::query_scalar("SELECT auth_type FROM users WHERE id = $1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&db.pool)
            .await?;

    let auth_type = auth_type.ok_or_else(|| AppError::NotFound("User not found".into()))?;
    if auth_type != "local" {
        return Err(AppError::Validation(
            "Password reset is only available for local accounts".into(),
        ));
    }

    // Generate a new random password
    use rand::{distr::Alphanumeric, Rng};
    let gen_len = auth::MIN_PASSWORD_LENGTH.max(16);
    let plain: String = rand::rng()
        .sample_iter(Alphanumeric)
        .take(gen_len)
        .map(char::from)
        .collect();

    use argon2::{password_hash::SaltString, PasswordHasher};
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    let hash = argon2::Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map_err(|e| AppError::Internal(format!("Argon2 error: {e}")))?
        .to_string();

    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&hash)
        .bind(id)
        .execute(&db.pool)
        .await?;

    audit::log(
        &db.pool,
        Some(admin.id),
        "user.password_reset",
        &json!({ "target_user_id": id.to_string() }),
    )
    .await?;

    Ok(Json(json!({
        "password": plain
    })))
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
    pub connection_name: Option<String>,
}

#[derive(Deserialize)]
pub struct AuditLogQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

pub async fn list_audit_logs(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Query(query): axum::extract::Query<AuditLogQuery>,
) -> Result<Json<Vec<AuditLogRow>>, AppError> {
    crate::services::middleware::check_audit_permission(&user)?;
    let db = require_running(&state).await?;
    let (per_page, offset) = paginate(query.page, query.per_page, 200);

    let rows: Vec<AuditLogRow> = sqlx::query_as(
        "SELECT a.id, a.created_at, a.user_id, u.username, a.action_type, a.details, a.current_hash,
                c.name AS connection_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN connections c ON c.id = (a.details->>'connection_id')::uuid
         ORDER BY a.id DESC LIMIT $1 OFFSET $2",
    )
    .bind(per_page)
    .bind(offset)
    .fetch_all(&db.pool)
    .await?;
    Ok(Json(rows))
}

// ── Connection Folders ──────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct ConnectionFolderRow {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

pub async fn list_connection_folders(
    State(state): State<SharedState>,
) -> Result<Json<Vec<ConnectionFolderRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<ConnectionFolderRow> =
        sqlx::query_as("SELECT id, name, parent_id FROM connection_folders ORDER BY name")
            .fetch_all(&db.pool)
            .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateFolderRequest {
    pub name: String,
    pub parent_id: Option<Uuid>,
}

pub async fn create_connection_folder(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateFolderRequest>,
) -> Result<Json<ConnectionFolderRow>, AppError> {
    crate::services::middleware::check_connection_management_permission(&user)?;
    let db = require_running(&state).await?;
    let row: ConnectionFolderRow = sqlx::query_as(
        "INSERT INTO connection_folders (name, parent_id) VALUES ($1, $2) RETURNING id, name, parent_id",
    )
    .bind(&body.name)
    .bind(body.parent_id)
    .fetch_one(&db.pool)
    .await?;
    audit::log(
        &db.pool,
        Some(user.id),
        "connection_folder.created",
        &json!({ "name": body.name }),
    )
    .await?;
    Ok(Json(row))
}

#[derive(Deserialize)]
pub struct UpdateFolderRequest {
    pub name: String,
    pub parent_id: Option<Uuid>,
}

pub async fn update_connection_folder(
    State(state): State<SharedState>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(body): Json<UpdateFolderRequest>,
) -> Result<Json<ConnectionFolderRow>, AppError> {
    let db = require_running(&state).await?;
    let row: ConnectionFolderRow = sqlx::query_as(
        "UPDATE connection_folders SET name = $1, parent_id = $2 WHERE id = $3 RETURNING id, name, parent_id",
    )
    .bind(&body.name)
    .bind(body.parent_id)
    .bind(id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Folder not found".into()))?;
    Ok(Json(row))
}

pub async fn delete_connection_folder(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_connection_management_permission(&user)?;
    let db = require_running(&state).await?;
    let result = sqlx::query("DELETE FROM connection_folders WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Folder not found".into()));
    }
    audit::log(
        &db.pool,
        Some(user.id),
        "connection_folder.deleted",
        &json!({ "id": id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "deleted" })))
}

/// Encode a Guacamole protocol instruction as a `String` from opcode + args.
/// Format: `<opcode_len>.<opcode>,<arg1_len>.<arg1>,…;`
pub fn format_guac_inst(opcode: &str, args: &[&str]) -> String {
    let mut out = format!("{}.{}", opcode.len(), opcode);
    for arg in args {
        out.push_str(&format!(",{}.{}", arg.len(), arg));
    }
    out.push(';');
    out
}

// ── Active Sessions (NVR) ──────────────────────────────────────────

pub async fn list_active_sessions(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<crate::services::session_registry::SessionInfo>>, AppError> {
    crate::services::middleware::check_session_permission(&user)?;
    let _db = require_running(&state).await?;
    let registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };
    Ok(Json(registry.list().await))
}

#[derive(Deserialize)]
pub struct KillSessionsRequest {
    pub session_ids: Vec<String>,
}

pub async fn kill_sessions(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<KillSessionsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_session_permission(&user)?;
    let db = require_running(&state).await?;
    let registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };

    let mut killed_count = 0;
    for id in &body.session_ids {
        if registry.terminate(id).await {
            killed_count += 1;
        }
    }

    audit::log(
        &db.pool,
        Some(user.id),
        "sessions.killed",
        &json!({ "count": killed_count, "ids": body.session_ids }),
    )
    .await?;

    Ok(Json(
        json!({ "status": "success", "killed_count": killed_count }),
    ))
}

#[derive(Deserialize)]
pub struct ObserveQuery {
    /// How many seconds back to replay (0 = live only, 300 = full 5-min buffer)
    pub offset: Option<u64>,
    /// Playback speed multiplier for replay (default: 4.0).
    /// Values >1 speed up, 1.0 = real-time, 0 = dump as fast as possible.
    pub speed: Option<f64>,
}

pub async fn observe_session(
    ws: axum::extract::WebSocketUpgrade,
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<ObserveQuery>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    crate::services::middleware::check_session_permission(&user)?;
    let _db = require_running(&state).await?;
    let registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };

    let session = registry
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::NotFound("Active session not found".into()))?;

    observe_session_ws(ws, session, query).await
}

/// Core observe logic shared by admin and user observe endpoints.
pub async fn observe_session_ws(
    ws: axum::extract::WebSocketUpgrade,
    session: std::sync::Arc<crate::services::session_registry::ActiveSession>,
    query: ObserveQuery,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let offset = query.offset.unwrap_or(300); // default: replay full buffer
    let speed = query.speed.unwrap_or(4.0).max(0.0); // default 4× speed

    // Always fetch the full buffer so that short rewinds (e.g. 30s) still
    // receive the base-state drawing instructions (initial PNG tiles,
    // terminal background, etc.) that were sent earlier.  The replay is
    // then split into a fast base-state dump + a paced replay window.
    let (size_inst, all_frames, mut rx) = {
        let buffer = session.buffer.read().await;
        let size = buffer.last_size().map(|s| s.to_string());
        let timed = buffer.frames_with_timing(300); // full buffer
        let rx = session.broadcast_tx.subscribe();
        (size, timed, rx)
    };

    // Total duration of the full buffer in ms
    let total_buffer_ms = all_frames.last().map(|(t, _)| *t).unwrap_or(0);

    // The paced replay window starts at this offset from the end.
    // Everything before it is base-state that gets dumped instantly.
    let is_live_only = offset == 0;
    let offset_ms = offset * 1000;
    let offset_boundary_ms = total_buffer_ms.saturating_sub(offset_ms);

    // Split frames into base-state dump and paced replay.
    let split_idx = if is_live_only {
        all_frames.len() // everything is an instant dump for "jump to live"
    } else {
        all_frames
            .iter()
            .position(|(t, _)| *t >= offset_boundary_ms)
            .unwrap_or(all_frames.len())
    };

    // Duration of only the paced-replay portion (for the frontend progress bar)
    let paced_duration_ms = if split_idx < all_frames.len() {
        all_frames.last().map(|(t, _)| *t).unwrap_or(0) - all_frames[split_idx].0
    } else {
        0
    };

    // Clone the buffer Arc so Phase 2 can rebuild the display on lag.
    let buffer_for_recovery = session.buffer.clone();

    Ok(ws
        .protocols(["guacamole"])
        .on_upgrade(move |mut socket| async move {
            use axum::extract::ws::Message;

            // Send replay metadata so the frontend can render the timeline.
            // Args: [paced_duration_ms, speed, buffer_depth_ms, offset_secs]
            let total_str = paced_duration_ms.to_string();
            let speed_str = format!("{speed}");
            let depth_str = total_buffer_ms.to_string();
            let offset_str = offset.to_string();
            let header = format_guac_inst("nvrheader", &[&total_str, &speed_str, &depth_str, &offset_str]);
            if socket.send(Message::Text(header)).await.is_err() {
                return;
            }

            // Send last-known size instruction first
            if let Some(size_inst) = size_inst {
                if socket.send(Message::Text(size_inst)).await.is_err() {
                    return;
                }
            }

            // ── Phase 1a: Base-state fast dump ──────────────────────
            //
            // Send all frames from before the paced-replay window
            // instantly (no pacing). Sync instructions are stripped at
            // the instruction level so the Guacamole client accumulates
            // all drawing ops without flushing intermediate states.
            // A single sync is sent afterward to flush the display so
            // the user sees the screen state at the rewind point.
            let mut last_sync_inst: Option<String> = None;

            for (_, frame) in all_frames.iter().take(split_idx) {

                // Strip sync instructions from the chunk (a single frame
                // can contain multiple Guacamole instructions like
                // "3.png,...;4.sync,...;3.cursor,...;")
                let mut stripped = String::with_capacity(frame.len());
                for inst in frame.split_inclusive(';') {
                    let trimmed = inst.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if trimmed.starts_with("4.sync,") || trimmed == "4.sync" {
                        last_sync_inst = Some(inst.to_string());
                    } else {
                        stripped.push_str(inst);
                    }
                }

                if !stripped.is_empty()
                    && socket.send(Message::Text(stripped)).await.is_err()
                {
                    return;
                }
            }

            // Flush the base state with the last sync so the display
            // renders all accumulated drawing ops as one atomic frame.
            if let Some(sync) = last_sync_inst.take() {
                if socket.send(Message::Text(sync)).await.is_err() {
                    return;
                }
            }

            // ── Phase 1b: Paced replay ──────────────────────────────
            //
            // Send the frames within the rewind window with proportional
            // pacing.  Syncs are sent as-is here because the pacing
            // gives the client time to render each frame naturally.
            let paced_origin_ms = if split_idx < all_frames.len() {
                all_frames[split_idx].0
            } else {
                0
            };

            for i in split_idx..all_frames.len() {
                let (delay_ms, ref frame) = all_frames[i];

                // Pace replay
                if speed > 0.0 && i > split_idx {
                    let prev_ms = all_frames[i - 1].0;
                    let gap = delay_ms.saturating_sub(prev_ms);
                    if gap > 0 {
                        let adjusted = (gap as f64 / speed) as u64;
                        let sleep_ms = adjusted.min(500);
                        if sleep_ms > 5 {
                            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms))
                                .await;
                        }
                    }
                }

                // Progress marker (relative to the paced portion)
                if (i - split_idx) % 20 == 0 || i == all_frames.len() - 1 {
                    let progress_ms = delay_ms.saturating_sub(paced_origin_ms);
                    let ms_str = progress_ms.to_string();
                    let progress = format_guac_inst("nvrprogress", &[&ms_str]);
                    if socket.send(Message::Text(progress)).await.is_err() {
                        return;
                    }
                }

                if socket.send(Message::Text(frame.clone())).await.is_err() {
                    return;
                }
            }

            // Send replay-done marker so the frontend knows we're now live
            let done = format_guac_inst("nvrreplaydone", &[]);
            let _ = socket.send(Message::Text(done)).await;

            // Phase 2: Forward live frames from the broadcast channel while
            // draining client-sent messages (e.g. Guacamole tunnel pings)
            // and sending periodic keep-alive nops to prevent client-side
            // tunnel timeouts during idle periods.
            //
            // Two additional safeguards:
            //
            // a) **Lag recovery** — if the broadcast receiver falls behind
            //    (e.g. during a burst of drawing instructions) the skipped
            //    frames may include critical image tiles, leaving the
            //    observer's display corrupted or black.  On lag we dump the
            //    current ring buffer with sync-stripping to atomically
            //    rebuild the full display state.
            //
            // b) **Idle sync keepalive** — when the remote session is truly
            //    idle, guacd sends nothing.  Without any rendering commands
            //    the browser may optimise away the canvas resources.  A
            //    periodic `sync` instruction keeps the Guacamole Display
            //    flushed so the canvases stay alive.
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_frame_at = std::time::Instant::now();

            loop {
                tokio::select! {
                    result = rx.recv() => {
                        match result {
                            Ok(frame) => {
                                last_frame_at = std::time::Instant::now();
                                if socket.send(Message::Text((*frame).clone())).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!("NVR observer lagged {n} frames — rebuilding display");

                                // Dump the full buffer with sync-stripping so the
                                // display rebuilds atomically in one shot.
                                let buf = buffer_for_recovery.read().await;
                                let rebuild = buf.frames_with_timing(300);
                                drop(buf);

                                let mut send_ok = true;
                                for (_, chunk) in &rebuild {
                                    let mut stripped = String::with_capacity(chunk.len());
                                    for inst in chunk.split_inclusive(';') {
                                        let t = inst.trim();
                                        if !t.is_empty()
                                            && !t.starts_with("4.sync,")
                                            && t != "4.sync"
                                        {
                                            stripped.push_str(inst);
                                        }
                                    }
                                    if !stripped.is_empty()
                                        && socket.send(Message::Text(stripped)).await.is_err()
                                    {
                                        send_ok = false;
                                        break;
                                    }
                                }
                                if !send_ok { break; }

                                // Flush the rebuilt state with one sync
                                let ts = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis()
                                    .to_string();
                                let sync = format_guac_inst("sync", &[&ts]);
                                if socket.send(Message::Text(sync)).await.is_err() {
                                    break;
                                }
                                last_frame_at = std::time::Instant::now();
                            }
                            Err(_) => break, // channel closed (session ended)
                        }
                    }
                    // Drain any incoming messages (pings, etc.) to prevent
                    // the receive buffer from growing unbounded.
                    msg = socket.recv() => {
                        if msg.is_none() {
                            break; // client disconnected
                        }
                        // Discard message content — observe is one-way
                    }
                    _ = keepalive.tick() => {
                        // nop keeps the WebSocket tunnel alive
                        if socket.send(Message::Text("3.nop;".into())).await.is_err() {
                            break;
                        }
                        // During idle periods, send a sync instruction so
                        // the Guacamole Display flushes its compositor.
                        // This prevents the browser from reclaiming canvas
                        // GPU/memory resources for idle canvases (which
                        // manifests as the view going black).
                        if last_frame_at.elapsed() > std::time::Duration::from_secs(5) {
                            let ts = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis()
                                .to_string();
                            let sync = format_guac_inst("sync", &[&ts]);
                            if socket.send(Message::Text(sync)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
        }))
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

    // ── Dynamic capacity recommendation based on host resources ──
    //
    // Read system CPU and memory via sysinfo.  Reserve 30% headroom for
    // other processes (backend, nginx, postgres, OS).  Use the more
    // constraining of the CPU-bound and memory-bound estimates.
    //
    // Per-session resource estimates (weighted average across RDP/VNC/SSH):
    //   RAM  ≈ 150 MB   (RDP ~200, VNC ~100, SSH ~20)
    //   CPU  ≈ 0.15 cores (RDP ~0.25, VNC ~0.10, SSH ~0.02)
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    let total_mem = sys.total_memory(); // bytes
    let cpu_cores = {
        sys.refresh_cpu_list(sysinfo::CpuRefreshKind::default());
        sys.cpus().len() as u64
    };

    metrics.system_total_memory = total_mem;
    metrics.system_cpu_cores = cpu_cores as u32;

    const USABLE_FRACTION: f64 = 0.70; // reserve 30% for OS / sidecar processes
    const RAM_PER_SESSION_MB: f64 = 150.0;
    const CPU_PER_SESSION: f64 = 0.15;

    let usable_mem_mb = (total_mem as f64 / 1_048_576.0) * USABLE_FRACTION;
    let usable_cpu = cpu_cores as f64 * USABLE_FRACTION;

    let by_mem = (usable_mem_mb / RAM_PER_SESSION_MB) as u32;
    let by_cpu = (usable_cpu / CPU_PER_SESSION) as u32;

    // Bottleneck governs; divide by pool size for per-instance recommendation.
    let total_recommended = by_mem.min(by_cpu).max(1);
    metrics.recommended_per_instance = (total_recommended / pool_size).max(1);

    Ok(Json(metrics))
}

// ── AD Sync Config CRUD ────────────────────────────────────────────────

use crate::services::ad_sync::{AdSyncConfig, AdSyncRun};

pub async fn list_ad_sync_configs(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<AdSyncConfig>>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;
    let mut rows: Vec<AdSyncConfig> =
        sqlx::query_as("SELECT * FROM ad_sync_configs ORDER BY label")
            .fetch_all(&db.pool)
            .await?;
    // Redact bind_password — never expose encrypted or plaintext secrets to clients
    for r in &mut rows {
        if !r.bind_password.is_empty() {
            r.bind_password = DOT_MASK.into();
        }
    }
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateAdSyncConfigRequest {
    pub id: Option<Uuid>,
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
    pub folder_id: Option<Uuid>,
    pub tls_skip_verify: Option<bool>,
    pub sync_interval_minutes: Option<i32>,
    pub enabled: Option<bool>,
    pub auth_method: Option<String>,
    pub keytab_path: Option<String>,
    pub krb5_principal: Option<String>,
    pub ca_cert_pem: Option<String>,
    pub clone_from: Option<Uuid>,
    /// Default Guacamole parameters applied to every synced connection.
    #[serde(default)]
    pub connection_defaults: Option<serde_json::Value>,
}

pub async fn create_ad_sync_config(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateAdSyncConfigRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Validate LDAP URL uses a safe scheme
    validate_ldap_url(&body.ldap_url)?;

    // Validate search filter has balanced parentheses (basic LDAP filter sanity)
    if let Some(ref filter) = body.search_filter {
        validate_ldap_filter(filter)?;
    }

    // Encrypt bind_password via Vault if configured
    let mut bind_password = body.bind_password.as_deref().unwrap_or("").to_string();

    // Resolve password if it's a mask and we are cloning
    if bind_password == DOT_MASK || bind_password == STAR_MASK {
        if let Some(id) = body.clone_from {
            let existing: Option<String> =
                sqlx::query_scalar("SELECT bind_password FROM ad_sync_configs WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&db.pool)
                    .await?;
            if let Some(pw) = existing {
                bind_password = pw;
            }
        }
    }

    let stored_password = if !bind_password.is_empty() {
        if bind_password.starts_with("vault:") {
            bind_password
        } else {
            let vault_cfg = {
                let s = state.read().await;
                s.config.as_ref().and_then(|c| c.vault.clone())
            };
            if let Some(ref vc) = vault_cfg {
                crate::services::vault::seal_setting(vc, &bind_password).await?
            } else {
                bind_password
            }
        }
    } else {
        String::new()
    };

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO ad_sync_configs (label, ldap_url, bind_dn, bind_password, search_bases, search_filter, search_scope, protocol, default_port, domain_override, folder_id, tls_skip_verify, sync_interval_minutes, enabled, auth_method, keytab_path, krb5_principal, ca_cert_pem, connection_defaults)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id",
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
    .bind(body.folder_id)
    .bind(body.tls_skip_verify.unwrap_or(false))
    .bind(body.sync_interval_minutes.unwrap_or(60))
    .bind(body.enabled.unwrap_or(true))
    .bind(body.auth_method.as_deref().unwrap_or("simple"))
    .bind(body.keytab_path.as_deref())
    .bind(body.krb5_principal.as_deref())
    .bind(body.ca_cert_pem.as_deref())
    .bind(body.connection_defaults.as_ref().unwrap_or(&serde_json::json!({})))
    .fetch_one(&db.pool)
    .await?;

    settings::set(&db.pool, "ad_sync_enabled", "true").await?;
    audit::log(
        &db.pool,
        Some(user.id),
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
    pub folder_id: Option<Uuid>,
    pub tls_skip_verify: Option<bool>,
    pub sync_interval_minutes: Option<i32>,
    pub enabled: Option<bool>,
    pub auth_method: Option<String>,
    pub keytab_path: Option<String>,
    pub krb5_principal: Option<String>,
    pub ca_cert_pem: Option<String>,
    /// Default Guacamole parameters applied to every synced connection.
    pub connection_defaults: Option<serde_json::Value>,
}

pub async fn update_ad_sync_config(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateAdSyncConfigRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
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
        validate_ldap_url(v)?;
    }

    // Validate search_filter if being updated (parity with create)
    if let Some(ref filter) = body.search_filter {
        validate_ldap_filter(filter)?;
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
        // Only update if not one of the redaction markers
        if v != DOT_MASK && v != STAR_MASK {
            // Encrypt bind_password via Vault if configured
            let stored = if !v.is_empty() {
                if v.starts_with("vault:") {
                    v.clone()
                } else {
                    let vault_cfg = {
                        let s = state.read().await;
                        s.config.as_ref().and_then(|c| c.vault.clone())
                    };
                    if let Some(ref vc) = vault_cfg {
                        crate::services::vault::seal_setting(vc, v).await?
                    } else {
                        v.clone()
                    }
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
    if let Some(v) = body.folder_id {
        sqlx::query("UPDATE ad_sync_configs SET folder_id = $1, updated_at = now() WHERE id = $2")
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
    if let Some(ref v) = body.connection_defaults {
        sqlx::query(
            "UPDATE ad_sync_configs SET connection_defaults = $1, updated_at = now() WHERE id = $2",
        )
        .bind(v)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    audit::log(
        &db.pool,
        Some(user.id),
        "ad_sync.config_updated",
        &json!({ "id": id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "updated" })))
}

pub async fn delete_ad_sync_config(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
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
        Some(user.id),
        "ad_sync.config_deleted",
        &json!({ "id": id.to_string() }),
    )
    .await?;
    Ok(Json(json!({ "status": "deleted" })))
}

// ── Trigger manual sync ────────────────────────────────────────────────

pub async fn trigger_ad_sync(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;
    let mut config: AdSyncConfig = sqlx::query_as("SELECT * FROM ad_sync_configs WHERE id = $1")
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
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateAdSyncConfigRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;

    // Resolve password: if it's a mask, fetch from DB. Then unseal.
    let mut bind_password = body.bind_password.clone().unwrap_or_default();
    if bind_password == DOT_MASK || bind_password == STAR_MASK {
        if let Some(id) = body.id {
            let existing: Option<String> =
                sqlx::query_scalar("SELECT bind_password FROM ad_sync_configs WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&db.pool)
                    .await?;
            if let Some(pw) = existing {
                bind_password = pw;
            }
        } else if let Some(clone_id) = body.clone_from {
            let existing: Option<String> =
                sqlx::query_scalar("SELECT bind_password FROM ad_sync_configs WHERE id = $1")
                    .bind(clone_id)
                    .fetch_optional(&db.pool)
                    .await?;
            if let Some(pw) = existing {
                bind_password = pw;
            }
        }
    }

    // Now unseal the password if it's vault-prefixed
    let vault_cfg = {
        let s = state.read().await;
        s.config.as_ref().and_then(|c| c.vault.clone())
    };
    if let Some(ref vc) = vault_cfg {
        if bind_password.starts_with("vault:") {
            bind_password = crate::services::vault::unseal_setting(vc, &bind_password).await?;
        }
    }

    // Build a temporary AdSyncConfig from the request body
    let config = AdSyncConfig {
        id: body.id.unwrap_or(Uuid::nil()),
        label: body.label.clone(),
        ldap_url: body.ldap_url.clone(),
        bind_dn: body.bind_dn.clone().unwrap_or_default(),
        bind_password,
        search_bases: body.search_bases.clone(),
        search_filter: body.search_filter.clone().unwrap_or_else(|| {
            "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))".into()
        }),
        search_scope: body.search_scope.clone().unwrap_or_else(|| "subtree".into()),
        protocol: body.protocol.clone().unwrap_or_else(|| "rdp".into()),
        default_port: body.default_port.unwrap_or(3389),
        domain_override: body.domain_override.clone(),
        folder_id: body.folder_id,
        tls_skip_verify: body.tls_skip_verify.unwrap_or(false),
        sync_interval_minutes: body.sync_interval_minutes.unwrap_or(60),
        enabled: body.enabled.unwrap_or(true),
        auth_method: body.auth_method.clone().unwrap_or_else(|| "simple".into()),
        keytab_path: body.keytab_path.clone(),
        krb5_principal: body.krb5_principal.clone(),
        ca_cert_pem: body.ca_cert_pem.clone(),
        connection_defaults: body.connection_defaults.clone().unwrap_or(serde_json::json!({})),
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
    Extension(user): Extension<AuthUser>,
    Path(config_id): Path<Uuid>,
) -> Result<Json<Vec<AdSyncRun>>, AppError> {
    crate::services::middleware::check_system_permission(&user)?;
    let db = require_running(&state).await?;
    let rows: Vec<AdSyncRun> = sqlx::query_as(
        "SELECT * FROM ad_sync_runs WHERE config_id = $1 ORDER BY started_at DESC LIMIT 50",
    )
    .bind(config_id)
    .fetch_all(&db.pool)
    .await?;
    Ok(Json(rows))
}

// ── Admin Tags (global, forced to all users) ──────────────────────────

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct AdminTag {
    pub id: Uuid,
    pub name: String,
    pub color: String,
    pub created_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAdminTagReq {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAdminTagReq {
    pub name: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetAdminConnectionTagsReq {
    pub connection_id: Uuid,
    pub tag_ids: Vec<Uuid>,
}

pub async fn list_admin_tags(
    State(state): State<SharedState>,
) -> Result<Json<Vec<AdminTag>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<AdminTag> =
        sqlx::query_as("SELECT id, name, color, created_at FROM admin_tags ORDER BY name")
            .fetch_all(&db.pool)
            .await?;
    Ok(Json(rows))
}

pub async fn create_admin_tag(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateAdminTagReq>,
) -> Result<Json<AdminTag>, AppError> {
    crate::services::middleware::check_connection_management_permission(&user)?;
    let db = require_running(&state).await?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.len() > 50 {
        return Err(AppError::Validation(
            "Tag name must be 1-50 characters".into(),
        ));
    }
    let color = body.color.unwrap_or_else(|| "#6366f1".to_string());
    if !crate::routes::user::is_valid_hex_color(&color) {
        return Err(AppError::Validation("Color must be a valid hex color (e.g. #ff00aa)".into()));
    }
    let tag: AdminTag = sqlx::query_as(
        "INSERT INTO admin_tags (name, color) VALUES ($1, $2) RETURNING id, name, color, created_at",
    )
    .bind(&name)
    .bind(&color)
    .fetch_one(&db.pool)
    .await?;
    Ok(Json(tag))
}

pub async fn update_admin_tag(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(tag_id): Path<Uuid>,
    Json(body): Json<UpdateAdminTagReq>,
) -> Result<Json<AdminTag>, AppError> {
    crate::services::middleware::check_connection_management_permission(&user)?;
    let db = require_running(&state).await?;
    if let Some(ref n) = body.name {
        let n = n.trim();
        if n.is_empty() || n.len() > 50 {
            return Err(AppError::Validation(
                "Tag name must be 1-50 characters".into(),
            ));
        }
    }
    if let Some(ref c) = body.color {
        if !crate::routes::user::is_valid_hex_color(c) {
            return Err(AppError::Validation("Color must be a valid hex color (e.g. #ff00aa)".into()));
        }
    }
    let tag: AdminTag = sqlx::query_as(
        "UPDATE admin_tags SET name = COALESCE($2, name), color = COALESCE($3, color) WHERE id = $1 RETURNING id, name, color, created_at",
    )
    .bind(tag_id)
    .bind(&body.name)
    .bind(&body.color)
    .fetch_one(&db.pool)
    .await?;
    Ok(Json(tag))
}

pub async fn delete_admin_tag(
    State(state): State<SharedState>,
    Path(tag_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    sqlx::query("DELETE FROM admin_tags WHERE id = $1")
        .bind(tag_id)
        .execute(&db.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_admin_connection_tags(
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<(Uuid, Uuid)> =
        sqlx::query_as("SELECT connection_id, tag_id FROM admin_connection_tags")
            .fetch_all(&db.pool)
            .await?;

    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (conn_id, tag_id) in rows {
        map.entry(conn_id.to_string())
            .or_default()
            .push(tag_id.to_string());
    }
    Ok(Json(json!(map)))
}

pub async fn set_admin_connection_tags(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SetAdminConnectionTagsReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::services::middleware::check_connection_management_permission(&user)?;
    let db = require_running(&state).await?;
    let mut tx = db.pool.begin().await?;
    sqlx::query("DELETE FROM admin_connection_tags WHERE connection_id = $1")
        .bind(body.connection_id)
        .execute(&mut *tx)
        .await?;
    if !body.tag_ids.is_empty() {
        sqlx::query(
            "INSERT INTO admin_connection_tags (connection_id, tag_id)
             SELECT $1, unnest($2::uuid[])
             ON CONFLICT DO NOTHING",
        )
        .bind(body.connection_id)
        .bind(&body.tag_ids)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
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
        let json =
            r#"{"realm":"CORP.LOCAL","kdc":["kdc1.corp.local"],"admin_server":"admin.corp.local"}"#;
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
        let json = r#"{"role_id":"550e8400-e29b-41d4-a716-446655440000","connection_ids":[],"folder_ids":[]}"#;
        let r: RoleMappingUpdate = serde_json::from_str(json).unwrap();
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
    fn create_folder_request_deser() {
        let r: CreateFolderRequest = serde_json::from_str(r#"{"name":"servers"}"#).unwrap();
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
        let json =
            r#"{"settings":[{"key":"theme","value":"dark"},{"key":"timeout","value":"30"}]}"#;
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
        assert!(r.clone_from.is_none());
    }

    #[test]
    fn create_ad_sync_config_request_clone() {
        let clone_id = Uuid::new_v4();
        let json = format!(
            r#"{{"label":"Clone","ldap_url":"ldap://dc.corp.local","search_bases":[],"clone_from":"{}"}}"#,
            clone_id
        );
        let r: CreateAdSyncConfigRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(r.label, "Clone");
        assert_eq!(r.clone_from, Some(clone_id));
    }

    #[test]
    fn update_ad_sync_config_request_deser() {
        let json = r#"{"label":"New Label","enabled":false}"#;
        let r: UpdateAdSyncConfigRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.label.unwrap(), "New Label");
        assert!(!r.enabled.unwrap());
        assert!(r.ldap_url.is_none());
    }

    #[test]
    fn sso_test_request_deser() {
        let json = r#"{"issuer_url":"https://sso.example.com","client_id":"id","client_secret":"********"}"#;
        let r: SsoTestRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.issuer_url, "https://sso.example.com");
        assert_eq!(r.client_id, "id");
        assert_eq!(r.client_secret, "********");
    }

    // ── Serialization tests for Serialize-derived structs ──────────

    #[test]
    fn role_row_serializes() {
        let r = RoleRow {
            id: Uuid::nil(),
            name: "admin".into(),
            can_manage_system: false,
            can_manage_users: false,
            can_manage_connections: false,
            can_view_audit_logs: false,
            can_create_users: false,
            can_create_user_groups: false,
            can_create_connections: false,
            can_create_connection_folders: false,
            can_create_sharing_profiles: false,
            can_view_sessions: false,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["name"], "admin");
    }

    #[test]
    fn connection_row_serializes() {
        let r = ConnectionRow {
            id: Uuid::nil(),
            name: "server-1".into(),
            protocol: "rdp".into(),
            hostname: "10.0.0.1".into(),
            port: 3389,
            domain: Some("CORP".into()),
            description: "Prod".into(),
            folder_id: None,
            extra: serde_json::json!({"color-depth": "24"}),
            last_accessed: None,
            watermark: "inherit".into(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["hostname"], "10.0.0.1");
        assert_eq!(v["port"], 3389);
        assert_eq!(v["domain"], "CORP");
        assert!(v["last_accessed"].is_null());
    }

    #[test]
    fn connection_folder_row_serializes() {
        let r = ConnectionFolderRow {
            id: Uuid::nil(),
            name: "Production".into(),
            parent_id: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["name"], "Production");
        assert!(v["parent_id"].is_null());
    }

    #[test]
    fn kerberos_realm_row_serializes() {
        let r = KerberosRealmRow {
            id: Uuid::nil(),
            realm: "CORP.LOCAL".into(),
            kdc_servers: "kdc1.corp.local,kdc2.corp.local".into(),
            admin_server: "admin.corp.local".into(),
            ticket_lifetime: "24h".into(),
            renew_lifetime: "7d".into(),
            is_default: true,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["realm"], "CORP.LOCAL");
        assert_eq!(v["is_default"], true);
    }

    #[test]
    fn user_row_serializes() {
        let r = UserRow {
            id: Uuid::nil(),
            username: "admin".into(),
            email: "admin@corp.local".into(),
            full_name: Some("Admin User".into()),
            auth_type: "local".into(),
            sub: None,
            role_name: "admin".into(),
            deleted_at: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["username"], "admin");
        assert_eq!(v["auth_type"], "local");
        assert!(v["sub"].is_null());
        assert!(v["deleted_at"].is_null());
    }

    #[test]
    fn user_row_serializes_with_deleted_at() {
        let deleted_at = chrono::Utc::now();
        let r = UserRow {
            id: Uuid::nil(),
            username: "deleted-user".into(),
            email: "deleted@corp.local".into(),
            full_name: None,
            auth_type: "local".into(),
            sub: None,
            role_name: "user".into(),
            deleted_at: Some(deleted_at),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["username"], "deleted-user");
        assert!(v["deleted_at"].is_string());
    }

    #[test]
    fn user_list_query_deser() {
        let q: UserListQuery = serde_json::from_str("{}").unwrap();
        assert!(q.include_deleted.is_none());

        let q: UserListQuery = serde_json::from_str(r#"{"include_deleted":true}"#).unwrap();
        assert!(q.include_deleted.unwrap());

        let q: UserListQuery = serde_json::from_str(r#"{"include_deleted":false}"#).unwrap();
        assert!(!q.include_deleted.unwrap());
    }

    #[test]
    fn create_user_request_deser() {
        let json = r#"{"username":"newuser","email":"new@corp.local","role_id":"550e8400-e29b-41d4-a716-446655440000","auth_type":"local"}"#;
        let r: CreateUserRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.username, "newuser");
        assert_eq!(r.auth_type, "local");
    }

    #[test]
    fn update_kerberos_realm_request_deser() {
        let json = r#"{"realm":"CORP","kdc_servers":["kdc1"]}"#;
        let r: UpdateKerberosRealmRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.realm.as_deref(), Some("CORP"));
        assert!(r.admin_server.is_none());
        assert!(r.ticket_lifetime.is_none());
    }

    #[test]
    fn create_connection_request_rejects_missing_name() {
        let json = r#"{"protocol":"rdp","hostname":"10.0.0.1"}"#;
        let r: Result<CreateConnectionRequest, _> = serde_json::from_str(json);
        assert!(r.is_err());
    }

    #[test]
    fn recordings_update_request_full() {
        let json = r#"{"enabled":true,"retention_days":30,"storage_type":"azure","azure_account_name":"acc","azure_container_name":"cont","azure_access_key":"key"}"#;
        let r: RecordingsUpdateRequest = serde_json::from_str(json).unwrap();
        assert!(r.enabled);
        assert_eq!(r.retention_days.unwrap(), 30);
        assert_eq!(r.storage_type.as_deref(), Some("azure"));
        assert_eq!(r.azure_account_name.as_deref(), Some("acc"));
    }

    #[test]
    fn is_safe_hostname_allows_underscores() {
        assert!(is_safe_hostname("my_host_name"));
    }

    #[test]
    fn is_safe_hostname_allows_dots_and_ports() {
        assert!(is_safe_hostname("kdc.corp.local:88"));
        assert!(is_safe_hostname("192.168.1.1:389"));
    }

    #[tokio::test]
    async fn require_running_returns_error_in_setup_phase() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let state: SharedState = Arc::new(RwLock::new(crate::services::app_state::AppState {
            phase: crate::services::app_state::BootPhase::Setup,
            config: None,
            db: None,
            session_registry: crate::services::session_registry::SessionRegistry::new(),
            guacd_pool: None,
            file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                "/tmp/strata-files",
            )).await,
            started_at: std::time::Instant::now(),
        }));
        let result = require_running(&state).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn require_running_returns_error_when_no_db() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let state: SharedState = Arc::new(RwLock::new(crate::services::app_state::AppState {
            phase: crate::services::app_state::BootPhase::Running,
            config: None,
            db: None,
            session_registry: crate::services::session_registry::SessionRegistry::new(),
            guacd_pool: None,
            file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                "/tmp/strata-files",
            )).await,
            started_at: std::time::Instant::now(),
        }));
        let result = require_running(&state).await;
        assert!(result.is_err());
    }

    // ── redact_settings ────────────────────────────────────────────

    #[test]
    fn redact_settings_hides_sensitive_values() {
        let input = vec![
            ("sso_client_secret".into(), "super-secret".into()),
            ("app_name".into(), "Strata".into()),
            ("vault_token".into(), "hvs.12345".into()),
        ];
        let result = redact_settings(input);
        assert_eq!(result[0].1, "********");
        assert_eq!(result[1].1, "Strata");
        assert_eq!(result[2].1, "********");
    }

    #[test]
    fn redact_settings_passes_through_safe_keys() {
        let input = vec![
            ("theme".into(), "dark".into()),
            ("language".into(), "en".into()),
        ];
        let result = redact_settings(input);
        assert_eq!(result[0].1, "dark");
        assert_eq!(result[1].1, "en");
    }

    // ── validate_no_restricted_keys ────────────────────────────────

    #[test]
    fn validate_no_restricted_keys_accepts_safe_keys() {
        let settings = vec![
            SettingKV {
                key: "theme".into(),
                value: "dark".into(),
            },
            SettingKV {
                key: "app_name".into(),
                value: "Test".into(),
            },
        ];
        assert!(validate_no_restricted_keys(&settings).is_ok());
    }

    #[test]
    fn validate_no_restricted_keys_rejects_restricted() {
        let settings = vec![SettingKV {
            key: "jwt_secret".into(),
            value: "hack".into(),
        }];
        let err = validate_no_restricted_keys(&settings);
        assert!(err.is_err());
        assert!(format!("{}", err.unwrap_err()).contains("jwt_secret"));
    }

    #[test]
    fn validate_no_restricted_keys_rejects_sso_issuer() {
        let settings = vec![SettingKV {
            key: "sso_issuer_url".into(),
            value: "https://evil.com".into(),
        }];
        assert!(validate_no_restricted_keys(&settings).is_err());
    }

    #[test]
    fn test_redaction_masks() {
        assert_eq!(DOT_MASK, "••••••••");
        assert_eq!(STAR_MASK, "********");
        assert_ne!(DOT_MASK, STAR_MASK);
    }

    #[test]
    fn test_redact_settings_uses_constant() {
        let input = vec![("ad_bind_password".into(), "secret".into())];
        let result = redact_settings(input);
        assert_eq!(result[0].1, STAR_MASK);
    }

    // ── UpdateRoleRequest ──────────────────────────────────────────
    #[test]
    fn update_role_request_all_optional() {
        let r: UpdateRoleRequest = serde_json::from_str("{}").unwrap();
        assert!(r.name.is_none());
        assert!(r.can_manage_system.is_none());
        assert!(r.can_manage_users.is_none());
        assert!(r.can_manage_connections.is_none());
        assert!(r.can_view_audit_logs.is_none());
        assert!(r.can_create_users.is_none());
        assert!(r.can_create_user_groups.is_none());
        assert!(r.can_create_connections.is_none());
        assert!(r.can_create_connection_folders.is_none());
        assert!(r.can_create_sharing_profiles.is_none());
    }

    #[test]
    fn update_role_request_partial_fields() {
        let r: UpdateRoleRequest =
            serde_json::from_str(r#"{"name":"editor","can_manage_connections":true}"#).unwrap();
        assert_eq!(r.name.as_deref(), Some("editor"));
        assert_eq!(r.can_manage_connections, Some(true));
        assert!(r.can_manage_system.is_none());
    }

    #[test]
    fn create_role_request_with_permissions() {
        let r: CreateRoleRequest = serde_json::from_str(
            r#"{"name":"manager","can_manage_users":true,"can_view_audit_logs":true}"#,
        )
        .unwrap();
        assert_eq!(r.name, "manager");
        assert_eq!(r.can_manage_users, Some(true));
        assert_eq!(r.can_view_audit_logs, Some(true));
        assert!(r.can_manage_system.is_none());
    }

    // ── UpdateFolderRequest ────────────────────────────────────────
    #[test]
    fn update_folder_request_deser() {
        let r: UpdateFolderRequest = serde_json::from_str(r#"{"name":"production"}"#).unwrap();
        assert_eq!(r.name, "production");
        assert!(r.parent_id.is_none());
    }

    #[test]
    fn update_folder_request_with_parent() {
        let r: UpdateFolderRequest = serde_json::from_str(
            r#"{"name":"sub","parent_id":"550e8400-e29b-41d4-a716-446655440000"}"#,
        )
        .unwrap();
        assert_eq!(r.name, "sub");
        assert!(r.parent_id.is_some());
    }

    #[test]
    fn create_folder_request_with_parent() {
        let r: CreateFolderRequest = serde_json::from_str(
            r#"{"name":"sub","parent_id":"550e8400-e29b-41d4-a716-446655440000"}"#,
        )
        .unwrap();
        assert!(r.parent_id.is_some());
    }

    // ── RoleMappings serialization ─────────────────────────────────
    #[test]
    fn role_mappings_serializes() {
        let m = RoleMappings {
            connection_ids: vec![Uuid::nil()],
            folder_ids: vec![],
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["connection_ids"].as_array().unwrap().len(), 1);
        assert!(v["folder_ids"].as_array().unwrap().is_empty());
    }

    #[test]
    fn role_mapping_update_with_folders() {
        let json = r#"{"connection_ids":["550e8400-e29b-41d4-a716-446655440000"],"folder_ids":["660e8400-e29b-41d4-a716-446655440000"]}"#;
        let r: RoleMappingUpdate = serde_json::from_str(json).unwrap();
        assert_eq!(r.connection_ids.len(), 1);
        assert_eq!(r.folder_ids.len(), 1);
    }

    // ── ObserveQuery ───────────────────────────────────────────────
    #[test]
    fn observe_query_defaults() {
        let q: ObserveQuery = serde_json::from_str("{}").unwrap();
        assert!(q.offset.is_none());
        assert!(q.speed.is_none());
    }

    #[test]
    fn observe_query_with_values() {
        let q: ObserveQuery = serde_json::from_str(r#"{"offset":60,"speed":2.0}"#).unwrap();
        assert_eq!(q.offset.unwrap(), 60);
        assert!((q.speed.unwrap() - 2.0).abs() < f64::EPSILON);
    }

    // ── KillSessionsRequest ────────────────────────────────────────
    #[test]
    fn kill_sessions_request_deser() {
        let r: KillSessionsRequest =
            serde_json::from_str(r#"{"session_ids":["abc","def"]}"#).unwrap();
        assert_eq!(r.session_ids.len(), 2);
        assert_eq!(r.session_ids[0], "abc");
    }

    #[test]
    fn kill_sessions_request_empty() {
        let r: KillSessionsRequest = serde_json::from_str(r#"{"session_ids":[]}"#).unwrap();
        assert!(r.session_ids.is_empty());
    }

    // ── AuditLogRow serialization ──────────────────────────────────
    #[test]
    fn audit_log_row_serializes() {
        let r = AuditLogRow {
            id: 1,
            created_at: chrono::Utc::now(),
            user_id: Some(Uuid::nil()),
            username: Some("admin".into()),
            action_type: "login".into(),
            details: serde_json::json!({"ip": "127.0.0.1"}),
            current_hash: "abc123".into(),
            connection_name: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["action_type"], "login");
        assert_eq!(v["current_hash"], "abc123");
    }

    #[test]
    fn audit_log_row_serializes_without_user() {
        let r = AuditLogRow {
            id: 2,
            created_at: chrono::Utc::now(),
            user_id: None,
            username: None,
            action_type: "system.startup".into(),
            details: serde_json::json!({}),
            current_hash: "def456".into(),
            connection_name: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["user_id"].is_null());
        assert!(v["username"].is_null());
    }

    // ── RecordingsUpdateRequest ────────────────────────────────────
    #[test]
    fn recordings_update_request_azure_fields() {
        let json = r#"{"enabled":true,"storage_type":"azure","azure_account_name":"acct","azure_container_name":"recordings","azure_access_key":"key123","retention_days":90}"#;
        let r: RecordingsUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.azure_account_name.as_deref(), Some("acct"));
        assert_eq!(r.azure_container_name.as_deref(), Some("recordings"));
        assert_eq!(r.azure_access_key.as_deref(), Some("key123"));
        assert_eq!(r.retention_days, Some(90));
    }

    // ── ConnectionRow with extra ───────────────────────────────────
    #[test]
    fn connection_row_serializes_with_extra() {
        let r = ConnectionRow {
            id: Uuid::nil(),
            name: "rdp-host".into(),
            protocol: "rdp".into(),
            hostname: "10.0.0.2".into(),
            port: 3389,
            domain: None,
            description: "".into(),
            folder_id: Some(Uuid::nil()),
            extra: serde_json::json!({"color-depth": "32", "enable-wallpaper": "true"}),
            last_accessed: Some(chrono::Utc::now()),
            watermark: "inherit".into(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["extra"]["color-depth"], "32");
        assert!(v["folder_id"].is_string());
        assert!(v["last_accessed"].is_string());
    }

    // ── CreateConnectionRequest extra cases ────────────────────────
    #[test]
    fn create_connection_request_with_folder() {
        let json = r#"{"name":"test","protocol":"ssh","hostname":"box","folder_id":"550e8400-e29b-41d4-a716-446655440000","port":22}"#;
        let r: CreateConnectionRequest = serde_json::from_str(json).unwrap();
        assert!(r.folder_id.is_some());
        assert_eq!(r.port, Some(22));
    }

    // ── ConnectionFolderRow with parent ────────────────────────────
    #[test]
    fn connection_folder_row_with_parent() {
        let parent = Uuid::new_v4();
        let r = ConnectionFolderRow {
            id: Uuid::nil(),
            name: "Sub-folder".into(),
            parent_id: Some(parent),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["name"], "Sub-folder");
        assert!(v["parent_id"].is_string());
    }

    // ── CreateAdSyncConfigRequest full ─────────────────────────────
    #[test]
    fn create_ad_sync_config_request_full() {
        let json = r#"{
            "label":"Full AD",
            "ldap_url":"ldaps://dc.corp.local:636",
            "bind_dn":"cn=admin,dc=corp,dc=local",
            "bind_password":"secret",
            "search_bases":["dc=corp,dc=local","dc=sub,dc=corp,dc=local"],
            "search_filter":"(objectClass=computer)",
            "search_scope":"subtree",
            "protocol":"rdp",
            "default_port":3389,
            "domain_override":"CORP",
            "tls_skip_verify":true,
            "sync_interval_minutes":30,
            "enabled":true,
            "auth_method":"simple",
            "connection_defaults":{"color-depth":"24"}
        }"#;
        let r: CreateAdSyncConfigRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.label, "Full AD");
        assert_eq!(r.search_bases.len(), 2);
        assert_eq!(r.domain_override.as_deref(), Some("CORP"));
        assert_eq!(r.tls_skip_verify, Some(true));
        assert_eq!(r.sync_interval_minutes, Some(30));
        assert_eq!(r.auth_method.as_deref(), Some("simple"));
        assert!(r.connection_defaults.is_some());
    }

    // ── UpdateAdSyncConfigRequest full ─────────────────────────────
    #[test]
    fn update_ad_sync_config_request_full() {
        let json = r#"{
            "label":"Updated",
            "ldap_url":"ldaps://new-dc.corp.local",
            "bind_dn":"cn=svc,dc=corp,dc=local",
            "bind_password":"newsecret",
            "search_bases":["dc=new,dc=corp"],
            "search_filter":"(objectClass=user)",
            "search_scope":"one",
            "protocol":"ssh",
            "default_port":22,
            "domain_override":"NEWCORP",
            "tls_skip_verify":false,
            "sync_interval_minutes":120,
            "enabled":false,
            "auth_method":"gssapi",
            "keytab_path":"/etc/krb5.keytab",
            "krb5_principal":"svc@CORP.LOCAL",
            "ca_cert_pem":"-----BEGIN CERTIFICATE-----\nMIID...",
            "connection_defaults":{"enable-wallpaper":"true"}
        }"#;
        let r: UpdateAdSyncConfigRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.label.as_deref(), Some("Updated"));
        assert_eq!(r.protocol.as_deref(), Some("ssh"));
        assert_eq!(r.default_port, Some(22));
        assert_eq!(r.auth_method.as_deref(), Some("gssapi"));
        assert!(r.keytab_path.is_some());
        assert!(r.krb5_principal.is_some());
        assert!(r.ca_cert_pem.is_some());
        assert!(r.connection_defaults.is_some());
    }

    // ── CreateUserRequest extra cases ──────────────────────────────
    #[test]
    fn create_user_request_with_full_name() {
        let json = r#"{"username":"jdoe","email":"jdoe@example.com","full_name":"John Doe","role_id":"550e8400-e29b-41d4-a716-446655440000","auth_type":"sso"}"#;
        let r: CreateUserRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.full_name.as_deref(), Some("John Doe"));
        assert_eq!(r.auth_type, "sso");
    }

    // ── KerberosRealmRow edges ─────────────────────────────────────
    #[test]
    fn kerberos_realm_row_with_custom_lifetime() {
        let r = KerberosRealmRow {
            id: Uuid::nil(),
            realm: "EXAMPLE.COM".into(),
            kdc_servers: "kdc1.example.com".into(),
            admin_server: "admin.example.com".into(),
            ticket_lifetime: "8h".into(),
            renew_lifetime: "2d".into(),
            is_default: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["ticket_lifetime"], "8h");
        assert_eq!(v["renew_lifetime"], "2d");
        assert_eq!(v["is_default"], false);
    }

    // ── redact_settings edge cases ─────────────────────────────────
    #[test]
    fn redact_settings_empty_input() {
        let result = redact_settings(vec![]);
        assert!(result.is_empty());
    }

    #[test]
    fn redact_settings_partial_key_match() {
        // "azure_storage_access_key" contains "azure_storage_access_key"
        let input = vec![
            ("azure_storage_access_key".into(), "mykey".into()),
            ("my_custom_vault_token_note".into(), "note".into()),
        ];
        let result = redact_settings(input);
        assert_eq!(result[0].1, "********"); // Matches SENSITIVE_SETTINGS
        assert_eq!(result[1].1, "********"); // Contains "vault_token"
    }

    // ── validate_no_restricted_keys edge cases ─────────────────────
    #[test]
    fn validate_no_restricted_keys_empty_ok() {
        assert!(validate_no_restricted_keys(&[]).is_ok());
    }

    #[test]
    fn validate_no_restricted_keys_all_restricted() {
        for key in RESTRICTED_SETTINGS {
            let settings = vec![SettingKV {
                key: key.to_string(),
                value: "val".into(),
            }];
            assert!(
                validate_no_restricted_keys(&settings).is_err(),
                "Expected '{}' to be restricted",
                key
            );
        }
    }

    // ── VaultUpdateRequest extra ───────────────────────────────────
    #[test]
    fn vault_update_request_with_transit_key() {
        let json = r#"{"mode":"external","address":"https://vault:8200","token":"tok","transit_key":"custom-key"}"#;
        let r: VaultUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.transit_key.as_deref(), Some("custom-key"));
    }

    // ── UserRow with sub ───────────────────────────────────────────
    #[test]
    fn user_row_serializes_with_sub() {
        let r = UserRow {
            id: Uuid::nil(),
            username: "sso-user".into(),
            email: "sso@corp.local".into(),
            full_name: Some("SSO User".into()),
            auth_type: "sso".into(),
            sub: Some("auth0|12345".into()),
            role_name: "user".into(),
            deleted_at: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["sub"], "auth0|12345");
        assert_eq!(v["auth_type"], "sso");
    }

    // ── SettingsUpdateRequest with masked values ───────────────────
    #[test]
    fn settings_update_request_with_sensitive() {
        let json = r#"{"settings":[{"key":"sso_client_secret","value":"********"}]}"#;
        let r: SettingsUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.settings[0].value, "********");
    }

    // ── is_safe_hostname edge cases ────────────────────────────────
    #[test]
    fn safe_hostname_single_char() {
        assert!(is_safe_hostname("a"));
        assert!(is_safe_hostname("1"));
    }

    #[test]
    fn safe_hostname_rejects_null_bytes() {
        assert!(!is_safe_hostname("host\0name"));
    }

    #[test]
    fn safe_hostname_rejects_space() {
        assert!(!is_safe_hostname("host name.com"));
    }

    #[test]
    fn safe_hostname_allows_all_digits() {
        assert!(is_safe_hostname("192.168.1.1:389"));
    }

    // ── CreateKerberosRealmRequest with all fields ──────────────────
    #[test]
    fn create_kerberos_realm_request_full() {
        let json = r#"{
            "realm":"EXAMPLE.COM",
            "kdc_servers":["kdc1","kdc2","kdc3"],
            "admin_server":"kadmin.example.com",
            "ticket_lifetime":"12h",
            "renew_lifetime":"5d",
            "is_default":true
        }"#;
        let r: CreateKerberosRealmRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.kdc_servers.len(), 3);
        assert_eq!(r.ticket_lifetime.as_deref(), Some("12h"));
        assert_eq!(r.renew_lifetime.as_deref(), Some("5d"));
        assert_eq!(r.is_default, Some(true));
    }

    // ── ListRecordingsQuery ────────────────────────────────────────
    #[test]
    fn list_recordings_query_deser() {
        let q: super::recordings::ListRecordingsQuery = serde_json::from_str("{}").unwrap();
        assert!(q.user_id.is_none());
        assert!(q.connection_id.is_none());
        assert!(q.limit.is_none());
        assert!(q.offset.is_none());
    }

    #[test]
    fn list_recordings_query_with_values() {
        let q: super::recordings::ListRecordingsQuery = serde_json::from_str(
            r#"{"user_id":"550e8400-e29b-41d4-a716-446655440000","limit":10,"offset":20}"#,
        )
        .unwrap();
        assert!(q.user_id.is_some());
        assert_eq!(q.limit, Some(10));
        assert_eq!(q.offset, Some(20));
    }

    // ── KerberosUpdateRequest full ─────────────────────────────────
    #[test]
    fn kerberos_update_request_full() {
        let json = r#"{"realm":"CORP.LOCAL","kdc":["kdc1","kdc2"],"admin_server":"admin","ticket_lifetime":"24h","renew_lifetime":"7d"}"#;
        let r: KerberosUpdateRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.kdc.len(), 2);
        assert_eq!(r.ticket_lifetime.as_deref(), Some("24h"));
        assert_eq!(r.renew_lifetime.as_deref(), Some("7d"));
    }

    // ── role_row with all permissions true ──────────────────────────
    #[test]
    fn role_row_all_permissions() {
        let r = RoleRow {
            id: Uuid::nil(),
            name: "superadmin".into(),
            can_manage_system: true,
            can_manage_users: true,
            can_manage_connections: true,
            can_view_audit_logs: true,
            can_create_users: true,
            can_create_user_groups: true,
            can_create_connections: true,
            can_create_connection_folders: true,
            can_create_sharing_profiles: true,
            can_view_sessions: true,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["can_manage_system"], true);
        assert_eq!(v["can_manage_users"], true);
        assert_eq!(v["can_manage_connections"], true);
        assert_eq!(v["can_view_audit_logs"], true);
        assert_eq!(v["can_create_users"], true);
        assert_eq!(v["can_create_user_groups"], true);
        assert_eq!(v["can_create_connections"], true);
        assert_eq!(v["can_create_connection_folders"], true);
        assert_eq!(v["can_create_sharing_profiles"], true);
    }

    // ── CredentialProfileRow serialization ──────────────────────────
    #[test]
    fn credential_profile_row_deser() {
        let now = chrono::Utc::now();
        let r = super::super::user::CredentialProfileRow {
            id: Uuid::nil(),
            label: "Work".into(),
            created_at: now,
            updated_at: now,
            expires_at: now,
            expired: false,
            ttl_hours: 8,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["label"], "Work");
        assert_eq!(v["expired"], false);
        assert_eq!(v["ttl_hours"], 8);
    }

    // ── validate_ldap_url ──────────────────────────────────────────

    #[test]
    fn validate_ldap_url_ldap() {
        assert!(validate_ldap_url("ldap://dc.corp.local").is_ok());
    }

    #[test]
    fn validate_ldap_url_ldaps() {
        assert!(validate_ldap_url("ldaps://dc.corp.local:636").is_ok());
    }

    #[test]
    fn validate_ldap_url_rejects_http() {
        assert!(validate_ldap_url("http://dc.corp.local").is_err());
    }

    #[test]
    fn validate_ldap_url_rejects_https() {
        assert!(validate_ldap_url("https://dc.corp.local").is_err());
    }

    #[test]
    fn validate_ldap_url_rejects_empty() {
        assert!(validate_ldap_url("").is_err());
    }

    #[test]
    fn validate_ldap_url_rejects_ftp() {
        assert!(validate_ldap_url("ftp://dc.corp.local").is_err());
    }

    #[test]
    fn validate_ldap_url_rejects_plain_hostname() {
        assert!(validate_ldap_url("dc.corp.local").is_err());
    }

    // ── validate_ldap_filter ───────────────────────────────────────

    #[test]
    fn validate_ldap_filter_balanced() {
        assert!(validate_ldap_filter("(objectClass=computer)").is_ok());
    }

    #[test]
    fn validate_ldap_filter_nested() {
        assert!(validate_ldap_filter("(&(objectClass=computer)(cn=*))").is_ok());
    }

    #[test]
    fn validate_ldap_filter_complex() {
        assert!(validate_ldap_filter("(|(objectClass=user)(objectClass=group))").is_ok());
    }

    #[test]
    fn validate_ldap_filter_unbalanced_open() {
        assert!(validate_ldap_filter("((objectClass=computer)").is_err());
    }

    #[test]
    fn validate_ldap_filter_unbalanced_close() {
        assert!(validate_ldap_filter("(objectClass=computer))").is_err());
    }

    #[test]
    fn validate_ldap_filter_no_parens() {
        assert!(validate_ldap_filter("objectClass=computer").is_err());
    }

    #[test]
    fn validate_ldap_filter_empty() {
        assert!(validate_ldap_filter("").is_err());
    }

    #[test]
    fn validate_ldap_filter_just_parens() {
        assert!(validate_ldap_filter("()").is_ok());
    }

    #[test]
    fn validate_ldap_filter_deep_nesting() {
        assert!(validate_ldap_filter("((&(|(cn=a)(cn=b))(sn=c)))").is_ok());
    }

    // ── is_safe_hostname (additional coverage) ─────────────────────────

    #[test]
    fn is_safe_hostname_rejects_empty() {
        assert!(!is_safe_hostname(""));
    }

    #[test]
    fn is_safe_hostname_rejects_too_long() {
        let long = "a".repeat(256);
        assert!(!is_safe_hostname(&long));
    }

    #[test]
    fn is_safe_hostname_allows_max_length() {
        let max = "a".repeat(255);
        assert!(is_safe_hostname(&max));
    }

    #[test]
    fn is_safe_hostname_rejects_spaces() {
        assert!(!is_safe_hostname("host name"));
    }

    #[test]
    fn is_safe_hostname_rejects_slashes() {
        assert!(!is_safe_hostname("host/name"));
        assert!(!is_safe_hostname("host\\name"));
    }

    #[test]
    fn is_safe_hostname_rejects_special_chars() {
        assert!(!is_safe_hostname("host@name"));
        assert!(!is_safe_hostname("host;name"));
        assert!(!is_safe_hostname("host&name"));
    }

    #[test]
    fn is_safe_hostname_allows_ipv4() {
        assert!(is_safe_hostname("192.168.1.1"));
    }

    #[test]
    fn is_safe_hostname_allows_host_with_port() {
        assert!(is_safe_hostname("myhost:8080"));
    }

    // ── redact_settings (additional coverage) ──────────────────────────

    #[test]
    fn redact_settings_masks_all_sensitive() {
        let settings = vec![
            ("sso_client_secret".into(), "secret123".into()),
            ("ad_bind_password".into(), "pwd".into()),
            ("azure_storage_access_key".into(), "key".into()),
            ("vault_token".into(), "tok".into()),
            ("vault_unseal_key".into(), "unseal".into()),
        ];
        let redacted = redact_settings(settings);
        for (_, v) in &redacted {
            assert_eq!(v, STAR_MASK);
        }
    }

    #[test]
    fn redact_settings_preserves_key_order() {
        let settings = vec![
            ("a_setting".into(), "val_a".into()),
            ("sso_client_secret".into(), "secret".into()),
            ("b_setting".into(), "val_b".into()),
        ];
        let redacted = redact_settings(settings);
        assert_eq!(redacted[0].0, "a_setting");
        assert_eq!(redacted[0].1, "val_a");
        assert_eq!(redacted[1].1, STAR_MASK);
        assert_eq!(redacted[2].0, "b_setting");
        assert_eq!(redacted[2].1, "val_b");
    }

    // ── build_oidc_discovery_url ───────────────────────────────────

    #[test]
    fn oidc_discovery_url_no_trailing_slash() {
        assert_eq!(
            build_oidc_discovery_url("https://login.example.com"),
            "https://login.example.com/.well-known/openid-configuration"
        );
    }

    #[test]
    fn oidc_discovery_url_with_trailing_slash() {
        assert_eq!(
            build_oidc_discovery_url("https://login.example.com/"),
            "https://login.example.com/.well-known/openid-configuration"
        );
    }

    #[test]
    fn oidc_discovery_url_with_path() {
        assert_eq!(
            build_oidc_discovery_url("https://auth.example.com/realms/main"),
            "https://auth.example.com/realms/main/.well-known/openid-configuration"
        );
    }

    #[test]
    fn oidc_discovery_url_with_path_trailing_slash() {
        assert_eq!(
            build_oidc_discovery_url("https://auth.example.com/realms/main/"),
            "https://auth.example.com/realms/main/.well-known/openid-configuration"
        );
    }

    // ── validate_oidc_config ───────────────────────────────────────

    #[test]
    fn oidc_config_valid() {
        let config = json!({
            "authorization_endpoint": "https://auth/authorize",
            "token_endpoint": "https://auth/token",
            "jwks_uri": "https://auth/jwks"
        });
        assert!(validate_oidc_config(&config).is_ok());
    }

    #[test]
    fn oidc_config_missing_auth_endpoint() {
        let config = json!({
            "token_endpoint": "https://auth/token",
            "jwks_uri": "https://auth/jwks"
        });
        assert!(validate_oidc_config(&config).is_err());
    }

    #[test]
    fn oidc_config_missing_token_endpoint() {
        let config = json!({
            "authorization_endpoint": "https://auth/authorize",
            "jwks_uri": "https://auth/jwks"
        });
        assert!(validate_oidc_config(&config).is_err());
    }

    #[test]
    fn oidc_config_missing_jwks() {
        let config = json!({
            "authorization_endpoint": "https://auth/authorize",
            "token_endpoint": "https://auth/token"
        });
        assert!(validate_oidc_config(&config).is_err());
    }

    #[test]
    fn oidc_config_empty_object() {
        assert!(validate_oidc_config(&json!({})).is_err());
    }

    #[test]
    fn oidc_config_null_values_rejected() {
        let config = json!({
            "authorization_endpoint": null,
            "token_endpoint": "https://auth/token",
            "jwks_uri": "https://auth/jwks"
        });
        assert!(validate_oidc_config(&config).is_err());
    }

    #[test]
    fn oidc_config_numeric_values_rejected() {
        let config = json!({
            "authorization_endpoint": 42,
            "token_endpoint": "https://auth/token",
            "jwks_uri": "https://auth/jwks"
        });
        assert!(validate_oidc_config(&config).is_err());
    }

    #[test]
    fn oidc_config_with_extra_fields_valid() {
        let config = json!({
            "authorization_endpoint": "https://auth/authorize",
            "token_endpoint": "https://auth/token",
            "jwks_uri": "https://auth/jwks",
            "issuer": "https://auth",
            "userinfo_endpoint": "https://auth/userinfo"
        });
        assert!(validate_oidc_config(&config).is_ok());
    }

    // ── should_skip_masked_setting ─────────────────────────────────

    #[test]
    fn skip_masked_star_mask() {
        assert!(should_skip_masked_setting("sso_client_secret", STAR_MASK));
    }

    #[test]
    fn skip_masked_dot_mask() {
        assert!(should_skip_masked_setting("ad_bind_password", DOT_MASK));
    }

    #[test]
    fn skip_masked_non_sensitive_key() {
        assert!(!should_skip_masked_setting("theme_color", STAR_MASK));
    }

    #[test]
    fn skip_masked_sensitive_key_real_value() {
        assert!(!should_skip_masked_setting(
            "sso_client_secret",
            "real-secret-value"
        ));
    }

    #[test]
    fn skip_masked_vault_token_star() {
        assert!(should_skip_masked_setting("vault_token", STAR_MASK));
    }

    #[test]
    fn skip_masked_partial_match_key() {
        assert!(should_skip_masked_setting(
            "my_custom_vault_token_extra",
            STAR_MASK
        ));
    }

    #[test]
    fn skip_masked_empty_value() {
        assert!(!should_skip_masked_setting("sso_client_secret", ""));
    }

    // ── realm_rows_to_configs ──────────────────────────────────────

    #[test]
    fn realm_rows_to_configs_single() {
        let rows = vec![KerberosRealmRow {
            id: Uuid::nil(),
            realm: "CORP.LOCAL".into(),
            kdc_servers: "kdc1.corp.local,kdc2.corp.local".into(),
            admin_server: "kadmin.corp.local".into(),
            ticket_lifetime: "10h".into(),
            renew_lifetime: "7d".into(),
            is_default: true,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }];
        let configs = realm_rows_to_configs(&rows);
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].realm, "CORP.LOCAL");
        assert_eq!(configs[0].kdcs, vec!["kdc1.corp.local", "kdc2.corp.local"]);
        assert_eq!(configs[0].admin_server, "kadmin.corp.local");
        assert_eq!(configs[0].ticket_lifetime, "10h");
        assert_eq!(configs[0].renew_lifetime, "7d");
        assert!(configs[0].is_default);
    }

    #[test]
    fn realm_rows_to_configs_filters_empty_kdcs() {
        let rows = vec![KerberosRealmRow {
            id: Uuid::nil(),
            realm: "TEST.COM".into(),
            kdc_servers: "kdc1, , kdc2,".into(),
            admin_server: "admin".into(),
            ticket_lifetime: "8h".into(),
            renew_lifetime: "3d".into(),
            is_default: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }];
        let configs = realm_rows_to_configs(&rows);
        assert_eq!(configs[0].kdcs, vec!["kdc1", "kdc2"]);
    }

    #[test]
    fn realm_rows_to_configs_empty() {
        let configs = realm_rows_to_configs(&[]);
        assert!(configs.is_empty());
    }

    #[test]
    fn realm_rows_to_configs_multiple() {
        let rows = vec![
            KerberosRealmRow {
                id: Uuid::nil(),
                realm: "A.COM".into(),
                kdc_servers: "kdc-a".into(),
                admin_server: "admin-a".into(),
                ticket_lifetime: "1h".into(),
                renew_lifetime: "1d".into(),
                is_default: true,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            },
            KerberosRealmRow {
                id: Uuid::nil(),
                realm: "B.COM".into(),
                kdc_servers: "kdc-b1,kdc-b2".into(),
                admin_server: "admin-b".into(),
                ticket_lifetime: "2h".into(),
                renew_lifetime: "2d".into(),
                is_default: false,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            },
        ];
        let configs = realm_rows_to_configs(&rows);
        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].realm, "A.COM");
        assert_eq!(configs[1].realm, "B.COM");
        assert_eq!(configs[1].kdcs.len(), 2);
    }

    // ── validate_kerberos_hostnames ────────────────────────────────

    #[test]
    fn kerberos_hostnames_all_none() {
        assert!(validate_kerberos_hostnames(None, None, None).is_ok());
    }

    #[test]
    fn kerberos_hostnames_valid_realm() {
        assert!(validate_kerberos_hostnames(Some("CORP.LOCAL"), None, None).is_ok());
    }

    #[test]
    fn kerberos_hostnames_invalid_realm() {
        assert!(validate_kerberos_hostnames(Some("CORP; DROP"), None, None).is_err());
    }

    #[test]
    fn kerberos_hostnames_valid_kdcs() {
        let kdcs = vec!["kdc1.corp".into(), "kdc2.corp".into()];
        assert!(validate_kerberos_hostnames(None, Some(&kdcs), None).is_ok());
    }

    #[test]
    fn kerberos_hostnames_one_bad_kdc() {
        let kdcs = vec!["kdc1.corp".into(), "kdc2; evil".into()];
        assert!(validate_kerberos_hostnames(None, Some(&kdcs), None).is_err());
    }

    #[test]
    fn kerberos_hostnames_valid_admin() {
        assert!(validate_kerberos_hostnames(None, None, Some("admin.corp")).is_ok());
    }

    #[test]
    fn kerberos_hostnames_invalid_admin() {
        assert!(validate_kerberos_hostnames(None, None, Some("admin\nEvil")).is_err());
    }

    #[test]
    fn kerberos_hostnames_all_valid() {
        let kdcs = vec!["kdc1".into(), "kdc2".into()];
        assert!(validate_kerberos_hostnames(Some("REALM"), Some(&kdcs), Some("admin")).is_ok());
    }

    #[test]
    fn kerberos_hostnames_realm_bad_rest_valid() {
        let kdcs = vec!["kdc1".into()];
        assert!(
            validate_kerberos_hostnames(Some("BAD REALM"), Some(&kdcs), Some("admin")).is_err()
        );
    }

    // ── paginate ───────────────────────────────────────────────────

    #[test]
    fn paginate_defaults() {
        let (per_page, offset) = paginate(None, None, 200);
        assert_eq!(per_page, 50);
        assert_eq!(offset, 0);
    }

    #[test]
    fn paginate_page_2() {
        let (per_page, offset) = paginate(Some(2), Some(25), 200);
        assert_eq!(per_page, 25);
        assert_eq!(offset, 25);
    }

    #[test]
    fn paginate_clamps_per_page_max() {
        let (per_page, _) = paginate(None, Some(999), 200);
        assert_eq!(per_page, 200);
    }

    #[test]
    fn paginate_clamps_per_page_min() {
        let (per_page, _) = paginate(None, Some(0), 200);
        assert_eq!(per_page, 1);
    }

    #[test]
    fn paginate_negative_page() {
        let (_, offset) = paginate(Some(-5), Some(10), 200);
        assert_eq!(offset, 0);
    }

    #[test]
    fn paginate_page_zero_treated_as_one() {
        let (_, offset) = paginate(Some(0), Some(10), 200);
        assert_eq!(offset, 0);
    }

    #[test]
    fn paginate_page_3_per_page_10() {
        let (per_page, offset) = paginate(Some(3), Some(10), 100);
        assert_eq!(per_page, 10);
        assert_eq!(offset, 20);
    }

    // ── normalize_extra ────────────────────────────────────────────

    #[test]
    fn normalize_extra_null() {
        let result = normalize_extra(&serde_json::Value::Null);
        assert_eq!(result, json!({}));
    }

    #[test]
    fn normalize_extra_empty_object() {
        let input = json!({});
        let result = normalize_extra(&input);
        assert_eq!(result, json!({}));
    }

    #[test]
    fn normalize_extra_with_fields() {
        let input = json!({"color-depth": "32", "enable-wallpaper": "true"});
        let result = normalize_extra(&input);
        assert_eq!(result["color-depth"], "32");
        assert_eq!(result["enable-wallpaper"], "true");
    }

    #[test]
    fn normalize_extra_array_passthrough() {
        let input = json!([1, 2, 3]);
        let result = normalize_extra(&input);
        assert_eq!(result, json!([1, 2, 3]));
    }

    #[test]
    fn normalize_extra_string_passthrough() {
        let input = json!("hello");
        let result = normalize_extra(&input);
        assert_eq!(result, json!("hello"));
    }

    // ── build_share_url ────────────────────────────────────────────

    #[test]
    fn share_url_view_mode() {
        assert_eq!(build_share_url("abc-123", "view"), "/shared/abc-123");
    }

    #[test]
    fn share_url_control_mode() {
        assert_eq!(
            build_share_url("abc-123", "control"),
            "/shared/abc-123?mode=control"
        );
    }

    #[test]
    fn share_url_unknown_mode_treated_as_view() {
        assert_eq!(build_share_url("tok", "other"), "/shared/tok");
    }

    // ── validate_share_mode ────────────────────────────────────────

    #[test]
    fn share_mode_view() {
        assert_eq!(validate_share_mode("view").unwrap(), "view");
    }

    #[test]
    fn share_mode_control() {
        assert_eq!(validate_share_mode("control").unwrap(), "control");
    }

    #[test]
    fn share_mode_invalid() {
        assert!(validate_share_mode("admin").is_err());
    }

    #[test]
    fn share_mode_empty() {
        assert!(validate_share_mode("").is_err());
    }

    #[test]
    fn share_mode_uppercase() {
        // Only exact matches accepted, not case-insensitive
        assert!(validate_share_mode("View").is_err());
    }

    // ── format_guac_inst ───────────────────────────────────────────

    #[test]
    fn guac_inst_no_args() {
        assert_eq!(format_guac_inst("nvrreplaydone", &[]), "13.nvrreplaydone;");
    }

    #[test]
    fn guac_inst_single_arg() {
        assert_eq!(
            format_guac_inst("nvrprogress", &["5000"]),
            "11.nvrprogress,4.5000;"
        );
    }

    #[test]
    fn guac_inst_multiple_args() {
        assert_eq!(
            format_guac_inst("nvrheader", &["30000", "4", "300000", "60"]),
            "9.nvrheader,5.30000,1.4,6.300000,2.60;"
        );
    }

    #[test]
    fn guac_inst_empty_arg() {
        assert_eq!(format_guac_inst("nop", &[""]), "3.nop,0.;");
    }

    #[test]
    fn guac_inst_nop() {
        assert_eq!(format_guac_inst("nop", &[]), "3.nop;");
    }

    #[test]
    fn guac_inst_select_protocol() {
        assert_eq!(format_guac_inst("select", &["rdp"]), "6.select,3.rdp;");
    }

    #[test]
    fn guac_inst_error_with_code() {
        let result = format_guac_inst("error", &["Session killed", "521"]);
        assert!(result.starts_with("5.error,"));
        assert!(result.ends_with(';'));
        assert!(result.contains("14.Session killed"));
        assert!(result.contains("3.521"));
    }
}
