use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::tunnel::{self, HandshakeParams};
use axum::extract::Extension;

// ── Create a share link ──────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateShareRequest {
    /// "view" (default, read-only) or "control" (full input forwarding).
    #[serde(default = "default_share_mode")]
    pub mode: String,
}

fn default_share_mode() -> String {
    "view".into()
}

#[derive(Serialize)]
pub struct ShareLinkResponse {
    pub share_token: String,
    pub share_url: String,
    pub mode: String,
}

pub async fn create_share(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(connection_id): Path<Uuid>,
    Json(body): Json<CreateShareRequest>,
) -> Result<Json<ShareLinkResponse>, AppError> {
    let db = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    // Verify user has access to this connection
    let conn_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM connections WHERE id = $1)",
    )
    .bind(connection_id)
    .fetch_one(&db.pool)
    .await?;
    if !conn_exists {
        return Err(AppError::NotFound("Connection not found".into()));
    }

    // Validate mode
    let mode = match body.mode.as_str() {
        "view" | "control" => body.mode.clone(),
        _ => return Err(AppError::Validation("mode must be 'view' or 'control'".into())),
    };

    // Generate a unique share token
    let share_token = format!("{}", Uuid::new_v4());

    let read_only = mode == "view";

    // Insert the share record
    sqlx::query(
        "INSERT INTO connection_shares (connection_id, owner_user_id, share_token, read_only, mode)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(connection_id)
    .bind(user.id)
    .bind(&share_token)
    .bind(read_only)
    .bind(&mode)
    .execute(&db.pool)
    .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "connection.shared",
        &serde_json::json!({ "connection_id": connection_id.to_string(), "share_token": &share_token, "mode": &mode }),
    )
    .await?;

    Ok(Json(ShareLinkResponse {
        share_url: if mode == "control" {
            format!("/shared/{}?mode=control", share_token)
        } else {
            format!("/shared/{}", share_token)
        },
        share_token,
        mode,
    }))
}

// ── Revoke a share link ──────────────────────────────────────────────

pub async fn revoke_share(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(share_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = {
        let s = state.read().await;
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    sqlx::query(
        "UPDATE connection_shares SET revoked = true WHERE id = $1 AND owner_user_id = $2",
    )
    .bind(share_id)
    .bind(user.id)
    .execute(&db.pool)
    .await?;

    Ok(Json(serde_json::json!({ "status": "revoked" })))
}

// ── Join a shared connection (public, no auth required) ──────────────

#[derive(Deserialize, Default)]
pub struct SharedTunnelQuery {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi: Option<u32>,
}

pub async fn ws_shared_tunnel(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Path(share_token): Path<String>,
    Query(query): Query<SharedTunnelQuery>,
) -> Result<impl IntoResponse, AppError> {
    let (db, config) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let cfg = s.config.clone().ok_or(AppError::SetupRequired)?;
        (db, cfg)
    };

    // Look up the share and verify it's valid
    let share: Option<(Uuid, Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id, connection_id, owner_user_id, mode
         FROM connection_shares
         WHERE share_token = $1
           AND NOT revoked
           AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(&share_token)
    .fetch_optional(&db.pool)
    .await?;

    let (_share_id, connection_id, owner_user_id, mode) = share
        .ok_or_else(|| AppError::NotFound("Invalid or expired share link".into()))?;

    let read_only = mode == "view";

    // Fetch connection details
    let conn: (String, String, i32, Option<String>, String, serde_json::Value) = sqlx::query_as(
        "SELECT protocol, hostname, port, domain, name, extra FROM connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&db.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;

    let (protocol, hostname, port, domain, _name, extra_json) = conn;

    let extra: std::collections::HashMap<String, String> = match &extra_json {
        serde_json::Value::Object(map) => map
            .iter()
            .filter_map(|(k, v)| {
                let val = match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    serde_json::Value::Number(n) => n.to_string(),
                    _ => return None,
                };
                Some((k.clone(), val))
            })
            .collect(),
        _ => std::collections::HashMap::new(),
    };

    // Load the OWNER's credentials (the person who shared)
    let password = if let Some(vault_cfg) = &config.vault {
        let cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
            "SELECT encrypted_password, encrypted_dek, nonce
             FROM user_credentials WHERE user_id = $1 AND connection_id = $2",
        )
        .bind(owner_user_id)
        .bind(connection_id)
        .fetch_optional(&db.pool)
        .await?;

        if let Some((enc_pass, enc_dek, nonce)) = cred {
            let plaintext = crate::services::vault::unseal(vault_cfg, &enc_dek, &enc_pass, &nonce).await?;
            Some(String::from_utf8(plaintext).unwrap_or_default())
        } else {
            None
        }
    } else {
        None
    };

    // Get the owner username for credential fallback
    let owner_username: Option<String> = sqlx::query_scalar(
        "SELECT username FROM users WHERE id = $1",
    )
    .bind(owner_user_id)
    .fetch_optional(&db.pool)
    .await?;

    let (final_username, final_password) = if password.is_some() {
        (owner_username, password)
    } else {
        (None, None)
    };

    let guacd_host = config.guacd_host.unwrap_or_else(|| "guacd".into());
    let guacd_port = config.guacd_port.unwrap_or(4822);

    let security = extra.get("security").cloned().or(Some("any".into()));
    let ignore_cert = extra.get("ignore-cert").map(|v| v == "true").unwrap_or(true);

    let mut handshake = HandshakeParams {
        protocol,
        hostname,
        port: port as u16,
        username: final_username,
        password: final_password,
        domain,
        security,
        ignore_cert,
        recording_path: None,
        create_recording_path: false,
        width: query.width.unwrap_or(1920),
        height: query.height.unwrap_or(1080),
        dpi: query.dpi.unwrap_or(96),
        extra,
    };

    // If read-only, add read-only params
    if read_only {
        handshake.extra.insert("read-only".into(), "true".into());
    }

    Ok(ws.protocols(["guacamole"]).on_upgrade(move |socket| async move {
        if let Err(e) = tunnel::proxy(socket, &guacd_host, guacd_port, handshake, None).await {
            tracing::error!("Shared tunnel error: {e}");
        }
    }))
}
