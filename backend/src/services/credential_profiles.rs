//! Credential Profile persistence.
//!
//! Pure DB ops for the `credential_profiles`, `credential_mappings`, and
//! `connection_shares` (revocation by profile) tables. Vault encryption
//! (seal/unseal) is deliberately kept in the route handlers because it
//! depends on runtime `VaultConfig` from `AppState`.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::AppError;

#[derive(Serialize, sqlx::FromRow)]
pub struct CredentialProfileRow {
    pub id: Uuid,
    pub label: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub expired: bool,
    pub ttl_hours: i32,
    pub extended_expiry: bool,
    pub checkout_id: Option<Uuid>,
}

/// Maximum TTL (in hours) when a profile opts in to extended expiry.
/// 2160 = 90 days, matched in DB by `chk_ttl_hours`
/// (migration 061_credential_profile_extended_expiry.sql).
pub const EXTENDED_TTL_MAX_HOURS: i64 = 2160;

#[derive(Serialize, sqlx::FromRow)]
pub struct MappingRow {
    pub connection_id: Uuid,
    pub connection_name: String,
    pub protocol: String,
}

/// Sealed payload pulled from DB for re-encryption flows.
pub struct SealedPayload {
    pub ciphertext: Vec<u8>,
    pub encrypted_dek: Vec<u8>,
    pub nonce: Vec<u8>,
}

/// Resolve the admin-configured maximum credential TTL (capped at 12h).
pub async fn admin_max_ttl_hours(pool: &PgPool) -> i64 {
    crate::services::settings::get(pool, "credential_ttl_hours")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(12)
        .clamp(1, 12)
}

/// Effective TTL upper bound for a profile, in hours. When the profile
/// has opted in to `extended_expiry`, the cap is `EXTENDED_TTL_MAX_HOURS`
/// (90 days); otherwise it's the admin-configured `admin_max_ttl_hours`.
pub fn effective_ttl_max(admin_max: i64, extended: bool) -> i64 {
    if extended {
        EXTENDED_TTL_MAX_HOURS
    } else {
        admin_max
    }
}

// ── Profiles ──────────────────────────────────────────────────────────

pub async fn list_for_user(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<Vec<CredentialProfileRow>, AppError> {
    let rows = sqlx::query_as(
        "SELECT id, label, created_at, updated_at, expires_at,
                (expires_at < now()) AS expired, ttl_hours, extended_expiry, checkout_id
         FROM credential_profiles WHERE user_id = $1 ORDER BY label",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn user_owns(pool: &PgPool, profile_id: Uuid, user_id: Uuid) -> Result<bool, AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM credential_profiles WHERE id = $1 AND user_id = $2)",
    )
    .bind(profile_id)
    .bind(user_id)
    .fetch_one(pool)
    .await
    .unwrap_or(false);
    Ok(exists)
}

/// Fetch the current `extended_expiry` flag for a profile (used to pick
/// the right TTL cap when an update doesn't explicitly toggle it).
pub async fn get_extended_expiry(pool: &PgPool, profile_id: Uuid) -> Result<bool, AppError> {
    let v: bool = sqlx::query_scalar(
        "SELECT extended_expiry FROM credential_profiles WHERE id = $1",
    )
    .bind(profile_id)
    .fetch_one(pool)
    .await?;
    Ok(v)
}

pub async fn insert(
    pool: &PgPool,
    user_id: Uuid,
    label: &str,
    sealed: &SealedPayload,
    ttl_hours: i32,
    extended_expiry: bool,
) -> Result<Uuid, AppError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO credential_profiles (user_id, label, encrypted_username, encrypted_password, encrypted_dek, nonce, ttl_hours, extended_expiry, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(hours => $7))
         RETURNING id",
    )
    .bind(user_id)
    .bind(label)
    .bind(&[] as &[u8])
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .bind(ttl_hours)
    .bind(extended_expiry)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

/// Fetch the encrypted payload for an existing profile (used when re-encrypting
/// on partial update).
pub async fn get_sealed(pool: &PgPool, profile_id: Uuid) -> Result<SealedPayload, AppError> {
    let (ciphertext, encrypted_dek, nonce): (Vec<u8>, Vec<u8>, Vec<u8>) = sqlx::query_as(
        "SELECT encrypted_password, encrypted_dek, nonce
         FROM credential_profiles WHERE id = $1",
    )
    .bind(profile_id)
    .fetch_one(pool)
    .await?;
    Ok(SealedPayload {
        ciphertext,
        encrypted_dek,
        nonce,
    })
}

/// Replace sealed payload + bump TTL/label/extended-expiry.
pub async fn update_sealed(
    pool: &PgPool,
    profile_id: Uuid,
    sealed: &SealedPayload,
    ttl_hours: i32,
    extended_expiry: bool,
    label: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE credential_profiles
         SET encrypted_username = $1, encrypted_password = $2, encrypted_dek = $3, nonce = $4,
             ttl_hours = $5, extended_expiry = $8, updated_at = now(),
             expires_at = now() + make_interval(hours => $5),
             label = COALESCE($7, label)
         WHERE id = $6",
    )
    .bind(&[] as &[u8])
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .bind(ttl_hours)
    .bind(profile_id)
    .bind(label)
    .bind(extended_expiry)
    .execute(pool)
    .await?;
    Ok(())
}

/// Update label, TTL and/or extended-expiry flag without changing encrypted payload.
pub async fn update_metadata(
    pool: &PgPool,
    profile_id: Uuid,
    label: Option<&str>,
    ttl_hours: Option<i32>,
    extended_expiry: Option<bool>,
) -> Result<(), AppError> {
    if label.is_none() && ttl_hours.is_none() && extended_expiry.is_none() {
        return Ok(());
    }
    sqlx::query(
        "UPDATE credential_profiles SET
            label = COALESCE($2, label),
            ttl_hours = COALESCE($3, ttl_hours),
            extended_expiry = COALESCE($4, extended_expiry),
            expires_at = CASE WHEN $3 IS NOT NULL THEN now() + make_interval(hours => $3) ELSE expires_at END,
            updated_at = now()
         WHERE id = $1",
    )
    .bind(profile_id)
    .bind(label)
    .bind(ttl_hours)
    .bind(extended_expiry)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete(pool: &PgPool, profile_id: Uuid, user_id: Uuid) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM credential_profiles WHERE id = $1 AND user_id = $2")
        .bind(profile_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Revoke all active share links belonging to `user_id` that point to
/// connections currently mapped to `profile_id`.
pub async fn revoke_shares_for_profile(
    pool: &PgPool,
    user_id: Uuid,
    profile_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE connection_shares SET revoked = true
         WHERE owner_user_id = $1 AND connection_id IN (
             SELECT connection_id FROM credential_mappings WHERE credential_id = $2
         ) AND NOT revoked",
    )
    .bind(user_id)
    .bind(profile_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Checkout link ─────────────────────────────────────────────────────

/// Clear the checkout association on a profile.
pub async fn clear_checkout_link(pool: &PgPool, profile_id: Uuid) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE credential_profiles SET checkout_id = NULL, updated_at = now() WHERE id = $1",
    )
    .bind(profile_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Attach the given sealed payload + checkout metadata to a profile.
pub async fn link_to_checkout(
    pool: &PgPool,
    profile_id: Uuid,
    sealed: &SealedPayload,
    checkout_id: Uuid,
    expires_at: Option<DateTime<Utc>>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE credential_profiles
         SET encrypted_password = $1,
             encrypted_dek = $2,
             nonce = $3,
             encrypted_username = NULL,
             checkout_id = $4,
             expires_at = $5,
             updated_at = now()
         WHERE id = $6",
    )
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .bind(checkout_id)
    .bind(expires_at)
    .bind(profile_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Mappings ──────────────────────────────────────────────────────────

pub async fn list_mappings(pool: &PgPool, profile_id: Uuid) -> Result<Vec<MappingRow>, AppError> {
    let rows = sqlx::query_as(
        "SELECT cm.connection_id, c.name AS connection_name, c.protocol
         FROM credential_mappings cm
         JOIN connections c ON c.id = cm.connection_id
         WHERE cm.credential_id = $1
         ORDER BY c.name",
    )
    .bind(profile_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Does the user have access to `connection_id` via their role (folders or
/// per-connection grants) OR via `can_access_all_connections`?
pub async fn user_has_connection_access(
    pool: &PgPool,
    connection_id: Uuid,
    user_id: Uuid,
    all_access: bool,
) -> Result<bool, AppError> {
    let has_access: bool = if all_access {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM connections WHERE id = $1 AND soft_deleted_at IS NULL)",
        )
        .bind(connection_id)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM connections c
                JOIN users u ON u.id = $2
                WHERE c.id = $1 AND c.soft_deleted_at IS NULL
                AND (
                    EXISTS (SELECT 1 FROM role_connections rc WHERE rc.role_id = u.role_id AND rc.connection_id = c.id)
                    OR
                    EXISTS (SELECT 1 FROM role_folders rf WHERE rf.role_id = u.role_id AND rf.folder_id = c.folder_id)
                )
            )",
        )
        .bind(connection_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?
    };
    Ok(has_access)
}

/// Remove any mapping for this user+connection (across all of the user's profiles).
pub async fn clear_connection_mapping(
    pool: &PgPool,
    connection_id: Uuid,
    user_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "DELETE FROM credential_mappings
         WHERE connection_id = $1
           AND credential_id IN (SELECT id FROM credential_profiles WHERE user_id = $2)",
    )
    .bind(connection_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn insert_mapping(
    pool: &PgPool,
    profile_id: Uuid,
    connection_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO credential_mappings (credential_id, connection_id) VALUES ($1, $2)
         ON CONFLICT (credential_id, connection_id) DO NOTHING",
    )
    .bind(profile_id)
    .bind(connection_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Connection-info helpers ───────────────────────────────────────────

/// Metadata about an expired or stale profile mapped to a connection.
/// Fields: (profile_id_text, label, ttl_hours, managed_ad_dn, ad_sync_config_id, can_self_approve)
pub type ExpiredProfileInfo = (String, String, i32, Option<String>, Option<Uuid>, bool);

/// Does the user have live (non-expired, non-stale) credentials mapped to
/// this connection? A profile is "live" when its TTL has not expired and —
/// if backed by a managed-account checkout — the checkout is still Active.
pub async fn has_live_creds_for_connection(
    pool: &PgPool,
    connection_id: Uuid,
    user_id: Uuid,
) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM credential_mappings cm
            JOIN credential_profiles cp ON cp.id = cm.credential_id
            LEFT JOIN password_checkout_requests pcr ON pcr.id = cp.checkout_id
            WHERE cm.connection_id = $1 AND cp.user_id = $2
              AND cp.expires_at > now()
              AND (
                    cp.checkout_id IS NULL
                 OR (pcr.status = 'Active' AND (pcr.expires_at IS NULL OR pcr.expires_at > now()))
              )
        )",
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_one(pool)
    .await
    .unwrap_or(false)
}

/// Look up a profile mapped to this connection that is TTL-expired or whose
/// backing checkout is no longer live. Used to offer re-approval / re-entry.
pub async fn expired_profile_for_connection(
    pool: &PgPool,
    connection_id: Uuid,
    user_id: Uuid,
) -> Option<ExpiredProfileInfo> {
    sqlx::query_as::<_, ExpiredProfileInfo>(
        "SELECT
            cp.id::text,
            cp.label,
            cp.ttl_hours,
            pcr.managed_ad_dn,
            pcr.ad_sync_config_id,
            COALESCE(uam.can_self_approve, false) as can_self_approve
         FROM credential_mappings cm
         JOIN credential_profiles cp ON cp.id = cm.credential_id
         LEFT JOIN password_checkout_requests pcr ON pcr.id = cp.checkout_id
         LEFT JOIN user_account_mappings uam ON uam.user_id = cp.user_id AND uam.managed_ad_dn = pcr.managed_ad_dn
         WHERE cm.connection_id = $1 AND cp.user_id = $2
           AND (
                 cp.expires_at <= now()
              OR (cp.checkout_id IS NOT NULL
                  AND (pcr.status <> 'Active'
                       OR (pcr.expires_at IS NOT NULL AND pcr.expires_at <= now())))
           )
         LIMIT 1",
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .unwrap_or(None)
}
