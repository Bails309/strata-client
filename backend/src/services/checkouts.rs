use chrono::{DateTime, Utc};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Postgres};
use uuid::Uuid;

use crate::config::VaultConfig;
use crate::error::AppError;
use crate::routes::admin::parse_ldap_error_hint;
use crate::services::vault;

// ── Password policy from ad_sync_configs ───────────────────────────────

#[derive(Debug, Clone)]
pub struct PasswordPolicy {
    pub min_length: i32,
    pub require_uppercase: bool,
    pub require_lowercase: bool,
    pub require_numbers: bool,
    pub require_symbols: bool,
}

impl Default for PasswordPolicy {
    fn default() -> Self {
        Self {
            min_length: 16,
            require_uppercase: true,
            require_lowercase: true,
            require_numbers: true,
            require_symbols: true,
        }
    }
}

// ── Checkout request row ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CheckoutRequest {
    pub id: Uuid,
    pub requester_user_id: Uuid,
    pub managed_ad_dn: String,
    pub ad_sync_config_id: Option<Uuid>,
    pub status: String,
    pub requested_duration_mins: i32,
    pub approved_by_user_id: Option<Uuid>,
    pub justification_comment: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub vault_credential_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[sqlx(default)]
    pub requester_username: Option<String>,
    pub friendly_name: Option<String>,
    #[sqlx(default)]
    pub emergency_bypass: bool,
    #[sqlx(default)]
    pub scheduled_start_at: Option<DateTime<Utc>>,
}

// ── Approval role row ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ApprovalRole {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ── User account mapping row ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserAccountMapping {
    pub id: Uuid,
    pub user_id: Uuid,
    pub managed_ad_dn: String,
    pub can_self_approve: bool,
    pub ad_sync_config_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub friendly_name: Option<String>,
}

// ── Generate a password matching the policy ────────────────────────────

pub fn generate_password(policy: &PasswordPolicy) -> String {
    let mut rng = rand::rng();
    let length = policy.min_length.max(12) as usize;

    let uppercase = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let lowercase = b"abcdefghijklmnopqrstuvwxyz";
    let numbers = b"0123456789";
    let symbols = b"!@#$%^&*()-_=+[]{}|;:,.<>?";

    // Guarantee at least one of each required class
    let mut password: Vec<u8> = Vec::with_capacity(length);

    if policy.require_uppercase {
        password.push(uppercase[rng.random_range(0..uppercase.len())]);
    }
    if policy.require_lowercase {
        password.push(lowercase[rng.random_range(0..lowercase.len())]);
    }
    if policy.require_numbers {
        password.push(numbers[rng.random_range(0..numbers.len())]);
    }
    if policy.require_symbols {
        password.push(symbols[rng.random_range(0..symbols.len())]);
    }

    // Build combined charset
    let mut charset: Vec<u8> = Vec::new();
    if policy.require_uppercase {
        charset.extend_from_slice(uppercase);
    }
    if policy.require_lowercase {
        charset.extend_from_slice(lowercase);
    }
    if policy.require_numbers {
        charset.extend_from_slice(numbers);
    }
    if policy.require_symbols {
        charset.extend_from_slice(symbols);
    }
    // Always include upper + lower as minimum
    if charset.is_empty() {
        charset.extend_from_slice(uppercase);
        charset.extend_from_slice(lowercase);
        charset.extend_from_slice(numbers);
    }

    // Fill remaining length
    while password.len() < length {
        password.push(charset[rng.random_range(0..charset.len())]);
    }

    // Shuffle to avoid predictable prefix
    for i in (1..password.len()).rev() {
        let j = rng.random_range(0..=i);
        password.swap(i, j);
    }

    String::from_utf8(password).expect("password chars are ascii")
}

// ── Load password policy from an AD sync config ────────────────────────

pub async fn load_policy(
    pool: &Pool<Postgres>,
    config_id: Uuid,
) -> Result<PasswordPolicy, AppError> {
    let row: Option<(i32, bool, bool, bool, bool)> = sqlx::query_as(
        "SELECT pm_pwd_min_length, pm_pwd_require_uppercase, pm_pwd_require_lowercase,
                pm_pwd_require_numbers, pm_pwd_require_symbols
         FROM ad_sync_configs WHERE id = $1",
    )
    .bind(config_id)
    .fetch_optional(pool)
    .await?;

    match row {
        Some((min_len, upper, lower, nums, syms)) => Ok(PasswordPolicy {
            min_length: min_len,
            require_uppercase: upper,
            require_lowercase: lower,
            require_numbers: nums,
            require_symbols: syms,
        }),
        None => Ok(PasswordPolicy::default()),
    }
}

// ── Seal a managed credential into the Vault (no plaintext in DB) ──────

pub async fn seal_managed_credential(
    vault_cfg: &VaultConfig,
    pool: &Pool<Postgres>,
    user_id: Uuid,
    managed_ad_dn: &str,
    username: &str,
    password: &str,
    duration_mins: i32,
) -> Result<Uuid, AppError> {
    let payload = serde_json::json!({
        "u": username,
        "p": password,
        "managed_dn": managed_ad_dn,
    });
    let plaintext = serde_json::to_vec(&payload)
        .map_err(|e| AppError::Internal(format!("JSON serialise: {e}")))?;

    let sealed = vault::seal(vault_cfg, &plaintext).await?;

    // Store as a credential_profile with a special label prefix so the UI
    // can distinguish managed credentials from user-created profiles.
    // Use upsert to handle retries where a previous attempt created the row.
    let profile_id: Uuid = sqlx::query_scalar(
        "INSERT INTO credential_profiles (user_id, label, encrypted_password, encrypted_dek, nonce, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::INTERVAL)
         ON CONFLICT (user_id, label) DO UPDATE
           SET encrypted_password = EXCLUDED.encrypted_password,
               encrypted_dek = EXCLUDED.encrypted_dek,
               nonce = EXCLUDED.nonce,
               expires_at = now() + ($6 || ' minutes')::INTERVAL,
               updated_at = now()
         RETURNING id",
    )
    .bind(user_id)
    .bind(format!("[managed] {managed_ad_dn}"))
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .bind(duration_mins.to_string())
    .fetch_one(pool)
    .await?;

    Ok(profile_id)
}

// ── Activate a checkout: rotate password, push to AD, seal to Vault ────

pub async fn activate_checkout(
    pool: &Pool<Postgres>,
    vault_cfg: &VaultConfig,
    checkout_id: Uuid,
) -> Result<(), AppError> {
    // W2-9 — race-free activation.
    //
    // Two approvers clicking "Activate" at the same instant used to each
    // read the row, see `status = 'Approved'`, and then each push a
    // password to AD + seal a credential. The second write won: the first
    // user's profile pointed at a password that no longer worked in AD.
    //
    // We now open a transaction and take a row-level lock via
    // `SELECT ... FOR UPDATE` before looking at `status`. The lock is
    // scoped to this one checkout row, so contention is bounded; the lock
    // is released when the transaction commits (after the final UPDATE) or
    // rolls back on error.
    let mut tx = pool.begin().await?;

    let req: CheckoutRequest =
        sqlx::query_as("SELECT * FROM password_checkout_requests WHERE id = $1 FOR UPDATE")
            .bind(checkout_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::NotFound("Checkout request not found".into()))?;

    if req.status != "Approved" && req.status != "Active" && req.status != "Scheduled" {
        return Err(AppError::Validation(format!(
            "Cannot activate checkout in '{}' state",
            req.status
        )));
    }

    // Idempotency on Active. The original race fix (FOR UPDATE around
    // the status check + update) only protects *concurrent* activations
    // within the same lock window. It does not protect against a second,
    // separate request after the first has fully committed: the row is
    // now `Active`, the status check above passes, and without this
    // short-circuit we would push a second AD password reset and seal a
    // second credential profile — invalidating the first profile that
    // was issued seconds earlier. Common trigger: user clicks Activate,
    // LDAP is slow, they refresh, the page re-fires activation on mount.
    //
    // If the row is already `Active`, return the existing
    // `vault_credential_id`; do not touch AD.
    if req.status == "Active" {
        if let Some(existing_profile_id) = req.vault_credential_id {
            tx.commit().await?;
            tracing::info!(
                "Checkout {} already Active — skipping AD reset, existing credential profile {}",
                checkout_id,
                existing_profile_id
            );
            return Ok(());
        }
        // Active but no profile linked: this should not happen — fall
        // through and rebuild the credential. We log it so it shows up
        // if some out-of-band process ever zeroes the column.
        tracing::warn!(
            "Checkout {} is Active but vault_credential_id is NULL — re-running activation",
            checkout_id
        );
    }

    let config_id = req
        .ad_sync_config_id
        .ok_or_else(|| AppError::Validation("Checkout has no associated AD sync config".into()))?;

    // Load password policy and generate new password
    let policy = load_policy(pool, config_id).await?;
    let new_password = generate_password(&policy);

    // Load the AD sync config for LDAP credentials
    let config: crate::services::ad_sync::AdSyncConfig =
        sqlx::query_as("SELECT * FROM ad_sync_configs WHERE id = $1")
            .bind(config_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound("AD sync config not found".into()))?;

    // Push password to AD via LDAP modify
    let bind_dn = config
        .pm_bind_user
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&config.bind_dn);
    let raw_pw = config
        .pm_bind_password
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&config.bind_password);
    // Decrypt vault-encrypted bind password
    let bind_pw = crate::services::vault::unseal_setting(vault_cfg, raw_pw).await?;

    let sam_account = ldap_reset_password(
        &config.ldap_url,
        bind_dn,
        &bind_pw,
        &req.managed_ad_dn,
        &new_password,
        config.tls_skip_verify,
        config.ca_cert_pem.as_deref(),
        false, // NOT a scramble - this is an activation, user needs to be able to login
    )
    .await?;

    // Seal credential into Vault and store as credential_profile
    let profile_id = seal_managed_credential(
        vault_cfg,
        pool,
        req.requester_user_id,
        &req.managed_ad_dn,
        &sam_account,
        &new_password,
        req.requested_duration_mins,
    )
    .await?;

    // Update checkout to Active with expiry (inside the same transaction so
    // the row lock held by `SELECT ... FOR UPDATE` is released atomically).
    sqlx::query(
        "UPDATE password_checkout_requests
         SET status = 'Active',
             expires_at = now() + ($1 || ' minutes')::INTERVAL,
             vault_credential_id = $2,
             updated_at = now()
         WHERE id = $3",
    )
    .bind(req.requested_duration_mins.to_string())
    .bind(profile_id)
    .bind(checkout_id)
    .execute(&mut *tx)
    .await?;

    // Relink any profiles that were linked to a previous (expired) checkout
    // for the same managed DN — point them to this new checkout instead.
    // Also refresh expires_at so the tunnel query's `cp.expires_at > now()`
    // filter still passes with the new checkout's duration.
    sqlx::query(
        "UPDATE credential_profiles
         SET checkout_id = $1,
             expires_at = now() + ($4 || ' minutes')::INTERVAL,
             updated_at = now()
         WHERE user_id = $2
           AND checkout_id IN (
               SELECT id FROM password_checkout_requests
               WHERE managed_ad_dn = $3
                 AND id != $1
                 AND requester_user_id = $2
           )",
    )
    .bind(checkout_id)
    .bind(req.requester_user_id)
    .bind(&req.managed_ad_dn)
    .bind(req.requested_duration_mins.to_string())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    tracing::info!(
        "Checkout {} activated for DN '{}', expires in {} mins",
        checkout_id,
        req.managed_ad_dn,
        req.requested_duration_mins
    );

    // Audit
    crate::services::audit::log(
        pool,
        Some(req.requester_user_id),
        "password_checkout.activated",
        &serde_json::json!({
            "checkout_id": checkout_id,
            "managed_ad_dn": req.managed_ad_dn,
            "duration_mins": req.requested_duration_mins,
        }),
    )
    .await?;

    Ok(())
}

// ── Check in a checkout early: scramble password, mark CheckedIn ───────

pub async fn checkin_checkout(
    pool: &Pool<Postgres>,
    vault_cfg: &VaultConfig,
    checkout_id: Uuid,
    user_id: Uuid,
) -> Result<(), AppError> {
    let req: CheckoutRequest = sqlx::query_as(
        "SELECT * FROM password_checkout_requests WHERE id = $1 AND requester_user_id = $2",
    )
    .bind(checkout_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Checkout request not found".into()))?;

    if req.status != "Active" {
        return Err(AppError::Validation(format!(
            "Only Active checkouts can be checked in, current status: '{}'",
            req.status
        )));
    }

    let config_id = req
        .ad_sync_config_id
        .ok_or_else(|| AppError::Internal("Checkout has no AD sync config".into()))?;

    // Generate a random password to scramble the account in AD
    let policy = load_policy(pool, config_id).await?;
    let scramble_password = generate_password(&policy);

    let config: crate::services::ad_sync::AdSyncConfig =
        sqlx::query_as("SELECT * FROM ad_sync_configs WHERE id = $1")
            .bind(config_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound("AD sync config not found".into()))?;

    let bind_dn = config
        .pm_bind_user
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&config.bind_dn);
    let raw_pw = config
        .pm_bind_password
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&config.bind_password);
    let bind_pw = crate::services::vault::unseal_setting(vault_cfg, raw_pw).await?;

    // Push scrambled password to AD
    ldap_reset_password(
        &config.ldap_url,
        bind_dn,
        &bind_pw,
        &req.managed_ad_dn,
        &scramble_password,
        config.tls_skip_verify,
        config.ca_cert_pem.as_deref(),
        true, // This IS a scramble - ignore lockouts if reset succeeded
    )
    .await
    .map(|_| ())
    .map_err(|e| {
        AppError::Internal(format!(
            "Failed to scramble password for DN '{}': {e}",
            req.managed_ad_dn
        ))
    })?;

    // Expire the managed credential profile. W2-8 — surface errors instead
    // of swallowing them with `let _`.
    if let Some(profile_id) = req.vault_credential_id {
        if let Err(e) =
            sqlx::query("UPDATE credential_profiles SET expires_at = now() WHERE id = $1")
                .bind(profile_id)
                .execute(pool)
                .await
        {
            tracing::warn!("Failed to expire credential profile {profile_id} during check-in: {e}");
        }
    }

    // Mark checkout as CheckedIn
    sqlx::query(
        "UPDATE password_checkout_requests SET status = 'CheckedIn', updated_at = now() WHERE id = $1",
    )
    .bind(checkout_id)
    .execute(pool)
    .await?;

    tracing::info!(
        "Checkout {} checked in by user {}, password scrambled for DN '{}'",
        checkout_id,
        user_id,
        req.managed_ad_dn
    );

    crate::services::audit::log(
        pool,
        Some(user_id),
        "password_checkout.checked_in",
        &serde_json::json!({
            "checkout_id": checkout_id,
            "managed_ad_dn": req.managed_ad_dn,
        }),
    )
    .await?;

    Ok(())
}

// ── Expire a checkout: rotate to orphan password, mark expired ─────────

pub async fn expire_checkout(
    pool: &Pool<Postgres>,
    _vault_cfg: &VaultConfig,
    checkout_id: Uuid,
) -> Result<(), AppError> {
    let req: CheckoutRequest =
        sqlx::query_as("SELECT * FROM password_checkout_requests WHERE id = $1")
            .bind(checkout_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound("Checkout request not found".into()))?;

    if req.status != "Active" {
        return Ok(()); // Already expired or not active
    }

    let config_id = match req.ad_sync_config_id {
        Some(id) => id,
        None => {
            // Just mark expired if no config
            sqlx::query(
                "UPDATE password_checkout_requests SET status = 'Expired', updated_at = now() WHERE id = $1",
            )
            .bind(checkout_id)
            .execute(pool)
            .await?;
            return Ok(());
        }
    };

    // Generate a new random password to orphan the old one in AD
    let policy = load_policy(pool, config_id).await?;
    let orphan_password = generate_password(&policy);

    let config: crate::services::ad_sync::AdSyncConfig =
        sqlx::query_as("SELECT * FROM ad_sync_configs WHERE id = $1")
            .bind(config_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound("AD sync config not found".into()))?;

    let bind_dn = config
        .pm_bind_user
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&config.bind_dn);
    let raw_pw = config
        .pm_bind_password
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&config.bind_password);
    // Decrypt vault-encrypted bind password
    let bind_pw = crate::services::vault::unseal_setting(_vault_cfg, raw_pw)
        .await
        .unwrap_or_else(|_| raw_pw.to_string());

    // Best-effort: push orphan password to AD
    if let Err(e) = ldap_reset_password(
        &config.ldap_url,
        bind_dn,
        &bind_pw,
        &req.managed_ad_dn,
        &orphan_password,
        config.tls_skip_verify,
        config.ca_cert_pem.as_deref(),
        true, // This IS a scramble - ignore lockouts
    )
    .await
    .map(|_| ())
    {
        tracing::error!(
            "Failed to orphan password for checkout {checkout_id}, DN '{}': {e}",
            req.managed_ad_dn
        );
    }

    // Mark the credential profile as expired (don't delete — mapping stays intact).
    // W2-8 — surface errors instead of swallowing them with `let _`.
    if let Some(profile_id) = req.vault_credential_id {
        if let Err(e) =
            sqlx::query("UPDATE credential_profiles SET expires_at = now() WHERE id = $1")
                .bind(profile_id)
                .execute(pool)
                .await
        {
            tracing::warn!(
                "Failed to expire credential profile {profile_id} during checkout expiry: {e}"
            );
        }
    }

    // Mark checkout as Expired
    sqlx::query(
        "UPDATE password_checkout_requests SET status = 'Expired', updated_at = now() WHERE id = $1",
    )
    .bind(checkout_id)
    .execute(pool)
    .await?;

    tracing::info!(
        "Checkout {} expired, orphan password pushed for DN '{}'",
        checkout_id,
        req.managed_ad_dn
    );

    crate::services::audit::log(
        pool,
        Some(req.requester_user_id),
        "password_checkout.expired",
        &serde_json::json!({
            "checkout_id": checkout_id,
            "managed_ad_dn": req.managed_ad_dn,
        }),
    )
    .await?;

    Ok(())
}

// ── LDAP password reset via unicodePwd modify ──────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn ldap_reset_password(
    ldap_url: &str,
    bind_dn: &str,
    bind_password: &str,
    target_dn: &str,
    new_password: &str,
    tls_skip_verify: bool,
    ca_cert_pem: Option<&str>,
    is_scramble: bool,
) -> Result<String, AppError> {
    use ldap3::{LdapConnAsync, LdapConnSettings, Mod};
    use std::collections::HashSet;
    use std::time::Duration;

    // Log DNS resolution to identify which DC we're hitting
    {
        let host = ldap_url
            .trim_start_matches("ldaps://")
            .trim_start_matches("ldap://")
            .split(':')
            .next()
            .unwrap_or(ldap_url);
        match tokio::net::lookup_host(format!("{}:636", host)).await {
            Ok(addrs) => {
                let ips: Vec<_> = addrs.map(|a| a.ip().to_string()).collect();
                tracing::info!("LDAP password reset: '{}' resolves to IPs: {:?}", host, ips);
            }
            Err(e) => {
                tracing::warn!("Could not resolve LDAP host '{}': {}", host, e);
            }
        }
    }

    let mut settings = LdapConnSettings::new()
        .set_conn_timeout(Duration::from_secs(15))
        .set_starttls(false)
        .set_no_tls_verify(tls_skip_verify);

    if let Some(pem) = ca_cert_pem {
        if !pem.is_empty() && !tls_skip_verify {
            let tls_config = crate::services::ad_sync::build_tls_config_with_ca(pem)
                .map_err(|e| AppError::Internal(format!("TLS config: {e}")))?;
            settings = settings.set_config(tls_config);
        }
    }

    let (conn, mut ldap) = LdapConnAsync::with_settings(settings, ldap_url)
        .await
        .map_err(|e| AppError::Internal(format!("LDAP connect: {e}")))?;
    ldap3::drive!(conn);

    ldap.simple_bind(bind_dn, bind_password)
        .await
        .map_err(|e| AppError::Internal(format!("LDAP bind: {e}")))?
        .success()
        .map_err(|e| AppError::Internal(format!("LDAP bind failed: {e}")))?;

    tracing::info!(
        "LDAP bind successful for DN '{}', resetting password for '{}'",
        bind_dn,
        target_dn
    );

    // Check pwdLastSet BEFORE modify
    {
        use ldap3::{Scope, SearchEntry};
        let (rs, _result) = ldap
            .search(
                target_dn,
                Scope::Base,
                "(objectClass=*)",
                vec!["pwdLastSet"],
            )
            .await
            .map_err(|e| AppError::Internal(format!("LDAP search pre-modify: {e}")))?
            .success()
            .map_err(|e| AppError::Internal(format!("LDAP search pre-modify failed: {e}")))?;
        if let Some(entry) = rs.into_iter().next() {
            let se = SearchEntry::construct(entry);
            let pwd_last_set = se.attrs.get("pwdLastSet").cloned().unwrap_or_default();
            tracing::info!(
                "PRE-MODIFY pwdLastSet for '{}': {:?}",
                target_dn,
                pwd_last_set
            );
        } else {
            tracing::warn!("PRE-MODIFY: no entry found for '{}'", target_dn);
        }
    }

    // AD requires unicodePwd as a quoted UTF-16LE encoded string
    let quoted = format!("\"{}\"", new_password);
    let utf16le: Vec<u8> = quoted
        .encode_utf16()
        .flat_map(|c| c.to_le_bytes())
        .collect();

    tracing::info!(
        "Attempting unicodePwd modify for '{}': password_len={}, utf16le_len={}",
        target_dn,
        new_password.len(),
        utf16le.len()
    );

    let mods = vec![Mod::Replace(
        Vec::from("unicodePwd".as_bytes()),
        HashSet::from([utf16le.clone()]),
    )];

    let modify_result = ldap
        .modify(target_dn, mods)
        .await
        .map_err(|e| AppError::Internal(format!("LDAP modify: {e}")))?;

    tracing::info!(
        "LDAP modify result for '{}': rc={}, message='{}', refs={:?}",
        target_dn,
        modify_result.rc,
        modify_result.text,
        modify_result.refs
    );

    if modify_result.rc != 0 {
        let mut err_msg = format!(
            "LDAP password reset failed for '{}' (rc={}): {}",
            target_dn, modify_result.rc, modify_result.text
        );

        // ── Enhanced Diagnostics for Insufficient Access (rc=50) ──
        if modify_result.rc == 50 {
            use ldap3::controls::RawControl;
            use ldap3::{Scope, SearchEntry};

            // Query adminCount and nTSecurityDescriptor to pinpoint why access is denied.
            // OID for LDAP_SERVER_SD_FLAGS_OID is 1.2.840.113556.1.4.801
            // BER for Integer 7 (Owner+Group+DACL) is 02 01 07
            let sd_flags_control = RawControl {
                ctype: "1.2.840.113556.1.4.801".to_string(),
                crit: false,
                val: Some(vec![0x02, 0x01, 0x07]),
            };

            let diag_search = ldap
                .with_controls(vec![sd_flags_control])
                .search(
                    target_dn,
                    Scope::Base,
                    "(objectClass=*)",
                    vec!["adminCount", "nTSecurityDescriptor"],
                )
                .await;

            if let Ok(ldap3::SearchResult(rs, _)) = diag_search {
                for entry in rs {
                    let se = SearchEntry::construct(entry);

                    // 1. Check for Protected Account (adminCount == 1)
                    if let Some(ac) = se.attrs.get("adminCount").and_then(|v| v.first()) {
                        if ac == "1" {
                            err_msg.push_str("\n\nDIAGNOSTIC: This account is PROTECTED (adminCount=1). Permissions must be applied to the AdminSDHolder template container instead of the OU.");
                        }
                    }

                    // 2. Check for Blocked Inheritance (DACL_PROTECTED bit in SD Control field)
                    if let Some(sd_bytes) = se
                        .bin_attrs
                        .get("nTSecurityDescriptor")
                        .and_then(|v| v.first())
                    {
                        // SECURITY_DESCRIPTOR header: Revision(1), Sbz1(1), Control(2, LE)
                        if sd_bytes.len() >= 4 {
                            let control = u16::from_le_bytes([sd_bytes[2], sd_bytes[3]]);
                            // SE_DACL_PROTECTED = 0x1000
                            if (control & 0x1000) != 0 {
                                err_msg.push_str("\n\nDIAGNOSTIC: Inheritance is BLOCKED on this account. Either enable inheritance on the object or apply permissions directly to this user.");
                            }
                        }
                    }
                }
            }
        }

        return Err(AppError::Internal(err_msg));
    }

    // Check pwdLastSet AFTER modify to verify
    {
        use ldap3::{Scope, SearchEntry};
        let (rs, _result) = ldap
            .search(
                target_dn,
                Scope::Base,
                "(objectClass=*)",
                vec!["pwdLastSet"],
            )
            .await
            .map_err(|e| AppError::Internal(format!("LDAP search post-modify: {e}")))?
            .success()
            .map_err(|e| AppError::Internal(format!("LDAP search post-modify failed: {e}")))?;
        if let Some(entry) = rs.into_iter().next() {
            let se = SearchEntry::construct(entry);
            let pwd_last_set = se.attrs.get("pwdLastSet").cloned().unwrap_or_default();
            tracing::info!(
                "POST-MODIFY pwdLastSet for '{}': {:?}",
                target_dn,
                pwd_last_set
            );
        } else {
            tracing::warn!("POST-MODIFY: no entry found for '{}'", target_dn);
        }
    }

    // Verify the password was actually changed by binding as the target user
    let verify_result = ldap.simple_bind(target_dn, new_password).await;
    match verify_result {
        Ok(ref res) if res.rc == 0 => {
            tracing::info!(
                "VERIFICATION BIND SUCCEEDED for '{}' — password change confirmed on this DC",
                target_dn
            );
        }
        Ok(ref res) => {
            let is_locked = res.text.contains("data 775");
            // data 52f = ERROR_ACCOUNT_RESTRICTIONS (smart card required, logon hours,
            // workstation restrictions, Protected Users group, etc.). The password modify
            // itself succeeded (rc=0); AD is only refusing the simple_bind verification
            // due to non-password account policy. Treat as success.
            let is_account_restricted = res.text.contains("data 52f");
            if is_account_restricted {
                tracing::warn!(
                    "VERIFICATION BIND for '{}' blocked by AD account restrictions (data 52f: smart card required / logon hours / workstation restriction / Protected Users). Password modify rc=0 so change is confirmed — proceeding without simple-bind verification.",
                    target_dn
                );
            } else if is_locked {
                if is_scramble {
                    tracing::warn!(
                        "VERIFICATION BIND FAILED for '{}' with DATA 775 (Locked Out) — but proceeding because this is a scramble operation and modify rc=0.",
                        target_dn
                    );
                } else {
                    tracing::error!(
                        "VERIFICATION BIND FAILED for '{}': Account is LOCKED OUT (data 775) in Active Directory.",
                        target_dn
                    );
                    return Err(AppError::Validation(format!(
                        "Account is currently LOCKED OUT in Active Directory (DN: '{}'). Please unlock the account before requesting a checkout.",
                        target_dn
                    )));
                }
            } else {
                // Decode the common AD sub-status codes (data 525/52e/530/531/532/533/52f/701/773/775)
                // into a user-friendly validation message instead of returning the raw
                // "Password modify returned rc=0 but verification bind failed (rc=49) … data XXX"
                // string that surfaces in the Credentials UI.
                if let Some(hint) = parse_ldap_error_hint(&res.text) {
                    tracing::error!(
                        "VERIFICATION BIND FAILED for '{}': rc={}, message='{}' → {}",
                        target_dn,
                        res.rc,
                        res.text,
                        hint
                    );
                    return Err(AppError::Validation(hint));
                }
                tracing::error!(
                    "VERIFICATION BIND FAILED for '{}': rc={}, message='{}' — password may NOT have changed!",
                    target_dn, res.rc, res.text
                );
                return Err(AppError::Internal(format!(
                    "Password modify returned rc=0 but verification bind failed (rc={}) for '{}': {}",
                    res.rc, target_dn, res.text
                )));
            }
        }
        Err(ref e) => {
            tracing::error!(
                "VERIFICATION BIND ERROR for '{}': {} — password may NOT have changed!",
                target_dn,
                e
            );
            return Err(AppError::Internal(format!(
                "Password modify returned rc=0 but verification bind errored for '{}': {}",
                target_dn, e
            )));
        }
    }

    // Query the actual sAMAccountName so callers can use the real login name
    // (the CN from the DN may be a display name like "Doe, John (Support)")
    // Re-bind as the service account since we just bound as the target user
    ldap.simple_bind(bind_dn, bind_password)
        .await
        .map_err(|e| AppError::Internal(format!("LDAP re-bind: {e}")))?
        .success()
        .map_err(|e| AppError::Internal(format!("LDAP re-bind failed: {e}")))?;

    let sam_account_name = {
        use ldap3::{Scope, SearchEntry};
        let (rs, _) = ldap
            .search(
                target_dn,
                Scope::Base,
                "(objectClass=*)",
                vec!["sAMAccountName"],
            )
            .await
            .map_err(|e| AppError::Internal(format!("LDAP sAMAccountName search: {e}")))?
            .success()
            .map_err(|e| AppError::Internal(format!("LDAP sAMAccountName search failed: {e}")))?;
        rs.into_iter()
            .next()
            .and_then(|entry| {
                let se = SearchEntry::construct(entry);
                se.attrs
                    .get("sAMAccountName")
                    .and_then(|v| v.first().cloned())
            })
            .unwrap_or_else(|| {
                tracing::warn!(
                    "Could not read sAMAccountName for '{}', falling back to CN",
                    target_dn
                );
                extract_cn_from_dn(target_dn)
            })
    };

    tracing::info!(
        "Password reset completed and VERIFIED for DN '{}', sAMAccountName='{}'",
        target_dn,
        sam_account_name
    );

    let _ = ldap.unbind().await;

    Ok(sam_account_name)
}

// ── Auto-rotation: rotate service account password ─────────────────────

pub async fn auto_rotate_service_account(
    pool: &Pool<Postgres>,
    vault_cfg: &VaultConfig,
    config_id: Uuid,
) -> Result<(), AppError> {
    let config: crate::services::ad_sync::AdSyncConfig =
        sqlx::query_as("SELECT * FROM ad_sync_configs WHERE id = $1")
            .bind(config_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| AppError::NotFound("AD sync config not found".into()))?;

    if !config.pm_auto_rotate_enabled {
        return Ok(());
    }

    let policy = load_policy(pool, config_id).await?;
    let new_password = generate_password(&policy);

    // Use the PM bind user if configured, else the main bind_dn
    let bind_dn = config
        .pm_bind_user
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&config.bind_dn);
    let raw_pw = config
        .pm_bind_password
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&config.bind_password);
    // Decrypt vault-encrypted bind password
    let bind_pw = crate::services::vault::unseal_setting(vault_cfg, raw_pw).await?;

    // Reset the service account's own password
    let _ = ldap_reset_password(
        &config.ldap_url,
        bind_dn,
        &bind_pw,
        &config.bind_dn,
        &new_password,
        config.tls_skip_verify,
        config.ca_cert_pem.as_deref(),
        false, // Manual rotation - verification required
    )
    .await?;

    // Verify the new password works by binding with it
    {
        use ldap3::{LdapConnAsync, LdapConnSettings};
        use std::time::Duration;

        let settings = LdapConnSettings::new()
            .set_conn_timeout(Duration::from_secs(15))
            .set_no_tls_verify(config.tls_skip_verify);

        let (conn, mut ldap) = LdapConnAsync::with_settings(settings, &config.ldap_url)
            .await
            .map_err(|e| AppError::Internal(format!("Verify connect: {e}")))?;
        ldap3::drive!(conn);

        ldap.simple_bind(&config.bind_dn, &new_password)
            .await
            .map_err(|e| AppError::Internal(format!("Verify bind: {e}")))?
            .success()
            .map_err(|e| {
                AppError::Internal(format!(
                    "New password verification failed — AD may be out of sync: {e}"
                ))
            })?;

        let _ = ldap.unbind().await;
    }

    // Seal the new password and update the config's bind_password
    let sealed = vault::seal_setting(vault_cfg, &new_password).await?;
    sqlx::query(
        "UPDATE ad_sync_configs SET bind_password = $1, pm_last_rotated_at = now(), updated_at = now() WHERE id = $2",
    )
    .bind(&sealed)
    .bind(config_id)
    .execute(pool)
    .await?;

    tracing::info!(
        "Auto-rotated service account password for AD sync config '{}'",
        config.label
    );

    crate::services::audit::log(
        pool,
        None,
        "password_management.auto_rotated",
        &serde_json::json!({
            "config_id": config_id,
            "label": config.label,
        }),
    )
    .await?;

    Ok(())
}

// ── Helper: extract CN from a DN ───────────────────────────────────────

fn extract_cn_from_dn(dn: &str) -> String {
    dn.split(',')
        .next()
        .and_then(|part| {
            part.strip_prefix("CN=")
                .or_else(|| part.strip_prefix("cn="))
        })
        .unwrap_or(dn)
        .to_string()
}

// ── Background workers ─────────────────────────────────────────────────

use crate::services::app_state::{BootPhase, SharedState};

/// Spawn the checkout expiration scrubber (runs every 60s).
///
/// Uses the shared worker harness so the loop obeys shutdown cancellation,
/// bounds each iteration with a timeout, and backs off with jitter after an
/// error (W2-4 / W2-7).
pub fn spawn_expiration_worker(
    state: SharedState,
    shutdown: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    use crate::services::worker::{spawn_periodic, PeriodicConfig};
    spawn_periodic(
        PeriodicConfig::every_60s("checkout_expiration_scrubber"),
        shutdown,
        move || {
            let state = state.clone();
            async move { run_expiration_scrub(state).await }
        },
    )
}

async fn run_expiration_scrub(state: SharedState) -> anyhow::Result<()> {
    let (db, vault_cfg) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        let db = s.db.clone().ok_or_else(|| anyhow::anyhow!("No DB"))?;
        let vault = s
            .config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| anyhow::anyhow!("No vault config"))?;
        (db, vault)
    };

    // Find active checkouts that have expired
    let expired_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM password_checkout_requests
         WHERE status = 'Active' AND expires_at < now()",
    )
    .fetch_all(&db.pool)
    .await?;

    for checkout_id in expired_ids {
        if let Err(e) = expire_checkout(&db.pool, &vault_cfg, checkout_id).await {
            tracing::error!("Failed to expire checkout {checkout_id}: {e}");
        }
    }

    // Expire stale Approved/Pending checkouts where created_at + duration has passed
    let stale_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM password_checkout_requests
         WHERE status IN ('Approved', 'Pending')
           AND created_at + (requested_duration_mins || ' minutes')::INTERVAL < now()",
    )
    .fetch_all(&db.pool)
    .await?;

    for checkout_id in stale_ids {
        sqlx::query(
            "UPDATE password_checkout_requests SET status = 'Expired', updated_at = now() WHERE id = $1",
        )
        .bind(checkout_id)
        .execute(&db.pool)
        .await?;
        tracing::info!("Stale checkout {checkout_id} marked as Expired (never activated)");
    }

    // Activate any scheduled checkouts whose start time has arrived
    let due_scheduled: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM password_checkout_requests
         WHERE status = 'Scheduled'
           AND scheduled_start_at IS NOT NULL
           AND scheduled_start_at <= now()",
    )
    .fetch_all(&db.pool)
    .await?;

    for checkout_id in due_scheduled {
        if let Err(e) = activate_checkout(&db.pool, &vault_cfg, checkout_id).await {
            tracing::error!("Failed to activate scheduled checkout {checkout_id}: {e}");
        } else {
            tracing::info!("Scheduled checkout {checkout_id} activated");
        }
    }

    Ok(())
}

/// Spawn the auto-rotation worker (runs daily).
///
/// W2-4 / W2-7 — uses the shared worker harness for shutdown cancellation,
/// per-iteration timeout, and jittered error backoff.
pub fn spawn_auto_rotation_worker(
    state: SharedState,
    shutdown: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    use crate::services::worker::{spawn_periodic, PeriodicConfig};
    spawn_periodic(
        PeriodicConfig {
            label: "checkout_auto_rotation",
            initial_delay: std::time::Duration::from_secs(60),
            interval: std::time::Duration::from_secs(24 * 3600),
            // Rotation can touch many managed accounts; give it a generous budget.
            iteration_timeout: std::time::Duration::from_secs(30 * 60),
            error_backoff_base: std::time::Duration::from_secs(60),
        },
        shutdown,
        move || {
            let state = state.clone();
            async move { run_auto_rotation(state).await }
        },
    )
}

async fn run_auto_rotation(state: SharedState) -> anyhow::Result<()> {
    let (db, vault_cfg) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Ok(());
        }
        let db = s.db.clone().ok_or_else(|| anyhow::anyhow!("No DB"))?;
        let vault = s
            .config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| anyhow::anyhow!("No vault config"))?;
        (db, vault)
    };

    // Find configs due for rotation
    let due_configs: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM ad_sync_configs
         WHERE pm_enabled = true
           AND pm_auto_rotate_enabled = true
           AND (pm_last_rotated_at IS NULL
                OR pm_last_rotated_at < now() - (pm_auto_rotate_interval_days || ' days')::INTERVAL)",
    )
    .fetch_all(&db.pool)
    .await?;

    for config_id in due_configs {
        if let Err(e) = auto_rotate_service_account(&db.pool, &vault_cfg, config_id).await {
            tracing::error!("Auto-rotation failed for config {config_id}: {e}");
        }
    }

    Ok(())
}

// ── User-facing checkout queries & mutations ──────────────────────────

use sqlx::PgPool;

/// Tuple shape returned by [`list_managed_accounts_for_user`].
/// Fields: (mapping_id, user_id, managed_ad_dn, can_self_approve,
///          ad_sync_config_id, created_at, friendly_name, pm_allow_emergency_bypass)
pub type ManagedAccountRow = (
    Uuid,
    Uuid,
    String,
    bool,
    Option<Uuid>,
    chrono::DateTime<chrono::Utc>,
    Option<String>,
    Option<bool>,
);

/// Managed-account mappings for a user, joined with their AD-sync config
/// to expose `pm_allow_emergency_bypass`.
pub async fn list_managed_accounts_for_user(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<ManagedAccountRow>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT m.id, m.user_id, m.managed_ad_dn, m.can_self_approve, m.ad_sync_config_id,
                m.created_at, m.friendly_name, c.pm_allow_emergency_bypass
         FROM user_account_mappings m
         LEFT JOIN ad_sync_configs c ON c.id = m.ad_sync_config_id
         WHERE m.user_id = $1
         ORDER BY m.managed_ad_dn",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn find_mapping(
    pool: &PgPool,
    user_id: Uuid,
    managed_ad_dn: &str,
) -> Result<Option<UserAccountMapping>, crate::error::AppError> {
    let row = sqlx::query_as(
        "SELECT * FROM user_account_mappings WHERE user_id = $1 AND managed_ad_dn = $2",
    )
    .bind(user_id)
    .bind(managed_ad_dn)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Does the user already have a Pending/Approved/Scheduled/Active checkout
/// for the given managed AD DN?
pub async fn has_open_checkout(
    pool: &PgPool,
    user_id: Uuid,
    managed_ad_dn: &str,
) -> Result<bool, crate::error::AppError> {
    let existing: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM password_checkout_requests
         WHERE requester_user_id = $1 AND managed_ad_dn = $2 AND status IN ('Pending','Approved','Scheduled','Active')",
    )
    .bind(user_id)
    .bind(managed_ad_dn)
    .fetch_optional(pool)
    .await?;
    Ok(existing.is_some())
}

/// Returns whether emergency bypass is allowed for the given AD-sync config.
/// Returns `false` if the config is missing or the flag is unset.
pub async fn emergency_bypass_allowed(
    pool: &PgPool,
    ad_sync_config_id: Option<Uuid>,
) -> Result<bool, crate::error::AppError> {
    let Some(cfg_id) = ad_sync_config_id else {
        return Ok(false);
    };
    let allow: Option<bool> =
        sqlx::query_scalar("SELECT pm_allow_emergency_bypass FROM ad_sync_configs WHERE id = $1")
            .bind(cfg_id)
            .fetch_optional(pool)
            .await?;
    Ok(allow.unwrap_or(false))
}

/// Insert a new checkout request and return its ID.
#[allow(clippy::too_many_arguments)]
pub async fn insert_request(
    pool: &PgPool,
    requester_user_id: Uuid,
    managed_ad_dn: &str,
    ad_sync_config_id: Option<Uuid>,
    status: &str,
    requested_duration_mins: i32,
    justification_comment: &str,
    friendly_name: Option<&str>,
    emergency_bypass: bool,
    scheduled_start_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<Uuid, crate::error::AppError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO password_checkout_requests
         (requester_user_id, managed_ad_dn, ad_sync_config_id, status, requested_duration_mins, justification_comment, friendly_name, emergency_bypass, scheduled_start_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(requester_user_id)
    .bind(managed_ad_dn)
    .bind(ad_sync_config_id)
    .bind(status)
    .bind(requested_duration_mins)
    .bind(justification_comment)
    .bind(friendly_name)
    .bind(emergency_bypass)
    .bind(scheduled_start_at)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// List the requesting user's recent checkouts (most recent first, capped at 100).
pub async fn list_for_user(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<CheckoutRequest>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT * FROM password_checkout_requests WHERE requester_user_id = $1 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Fetch a checkout if it belongs to `user_id`.
pub async fn get_owned_by_user(
    pool: &PgPool,
    checkout_id: Uuid,
    user_id: Uuid,
) -> Result<Option<CheckoutRequest>, crate::error::AppError> {
    let row = sqlx::query_as(
        "SELECT * FROM password_checkout_requests WHERE id = $1 AND requester_user_id = $2",
    )
    .bind(checkout_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Fetch a checkout by id (any requester).
pub async fn get_by_id(
    pool: &PgPool,
    checkout_id: Uuid,
) -> Result<Option<CheckoutRequest>, crate::error::AppError> {
    let row = sqlx::query_as("SELECT * FROM password_checkout_requests WHERE id = $1")
        .bind(checkout_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

// ── Approval flow ─────────────────────────────────────────────────────

/// All role IDs that `user_id` holds as an approver.
pub async fn approver_role_ids(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<Uuid>, crate::error::AppError> {
    let rows =
        sqlx::query_scalar("SELECT role_id FROM approval_role_assignments WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

/// Pending checkout requests visible to approvers holding any of `role_ids`.
pub async fn pending_for_roles(
    pool: &PgPool,
    role_ids: &[Uuid],
) -> Result<Vec<CheckoutRequest>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT pcr.*, u.username AS requester_username
         FROM password_checkout_requests pcr
         LEFT JOIN users u ON u.id = pcr.requester_user_id
         WHERE pcr.status = 'Pending'
         AND EXISTS (
             SELECT 1 FROM approval_role_accounts ara
             WHERE ara.role_id = ANY($1)
             AND ara.managed_ad_dn = pcr.managed_ad_dn
         )
         ORDER BY pcr.created_at ASC LIMIT 200",
    )
    .bind(role_ids)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Does any of the approver's roles cover the given managed account DN?
pub async fn roles_cover_account(
    pool: &PgPool,
    role_ids: &[Uuid],
    managed_ad_dn: &str,
) -> Result<bool, crate::error::AppError> {
    let covers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM approval_role_accounts
         WHERE role_id = ANY($1) AND managed_ad_dn = $2",
    )
    .bind(role_ids)
    .bind(managed_ad_dn)
    .fetch_one(pool)
    .await?;
    Ok(covers > 0)
}

/// Return distinct user ids whose approval role covers the given DN.
///
/// Used by the notification dispatcher to fan out "Pending approval"
/// emails — we resolve every approver who could action this request.
pub async fn approvers_for_account(
    pool: &PgPool,
    managed_ad_dn: &str,
) -> Result<Vec<Uuid>, crate::error::AppError> {
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT DISTINCT ara_users.user_id
           FROM approval_role_accounts ara
           JOIN approval_role_assignments ara_users ON ara_users.role_id = ara.role_id
          WHERE ara.managed_ad_dn = $1",
    )
    .bind(managed_ad_dn)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Mark a pending checkout as Approved/Denied by the given approver.
pub async fn set_decision(
    pool: &PgPool,
    checkout_id: Uuid,
    approver_user_id: Uuid,
    approved: bool,
) -> Result<(), crate::error::AppError> {
    let status = if approved { "Approved" } else { "Denied" };
    let sql = format!(
        "UPDATE password_checkout_requests SET status = '{status}', approved_by_user_id = $1, updated_at = now() WHERE id = $2"
    );
    sqlx::query(&sql)
        .bind(approver_user_id)
        .bind(checkout_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ── User Account Mapping administration ────────────────────────────────

pub async fn list_account_mappings(
    pool: &PgPool,
) -> Result<Vec<UserAccountMapping>, crate::error::AppError> {
    let rows = sqlx::query_as("SELECT * FROM user_account_mappings ORDER BY created_at")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// List all `managed_ad_dn` values already mapped for the given config.
pub async fn list_mapped_dns_for_config(
    pool: &PgPool,
    config_id: Uuid,
) -> Result<Vec<String>, crate::error::AppError> {
    let rows = sqlx::query_scalar(
        "SELECT managed_ad_dn FROM user_account_mappings WHERE ad_sync_config_id = $1",
    )
    .bind(config_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Most-recent checkout requests across the whole system (admin view).
pub async fn list_all_recent(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<CheckoutRequest>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT * FROM password_checkout_requests ORDER BY created_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn upsert_account_mapping(
    pool: &PgPool,
    user_id: Uuid,
    managed_ad_dn: &str,
    can_self_approve: bool,
    ad_sync_config_id: Option<Uuid>,
    friendly_name: Option<&str>,
) -> Result<Uuid, crate::error::AppError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO user_account_mappings (user_id, managed_ad_dn, can_self_approve, ad_sync_config_id, friendly_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, managed_ad_dn) DO UPDATE SET can_self_approve = $3, ad_sync_config_id = $4, friendly_name = $5
         RETURNING id",
    )
    .bind(user_id)
    .bind(managed_ad_dn)
    .bind(can_self_approve)
    .bind(ad_sync_config_id)
    .bind(friendly_name)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn delete_account_mapping(
    pool: &PgPool,
    mapping_id: Uuid,
) -> Result<(), crate::error::AppError> {
    sqlx::query("DELETE FROM user_account_mappings WHERE id = $1")
        .bind(mapping_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_account_mapping(
    pool: &PgPool,
    mapping_id: Uuid,
    can_self_approve: Option<bool>,
    friendly_name: Option<&str>,
) -> Result<bool, crate::error::AppError> {
    let res = sqlx::query(
        "UPDATE user_account_mappings SET
            can_self_approve = COALESCE($2, can_self_approve),
            friendly_name    = COALESCE($3, friendly_name)
         WHERE id = $1",
    )
    .bind(mapping_id)
    .bind(can_self_approve)
    .bind(friendly_name)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

// ── Approval Role administration ──────────────────────────────────────

pub async fn list_approval_roles(
    pool: &PgPool,
) -> Result<Vec<ApprovalRole>, crate::error::AppError> {
    let rows = sqlx::query_as("SELECT * FROM approval_roles ORDER BY name")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn create_approval_role(
    pool: &PgPool,
    name: &str,
    description: &str,
) -> Result<Uuid, crate::error::AppError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO approval_roles (name, description) VALUES ($1, $2) RETURNING id",
    )
    .bind(name)
    .bind(description)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn update_approval_role_name(
    pool: &PgPool,
    role_id: Uuid,
    name: &str,
) -> Result<(), crate::error::AppError> {
    sqlx::query("UPDATE approval_roles SET name = $1, updated_at = now() WHERE id = $2")
        .bind(name)
        .bind(role_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_approval_role_description(
    pool: &PgPool,
    role_id: Uuid,
    description: &str,
) -> Result<(), crate::error::AppError> {
    sqlx::query("UPDATE approval_roles SET description = $1, updated_at = now() WHERE id = $2")
        .bind(description)
        .bind(role_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_approval_role(
    pool: &PgPool,
    role_id: Uuid,
) -> Result<(), crate::error::AppError> {
    sqlx::query("DELETE FROM approval_roles WHERE id = $1")
        .bind(role_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// (user_id, username) pairs for users assigned to an approval role.
pub async fn list_role_assignments(
    pool: &PgPool,
    role_id: Uuid,
) -> Result<Vec<(Uuid, String)>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT u.id, u.username
         FROM approval_role_assignments ara
         JOIN users u ON u.id = ara.user_id
         WHERE ara.role_id = $1
         ORDER BY u.username",
    )
    .bind(role_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Replace the set of users assigned to an approval role (transactional).
pub async fn set_role_assignments(
    pool: &PgPool,
    role_id: Uuid,
    user_ids: &[Uuid],
) -> Result<(), crate::error::AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM approval_role_assignments WHERE role_id = $1")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    for uid in user_ids {
        sqlx::query(
            "INSERT INTO approval_role_assignments (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(uid)
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Managed AD account DNs in the scope of an approval role.
pub async fn list_role_accounts(
    pool: &PgPool,
    role_id: Uuid,
) -> Result<Vec<String>, crate::error::AppError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT managed_ad_dn FROM approval_role_accounts WHERE role_id = $1 ORDER BY managed_ad_dn",
    )
    .bind(role_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(dn,)| dn).collect())
}

/// Replace the set of managed accounts attached to an approval role
/// (transactional). `entries` supplies `(dn, friendly_name)` pairs; empty
/// DNs are skipped. The caller is responsible for trimming/validating.
pub async fn set_role_accounts(
    pool: &PgPool,
    role_id: Uuid,
    entries: &[(String, Option<String>)],
) -> Result<(), crate::error::AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM approval_role_accounts WHERE role_id = $1")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    for (dn, friendly_name) in entries {
        if dn.is_empty() {
            continue;
        }
        sqlx::query(
            "INSERT INTO approval_role_accounts (role_id, managed_ad_dn, friendly_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(role_id)
        .bind(dn)
        .bind(friendly_name)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_password_default_policy() {
        let policy = PasswordPolicy::default();
        let pw = generate_password(&policy);
        assert!(pw.len() >= 16);
        assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
        assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
        assert!(pw.chars().any(|c| c.is_ascii_digit()));
        assert!(pw.chars().any(|c| !c.is_alphanumeric()));
    }

    #[test]
    fn generate_password_min_length() {
        let policy = PasswordPolicy {
            min_length: 32,
            ..PasswordPolicy::default()
        };
        let pw = generate_password(&policy);
        assert!(pw.len() >= 32);
    }

    #[test]
    fn generate_password_no_symbols() {
        let policy = PasswordPolicy {
            require_symbols: false,
            ..PasswordPolicy::default()
        };
        let pw = generate_password(&policy);
        assert!(pw.len() >= 16);
        // Should still contain uppercase, lowercase, numbers
        assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
        assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
        assert!(pw.chars().any(|c| c.is_ascii_digit()));
    }

    #[test]
    fn generate_password_no_numbers() {
        let policy = PasswordPolicy {
            require_numbers: false,
            ..PasswordPolicy::default()
        };
        let pw = generate_password(&policy);
        assert!(!pw.chars().any(|c| c.is_ascii_digit()));
    }

    #[test]
    fn password_policy_default() {
        let p = PasswordPolicy::default();
        assert_eq!(p.min_length, 16);
        assert!(p.require_uppercase);
        assert!(p.require_lowercase);
        assert!(p.require_numbers);
        assert!(p.require_symbols);
    }

    #[test]
    fn extract_cn_works() {
        assert_eq!(
            extract_cn_from_dn("CN=John.Doe,OU=Users,DC=example,DC=com"),
            "John.Doe"
        );
        assert_eq!(
            extract_cn_from_dn("cn=svc-account,OU=ServiceAccounts,DC=corp,DC=net"),
            "svc-account"
        );
        assert_eq!(
            extract_cn_from_dn("CN=John Doe,OU=Support,DC=example,DC=com"),
            "John Doe"
        );
        assert_eq!(extract_cn_from_dn("some-other-format"), "some-other-format");
        assert_eq!(extract_cn_from_dn(""), "");
    }

    // ── W4-7 / W4-8 additions ───────────────────────────────────────

    /// Generated passwords must include every required class when all are on,
    /// even at the 12-char floor applied by `generate_password`.
    #[test]
    fn generate_password_all_classes_required_at_floor() {
        let policy = PasswordPolicy {
            min_length: 4, // below the 12-char floor; generator must enforce it
            require_uppercase: true,
            require_lowercase: true,
            require_numbers: true,
            require_symbols: true,
        };
        let pw = generate_password(&policy);
        assert!(pw.len() >= 12, "floor must apply, got {}", pw.len());
        assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
        assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
        assert!(pw.chars().any(|c| c.is_ascii_digit()));
        assert!(pw.chars().any(|c| !c.is_alphanumeric()));
    }

    /// With every class disabled the generator must still produce a usable,
    /// ascii-only password (falls back to upper + lower + digit pool).
    #[test]
    fn generate_password_all_classes_disabled_fallback() {
        let policy = PasswordPolicy {
            min_length: 16,
            require_uppercase: false,
            require_lowercase: false,
            require_numbers: false,
            require_symbols: false,
        };
        let pw = generate_password(&policy);
        assert!(pw.len() >= 16);
        assert!(pw.is_ascii());
        assert!(!pw.chars().any(|c| c.is_ascii_whitespace()));
    }

    /// Two calls in quick succession must produce different passwords — a
    /// weak statistical guarantee but strong enough to catch a fixed-seed
    /// regression.
    #[test]
    fn generate_password_not_deterministic() {
        let policy = PasswordPolicy::default();
        let a = generate_password(&policy);
        let b = generate_password(&policy);
        assert_ne!(a, b, "consecutive passwords must differ");
    }

    /// The CN extractor must tolerate arbitrary attacker-shaped DNs without
    /// panicking (W4-8 negative case).
    #[test]
    fn extract_cn_misuse_inputs() {
        // Embedded commas inside a quoted CN are not unescaped by the simple
        // parser, but the function must not panic on any of these shapes.
        assert_eq!(
            extract_cn_from_dn(r#"CN="weird,name",OU=x,DC=y"#),
            r#""weird"#
        );
        assert_eq!(extract_cn_from_dn("CN="), "");
        assert_eq!(extract_cn_from_dn(",,,,"), ",,,,");
        // Unicode is preserved byte-for-byte.
        assert_eq!(extract_cn_from_dn("CN=Zoë,DC=x"), "Zoë");
    }
}
