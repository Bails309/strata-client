//! DB operations for role rows (RBAC permission flags).
//!
//! Extracted from [`crate::routes::admin`] so route handlers can be thin
//! orchestration layers over a typed service boundary (§3.1 / W4-6).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres};
use uuid::Uuid;

#[derive(Serialize, FromRow, Debug, Clone)]
pub struct RoleRow {
    pub id: Uuid,
    pub name: String,
    pub can_manage_system: bool,
    pub can_manage_users: bool,
    pub can_manage_connections: bool,
    pub can_view_audit_logs: bool,
    pub can_create_users: bool,
    pub can_create_user_groups: bool,
    pub can_create_connections: bool,
    pub can_create_connection_folders: bool,
    pub can_create_sharing_profiles: bool,
    pub can_view_sessions: bool,
}

#[derive(Deserialize, Debug)]
pub struct CreateRoleRequest {
    pub name: String,
    pub can_manage_system: Option<bool>,
    pub can_manage_users: Option<bool>,
    pub can_manage_connections: Option<bool>,
    pub can_view_audit_logs: Option<bool>,
    pub can_create_users: Option<bool>,
    pub can_create_user_groups: Option<bool>,
    pub can_create_connections: Option<bool>,
    pub can_create_connection_folders: Option<bool>,
    pub can_create_sharing_profiles: Option<bool>,
    pub can_view_sessions: Option<bool>,
}

#[derive(Deserialize, Debug)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    pub can_manage_system: Option<bool>,
    pub can_manage_users: Option<bool>,
    pub can_manage_connections: Option<bool>,
    pub can_view_audit_logs: Option<bool>,
    pub can_create_users: Option<bool>,
    pub can_create_user_groups: Option<bool>,
    pub can_create_connections: Option<bool>,
    pub can_create_connection_folders: Option<bool>,
    pub can_create_sharing_profiles: Option<bool>,
    pub can_view_sessions: Option<bool>,
}

const SELECT_COLUMNS: &str =
    "id, name, can_manage_system, can_manage_users, can_manage_connections, can_view_audit_logs, \
     can_create_users, can_create_user_groups, can_create_connections, \
     can_create_connection_folders, can_create_sharing_profiles, can_view_sessions";

pub async fn list_all(pool: &Pool<Postgres>) -> Result<Vec<RoleRow>, AppError> {
    let rows: Vec<RoleRow> =
        sqlx::query_as(&format!("SELECT {SELECT_COLUMNS} FROM roles ORDER BY name"))
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

pub async fn create(pool: &Pool<Postgres>, body: &CreateRoleRequest) -> Result<RoleRow, AppError> {
    let row: RoleRow = sqlx::query_as(&format!(
        "INSERT INTO roles (name, can_manage_system, can_manage_users, can_manage_connections, \
         can_view_audit_logs, can_create_users, can_create_user_groups, can_create_connections, \
         can_create_connection_folders, can_create_sharing_profiles, can_view_sessions) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) \
         RETURNING {SELECT_COLUMNS}"
    ))
    .bind(&body.name)
    .bind(body.can_manage_system.unwrap_or(false))
    .bind(body.can_manage_users.unwrap_or(false))
    .bind(body.can_manage_connections.unwrap_or(false))
    .bind(body.can_view_audit_logs.unwrap_or(false))
    .bind(body.can_create_users.unwrap_or(false))
    .bind(body.can_create_user_groups.unwrap_or(false))
    .bind(body.can_create_connections.unwrap_or(false))
    .bind(body.can_create_connection_folders.unwrap_or(false))
    .bind(body.can_create_sharing_profiles.unwrap_or(false))
    .bind(body.can_view_sessions.unwrap_or(false))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update(
    pool: &Pool<Postgres>,
    id: Uuid,
    body: &UpdateRoleRequest,
) -> Result<RoleRow, AppError> {
    let row: RoleRow = sqlx::query_as(&format!(
        "UPDATE roles SET
            name = COALESCE($2, name),
            can_manage_system = COALESCE($3, can_manage_system),
            can_manage_users = COALESCE($4, can_manage_users),
            can_manage_connections = COALESCE($5, can_manage_connections),
            can_view_audit_logs = COALESCE($6, can_view_audit_logs),
            can_create_users = COALESCE($7, can_create_users),
            can_create_user_groups = COALESCE($8, can_create_user_groups),
            can_create_connections = COALESCE($9, can_create_connections),
            can_create_connection_folders = COALESCE($10, can_create_connection_folders),
            can_create_sharing_profiles = COALESCE($11, can_create_sharing_profiles),
            can_view_sessions = COALESCE($12, can_view_sessions)
         WHERE id = $1
         RETURNING {SELECT_COLUMNS}"
    ))
    .bind(id)
    .bind(body.name.as_deref())
    .bind(body.can_manage_system)
    .bind(body.can_manage_users)
    .bind(body.can_manage_connections)
    .bind(body.can_view_audit_logs)
    .bind(body.can_create_users)
    .bind(body.can_create_user_groups)
    .bind(body.can_create_connections)
    .bind(body.can_create_connection_folders)
    .bind(body.can_create_sharing_profiles)
    .bind(body.can_view_sessions)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Fetch a role's name by id. Returns `None` if not found.
pub async fn find_name(pool: &Pool<Postgres>, id: Uuid) -> Result<Option<String>, AppError> {
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM roles WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(name)
}

/// Count users currently assigned to a role.
pub async fn count_users_in_role(pool: &Pool<Postgres>, id: Uuid) -> Result<i64, AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role_id = $1")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(count)
}

pub async fn delete_by_id(pool: &Pool<Postgres>, id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM roles WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Role-Connection / Role-Folder mappings ─────────────────────────────

#[derive(Deserialize, Debug)]
pub struct RoleMappingUpdate {
    pub connection_ids: Vec<Uuid>,
    pub folder_ids: Vec<Uuid>,
}

#[derive(Serialize, Debug)]
pub struct RoleMappings {
    pub connection_ids: Vec<Uuid>,
    pub folder_ids: Vec<Uuid>,
}

/// Fetch connection + folder mappings for a single role.
pub async fn get_mappings(pool: &Pool<Postgres>, role_id: Uuid) -> Result<RoleMappings, AppError> {
    let connection_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT connection_id FROM role_connections WHERE role_id = $1")
            .bind(role_id)
            .fetch_all(pool)
            .await?;

    let folder_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT folder_id FROM role_folders WHERE role_id = $1")
            .bind(role_id)
            .fetch_all(pool)
            .await?;

    Ok(RoleMappings {
        connection_ids,
        folder_ids,
    })
}

/// Replace all connection + folder mappings for a role atomically.
pub async fn replace_mappings(
    pool: &Pool<Postgres>,
    role_id: Uuid,
    body: &RoleMappingUpdate,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM role_connections WHERE role_id = $1")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    for cid in &body.connection_ids {
        sqlx::query("INSERT INTO role_connections (role_id, connection_id) VALUES ($1, $2)")
            .bind(role_id)
            .bind(cid)
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query("DELETE FROM role_folders WHERE role_id = $1")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    for fid in &body.folder_ids {
        sqlx::query("INSERT INTO role_folders (role_id, folder_id) VALUES ($1, $2)")
            .bind(role_id)
            .bind(fid)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}
