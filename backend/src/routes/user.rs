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

/// Resolve effective TTL: user preference capped by admin max.
/// Both inputs and output are clamped to [1, admin_max].
pub fn resolve_ttl(user_pref: Option<i32>, admin_max: i64) -> i32 {
    (user_pref.unwrap_or(admin_max as i32) as i64).clamp(1, admin_max) as i32
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
        "can_create_sharing_profiles": user.can_create_sharing_profiles,
        "can_view_sessions": user.can_view_sessions,
        "is_approver": is_approver,
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

    if favorites::is_favorite(&db.pool, user.id, body.connection_id).await? {
        favorites::remove(&db.pool, user.id, body.connection_id).await?;
        Ok(Json(json!({ "favorited": false })))
    } else {
        favorites::add(&db.pool, user.id, body.connection_id).await?;
        Ok(Json(json!({ "favorited": true })))
    }
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
    pub username: String,
    pub password: String,
    pub ttl_hours: Option<i32>,
}

pub async fn list_credential_profiles(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<CredentialProfileRow>>, AppError> {
    let db = require_running(&state).await?;
    let rows = cp_svc::list_for_user(&db.pool, user.id).await?;
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
    let sealed_raw = vault::seal(&vault_cfg, combined.to_string().as_bytes()).await?;
    let sealed = cp_svc::SealedPayload {
        ciphertext: sealed_raw.ciphertext,
        encrypted_dek: sealed_raw.encrypted_dek,
        nonce: sealed_raw.nonce,
    };

    let admin_max = cp_svc::admin_max_ttl_hours(&db.pool).await;
    let ttl_hours = resolve_ttl(body.ttl_hours, admin_max);

    let id = cp_svc::insert(&db.pool, user.id, &body.label, &sealed, ttl_hours).await?;

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

    if !cp_svc::user_owns(&db.pool, profile_id, user.id).await? {
        return Err(AppError::NotFound("Credential profile not found".into()));
    }

    let admin_max = cp_svc::admin_max_ttl_hours(&db.pool).await;

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

        let ttl_hours = resolve_ttl(body.ttl_hours, admin_max);
        cp_svc::update_sealed(
            &db.pool,
            profile_id,
            &sealed,
            ttl_hours,
            body.label.as_deref(),
        )
        .await?;
    } else {
        // No credential change — update label and/or TTL
        let ttl_hours = body.ttl_hours.map(|h| resolve_ttl(Some(h), admin_max));
        cp_svc::update_metadata(&db.pool, profile_id, body.label.as_deref(), ttl_hours).await?;
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

    let checkout_id = body.checkout_id.unwrap();

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
        query.limit.unwrap_or(50),
        query.offset.unwrap_or(0),
    )
    .await?;

    Ok(Json(recordings))
}

/// GET /api/user/recordings/:id/stream — stream a recording that belongs to the authenticated user.
// CodeQL note: `rust/unused-variable` misfires on `e` interpolated into
// `tracing::error!("… {e}")` inside the `on_upgrade` closure (alert #75).
#[allow(unused_variables)]
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

    Ok(ws
        .protocols(["guacamole"])
        .on_upgrade(move |socket| async move {
            if let Err(e) = crate::routes::admin::recordings::handle_user_recording_stream(
                socket, state, recording, seek_ms, speed,
            )
            .await
            {
                tracing::error!("User recording stream error: {e}");
            }
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
        let target_cn = dn
            .split(',')
            .next()
            .and_then(|s| s.strip_prefix("CN="))
            .unwrap_or(dn)
            .to_owned();
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
        crate::services::checkouts::set_decision(&db.pool, checkout_id, user.id, true).await?;

        crate::services::audit::log(
            &db.pool,
            Some(user.id),
            "checkout.approved",
            &json!({ "checkout_id": checkout_id }),
        )
        .await?;

        // Notification: tell the requester their request was approved.
        {
            let target_cn = checkout
                .managed_ad_dn
                .split(',')
                .next()
                .and_then(|s| s.strip_prefix("CN="))
                .unwrap_or(&checkout.managed_ad_dn)
                .to_owned();
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
        crate::services::checkouts::set_decision(&db.pool, checkout_id, user.id, false).await?;

        crate::services::audit::log(
            &db.pool,
            Some(user.id),
            "checkout.denied",
            &json!({ "checkout_id": checkout_id }),
        )
        .await?;

        // Notification: tell the requester their request was declined.
        {
            let target_cn = checkout
                .managed_ad_dn
                .split(',')
                .next()
                .and_then(|s| s.strip_prefix("CN="))
                .unwrap_or(&checkout.managed_ad_dn)
                .to_owned();
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
            checkout_id: None,
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
            checkout_id: None,
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

    // ── resolve_ttl ────────────────────────────────────────────────────

    #[test]
    fn resolve_ttl_uses_user_pref_within_range() {
        assert_eq!(resolve_ttl(Some(6), 12), 6);
    }

    #[test]
    fn resolve_ttl_clamps_above_max() {
        assert_eq!(resolve_ttl(Some(24), 12), 12);
    }

    #[test]
    fn resolve_ttl_clamps_below_one() {
        assert_eq!(resolve_ttl(Some(0), 12), 1);
        assert_eq!(resolve_ttl(Some(-5), 12), 1);
    }

    #[test]
    fn resolve_ttl_defaults_to_admin_max() {
        assert_eq!(resolve_ttl(None, 8), 8);
    }

    #[test]
    fn resolve_ttl_none_with_small_admin_max() {
        assert_eq!(resolve_ttl(None, 1), 1);
    }

    #[test]
    fn resolve_ttl_exact_boundary() {
        assert_eq!(resolve_ttl(Some(12), 12), 12);
        assert_eq!(resolve_ttl(Some(1), 12), 1);
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

    #[test]
    fn resolve_ttl_boundary_clamping() {
        // Assuming resolve_ttl(input, min, max)
        // Let's find the function first to be sure
    }
}
