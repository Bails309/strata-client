//! Per-user connection credentials (envelope-encrypted via Vault) and
//! revocation of share links when the underlying credential changes.

use crate::error::AppError;
use crate::services::vault::SealedCredential;
use sqlx::{Pool, Postgres};
use uuid::Uuid;

/// Upsert the sealed per-user credential for `(user_id, connection_id)`.
pub async fn upsert(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
    sealed: &SealedCredential,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO user_credentials (user_id, connection_id, encrypted_password, encrypted_dek, nonce)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, connection_id) DO UPDATE
         SET encrypted_password = $3, encrypted_dek = $4, nonce = $5, updated_at = now()",
    )
    .bind(user_id)
    .bind(connection_id)
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .execute(pool)
    .await?;
    Ok(())
}

/// Revoke all non-revoked share links owned by `user_id` for `connection_id`.
pub async fn revoke_user_shares(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE connection_shares SET revoked = true
         WHERE owner_user_id = $1 AND connection_id = $2 AND NOT revoked",
    )
    .bind(user_id)
    .bind(connection_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Encrypted credential blob as stored in `credential_profiles`:
/// `(encrypted_password, encrypted_dek, nonce)`.
pub type EncryptedBlob = (Vec<u8>, Vec<u8>, Vec<u8>);

/// Load the managed (checkout-linked) credential blob via a
/// `credential_mappings` → profile → active checkout → managed profile chain.
/// Returns `None` if no active managed checkout is mapped for
/// `(connection_id, user_id)`.
pub async fn load_mapping_managed(
    pool: &Pool<Postgres>,
    connection_id: Uuid,
    user_id: Uuid,
) -> Result<Option<EncryptedBlob>, AppError> {
    let row = sqlx::query_as(
        "SELECT managed.encrypted_password, managed.encrypted_dek, managed.nonce
         FROM credential_mappings cm
         JOIN credential_profiles cp ON cp.id = cm.credential_id
         JOIN password_checkout_requests pcr
                ON pcr.id = cp.checkout_id AND pcr.status = 'Active'
         JOIN credential_profiles managed
                ON managed.id = pcr.vault_credential_id
         WHERE cm.connection_id = $1 AND cp.user_id = $2
           AND cp.expires_at > now()",
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Load the user's own mapped credential blob (no checkout) for
/// `(connection_id, user_id)`.
pub async fn load_mapping_own(
    pool: &Pool<Postgres>,
    connection_id: Uuid,
    user_id: Uuid,
) -> Result<Option<EncryptedBlob>, AppError> {
    let row = sqlx::query_as(
        "SELECT cp.encrypted_password, cp.encrypted_dek, cp.nonce
         FROM credential_mappings cm
         JOIN credential_profiles cp ON cp.id = cm.credential_id
         WHERE cm.connection_id = $1 AND cp.user_id = $2
           AND cp.expires_at > now()",
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Load a specific profile's own credential blob by profile id, scoped to `user_id`.
pub async fn load_profile_own(
    pool: &Pool<Postgres>,
    profile_id: Uuid,
    user_id: Uuid,
) -> Result<Option<EncryptedBlob>, AppError> {
    let row = sqlx::query_as(
        "SELECT cp.encrypted_password, cp.encrypted_dek, cp.nonce
         FROM credential_profiles cp
         WHERE cp.id = $1 AND cp.user_id = $2
           AND cp.expires_at > now()",
    )
    .bind(profile_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Load the managed (checkout-linked) credential blob reached via the given
/// profile id (one-off ticket path).
pub async fn load_profile_managed(
    pool: &Pool<Postgres>,
    profile_id: Uuid,
    user_id: Uuid,
) -> Result<Option<EncryptedBlob>, AppError> {
    let row = sqlx::query_as(
        "SELECT managed.encrypted_password, managed.encrypted_dek, managed.nonce
         FROM credential_profiles cp
         JOIN password_checkout_requests pcr
                ON pcr.id = cp.checkout_id AND pcr.status = 'Active'
         JOIN credential_profiles managed
                ON managed.id = pcr.vault_credential_id
         WHERE cp.id = $1 AND cp.user_id = $2
           AND cp.expires_at > now()",
    )
    .bind(profile_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Returns true if the user has a mapped, checkout-linked credential profile
/// for `connection_id` that has already expired (stale managed creds must not
/// be sent to AD, to avoid account lockout).
pub async fn has_expired_mapped_managed(
    pool: &Pool<Postgres>,
    connection_id: Uuid,
    user_id: Uuid,
) -> Result<bool, AppError> {
    let has_expired: bool = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM credential_mappings cm
            JOIN credential_profiles cp ON cp.id = cm.credential_id
            WHERE cm.connection_id = $1 AND cp.user_id = $2
              AND cp.checkout_id IS NOT NULL
              AND cp.expires_at <= now()
        )",
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(has_expired)
}
