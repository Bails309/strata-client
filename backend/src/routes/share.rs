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
    /// Multiplayer / co-pilot toggle (v1.9.6+). When `true`, the share
    /// link admits up to [`MAX_MULTIPLAYER_PARTICIPANTS`] simultaneous
    /// participants who can each be granted the input token in turn.
    #[serde(default)]
    pub multiplayer: bool,
    /// Server-clamped to `1..=` [`MAX_MULTIPLAYER_PARTICIPANTS`]. Only
    /// honoured when `multiplayer = true`.
    #[serde(default = "default_max_participants")]
    pub max_participants: i16,
    /// Whether the co-pilot room exposes a chat channel.
    #[serde(default = "default_true")]
    pub allow_chat: bool,
    /// Whether the co-pilot room signals an optional WebRTC audio mesh.
    /// No server-side TURN is provisioned; opt-in mesh only.
    #[serde(default)]
    pub allow_audio: bool,
}

fn default_share_mode() -> String {
    "view".into()
}

fn default_max_participants() -> i16 {
    2
}

fn default_true() -> bool {
    true
}

/// Hard server-side cap on participants per multiplayer room. Matches
/// `co_pilot::MAX_PARTICIPANTS` and the DB-level CHECK in migration 066.
pub const MAX_MULTIPLAYER_PARTICIPANTS: i16 = 6;

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

    // Multiplayer is only meaningful with `control` mode — there's no
    // point in a multi-cursor read-only viewer. Reject the combination
    // up-front so the wire contract stays simple.
    let multiplayer = body.multiplayer && mode == "control";
    let max_participants = if multiplayer {
        body.max_participants.clamp(1, MAX_MULTIPLAYER_PARTICIPANTS)
    } else {
        1
    };
    let allow_chat = body.allow_chat && multiplayer;
    let allow_audio = body.allow_audio && multiplayer;

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
        multiplayer,
        max_participants,
        allow_chat,
        allow_audio,
    )
    .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "connection.shared",
        &serde_json::json!({
            "connection_id": connection_id.to_string(),
            "share_token": &share_token,
            "mode": &mode,
            "multiplayer": multiplayer,
            "max_participants": max_participants,
            "allow_chat": allow_chat,
            "allow_audio": allow_audio,
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

    // Best-effort audit entry; do not fail the user request if audit insert
    // fails (audit::log already logs on its own errors).
    let _ = crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "connection.share_revoked",
        &serde_json::json!({ "share_id": share_id.to_string() }),
    )
    .await;

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

    let share = match share {
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
    let connection_id = share.connection_id;
    let owner_user_id = share.owner_user_id;
    let mode = share.mode.clone();

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
    let (size_inst, persistent_state, all_frames, mut rx, input_tx) = {
        let buffer = session.buffer.read().await;
        let size = buffer.last_size().map(|s| s.to_string());
        let persistent = buffer.persistent_state();
        let timed = buffer.frames_with_timing(300); // full 5-minute buffer
        let rx = session.broadcast_tx.subscribe();
        let input_tx = session.input_tx.clone();
        (size, persistent, timed, rx, input_tx)
    };

    let buffer_for_recovery = session.buffer.clone();
    // Captures for the revocation re-check that runs inside the
    // viewer loop. Without these, the WebSocket would stay open
    // indefinitely once joined — admins clicking "revoke" only
    // stopped *new* viewers from connecting, never the ones already
    // mid-session.
    let revoke_pool = db.pool.clone();
    let revoke_token = share_token.clone();

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

            // Replay the persistent-state log (drawing instructions
            // salvaged from frames already evicted from the ring buffer)
            // so observers joining a session that has been running
            // longer than the buffer window see reconstructed screen
            // content rather than a black canvas.
            if !persistent_state.is_empty()
                && socket
                    .send(Message::Text(persistent_state.into()))
                    .await
                    .is_err()
            {
                return;
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
            // Re-check share validity at most once per `revoke_check_every`
            // keepalive ticks. With ticks at 5s and N=6 that lands on a
            // ~30s revocation latency — fast enough to bound damage,
            // slow enough to keep the per-viewer DB load to ~2 queries
            // per minute. The first check fires immediately after the
            // first tick (not at startup) because the join-time check
            // already ran.
            let revoke_check_every: u32 = 6;
            let mut ticks_since_check: u32 = 0;

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
                                let rebuild_persistent = buf.persistent_state();
                                let rebuild = buf.frames_with_timing(300);
                                drop(buf);

                                let mut send_ok = true;

                                // Re-send persistent state first so any
                                // long-evicted layer / image setup is
                                // present before the recent frame dump.
                                if !rebuild_persistent.is_empty()
                                    && socket
                                        .send(Message::Text(rebuild_persistent.into()))
                                        .await
                                        .is_err()
                                {
                                    break;
                                }

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
                        ticks_since_check += 1;
                        if ticks_since_check >= revoke_check_every {
                            ticks_since_check = 0;
                            // If the share row has been revoked
                            // (deleted/expired) OR the underlying
                            // connection has been soft-deleted,
                            // `find_active_by_token` returns None.
                            // We treat a transient DB error as "keep
                            // serving" — a network blip should not
                            // boot every active viewer — but log it.
                            match crate::services::shares::find_active_by_token(
                                &revoke_pool,
                                &revoke_token,
                            )
                            .await
                            {
                                Ok(Some(_)) => {}
                                Ok(None) => {
                                    tracing::info!(
                                        token_prefix = %hash_token_prefix(&revoke_token),
                                        "shared viewer kicked: share no longer active"
                                    );
                                    let _ = socket
                                        .send(Message::Text(
                                            "0.10.disconnect;".into(),
                                        ))
                                        .await;
                                    break;
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        error = %e,
                                        "share revocation re-check failed; keeping viewer connected"
                                    );
                                }
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

    // ── Multiplayer extension defaults (v1.9.6+) ──────────────────

    #[test]
    fn create_share_request_multiplayer_defaults_off() {
        let r: CreateShareRequest = serde_json::from_str("{}").unwrap();
        assert!(!r.multiplayer);
        assert_eq!(r.max_participants, default_max_participants());
        assert!(r.allow_chat);
        assert!(!r.allow_audio);
    }

    #[test]
    fn create_share_request_multiplayer_payload() {
        let r: CreateShareRequest = serde_json::from_str(
            r#"{"mode":"control","multiplayer":true,"max_participants":4,"allow_chat":true,"allow_audio":true}"#,
        )
        .unwrap();
        assert!(r.multiplayer);
        assert_eq!(r.max_participants, 4);
        assert!(r.allow_chat);
        assert!(r.allow_audio);
    }

    #[test]
    fn max_multiplayer_participants_matches_protocol_constant() {
        // Wire-level cap must match `co_pilot::MAX_PARTICIPANTS` so the
        // DB-clamp, route-clamp, and in-memory room cap stay in lock-step.
        assert_eq!(
            MAX_MULTIPLAYER_PARTICIPANTS as u8,
            crate::services::co_pilot::MAX_PARTICIPANTS
        );
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
