use axum::extract::{Extension, Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::AuthUser;
use crate::services::{settings, vault};

/// Resolve TTL for a credential profile, picking the effective upper
/// bound based on whether the profile opts in to extended expiry.
/// Falls back to `admin_max` (i.e. the existing 12 h cap) when not extended.
pub fn resolve_profile_ttl(user_pref: Option<i32>, admin_max: i64, extended: bool) -> i32 {
    let cap = crate::services::credential_profiles::effective_ttl_max(admin_max, extended);
    let default = if extended {
        cap as i32
    } else {
        admin_max as i32
    };
    (user_pref.unwrap_or(default) as i64).clamp(1, cap) as i32
}

/// Validate a hex color string (e.g. "#ff00aa" or "#abc").
pub fn is_valid_hex_color(s: &str) -> bool {
    let s = s.as_bytes();
    matches!(s.len(), 4 | 7) && s[0] == b'#' && s[1..].iter().all(|b| b.is_ascii_hexdigit())
}

/// Parse the `ignore-cert` field from a connection's `extra` JSON.
/// Returns `true` when the field is a boolean `true` or the string `"true"`.
pub fn parse_ignore_cert(extra: &Option<serde_json::Value>) -> bool {
    extra
        .as_ref()
        .and_then(|e| e.get("ignore-cert"))
        .map(|v| match v {
            serde_json::Value::String(s) => s == "true",
            serde_json::Value::Bool(b) => *b,
            _ => false,
        })
        .unwrap_or(false)
}

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
    let client_ip = crate::routes::auth::extract_client_ip(&headers);
    let watermark_enabled = settings::get(&db.pool, "watermark_enabled")
        .await
        .unwrap_or(None)
        .unwrap_or_default();

    let vault_configured = {
        let s = state.read().await;
        s.config.as_ref().and_then(|c| c.vault.as_ref()).is_some()
    };

    // Check whether the user has accepted the terms / disclaimer
    let (terms_accepted_at, terms_accepted_version) =
        crate::services::users::terms_status(&db.pool, user.id).await?;

    // Check whether the user has any approval roles assigned
    let is_approver = crate::services::users::is_approver(&db.pool, user.id)
        .await
        .unwrap_or(false);

    // Designated outbound-share approver? Super-admins are implicit
    // approvers (they bypass the gate in routes/outbound_shares.rs::
    // require_approver), so true for either condition.
    let is_outbound_approver = user.can_manage_system
        || crate::services::outbound_shares::is_outbound_approver(&db.pool, user.id)
            .await
            .unwrap_or(false);

    // Per-user outbound Quick-Share approval-bypass flag. `false`
    // means "this user is exempt from the approval queue"; `true` or
    // NULL means "this user must wait for an approver (and must
    // provide a justification on submit)". Surfaced so the SPA can
    // mark the Quick-Share Outbound justification field as required
    // and disable submit until it's filled — the chokepoint stays in
    // routes/outbound_shares.rs::validate_outbound_justification.
    let outbound_share_requires_approval: Option<bool> =
        sqlx::query_scalar("SELECT outbound_share_requires_approval FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_optional(&db.pool)
            .await
            .unwrap_or(None)
            .flatten();

    Ok(Json(json!({
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role,
        "sub": user.sub,
        "client_ip": client_ip,
        "watermark_enabled": watermark_enabled == "true",
        "vault_configured": vault_configured,
        "terms_accepted_at": terms_accepted_at,
        "terms_accepted_version": terms_accepted_version,
        "can_manage_system": user.can_manage_system,
        "can_manage_users": user.can_manage_users,
        "can_manage_connections": user.can_manage_connections,
        "can_view_audit_logs": user.can_view_audit_logs,
        "can_create_users": user.can_create_users,
        "can_create_user_groups": user.can_create_user_groups,
        "can_create_connections": user.can_create_connections,
        "can_use_quick_share": user.can_use_quick_share,
        "can_use_quick_share_outbound": user.can_use_quick_share_outbound,
        "can_create_sharing_profiles": user.can_create_sharing_profiles,
        "can_view_sessions": user.can_view_sessions,
        "is_approver": is_approver,
        "is_outbound_approver": is_outbound_approver,
        "outbound_share_requires_approval": outbound_share_requires_approval,
    })))
}

/// Accept the recording disclaimer / terms of service.
pub async fn accept_terms(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let version = body.get("version").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
    if !(1..=1000).contains(&version) {
        return Err(AppError::Validation("Invalid terms version".into()));
    }
    crate::services::users::accept_terms(&db.pool, user.id, version).await?;
    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "user.terms_accepted",
        &json!({ "version": version }),
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

// ── User's connections ─────────────────────────────────────────────────

pub use crate::services::connections::UserConnectionRow;

pub async fn my_connections(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<UserConnectionRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows = crate::services::connections::list_for_user(
        &db.pool,
        user.id,
        user.can_access_all_connections(),
    )
    .await?;
    Ok(Json(rows))
}

/// Flat list of all connection folders (id, name, parent_id) so the
/// frontend can render the nested folder tree on Dashboard. Folder names
/// are not sensitive — admin-only mutations stay on `/api/admin/...`.
pub async fn my_connection_folders(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<crate::services::connections::ConnectionFolderRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows = crate::services::connections::list_folders_for_user(
        &db.pool,
        user.id,
        user.can_access_all_connections(),
    )
    .await?;
    Ok(Json(rows))
}

// ── Favorites ─────────────────────────────────────────────────────────

use crate::services::favorites;

pub async fn list_favorites(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<Uuid>>, AppError> {
    let db = require_running(&state).await?;
    let ids = favorites::list(&db.pool, user.id).await?;
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
    let favorited = favorites::toggle(&db.pool, user.id, body.connection_id).await?;
    Ok(Json(json!({ "favorited": favorited })))
}

// ── User Tags ─────────────────────────────────────────────────────────

use crate::services::user_tags as tags_svc;
pub use crate::services::user_tags::{
    CreateTagRequest, SetConnectionTagsRequest, SetDisplayTagRequest, UpdateTagRequest, UserTag,
};

/// List all tags owned by the current user.
pub async fn list_tags(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<UserTag>>, AppError> {
    let db = require_running(&state).await?;
    let tags = tags_svc::list_for_user(&db.pool, user.id).await?;
    Ok(Json(tags))
}

/// Create a new tag for the current user.
pub async fn create_tag(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateTagRequest>,
) -> Result<Json<UserTag>, AppError> {
    let db = require_running(&state).await?;
    let name = body.name.trim().to_string();
    if name.is_empty() || name.len() > 50 {
        return Err(AppError::Validation(
            "Tag name must be 1-50 characters".into(),
        ));
    }
    let color = body.color.unwrap_or_else(|| "#6366f1".to_string());
    if !is_valid_hex_color(&color) {
        return Err(AppError::Validation(
            "Color must be a valid hex color (e.g. #ff00aa)".into(),
        ));
    }
    let tag = tags_svc::create(&db.pool, user.id, &name, &color).await?;
    Ok(Json(tag))
}

/// Update an existing tag (name and/or color).
pub async fn update_tag(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(tag_id): Path<Uuid>,
    Json(body): Json<UpdateTagRequest>,
) -> Result<Json<UserTag>, AppError> {
    let db = require_running(&state).await?;
    if let Some(ref n) = body.name {
        let n = n.trim();
        if n.is_empty() || n.len() > 50 {
            return Err(AppError::Validation(
                "Tag name must be 1-50 characters".into(),
            ));
        }
    }
    if let Some(ref c) = body.color {
        if !is_valid_hex_color(c) {
            return Err(AppError::Validation(
                "Color must be a valid hex color (e.g. #ff00aa)".into(),
            ));
        }
    }
    let name_trimmed = body.name.as_deref().map(|s| s.trim());
    let tag = tags_svc::update(
        &db.pool,
        tag_id,
        user.id,
        name_trimmed,
        body.color.as_deref(),
    )
    .await?
    .ok_or_else(|| AppError::NotFound("Tag not found".into()))?;
    Ok(Json(tag))
}

/// Delete a tag (cascades to connection_tags).
pub async fn delete_tag(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(tag_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    if !tags_svc::delete(&db.pool, tag_id, user.id).await? {
        return Err(AppError::NotFound("Tag not found".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

/// List all connection→tag mappings for the current user.
/// Returns { connection_id: [tag_id, ...] }.
pub async fn list_connection_tags(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let rows = tags_svc::list_connection_tags(&db.pool, user.id).await?;

    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for r in rows {
        map.entry(r.connection_id.to_string())
            .or_default()
            .push(r.tag_id.to_string());
    }
    Ok(Json(json!(map)))
}

/// Replace all tags on a connection for the current user.
pub async fn set_connection_tags(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SetConnectionTagsRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    // Authorisation: a user must have role-based access (direct or via
    // folder) to the connection before they can mutate its tag set.
    // Operators with `can_manage_system` / `can_manage_connections`
    // bypass the check. Without this, any logged-in user could mutate
    // tags on any connection by guessing the UUID (IDOR).
    if !user.can_access_all_connections()
        && !crate::services::connections::user_has_role_access(
            &db.pool,
            user.id,
            body.connection_id,
        )
        .await?
    {
        return Err(AppError::Forbidden);
    }
    tags_svc::set_connection_tags(&db.pool, user.id, body.connection_id, &body.tag_ids).await?;
    Ok(Json(json!({ "ok": true })))
}

// ── Display Tags (pinned tag per connection for session sidebar) ───────

/// Return all display-tag mappings for the current user.
/// Response: { connection_id: { id, name, color } }
pub async fn list_display_tags(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let rows = tags_svc::list_display_tags(&db.pool, user.id).await?;

    let mut map = serde_json::Map::new();
    for r in rows {
        map.insert(
            r.connection_id.to_string(),
            json!({ "id": r.id, "name": r.name, "color": r.color }),
        );
    }
    Ok(Json(serde_json::Value::Object(map)))
}

/// Set or replace the display tag for a connection (one per connection per user).
pub async fn set_display_tag(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SetDisplayTagRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    if !tags_svc::user_owns_tag(&db.pool, body.tag_id, user.id).await? {
        return Err(AppError::NotFound("Tag not found".into()));
    }

    tags_svc::upsert_display_tag(&db.pool, user.id, body.connection_id, body.tag_id).await?;

    Ok(Json(json!({ "ok": true })))
}

/// Remove the display tag for a connection.
pub async fn remove_display_tag(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(connection_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    tags_svc::remove_display_tag(&db.pool, user.id, connection_id).await?;
    Ok(Json(json!({ "ok": true })))
}

// ── Display settings (public for authenticated users) ─────────────────

/// Return only the display-related settings any user needs (timezone, time/date format).
pub async fn get_display_settings(
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let keys = [
        "display_timezone",
        "display_time_format",
        "display_date_format",
    ];
    let mut map = serde_json::Map::new();
    for key in &keys {
        if let Some(val) = settings::get(&db.pool, key).await? {
            map.insert(key.to_string(), serde_json::Value::String(val));
        }
    }
    Ok(Json(serde_json::Value::Object(map)))
}

// ── Admin tags (read-only for regular users) ──────────────────────────

/// List all admin-managed global tags (visible to every user).
pub async fn list_admin_tags(
    State(state): State<SharedState>,
) -> Result<Json<Vec<UserTag>>, AppError> {
    let db = require_running(&state).await?;
    let tags = tags_svc::list_admin_tags(&db.pool).await?;
    Ok(Json(tags))
}

/// Returns { connection_id: [tag_id, ...] } for admin-assigned tags.
pub async fn list_admin_connection_tags(
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let rows = crate::services::admin_tags::list_all_connection_tag_pairs(&db.pool).await?;

    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (conn_id, tag_id) in rows {
        map.entry(conn_id.to_string())
            .or_default()
            .push(tag_id.to_string());
    }
    Ok(Json(json!(map)))
}

// ── User preferences ──────────────────────────────────────────────────

/// Return the current user's UI preferences object (or `{}` if unset).
pub async fn get_preferences(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let prefs = crate::services::user_preferences::get(&db.pool, user.id).await?;
    Ok(Json(prefs))
}

/// Replace the current user's UI preferences object.
pub async fn update_preferences(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    crate::services::user_preferences::set(&db.pool, user.id, &body).await?;
    Ok(Json(body))
}

// ── Command palette execution audit ───────────────────────────────────

/// Body for `POST /api/user/command-audit` — records an executed Ctrl+K
/// command for the current user. The frontend posts this fire-and-forget
/// after the command runs; the backend is the source of truth for actor
/// identity and timestamp.
#[derive(Deserialize)]
pub struct CommandAuditRequest {
    /// e.g. `":reload"` or `":jump"`. Must be 1–64 chars after trimming
    /// the leading colon, and match the same trigger character class as
    /// stored mappings.
    pub trigger: String,
    /// The action that ran. For built-ins this is the built-in command
    /// name (`"reload"`, `"disconnect"`, `"fullscreen"`, `"commands"`);
    /// for user-defined mappings it's one of the action enum values
    /// (`"open-connection"`, `"open-folder"`, `"open-tag"`, `"open-page"`,
    /// `"paste-text"`).
    pub action: String,
    /// Action-specific arguments, opaque to this endpoint.
    #[serde(default)]
    pub args: serde_json::Value,
    /// Optional resolved target id — connection / folder / tag / session
    /// id where applicable. Stored for cross-referencing in the audit
    /// view; not validated server-side beyond UUID parseability.
    #[serde(default)]
    pub target_id: Option<Uuid>,
}

const ALLOWED_AUDIT_ACTIONS: &[&str] = &[
    "reload",
    "disconnect",
    "fullscreen",
    "commands",
    "close",
    "explorer",
    "open-connection",
    "open-folder",
    "open-tag",
    "open-page",
    "paste-text",
    "open-path",
];

fn is_valid_audit_trigger(s: &str) -> bool {
    let core = s.strip_prefix(':').unwrap_or(s);
    if core.is_empty() || core.len() > 64 {
        return false;
    }
    core.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// `POST /api/user/command-audit` — record one executed command.
pub async fn post_command_audit(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CommandAuditRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Light validation — keep noise out of the audit chain. Anything
    // coming from a tampered client will be rejected at the door rather
    // than recorded with junk fields.
    if !is_valid_audit_trigger(&body.trigger) {
        return Err(AppError::Validation(
            "trigger must match :?[a-z0-9_-]{1,64}".into(),
        ));
    }
    if !ALLOWED_AUDIT_ACTIONS.contains(&body.action.as_str()) {
        return Err(AppError::Validation(format!(
            "action '{}' not in allow-list",
            body.action
        )));
    }

    let details = json!({
        "trigger": body.trigger,
        "action": body.action,
        "args": body.args,
        "target_id": body.target_id,
    });
    crate::services::audit::log(&db.pool, Some(user.id), "command.executed", &details)
        .await
        .map_err(|e| AppError::Internal(format!("command audit: {e}")))?;

    Ok(Json(json!({ "ok": true })))
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

    crate::services::user_credentials::upsert(&db.pool, user.id, body.connection_id, &sealed)
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
    crate::services::user_credentials::revoke_user_shares(&db.pool, user.id, body.connection_id)
        .await?;

    Ok(Json(json!({ "status": "credential_saved" })))
}

// ── Credential Profiles (envelope-encrypted username+password) ────────

use crate::services::credential_profiles as cp_svc;
pub use crate::services::credential_profiles::{CredentialProfileRow, MappingRow};

#[derive(Deserialize)]
pub struct CreateCredentialProfileRequest {
    pub label: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    pub ttl_hours: Option<i32>,
    #[serde(default)]
    pub extended_expiry: Option<bool>,
    /// 'local' (default) or 'safeguard'. When `safeguard`, the
    /// `username`/`password` fields are ignored and
    /// `safeguard_account_id` + `safeguard_asset` are required.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub safeguard_account_id: Option<String>,
    #[serde(default)]
    pub safeguard_asset: Option<String>,
}

pub async fn list_credential_profiles(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<CredentialProfileRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows = cp_svc::list_for_user(&db.pool, user.id).await?;
    Ok(Json(rows))
}

/// `GET /api/user/safeguard/enabled` — minimal capability probe so the
/// credential editor can show or hide the Safeguard JIT option without
/// granting non-admin users read access to the full appliance config.
pub async fn safeguard_enabled(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    // AND the global kill switch with the per-user opt-in so the
    // credential editor only offers Safeguard JIT to onboarded users.
    let enabled = crate::services::safeguard::user_jit_enabled(&db.pool, user.id).await;
    Ok(Json(serde_json::json!({ "enabled": enabled })))
}

/// `GET /api/user/safeguard/status` — does the current user have a
/// live Safeguard API token on file? Used by the credential editor to
/// show a "Sign in to Safeguard" prompt when needed.
///
/// In addition to the cheap DB-only check, this endpoint will probe
/// the appliance with the cached token to verify it is still
/// accepted. If Safeguard returns 401/403 we proactively clear the
/// row and report `signed_in = false`, so users that had their
/// Safeguard token revoked (or whose `expires_at` we recorded
/// optimistically) don't keep appearing as signed in.
pub async fn safeguard_token_status(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let mut status = crate::services::safeguard::user_token::status(&db.pool, user.id).await?;
    let cfg = crate::services::safeguard::config::load(&db.pool).await?;

    // When the DB row claims we are signed in, verify with the
    // appliance. A definitive Invalid response retires the row;
    // a Transient error is ignored so an appliance blip doesn't
    // sign the user out.
    if status.signed_in && cfg.enabled {
        let vault_cfg = {
            let s = state.read().await;
            s.config.as_ref().and_then(|c| c.vault.clone())
        };
        if let Some(vault_cfg) = vault_cfg {
            if let Some(token) =
                crate::services::safeguard::user_token::load(&db.pool, &vault_cfg, user.id).await?
            {
                use crate::services::safeguard::client;
                let secrets =
                    crate::services::safeguard::config::load_secrets(&db.pool, &vault_cfg).await?;
                let identity = client::a2a_identity(&secrets)?;
                let http = client::build_client(&cfg, identity)?;
                let base = client::base_url(&cfg);
                match client::verify_token(&http, &base, &token).await {
                    client::TokenProbe::Valid => { /* keep status */ }
                    client::TokenProbe::Invalid { status: code } => {
                        tracing::info!(
                            user_id = %user.id,
                            http_status = code,
                            "Safeguard rejected cached user token — clearing"
                        );
                        let _ =
                            crate::services::safeguard::user_token::clear(&db.pool, user.id).await;
                        status = crate::services::safeguard::user_token::TokenStatus {
                            signed_in: false,
                            expires_at: None,
                        };
                    }
                    client::TokenProbe::Transient { error } => {
                        tracing::warn!(
                            user_id = %user.id,
                            %error,
                            "Safeguard /Me probe failed transiently — keeping cached token"
                        );
                    }
                }
            }
        }
    }

    Ok(Json(serde_json::json!({
        "signed_in": status.signed_in,
        "expires_at": status.expires_at,
        "appliance_fqdn": cfg.appliance_fqdn,
        "idp_alias": cfg.idp_alias,
        "auth_mode": cfg.auth_mode.as_str(),
        "enabled": cfg.enabled,
        "password_cache_enabled": cfg.password_cache_enabled,
    })))
}

#[derive(Deserialize)]
pub struct SubmitSafeguardTokenBody {
    /// The Safeguard API access token from `Connect-Safeguard`'s
    /// `$SGToken` (already RSTS-exchanged by the PS module — usable
    /// as a bearer against /service/core).
    pub api_token: String,
    /// Optional override of the token's lifetime in seconds. Safeguard
    /// tokens are 15-minute lived by default; we cap at 24h so a
    /// fat-fingered value can't pin a stale token forever.
    #[serde(default)]
    pub expires_in_seconds: Option<i64>,
}

/// `POST /api/user/safeguard/token` — accept the API token a user
/// obtained from `Connect-Safeguard -Browser` and Vault-seal it for
/// future JIT checkouts.
///
/// Before storing the token we probe `/service/core/v4/Me` with it.
/// An already-expired or revoked token is rejected up-front so the
/// UI never reports a phantom "signed in" state. The cached
/// `expires_at` prefers the JWT `exp` claim over the
/// `expires_in_seconds` hint so the UI shows the real lifetime.
pub async fn submit_safeguard_token(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SubmitSafeguardTokenBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    let token = body.api_token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::Validation("api_token is required".into()));
    }

    // Live-probe the supplied token against the appliance so we
    // never store something that is already invalid. Any decisive
    // rejection (401/403) returns a clean validation error; transient
    // failures (network, 5xx) are also surfaced rather than silently
    // accepted, since the user pasted this token specifically to use
    // it and would be misled by a green "signed in" badge.
    let cfg = crate::services::safeguard::config::load(&db.pool).await?;
    {
        use crate::services::safeguard::client;
        let secrets =
            crate::services::safeguard::config::load_secrets(&db.pool, &vault_cfg).await?;
        let identity = client::a2a_identity(&secrets)?;
        let http = client::build_client(&cfg, identity)?;
        let base = client::base_url(&cfg);
        match client::verify_token(&http, &base, &token).await {
            client::TokenProbe::Valid => {}
            client::TokenProbe::Invalid { status } => {
                return Err(AppError::Validation(format!(
                    "Safeguard rejected the supplied token (HTTP {status}). It is expired, revoked, or was issued for a different appliance — please obtain a fresh token via Connect-Safeguard."
                )));
            }
            client::TokenProbe::Transient { error } => {
                return Err(AppError::Internal(format!(
                    "Could not verify the Safeguard token: {error}"
                )));
            }
        }
    }

    // 15 min default matches the appliance; 24h cap is a sanity
    // guard. Prefer the JWT's own `exp` claim when present so the
    // cache row reflects the appliance's real lifetime, not the
    // caller's hint.
    let ttl_hint = body
        .expires_in_seconds
        .unwrap_or(15 * 60)
        .clamp(60, 24 * 60 * 60);
    let fallback = chrono::Utc::now() + chrono::Duration::seconds(ttl_hint);
    let expires_at = match crate::services::safeguard::user_token::jwt_exp(&token) {
        Some(exp) => {
            let max = chrono::Utc::now() + chrono::Duration::hours(24);
            let min = chrono::Utc::now() + chrono::Duration::seconds(60);
            exp.min(max).max(min)
        }
        None => fallback,
    };

    crate::services::safeguard::user_token::store(
        &db.pool, &vault_cfg, user.id, &token, expires_at,
    )
    .await?;

    Ok(Json(serde_json::json!({
        "signed_in": true,
        "expires_at": expires_at,
    })))
}

/// `DELETE /api/user/safeguard/token` — sign the user out of
/// Safeguard. Idempotent.
pub async fn clear_safeguard_token(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    crate::services::safeguard::user_token::clear(&db.pool, user.id).await?;
    Ok(Json(serde_json::json!({ "signed_in": false })))
}

/// `POST /api/user/safeguard/signin/start` — mint a one-shot
/// enrolment code so the PowerShell snippet rendered in the
/// Safeguard sign-in card can POST the resulting `$SGToken` back to
/// Strata without the user having to copy/paste the JWT.
///
/// The returned code is single-use, expires in 5 minutes, and is
/// scoped to this user_id at consume time. The unauthenticated
/// `/api/safeguard/enrol` endpoint validates and consumes it.
pub async fn start_safeguard_signin(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    // Guard against minting codes when JIT is off — pointless and
    // potentially confusing for the operator.
    let cfg = crate::services::safeguard::config::load(&db.pool).await?;
    if !cfg.enabled || cfg.auth_mode.as_str() == "a2a" {
        return Err(AppError::Validation(
            "Safeguard JIT browser sign-in is not enabled.".into(),
        ));
    }

    let client_ip = crate::routes::auth::extract_client_ip(&headers);
    let minted =
        crate::services::safeguard::enrolment::mint(&db.pool, user.id, Some(&client_ip)).await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "safeguard.enrolment.minted",
        &json!({
            "expires_at": minted.expires_at,
            "ip": client_ip,
        }),
    )
    .await?;

    Ok(Json(json!({
        "code": minted.code,
        "expires_at": minted.expires_at,
    })))
}

#[derive(Deserialize)]
pub struct SafeguardEnrolBody {
    /// One-shot code minted by `POST /api/user/safeguard/signin/start`.
    pub code: String,
    /// The Safeguard API access token from PowerShell's `$SGToken`.
    pub token: String,
    /// Optional override of the token's lifetime in seconds. Mirrors
    /// the manual paste endpoint: 15-min default, 24h cap.
    #[serde(default)]
    pub expires_in_seconds: Option<i64>,
}

/// `POST /api/safeguard/enrol` — UNAUTHENTICATED. The one-shot code
/// IS the authentication: it was minted for a specific user_id at a
/// specific time and is consumed atomically. The PS snippet rendered
/// in the sign-in card POSTs `{ code, token }` here so the operator
/// never has to copy the JWT out of their terminal.
pub async fn enrol_safeguard_token(
    State(state): State<SharedState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SafeguardEnrolBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    let token = body.token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::Validation("token is required".into()));
    }
    let client_ip = crate::routes::auth::extract_client_ip(&headers);

    // Consume the code first — same uniform "invalid or expired"
    // error in every failure path so the caller can't fingerprint
    // unknown vs used vs expired.
    let user_id = match crate::services::safeguard::enrolment::consume(&db.pool, &body.code).await {
        Ok(uid) => uid,
        Err(e) => {
            // Audit even the failure so a brute-force attempt shows
            // up in the log. user_id is None because we don't know
            // who the rejected code was for.
            crate::services::audit::log(
                &db.pool,
                None,
                "safeguard.enrolment.rejected",
                &json!({ "ip": client_ip }),
            )
            .await
            .ok();
            return Err(e);
        }
    };

    let ttl_hint = body
        .expires_in_seconds
        .unwrap_or(15 * 60)
        .clamp(60, 24 * 60 * 60);
    let fallback = chrono::Utc::now() + chrono::Duration::seconds(ttl_hint);
    let expires_at = match crate::services::safeguard::user_token::jwt_exp(&token) {
        Some(exp) => {
            let max = chrono::Utc::now() + chrono::Duration::hours(24);
            let min = chrono::Utc::now() + chrono::Duration::seconds(60);
            exp.min(max).max(min)
        }
        None => fallback,
    };

    // Live-probe the token before storing so the consumed enrolment
    // code isn't burned on a token Safeguard has already invalidated.
    let cfg = crate::services::safeguard::config::load(&db.pool).await?;
    {
        use crate::services::safeguard::client;
        let secrets =
            crate::services::safeguard::config::load_secrets(&db.pool, &vault_cfg).await?;
        let identity = client::a2a_identity(&secrets)?;
        let http = client::build_client(&cfg, identity)?;
        let base = client::base_url(&cfg);
        match client::verify_token(&http, &base, &token).await {
            client::TokenProbe::Valid => {}
            client::TokenProbe::Invalid { status } => {
                crate::services::audit::log(
                    &db.pool,
                    Some(user_id),
                    "safeguard.enrolment.token_rejected",
                    &json!({ "http_status": status, "ip": client_ip }),
                )
                .await
                .ok();
                return Err(AppError::Validation(format!(
                    "Safeguard rejected the supplied token (HTTP {status}). It is expired, revoked, or was issued for a different appliance — please obtain a fresh token via Connect-Safeguard."
                )));
            }
            client::TokenProbe::Transient { error } => {
                crate::services::audit::log(
                    &db.pool,
                    Some(user_id),
                    "safeguard.enrolment.token_probe_failed",
                    &json!({ "error": error, "ip": client_ip }),
                )
                .await
                .ok();
                return Err(AppError::Internal(format!(
                    "Could not verify the Safeguard token: {error}"
                )));
            }
        }
    }

    crate::services::safeguard::user_token::store(
        &db.pool, &vault_cfg, user_id, &token, expires_at,
    )
    .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user_id),
        "safeguard.enrolment.consumed",
        &json!({
            "expires_at": expires_at,
            "ip": client_ip,
        }),
    )
    .await?;

    Ok(Json(json!({
        "signed_in": true,
        "expires_at": expires_at,
    })))
}

#[derive(Deserialize)]
pub struct BulkSafeguardCheckoutBody {
    pub profile_ids: Vec<Uuid>,
    /// User-supplied justification. Safeguard policy normally
    /// requires a non-empty `ReasonComment`; when omitted Safeguard
    /// silently denies the request. We treat it as required here
    /// and fall back to a generated marker only if the caller sent
    /// nothing (keeps backwards compatibility with old clients).
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Serialize)]
pub struct BulkSafeguardCheckoutResult {
    pub profile_id: Uuid,
    pub label: String,
    /// `true` only when the password is now cached and usable. For
    /// pending-approval rows this stays `false` — the frontend keys
    /// off `state` to render the third badge.
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Cache expiry (only present on success).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Username Safeguard returned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// `true` when the call replaced an existing live cache row by
    /// checking the old request back in first.
    #[serde(default)]
    pub replaced_existing: bool,
    /// Tri-state result for the frontend: `"ok"` (default when `ok =
    /// true`), `"pending"` (approver action required — request_id is
    /// non-null), `"failed"` (everything else where `ok = false`).
    /// Encoded as a separate field so old clients that only look at
    /// `ok` continue to render pending rows as failed, which matches
    /// pre-feature behaviour.
    pub state: BulkCheckoutState,
    /// Safeguard AccessRequest id. Always populated on `pending` so
    /// the frontend can poll / manually release; populated on `ok`
    /// for parity / debugging.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Echo of the profile's account id; required by the release
    /// endpoint to forge-proof the call (the user can't release an
    /// id that doesn't belong to one of their own profiles).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Echo of the profile's asset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BulkCheckoutState {
    Ok,
    Pending,
    Failed,
}

/// `POST /api/user/safeguard/bulk-checkout` — pre-fetch passwords for
/// the user's selected Safeguard profiles in one batch, cache each
/// for the profile's own `ttl_hours`, and (when one is already
/// cached) check the old appliance request in first so the new
/// checkout cleanly replaces it.
///
/// Requires admin `password_cache_enabled = true` — without caching
/// the result would be discarded the moment the user disconnects.
pub async fn bulk_safeguard_checkout(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<BulkSafeguardCheckoutBody>,
) -> Result<Json<Vec<BulkSafeguardCheckoutResult>>, AppError> {
    let db = require_running(&state).await?;
    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    let sg_cfg = crate::services::safeguard::config::load(&db.pool).await?;
    if !sg_cfg.enabled {
        return Err(AppError::Validation("Safeguard JIT is not enabled".into()));
    }
    if !crate::services::users::safeguard_jit_enabled(&db.pool, user.id).await {
        return Err(AppError::Validation(
            "Safeguard JIT is not enabled for this user".into(),
        ));
    }
    if !sg_cfg.password_cache_enabled {
        return Err(AppError::Validation(
            "Bulk checkout requires the admin to enable Safeguard password caching".into(),
        ));
    }
    if body.profile_ids.is_empty() {
        return Ok(Json(vec![]));
    }

    // Safeguard policy commonly requires a non-empty ReasonComment;
    // refuse upfront rather than silently substituting a marker the
    // reviewer can't action on.
    let trimmed_comment = body
        .comment
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if trimmed_comment.is_none() {
        return Err(AppError::Validation(
            "A justification comment is required for Safeguard checkouts".into(),
        ));
    }

    // Resolve profiles the user actually owns. Anything not owned, not
    // kind='safeguard', or expired is silently dropped — the response
    // will be missing those ids and the UI can highlight them.
    let rows = cp_svc::list_for_user(&db.pool, user.id).await?;
    let mut out = Vec::with_capacity(body.profile_ids.len());

    for pid in body.profile_ids.iter().copied() {
        let Some(profile) = rows.iter().find(|r| r.id == pid) else {
            out.push(BulkSafeguardCheckoutResult {
                profile_id: pid,
                label: String::new(),
                ok: false,
                error: Some("profile not found".into()),
                expires_at: None,
                username: None,
                replaced_existing: false,
                state: BulkCheckoutState::Failed,
                request_id: None,
                account_id: None,
                asset: None,
            });
            continue;
        };
        if profile.kind != "safeguard" {
            out.push(BulkSafeguardCheckoutResult {
                profile_id: pid,
                label: profile.label.clone(),
                ok: false,
                error: Some("not a Safeguard profile".into()),
                expires_at: None,
                username: None,
                replaced_existing: false,
                state: BulkCheckoutState::Failed,
                request_id: None,
                account_id: None,
                asset: None,
            });
            continue;
        }
        let account_id = profile.safeguard_account_id.clone().unwrap_or_default();
        let asset = profile.safeguard_asset.clone().unwrap_or_default();
        if account_id.trim().is_empty() || asset.trim().is_empty() {
            out.push(BulkSafeguardCheckoutResult {
                profile_id: pid,
                label: profile.label.clone(),
                ok: false,
                error: Some("profile is missing account_id or asset".into()),
                expires_at: None,
                username: None,
                replaced_existing: false,
                state: BulkCheckoutState::Failed,
                request_id: None,
                account_id: None,
                asset: None,
            });
            continue;
        }

        // If there's already a cached row for this profile, release
        // the existing Safeguard request before opening a new one so
        // the appliance audit shows a clean transition and the user
        // doesn't end up with two open requests for the same account.
        let mut replaced_existing = false;
        if let Ok(Some(cached)) =
            crate::services::safeguard::password_cache::load(&db.pool, &vault_cfg, user.id, pid)
                .await
        {
            replaced_existing = true;
            if let Some(rid) = cached.request_id.as_deref() {
                if let Err(e) = crate::services::safeguard::jit_checkin(
                    &db.pool,
                    &vault_cfg,
                    rid,
                    &account_id,
                    &asset,
                    Some(user.id),
                    None,
                )
                .await
                {
                    // Best-effort: a stale checkin (already checked in
                    // via portal) shouldn't block the new checkout.
                    tracing::warn!(
                        "bulk-checkout: existing request {} checkin failed for profile {}: {e}",
                        rid,
                        pid
                    );
                }
            }
            let _ = crate::services::safeguard::password_cache::clear(&db.pool, user.id, pid).await;
        }

        // New JIT checkout at the profile's own ttl_hours.
        // Prefer the user-supplied comment verbatim — Safeguard
        // policy commonly mandates a meaningful ReasonComment and
        // the admin-template-rendered marker ("Strata bulk:<uuid>")
        // is rarely what a reviewer wants to see in the audit log.
        let user_comment = body
            .comment
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let reason = match user_comment {
            Some(c) => c.to_string(),
            None => crate::services::safeguard::render_reason(
                &sg_cfg.request_reason_template,
                &format!("bulk:{pid}"),
                &user.username,
            ),
        };
        let jit = match crate::services::safeguard::jit_checkout(
            &db.pool,
            &vault_cfg,
            &account_id,
            &asset,
            &reason,
            Some(user.id),
            None,
            Some(pid),
            Some(profile.ttl_hours.max(1) as u32),
        )
        .await
        {
            Ok(o) => o,
            Err(e) => {
                tracing::warn!(
                    "bulk-checkout: jit_checkout failed for profile {pid} ({}): {e}",
                    profile.label
                );
                out.push(BulkSafeguardCheckoutResult {
                    profile_id: pid,
                    label: profile.label.clone(),
                    ok: false,
                    error: Some(e.to_string()),
                    expires_at: None,
                    username: None,
                    replaced_existing,
                    state: BulkCheckoutState::Failed,
                    request_id: None,
                    account_id: Some(account_id.clone()),
                    asset: Some(asset.clone()),
                });
                continue;
            }
        };
        let outcome = match jit {
            crate::services::safeguard::JitOutcome::Released(o) => o,
            crate::services::safeguard::JitOutcome::PendingApproval {
                request_id,
                appliance_state,
                ..
            } => {
                // Approver action required. Keep the request id so
                // the frontend can poll / press Refresh; do NOT
                // mutate the password cache (no password to cache).
                tracing::info!(
                    "bulk-checkout: profile {pid} ({}) pending approval — request_id={request_id} state={appliance_state:?}",
                    profile.label
                );
                out.push(BulkSafeguardCheckoutResult {
                    profile_id: pid,
                    label: profile.label.clone(),
                    ok: false,
                    error: Some(format!(
                        "Awaiting approver — request {request_id} is queued in Safeguard."
                    )),
                    expires_at: None,
                    username: None,
                    replaced_existing,
                    state: BulkCheckoutState::Pending,
                    request_id: Some(request_id),
                    account_id: Some(account_id.clone()),
                    asset: Some(asset.clone()),
                });
                continue;
            }
        };

        let expires_at =
            chrono::Utc::now() + chrono::Duration::hours(profile.ttl_hours.max(1) as i64);
        if let Err(e) = crate::services::safeguard::password_cache::store(
            &db.pool,
            &vault_cfg,
            user.id,
            pid,
            outcome.username.as_deref(),
            &outcome.password,
            Some(&outcome.request_id),
            expires_at,
        )
        .await
        {
            out.push(BulkSafeguardCheckoutResult {
                profile_id: pid,
                label: profile.label.clone(),
                ok: false,
                error: Some(format!("cache store failed: {e}")),
                expires_at: None,
                username: outcome.username.clone(),
                replaced_existing,
                state: BulkCheckoutState::Failed,
                request_id: Some(outcome.request_id.clone()),
                account_id: Some(account_id.clone()),
                asset: Some(asset.clone()),
            });
            continue;
        }

        // Keep the profile's own `expires_at` in lock-step with the
        // cache row's TTL so the Profiles list reflects the freshly
        // checked-out window (the column is otherwise frozen at the
        // last profile edit). On checkin we slam it back to `now()`.
        let _ = cp_svc::set_expires_at(&db.pool, pid, expires_at).await;

        out.push(BulkSafeguardCheckoutResult {
            profile_id: pid,
            label: profile.label.clone(),
            ok: true,
            error: None,
            expires_at: Some(expires_at),
            username: outcome.username,
            replaced_existing,
            state: BulkCheckoutState::Ok,
            request_id: Some(outcome.request_id),
            account_id: Some(account_id.clone()),
            asset: Some(asset.clone()),
        });
    }

    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct ReleaseSafeguardPendingBody {
    pub profile_id: Uuid,
    pub request_id: String,
}

/// `POST /api/user/safeguard/release` — retry a previously-issued
/// Safeguard `CheckoutPassword` for a request that came back
/// `PendingApproval`. Used by the bulk-checkout UI as both the
/// per-row Refresh button and the background poll: if an approver
/// has acted since the last poll we cache the freshly-released
/// password and tell the frontend; otherwise we report the request
/// is still pending.
///
/// Forge-proof: the request id MUST belong to a Safeguard profile the
/// caller owns, and the profile MUST still have account_id/asset
/// configured. We don't trust the appliance to enforce ownership
/// because the per_user_browser token IS the user — accepting an
/// arbitrary request id would let any signed-in user resolve any
/// pending approval they happen to know the id of.
pub async fn release_safeguard_pending(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<ReleaseSafeguardPendingBody>,
) -> Result<Json<BulkSafeguardCheckoutResult>, AppError> {
    let db = require_running(&state).await?;
    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    let request_id = body.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err(AppError::Validation("request_id is required".into()));
    }

    // Resolve the profile and confirm ownership in one go.
    let rows = cp_svc::list_for_user(&db.pool, user.id).await?;
    let profile = rows
        .iter()
        .find(|r| r.id == body.profile_id)
        .ok_or_else(|| AppError::Validation("profile not found".into()))?;
    if profile.kind != "safeguard" {
        return Err(AppError::Validation("not a Safeguard profile".into()));
    }
    let account_id = profile.safeguard_account_id.clone().unwrap_or_default();
    let asset = profile.safeguard_asset.clone().unwrap_or_default();
    if account_id.trim().is_empty() || asset.trim().is_empty() {
        return Err(AppError::Validation(
            "profile is missing account_id or asset".into(),
        ));
    }

    let jit = crate::services::safeguard::release_pending(
        &db.pool,
        &vault_cfg,
        &request_id,
        &account_id,
        &asset,
        Some(user.id),
        None,
        Some(body.profile_id),
    )
    .await?;

    match jit {
        crate::services::safeguard::JitOutcome::Released(outcome) => {
            let expires_at =
                chrono::Utc::now() + chrono::Duration::hours(profile.ttl_hours.max(1) as i64);
            // `outcome.username` is None on the release path (the
            // appliance only echoes the account name at request
            // creation time). The frontend already has the profile
            // label and can show "—" if needed.
            let cached_username = outcome.username.clone();
            crate::services::safeguard::password_cache::store(
                &db.pool,
                &vault_cfg,
                user.id,
                body.profile_id,
                cached_username.as_deref(),
                &outcome.password,
                Some(&outcome.request_id),
                expires_at,
            )
            .await?;
            let _ = cp_svc::set_expires_at(&db.pool, body.profile_id, expires_at).await;

            Ok(Json(BulkSafeguardCheckoutResult {
                profile_id: body.profile_id,
                label: profile.label.clone(),
                ok: true,
                error: None,
                expires_at: Some(expires_at),
                username: cached_username,
                replaced_existing: false,
                state: BulkCheckoutState::Ok,
                request_id: Some(outcome.request_id),
                account_id: Some(account_id),
                asset: Some(asset),
            }))
        }
        crate::services::safeguard::JitOutcome::PendingApproval {
            request_id: rid,
            appliance_state,
            ..
        } => Ok(Json(BulkSafeguardCheckoutResult {
            profile_id: body.profile_id,
            label: profile.label.clone(),
            ok: false,
            error: Some(format!(
                "Awaiting approver — request {rid} is queued in Safeguard{}.",
                appliance_state
                    .as_deref()
                    .map(|s| format!(" (state: {s})"))
                    .unwrap_or_default()
            )),
            expires_at: None,
            username: None,
            replaced_existing: false,
            state: BulkCheckoutState::Pending,
            request_id: Some(rid),
            account_id: Some(account_id),
            asset: Some(asset),
        })),
    }
}

/// `GET /api/user/safeguard/cached` — lightweight (no-decrypt)
/// snapshot of the user's live cache rows. Used by the bulk-checkout
/// UI to render "Cached — Xh left" badges. Expired rows are
/// automatically excluded.
pub async fn list_safeguard_cached(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<crate::services::safeguard::password_cache::CachedStatus>>, AppError> {
    let db = require_running(&state).await?;
    let rows =
        crate::services::safeguard::password_cache::status_for_user(&db.pool, user.id).await?;
    Ok(Json(rows))
}

/// `GET /api/user/safeguard/accounts` — list the Safeguard accounts
/// the currently-signed-in user is entitled to request password
/// access against, so the credential-profile editor can offer them
/// as a picker instead of forcing the user to type account ids.
///
/// Requires a live per-user Safeguard token (browser sign-in flow).
/// When the token is missing/expired, returns the same
/// `safeguard.signin_required` validation marker the JIT path uses
/// so the frontend can prompt for a fresh sign-in.
pub async fn list_safeguard_accounts(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<crate::services::safeguard::client::EntitledAccount>>, AppError> {
    let db = require_running(&state).await?;
    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    let sg_cfg = crate::services::safeguard::config::load(&db.pool).await?;
    if !sg_cfg.enabled {
        return Err(AppError::Validation("Safeguard JIT is not enabled".into()));
    }
    if !crate::services::users::safeguard_jit_enabled(&db.pool, user.id).await {
        return Err(AppError::Validation(
            "Safeguard JIT is not enabled for this user".into(),
        ));
    }

    // Per-user browser token is the only auth mode that makes sense
    // here: A2A returns the appliance-wide catalog, not the user's
    // own entitlements. Hybrid still requires a personal token to
    // answer "what am *I* entitled to?".
    let bearer = crate::services::safeguard::user_token::load(&db.pool, &vault_cfg, user.id)
        .await?
        .ok_or_else(|| AppError::Validation("safeguard.signin_required".into()))?;

    let secrets = crate::services::safeguard::config::load_secrets(&db.pool, &vault_cfg).await?;
    let identity = crate::services::safeguard::client::a2a_identity(&secrets)?;
    let http = crate::services::safeguard::client::build_client(&sg_cfg, identity)?;
    let base = crate::services::safeguard::client::base_url(&sg_cfg);

    let entitlements =
        crate::services::safeguard::client::list_password_entitlements(&http, &base, &bearer)
            .await?;

    // Audit count only — never log account/asset names.
    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "safeguard.entitlements.listed",
        &json!({ "count": entitlements.len() }),
    )
    .await?;

    Ok(Json(entitlements))
}

#[derive(Deserialize)]
pub struct BulkSafeguardCheckinBody {
    /// Profile IDs to release. An empty list means "all currently
    /// cached", so the UI can offer a single "Check in all" button
    /// without needing to enumerate every cached profile id.
    #[serde(default)]
    pub profile_ids: Vec<Uuid>,
}

#[derive(Serialize)]
pub struct BulkSafeguardCheckinResult {
    pub profile_id: Uuid,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `POST /api/user/safeguard/checkin` — release one or more cached
/// Safeguard passwords. For each profile we call
/// `AccessRequests/{id}/CheckIn` on the appliance (best-effort: a
/// 4xx from Safeguard for an already-closed request still results
/// in the local cache row being cleared so the UI is consistent).
///
/// Available whenever the user has a valid bearer (per-user token
/// or A2A fallback). The same `jit_checkin` path is reused so the
/// audit row is identical to a tunnel-driven check-in.
pub async fn bulk_safeguard_checkin(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<BulkSafeguardCheckinBody>,
) -> Result<Json<Vec<BulkSafeguardCheckinResult>>, AppError> {
    let db = require_running(&state).await?;
    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    // Resolve the full set of target profiles. An empty `profile_ids`
    // means "everything currently cached for this user".
    let cached =
        crate::services::safeguard::password_cache::status_for_user(&db.pool, user.id).await?;
    let target_ids: Vec<Uuid> = if body.profile_ids.is_empty() {
        cached.iter().map(|c| c.profile_id).collect()
    } else {
        body.profile_ids.clone()
    };

    if target_ids.is_empty() {
        return Ok(Json(vec![]));
    }

    let profiles = cp_svc::list_for_user(&db.pool, user.id).await?;
    let mut out = Vec::with_capacity(target_ids.len());

    for pid in target_ids {
        // Pull request_id + account/asset off the live cache row;
        // without those the appliance call can't be made.
        let entry = match crate::services::safeguard::password_cache::load(
            &db.pool, &vault_cfg, user.id, pid,
        )
        .await
        {
            Ok(Some(e)) => e,
            Ok(None) => {
                out.push(BulkSafeguardCheckinResult {
                    profile_id: pid,
                    ok: true,
                    error: None,
                });
                continue;
            }
            Err(e) => {
                out.push(BulkSafeguardCheckinResult {
                    profile_id: pid,
                    ok: false,
                    error: Some(e.to_string()),
                });
                continue;
            }
        };

        // Account/asset for the audit row are taken from the user's
        // own profile — the cache table doesn't carry them.
        let (account_id, asset_id) = profiles
            .iter()
            .find(|p| p.id == pid)
            .map(|p| {
                (
                    p.safeguard_account_id.clone().unwrap_or_default(),
                    p.safeguard_asset.clone().unwrap_or_default(),
                )
            })
            .unwrap_or_default();

        let mut error: Option<String> = None;
        if let Some(rid) = entry.request_id.as_deref() {
            if let Err(e) = crate::services::safeguard::jit_checkin(
                &db.pool,
                &vault_cfg,
                rid,
                &account_id,
                &asset_id,
                Some(user.id),
                None,
            )
            .await
            {
                // Don't abort: the appliance may have already auto-
                // checked-in (TTL expired, admin revoked, portal
                // check-in). We still want to drop the cache row so
                // the UI doesn't keep showing a stale entry.
                tracing::warn!("bulk-checkin: appliance checkin failed for profile {pid}: {e}");
                error = Some(e.to_string());
            }
        }

        let _ = crate::services::safeguard::password_cache::clear(&db.pool, user.id, pid).await;

        // Mark the profile expired immediately so the Profiles list
        // doesn't keep showing a "valid until ..." timestamp on a
        // credential whose password has just been scrambled by the
        // appliance — a user glancing at the row could otherwise
        // think the cached password is still usable.
        let _ = cp_svc::set_expires_at(&db.pool, pid, chrono::Utc::now()).await;

        out.push(BulkSafeguardCheckinResult {
            profile_id: pid,
            ok: error.is_none(),
            error,
        });
    }

    Ok(Json(out))
}

pub async fn create_credential_profile(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<CreateCredentialProfileRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    let admin_max = cp_svc::admin_max_ttl_hours(&db.pool).await;
    let extended_expiry = body.extended_expiry.unwrap_or(false);
    let ttl_hours = resolve_profile_ttl(body.ttl_hours, admin_max, extended_expiry);

    // ── Safeguard JIT branch ────────────────────────────────────────
    // No envelope payload is stored — the password is checked out from
    // the Safeguard appliance at tunnel-open time.
    if body.kind.as_deref() == Some("safeguard") {
        let account_id = body
            .safeguard_account_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                AppError::Validation(
                    "safeguard_account_id is required for Safeguard profiles".into(),
                )
            })?;
        let asset = body
            .safeguard_asset
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                AppError::Validation("safeguard_asset is required for Safeguard profiles".into())
            })?;

        // Hard-fail when the Safeguard subsystem is disabled — the
        // profile would be unusable. Better to refuse at create time
        // than to surface a 503 at the first tunnel open.
        if !crate::services::safeguard::kill_switch_enabled(&db.pool).await {
            return Err(AppError::Validation(
                "Safeguard JIT is disabled in admin settings".into(),
            ));
        }
        if !crate::services::users::safeguard_jit_enabled(&db.pool, user.id).await {
            return Err(AppError::Validation(
                "Safeguard JIT is not enabled for your account. Ask an administrator to enable it."
                    .into(),
            ));
        }

        let id = cp_svc::insert_safeguard(
            &db.pool,
            user.id,
            &body.label,
            account_id,
            asset,
            ttl_hours,
            extended_expiry,
        )
        .await?;

        crate::services::audit::log(
            &db.pool,
            Some(user.id),
            "credential_profile.created",
            &json!({
                "profile_id": id.to_string(),
                "label": body.label,
                "kind": "safeguard",
                "safeguard_account_id": account_id,
                "safeguard_asset": asset,
                "ttl_hours": ttl_hours,
            }),
        )
        .await?;

        return Ok(Json(
            json!({ "id": id, "status": "created", "kind": "safeguard" }),
        ));
    }

    // ── Local (envelope-encrypted) branch — original behaviour ────
    let username = body
        .username
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Validation("username is required for local credential profiles".into())
        })?;
    let password = body
        .password
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Validation("password is required for local credential profiles".into())
        })?;

    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Config("Vault not configured".into()))?
    };

    // Envelope-encrypt both username and password with one DEK
    let combined = serde_json::json!({
        "u": username,
        "p": password,
    });
    let sealed_raw = vault::seal(&vault_cfg, combined.to_string().as_bytes()).await?;
    let sealed = cp_svc::SealedPayload {
        ciphertext: sealed_raw.ciphertext,
        encrypted_dek: sealed_raw.encrypted_dek,
        nonce: sealed_raw.nonce,
    };

    let id = cp_svc::insert(
        &db.pool,
        user.id,
        &body.label,
        &sealed,
        ttl_hours,
        extended_expiry,
    )
    .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "credential_profile.created",
        &json!({
            "profile_id": id.to_string(),
            "label": body.label,
            "extended_expiry": extended_expiry,
            "ttl_hours": ttl_hours,
        }),
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
    #[serde(default)]
    pub extended_expiry: Option<bool>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub safeguard_account_id: Option<String>,
    #[serde(default)]
    pub safeguard_asset: Option<String>,
}

pub async fn update_credential_profile(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(profile_id): Path<Uuid>,
    Json(body): Json<UpdateCredentialProfileRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    if !cp_svc::user_owns(&db.pool, profile_id, user.id).await? {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    let admin_max = cp_svc::admin_max_ttl_hours(&db.pool).await;
    let current_kind = cp_svc::get_kind(&db.pool, profile_id)
        .await?
        .unwrap_or_else(|| "local".to_string());
    let requested_kind = body.kind.as_deref().unwrap_or(current_kind.as_str());
    let switching_to_safeguard = current_kind != "safeguard" && requested_kind == "safeguard";
    let switching_to_local = current_kind != "local" && requested_kind == "local";

    if requested_kind != "local" && requested_kind != "safeguard" {
        return Err(AppError::Validation(
            "kind must be 'local' or 'safeguard'".into(),
        ));
    }

    if requested_kind == "safeguard" {
        let account_id = body
            .safeguard_account_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                AppError::Validation(
                    "safeguard_account_id is required for Safeguard profiles".into(),
                )
            })?;
        let asset = body
            .safeguard_asset
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                AppError::Validation("safeguard_asset is required for Safeguard profiles".into())
            })?;

        // Safeguard TTL is always clamped against non-extended policy.
        let ttl_hours = body
            .ttl_hours
            .map(|h| resolve_profile_ttl(Some(h), admin_max, false));
        cp_svc::update_metadata(
            &db.pool,
            profile_id,
            body.label.as_deref(),
            ttl_hours,
            Some(false),
        )
        .await?;

        if switching_to_safeguard {
            cp_svc::set_kind_safeguard(&db.pool, profile_id, account_id, asset).await?;
        } else {
            cp_svc::update_safeguard_target(&db.pool, profile_id, Some(account_id), Some(asset))
                .await?;
        }
    } else {
        // The effective extended-expiry value for clamping the TTL is whatever
        // the body sent, falling back to whatever's currently stored.
        let extended_expiry = match body.extended_expiry {
            Some(v) => v,
            None => cp_svc::get_extended_expiry(&db.pool, profile_id).await?,
        };

        // If converting safeguard->local, require explicit username+password
        // because safeguard profiles do not carry a reusable local payload.
        if switching_to_local
            && (body.username.as_deref().unwrap_or("").trim().is_empty()
                || body.password.as_deref().unwrap_or("").trim().is_empty())
        {
            return Err(AppError::Validation(
                "username and password are required when converting a Safeguard profile to local"
                    .into(),
            ));
        }

        // If credentials are being updated, re-encrypt.
        if body.username.is_some() || body.password.is_some() || switching_to_local {
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
                    let existing = cp_svc::get_sealed(&db.pool, profile_id).await?;

                    let plaintext = vault::unseal(
                        &vault_cfg,
                        &existing.encrypted_dek,
                        &existing.ciphertext,
                        &existing.nonce,
                    )
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
            let sealed_raw = vault::seal(&vault_cfg, combined.to_string().as_bytes()).await?;
            let sealed = cp_svc::SealedPayload {
                ciphertext: sealed_raw.ciphertext,
                encrypted_dek: sealed_raw.encrypted_dek,
                nonce: sealed_raw.nonce,
            };

            let ttl_hours = resolve_profile_ttl(body.ttl_hours, admin_max, extended_expiry);
            cp_svc::update_sealed(
                &db.pool,
                profile_id,
                &sealed,
                ttl_hours,
                extended_expiry,
                body.label.as_deref(),
            )
            .await?;
        } else {
            // No credential change — update label and/or TTL and/or extended flag.
            let ttl_hours = body
                .ttl_hours
                .map(|h| resolve_profile_ttl(Some(h), admin_max, extended_expiry));
            cp_svc::update_metadata(
                &db.pool,
                profile_id,
                body.label.as_deref(),
                ttl_hours,
                body.extended_expiry,
            )
            .await?;
        }

        if switching_to_local {
            cp_svc::set_kind_local(&db.pool, profile_id).await?;
        }
    }

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "credential_profile.updated",
        &json!({ "profile_id": profile_id.to_string() }),
    )
    .await?;

    // Revoke active share links for connections using this profile
    if body.username.is_some()
        || body.password.is_some()
        || switching_to_local
        || switching_to_safeguard
    {
        cp_svc::revoke_shares_for_profile(&db.pool, user.id, profile_id).await?;
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
    cp_svc::revoke_shares_for_profile(&db.pool, user.id, profile_id).await?;

    if !cp_svc::delete(&db.pool, profile_id, user.id).await? {
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

// ── Link a credential profile to an active checkout ─────────────────

#[derive(Deserialize)]
pub struct LinkCheckoutRequest {
    pub checkout_id: Option<Uuid>,
}

pub async fn link_checkout_to_profile(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(profile_id): Path<Uuid>,
    Json(body): Json<LinkCheckoutRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    // Verify profile belongs to user
    if !cp_svc::user_owns(&db.pool, profile_id, user.id).await? {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    // Unlink
    if body.checkout_id.is_none() {
        cp_svc::clear_checkout_link(&db.pool, profile_id).await?;
        return Ok(Json(json!({ "status": "unlinked" })));
    }

    // SAFETY: branch above returned when None; reject defensively in
    // case a future refactor reorders the early-return.
    let checkout_id = body
        .checkout_id
        .ok_or_else(|| AppError::Internal("checkout_id missing after non-None guard".into()))?;

    // Verify checkout belongs to user and is active
    let checkout = crate::services::checkouts::get_owned_by_user(&db.pool, checkout_id, user.id)
        .await?
        .ok_or_else(|| AppError::NotFound("Checkout not found".into()))?;

    if checkout.status != "Active" {
        return Err(AppError::Validation(
            "Only active checkouts can be linked to profiles. Approved checkouts must be activated first.".into(),
        ));
    }

    let cred_id = checkout
        .vault_credential_id
        .ok_or_else(|| AppError::Internal("Checkout has no credential stored".into()))?;

    // Copy encrypted credentials from the checkout's managed credential to this profile
    let sealed = cp_svc::get_sealed(&db.pool, cred_id)
        .await
        .map_err(|_| AppError::Internal("Checkout credential profile not found".into()))?;

    cp_svc::link_to_checkout(
        &db.pool,
        profile_id,
        &sealed,
        checkout_id,
        checkout.expires_at,
    )
    .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "credential_profile.linked_checkout",
        &json!({
            "profile_id": profile_id.to_string(),
            "checkout_id": checkout_id.to_string(),
            "managed_ad_dn": checkout.managed_ad_dn,
        }),
    )
    .await?;

    Ok(Json(json!({
        "status": "linked",
        "checkout_id": checkout_id,
        "managed_ad_dn": checkout.managed_ad_dn,
        "expires_at": checkout.expires_at,
    })))
}

// ── Credential Mappings (profile ↔ connection) ──────────────────────

#[derive(Deserialize)]
pub struct SetMappingRequest {
    pub profile_id: Uuid,
    pub connection_id: Uuid,
}

pub async fn get_profile_mappings(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(profile_id): Path<Uuid>,
) -> Result<Json<Vec<MappingRow>>, AppError> {
    let db = require_running(&state).await?;

    if !cp_svc::user_owns(&db.pool, profile_id, user.id).await? {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    let rows = cp_svc::list_mappings(&db.pool, profile_id).await?;
    Ok(Json(rows))
}

pub async fn set_credential_mapping(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<SetMappingRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    if !cp_svc::user_owns(&db.pool, body.profile_id, user.id).await? {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    let has_access = cp_svc::user_has_connection_access(
        &db.pool,
        body.connection_id,
        user.id,
        user.can_access_all_connections(),
    )
    .await?;
    if !has_access {
        return Err(AppError::NotFound("Connection not found".into()));
    }

    // Remove any existing mapping for this user+connection (different profile)
    cp_svc::clear_connection_mapping(&db.pool, body.connection_id, user.id).await?;

    // Insert new mapping
    cp_svc::insert_mapping(&db.pool, body.profile_id, body.connection_id).await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "user.credential_mapping_set",
        &json!({
            "profile_id": body.profile_id.to_string(),
            "connection_id": body.connection_id.to_string(),
        }),
    )
    .await?;

    Ok(Json(json!({ "status": "mapped" })))
}

pub async fn remove_credential_mapping(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(connection_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    cp_svc::clear_connection_mapping(&db.pool, connection_id, user.id).await?;
    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "user.credential_mapping_removed",
        &json!({ "connection_id": connection_id.to_string() }),
    )
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

    // Fetch protocol, extra params, and watermark setting for this connection
    let (protocol, extra, watermark) =
        crate::services::connections::get_session_info(&db.pool, connection_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Connection not found".into()))?;

    // Check if a credential profile is mapped to this user+connection.
    // A profile is considered "live" when:
    //   - its TTL has not expired, AND
    //   - if it is backed by a managed-account checkout, that checkout is
    //     still Active (not CheckedIn / Expired / Denied / Cancelled /
    //     Scheduled / Pending). A CheckedIn checkout has had its password
    //     scrambled in vault; attempting to use it would cause an AD lockout.
    let has_vault_creds: bool = if !has_vault {
        false
    } else {
        cp_svc::has_live_creds_for_connection(&db.pool, connection_id, user.id).await
    };

    // If no active credentials, check for an expired-or-stale profile mapped
    // to this connection. This includes both TTL-expired profiles and
    // profiles whose backing checkout is no longer live (CheckedIn, Expired,
    // Denied, Cancelled, etc.) so the user can re-request / re-enter creds.
    // Also check if it's a managed account with self-approval rights.
    let expired_profile = if !has_vault_creds && has_vault {
        cp_svc::expired_profile_for_connection(&db.pool, connection_id, user.id).await
    } else {
        None
    };

    let ignore_cert = if protocol == "rdp" {
        parse_ignore_cert(&extra)
    } else {
        false
    };

    // Match the strict "only explicit true = enabled" semantics used by
    // `tunnel.rs::full_param_map` so the UI, backend, and guacd all agree.
    let extra_obj = extra.as_ref().and_then(|e| e.as_object());
    let drive_setting = extra_obj
        .and_then(|o| o.get("enable-drive"))
        .and_then(|v| v.as_str());
    let sftp_setting = extra_obj
        .and_then(|o| o.get("enable-sftp"))
        .and_then(|v| v.as_str());
    let file_transfer_enabled = drive_setting == Some("true") || sftp_setting == Some("true");

    let mut resp = json!({
        "protocol": protocol,
        "has_credentials": has_vault_creds,
        "ignore_cert": ignore_cert,
        "watermark": watermark,
        "file_transfer_enabled": file_transfer_enabled,
    });

    if let Some((ep_id, ep_label, ep_ttl, ep_dn, ep_cfg_id, ep_self_approve)) = expired_profile {
        resp["expired_profile"] = json!({
            "id": ep_id,
            "label": ep_label,
            "ttl_hours": ep_ttl,
            "managed_ad_dn": ep_dn,
            "ad_sync_config_id": ep_cfg_id,
            "can_self_approve": ep_self_approve,
        });
    }

    Ok(Json(resp))
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
    let recordings_canonical = tokio::fs::canonicalize(recordings_dir)
        .await
        .unwrap_or_else(|_| std::path::PathBuf::from(recordings_dir));
    let candidate = std::path::Path::new(recordings_dir).join(&filename);

    // Resolve symlinks and verify the canonical path stays within recordings dir
    if let Ok(canonical) = tokio::fs::canonicalize(&candidate).await {
        if !canonical.starts_with(&recordings_canonical) {
            return Err(AppError::NotFound("Invalid filename".into()));
        }
        // Open the resolved canonical path, not the user-supplied one
        if let Ok(file) = File::open(&canonical).await {
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

// ── User's own active sessions ────────────────────────────────────────

/// GET /api/user/sessions — list active sessions belonging to the authenticated user only.
pub async fn my_active_sessions(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<crate::services::session_registry::SessionInfo>>, AppError> {
    let _db = require_running(&state).await?;
    let registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };
    let all = registry.list().await;
    let mine: Vec<_> = all.into_iter().filter(|s| s.user_id == user.id).collect();
    Ok(Json(mine))
}

/// GET /api/user/sessions/:id/observe — observe a live session owned by the authenticated user.
pub async fn my_observe_session(
    ws: axum::extract::WebSocketUpgrade,
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(session_id): Path<String>,
    Query(query): Query<super::admin::ObserveQuery>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let _db = require_running(&state).await?;
    let registry = {
        let s = state.read().await;
        s.session_registry.clone()
    };

    let session = registry
        .get(&session_id)
        .await
        .ok_or_else(|| AppError::NotFound("Active session not found".into()))?;

    // Verify the session belongs to the authenticated user
    if session.user_id != user.id {
        return Err(AppError::NotFound("Active session not found".into()));
    }

    super::admin::observe_session_ws(ws, session, query).await
}

// ── User's own recordings ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct MyRecordingsQuery {
    pub connection_id: Option<Uuid>,
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// GET /api/user/recordings — list recordings owned by the authenticated user.
pub async fn my_recordings(
    State(state): State<SharedState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<MyRecordingsQuery>,
) -> Result<Json<Vec<crate::db::Recording>>, AppError> {
    let db = require_running(&state).await?;

    let recordings = crate::services::recordings::list_for_user(
        &db.pool,
        auth.id,
        query.connection_id,
        query.search,
        query.limit.unwrap_or(50),
        query.offset.unwrap_or(0),
    )
    .await?;

    Ok(Json(recordings))
}

/// GET /api/user/recordings/:id/stream — stream a recording that belongs to the authenticated user.
async fn my_recording_stream_handler(
    socket: axum::extract::ws::WebSocket,
    state: SharedState,
    recording: crate::db::Recording,
    seek_ms: u64,
    speed: f64,
) {
    if let Err(e) = crate::routes::admin::recordings::handle_user_recording_stream(
        socket, state, recording, seek_ms, speed,
    )
    .await
    {
        tracing::error!("User recording stream error: {}", e);
    }
}

pub async fn my_recording_stream(
    ws: axum::extract::ws::WebSocketUpgrade,
    State(state): State<SharedState>,
    Extension(auth): Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Query(query): Query<crate::routes::admin::recordings::RecordingStreamQuery>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let db = require_running(&state).await?;

    let seek_ms = query.seek.unwrap_or(0);
    let speed = query.speed.unwrap_or(1.0).clamp(0.25, 16.0);

    // Fetch recording and verify ownership
    let recording = crate::services::recordings::get_owned_by_user(&db.pool, id, auth.id)
        .await?
        .ok_or_else(|| AppError::NotFound("Recording not found".into()))?;

    Ok(ws.protocols(["guacamole"]).on_upgrade(move |socket| {
        my_recording_stream_handler(socket, state, recording, seek_ms, speed)
    }))
}

// ════════════════════════════════════════════════════════════════════════
// Password Checkout — user-facing endpoints
// ════════════════════════════════════════════════════════════════════════

use crate::services::checkouts::CheckoutRequest;

/// My managed account mappings (accounts I can request checkout for).
pub async fn my_managed_accounts(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<serde_json::Value>>, AppError> {
    let db = require_running(&state).await?;
    let rows =
        crate::services::checkouts::list_managed_accounts_for_user(&db.pool, user.id).await?;

    let out: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.0,
                "user_id": r.1,
                "managed_ad_dn": r.2,
                "can_self_approve": r.3,
                "ad_sync_config_id": r.4,
                "created_at": r.5,
                "friendly_name": r.6,
                "pm_allow_emergency_bypass": r.7.unwrap_or(false),
            })
        })
        .collect();
    Ok(Json(out))
}

/// Request a password checkout.
#[derive(Deserialize)]
pub struct RequestCheckoutBody {
    pub managed_ad_dn: String,
    #[allow(dead_code)]
    pub ad_sync_config_id: Option<Uuid>,
    pub requested_duration_mins: Option<i32>,
    pub justification_comment: Option<String>,
    /// When true, bypass the approval workflow and release the password
    /// immediately. Only honoured when the AD sync config has
    /// `pm_allow_emergency_bypass = true` and a justification is provided.
    #[serde(default)]
    pub emergency_bypass: Option<bool>,
    /// Optional future timestamp. When set and in the future, the checkout
    /// is held at status = 'Scheduled' until the background worker releases
    /// the password at or after this time. Ignored when emergency bypass
    /// is used.
    #[serde(default)]
    pub scheduled_start_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn request_checkout(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<RequestCheckoutBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;
    let dn = body.managed_ad_dn.trim();
    if dn.is_empty() {
        return Err(AppError::Validation("managed_ad_dn is required".into()));
    }

    // Verify user has a mapping for this DN
    let mapping = crate::services::checkouts::find_mapping(&db.pool, user.id, dn)
        .await?
        .ok_or(AppError::Forbidden)?;

    let mut duration = body.requested_duration_mins.unwrap_or(60).clamp(1, 720);
    // Check for active/pending checkout on same DN by same user
    if crate::services::checkouts::has_open_checkout(&db.pool, user.id, dn).await? {
        return Err(AppError::Validation(
            "You already have a pending or active checkout for this account".into(),
        ));
    }

    // If self-approve, go straight to Approved
    let mut initial_status = if mapping.can_self_approve {
        "Approved"
    } else {
        "Pending"
    };

    // Justification is mandatory (≥ 10 characters) whenever approval is
    // required — i.e. the user does not have self-approval rights. This
    // ensures every approver-visible request carries a written business
    // reason. Self-approving users remain free to submit without a comment.
    if !mapping.can_self_approve {
        let justification = body.justification_comment.as_deref().unwrap_or("").trim();
        if justification.len() < 10 {
            return Err(AppError::Validation(
                "A justification of at least 10 characters is required for approval-required checkouts".into(),
            ));
        }
    }

    // Emergency Approval Bypass: lets a user who normally requires approval
    // release the password immediately. Must be explicitly allowed per AD sync
    // config, must not be used by self-approvers (it's meaningless), and must
    // be accompanied by a justification of at least 10 chars.
    let emergency_bypass = body.emergency_bypass.unwrap_or(false);
    if emergency_bypass {
        if mapping.can_self_approve {
            // No-op for self-approvers; just honour normal flow.
        } else {
            let justification = body.justification_comment.as_deref().unwrap_or("").trim();
            if justification.len() < 10 {
                return Err(AppError::Validation(
                    "Emergency Approval Bypass requires a justification of at least 10 characters"
                        .into(),
                ));
            }

            let allow_bypass = crate::services::checkouts::emergency_bypass_allowed(
                &db.pool,
                mapping.ad_sync_config_id,
                &mapping.managed_ad_dn,
            )
            .await?;

            if !allow_bypass {
                return Err(AppError::Forbidden);
            }

            // Hard cap: emergency bypass checkouts cannot exceed 30 minutes.
            // This limits exposure when the approver chain is bypassed.
            if duration > 30 {
                duration = 30;
            }

            initial_status = "Approved";
        }
    }

    // Scheduled start: if the user requested a future start time and the
    // checkout is in an auto-release state, hold it until the clock catches up.
    // Emergency bypass overrides scheduling (break-glass is immediate).
    let now = chrono::Utc::now();
    let scheduled_start_at = body
        .scheduled_start_at
        .filter(|ts| *ts > now + chrono::Duration::seconds(30));
    // Guard: don't allow scheduling more than 14 days out
    if let Some(ts) = scheduled_start_at {
        if ts > now + chrono::Duration::days(14) {
            return Err(AppError::Validation(
                "Scheduled start time cannot be more than 14 days in the future".into(),
            ));
        }
    }
    let use_schedule = scheduled_start_at.is_some()
        && initial_status == "Approved"
        && (!emergency_bypass || mapping.can_self_approve);
    if use_schedule {
        initial_status = "Scheduled";
    }

    let id = crate::services::checkouts::insert_request(
        &db.pool,
        user.id,
        dn,
        mapping.ad_sync_config_id,
        initial_status,
        duration,
        body.justification_comment.as_deref().unwrap_or(""),
        mapping.friendly_name.as_deref(),
        emergency_bypass && initial_status == "Approved" && !mapping.can_self_approve,
        scheduled_start_at,
    )
    .await?;

    let emergency_logged = emergency_bypass && !mapping.can_self_approve;
    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        if emergency_logged {
            "checkout.emergency_bypass"
        } else {
            "checkout.requested"
        },
        &json!({
            "checkout_id": id,
            "dn": dn,
            "status": initial_status,
            "emergency_bypass": emergency_logged,
            "scheduled_start_at": scheduled_start_at,
            "justification": body.justification_comment.as_deref().unwrap_or(""),
        }),
    )
    .await?;

    // ── Notification dispatch ───────────────────────────────────────
    // Fire-and-forget; never blocks the HTTP response.  Branches on the
    // initial_status so a self-approval (or emergency bypass) sends the
    // audit-grade "self-approved" template, and a normal request fans
    // out the "pending" template to all approvers.
    {
        // Prefer the friendly_name the admin has set on the mapping —
        // that's what every user-facing surface (My Checkouts card, the
        // request form, the approver queue header) shows for this
        // account, so the audit-grade email needs to read identically.
        // Fall back to a properly-escaped CN extraction when no
        // friendly name is configured.
        let target_cn = mapping
            .friendly_name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| crate::services::display::cn_from_dn(dn))
            .unwrap_or_else(|| dn.to_owned());
        let requester_display = user
            .full_name
            .clone()
            .unwrap_or_else(|| user.username.clone());
        let vault_for_dispatch = {
            let s = state.read().await;
            s.config.as_ref().and_then(|c| c.vault.clone())
        };

        if initial_status == "Approved" || initial_status == "Active" {
            // Self-approved or emergency-bypass auto-approve: audit-grade
            // notice to the requester.
            let expires_at = chrono::Utc::now() + chrono::Duration::minutes(duration as i64);
            crate::services::notifications::spawn_dispatch(
                db.pool.clone(),
                vault_for_dispatch,
                crate::services::notifications::CheckoutEvent::SelfApproved {
                    checkout_id: id,
                    requester_id: user.id,
                    requester_display_name: requester_display,
                    target_account_dn: dn.to_owned(),
                    target_account_cn: target_cn,
                    expires_at,
                },
            );
        } else if initial_status == "Pending" {
            match crate::services::checkouts::approvers_for_account(&db.pool, dn).await {
                Ok(approver_user_ids) => {
                    crate::services::notifications::spawn_dispatch(
                        db.pool.clone(),
                        vault_for_dispatch,
                        crate::services::notifications::CheckoutEvent::Pending {
                            checkout_id: id,
                            requester_id: user.id,
                            requester_display_name: requester_display,
                            requester_username: user.username.clone(),
                            target_account_dn: dn.to_owned(),
                            target_account_cn: target_cn,
                            justification: body.justification_comment.clone().unwrap_or_default(),
                            requested_ttl_minutes: duration,
                            approver_user_ids,
                        },
                    );
                }
                Err(e) => {
                    tracing::warn!("could not resolve approvers for {dn}: {e}");
                }
            }
        }
        // Scheduled ⇒ no immediate notification (worker will pick it up
        // when the scheduled time arrives; that path is not yet wired).
    }

    // Auto-activate if self-approved
    if initial_status == "Approved" {
        let vault_cfg = {
            let s = state.read().await;
            s.config.as_ref().and_then(|c| c.vault.clone())
        };
        if let Some(ref vc) = vault_cfg {
            match crate::services::checkouts::activate_checkout(&db.pool, vc, id).await {
                Ok(()) => {
                    return Ok(Json(json!({ "id": id, "status": "Active" })));
                }
                Err(e) => {
                    tracing::error!("Checkout {id} approved but activation failed: {e}");
                    // Return success with Approved status — user can retry
                    return Ok(Json(json!({
                        "id": id,
                        "status": "Approved",
                        "activation_error": format!("{e}")
                    })));
                }
            }
        }
    }

    Ok(Json(json!({
        "id": id,
        "status": initial_status,
        "scheduled_start_at": scheduled_start_at,
    })))
}

/// My checkout requests.
pub async fn my_checkouts(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<CheckoutRequest>>, AppError> {
    let db = require_running(&state).await?;
    let rows = crate::services::checkouts::list_for_user(&db.pool, user.id).await?;
    Ok(Json(rows))
}

/// List pending requests that I can approve (my role covers the request's managed account).
pub async fn pending_approvals(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<CheckoutRequest>>, AppError> {
    let db = require_running(&state).await?;
    let role_ids = crate::services::checkouts::approver_role_ids(&db.pool, user.id).await?;

    if role_ids.is_empty() {
        return Ok(Json(vec![]));
    }

    let pending = crate::services::checkouts::pending_for_roles(&db.pool, &role_ids).await?;
    Ok(Json(pending))
}

/// Approve a pending checkout.
#[derive(Deserialize)]
pub struct ApprovalDecisionBody {
    pub approved: bool,
    /// Free-form reason captured from the approver. Required by the UI
    /// on Deny (the inline popup gates the Confirm button on a non-empty
    /// field); optional on Approve. Trimmed and length-checked here so a
    /// 50 MB blob can't get persisted into `decision_reason`.
    #[serde(default)]
    pub reason: Option<String>,
}

pub async fn decide_checkout(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(checkout_id): Path<Uuid>,
    Json(body): Json<ApprovalDecisionBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    let role_ids = crate::services::checkouts::approver_role_ids(&db.pool, user.id).await?;
    if role_ids.is_empty() {
        return Err(AppError::Forbidden);
    }

    let checkout = crate::services::checkouts::get_by_id(&db.pool, checkout_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Checkout request not found".into()))?;

    if checkout.status != "Pending" {
        return Err(AppError::Validation(format!(
            "Cannot change status from '{}'",
            checkout.status
        )));
    }

    // Normalise the reason: trim whitespace, drop empty strings, enforce
    // a 1024-char cap to match the outbound-share decide endpoint. Done
    // here (not in set_decision) so the validation error surfaces as a
    // 400 rather than landing on the DB layer. Denials with an empty
    // reason are rejected so the audit trail always has context — the UI
    // already gates Confirm on this but a direct API caller must obey.
    let reason: Option<String> = body
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if let Some(ref r) = reason {
        if r.chars().count() > 1024 {
            return Err(AppError::Validation(
                "Decision reason must be 1024 characters or fewer".into(),
            ));
        }
    }
    if !body.approved && reason.is_none() {
        return Err(AppError::Validation(
            "A reason is required when denying a checkout request".into(),
        ));
    }

    if !crate::services::checkouts::roles_cover_account(
        &db.pool,
        &role_ids,
        &checkout.managed_ad_dn,
    )
    .await?
    {
        return Err(AppError::Forbidden);
    }

    if body.approved {
        crate::services::checkouts::set_decision(
            &db.pool,
            checkout_id,
            user.id,
            true,
            reason.as_deref(),
        )
        .await?;

        crate::services::audit::log(
            &db.pool,
            Some(user.id),
            "checkout.approved",
            &json!({ "checkout_id": checkout_id, "reason": reason }),
        )
        .await?;

        // Notification: tell the requester their request was approved.
        {
            let target_cn = checkout
                .friendly_name
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| crate::services::display::cn_from_dn(&checkout.managed_ad_dn))
                .unwrap_or_else(|| checkout.managed_ad_dn.clone());
            let approver_display = user
                .full_name
                .clone()
                .unwrap_or_else(|| user.username.clone());
            let expires_at = chrono::Utc::now()
                + chrono::Duration::minutes(checkout.requested_duration_mins as i64);
            let vault_for_dispatch = {
                let s = state.read().await;
                s.config.as_ref().and_then(|c| c.vault.clone())
            };
            crate::services::notifications::spawn_dispatch(
                db.pool.clone(),
                vault_for_dispatch,
                crate::services::notifications::CheckoutEvent::Approved {
                    checkout_id,
                    requester_id: checkout.requester_user_id,
                    requester_display_name: String::new(), // looked up server-side if needed
                    approver_display_name: approver_display,
                    target_account_dn: checkout.managed_ad_dn.clone(),
                    target_account_cn: target_cn,
                    expires_at,
                },
            );
        }

        // Auto-activate
        let vault_cfg = {
            let s = state.read().await;
            s.config.as_ref().and_then(|c| c.vault.clone())
        };
        if let Some(ref vc) = vault_cfg {
            match crate::services::checkouts::activate_checkout(&db.pool, vc, checkout_id).await {
                Ok(()) => {
                    return Ok(Json(json!({ "status": "Active" })));
                }
                Err(e) => {
                    tracing::error!("Checkout {checkout_id} approved but activation failed: {e}");
                    return Ok(Json(json!({
                        "status": "Approved",
                        "activation_error": format!("{e}")
                    })));
                }
            }
        }

        Ok(Json(json!({ "status": "Approved" })))
    } else {
        crate::services::checkouts::set_decision(
            &db.pool,
            checkout_id,
            user.id,
            false,
            reason.as_deref(),
        )
        .await?;

        crate::services::audit::log(
            &db.pool,
            Some(user.id),
            "checkout.denied",
            &json!({ "checkout_id": checkout_id, "reason": reason }),
        )
        .await?;

        // Notification: tell the requester their request was declined.
        {
            let target_cn = checkout
                .friendly_name
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| crate::services::display::cn_from_dn(&checkout.managed_ad_dn))
                .unwrap_or_else(|| checkout.managed_ad_dn.clone());
            let approver_display = user
                .full_name
                .clone()
                .unwrap_or_else(|| user.username.clone());
            let vault_for_dispatch = {
                let s = state.read().await;
                s.config.as_ref().and_then(|c| c.vault.clone())
            };
            crate::services::notifications::spawn_dispatch(
                db.pool.clone(),
                vault_for_dispatch,
                crate::services::notifications::CheckoutEvent::Rejected {
                    checkout_id,
                    requester_id: checkout.requester_user_id,
                    requester_display_name: String::new(),
                    approver_display_name: approver_display,
                    target_account_dn: checkout.managed_ad_dn.clone(),
                    target_account_cn: target_cn,
                    reason: reason.clone(),
                },
            );
        }

        Ok(Json(json!({ "status": "Denied" })))
    }
}

/// Get the revealed password for an active checkout (only the requester can see it).
pub async fn reveal_checkout_password(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(checkout_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    let checkout = crate::services::checkouts::get_owned_by_user(&db.pool, checkout_id, user.id)
        .await?
        .ok_or_else(|| AppError::NotFound("Checkout not found".into()))?;

    if checkout.status != "Active" {
        return Err(AppError::Validation(
            "Password can only be revealed for active checkouts".into(),
        ));
    }

    let cred_id = checkout
        .vault_credential_id
        .ok_or_else(|| AppError::Internal("No credential stored for this checkout".into()))?;

    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or(AppError::Internal("Vault not configured".into()))?
    };

    // Fetch the credential profile
    let sealed = cp_svc::get_sealed(&db.pool, cred_id)
        .await
        .map_err(|_| AppError::Internal("Credential profile not found".into()))?;

    let plaintext = vault::unseal(
        &vault_cfg,
        &sealed.encrypted_dek,
        &sealed.ciphertext,
        &sealed.nonce,
    )
    .await?;
    let plain_str = String::from_utf8(plaintext).unwrap_or_default();
    let parsed: serde_json::Value =
        serde_json::from_str(&plain_str).unwrap_or_else(|_| json!({ "p": plain_str }));
    let password: String = parsed["p"].as_str().unwrap_or_default().to_string();

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "checkout.password_revealed",
        &json!({ "checkout_id": checkout_id }),
    )
    .await?;

    Ok(Json(json!({
        "password": password,
        "expires_at": checkout.expires_at,
    })))
}

/// Retry activation of an Approved checkout that failed to activate.
///
/// W2-10 — honours the optional `Idempotency-Key` request header. When
/// present, the first successful (or failed) response is cached for
/// `IDEMPOTENCY_TTL_HOURS` and any subsequent request carrying the same
/// key for the same user+route short-circuits to the cached response.
/// This protects against duplicate password resets when a client retries
/// after a network failure.
pub async fn retry_checkout_activation(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(checkout_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    const ROUTE: &str = "POST /api/user/checkouts/:id/retry";
    let db = require_running(&state).await?;
    let idem_key = crate::services::idempotency::extract_key(&headers)?;

    if let Some(ref key) = idem_key {
        if let Some(cached) =
            crate::services::idempotency::lookup(&db.pool, user.id, ROUTE, key).await?
        {
            let status = axum::http::StatusCode::from_u16(cached.status_code as u16)
                .unwrap_or(axum::http::StatusCode::OK);
            return Ok((status, Json(cached.body)));
        }
    }

    let checkout = crate::services::checkouts::get_owned_by_user(&db.pool, checkout_id, user.id)
        .await?
        .ok_or_else(|| AppError::NotFound("Checkout not found".into()))?;

    if checkout.status != "Approved" {
        return Err(AppError::Validation(format!(
            "Only Approved checkouts can be retried, current status: '{}'",
            checkout.status
        )));
    }

    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or(AppError::Internal("Vault not configured".into()))?
    };

    crate::services::checkouts::activate_checkout(&db.pool, &vault_cfg, checkout_id)
        .await
        .map_err(|e| {
            tracing::error!("Retry activation failed for checkout {checkout_id}: {e}");
            AppError::Validation(format!("Activation failed: {e}"))
        })?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "checkout.retry_activation",
        &json!({ "checkout_id": checkout_id.to_string() }),
    )
    .await?;

    let body = json!({ "status": "Active" });
    if let Some(ref key) = idem_key {
        if let Err(e) =
            crate::services::idempotency::store(&db.pool, user.id, ROUTE, key, 200, &body).await
        {
            tracing::warn!("Failed to cache idempotency response for key {key}: {e}");
        }
    }
    Ok((axum::http::StatusCode::OK, Json(body)))
}

pub async fn checkin_checkout(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(checkout_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let db = require_running(&state).await?;

    let vault_cfg = {
        let s = state.read().await;
        s.config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or(AppError::Internal("Vault not configured".into()))?
    };

    crate::services::checkouts::checkin_checkout(&db.pool, &vault_cfg, checkout_id, user.id)
        .await?;

    crate::services::audit::log(
        &db.pool,
        Some(user.id),
        "checkout.checkin",
        &json!({ "checkout_id": checkout_id.to_string() }),
    )
    .await?;

    Ok(Json(json!({ "status": "CheckedIn" })))
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
        assert_eq!(req.username.as_deref(), Some("admin"));
        assert_eq!(req.password.as_deref(), Some("hunter2"));
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
        assert!(req.kind.is_none());
    }

    #[test]
    fn update_profile_request_deserializes_kind() {
        let j = json!({
            "kind": "safeguard",
            "safeguard_account_id": "42",
            "safeguard_asset": "prod-asset"
        });
        let req: UpdateCredentialProfileRequest = serde_json::from_value(j).unwrap();
        assert_eq!(req.kind.as_deref(), Some("safeguard"));
        assert_eq!(req.safeguard_account_id.as_deref(), Some("42"));
        assert_eq!(req.safeguard_asset.as_deref(), Some("prod-asset"));
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
            watermark: "inherit".into(),
            health_status: "unknown".into(),
            health_checked_at: None,
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
            extended_expiry: false,
            checkout_id: None,
            kind: "local".into(),
            safeguard_account_id: None,
            safeguard_asset: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["label"], "Work");
        assert_eq!(v["expired"], false);
        assert_eq!(v["ttl_hours"], 8);
        assert_eq!(v["extended_expiry"], false);
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
                file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                    "/tmp/strata-files",
                ))
                .await,
                web_displays: std::sync::Arc::new(
                    crate::services::web_session::WebDisplayAllocator::new(),
                ),
                web_runtime: std::sync::Arc::new(
                    crate::services::web_runtime::WebRuntimeRegistry::new(std::sync::Arc::new(
                        crate::services::web_session::WebDisplayAllocator::new(),
                    )),
                ),
                vdi_driver: std::sync::Arc::new(crate::services::vdi::NoopVdiDriver),
                dmz_link_registry: None,
                av_scanner: std::sync::Arc::new(crate::services::av::OffScanner),
                av_fail_mode: crate::services::av::FailMode::Block,
                started_at: std::time::Instant::now(),
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
                file_store: crate::services::file_store::FileStore::new(std::path::PathBuf::from(
                    "/tmp/strata-files",
                ))
                .await,
                web_displays: std::sync::Arc::new(
                    crate::services::web_session::WebDisplayAllocator::new(),
                ),
                web_runtime: std::sync::Arc::new(
                    crate::services::web_runtime::WebRuntimeRegistry::new(std::sync::Arc::new(
                        crate::services::web_session::WebDisplayAllocator::new(),
                    )),
                ),
                vdi_driver: std::sync::Arc::new(crate::services::vdi::NoopVdiDriver),
                dmz_link_registry: None,
                av_scanner: std::sync::Arc::new(crate::services::av::OffScanner),
                av_fail_mode: crate::services::av::FailMode::Block,
                started_at: std::time::Instant::now(),
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
            extended_expiry: false,
            checkout_id: None,
            kind: "local".into(),
            safeguard_account_id: None,
            safeguard_asset: None,
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
            watermark: "inherit".into(),
            health_status: "unknown".into(),
            health_checked_at: None,
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
            watermark: "on".into(),
            health_status: "unknown".into(),
            health_checked_at: None,
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

    // ── resolve_profile_ttl (extended-expiry aware) ────────────────────

    #[test]
    fn resolve_profile_ttl_non_extended_uses_admin_max() {
        // Non-extended profiles must still respect the admin's 1–12 cap.
        assert_eq!(resolve_profile_ttl(Some(8), 12, false), 8);
        assert_eq!(resolve_profile_ttl(Some(48), 12, false), 12);
        assert_eq!(resolve_profile_ttl(None, 12, false), 12);
    }

    #[test]
    fn resolve_profile_ttl_extended_allows_up_to_90_days() {
        // 2160 hours = 90 days
        assert_eq!(resolve_profile_ttl(Some(720), 12, true), 720);
        assert_eq!(resolve_profile_ttl(Some(2160), 12, true), 2160);
    }

    #[test]
    fn resolve_profile_ttl_extended_clamps_above_extended_max() {
        assert_eq!(resolve_profile_ttl(Some(9999), 12, true), 2160);
    }

    #[test]
    fn resolve_profile_ttl_extended_default_is_extended_max() {
        // No user preference + extended => default to the extended cap.
        assert_eq!(resolve_profile_ttl(None, 12, true), 2160);
    }

    #[test]
    fn resolve_profile_ttl_clamps_below_one() {
        assert_eq!(resolve_profile_ttl(Some(0), 12, false), 1);
        assert_eq!(resolve_profile_ttl(Some(-5), 12, true), 1);
    }

    // ── is_valid_hex_color ─────────────────────────────────────────────

    #[test]
    fn test_is_valid_hex_color() {
        assert!(is_valid_hex_color("#fff"));
        assert!(is_valid_hex_color("#000000"));
        assert!(is_valid_hex_color("#ABCDEF"));
        assert!(!is_valid_hex_color("#abcd")); // 4 digits total (including #)
        assert!(!is_valid_hex_color("fff")); // missing #
        assert!(!is_valid_hex_color("#ghi")); // invalid hex
        assert!(!is_valid_hex_color("#1234567")); // too long
                                                  // Boundary cases
        assert!(!is_valid_hex_color("#")); // empty after #
        assert!(!is_valid_hex_color("#12")); // too short
        assert!(!is_valid_hex_color("#12345")); // uneven length (not 3 or 6 after #)
    }

    // ── parse_ignore_cert ──────────────────────────────────────────────

    #[test]
    fn parse_ignore_cert_bool_true() {
        let extra = Some(json!({ "ignore-cert": true }));
        assert!(parse_ignore_cert(&extra));
    }

    #[test]
    fn parse_ignore_cert_bool_false() {
        let extra = Some(json!({ "ignore-cert": false }));
        assert!(!parse_ignore_cert(&extra));
    }

    #[test]
    fn parse_ignore_cert_string_true() {
        let extra = Some(json!({ "ignore-cert": "true" }));
        assert!(parse_ignore_cert(&extra));
    }

    #[test]
    fn parse_ignore_cert_string_false() {
        let extra = Some(json!({ "ignore-cert": "false" }));
        assert!(!parse_ignore_cert(&extra));
    }

    #[test]
    fn parse_ignore_cert_missing_key() {
        let extra = Some(json!({ "other": "value" }));
        assert!(!parse_ignore_cert(&extra));
    }

    #[test]
    fn parse_ignore_cert_none_extra() {
        assert!(!parse_ignore_cert(&None));
    }

    #[test]
    fn parse_ignore_cert_number_ignored() {
        let extra = Some(json!({ "ignore-cert": 1 }));
        assert!(!parse_ignore_cert(&extra));
    }

    #[test]
    fn parse_ignore_cert_null_value() {
        let extra = Some(json!({ "ignore-cert": null }));
        assert!(!parse_ignore_cert(&extra));
    }
}
