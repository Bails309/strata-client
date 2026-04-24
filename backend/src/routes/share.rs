use axum::extract::{ConnectInfo, Path, State, WebSocketUpgrade};
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

/// Short hash prefix of a share token, suitable for audit logs. Keeps the
/// audit trail correlatable across events without persisting the raw token
/// (which is effectively a bearer credential for the anonymous share path).
fn hash_token_prefix(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let digest = hasher.finalize();
    // 8 hex chars = 32 bits of prefix; collision-resistant enough for audit
    // correlation but reveals nothing about the underlying token.
    format!(
        "{:x}{:x}{:x}{:x}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

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
    let has_access = crate::services::shares::connection_visible_to_user(
        &db.pool,
        connection_id,
        user.id,
        user.can_access_all_connections(),
    )
    .await?;
    if !has_access {
        return Err(AppError::NotFound("Connection not found".into()));
    }

    // Validate mode
    let mode = crate::routes::admin::validate_share_mode(&body.mode)?;

    // Generate a unique share token
    let share_token = format!("{}", Uuid::new_v4());

    let read_only = mode == "view";

    // Insert the share record with mandatory expiry
    crate::services::shares::insert_share(
        &db.pool,
        connection_id,
        user.id,
        &share_token,
        read_only,
        &mode,
        DEFAULT_SHARE_EXPIRY_HOURS,
    )
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

    let revoked = crate::services::shares::revoke_owned(&db.pool, share_id, user.id).await?;

    if !revoked {
        return Err(AppError::NotFound(
            "Share not found or already revoked".into(),
        ));
    }

    Ok(Json(serde_json::json!({ "status": "revoked" })))
}

// ── Join a shared connection (public, no auth required) ──────────────

pub async fn ws_shared_tunnel(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    Path(share_token): Path<String>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    // Acquire DB up front so we can emit audit events on rejection paths.
    let db = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.db.clone().ok_or(AppError::SetupRequired)?
    };

    // Extract client IP once — used in every audit event below.
    let client_ip = crate::routes::auth::try_extract_client_ip(&headers)
        .unwrap_or_else(|| addr.ip().to_string());

    // Rate limit shared tunnel connections.
    //
    // On overflow we *do not* nuke every counter — an attacker spamming unique
    // tokens would otherwise reset legitimate tokens' limits as a side-effect.
    // Instead we first prune counters whose windows have fully expired (cheap,
    // removes the bulk of stale entries), and only if still over the cap drop
    // the handful of oldest still-active entries by their most-recent attempt.
    let rate_limited = {
        let mut map = SHARE_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > MAX_SHARE_RATE_ENTRIES {
            let cutoff = Instant::now() - std::time::Duration::from_secs(SHARE_WINDOW_SECS);
            // Step 1: drop any entry whose newest attempt is outside the window.
            map.retain(|_, attempts| attempts.iter().any(|t| *t > cutoff));
            // Step 2: if still over the cap, evict the oldest remaining entries.
            if map.len() > MAX_SHARE_RATE_ENTRIES {
                let overflow = map.len() - MAX_SHARE_RATE_ENTRIES;
                let mut by_recency: Vec<(String, Instant)> = map
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            v.iter().copied().max().unwrap_or_else(Instant::now),
                        )
                    })
                    .collect();
                by_recency.sort_by_key(|(_, ts)| *ts);
                for (k, _) in by_recency.into_iter().take(overflow) {
                    map.remove(&k);
                }
            }
        }
        let attempts = map.entry(share_token.clone()).or_default();
        let cutoff = Instant::now() - std::time::Duration::from_secs(SHARE_WINDOW_SECS);
        attempts.retain(|t| *t > cutoff);
        if attempts.len() >= MAX_SHARE_ATTEMPTS {
            true
        } else {
            attempts.push(Instant::now());
            false
        }
    };
    if rate_limited {
        // Emit an audit event so operators can see brute-force style probing
        // against shared links. Use the token's short hash prefix to keep the
        // log correlatable without persisting the raw token.
        let _ = crate::services::audit::log(
            &db.pool,
            None,
            "connection.share_rate_limited",
            &serde_json::json!({
                "share_token_prefix": hash_token_prefix(&share_token),
                "client_ip": &client_ip,
            }),
        )
        .await;
        return Err(AppError::Auth(
            "Too many connection attempts. Please try again later.".into(),
        ));
    }

    // Look up the share and verify it's valid
    let share = crate::services::shares::find_active_by_token(&db.pool, &share_token).await?;

    let (_share_id, connection_id, owner_user_id, mode) = match share {
        Some(s) => s,
        None => {
            let _ = crate::services::audit::log(
                &db.pool,
                None,
                "connection.share_invalid_token",
                &serde_json::json!({
                    "share_token_prefix": hash_token_prefix(&share_token),
                    "client_ip": &client_ip,
                }),
            )
            .await;
            return Err(AppError::NotFound("Invalid or expired share link".into()));
        }
    };

    let is_control = mode == "control";

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
                if socket.send(Message::Text(size_inst.into())).await.is_err() {
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
                if !stripped.is_empty()
                    && socket.send(Message::Text(stripped.into())).await.is_err()
                {
                    return;
                }
            }

            // Flush accumulated drawing ops with a single sync
            if let Some(sync) = last_sync_inst.take() {
                if socket.send(Message::Text(sync.into())).await.is_err() {
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
                                if socket.send(Message::Text((*frame).clone().into())).await.is_err() {
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
                                    if !stripped.is_empty()
                                        && socket.send(Message::Text(stripped.into())).await.is_err()
                                    {
                                        send_ok = false;
                                        break;
                                    }
                                }
                                if !send_ok { break; }

                                let ts = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis()
                                    .to_string();
                                let sync = format!("{}.sync,{}.{};", "4", ts.len(), ts);
                                if socket.send(Message::Text(sync.into())).await.is_err() {
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
                            Some(Ok(Message::Text(text)))
                                if is_control
                                // Forward input from control viewer to owner's guacd
                                    && input_tx.send(text.to_string()).await.is_err() =>
                            {
                                break; // owner's session ended
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
                            if socket.send(Message::Text(sync.into())).await.is_err() {
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
        assert_eq!(MAX_SHARE_RATE_ENTRIES, 10_000);
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
    // (Removed: SharedTunnelQuery was dead code with no fields)

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
    // (Removed: SharedTunnelQuery was dead code with no fields)

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
    // (Removed: was a #[cfg(test)] duplicate of tunnel.rs resolve_credentials)
}
