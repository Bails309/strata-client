// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Outbound Quick-Share HTTP routes.
//!
//! User-facing endpoints (gated by `can_use_quick_share_outbound`):
//! - `POST   /api/user/outbound-shares`           — submit a new share (multipart).
//! - `GET    /api/user/outbound-shares`           — list the caller's shares.
//! - `GET    /api/user/outbound-shares/:id/download` — download an approved share.
//!
//! Approver / admin endpoints (gated by [`is_outbound_approver`] or
//! [`check_system_permission`]):
//! - `GET    /api/admin/outbound-shares`             — list everything.
//! - `GET    /api/admin/outbound-shares/pending`     — list pending queue.
//! - `POST   /api/admin/outbound-shares/:id/decide`  — approve / deny.
//! - `DELETE /api/admin/outbound-shares/:id`         — manual purge.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use futures_util::TryStreamExt;
use serde::Deserialize;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::middleware::{
    check_quick_share_outbound_permission, check_system_permission, AuthUser,
};
use crate::services::{outbound_shares, vault};

/// Configurable staging directory for sealed outbound blobs. Falls back
/// to `/tmp/strata-outbound-shares` (Linux containers) or the platform
/// temp dir when that path isn't writable.
fn staging_root() -> PathBuf {
    if let Ok(custom) = std::env::var("STRATA_OUTBOUND_SHARES_DIR") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    let primary = PathBuf::from("/tmp/strata-outbound-shares");
    if std::fs::create_dir_all(&primary).is_ok() {
        return primary;
    }
    std::env::temp_dir().join("strata-outbound-shares")
}

// ── User: submit ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SubmitResponse {
    id: Uuid,
    status: String,
    dlp_score: i32,
    dlp_reasons: Vec<String>,
    /// Only present when the share was auto-approved.
    download_url: Option<String>,
    expires_at: chrono::DateTime<chrono::Utc>,
}

/// `POST /api/user/outbound-shares` — multipart upload.
///
/// Required form fields:
/// - `file`         — the file payload.
///
/// Optional fields:
/// - `session_id`   — the active session id (for audit context).
/// - `connection_id`— UUID of the connection the file came from.
/// - `justification`— free-text reason shown to the approver.
pub async fn submit(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    multipart: axum::extract::Multipart,
) -> Result<Json<SubmitResponse>, AppError> {
    check_quick_share_outbound_permission(&user)?;
    let (pool, vault_cfg, av_scanner, av_fail_mode) = load_pool_vault_and_av(&state).await?;
    let parsed = parse_outbound_multipart(multipart, &av_scanner, av_fail_mode).await?;
    finalize_submit(
        &pool,
        &vault_cfg,
        user.id,
        parsed.session_id.as_deref(),
        parsed.connection_id,
        parsed.justification.as_deref(),
        &parsed.filename,
        &parsed.content_type,
        &parsed.plaintext,
        &parsed.av_verdict,
        parsed.av_backend,
    )
    .await
    .map(Json)
}

/// Shared state-fetch used by both the cookie-auth `submit` handler
/// and the token-auth `ingest_via_token` handler. Returns the DB
/// pool, the active Vault config, the AV scanner handle, and its
/// configured fail-mode — all four are needed to drive
/// `parse_outbound_multipart` and `finalize_submit`.
async fn load_pool_vault_and_av(
    state: &SharedState,
) -> Result<
    (
        sqlx::PgPool,
        crate::config::VaultConfig,
        std::sync::Arc<dyn crate::services::av::Scanner>,
        crate::services::av::FailMode,
    ),
    AppError,
> {
    let s = state.read().await;
    if s.phase != BootPhase::Running {
        return Err(AppError::SetupRequired);
    }
    let pool =
        s.db.as_ref()
            .ok_or_else(|| AppError::Internal("DB not initialised".into()))?
            .pool
            .clone();
    let vault_cfg = s
        .config
        .as_ref()
        .and_then(|c| c.vault.clone())
        .ok_or_else(|| AppError::Vault("Vault is not configured".into()))?;
    Ok((pool, vault_cfg, s.av_scanner.clone(), s.av_fail_mode))
}

/// Result of parsing the outbound-share multipart body.
struct ParsedOutboundUpload {
    filename: String,
    content_type: String,
    plaintext: Vec<u8>,
    session_id: Option<String>,
    connection_id: Option<Uuid>,
    justification: Option<String>,
    /// Verdict from the configured AV scanner. Always present — for
    /// `STRATA_AV_BACKEND=off` it is `Skipped { reason: "scanning
    /// disabled" }`. Persisted into the `outbound_shares.av_*` columns
    /// by `services::outbound_shares::submit`.
    av_verdict: crate::services::av::Verdict,
    /// Backend tag (`off` / `clamav` / `command`) of the scanner that
    /// produced [`av_verdict`]. Persisted alongside so the audit trail
    /// records *which* engine spoke.
    av_backend: &'static str,
}

async fn parse_outbound_multipart(
    mut multipart: axum::extract::Multipart,
    av_scanner: &std::sync::Arc<dyn crate::services::av::Scanner>,
    av_fail_mode: crate::services::av::FailMode,
) -> Result<ParsedOutboundUpload, AppError> {
    let mut session_id: Option<String> = None;
    let mut connection_id: Option<Uuid> = None;
    let mut justification: Option<String> = None;
    let mut file_meta: Option<(String, String, PathBuf, u64)> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "session_id" => {
                session_id = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| AppError::Validation(format!("Invalid session_id: {e}")))?,
                );
            }
            "connection_id" => {
                let s = field
                    .text()
                    .await
                    .map_err(|e| AppError::Validation(format!("Invalid connection_id: {e}")))?;
                if !s.trim().is_empty() {
                    connection_id = Some(
                        Uuid::parse_str(s.trim())
                            .map_err(|_| AppError::Validation("Bad connection_id".into()))?,
                    );
                }
            }
            "justification" => {
                let s = field
                    .text()
                    .await
                    .map_err(|e| AppError::Validation(format!("Invalid justification: {e}")))?;
                if !s.trim().is_empty() {
                    if s.len() > 1024 {
                        return Err(AppError::Validation(
                            "Justification too long (max 1024 chars)".into(),
                        ));
                    }
                    justification = Some(s);
                }
            }
            "file" => {
                let filename = field.file_name().unwrap_or("upload").to_string();
                let content_type = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let temp_path =
                    std::env::temp_dir().join(format!("strata-outbound-{}", Uuid::new_v4()));
                let mut temp_file = tokio::fs::File::create(&temp_path)
                    .await
                    .map_err(|e| AppError::Internal(format!("Failed to create temp file: {e}")))?;
                let mut written: u64 = 0;
                let mut stream = field;
                while let Some(chunk) = stream.try_next().await.map_err(|e| {
                    let _ = std::fs::remove_file(&temp_path);
                    AppError::Validation(format!("Failed to read file: {e}"))
                })? {
                    written += chunk.len() as u64;
                    if written > outbound_shares::MAX_FILE_SIZE {
                        let _ = std::fs::remove_file(&temp_path);
                        return Err(AppError::Validation(
                            "File exceeds maximum allowed size".into(),
                        ));
                    }
                    temp_file.write_all(&chunk).await.map_err(|e| {
                        let _ = std::fs::remove_file(&temp_path);
                        AppError::Internal(format!("Failed to write temp file: {e}"))
                    })?;
                }
                temp_file.flush().await.map_err(|e| {
                    let _ = std::fs::remove_file(&temp_path);
                    AppError::Internal(format!("Failed to flush temp file: {e}"))
                })?;
                drop(temp_file);
                file_meta = Some((filename, content_type, temp_path, written));
            }
            _ => {}
        }
    }

    let (filename, content_type, temp_path, _size) =
        file_meta.ok_or_else(|| AppError::Validation("Missing file field".into()))?;

    // ── AV scan (W7-1) ────────────────────────────────────────────────
    //
    // Scan the on-disk temp file *before* we load it into memory and
    // *before* the service layer seals it via Vault — sealing destroys
    // the only thing the scanner could match a signature against. A
    // blocking verdict (Infected, or Error in fail_mode=Block) deletes
    // the temp file and short-circuits the request so the sealed blob
    // and the DB row are never created. The verdict is plumbed down to
    // `submit()` even when allowed, so the row records *which* engine
    // saw the file and *what* it said (including the bypass cases:
    // Skipped/oversize, Skipped/scanning-disabled, allowed-Error).
    let av_verdict = av_scanner.scan(&temp_path).await;
    let av_backend = av_scanner.backend_tag();
    if av_verdict.blocks(av_fail_mode) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let msg = match &av_verdict {
            crate::services::av::Verdict::Infected { signature } => {
                format!("File rejected by malware scan: {signature}")
            }
            crate::services::av::Verdict::Error { message } => {
                format!("Antivirus scan failed: {message}")
            }
            crate::services::av::Verdict::Clean | crate::services::av::Verdict::Skipped { .. } => {
                unreachable!()
            }
        };
        tracing::warn!(
            filename = %filename,
            av_status = av_verdict.as_str(),
            av_signature = ?av_verdict.signature(),
            av_backend = av_backend,
            "Outbound Quick Share upload blocked by AV scan"
        );
        return Err(AppError::Validation(msg));
    }

    // Load plaintext from temp file. The submit() service seals it via
    // Vault before writing to the staging directory.
    let plaintext = tokio::fs::read(&temp_path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read upload temp: {e}")))?;
    let _ = tokio::fs::remove_file(&temp_path).await;

    Ok(ParsedOutboundUpload {
        filename,
        content_type,
        plaintext,
        session_id,
        connection_id,
        justification,
        av_verdict,
        av_backend,
    })
}

/// Run the per-user approval lookup and seal-and-stage submit. Used
/// by both the cookie-auth `submit` handler and the token-auth
/// `ingest_via_token` handler.
#[allow(clippy::too_many_arguments)]
async fn finalize_submit(
    pool: &sqlx::PgPool,
    vault_cfg: &crate::config::VaultConfig,
    user_id: Uuid,
    session_id: Option<&str>,
    connection_id: Option<Uuid>,
    justification: Option<&str>,
    filename: &str,
    content_type: &str,
    plaintext: &[u8],
    av_verdict: &crate::services::av::Verdict,
    av_backend: &'static str,
) -> Result<SubmitResponse, AppError> {
    // Approval is required by default for every outbound submission;
    // the only way to bypass is an explicit per-user opt-out
    // (`users.outbound_share_requires_approval = FALSE`). When that
    // flag is set the share is auto-approved unconditionally — the
    // DLP score is still computed and surfaced for audit but does NOT
    // override the bypass. Migration 076 dropped the role-level toggle
    // introduced in 075 — the role layer now governs only whether the
    // feature is available at all (`can_use_quick_share_outbound`).
    // NULL on the user column means "use the system default (require
    // approval)"; an unknown/deleted user likewise falls back to TRUE.
    let requires_approval: bool = sqlx::query_scalar(
        "SELECT COALESCE(outbound_share_requires_approval, TRUE)
         FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .unwrap_or(true);

    // Enforce the justification gate BEFORE we seal the plaintext into
    // the staging directory: a denied request shouldn't leave a sealed
    // blob behind for a janitor task to clean up, and the user gets a
    // crisp error instead of an opaque internal failure.
    validate_outbound_justification(requires_approval, justification)?;

    let staging = staging_root();

    let outcome = outbound_shares::submit(
        pool,
        vault_cfg,
        outbound_shares::SubmitInput {
            requester_user_id: user_id,
            session_id,
            connection_id,
            filename,
            content_type,
            justification,
            plaintext,
            staging_root: &staging,
            requires_approval,
            av_verdict,
            av_backend,
        },
    )
    .await?;

    let download_url = outcome
        .download_token
        .as_ref()
        .map(|t| format!("/api/user/outbound-shares/download/{t}"));

    Ok(SubmitResponse {
        id: outcome.id,
        status: outcome.status.as_str().to_string(),
        dlp_score: outcome.dlp_score,
        dlp_reasons: outcome.dlp_reasons,
        download_url,
        expires_at: outcome.expires_at,
    })
}

// ── User: issue in-session upload token ─────────────────────────────

#[derive(Deserialize, Default)]
pub struct IssueIngestTokenRequest {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    #[serde(default)]
    pub justification: Option<String>,
}

#[derive(serde::Serialize)]
pub struct IssueIngestTokenResponse {
    pub token: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    /// `POST` target the SPA renders into the curl / Invoke-WebRequest
    /// snippet. Always a relative path; the SPA prefixes its own
    /// origin (so reverse-proxy hostnames work without server-side
    /// awareness of the public URL).
    pub upload_path: String,
}

/// `POST /api/user/outbound-shares/ingest-token` — mint a one-shot
/// upload token scoped to the calling user. The SPA renders the
/// token into a `curl` / `Invoke-WebRequest` command the user pastes
/// inside the remote session shell. Approval, DLP, and audit run
/// against the user who minted the token, not against whatever
/// principal happens to execute the snippet.
pub async fn issue_ingest_token(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    headers: axum::http::HeaderMap,
    Json(body): Json<IssueIngestTokenRequest>,
) -> Result<Json<IssueIngestTokenResponse>, AppError> {
    check_quick_share_outbound_permission(&user)?;
    let pool = require_pool(&state).await?;

    // Bound the justification at mint time so we don't store unbounded
    // strings in the token table.
    if let Some(j) = body.justification.as_ref() {
        if j.len() > 1024 {
            return Err(AppError::Validation(
                "Justification too long (max 1024 chars)".into(),
            ));
        }
    }

    // Enforce the same "justification required when approval is
    // required" rule as the cookie-auth submit path. We catch it here
    // — at mint time — so the user gets the error in the SPA instead
    // of after they've pasted the snippet into the remote session and
    // the upload comes back denied. `finalize_submit` re-validates as
    // a defence-in-depth backstop in case the multipart `justification`
    // field overrides the token-supplied one with garbage.
    let requires_approval: bool = sqlx::query_scalar(
        "SELECT COALESCE(outbound_share_requires_approval, TRUE)
         FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_optional(&pool)
    .await?
    .unwrap_or(true);
    validate_outbound_justification(requires_approval, body.justification.as_deref())?;

    let client_ip = crate::routes::auth::extract_client_ip(&headers);

    let minted = crate::services::outbound_share_ingest::mint(
        &pool,
        user.id,
        body.session_id.as_deref(),
        body.connection_id,
        body.justification.as_deref(),
        Some(&client_ip),
    )
    .await?;

    let _ = crate::services::audit::log(
        &pool,
        Some(user.id),
        "outbound_share.ingest_token.minted",
        &serde_json::json!({
            "session_id": body.session_id,
            "connection_id": body.connection_id,
            "expires_at": minted.expires_at,
            "ip": client_ip,
        }),
    )
    .await;

    Ok(Json(IssueIngestTokenResponse {
        token: minted.token.clone(),
        expires_at: minted.expires_at,
        upload_path: format!("/api/outbound-shares/ingest/{}", minted.token),
    }))
}

// ── Public: token-auth ingest ───────────────────────────────────────

/// `POST /api/outbound-shares/ingest/{token}` — UNAUTHENTICATED.
///
/// The token is the auth. It is single-use, expires after 10 minutes,
/// and was minted for a specific user + session + connection +
/// justification context which is reapplied here so the audit chain
/// matches the cookie-auth `submit` path. The remote-session shell
/// only has to know how to POST a multipart `file` field.
pub async fn ingest_via_token(
    State(state): State<SharedState>,
    Path(token): Path<String>,
    headers: axum::http::HeaderMap,
    multipart: axum::extract::Multipart,
) -> Result<Json<SubmitResponse>, AppError> {
    let (pool, vault_cfg, av_scanner, av_fail_mode) = load_pool_vault_and_av(&state).await?;

    let client_ip = crate::routes::auth::extract_client_ip(&headers);

    // Consume FIRST so any failure (oversize, bad form, vault error)
    // burns the token — prevents replay of a partially-valid upload.
    let ctx =
        crate::services::outbound_share_ingest::consume(&pool, &token, Some(&client_ip)).await?;

    // Re-check the requester's permission at consume time so a token
    // minted by a user whose role was revoked in the intervening
    // window can't sneak a file out.
    let allowed: Option<bool> = sqlx::query_scalar(
        "SELECT r.can_use_quick_share_outbound
           FROM users u
           JOIN roles r ON r.id = u.role_id
          WHERE u.id = $1",
    )
    .bind(ctx.user_id)
    .fetch_optional(&pool)
    .await?;
    if !matches!(allowed, Some(true)) {
        return Err(AppError::Forbidden);
    }

    let parsed = parse_outbound_multipart(multipart, &av_scanner, av_fail_mode).await?;

    // Token-supplied context wins over anything the multipart
    // happens to include — the remote shell shouldn't be able to
    // launder a different session_id into the audit log.
    let session_id = ctx.session_id.as_deref().or(parsed.session_id.as_deref());
    let connection_id = ctx.connection_id.or(parsed.connection_id);
    let justification = ctx
        .justification
        .as_deref()
        .or(parsed.justification.as_deref());

    let response = finalize_submit(
        &pool,
        &vault_cfg,
        ctx.user_id,
        session_id,
        connection_id,
        justification,
        &parsed.filename,
        &parsed.content_type,
        &parsed.plaintext,
        &parsed.av_verdict,
        parsed.av_backend,
    )
    .await?;

    let _ = crate::services::audit::log(
        &pool,
        Some(ctx.user_id),
        "outbound_share.ingest_token.consumed",
        &serde_json::json!({
            "share_id": response.id,
            "session_id": session_id,
            "connection_id": connection_id,
            "filename": parsed.filename,
            "size": parsed.plaintext.len(),
            "ip": client_ip,
        }),
    )
    .await;

    Ok(Json(response))
}

// ── User: list own shares ───────────────────────────────────────────

pub async fn list_mine(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<outbound_shares::OutboundShare>>, AppError> {
    check_quick_share_outbound_permission(&user)?;
    let pool = require_pool(&state).await?;
    let rows = outbound_shares::list_for_user(&pool, user.id).await?;
    Ok(Json(rows))
}

// ── User: download via one-shot token ───────────────────────────────

/// `GET /api/user/outbound-shares/download/:token` — capability URL.
///
/// The token IS the auth; we still require an authenticated user so we
/// can audit who downloaded what.
pub async fn download(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(token): Path<String>,
) -> Result<Response, AppError> {
    check_quick_share_outbound_permission(&user)?;

    let (pool, vault_cfg) = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        let pool =
            s.db.as_ref()
                .ok_or_else(|| AppError::Internal("DB not initialised".into()))?
                .pool
                .clone();
        let vault_cfg = s
            .config
            .as_ref()
            .and_then(|c| c.vault.clone())
            .ok_or_else(|| AppError::Vault("Vault is not configured".into()))?;
        (pool, vault_cfg)
    };

    let mat = outbound_shares::consume_download_token(&pool, &token).await?;

    // Only the requester (or a system admin) can fetch their own bytes.
    if mat.share.requester_user_id != user.id && !user.can_manage_system {
        return Err(AppError::Forbidden);
    }

    let plaintext = vault::unseal(&vault_cfg, &mat.sealed_dek, &mat.ciphertext, &mat.nonce).await?;

    let filename = mat.share.filename.clone();
    let content_type = mat.share.content_type.clone();

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", sanitize_filename(&filename)),
        )
        .header(header::CONTENT_LENGTH, plaintext.len())
        .body(Body::from(plaintext))
        .map_err(|e| AppError::Internal(format!("Response build error: {e}")))?;
    Ok(response)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c == '"' || c == '\n' || c == '\r' {
                '_'
            } else {
                c
            }
        })
        .collect()
}

// ── Admin/approver routes ───────────────────────────────────────────

/// Only outbound-share approvers (or super-admins) can hit the admin
/// surface. Centralised so every route in this module follows the same
/// gate.
async fn require_approver(
    pool: &sqlx::Pool<sqlx::Postgres>,
    user: &AuthUser,
) -> Result<(), AppError> {
    // Super-admin bypass.
    if user.can_manage_system {
        return Ok(());
    }
    let is_approver = outbound_shares::is_outbound_approver(pool, user.id).await?;
    if is_approver {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

pub async fn list_all(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<outbound_shares::OutboundShare>>, AppError> {
    let pool = require_pool(&state).await?;
    require_approver(&pool, &user).await?;
    let rows = outbound_shares::list_all(&pool).await?;
    Ok(Json(rows))
}

pub async fn list_pending(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<outbound_shares::OutboundShare>>, AppError> {
    let pool = require_pool(&state).await?;
    require_approver(&pool, &user).await?;
    let rows = outbound_shares::list_pending(&pool).await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct DecideRequest {
    pub approve: bool,
    pub reason: Option<String>,
}

#[derive(serde::Serialize)]
pub struct DecideResponse {
    pub id: Uuid,
    pub status: String,
    /// Only present when approved.
    pub download_url: Option<String>,
}

pub async fn decide(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<DecideRequest>,
) -> Result<Json<DecideResponse>, AppError> {
    let pool = require_pool(&state).await?;
    require_approver(&pool, &user).await?;

    let outcome = outbound_shares::decide(
        &pool,
        outbound_shares::DecideInput {
            share_id: id,
            approver_user_id: user.id,
            approve: body.approve,
            reason: body.reason.as_deref(),
            caller_is_super_admin: user.can_manage_system,
        },
    )
    .await?;

    let download_url = outcome
        .download_token
        .as_ref()
        .map(|t| format!("/api/user/outbound-shares/download/{t}"));

    Ok(Json(DecideResponse {
        id: outcome.id,
        status: outcome.status.as_str().to_string(),
        download_url,
    }))
}

/// `DELETE /api/admin/outbound-shares/:id` — manual purge.
pub async fn purge(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    // Manual purge is a destructive admin op — system-perm required.
    check_system_permission(&user)?;
    let pool = require_pool(&state).await?;

    let share = outbound_shares::find(&pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Share not found".into()))?;

    if let Some(path) = share.storage_path.as_deref() {
        let _ = tokio::fs::remove_file(path).await;
    }

    sqlx::query(
        "UPDATE outbound_shares
         SET status = 'purged',
             sealed_dek_ciphertext = NULL,
             sealed_dek_nonce = NULL,
             storage_path = NULL,
             download_token = NULL,
             purged_at = NOW()
         WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await?;

    let _ = crate::services::audit::log(
        &pool,
        Some(user.id),
        "outbound_share.purged",
        &serde_json::json!({ "share_id": id, "manual": true }),
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

// ── Approver list management (super-admin only) ─────────────────────

/// `GET /api/admin/outbound-shares/approvers` — list every user who
/// can decide outbound-share requests. Super-admins (`can_manage_system`)
/// are implicit approvers; this list is the *additional* delegations.
pub async fn list_approvers(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<outbound_shares::OutboundShareApproverRow>>, AppError> {
    check_system_permission(&user)?;
    let pool = require_pool(&state).await?;
    let rows = outbound_shares::list_approvers(&pool).await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct AddApproverRequest {
    pub user_id: Uuid,
}

/// `POST /api/admin/outbound-shares/approvers` — add a user to the
/// approver list. Idempotent.
pub async fn add_approver(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Json(body): Json<AddApproverRequest>,
) -> Result<StatusCode, AppError> {
    check_system_permission(&user)?;
    let pool = require_pool(&state).await?;
    let inserted = outbound_shares::add_approver(&pool, body.user_id).await?;
    if inserted {
        let _ = crate::services::audit::log(
            &pool,
            Some(user.id),
            "outbound_share.approver_added",
            &serde_json::json!({ "user_id": body.user_id }),
        )
        .await;
    }
    Ok(if inserted {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    })
}

/// `DELETE /api/admin/outbound-shares/approvers/:user_id` — remove a
/// user from the approver list. Returns 204 even when the user wasn't
/// an approver (idempotent), so the UI doesn't need to track state.
pub async fn remove_approver(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(user_id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    check_system_permission(&user)?;
    let pool = require_pool(&state).await?;
    let removed = outbound_shares::remove_approver(&pool, user_id).await?;
    if removed {
        let _ = crate::services::audit::log(
            &pool,
            Some(user.id),
            "outbound_share.approver_removed",
            &serde_json::json!({ "user_id": user_id }),
        )
        .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

// ── Helpers ─────────────────────────────────────────────────────────

async fn require_pool(state: &SharedState) -> Result<sqlx::Pool<sqlx::Postgres>, AppError> {
    let guard = state.read().await;
    guard
        .db
        .as_ref()
        .map(|d| d.pool.clone())
        .ok_or_else(|| AppError::Internal("database not configured".into()))
}

/// Minimum justification length when approval is required.
///
/// Mirrors `MIN_JUSTIFICATION_LEN` in the credential-checkout flow
/// (`routes/user.rs::checkout`) so users see one consistent rule:
/// any approval-gated operation needs at least 10 chars of reasoning
/// that the approver can act on. A handful of words like "audit ticket
/// INC-1234" easily clears the bar; a stray space or "asdf" does not.
const MIN_OUTBOUND_JUSTIFICATION_LEN: usize = 10;

/// Enforce the per-user "justification required when approval is
/// required" rule. Returns `Ok(())` when the user has the
/// `outbound_share_requires_approval = FALSE` bypass; otherwise the
/// trimmed justification must be at least
/// [`MIN_OUTBOUND_JUSTIFICATION_LEN`] characters.
///
/// Pulled out as a pure function so both the multipart `submit`
/// chokepoint and the `issue_ingest_token` mint endpoint share one
/// implementation, and so it can be unit-tested without a DB.
fn validate_outbound_justification(
    requires_approval: bool,
    justification: Option<&str>,
) -> Result<(), AppError> {
    if !requires_approval {
        return Ok(());
    }
    let trimmed = justification.unwrap_or("").trim();
    if trimmed.chars().count() < MIN_OUTBOUND_JUSTIFICATION_LEN {
        return Err(AppError::Validation(format!(
            "A justification of at least {MIN_OUTBOUND_JUSTIFICATION_LEN} characters is required for outbound shares unless the approval bypass is enabled for your account."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_strips_dangerous_chars() {
        assert_eq!(sanitize_filename("hello.txt"), "hello.txt");
        assert_eq!(sanitize_filename("evil\".txt"), "evil_.txt");
        assert_eq!(sanitize_filename("two\nlines"), "two_lines");
    }

    #[test]
    fn staging_root_returns_writable_path() {
        // The function must always return *some* path; we can't assert
        // a specific value because the env can override it.
        let p = staging_root();
        assert!(!p.as_os_str().is_empty());
    }

    #[test]
    fn justification_not_required_when_bypass_enabled() {
        // The bypass user can submit with no justification at all.
        assert!(validate_outbound_justification(false, None).is_ok());
        assert!(validate_outbound_justification(false, Some("")).is_ok());
        assert!(validate_outbound_justification(false, Some("   ")).is_ok());
        assert!(validate_outbound_justification(false, Some("x")).is_ok());
    }

    #[test]
    fn justification_required_when_approval_required() {
        // Missing / empty / whitespace / too-short all fail with a
        // Validation error.
        for input in [None, Some(""), Some("   "), Some("too short")] {
            let err = validate_outbound_justification(true, input)
                .expect_err("expected Err for input {input:?}");
            assert!(
                matches!(err, AppError::Validation(_)),
                "expected Validation error, got {err:?}"
            );
        }
        // Exactly the minimum length passes.
        assert!(validate_outbound_justification(true, Some("1234567890")).is_ok());
        // Well above the minimum passes.
        assert!(
            validate_outbound_justification(true, Some("Audit ticket INC-1234, urgent fix."))
                .is_ok()
        );
        // Surrounding whitespace is trimmed before measuring.
        assert!(validate_outbound_justification(true, Some("   1234567890   ")).is_ok());
        assert!(validate_outbound_justification(true, Some("   short   ")).is_err());
    }

    #[test]
    fn justification_counts_chars_not_bytes() {
        // 10 multibyte chars (é) = 20 bytes but should still satisfy the
        // chars().count() check.
        let ten_e_accent: String = "é".repeat(10);
        assert!(validate_outbound_justification(true, Some(&ten_e_accent)).is_ok());
        let nine_e_accent: String = "é".repeat(9);
        assert!(validate_outbound_justification(true, Some(&nine_e_accent)).is_err());
    }
}
