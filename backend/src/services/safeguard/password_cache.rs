//! Per-user, per-profile Safeguard password cache.
//!
//! When the admin enables `safeguard_config.password_cache_enabled`,
//! a JIT checkout's plaintext password is Vault-sealed and stored
//! here for the admin-configured lifetime
//! (`default_checkout_hours`). Subsequent tunnel opens for the same
//! `(user_id, profile_id)` reuse the cached row without making any
//! Safeguard API call — so users with long sessions don't have to
//! resubmit a fresh 15-minute RSTS token every time the previous one
//! expires.
//!
//! Storage mirrors `safeguard_user_tokens`: ciphertext + per-row DEK
//! + nonce, with eager delete-on-expired in `load` so a stale row
//! never silently succeeds.

use crate::config::VaultConfig;
use crate::error::AppError;
use crate::services::vault::{seal, unseal};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// Unsealed cached entry returned to the tunnel handler.
pub struct CachedPassword {
    /// `Account.Name` snapshotted at checkout time (may be `None` if
    /// the appliance didn't return one — RDP will then prompt).
    pub username: Option<String>,
    /// Plaintext password. NEVER persist outside this module.
    pub password: String,
    /// Safeguard AccessRequest id at the time of the original checkout.
    /// Surfaced for future "release this cached credential" admin tools.
    pub request_id: Option<String>,
    pub expires_at: DateTime<Utc>,
}

/// Replace any existing cache row for `(user_id, profile_id)`.
pub async fn store(
    pool: &PgPool,
    vault: &VaultConfig,
    user_id: Uuid,
    profile_id: Uuid,
    username: Option<&str>,
    password: &str,
    request_id: Option<&str>,
    expires_at: DateTime<Utc>,
) -> Result<(), AppError> {
    if password.is_empty() {
        return Err(AppError::Validation(
            "cannot cache an empty Safeguard password".into(),
        ));
    }
    let sealed = seal(vault, password.as_bytes()).await?;

    sqlx::query(
        "INSERT INTO safeguard_cached_passwords
            (user_id, profile_id, ciphertext, encrypted_dek, nonce,
             username, request_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (user_id, profile_id) DO UPDATE SET
            ciphertext    = EXCLUDED.ciphertext,
            encrypted_dek = EXCLUDED.encrypted_dek,
            nonce         = EXCLUDED.nonce,
            username      = EXCLUDED.username,
            request_id    = EXCLUDED.request_id,
            expires_at    = EXCLUDED.expires_at,
            created_at    = now()",
    )
    .bind(user_id)
    .bind(profile_id)
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .bind(username)
    .bind(request_id)
    .bind(expires_at)
    .execute(pool)
    .await?;

    Ok(())
}

/// Decrypt the cached entry, returning `None` if absent or expired
/// (expired rows are deleted eagerly so future polls are consistent).
pub async fn load(
    pool: &PgPool,
    vault: &VaultConfig,
    user_id: Uuid,
    profile_id: Uuid,
) -> Result<Option<CachedPassword>, AppError> {
    let row: Option<(
        Vec<u8>,
        Vec<u8>,
        Vec<u8>,
        Option<String>,
        Option<String>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        "SELECT ciphertext, encrypted_dek, nonce, username, request_id, expires_at
           FROM safeguard_cached_passwords
          WHERE user_id = $1 AND profile_id = $2",
    )
    .bind(user_id)
    .bind(profile_id)
    .fetch_optional(pool)
    .await?;

    let Some((ciphertext, encrypted_dek, nonce, username, request_id, expires_at)) = row else {
        return Ok(None);
    };

    if expires_at <= Utc::now() {
        let _ = clear(pool, user_id, profile_id).await;
        return Ok(None);
    }

    let plaintext = unseal(vault, &encrypted_dek, &ciphertext, &nonce).await?;
    let password = String::from_utf8(plaintext)
        .map_err(|_| AppError::Internal("cached Safeguard password is not valid UTF-8".into()))?;

    Ok(Some(CachedPassword {
        username,
        password,
        request_id,
        expires_at,
    }))
}

pub async fn clear(pool: &PgPool, user_id: Uuid, profile_id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM safeguard_cached_passwords WHERE user_id = $1 AND profile_id = $2")
        .bind(user_id)
        .bind(profile_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Lightweight (no-decrypt) status row for the bulk-checkout UI.
#[derive(serde::Serialize)]
pub struct CachedStatus {
    pub profile_id: Uuid,
    pub username: Option<String>,
    pub request_id: Option<String>,
    pub expires_at: DateTime<Utc>,
}

/// Return cache rows for every profile the user has currently cached.
/// Expired rows are filtered out (caller treats absence as "not
/// cached"). No decryption occurs — this is safe to call on every
/// poll.
pub async fn status_for_user(pool: &PgPool, user_id: Uuid) -> Result<Vec<CachedStatus>, AppError> {
    let rows: Vec<(Uuid, Option<String>, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT profile_id, username, request_id, expires_at
           FROM safeguard_cached_passwords
          WHERE user_id = $1 AND expires_at > now()
          ORDER BY expires_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(profile_id, username, request_id, expires_at)| CachedStatus {
                profile_id,
                username,
                request_id,
                expires_at,
            },
        )
        .collect())
}
