use axum::extract::{ConnectInfo, Path, Query, State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use axum::extract::Extension;

/// Resolve final username/password from credential lookup + owner fallback.
///
/// If both credential username and password are present, use them both.
/// If only password is found (no stored username), fall back to the
/// owner's username from the users table.  Otherwise return (None, None).
fn resolve_final_credentials(
    cred_username: Option<String>,
    cred_password: Option<String>,
    owner_username: Option<String>,
) -> (Option<String>, Option<String>) {
    match (cred_username, cred_password) {
        (Some(u), Some(p)) => (Some(u), Some(p)),
        (None, Some(p)) => (owner_username, Some(p)),
        _ => (None, None),
    }
}

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
    let mode = crate::routes::admin::validate_share_mode(&body.mode)?;

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
        share_url: crate::routes::admin::build_share_url(&share_token, &mode),
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
    Query(_query): Query<SharedTunnelQuery>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
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

    let db = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.db.clone().ok_or(AppError::SetupRequired)?
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

    let is_control = mode == "control";

    // Extract client IP for audit logging
    let client_ip = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| addr.ip().to_string());

    // Find the owner's active session for this connection
    let registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };

    let session = registry
        .find_by_connection_and_user(connection_id, owner_user_id)
        .await
        .ok_or_else(|| {
            AppError::NotFound(
                "The owner's session is not currently active. They must be connected for you to view their session.".into(),
            )
        })?;

    // Audit log the share access
    crate::services::audit::log(
        &db.pool,
        None,
        "connection.share_accessed",
        &serde_json::json!({
            "connection_id": connection_id.to_string(),
            "share_token": &share_token,
            "client_ip": &client_ip,
        }),
    )
    .await?;

    // Subscribe to the owner's session broadcast and get buffered frames
    let (size_inst, all_frames, mut rx, input_tx) = {
        let buffer = session.buffer.read().await;
        let size = buffer.last_size().map(|s| s.to_string());
        let timed = buffer.frames_with_timing(300); // full 5-minute buffer
        let rx = session.broadcast_tx.subscribe();
        let input_tx = session.input_tx.clone();
        (size, timed, rx, input_tx)
    };

    let buffer_for_recovery = session.buffer.clone();

    Ok(ws
        .protocols(["guacamole"])
        .on_upgrade(move |mut socket| async move {
            use axum::extract::ws::Message;

            // Send the last-known size instruction so the display renders
            // at the correct dimensions
            if let Some(size_inst) = size_inst {
                if socket.send(Message::Text(size_inst)).await.is_err() {
                    return;
                }
            }

            // Dump entire buffer instantly (sync-stripped) to rebuild display
            let mut last_sync_inst: Option<String> = None;
            for (_delay, ref frame) in &all_frames {
                let mut stripped = String::with_capacity(frame.len());
                for inst in frame.split_inclusive(';') {
                    let trimmed = inst.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if trimmed.starts_with("4.sync,") || trimmed == "4.sync" {
                        last_sync_inst = Some(inst.to_string());
                    } else {
                        stripped.push_str(inst);
                    }
                }
                if !stripped.is_empty() {
                    if socket.send(Message::Text(stripped)).await.is_err() {
                        return;
                    }
                }
            }

            // Flush accumulated drawing ops with a single sync
            if let Some(sync) = last_sync_inst.take() {
                if socket.send(Message::Text(sync)).await.is_err() {
                    return;
                }
            }

            // Live phase: forward frames from the broadcast channel
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_frame_at = std::time::Instant::now();

            loop {
                tokio::select! {
                    result = rx.recv() => {
                        match result {
                            Ok(frame) => {
                                last_frame_at = std::time::Instant::now();
                                if socket.send(Message::Text((*frame).clone())).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!("Shared viewer lagged {n} frames — rebuilding display");

                                let buf = buffer_for_recovery.read().await;
                                let rebuild = buf.frames_with_timing(300);
                                drop(buf);

                                let mut send_ok = true;
                                for (_, chunk) in &rebuild {
                                    let mut stripped = String::with_capacity(chunk.len());
                                    for inst in chunk.split_inclusive(';') {
                                        let t = inst.trim();
                                        if !t.is_empty()
                                            && !t.starts_with("4.sync,")
                                            && t != "4.sync"
                                        {
                                            stripped.push_str(inst);
                                        }
                                    }
                                    if !stripped.is_empty() {
                                        if socket.send(Message::Text(stripped)).await.is_err() {
                                            send_ok = false;
                                            break;
                                        }
                                    }
                                }
                                if !send_ok { break; }

                                let ts = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis()
                                    .to_string();
                                let sync = format!("{}.sync,{}.{};", "4", ts.len(), ts);
                                if socket.send(Message::Text(sync)).await.is_err() {
                                    break;
                                }
                                last_frame_at = std::time::Instant::now();
                            }
                            Err(_) => break, // channel closed (owner's session ended)
                        }
                    }
                    msg = socket.recv() => {
                        match msg {
                            None => break, // client disconnected
                            Some(Ok(Message::Text(text))) if is_control => {
                                // Forward input from control viewer to owner's guacd
                                if input_tx.send(text).await.is_err() {
                                    break; // owner's session ended
                                }
                            }
                            _ => {} // discard in view mode or for non-text messages
                        }
                    }
                    _ = keepalive.tick() => {
                        if socket.send(Message::Text("3.nop;".into())).await.is_err() {
                            break;
                        }
                        if last_frame_at.elapsed() > std::time::Duration::from_secs(5) {
                            let ts = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis()
                                .to_string();
                            let sync = format!("{}.sync,{}.{};", "4", ts.len(), ts);
                            if socket.send(Message::Text(sync)).await.is_err() {
                                break;
                            }
                        }
                    }
                }
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

    // ── Share link URL construction ────────────────────────────────

    #[test]
    fn share_link_response_view_url_format() {
        let token = "abc-123";
        let url = format!("/shared/{}", token);
        assert!(!url.contains("mode="));
        assert_eq!(url, "/shared/abc-123");
    }

    #[test]
    fn share_link_response_control_url_format() {
        let token = "abc-123";
        let url = format!("/shared/{}?mode=control", token);
        assert!(url.contains("mode=control"));
    }

    // ── Rate limit constants ───────────────────────────────────────

    #[test]
    fn share_rate_limit_constants_consistent() {
        const { assert!(MAX_SHARE_ATTEMPTS > 0) };
        const { assert!(SHARE_WINDOW_SECS > 0) };
        const { assert!(MAX_SHARE_RATE_ENTRIES > MAX_SHARE_ATTEMPTS) };
    }

    #[test]
    fn default_share_expiry_is_positive() {
        const { assert!(DEFAULT_SHARE_EXPIRY_HOURS > 0) };
    }

    // ── SharedTunnelQuery edge cases ───────────────────────────────

    #[test]
    fn shared_tunnel_query_all_zeros() {
        let q: SharedTunnelQuery =
            serde_json::from_str(r#"{"width":0,"height":0,"dpi":0}"#).unwrap();
        assert_eq!(q.width.unwrap(), 0);
        assert_eq!(q.height.unwrap(), 0);
        assert_eq!(q.dpi.unwrap(), 0);
    }

    #[test]
    fn shared_tunnel_query_large_values() {
        let q: SharedTunnelQuery =
            serde_json::from_str(r#"{"width":7680,"height":4320,"dpi":600}"#).unwrap();
        assert_eq!(q.width.unwrap(), 7680);
        assert_eq!(q.height.unwrap(), 4320);
        assert_eq!(q.dpi.unwrap(), 600);
    }

    // ── ShareLinkResponse field access ─────────────────────────────

    #[test]
    fn share_link_response_fields_accessible() {
        let resp = ShareLinkResponse {
            share_token: "tok".into(),
            share_url: "/shared/tok".into(),
            mode: "view".into(),
        };
        assert_eq!(resp.share_token, "tok");
        assert_eq!(resp.share_url, "/shared/tok");
        assert_eq!(resp.mode, "view");
    }

    // ── resolve_final_credentials ──────────────────────────────────

    #[test]
    fn resolve_creds_both_present() {
        let (u, p) = resolve_final_credentials(
            Some("admin".into()),
            Some("pass".into()),
            Some("owner".into()),
        );
        assert_eq!(u.as_deref(), Some("admin"));
        assert_eq!(p.as_deref(), Some("pass"));
    }

    #[test]
    fn resolve_creds_username_none_falls_back_to_owner() {
        let (u, p) = resolve_final_credentials(None, Some("pass".into()), Some("owner".into()));
        assert_eq!(u.as_deref(), Some("owner"));
        assert_eq!(p.as_deref(), Some("pass"));
    }

    #[test]
    fn resolve_creds_username_none_owner_none() {
        let (u, p) = resolve_final_credentials(None, Some("pass".into()), None);
        assert!(u.is_none());
        assert_eq!(p.as_deref(), Some("pass"));
    }

    #[test]
    fn resolve_creds_both_none() {
        let (u, p) = resolve_final_credentials(None, None, Some("owner".into()));
        assert!(u.is_none());
        assert!(p.is_none());
    }

    #[test]
    fn resolve_creds_password_none() {
        let (u, p) = resolve_final_credentials(Some("admin".into()), None, Some("owner".into()));
        assert!(u.is_none());
        assert!(p.is_none());
    }

    #[test]
    fn resolve_creds_all_none() {
        let (u, p) = resolve_final_credentials(None, None, None);
        assert!(u.is_none());
        assert!(p.is_none());
    }
}
