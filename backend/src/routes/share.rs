use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::tunnel::{self, HandshakeParams, NvrContext};
use axum::extract::Extension;

/// Rate limiter for shared tunnel connections (per share_token).
static SHARE_RATE_LIMIT: std::sync::LazyLock<Mutex<HashMap<String, Vec<Instant>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Maximum shared tunnel connections per token per minute.
const MAX_SHARE_ATTEMPTS: usize = 10;
const SHARE_WINDOW_SECS: u64 = 60;
/// Maximum entries in the shared rate limiter to prevent OOM.
const MAX_SHARE_RATE_ENTRIES: usize = 10_000;

/// Default share link expiry: 24 hours.
const DEFAULT_SHARE_EXPIRY_HOURS: i32 = 24;

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

    // Only users with sharing permission can create share links
    if !user.can_manage_system && !user.can_create_sharing_profiles {
        return Err(AppError::Forbidden);
    }

    // Verify user has access to this connection
    let has_access: bool = if user.role == "admin" {
        // Admins can share any connection
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM connections WHERE id = $1 AND soft_deleted_at IS NULL)",
        )
        .bind(connection_id)
        .fetch_one(&db.pool)
        .await?
    } else {
        // Non-admins must have a role assignment to the connection
        sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM connections c
                JOIN role_connections rc ON rc.connection_id = c.id
                JOIN users u ON u.role_id = rc.role_id
                WHERE c.id = $1 AND u.id = $2 AND c.soft_deleted_at IS NULL
            )",
        )
        .bind(connection_id)
        .bind(user.id)
        .fetch_one(&db.pool)
        .await?
    };
    if !has_access {
        return Err(AppError::NotFound("Connection not found".into()));
    }

    // Validate mode
    let mode = match body.mode.as_str() {
        "view" | "control" => body.mode.clone(),
        _ => {
            return Err(AppError::Validation(
                "mode must be 'view' or 'control'".into(),
            ))
        }
    };

    // Generate a unique share token
    let share_token = format!("{}", Uuid::new_v4());

    let read_only = mode == "view";

    // Insert the share record with mandatory expiry
    sqlx::query(
        "INSERT INTO connection_shares (connection_id, owner_user_id, share_token, read_only, mode, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))",
    )
    .bind(connection_id)
    .bind(user.id)
    .bind(&share_token)
    .bind(read_only)
    .bind(&mode)
    .bind(DEFAULT_SHARE_EXPIRY_HOURS)
    .execute(&db.pool)
    .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "connection.shared",
        &serde_json::json!({
            "connection_id": connection_id.to_string(),
            "share_token": &share_token,
            "mode": &mode
        }),
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

    let result = sqlx::query(
        "UPDATE connection_shares SET revoked = true WHERE id = $1 AND owner_user_id = $2 AND NOT revoked",
    )
    .bind(share_id)
    .bind(user.id)
    .execute(&db.pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "Share not found or already revoked".into(),
        ));
    }

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
    // Rate limit shared tunnel connections
    {
        let mut map = SHARE_RATE_LIMIT.lock().unwrap();
        // Prune entire map if too large to prevent OOM
        if map.len() > MAX_SHARE_RATE_ENTRIES {
            map.clear();
        }
        let attempts = map.entry(share_token.clone()).or_default();
        let cutoff = Instant::now() - std::time::Duration::from_secs(SHARE_WINDOW_SECS);
        attempts.retain(|t| *t > cutoff);
        if attempts.len() >= MAX_SHARE_ATTEMPTS {
            return Err(AppError::Auth(
                "Too many connection attempts. Please try again later.".into(),
            ));
        }
        attempts.push(Instant::now());
    }

    let (db, config, guacd_pool) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let db = s.db.clone().ok_or(AppError::SetupRequired)?;
        let cfg = s.config.clone().ok_or(AppError::SetupRequired)?;
        let pool = s.guacd_pool.clone();
        (db, cfg, pool)
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

    let (_share_id, connection_id, owner_user_id, mode) =
        share.ok_or_else(|| AppError::NotFound("Invalid or expired share link".into()))?;

    let read_only = mode == "view";

    // Fetch connection details
    let conn: (String, String, i32, Option<String>, String, serde_json::Value) =
        sqlx::query_as(
            "SELECT protocol, hostname, port, domain, name, extra FROM connections WHERE id = $1 AND soft_deleted_at IS NULL",
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

    // Load the OWNER's credentials (the person who shared).
    // First try the newer credential_profiles system, then fall back to
    // the legacy user_credentials table for backwards compatibility.
    let (cred_username, cred_password) = if let Some(vault_cfg) = &config.vault {
        // Try credential_profiles + credential_mappings first
        let profile_cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
            "SELECT cp.encrypted_password, cp.encrypted_dek, cp.nonce
             FROM credential_mappings cm
             JOIN credential_profiles cp ON cp.id = cm.credential_id
             WHERE cm.connection_id = $1 AND cp.user_id = $2
               AND cp.expires_at > now()",
        )
        .bind(connection_id)
        .bind(owner_user_id)
        .fetch_optional(&db.pool)
        .await?;

        if let Some((enc_payload, enc_dek, nonce)) = profile_cred {
            let plaintext =
                crate::services::vault::unseal(vault_cfg, &enc_dek, &enc_payload, &nonce).await?;
            let plain_str = String::from_utf8(plaintext).unwrap_or_default();
            // Parse combined JSON payload { "u": username, "p": password }
            let parsed: serde_json::Value = serde_json::from_str(&plain_str)
                .unwrap_or_else(|_| serde_json::json!({ "u": "", "p": plain_str }));
            let u = parsed["u"].as_str().unwrap_or("").to_string();
            let p = parsed["p"].as_str().unwrap_or("").to_string();
            (
                if u.is_empty() { None } else { Some(u) },
                if p.is_empty() { None } else { Some(p) },
            )
        } else {
            // Fall back to legacy user_credentials table
            let legacy_cred: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = sqlx::query_as(
                "SELECT encrypted_password, encrypted_dek, nonce
                 FROM user_credentials WHERE user_id = $1 AND connection_id = $2",
            )
            .bind(owner_user_id)
            .bind(connection_id)
            .fetch_optional(&db.pool)
            .await?;

            if let Some((enc_pass, enc_dek, nonce)) = legacy_cred {
                let plaintext =
                    crate::services::vault::unseal(vault_cfg, &enc_dek, &enc_pass, &nonce).await?;
                let pwd = String::from_utf8(plaintext).unwrap_or_default();
                (None, if pwd.is_empty() { None } else { Some(pwd) })
            } else {
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    // Get the owner username for credential fallback
    let owner_username: Option<String> =
        sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
            .bind(owner_user_id)
            .fetch_optional(&db.pool)
            .await?;

    let (final_username, final_password) = match (cred_username, cred_password) {
        (Some(u), Some(p)) => (Some(u), Some(p)),
        (None, Some(p)) => (owner_username.clone(), Some(p)),
        _ => (None, None),
    };

    let guacd_host: String;
    let guacd_port: u16;
    if let Some(ref pool) = guacd_pool {
        let (h, p) = pool.next();
        guacd_host = h.to_string();
        guacd_port = p;
    } else {
        guacd_host = config.guacd_host.unwrap_or_else(|| "guacd".into());
        guacd_port = config.guacd_port.unwrap_or(4822);
    };

    let security = extra.get("security").cloned().or(Some("any".into()));
    let ignore_cert = extra
        .get("ignore-cert")
        .map(|v| v == "true")
        .unwrap_or(false);

    let safe_port: u16 = port
        .try_into()
        .map_err(|_| AppError::Validation("Invalid port number".into()))?;

    let connection_name = _name.clone();

    let mut handshake = HandshakeParams {
        protocol: protocol.clone(),
        hostname,
        port: safe_port,
        username: final_username,
        password: final_password,
        domain,
        security,
        ignore_cert,
        recording_path: None,
        create_recording_path: false,
        width: query.width.unwrap_or(1920).clamp(64, 7680),
        height: query.height.unwrap_or(1080).clamp(64, 4320),
        dpi: query.dpi.unwrap_or(96).clamp(64, 600),
        extra,
    };

    // If read-only, add read-only params
    if read_only {
        handshake.extra.insert("read-only".into(), "true".into());
    }

    // Register shared session in NVR for accountability
    let session_registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };
    let nvr_session_id = format!(
        "shared-{}-{}",
        connection_id,
        chrono::Utc::now().timestamp_millis()
    );
    let nvr_username = format!(
        "shared:{}",
        owner_username.unwrap_or_else(|| "unknown".into())
    );

    Ok(ws
        .protocols(["guacamole"])
        .on_upgrade(move |socket| async move {
            let nvr = NvrContext {
                registry: session_registry,
                session_id: nvr_session_id,
                connection_id,
                connection_name,
                protocol,
                user_id: owner_user_id,
                username: nvr_username,
            };
            if let Err(e) =
                tunnel::proxy(socket, &guacd_host, guacd_port, handshake, Some(nvr)).await
            {
                tracing::error!("Shared tunnel error: {e}");
            }
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── default_share_mode ─────────────────────────────────────────
    #[test]
    fn default_mode_is_view() {
        assert_eq!(default_share_mode(), "view");
    }

    // ── Constants ──────────────────────────────────────────────────
    #[test]
    fn rate_limit_constants() {
        assert_eq!(MAX_SHARE_ATTEMPTS, 10);
        assert_eq!(SHARE_WINDOW_SECS, 60);
        const { assert!(MAX_SHARE_RATE_ENTRIES >= 1000) };
    }

    #[test]
    fn default_expiry_hours() {
        assert_eq!(DEFAULT_SHARE_EXPIRY_HOURS, 24);
    }

    // ── CreateShareRequest deserialization ──────────────────────────
    #[test]
    fn create_share_request_default_mode() {
        let r: CreateShareRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(r.mode, "view");
    }

    #[test]
    fn create_share_request_control_mode() {
        let r: CreateShareRequest = serde_json::from_str(r#"{"mode":"control"}"#).unwrap();
        assert_eq!(r.mode, "control");
    }

    // ── ShareLinkResponse serialization ────────────────────────────
    #[test]
    fn share_link_response_serialization() {
        let resp = ShareLinkResponse {
            share_token: "abc-123".into(),
            share_url: "/shared/abc-123".into(),
            mode: "view".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["share_token"], "abc-123");
        assert_eq!(json["share_url"], "/shared/abc-123");
        assert_eq!(json["mode"], "view");
    }

    // ── SharedTunnelQuery deserialization ───────────────────────────
    #[test]
    fn shared_tunnel_query_defaults() {
        let q: SharedTunnelQuery = serde_json::from_str("{}").unwrap();
        assert!(q.width.is_none());
        assert!(q.height.is_none());
        assert!(q.dpi.is_none());
    }

    #[test]
    fn shared_tunnel_query_with_values() {
        let q: SharedTunnelQuery =
            serde_json::from_str(r#"{"width":1920,"height":1080,"dpi":144}"#).unwrap();
        assert_eq!(q.width.unwrap(), 1920);
        assert_eq!(q.height.unwrap(), 1080);
        assert_eq!(q.dpi.unwrap(), 144);
    }

    #[test]
    fn shared_tunnel_query_partial() {
        let q: SharedTunnelQuery = serde_json::from_str(r#"{"width":2560}"#).unwrap();
        assert_eq!(q.width.unwrap(), 2560);
        assert!(q.height.is_none());
        assert!(q.dpi.is_none());
    }

    #[test]
    fn share_link_response_control_mode() {
        let resp = ShareLinkResponse {
            share_token: "tok-456".into(),
            share_url: "/shared/tok-456?mode=control".into(),
            mode: "control".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["mode"], "control");
        assert!(json["share_url"].as_str().unwrap().contains("mode=control"));
    }

    #[test]
    fn create_share_request_arbitrary_string() {
        let r: CreateShareRequest = serde_json::from_str(r#"{"mode":"other"}"#).unwrap();
        assert_eq!(r.mode, "other");
    }
}
