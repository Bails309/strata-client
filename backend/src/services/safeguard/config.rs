//! Safeguard JIT — singleton config row DAO.
//!
//! Reads / writes the one-and-only `safeguard_config` row (PK = 1).
//! Secrets are sealed with [`crate::services::vault::seal_setting`]
//! and stored as `vault:{json}` envelope strings, matching the SMTP
//! password / AD bind password convention. Plaintext NEVER hits the
//! DB.
//!
//! The public [`SafeguardConfig`] struct never carries plaintext
//! secrets either — when the admin tab GETs the config, sealed
//! columns are returned as `"********"` placeholders (a fixed
//! 8-character mask, same convention as `routes::admin::sso_test`).
//! When the admin PUTs an update, an incoming `"********"` literal
//! means "keep the existing value", so admins can edit unrelated
//! fields without re-typing the API key on every save.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::VaultConfig;
use crate::error::AppError;

/// Mask returned to (and accepted from) the UI in place of real
/// secrets. Keep in sync with `frontend/src/pages/admin/SafeguardTab.tsx`.
pub const SECRET_MASK: &str = "********";

/// Auth mode discriminator (mirrors the DB CHECK constraint).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// Per-user browser SSO via Safeguard's RSTS federation flow.
    /// Each user runs the helper (PowerShell `Connect-Safeguard -Browser
    /// -IdentityProvider <alias>`) once per token lifetime and posts the
    /// resulting API token to Strata, where it is Vault-sealed and used
    /// for that user's JIT checkouts.
    PerUserBrowser,
    A2a,
    Hybrid,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::PerUserBrowser => "per_user_browser",
            AuthMode::A2a => "a2a",
            AuthMode::Hybrid => "hybrid",
        }
    }

    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s {
            "per_user_browser" => Ok(AuthMode::PerUserBrowser),
            // Accept the legacy spelling for one release so any
            // unmigrated row or in-flight admin request doesn't 400.
            "per_user_oidc" => Ok(AuthMode::PerUserBrowser),
            "a2a" => Ok(AuthMode::A2a),
            "hybrid" => Ok(AuthMode::Hybrid),
            other => Err(AppError::Validation(format!(
                "unknown safeguard auth_mode '{other}'"
            ))),
        }
    }
}

/// Public, UI-facing view of the safeguard_config row. Secrets are
/// masked when written to JSON (see [`SECRET_MASK`]). The PUT handler
/// interprets an inbound `"********"` value as "keep existing".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafeguardConfig {
    pub enabled: bool,
    pub appliance_fqdn: String,
    pub appliance_port: i32,
    pub verify_tls: bool,
    /// Optional CA bundle (PEM). Empty string == not set.
    #[serde(default)]
    pub ca_cert_pem: String,
    pub idp_alias: String,
    pub auth_mode: AuthMode,
    pub default_checkout_hours: i32,
    pub request_reason_template: String,
    pub auto_checkin_on_session_end: bool,
    /// When `true`, a successful JIT checkout's password is sealed and
    /// cached for `default_checkout_hours`, so subsequent tunnel opens
    /// for the same profile reuse the cached row without requiring a
    /// fresh per-user Safeguard sign-in. Auto-checkin is suppressed
    /// while caching is active — the credential remains live on the
    /// appliance until Safeguard's own rotation policy expires it.
    #[serde(default)]
    pub password_cache_enabled: bool,
    /// On read: `"********"` if set, `""` if unset. On write: same
    /// convention — `"********"` means "leave existing alone".
    #[serde(default)]
    pub a2a_api_key: String,
    #[serde(default)]
    pub a2a_client_cert_pem: String,
    #[serde(default)]
    pub a2a_client_key_pem: String,
}

impl Default for SafeguardConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            appliance_fqdn: String::new(),
            appliance_port: 443,
            verify_tls: true,
            ca_cert_pem: String::new(),
            idp_alias: String::new(),
            auth_mode: AuthMode::PerUserBrowser,
            default_checkout_hours: 12,
            request_reason_template: "Strata session {session_id} for {user}".to_string(),
            auto_checkin_on_session_end: true,
            password_cache_enabled: false,
            a2a_api_key: String::new(),
            a2a_client_cert_pem: String::new(),
            a2a_client_key_pem: String::new(),
        }
    }
}

/// Internal row shape — exposes sealed envelopes plus the auth mode as
/// a string. Only used by this module.
#[derive(sqlx::FromRow)]
struct ConfigRow {
    enabled: bool,
    appliance_fqdn: String,
    appliance_port: i32,
    verify_tls: bool,
    ca_cert_pem: Option<String>,
    idp_alias: String,
    auth_mode: String,
    default_checkout_hours: i32,
    request_reason_template: String,
    auto_checkin_on_session_end: bool,
    password_cache_enabled: bool,
    a2a_api_key_sealed: Option<String>,
    a2a_client_cert_pem_sealed: Option<String>,
    a2a_client_key_pem_sealed: Option<String>,
}

/// Load the (masked) config for the admin UI. Secrets are replaced
/// with [`SECRET_MASK`] when present and empty string when unset.
pub async fn load(pool: &PgPool) -> Result<SafeguardConfig, AppError> {
    let row: ConfigRow = sqlx::query_as(
        "SELECT enabled, appliance_fqdn, appliance_port, verify_tls, ca_cert_pem,
                idp_alias, auth_mode, default_checkout_hours, request_reason_template,
                auto_checkin_on_session_end, password_cache_enabled,
                a2a_api_key_sealed, a2a_client_cert_pem_sealed, a2a_client_key_pem_sealed
           FROM safeguard_config WHERE id = 1",
    )
    .fetch_one(pool)
    .await?;

    Ok(SafeguardConfig {
        enabled: row.enabled,
        appliance_fqdn: row.appliance_fqdn,
        appliance_port: row.appliance_port,
        verify_tls: row.verify_tls,
        ca_cert_pem: row.ca_cert_pem.unwrap_or_default(),
        idp_alias: row.idp_alias,
        auth_mode: AuthMode::parse(&row.auth_mode)?,
        default_checkout_hours: row.default_checkout_hours,
        request_reason_template: row.request_reason_template,
        auto_checkin_on_session_end: row.auto_checkin_on_session_end,
        password_cache_enabled: row.password_cache_enabled,
        a2a_api_key: mask_if_set(row.a2a_api_key_sealed.as_deref()),
        a2a_client_cert_pem: mask_if_set(row.a2a_client_cert_pem_sealed.as_deref()),
        a2a_client_key_pem: mask_if_set(row.a2a_client_key_pem_sealed.as_deref()),
    })
}

/// Plaintext-bearing view, ONLY for internal callers (REST client,
/// test-connection probe). Never serialise this to JSON.
#[derive(Debug, Clone)]
pub struct ResolvedSecrets {
    pub a2a_api_key: Option<String>,
    pub a2a_client_cert_pem: Option<String>,
    pub a2a_client_key_pem: Option<String>,
}

/// Decrypt the sealed secrets for use by the REST client. Each field
/// is `None` when the corresponding column was NULL.
pub async fn load_secrets(pool: &PgPool, vault: &VaultConfig) -> Result<ResolvedSecrets, AppError> {
    let row: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT a2a_api_key_sealed, a2a_client_cert_pem_sealed, a2a_client_key_pem_sealed
           FROM safeguard_config WHERE id = 1",
    )
    .fetch_one(pool)
    .await?;

    let unseal = |v: Option<String>| async move {
        match v {
            None => Ok::<_, AppError>(None),
            Some(s) if s.is_empty() => Ok(None),
            Some(s) => crate::services::vault::unseal_setting(vault, &s)
                .await
                .map(Some),
        }
    };

    Ok(ResolvedSecrets {
        a2a_api_key: unseal(row.0).await?,
        a2a_client_cert_pem: unseal(row.1).await?,
        a2a_client_key_pem: unseal(row.2).await?,
    })
}

/// Replace the config row. Sealed columns follow the keep-on-mask rule:
/// an inbound value equal to [`SECRET_MASK`] means "preserve the
/// existing envelope unchanged". Pass `vault = None` to disallow any
/// new secret writes (the route handler enforces this when Vault is
/// not configured).
pub async fn save(
    pool: &PgPool,
    vault: Option<&VaultConfig>,
    updated_by: Option<Uuid>,
    new_cfg: &SafeguardConfig,
) -> Result<(), AppError> {
    validate(new_cfg)?;

    // Pull existing sealed envelopes so we can keep-on-mask.
    let existing: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT a2a_api_key_sealed, a2a_client_cert_pem_sealed, a2a_client_key_pem_sealed
           FROM safeguard_config WHERE id = 1",
    )
    .fetch_one(pool)
    .await?;

    let api_key = reseal_or_keep(vault, &new_cfg.a2a_api_key, existing.0).await?;
    let client_cert = reseal_or_keep(vault, &new_cfg.a2a_client_cert_pem, existing.1).await?;
    let client_key = reseal_or_keep(vault, &new_cfg.a2a_client_key_pem, existing.2).await?;

    sqlx::query(
        "UPDATE safeguard_config SET
            enabled                     = $1,
            appliance_fqdn              = $2,
            appliance_port              = $3,
            verify_tls                  = $4,
            ca_cert_pem                 = NULLIF($5, ''),
            idp_alias                   = $6,
            auth_mode                   = $7,
            default_checkout_hours      = $8,
            request_reason_template     = $9,
            auto_checkin_on_session_end = $10,
            password_cache_enabled      = $11,
            a2a_api_key_sealed          = $12,
            a2a_client_cert_pem_sealed  = $13,
            a2a_client_key_pem_sealed   = $14,
            updated_at                  = now(),
            updated_by                  = $15
          WHERE id = 1",
    )
    .bind(new_cfg.enabled)
    .bind(&new_cfg.appliance_fqdn)
    .bind(new_cfg.appliance_port)
    .bind(new_cfg.verify_tls)
    .bind(&new_cfg.ca_cert_pem)
    .bind(&new_cfg.idp_alias)
    .bind(new_cfg.auth_mode.as_str())
    .bind(new_cfg.default_checkout_hours)
    .bind(&new_cfg.request_reason_template)
    .bind(new_cfg.auto_checkin_on_session_end)
    .bind(new_cfg.password_cache_enabled)
    .bind(api_key)
    .bind(client_cert)
    .bind(client_key)
    .bind(updated_by)
    .execute(pool)
    .await?;

    Ok(())
}

fn mask_if_set(sealed: Option<&str>) -> String {
    match sealed {
        Some(s) if !s.is_empty() => SECRET_MASK.to_string(),
        _ => String::new(),
    }
}

/// Re-seal an inbound secret, honour the keep-on-mask rule, and let an
/// empty string clear the column.
async fn reseal_or_keep(
    vault: Option<&VaultConfig>,
    incoming: &str,
    existing: Option<String>,
) -> Result<Option<String>, AppError> {
    if incoming == SECRET_MASK {
        // Keep existing.
        return Ok(existing);
    }
    if incoming.is_empty() {
        // Explicitly clear.
        return Ok(None);
    }
    let vault = vault.ok_or_else(|| {
        AppError::Validation("Vault must be configured before storing Safeguard secrets".into())
    })?;
    let sealed = crate::services::vault::seal_setting(vault, incoming).await?;
    Ok(Some(sealed))
}

fn validate(cfg: &SafeguardConfig) -> Result<(), AppError> {
    if cfg.enabled && cfg.appliance_fqdn.trim().is_empty() {
        return Err(AppError::Validation(
            "Safeguard appliance FQDN is required when enabled".into(),
        ));
    }
    if !(1..=65535).contains(&cfg.appliance_port) {
        return Err(AppError::Validation(
            "appliance_port must be between 1 and 65535".into(),
        ));
    }
    if !(1..=12).contains(&cfg.default_checkout_hours) {
        return Err(AppError::Validation(
            "default_checkout_hours must be between 1 and 12".into(),
        ));
    }
    if cfg.enabled
        && matches!(cfg.auth_mode, AuthMode::PerUserBrowser | AuthMode::Hybrid)
        && cfg.idp_alias.trim().is_empty()
    {
        return Err(AppError::Validation(
            "idp_alias is required for per_user_browser / hybrid auth modes".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_mode_roundtrip() {
        for m in [AuthMode::PerUserBrowser, AuthMode::A2a, AuthMode::Hybrid] {
            assert_eq!(AuthMode::parse(m.as_str()).unwrap(), m);
        }
        assert!(AuthMode::parse("nonsense").is_err());
    }

    #[test]
    fn mask_visibility() {
        assert_eq!(mask_if_set(None), "");
        assert_eq!(mask_if_set(Some("")), "");
        assert_eq!(mask_if_set(Some("vault:{...}")), SECRET_MASK);
    }

    #[test]
    fn validate_rejects_empty_fqdn_when_enabled() {
        let mut c = SafeguardConfig {
            enabled: true,
            auth_mode: AuthMode::A2a,
            ..Default::default()
        };
        c.appliance_fqdn = "".into();
        assert!(validate(&c).is_err());
        c.appliance_fqdn = "sg.example.com".into();
        assert!(validate(&c).is_ok());
    }

    #[test]
    fn validate_requires_idp_alias_for_per_user_browser() {
        let c = SafeguardConfig {
            enabled: true,
            auth_mode: AuthMode::PerUserBrowser,
            appliance_fqdn: "sg.example.com".into(),
            idp_alias: String::new(),
            ..Default::default()
        };
        assert!(validate(&c).is_err());
    }

    #[test]
    fn validate_allows_a2a_when_enabled() {
        let c = SafeguardConfig {
            enabled: true,
            auth_mode: AuthMode::A2a,
            appliance_fqdn: "sg.example.com".into(),
            ..Default::default()
        };
        assert!(validate(&c).is_ok());
    }

    #[test]
    fn validate_requires_idp_for_hybrid() {
        let c = SafeguardConfig {
            enabled: true,
            auth_mode: AuthMode::Hybrid,
            appliance_fqdn: "sg.example.com".into(),
            idp_alias: "".into(),
            ..Default::default()
        };
        assert!(validate(&c).is_err());
    }

    #[test]
    fn validate_port_bounds() {
        let mut c = SafeguardConfig {
            appliance_port: 0,
            ..Default::default()
        };
        assert!(validate(&c).is_err());
        c.appliance_port = 70000;
        assert!(validate(&c).is_err());
        c.appliance_port = 443;
        assert!(validate(&c).is_ok());
    }
}
