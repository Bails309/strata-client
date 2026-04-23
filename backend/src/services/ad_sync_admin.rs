//! AD Sync configuration admin CRUD.
//!
//! Extracted from [`crate::routes::admin`] so the (very large) INSERT and
//! partial-UPDATE bodies live in a service module. Vault sealing of bind
//! passwords stays in the handlers because it depends on runtime
//! `VaultConfig` from `AppState`.

use crate::error::AppError;
use crate::services::ad_sync::{AdSyncConfig, AdSyncRun};
use sqlx::PgPool;
use uuid::Uuid;

/// Fetch all configs (unredacted). The handler is responsible for masking
/// secrets before returning them to the client.
pub async fn list_all(pool: &PgPool) -> Result<Vec<AdSyncConfig>, AppError> {
    let rows = sqlx::query_as("SELECT * FROM ad_sync_configs ORDER BY label")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Fetch a single config by id, or `None` if missing. Bind passwords are
/// returned as stored (sealed); handlers are responsible for decryption.
pub async fn get_by_id(pool: &PgPool, id: Uuid) -> Result<Option<AdSyncConfig>, AppError> {
    let row = sqlx::query_as("SELECT * FROM ad_sync_configs WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// Fetch just the stored `bind_password` column for a config. Used by the
/// clone flow to resolve a mask marker to the real ciphertext.
pub async fn get_bind_password(pool: &PgPool, id: Uuid) -> Result<Option<String>, AppError> {
    let v = sqlx::query_scalar("SELECT bind_password FROM ad_sync_configs WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(v)
}

/// Fetch just the stored `pm_bind_password` column for a config.
pub async fn get_pm_bind_password(pool: &PgPool, id: Uuid) -> Result<Option<String>, AppError> {
    let v: Option<Option<String>> =
        sqlx::query_scalar("SELECT pm_bind_password FROM ad_sync_configs WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(v.flatten())
}

/// Fetch the most recent run rows for a config (most-recent first, limit 50).
pub async fn list_runs(pool: &PgPool, config_id: Uuid) -> Result<Vec<AdSyncRun>, AppError> {
    let rows = sqlx::query_as(
        "SELECT * FROM ad_sync_runs WHERE config_id = $1 ORDER BY started_at DESC LIMIT 50",
    )
    .bind(config_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn config_exists(pool: &PgPool, id: Uuid) -> Result<bool, AppError> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ad_sync_configs WHERE id = $1)")
            .bind(id)
            .fetch_one(pool)
            .await?;
    Ok(exists)
}

pub async fn count_configs(pool: &PgPool) -> Result<i64, AppError> {
    let c = sqlx::query_scalar("SELECT COUNT(*) FROM ad_sync_configs")
        .fetch_one(pool)
        .await?;
    Ok(c)
}

pub async fn delete_by_id(pool: &PgPool, id: Uuid) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM ad_sync_configs WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Arguments for [`insert_config`] with all defaults resolved by the caller.
#[allow(clippy::struct_excessive_bools)]
pub struct InsertConfigArgs<'a> {
    pub label: &'a str,
    pub ldap_url: &'a str,
    pub bind_dn: &'a str,
    pub bind_password: &'a str,
    pub search_bases: &'a [String],
    pub search_filter: &'a str,
    pub search_scope: &'a str,
    pub protocol: &'a str,
    pub default_port: i32,
    pub domain_override: Option<&'a str>,
    pub folder_id: Option<Uuid>,
    pub tls_skip_verify: bool,
    pub sync_interval_minutes: i32,
    pub enabled: bool,
    pub auth_method: &'a str,
    pub keytab_path: Option<&'a str>,
    pub krb5_principal: Option<&'a str>,
    pub ca_cert_pem: Option<&'a str>,
    pub connection_defaults: &'a serde_json::Value,
    pub pm_enabled: bool,
    pub pm_bind_user: Option<&'a str>,
    pub pm_bind_password: Option<&'a str>,
    pub pm_target_filter: &'a str,
    pub pm_pwd_min_length: i32,
    pub pm_pwd_require_uppercase: bool,
    pub pm_pwd_require_lowercase: bool,
    pub pm_pwd_require_numbers: bool,
    pub pm_pwd_require_symbols: bool,
    pub pm_auto_rotate_enabled: bool,
    pub pm_auto_rotate_interval_days: i32,
    pub pm_search_bases: &'a [String],
    pub pm_allow_emergency_bypass: bool,
}

pub async fn insert_config(pool: &PgPool, a: InsertConfigArgs<'_>) -> Result<Uuid, AppError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO ad_sync_configs (label, ldap_url, bind_dn, bind_password, search_bases, search_filter, search_scope, protocol, default_port, domain_override, folder_id, tls_skip_verify, sync_interval_minutes, enabled, auth_method, keytab_path, krb5_principal, ca_cert_pem, connection_defaults, pm_enabled, pm_bind_user, pm_bind_password, pm_target_filter, pm_pwd_min_length, pm_pwd_require_uppercase, pm_pwd_require_lowercase, pm_pwd_require_numbers, pm_pwd_require_symbols, pm_auto_rotate_enabled, pm_auto_rotate_interval_days, pm_search_bases, pm_allow_emergency_bypass)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING id",
    )
    .bind(a.label)
    .bind(a.ldap_url)
    .bind(a.bind_dn)
    .bind(a.bind_password)
    .bind(a.search_bases)
    .bind(a.search_filter)
    .bind(a.search_scope)
    .bind(a.protocol)
    .bind(a.default_port)
    .bind(a.domain_override)
    .bind(a.folder_id)
    .bind(a.tls_skip_verify)
    .bind(a.sync_interval_minutes)
    .bind(a.enabled)
    .bind(a.auth_method)
    .bind(a.keytab_path)
    .bind(a.krb5_principal)
    .bind(a.ca_cert_pem)
    .bind(a.connection_defaults)
    .bind(a.pm_enabled)
    .bind(a.pm_bind_user)
    .bind(a.pm_bind_password)
    .bind(a.pm_target_filter)
    .bind(a.pm_pwd_min_length)
    .bind(a.pm_pwd_require_uppercase)
    .bind(a.pm_pwd_require_lowercase)
    .bind(a.pm_pwd_require_numbers)
    .bind(a.pm_pwd_require_symbols)
    .bind(a.pm_auto_rotate_enabled)
    .bind(a.pm_auto_rotate_interval_days)
    .bind(a.pm_search_bases)
    .bind(a.pm_allow_emergency_bypass)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// Optional fields for a partial update. The handler is responsible for
/// sealing `bind_password` / `pm_bind_password` before populating these.
#[derive(Default)]
pub struct UpdateFields<'a> {
    pub label: Option<&'a str>,
    pub ldap_url: Option<&'a str>,
    pub bind_dn: Option<&'a str>,
    /// `Some(value)` applies the update; `None` leaves the column alone.
    /// Pass `Some("")` to clear.
    pub bind_password: Option<&'a str>,
    pub search_bases: Option<&'a [String]>,
    pub search_filter: Option<&'a str>,
    pub search_scope: Option<&'a str>,
    pub protocol: Option<&'a str>,
    pub default_port: Option<i32>,
    pub domain_override: Option<&'a str>,
    pub folder_id: Option<Uuid>,
    pub tls_skip_verify: Option<bool>,
    pub sync_interval_minutes: Option<i32>,
    pub enabled: Option<bool>,
    pub auth_method: Option<&'a str>,
    pub keytab_path: Option<&'a str>,
    pub krb5_principal: Option<&'a str>,
    /// Empty string is stored as NULL.
    pub ca_cert_pem: Option<&'a str>,
    pub connection_defaults: Option<&'a serde_json::Value>,
    pub pm_enabled: Option<bool>,
    /// Empty string is stored as NULL.
    pub pm_bind_user: Option<&'a str>,
    /// `Some(Some(ciphertext))` sets, `Some(None)` clears, `None` leaves alone.
    pub pm_bind_password: Option<Option<&'a str>>,
    pub pm_target_filter: Option<&'a str>,
    pub pm_pwd_min_length: Option<i32>,
    pub pm_pwd_require_uppercase: Option<bool>,
    pub pm_pwd_require_lowercase: Option<bool>,
    pub pm_pwd_require_numbers: Option<bool>,
    pub pm_pwd_require_symbols: Option<bool>,
    pub pm_auto_rotate_enabled: Option<bool>,
    pub pm_auto_rotate_interval_days: Option<i32>,
    pub pm_search_bases: Option<Vec<String>>,
    pub pm_allow_emergency_bypass: Option<bool>,
}

/// Apply a partial update transactionally. Each `Some` field generates one
/// UPDATE statement mirroring the original route handler.
pub async fn apply_update(pool: &PgPool, id: Uuid, f: UpdateFields<'_>) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    macro_rules! set {
        ($col:literal, $val:expr) => {
            sqlx::query(concat!(
                "UPDATE ad_sync_configs SET ",
                $col,
                " = $1, updated_at = now() WHERE id = $2"
            ))
            .bind($val)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        };
    }

    if let Some(v) = f.label {
        set!("label", v);
    }
    if let Some(v) = f.ldap_url {
        set!("ldap_url", v);
    }
    if let Some(v) = f.bind_dn {
        set!("bind_dn", v);
    }
    if let Some(v) = f.bind_password {
        set!("bind_password", v);
    }
    if let Some(v) = f.search_bases {
        set!("search_bases", v);
    }
    if let Some(v) = f.search_filter {
        set!("search_filter", v);
    }
    if let Some(v) = f.search_scope {
        set!("search_scope", v);
    }
    if let Some(v) = f.protocol {
        set!("protocol", v);
    }
    if let Some(v) = f.default_port {
        set!("default_port", v);
    }
    if let Some(v) = f.domain_override {
        set!("domain_override", v);
    }
    if let Some(v) = f.folder_id {
        set!("folder_id", v);
    }
    if let Some(v) = f.tls_skip_verify {
        set!("tls_skip_verify", v);
    }
    if let Some(v) = f.sync_interval_minutes {
        set!("sync_interval_minutes", v);
    }
    if let Some(v) = f.enabled {
        set!("enabled", v);
    }
    if let Some(v) = f.auth_method {
        set!("auth_method", v);
    }
    if let Some(v) = f.keytab_path {
        set!("keytab_path", v);
    }
    if let Some(v) = f.krb5_principal {
        set!("krb5_principal", v);
    }
    if let Some(v) = f.ca_cert_pem {
        let val = if v.is_empty() { None } else { Some(v) };
        set!("ca_cert_pem", val);
    }
    if let Some(v) = f.connection_defaults {
        set!("connection_defaults", v);
    }
    if let Some(v) = f.pm_enabled {
        set!("pm_enabled", v);
    }
    if let Some(v) = f.pm_bind_user {
        let val = if v.is_empty() { None } else { Some(v) };
        set!("pm_bind_user", val);
    }
    if let Some(v) = f.pm_bind_password {
        set!("pm_bind_password", v);
    }
    if let Some(v) = f.pm_target_filter {
        set!("pm_target_filter", v);
    }
    if let Some(v) = f.pm_pwd_min_length {
        set!("pm_pwd_min_length", v);
    }
    if let Some(v) = f.pm_pwd_require_uppercase {
        set!("pm_pwd_require_uppercase", v);
    }
    if let Some(v) = f.pm_pwd_require_lowercase {
        set!("pm_pwd_require_lowercase", v);
    }
    if let Some(v) = f.pm_pwd_require_numbers {
        set!("pm_pwd_require_numbers", v);
    }
    if let Some(v) = f.pm_pwd_require_symbols {
        set!("pm_pwd_require_symbols", v);
    }
    if let Some(v) = f.pm_auto_rotate_enabled {
        set!("pm_auto_rotate_enabled", v);
    }
    if let Some(v) = f.pm_auto_rotate_interval_days {
        set!("pm_auto_rotate_interval_days", v);
    }
    if let Some(v) = f.pm_search_bases {
        set!("pm_search_bases", v);
    }
    if let Some(v) = f.pm_allow_emergency_bypass {
        set!("pm_allow_emergency_bypass", v);
    }

    tx.commit().await?;
    Ok(())
}
