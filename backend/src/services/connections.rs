//! DB operations for connection rows (RDP/VNC/SSH targets).
//!
//! Extracted from [`crate::routes::admin`] so route handlers can be thin
//! orchestration layers over a typed service boundary (§3.1 / W4-6).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres};
use uuid::Uuid;

/// Columns returned by list/create/update in a stable order.
pub const SELECT_COLUMNS: &str = "id, name, protocol, hostname, port, domain, description, folder_id, extra, last_accessed, watermark, health_status, health_checked_at";

#[derive(Serialize, FromRow, Debug, Clone)]
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
    pub health_status: String,
    pub health_checked_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize, Debug)]
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

/// Normalise the `extra` JSON field: turn `null` into an empty object `{}`.
pub fn normalize_extra(extra: &serde_json::Value) -> serde_json::Value {
    if extra.is_null() {
        serde_json::json!({})
    } else {
        extra.clone()
    }
}

pub async fn list_all(pool: &Pool<Postgres>) -> Result<Vec<ConnectionRow>, AppError> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM connections WHERE soft_deleted_at IS NULL ORDER BY name"
    );
    let rows: Vec<ConnectionRow> = sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows)
}

/// Row returned to end-users for their connection list. Differs from
/// [`ConnectionRow`] by omitting `domain`/`extra` and joining in the
/// per-user `last_accessed` and `folder_name`.
#[derive(Serialize, FromRow, Debug)]
pub struct UserConnectionRow {
    pub id: Uuid,
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: i32,
    pub description: String,
    pub folder_id: Option<Uuid>,
    pub folder_name: Option<String>,
    pub last_accessed: Option<chrono::DateTime<chrono::Utc>>,
    pub watermark: String,
    pub health_status: String,
    pub health_checked_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// List connections visible to `user_id`. `see_all` = admins/managers that
/// bypass role-based filtering.
pub async fn list_for_user(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    see_all: bool,
) -> Result<Vec<UserConnectionRow>, AppError> {
    let rows = if see_all {
        sqlx::query_as(
            "SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                    c.folder_id, cf.name AS folder_name, uca.last_accessed, c.watermark,
                    c.health_status, c.health_checked_at
             FROM connections c
             LEFT JOIN connection_folders cf ON cf.id = c.folder_id
             LEFT JOIN user_connection_access uca ON uca.connection_id = c.id AND uca.user_id = $1
             WHERE c.soft_deleted_at IS NULL
             ORDER BY c.name",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT DISTINCT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                    c.folder_id, cf.name AS folder_name, uca.last_accessed, c.watermark,
                    c.health_status, c.health_checked_at
             FROM connections c
             LEFT JOIN connection_folders cf ON cf.id = c.folder_id
             LEFT JOIN user_connection_access uca ON uca.connection_id = c.id AND uca.user_id = $1
             JOIN users u ON u.id = $1
             WHERE c.soft_deleted_at IS NULL
             AND (
                 EXISTS (SELECT 1 FROM role_connections rc WHERE rc.role_id = u.role_id AND rc.connection_id = c.id)
                 OR
                 EXISTS (SELECT 1 FROM role_folders rf WHERE rf.role_id = u.role_id AND rf.folder_id = c.folder_id)
             )
             ORDER BY c.name",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

pub async fn create(
    pool: &Pool<Postgres>,
    body: &CreateConnectionRequest,
) -> Result<ConnectionRow, AppError> {
    let port = body.port.unwrap_or(3389);
    let extra = normalize_extra(&body.extra);
    let sql = format!(
        "INSERT INTO connections (name, protocol, hostname, port, domain, description, folder_id, extra, watermark)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING {SELECT_COLUMNS}"
    );
    let row: ConnectionRow = sqlx::query_as(&sql)
        .bind(&body.name)
        .bind(&body.protocol)
        .bind(&body.hostname)
        .bind(port)
        .bind(&body.domain)
        .bind(&body.description)
        .bind(body.folder_id)
        .bind(&extra)
        .bind(&body.watermark)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn update(
    pool: &Pool<Postgres>,
    id: Uuid,
    body: &CreateConnectionRequest,
) -> Result<Option<ConnectionRow>, AppError> {
    let port = body.port.unwrap_or(3389);
    let extra = normalize_extra(&body.extra);
    let sql = format!(
        "UPDATE connections SET name = $1, protocol = $2, hostname = $3, port = $4, domain = $5, description = $6, folder_id = $7, extra = $8, watermark = $9, updated_at = now()
         WHERE id = $10 AND soft_deleted_at IS NULL
         RETURNING {SELECT_COLUMNS}"
    );
    let row: Option<ConnectionRow> = sqlx::query_as(&sql)
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
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// Soft-delete a connection. Returns `true` if a row was updated, `false` if
/// no active row with that id exists.
pub async fn soft_delete(pool: &Pool<Postgres>, id: Uuid) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE connections SET soft_deleted_at = now() WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

// ── Connection Folders ─────────────────────────────────────────────────

#[derive(Serialize, FromRow, Debug, Clone)]
pub struct ConnectionFolderRow {
    pub id: Uuid,
    pub name: String,
    pub parent_id: Option<Uuid>,
}

#[derive(Deserialize, Debug)]
pub struct FolderRequest {
    pub name: String,
    pub parent_id: Option<Uuid>,
}

pub async fn list_folders(pool: &Pool<Postgres>) -> Result<Vec<ConnectionFolderRow>, AppError> {
    let rows: Vec<ConnectionFolderRow> =
        sqlx::query_as("SELECT id, name, parent_id FROM connection_folders ORDER BY name")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

pub async fn create_folder(
    pool: &Pool<Postgres>,
    body: &FolderRequest,
) -> Result<ConnectionFolderRow, AppError> {
    let row: ConnectionFolderRow = sqlx::query_as(
        "INSERT INTO connection_folders (name, parent_id) VALUES ($1, $2) RETURNING id, name, parent_id",
    )
    .bind(&body.name)
    .bind(body.parent_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update_folder(
    pool: &Pool<Postgres>,
    id: Uuid,
    body: &FolderRequest,
) -> Result<Option<ConnectionFolderRow>, AppError> {
    let row: Option<ConnectionFolderRow> = sqlx::query_as(
        "UPDATE connection_folders SET name = $1, parent_id = $2 WHERE id = $3 RETURNING id, name, parent_id",
    )
    .bind(&body.name)
    .bind(body.parent_id)
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_folder(pool: &Pool<Postgres>, id: Uuid) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM connection_folders WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Minimal fields used by `connection_info` to decide client-side auth prompts.
/// Tuple shape: (protocol, extra, watermark).
pub type ConnectionSessionInfo = (String, Option<serde_json::Value>, String);

/// Fetch protocol/extra/watermark for a non-soft-deleted connection.
pub async fn get_session_info(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<ConnectionSessionInfo>, AppError> {
    let row = sqlx::query_as(
        "SELECT protocol, extra, watermark FROM connections WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Check whether `user_id` has role-based access (direct role→connection
/// or role→folder→connection) to `connection_id`.
pub async fn user_has_role_access(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<bool, AppError> {
    let has_access: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM role_connections rc
            JOIN users u ON u.role_id = rc.role_id
            WHERE u.id = $1 AND rc.connection_id = $2
        ) OR EXISTS(
            SELECT 1 FROM role_folders rf
            JOIN connections c ON c.folder_id = rf.folder_id
            JOIN users u ON u.role_id = rf.role_id
            WHERE u.id = $1 AND c.id = $2
        )",
    )
    .bind(user_id)
    .bind(connection_id)
    .fetch_one(pool)
    .await?;
    Ok(has_access)
}

/// Tunnel-handshake fields for a non-soft-deleted connection:
/// (protocol, hostname, port, domain, name, extra).
pub type TunnelConnectionDetails = (
    String,
    String,
    i32,
    Option<String>,
    String,
    serde_json::Value,
);

/// Fetch protocol/hostname/port/domain/name/extra for the tunnel handshake.
pub async fn fetch_tunnel_details(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<TunnelConnectionDetails>, AppError> {
    let row = sqlx::query_as(
        "SELECT protocol, hostname, port, domain, name, extra
         FROM connections
         WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Upsert `user_connection_access.last_accessed = now()` for `(user_id, connection_id)`.
pub async fn touch_user_access(
    pool: &Pool<Postgres>,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO user_connection_access (user_id, connection_id, last_accessed)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id, connection_id) DO UPDATE SET last_accessed = now()",
    )
    .bind(user_id)
    .bind(connection_id)
    .execute(pool)
    .await?;
    Ok(())
}
