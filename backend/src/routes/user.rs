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
             WHERE u.id = $1
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

    // Check if Vault-stored credentials exist for this user+connection
    let has_vault_creds: bool = {
        let s = state.read().await;
        let has_vault = s.config.as_ref().and_then(|c| c.vault.as_ref()).is_some();
        if !has_vault {
            false
        } else {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM user_credentials WHERE user_id = $1 AND connection_id = $2)",
            )
            .bind(user.id)
            .bind(connection_id)
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

    let path = format!("/var/lib/guacamole/recordings/{filename}");
    let file = File::open(&path)
        .await
        .map_err(|_| AppError::NotFound(format!("Recording not found: {filename}")))?;

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    Ok(axum::response::Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(body)
        .unwrap())
}
