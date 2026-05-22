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
#[allow(clippy::too_many_arguments)]
pub async fn insert_share(
    pool: &Pool<Postgres>,
    connection_id: Uuid,
    owner_user_id: Uuid,
    share_token: &str,
    read_only: bool,
    mode: &str,
    expiry_hours: i32,
    multiplayer: bool,
    max_participants: i16,
    allow_chat: bool,
    allow_audio: bool,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO connection_shares (connection_id, owner_user_id, share_token, read_only, mode, expires_at, multiplayer, max_participants, allow_chat, allow_audio)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $7, $8, $9, $10)",
    )
    .bind(connection_id)
    .bind(owner_user_id)
    .bind(share_token)
    .bind(read_only)
    .bind(mode)
    .bind(expiry_hours)
    .bind(multiplayer)
    .bind(max_participants)
    .bind(allow_chat)
    .bind(allow_audio)
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

/// Active share lookup row carrying the v1.9.6 multiplayer fields.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ActiveShare {
    /// Share row id.
    pub share_id: Uuid,
    /// Underlying connection id.
    pub connection_id: Uuid,
    /// User id of the share's owner.
    pub owner_user_id: Uuid,
    /// Share mode: `view` or `control`.
    pub mode: String,
    /// Multiplayer / co-pilot toggle.
    pub multiplayer: bool,
    /// DB-clamped participant cap (1..=6).
    pub max_participants: i16,
    /// Whether the room exposes a chat channel.
    pub allow_chat: bool,
    /// Whether the room signals an optional WebRTC audio mesh.
    pub allow_audio: bool,
}

/// Legacy tuple alias kept for downstream call-sites that haven't
/// migrated to [`ActiveShare`] yet. Will be removed in v1.10.
pub type ActiveShareRow = (Uuid, Uuid, Uuid, String);

/// Look up an active (non-revoked, non-expired) share by token. The share is
/// considered **invalid** (returns `None`) whenever the underlying connection
/// has been soft-deleted — an admin revoking a connection must take every
/// outstanding share with it, even ones whose owner still holds an active
/// session. Enforced by a JOIN rather than a trigger so the check survives
/// even if ACL plumbing regresses.
pub async fn find_active_by_token(
    pool: &Pool<Postgres>,
    token: &str,
) -> Result<Option<ActiveShare>, AppError> {
    let row = sqlx::query_as::<_, ActiveShare>(
        "SELECT cs.id              AS share_id,
                cs.connection_id,
                cs.owner_user_id,
                cs.mode,
                cs.multiplayer,
                cs.max_participants,
                cs.allow_chat,
                cs.allow_audio
         FROM connection_shares cs
         JOIN connections c ON c.id = cs.connection_id
         WHERE cs.share_token = $1
           AND NOT cs.revoked
           AND (cs.expires_at IS NULL OR cs.expires_at > now())
           AND c.soft_deleted_at IS NULL",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}
