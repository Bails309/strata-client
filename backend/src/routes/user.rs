use axum::extract::{Extension, Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::{settings, vault};

async fn require_running(state: &SharedState) -> Result<crate::db::Database, AppError> {
    let s = state.read().await;
    if s.phase != BootPhase::Running {
        return Err(AppError::SetupRequired);
    }
    s.db.clone().ok_or(AppError::SetupRequired)
}

// ── Current user ───────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
#[allow(dead_code)]
pub struct UserProfile {
    pub id: Uuid,
    pub username: String,
    pub role_name: String,
}

pub async fn me(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let client_ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            // Use rightmost entry — the one added by our trusted proxy (Caddy)
            v.rsplit(',')
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    let watermark_enabled = settings::get(&db.pool, "watermark_enabled")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let vault_configured = {
        let s = state.read().await;
        s.config.as_ref().and_then(|c| c.vault.as_ref()).is_some()
    };

    Ok(Json(json!({
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role,
        "sub": user.sub,
        "client_ip": client_ip,
        "watermark_enabled": watermark_enabled == "true",
        "vault_configured": vault_configured,
        "can_manage_system": user.can_manage_system,
        "can_manage_users": user.can_manage_users,
        "can_manage_connections": user.can_manage_connections,
        "can_view_audit_logs": user.can_view_audit_logs,
        "can_create_users": user.can_create_users,
        "can_create_user_groups": user.can_create_user_groups,
        "can_create_connections": user.can_create_connections,
        "can_create_connection_folders": user.can_create_connection_folders,
        "can_create_sharing_profiles": user.can_create_sharing_profiles,
    })))
}

// ── User's connections ─────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
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
}

pub async fn my_connections(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<UserConnectionRow>>, AppError> {
    let db = require_running(&state).await?;

    let rows: Vec<UserConnectionRow> = if user.role == "admin" {
        // Admins see all connections regardless of role assignment.
        // History is fetched from user_connection_access (per-user). Note: migration 026
        // seeded this table from global data; subsequent connections update this per-user.
        sqlx::query_as(
            "SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                    c.folder_id, cf.name AS folder_name, uca.last_accessed
             FROM connections c
             LEFT JOIN connection_folders cf ON cf.id = c.folder_id
             LEFT JOIN user_connection_access uca ON uca.connection_id = c.id AND uca.user_id = $1
             WHERE c.soft_deleted_at IS NULL
             ORDER BY c.name",
        )
        .bind(user.id)
        .fetch_all(&db.pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT DISTINCT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                    c.folder_id, cf.name AS folder_name, uca.last_accessed
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
        .bind(user.id)
        .fetch_all(&db.pool)
        .await?
    };

    Ok(Json(rows))
}

// ── Favorites ─────────────────────────────────────────────────────────

pub async fn list_favorites(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<Uuid>>, AppError> {
    let db = require_running(&state).await?;
    let ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT connection_id FROM user_favorites WHERE user_id = $1")
            .bind(user.id)
            .fetch_all(&db.pool)
            .await?;
    Ok(Json(ids))
}

#[derive(Deserialize)]
pub struct FavoriteRequest {
    pub connection_id: Uuid,
}

pub async fn toggle_favorite(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<FavoriteRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Check if already favorited
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM user_favorites WHERE user_id = $1 AND connection_id = $2)",
    )
    .bind(user.id)
    .bind(body.connection_id)
    .fetch_one(&db.pool)
    .await
    .unwrap_or(false);

    if exists {
        sqlx::query("DELETE FROM user_favorites WHERE user_id = $1 AND connection_id = $2")
            .bind(user.id)
            .bind(body.connection_id)
            .execute(&db.pool)
            .await?;
        Ok(Json(json!({ "favorited": false })))
    } else {
        sqlx::query(
            "INSERT INTO user_favorites (user_id, connection_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(user.id)
        .bind(body.connection_id)
        .execute(&db.pool)
        .await?;
        Ok(Json(json!({ "favorited": true })))
    }
}
// ── Update user credential (envelope encryption) ──────────────────────

#[derive(Deserialize)]
pub struct UpdateCredentialRequest {
    pub connection_id: Uuid,
    pub password: String,
}

pub async fn update_credential(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<UpdateCredentialRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Require Vault to be configured
    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    // Envelope-encrypt the password
    let sealed = vault::seal(&vault_cfg, body.password.as_bytes()).await?;

    sqlx::query(
        "INSERT INTO user_credentials (user_id, connection_id, encrypted_password, encrypted_dek, nonce)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, connection_id) DO UPDATE
         SET encrypted_password = $3, encrypted_dek = $4, nonce = $5, updated_at = now()",
    )
    .bind(user.id)
    .bind(body.connection_id)
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .execute(&db.pool)
    .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "credential.updated",
        &json!({ "connection_id": body.connection_id.to_string() }),
    )
    .await?;

    // Revoke active share links for this connection owned by this user,
    // since the underlying credentials have changed
    sqlx::query(
        "UPDATE connection_shares SET revoked = true
         WHERE owner_user_id = $1 AND connection_id = $2 AND NOT revoked",
    )
    .bind(user.id)
    .bind(body.connection_id)
    .execute(&db.pool)
    .await?;

    Ok(Json(json!({ "status": "credential_saved" })))
}

// ── Credential Profiles (envelope-encrypted username+password) ────────

#[derive(Deserialize)]
pub struct CreateCredentialProfileRequest {
    pub label: String,
    pub username: String,
    pub password: String,
    pub ttl_hours: Option<i32>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct CredentialProfileRow {
    pub id: Uuid,
    pub label: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub expired: bool,
    pub ttl_hours: i32,
}

pub async fn list_credential_profiles(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<CredentialProfileRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows: Vec<CredentialProfileRow> = sqlx::query_as(
        "SELECT id, label, created_at, updated_at, expires_at,
                (expires_at < now()) AS expired, ttl_hours
         FROM credential_profiles WHERE user_id = $1 ORDER BY label",
    )
    .bind(user.id)
    .fetch_all(&db.pool)
    .await?;
    Ok(Json(rows))
}

pub async fn create_credential_profile(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateCredentialProfileRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    // Envelope-encrypt both username and password with one DEK
    let combined = serde_json::json!({
        "u": body.username,
        "p": body.password,
    });
    let sealed = vault::seal(&vault_cfg, combined.to_string().as_bytes()).await?;

    // Resolve effective TTL: user preference capped by admin max (which is itself capped at 12)
    let admin_max: i64 = crate::services::settings::get(&db.pool, "credential_ttl_hours")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(12)
        .clamp(1, 12);
    let ttl_hours = (body.ttl_hours.unwrap_or(admin_max as i32) as i64).clamp(1, admin_max) as i32;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO credential_profiles (user_id, label, encrypted_username, encrypted_password, encrypted_dek, nonce, ttl_hours, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $7))
         RETURNING id",
    )
    .bind(user.id)
    .bind(&body.label)
    .bind(&[] as &[u8])         // encrypted_username: unused, combined payload in encrypted_password
    .bind(&sealed.ciphertext)
    .bind(&sealed.encrypted_dek)
    .bind(&sealed.nonce)
    .bind(ttl_hours as i32)
    .fetch_one(&db.pool)
    .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "credential_profile.created",
        &json!({ "profile_id": id.to_string(), "label": body.label }),
    )
    .await?;

    Ok(Json(json!({ "id": id, "status": "created" })))
}

#[derive(Deserialize)]
pub struct UpdateCredentialProfileRequest {
    pub label: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub ttl_hours: Option<i32>,
}

pub async fn update_credential_profile(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(profile_id): Path<Uuid>,
    Json(body): Json<UpdateCredentialProfileRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Verify ownership
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM credential_profiles WHERE id = $1 AND user_id = $2)",
    )
    .bind(profile_id)
    .bind(user.id)
    .fetch_one(&db.pool)
    .await
    .unwrap_or(false);

    if !exists {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    // If credentials are being updated, re-encrypt
    if body.username.is_some() || body.password.is_some() {
        let vault_cfg = {
            let s = state.read().await;
            s.config
                .as_ref()
                .and_then(|c| c.vault.clone())
                .ok_or_else(|| AppError::Config("Vault not configured".into()))?
        };

        // We need both username and password for re-encryption.
        // If only one is provided, we must decrypt the existing to get the other.
        let (username, password) = match (&body.username, &body.password) {
            (Some(u), Some(p)) => (u.clone(), p.clone()),
            _ => {
                // Decrypt existing
                let existing: (Vec<u8>, Vec<u8>, Vec<u8>) = sqlx::query_as(
                    "SELECT encrypted_password, encrypted_dek, nonce
                     FROM credential_profiles WHERE id = $1",
                )
                .bind(profile_id)
                .fetch_one(&db.pool)
                .await?;

                let plaintext = vault::unseal(&vault_cfg, &existing.1, &existing.0, &existing.2)
                    .await
                    .map_err(|e| {
                        tracing::error!("Failed to decrypt existing credential profile: {e}");
                        AppError::Validation("Existing profile data uses outdated encryption. To update this profile, please re-type both your Username and Password to securely overwrite it.".into())
                    })?;
                let plain_str = String::from_utf8(plaintext).unwrap_or_default();
                let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                    .unwrap_or_else(|_| json!({ "u": "", "p": plain_str }));

                let existing_u = parsed["u"].as_str().unwrap_or("").to_string();
                let existing_p = parsed["p"].as_str().unwrap_or("").to_string();

                (
                    body.username.clone().unwrap_or(existing_u),
                    body.password.clone().unwrap_or(existing_p),
                )
            }
        };

        let combined = serde_json::json!({ "u": username, "p": password });
        let sealed = vault::seal(&vault_cfg, combined.to_string().as_bytes()).await?;

        // Resolve effective TTL: user preference capped by admin max (which is itself capped at 12)
        let admin_max: i64 = crate::services::settings::get(&db.pool, "credential_ttl_hours")
            .await
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(12)
            .clamp(1, 12);
        let ttl_hours =
            (body.ttl_hours.unwrap_or(admin_max as i32) as i64).clamp(1, admin_max) as i32;

        sqlx::query(
            "UPDATE credential_profiles
             SET encrypted_username = $1, encrypted_password = $2, encrypted_dek = $3, nonce = $4,
                 ttl_hours = $5, updated_at = now(), expires_at = now() + make_interval(hours => $5)
             WHERE id = $6",
        )
        .bind(&[] as &[u8])
        .bind(&sealed.ciphertext)
        .bind(&sealed.encrypted_dek)
        .bind(&sealed.nonce)
        .bind(ttl_hours)
        .bind(profile_id)
        .execute(&db.pool)
        .await?;
    }

    // Update label if provided
    if let Some(ref label) = body.label {
        sqlx::query("UPDATE credential_profiles SET label = $1, updated_at = now() WHERE id = $2")
            .bind(label)
            .bind(profile_id)
            .execute(&db.pool)
            .await?;
    }

    // Update TTL if provided (without credential change) — recalculates expires_at from now
    if body.ttl_hours.is_some() && body.username.is_none() && body.password.is_none() {
        let admin_max: i64 = crate::services::settings::get(&db.pool, "credential_ttl_hours")
            .await
            .ok()
            .flatten()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(12)
            .clamp(1, 12);
        let ttl_hours =
            (body.ttl_hours.unwrap_or(admin_max as i32) as i64).clamp(1, admin_max) as i32;
        sqlx::query(
            "UPDATE credential_profiles SET ttl_hours = $1, expires_at = now() + make_interval(hours => $1), updated_at = now() WHERE id = $2",
        )
        .bind(ttl_hours)
        .bind(profile_id)
        .execute(&db.pool)
        .await?;
    }

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "credential_profile.updated",
        &json!({ "profile_id": profile_id.to_string() }),
    )
    .await?;

    // Revoke active share links for connections using this profile
    if body.username.is_some() || body.password.is_some() {
        sqlx::query(
            "UPDATE connection_shares SET revoked = true
             WHERE owner_user_id = $1 AND connection_id IN (
                 SELECT connection_id FROM credential_mappings WHERE credential_id = $2
             ) AND NOT revoked",
        )
        .bind(user.id)
        .bind(profile_id)
        .execute(&db.pool)
        .await?;
    }

    Ok(Json(json!({ "status": "updated" })))
}

pub async fn delete_credential_profile(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(profile_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Revoke active share links for connections using this profile BEFORE deleting
    sqlx::query(
        "UPDATE connection_shares SET revoked = true
         WHERE owner_user_id = $1 AND connection_id IN (
             SELECT connection_id FROM credential_mappings WHERE credential_id = $2
         ) AND NOT revoked",
    )
    .bind(user.id)
    .bind(profile_id)
    .execute(&db.pool)
    .await?;

    let deleted = sqlx::query("DELETE FROM credential_profiles WHERE id = $1 AND user_id = $2")
        .bind(profile_id)
        .bind(user.id)
        .execute(&db.pool)
        .await?;

    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "credential_profile.deleted",
        &json!({ "profile_id": profile_id.to_string() }),
    )
    .await?;

    Ok(Json(json!({ "status": "deleted" })))
}

// ── Credential Mappings (profile ↔ connection) ──────────────────────

#[derive(Deserialize)]
pub struct SetMappingRequest {
    pub profile_id: Uuid,
    pub connection_id: Uuid,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct MappingRow {
    pub connection_id: Uuid,
    pub connection_name: String,
    pub protocol: String,
}

pub async fn get_profile_mappings(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(profile_id): Path<Uuid>,
) -> Result<Json<Vec<MappingRow>>, AppError> {
    let db = require_running(&state).await?;

    // Verify ownership
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM credential_profiles WHERE id = $1 AND user_id = $2)",
    )
    .bind(profile_id)
    .bind(user.id)
    .fetch_one(&db.pool)
    .await
    .unwrap_or(false);

    if !exists {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    let rows: Vec<MappingRow> = sqlx::query_as(
        "SELECT cm.connection_id, c.name AS connection_name, c.protocol
         FROM credential_mappings cm
         JOIN connections c ON c.id = cm.connection_id
         WHERE cm.credential_id = $1
         ORDER BY c.name",
    )
    .bind(profile_id)
    .fetch_all(&db.pool)
    .await?;

    Ok(Json(rows))
}

pub async fn set_credential_mapping(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SetMappingRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Verify profile ownership
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM credential_profiles WHERE id = $1 AND user_id = $2)",
    )
    .bind(body.profile_id)
    .bind(user.id)
    .fetch_one(&db.pool)
    .await
    .unwrap_or(false);

    if !exists {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    // Verify user has access to this connection via their role (or is admin)
    let has_access: bool = if user.role == "admin" {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM connections WHERE id = $1 AND soft_deleted_at IS NULL)",
        )
        .bind(body.connection_id)
        .fetch_one(&db.pool)
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
        .bind(body.connection_id)
        .bind(user.id)
        .fetch_one(&db.pool)
        .await?
    };
    if !has_access {
        return Err(AppError::NotFound("Connection not found".into()));
    }

    // Remove any existing mapping for this user+connection (different profile)
    sqlx::query(
        "DELETE FROM credential_mappings
         WHERE connection_id = $1
           AND credential_id IN (SELECT id FROM credential_profiles WHERE user_id = $2)",
    )
    .bind(body.connection_id)
    .bind(user.id)
    .execute(&db.pool)
    .await?;

    // Insert new mapping
    sqlx::query(
        "INSERT INTO credential_mappings (credential_id, connection_id) VALUES ($1, $2)
         ON CONFLICT (credential_id, connection_id) DO NOTHING",
    )
    .bind(body.profile_id)
    .bind(body.connection_id)
    .execute(&db.pool)
    .await?;

    Ok(Json(json!({ "status": "mapped" })))
}

pub async fn remove_credential_mapping(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(connection_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    sqlx::query(
        "DELETE FROM credential_mappings
         WHERE connection_id = $1
           AND credential_id IN (SELECT id FROM credential_profiles WHERE user_id = $2)",
    )
    .bind(connection_id)
    .bind(user.id)
    .execute(&db.pool)
    .await?;

    Ok(Json(json!({ "status": "removed" })))
}

// ── Connection info (does the user need to supply credentials?) ───────

pub async fn connection_info(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(connection_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (db, has_vault) = {
        let s = state.read().await;
        if s.phase != crate::services::app_state::BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let vault = s.config.as_ref().and_then(|c| c.vault.as_ref()).is_some();
        (db, vault)
    };

    // Fetch protocol and extra params for this connection
    let (protocol, extra): (String, Option<serde_json::Value>) = sqlx::query_as(
        "SELECT protocol, extra FROM connections WHERE id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(connection_id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;

    // Check if a credential profile is mapped to this user+connection
    let has_vault_creds: bool = if !has_vault {
        false
    } else {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM credential_mappings cm
                JOIN credential_profiles cp ON cp.id = cm.credential_id
                WHERE cm.connection_id = $1 AND cp.user_id = $2
                  AND cp.expires_at > now()
            )",
        )
        .bind(connection_id)
        .bind(user.id)
        .fetch_one(&db.pool)
        .await
        .unwrap_or(false)
    };

    let ignore_cert = if protocol == "rdp" {
        extra
            .as_ref()
            .and_then(|e| e.get("ignore-cert"))
            .map(|v| match v {
                serde_json::Value::String(s) => s == "true",
                serde_json::Value::Bool(b) => *b,
                _ => false,
            })
            .unwrap_or(false)
    } else {
        false
    };

    Ok(Json(json!({
        "protocol": protocol,
        "has_credentials": has_vault_creds,
        "ignore_cert": ignore_cert,
    })))
}

// ── Serve a recording file ────────────────────────────────────────────

/// Validate a recording filename — reject path traversal characters.
fn is_safe_recording_filename(name: &str) -> bool {
    !name.is_empty() && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

pub async fn get_recording(
    State(state): State<SharedState>,
    Path(filename): Path<String>,
) -> Result<axum::response::Response, AppError> {
    use axum::body::Body;
    use axum::http::header;
    use tokio::fs::File;
    use tokio_util::io::ReaderStream;

    // Sanitise filename – prevent path traversal
    if !is_safe_recording_filename(&filename) {
        return Err(AppError::NotFound("Invalid filename".into()));
    }

    // Escape quotes in filename for Content-Disposition header
    let safe_filename = filename.replace('"', "");

    // Try local file first
    let recordings_dir = "/var/lib/guacamole/recordings";
    let path = format!("{recordings_dir}/{filename}");

    // Resolve symlinks and verify the canonical path stays within recordings dir
    if let Ok(canonical) = tokio::fs::canonicalize(&path).await {
        let recordings_canonical = tokio::fs::canonicalize(recordings_dir)
            .await
            .unwrap_or_else(|_| std::path::PathBuf::from(recordings_dir));
        if !canonical.starts_with(&recordings_canonical) {
            return Err(AppError::NotFound("Invalid filename".into()));
        }
    }

    if let Ok(file) = File::open(&path).await {
        let stream = ReaderStream::new(file);
        let body = Body::from_stream(stream);
        return Ok(axum::response::Response::builder()
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{safe_filename}\""),
            )
            .body(body)
            .unwrap());
    }

    // Fall back to Azure Blob if configured
    let db = require_running(&state).await?;
    let config = crate::services::recordings::get_config(&db.pool)
        .await
        .map_err(|_| AppError::NotFound("Config error".into()))?;

    if config.storage_type == crate::services::recordings::StorageType::AzureBlob {
        let vault_cfg = {
            let s = state.read().await;
            s.config.as_ref().and_then(|c| c.vault.as_ref().cloned())
        };
        if let Some(azure) =
            crate::services::recordings::get_azure_config(&db.pool, vault_cfg.as_ref())
                .await
                .map_err(|_| AppError::NotFound("Config error".into()))?
        {
            let data = crate::services::recordings::download_from_azure(&azure, &filename)
                .await
                .map_err(|e| AppError::NotFound(format!("Recording not found: {e}")))?;

            let body = Body::from(data);
            return Ok(axum::response::Response::builder()
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{safe_filename}\""),
                )
                .body(body)
                .unwrap());
        }
    }

    Err(AppError::NotFound(format!(
        "Recording not found: {filename}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── FavoriteRequest ────────────────────────────────────────────────

    #[test]
    fn favorite_request_deserializes() {
        let j = json!({ "connection_id": "550e8400-e29b-41d4-a716-446655440000" });
        let req: FavoriteRequest = serde_json::from_value(j).unwrap();
        assert_eq!(
            req.connection_id,
            Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap()
        );
    }

    #[test]
    fn favorite_request_rejects_missing_field() {
        let j = json!({});
        assert!(serde_json::from_value::<FavoriteRequest>(j).is_err());
    }

    #[test]
    fn favorite_request_rejects_invalid_uuid() {
        let j = json!({ "connection_id": "not-a-uuid" });
        assert!(serde_json::from_value::<FavoriteRequest>(j).is_err());
    }

    // ── UpdateCredentialRequest ────────────────────────────────────────

    #[test]
    fn update_credential_request_deserializes() {
        let j = json!({
            "connection_id": "550e8400-e29b-41d4-a716-446655440000",
            "password": "s3cret!"
        });
        let req: UpdateCredentialRequest = serde_json::from_value(j).unwrap();
        assert_eq!(
            req.connection_id,
            Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap()
        );
        assert_eq!(req.password, "s3cret!");
    }

    #[test]
    fn update_credential_request_rejects_missing_password() {
        let j = json!({ "connection_id": "550e8400-e29b-41d4-a716-446655440000" });
        assert!(serde_json::from_value::<UpdateCredentialRequest>(j).is_err());
    }

    // ── CreateCredentialProfileRequest ─────────────────────────────────

    #[test]
    fn create_profile_request_deserializes_with_ttl() {
        let j = json!({
            "label": "Work",
            "username": "admin",
            "password": "hunter2",
            "ttl_hours": 8
        });
        let req: CreateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.label, "Work");
        assert_eq!(req.username, "admin");
        assert_eq!(req.password, "hunter2");
        assert_eq!(req.ttl_hours, Some(8));
    }

    #[test]
    fn create_profile_request_ttl_is_optional() {
        let j = json!({
            "label": "Work",
            "username": "admin",
            "password": "hunter2"
        });
        let req: CreateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert!(req.ttl_hours.is_none());
    }

    #[test]
    fn create_profile_request_rejects_missing_label() {
        let j = json!({ "username": "admin", "password": "hunter2" });
        assert!(serde_json::from_value::<CreateCredentialProfileRequest>(j).is_err());
    }

    // ── UpdateCredentialProfileRequest ─────────────────────────────────

    #[test]
    fn update_profile_request_all_optional() {
        let j = json!({});
        let req: UpdateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert!(req.label.is_none());
        assert!(req.username.is_none());
        assert!(req.password.is_none());
        assert!(req.ttl_hours.is_none());
    }

    #[test]
    fn update_profile_request_partial_fields() {
        let j = json!({ "label": "New Label", "ttl_hours": 4 });
        let req: UpdateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.label.as_deref(), Some("New Label"));
        assert_eq!(req.ttl_hours, Some(4));
        assert!(req.username.is_none());
        assert!(req.password.is_none());
    }

    // ── SetMappingRequest ──────────────────────────────────────────────

    #[test]
    fn set_mapping_request_deserializes() {
        let j = json!({
            "profile_id": "550e8400-e29b-41d4-a716-446655440000",
            "connection_id": "660e8400-e29b-41d4-a716-446655440000"
        });
        let req: SetMappingRequest = serde_json::from_value(j).unwrap();
        assert_eq!(
            req.profile_id,
            Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap()
        );
        assert_eq!(
            req.connection_id,
            Uuid::parse_str("660e8400-e29b-41d4-a716-446655440000").unwrap()
        );
    }

    #[test]
    fn set_mapping_request_rejects_missing_profile_id() {
        let j = json!({ "connection_id": "660e8400-e29b-41d4-a716-446655440000" });
        assert!(serde_json::from_value::<SetMappingRequest>(j).is_err());
    }

    // ── MappingRow serialization ───────────────────────────────────────

    #[test]
    fn mapping_row_serializes() {
        let row = MappingRow {
            connection_id: Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap(),
            connection_name: "Server A".to_string(),
            protocol: "rdp".to_string(),
        };
        let v = serde_json::to_value(&row).unwrap();
        assert_eq!(v["connection_name"], "Server A");
        assert_eq!(v["protocol"], "rdp");
    }

    // ── UserProfile serialization ──────────────────────────────────────

    #[test]
    fn user_profile_serializes() {
        let profile = UserProfile {
            id: Uuid::nil(),
            username: "testuser".to_string(),
            role_name: "admin".to_string(),
        };
        let v = serde_json::to_value(&profile).unwrap();
        assert_eq!(v["username"], "testuser");
        assert_eq!(v["role_name"], "admin");
    }

    // ── Filename sanitization (path traversal prevention) ──────────────

    #[test]
    fn filename_rejects_forward_slash() {
        assert!(!is_safe_recording_filename("subdir/recording.guac"));
    }

    #[test]
    fn filename_rejects_backslash() {
        assert!(!is_safe_recording_filename("subdir\\recording.guac"));
    }

    #[test]
    fn filename_allows_clean_name() {
        assert!(is_safe_recording_filename("session-abc123.guac"));
    }

    #[test]
    fn filename_allows_dots_in_name() {
        assert!(is_safe_recording_filename("session.2024.01.15.guac"));
    }

    #[test]
    fn filename_rejects_double_dot() {
        assert!(!is_safe_recording_filename("../../etc/passwd"));
    }

    #[test]
    fn filename_rejects_empty() {
        assert!(!is_safe_recording_filename(""));
    }

    // ── Struct serialization ───────────────────────────────────────────

    #[test]
    fn user_connection_row_serializes() {
        let r = UserConnectionRow {
            id: Uuid::nil(),
            name: "server-1".into(),
            protocol: "rdp".into(),
            hostname: "10.0.0.1".into(),
            port: 3389,
            description: "Prod".into(),
            folder_id: None,
            folder_name: Some("Production".into()),
            last_accessed: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["name"], "server-1");
        assert_eq!(v["protocol"], "rdp");
        assert_eq!(v["folder_name"], "Production");
        assert!(v["last_accessed"].is_null());
    }

    #[test]
    fn credential_profile_row_serializes() {
        let r = CredentialProfileRow {
            id: Uuid::nil(),
            label: "Work".into(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            expires_at: chrono::Utc::now(),
            expired: false,
            ttl_hours: 8,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["label"], "Work");
        assert_eq!(v["expired"], false);
        assert_eq!(v["ttl_hours"], 8);
    }

    #[test]
    fn update_credential_request_deser() {
        let j = json!({
            "connection_id": "550e8400-e29b-41d4-a716-446655440000",
            "password": "new-pass"
        });
        let req: UpdateCredentialRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.password, "new-pass");
    }

    #[test]
    fn create_profile_request_all_fields() {
        let j = json!({
            "label": "Admin",
            "username": "root",
            "password": "p@ss!",
            "ttl_hours": 24
        });
        let req: CreateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.label, "Admin");
        assert_eq!(req.ttl_hours.unwrap(), 24);
    }

    #[test]
    fn update_profile_all_fields() {
        let j = json!({
            "label": "Updated",
            "username": "newuser",
            "password": "newpass",
            "ttl_hours": 12
        });
        let req: UpdateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.label.as_deref(), Some("Updated"));
        assert_eq!(req.username.as_deref(), Some("newuser"));
        assert_eq!(req.password.as_deref(), Some("newpass"));
        assert_eq!(req.ttl_hours, Some(12));
    }

    #[test]
    fn set_mapping_request_deser() {
        let j = json!({
            "profile_id": "550e8400-e29b-41d4-a716-446655440000",
            "connection_id": "660e8400-e29b-41d4-a716-446655440000"
        });
        let req: SetMappingRequest = serde_json::from_value(j).unwrap();
        assert_eq!(
            req.profile_id.to_string(),
            "550e8400-e29b-41d4-a716-446655440000"
        );
    }

    #[test]
    fn mapping_row_full_serialization() {
        let r = MappingRow {
            connection_id: Uuid::nil(),
            connection_name: "Server A".into(),
            protocol: "ssh".into(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["protocol"], "ssh");
        assert_eq!(v["connection_name"], "Server A");
    }

    #[tokio::test]
    async fn require_running_returns_error_in_setup_phase() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let state: crate::services::app_state::SharedState =
            Arc::new(RwLock::new(crate::services::app_state::AppState {
                phase: crate::services::app_state::BootPhase::Setup,
                config: None,
                db: None,
                session_registry: crate::services::session_registry::SessionRegistry::new(),
                guacd_pool: None,
            }));
        let result = require_running(&state).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn require_running_returns_error_when_no_db() {
        use std::sync::Arc;
        use tokio::sync::RwLock;
        let state: crate::services::app_state::SharedState =
            Arc::new(RwLock::new(crate::services::app_state::AppState {
                phase: crate::services::app_state::BootPhase::Running,
                config: None,
                db: None,
                session_registry: crate::services::session_registry::SessionRegistry::new(),
                guacd_pool: None,
            }));
        let result = require_running(&state).await;
        assert!(result.is_err());
    }

    // ── UpdateCredentialProfileRequest (edge cases) ─────────────────

    #[test]
    fn update_profile_partial_fields() {
        let j = json!({
            "label": "Partial"
        });
        let req: UpdateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.label.as_deref(), Some("Partial"));
        assert!(req.username.is_none());
        assert!(req.password.is_none());
        assert!(req.ttl_hours.is_none());
    }

    #[test]
    fn create_profile_request_minimal() {
        let j = json!({
            "label": "Minimal",
            "username": "u",
            "password": "p"
        });
        let req: CreateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.label, "Minimal");
        assert!(req.ttl_hours.is_none());
    }

    // ── CredentialProfileRow serialization (expired=true) ──────────

    #[test]
    fn credential_profile_row_expired_true() {
        let now = chrono::Utc::now();
        let r = CredentialProfileRow {
            id: Uuid::nil(),
            label: "Expired Profile".into(),
            created_at: now,
            updated_at: now,
            expires_at: now,
            expired: true,
            ttl_hours: 4,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["label"], "Expired Profile");
        assert_eq!(v["expired"], true);
        assert_eq!(v["ttl_hours"], 4);
    }

    // ── UserConnectionRow serialization ────────────────────────────

    #[test]
    fn user_connection_row_with_folder() {
        let r = UserConnectionRow {
            id: Uuid::nil(),
            name: "server-2".into(),
            protocol: "ssh".into(),
            hostname: "10.0.0.5".into(),
            port: 22,
            description: "SSH box".into(),
            folder_id: Some(Uuid::nil()),
            folder_name: Some("Production".into()),
            last_accessed: Some(chrono::Utc::now()),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["folder_name"], "Production");
        assert_eq!(v["protocol"], "ssh");
        assert!(v["last_accessed"].is_string());
    }

    #[test]
    fn user_connection_row_without_folder() {
        let r = UserConnectionRow {
            id: Uuid::nil(),
            name: "server-3".into(),
            protocol: "vnc".into(),
            hostname: "10.0.0.6".into(),
            port: 5900,
            description: "".into(),
            folder_id: None,
            folder_name: None,
            last_accessed: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["folder_id"].is_null());
        assert!(v["folder_name"].is_null());
        assert!(v["last_accessed"].is_null());
    }

    // ── SetMappingRequest edge cases ───────────────────────────────

    #[test]
    fn set_mapping_request_different_ids() {
        let j = json!({
            "profile_id": "550e8400-e29b-41d4-a716-446655440000",
            "connection_id": "660e8400-e29b-41d4-a716-446655440000"
        });
        let req: SetMappingRequest = serde_json::from_value(j).unwrap();
        assert_ne!(req.profile_id, req.connection_id);
    }

    // ── UpdateCredentialRequest edge cases ──────────────────────────

    #[test]
    fn update_credential_request_special_chars() {
        let j = json!({
            "connection_id": "550e8400-e29b-41d4-a716-446655440000",
            "password": "complex-p@$$w0rd!"
        });
        let req: UpdateCredentialRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.password, "complex-p@$$w0rd!");
    }

    // ── Filename sanitization ──────────────────────────────────────

    #[test]
    fn filename_allows_hyphen_and_underscore() {
        assert!(is_safe_recording_filename("session_abc-123.guac"));
    }

    #[test]
    fn filename_allows_uuid_format() {
        assert!(is_safe_recording_filename(
            "550e8400-e29b-41d4-a716-446655440000.guac"
        ));
    }

    #[test]
    fn filename_rejects_absolute_path() {
        assert!(!is_safe_recording_filename("/etc/passwd"));
    }

    #[test]
    fn filename_rejects_windows_path() {
        assert!(!is_safe_recording_filename("C:\\Windows\\System32"));
    }
}
