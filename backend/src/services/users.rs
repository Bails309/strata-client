//! DB operations for user rows (admin-facing CRUD).
//!
//! Extracted from [`crate::routes::admin`] so route handlers can be thin
//! orchestration layers over a typed service boundary (§3.1 / W4-6).
//!
//! Password-hash generation and rate-limiting stay in the handler because
//! they are not pure DB operations.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres};
use uuid::Uuid;

const SELECT_COLUMNS: &str =
    "u.id, u.username, u.email, u.full_name, u.auth_type, u.sub, r.name as role_name, u.deleted_at";

#[derive(Serialize, FromRow, Debug, Clone)]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub full_name: Option<String>,
    pub auth_type: String,
    pub sub: Option<String>,
    pub role_name: String,
    pub deleted_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize, Debug)]
pub struct CreateUserRequest {
    pub username: String,
    pub email: String,
    pub full_name: Option<String>,
    pub role_id: Uuid,
    pub auth_type: String, // "local" or "sso"
}

#[derive(Deserialize, Debug)]
pub struct UpdateUserRequest {
    pub role_id: Uuid,
}

#[derive(Deserialize, Debug)]
pub struct UserListQuery {
    pub include_deleted: Option<bool>,
}

/// List users, optionally restricted to soft-deleted rows.
pub async fn list_all(
    pool: &Pool<Postgres>,
    include_deleted: bool,
) -> Result<Vec<UserRow>, AppError> {
    let sql = if include_deleted {
        format!(
            "SELECT {SELECT_COLUMNS}
             FROM users u JOIN roles r ON u.role_id = r.id
             WHERE u.deleted_at IS NOT NULL
             ORDER BY u.deleted_at DESC"
        )
    } else {
        format!(
            "SELECT {SELECT_COLUMNS}
             FROM users u JOIN roles r ON u.role_id = r.id
             WHERE u.deleted_at IS NULL
             ORDER BY u.email"
        )
    };
    let rows: Vec<UserRow> = sqlx::query_as(&sql).fetch_all(pool).await?;
    Ok(rows)
}

/// Clear a soft-delete tombstone. Returns `true` if a row was restored.
pub async fn restore(pool: &Pool<Postgres>, id: Uuid) -> Result<bool, AppError> {
    let result =
        sqlx::query("UPDATE users SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL")
            .bind(id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() > 0)
}

/// Soft-delete a user. Returns `true` if a row was updated.
pub async fn soft_delete(pool: &Pool<Postgres>, id: Uuid) -> Result<bool, AppError> {
    let result =
        sqlx::query("UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL")
            .bind(id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected() > 0)
}

/// Check whether a role with the given id exists.
pub async fn role_exists(pool: &Pool<Postgres>, role_id: Uuid) -> Result<bool, AppError> {
    let found: Option<Uuid> = sqlx::query_scalar("SELECT id FROM roles WHERE id = $1")
        .bind(role_id)
        .fetch_optional(pool)
        .await?;
    Ok(found.is_some())
}

/// Update the role assignment for a live user. Returns `true` if updated.
pub async fn set_role(pool: &Pool<Postgres>, id: Uuid, role_id: Uuid) -> Result<bool, AppError> {
    let result = sqlx::query("UPDATE users SET role_id = $1 WHERE id = $2 AND deleted_at IS NULL")
        .bind(role_id)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Check whether any live user already has the given (lower-cased)
/// email **or** username.
pub async fn exists_by_email_or_username(
    pool: &Pool<Postgres>,
    email_lower: &str,
    username_lower: &str,
) -> Result<bool, AppError> {
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $2")
            .bind(email_lower)
            .bind(username_lower)
            .fetch_optional(pool)
            .await?;
    Ok(existing.is_some())
}

/// Insert a new user row. The caller is responsible for hashing the
/// password (or passing `None` for SSO users) and normalising the
/// email/username to lowercase.
#[allow(clippy::too_many_arguments)]
pub async fn insert(
    pool: &Pool<Postgres>,
    id: Uuid,
    username: &str,
    email: &str,
    full_name: Option<&str>,
    password_hash: Option<&str>,
    auth_type: &str,
    role_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO users (id, username, email, full_name, password_hash, auth_type, role_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(username)
    .bind(email)
    .bind(full_name)
    .bind(password_hash)
    .bind(auth_type)
    .bind(role_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Look up the `auth_type` of a live user (used by the password-reset
/// flow to reject SSO accounts).
pub async fn auth_type_of(pool: &Pool<Postgres>, id: Uuid) -> Result<Option<String>, AppError> {
    let auth_type: Option<String> =
        sqlx::query_scalar("SELECT auth_type FROM users WHERE id = $1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(auth_type)
}

/// Persist a new password hash for the given user.
pub async fn set_password_hash(
    pool: &Pool<Postgres>,
    id: Uuid,
    hash: &str,
) -> Result<(), AppError> {
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(hash)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Return `(terms_accepted_at, terms_accepted_version)` for the user.
pub async fn terms_status(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<(Option<chrono::DateTime<chrono::Utc>>, Option<i32>), AppError> {
    let row: Option<(Option<chrono::DateTime<chrono::Utc>>, Option<i32>)> =
        sqlx::query_as("SELECT terms_accepted_at, terms_accepted_version FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(row.unwrap_or((None, None)))
}

/// Mark the user as having accepted the given terms version at `NOW()`.
pub async fn accept_terms(pool: &Pool<Postgres>, id: Uuid, version: i32) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE users SET terms_accepted_at = NOW(), terms_accepted_version = $2 WHERE id = $1",
    )
    .bind(id)
    .bind(version)
    .execute(pool)
    .await?;
    Ok(())
}

/// True if the user has any approval role assignments.
pub async fn is_approver(pool: &Pool<Postgres>, id: Uuid) -> Result<bool, AppError> {
    let v: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM approval_role_assignments WHERE user_id = $1)",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap_or(false);
    Ok(v)
}

// ── Auth-flow row types + lookups ──────────────────────────────────────

/// Row joined from `users` + `roles` for local-auth login. `password_hash`
/// is optional because SSO-only accounts may have a NULL hash.
#[derive(sqlx::FromRow)]
pub struct UserAuthRow {
    pub id: Uuid,
    pub username: String,
    pub password_hash: Option<String>,
    #[sqlx(rename = "name")]
    pub role: String,
    pub can_manage_system: bool,
    pub can_manage_users: bool,
    pub can_manage_connections: bool,
    pub can_view_audit_logs: bool,
    pub can_create_users: bool,
    pub can_create_user_groups: bool,
    pub can_create_connections: bool,
    pub can_create_connection_folders: bool,
    pub can_create_sharing_profiles: bool,
}

/// Look up a local-auth user by username or email (case-insensitive).
pub async fn find_local_by_username_or_email(
    pool: &Pool<Postgres>,
    username_or_email: &str,
) -> Result<Option<UserAuthRow>, AppError> {
    let row = sqlx::query_as(
        "SELECT u.id, u.username, u.password_hash, r.name,
                r.can_manage_system, r.can_manage_users, r.can_manage_connections, r.can_view_audit_logs,
                r.can_create_users, r.can_create_user_groups, r.can_create_connections,
                r.can_create_connection_folders, r.can_create_sharing_profiles
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE (LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($1)) AND u.auth_type = 'local' AND u.deleted_at IS NULL",
    )
    .bind(username_or_email)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Row returned by the `/auth/status` endpoint. Superset of [`UserAuthRow`]
/// that includes `full_name`, `can_view_sessions`, and terms-acceptance.
#[derive(sqlx::FromRow)]
pub struct AuthStatusRow {
    pub id: Uuid,
    pub username: String,
    pub full_name: Option<String>,
    #[sqlx(rename = "name")]
    pub role: String,
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
    pub terms_accepted_at: Option<chrono::DateTime<chrono::Utc>>,
    pub terms_accepted_version: Option<i32>,
}

pub async fn find_auth_status(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<AuthStatusRow>, AppError> {
    let row = sqlx::query_as(
        "SELECT u.id, u.username, u.full_name, r.name,
                r.can_manage_system, r.can_manage_users, r.can_manage_connections, r.can_view_audit_logs,
                r.can_create_users, r.can_create_user_groups, r.can_create_connections,
                r.can_create_connection_folders, r.can_create_sharing_profiles, r.can_view_sessions,
                u.terms_accepted_at, u.terms_accepted_version
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.id = $1 AND u.deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Fetch the stored Argon2 hash for a local-auth user. Returns `None` if
/// the user doesn't exist, is deleted, or isn't `auth_type = 'local'`.
pub async fn local_password_hash(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<String>, AppError> {
    let hash: Option<Option<String>> = sqlx::query_scalar(
        "SELECT password_hash FROM users WHERE id = $1 AND auth_type = 'local' AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(hash.flatten())
}

/// Look up `(username, role_name)` for the given user id (not deleted).
pub async fn username_and_role(
    pool: &Pool<Postgres>,
    id: Uuid,
) -> Result<Option<(String, String)>, AppError> {
    let row = sqlx::query_as(
        "SELECT u.username, r.name AS role_name
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1 AND u.deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Row used during SSO login/link.
#[derive(sqlx::FromRow)]
pub struct SsoUserRow {
    pub id: Uuid,
    pub username: String,
    pub role_name: String,
    pub sub: Option<String>,
    #[allow(dead_code)]
    pub full_name: Option<String>,
}

/// Find a non-deleted user by (case-insensitive) email for SSO linking.
pub async fn find_sso_by_email(
    pool: &Pool<Postgres>,
    email: &str,
) -> Result<Option<SsoUserRow>, AppError> {
    let row = sqlx::query_as(
        "SELECT u.id, u.username, r.name as role_name, u.sub, u.full_name
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL",
    )
    .bind(email)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Link the user to an OIDC subject on first SSO login. `full_name` is
/// only written if currently NULL.
pub async fn link_sso_subject(
    pool: &Pool<Postgres>,
    id: Uuid,
    sub: &str,
    full_name: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query("UPDATE users SET sub = $1, full_name = COALESCE(full_name, $2) WHERE id = $3")
        .bind(sub)
        .bind(full_name)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
