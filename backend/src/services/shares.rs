//! Connection share-link persistence.

use crate::error::AppError;
use sqlx::{Pool, Postgres};
use uuid::Uuid;

/// Returns true if the connection exists and is visible to `user_id`.
///
/// Admins / managers (`see_all`) only require the connection to exist and not
/// be soft-deleted. Other users must have a role-based assignment.
pub async fn connection_visible_to_user(
    pool: &Pool<Postgres>,
    connection_id: Uuid,
    user_id: Uuid,
    see_all: bool,
) -> Result<bool, AppError> {
    let has_access: bool = if see_all {
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
                JOIN role_connections rc ON rc.connection_id = c.id
                JOIN users u ON u.role_id = rc.role_id
                WHERE c.id = $1 AND u.id = $2 AND c.soft_deleted_at IS NULL
            )",
        )
        .bind(connection_id)
        .bind(user_id)
        .fetch_one(pool)
        .await?
    };
    Ok(has_access)
}

/// Insert a new share row with a mandatory expiry.
pub async fn insert_share(
    pool: &Pool<Postgres>,
    connection_id: Uuid,
    owner_user_id: Uuid,
    share_token: &str,
    read_only: bool,
    mode: &str,
    expiry_hours: i32,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO connection_shares (connection_id, owner_user_id, share_token, read_only, mode, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))",
    )
    .bind(connection_id)
    .bind(owner_user_id)
    .bind(share_token)
    .bind(read_only)
    .bind(mode)
    .bind(expiry_hours)
    .execute(pool)
    .await?;
    Ok(())
}

/// Revoke a share owned by `owner_user_id`. Returns true iff exactly one row
/// transitioned from non-revoked to revoked.
pub async fn revoke_owned(
    pool: &Pool<Postgres>,
    share_id: Uuid,
    owner_user_id: Uuid,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE connection_shares SET revoked = true WHERE id = $1 AND owner_user_id = $2 AND NOT revoked",
    )
    .bind(share_id)
    .bind(owner_user_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Active share lookup row: (share_id, connection_id, owner_user_id, mode).
pub type ActiveShareRow = (Uuid, Uuid, Uuid, String);

/// Look up an active (non-revoked, non-expired) share by token.
pub async fn find_active_by_token(
    pool: &Pool<Postgres>,
    token: &str,
) -> Result<Option<ActiveShareRow>, AppError> {
    let row = sqlx::query_as(
        "SELECT id, connection_id, owner_user_id, mode
         FROM connection_shares
         WHERE share_token = $1
           AND NOT revoked
           AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}
