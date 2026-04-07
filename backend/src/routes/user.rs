use axum::extract::{Path, State, Extension};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::vault;

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
) -> Result<Json<serde_json::Value>, AppError> {
    let _db = require_running(&state).await?;
    Ok(Json(json!({
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "sub": user.sub,
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
    pub group_id: Option<Uuid>,
    pub group_name: Option<String>,
    pub last_accessed: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn my_connections(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<UserConnectionRow>>, AppError> {
    let db = require_running(&state).await?;

    let rows: Vec<UserConnectionRow> = if user.role == "admin" {
        // Admins see all connections regardless of role assignment
        sqlx::query_as(
            "SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                    c.group_id, cg.name AS group_name, c.last_accessed
             FROM connections c
             LEFT JOIN connection_groups cg ON cg.id = c.group_id
             WHERE c.soft_deleted_at IS NULL
             ORDER BY c.name",
        )
        .fetch_all(&db.pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT c.id, c.name, c.protocol, c.hostname, c.port, c.description,
                    c.group_id, cg.name AS group_name, c.last_accessed
             FROM connections c
             JOIN role_connections rc ON rc.connection_id = c.id
             JOIN users u ON u.role_id = rc.role_id
             LEFT JOIN connection_groups cg ON cg.id = c.group_id
             WHERE u.id = $1 AND c.soft_deleted_at IS NULL
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
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT connection_id FROM user_favorites WHERE user_id = $1",
    )
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
        .min(12)
        .max(1);
    let ttl_hours = (body.ttl_hours.unwrap_or(admin_max as i32) as i64).min(admin_max).max(1) as i32;

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

                let plaintext = vault::unseal(&vault_cfg, &existing.1, &existing.0, &existing.2).await?;
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
            .min(12)
            .max(1);
        let ttl_hours = (body.ttl_hours.unwrap_or(admin_max as i32) as i64).min(admin_max).max(1) as i32;

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
            .min(12)
            .max(1);
        let ttl_hours = (body.ttl_hours.unwrap_or(admin_max as i32) as i64).min(admin_max).max(1) as i32;
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

    Ok(Json(json!({ "status": "updated" })))
}

pub async fn delete_credential_profile(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(profile_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    let deleted = sqlx::query(
        "DELETE FROM credential_profiles WHERE id = $1 AND user_id = $2",
    )
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
    let db = require_running(&state).await?;

    // Fetch protocol for this connection
    let protocol: String = sqlx::query_scalar(
        "SELECT protocol FROM connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;

    // Check if a credential profile is mapped to this user+connection
    let has_vault_creds: bool = {
        let s = state.read().await;
        let has_vault = s.config.as_ref().and_then(|c| c.vault.as_ref()).is_some();
        if !has_vault {
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
        }
    };

    Ok(Json(json!({
        "protocol": protocol,
        "has_credentials": has_vault_creds,
    })))
}

// ── Serve a recording file ────────────────────────────────────────────

pub async fn get_recording(
    State(state): State<SharedState>,
    Path(filename): Path<String>,
) -> Result<axum::response::Response, AppError> {
    use axum::body::Body;
    use axum::http::header;
    use tokio::fs::File;
    use tokio_util::io::ReaderStream;

    // Sanitise filename – prevent path traversal
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err(AppError::NotFound("Invalid filename".into()));
    }

    // Try local file first
    let path = format!("/var/lib/guacamole/recordings/{filename}");
    if let Ok(file) = File::open(&path).await {
        let stream = ReaderStream::new(file);
        let body = Body::from_stream(stream);
        return Ok(axum::response::Response::builder()
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\""))
            .body(body)
            .unwrap());
    }

    // Fall back to Azure Blob if configured
    let db = require_running(&state).await?;
    let config = crate::services::recordings::get_config(&db.pool)
        .await
        .map_err(|_| AppError::NotFound("Config error".into()))?;

    if config.storage_type == crate::services::recordings::StorageType::AzureBlob {
        if let Some(azure) = crate::services::recordings::get_azure_config(&db.pool)
            .await
            .map_err(|_| AppError::NotFound("Config error".into()))?
        {
            let data = crate::services::recordings::download_from_azure(&azure, &filename)
                .await
                .map_err(|e| AppError::NotFound(format!("Recording not found: {e}")))?;

            let body = Body::from(data);
            return Ok(axum::response::Response::builder()
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\""))
                .body(body)
                .unwrap());
        }
    }

    Err(AppError::NotFound(format!("Recording not found: {filename}")))
}
