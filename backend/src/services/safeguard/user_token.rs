//! Per-user Safeguard API token storage.
//!
//! When `auth_mode` is `per_user_browser` (or `hybrid` as the
//! preferred path), each user signs into Safeguard's RSTS federation
//! flow in their own browser via the `Safeguard-PS` helper command
//! (or the future Strata sign-in popup), obtains an API access token
//! good for ~15 minutes, and submits it to Strata. We keep that token
//! Vault-sealed and use it for that user's JIT checkouts.
//!
//! The envelope (ciphertext + per-row DEK + nonce) mirrors the
//! `credential_profiles` storage shape and reuses
//! [`crate::services::vault::seal`] / [`unseal`].
//!
//! Tokens are short-lived; we never refresh them server-side — the
//! user just signs in again when prompted.

use crate::config::VaultConfig;
use crate::error::AppError;
use crate::services::vault::{seal, unseal};
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

/// Outcome of a `status` query: whether the user has a live token and
/// when it expires.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenStatus {
    pub signed_in: bool,
    /// RFC3339; absent when `signed_in = false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

/// Replace any existing token for `user_id`.
pub async fn store(
    pool: &PgPool,
    vault: &VaultConfig,
    user_id: Uuid,
    api_token: &str,
    expires_at: DateTime<Utc>,
) -> Result<(), AppError> {
    if api_token.trim().is_empty() {
        return Err(AppError::Validation(
            "Safeguard API token cannot be empty".into(),
        ));
    }
    let sealed = seal(vault, api_token.as_bytes()).await?;

    sqlx::query(
        "INSERT INTO safeguard_user_tokens
            (user_id, ciphertext, encrypted_dek, nonce, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET
            ciphertext    = EXCLUDED.ciphertext,
            encrypted_dek = EXCLUDED.encrypted_dek,
            nonce         = EXCLUDED.nonce,
            expires_at    = EXCLUDED.expires_at,
            updated_at    = now()",
    )
    .bind(user_id)
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .bind(expires_at)
    .execute(pool)
    .await?;

    Ok(())
}

/// Load and decrypt the user's token. Returns `None` when no row
/// exists OR when the row has expired (caller treats both as "user
/// must sign in"). On the expired branch we eagerly delete so we
/// don't drift.
pub async fn load(
    pool: &PgPool,
    vault: &VaultConfig,
    user_id: Uuid,
) -> Result<Option<String>, AppError> {
    let row: Option<(Vec<u8>, Vec<u8>, Vec<u8>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT ciphertext, encrypted_dek, nonce, expires_at
           FROM safeguard_user_tokens WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    let Some((ciphertext, encrypted_dek, nonce, expires_at)) = row else {
        return Ok(None);
    };

    if expires_at <= Utc::now() {
        // Stale — drop it so subsequent `status` calls correctly
        // report signed_out without us having to re-check expiry.
        let _ = clear(pool, user_id).await;
        return Ok(None);
    }

    let plaintext = unseal(vault, &encrypted_dek, &ciphertext, &nonce).await?;

    let token = String::from_utf8(plaintext).map_err(|_| {
        AppError::Internal("stored Safeguard token is not valid UTF-8".into())
    })?;

    Ok(Some(token))
}

/// Best-effort status probe; never decrypts the token (caller only
/// needs to know "is the user signed in"). Returns
/// `signed_in = false` for an expired row but does NOT delete it —
/// `load` performs the cleanup so a /status poll stays idempotent.
pub async fn status(pool: &PgPool, user_id: Uuid) -> Result<TokenStatus, AppError> {
    let row: Option<(DateTime<Utc>,)> = sqlx::query_as(
        "SELECT expires_at FROM safeguard_user_tokens WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(match row {
        Some((expires_at,)) if expires_at > Utc::now() => TokenStatus {
            signed_in: true,
            expires_at: Some(expires_at),
        },
        _ => TokenStatus {
            signed_in: false,
            expires_at: None,
        },
    })
}

pub async fn clear(pool: &PgPool, user_id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM safeguard_user_tokens WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}
