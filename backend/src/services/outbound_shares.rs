// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Outbound Quick-Share (session → endpoint, approval-gated).
//!
//! Allows users sitting at a remote session to ship a file back to their
//! own workstation through Strata. Files are envelope-encrypted via Vault
//! Transit at rest, blocked behind a per-user "requires approval" gate
//! (default ON), and surfaced to a small set of designated approvers who
//! decide accept/deny before the requester can download.
//!
//! Lifecycle:
//!
//! 1. `submit()` — the staged upload is encrypted chunk by chunk
//!    ([`file_crypto`]) under a per-file key wrapped by Vault Transit,
//!    and the wrapped key is stored in the DB. A basic DLP scorer runs on the
//!    filename/MIME/size and records a score + reasons for audit/UI
//!    surfacing. If the user has `outbound_share_requires_approval = false`
//!    (admin override), status transitions to `Approved` and a one-shot
//!    `download_token` is generated immediately — the DLP score is
//!    recorded but does not gate the auto-approval. Otherwise status is
//!    `Pending` and an approver must decide.
//! 2. `decide()` — only an outbound-share approver (entry in
//!    `outbound_share_approvers`) can flip a `Pending` row to `Approved` or
//!    `Denied`. Denial purges the blob and clears the sealed key columns;
//!    approval mints a one-shot `download_token`.
//! 3. `consume_download_token()` — atomic; row is locked, the caller is
//!    authorised and the blob unsealed, then status flips to
//!    `Downloaded` and the token is cleared so the link is genuinely
//!    one-shot.
//! 4. `purge_expired()` — periodic worker (hourly). Two-phase sweep:
//!    (a) **Zeroise**: any row past `expires_at` (default
//!    [`DEFAULT_TTL_DAYS`] = 1 day from `created_at`) that has not been
//!    purged has its blob unlinked, sealed DEK/nonce + storage_path +
//!    download_token NULL'd, and `purged_at` stamped. `Pending`/`Approved`
//!    rows flip to `Purged`; `Downloaded`/`Denied` keep their status so
//!    the history still records *how* the row ended.
//!    (b) **Hard-delete**: any row whose `purged_at` is older than
//!    [`HISTORY_RETENTION_AFTER_PURGE_DAYS`] = 7 days is removed from
//!    the table entirely so the admin history doesn't grow without bound.
//!
//! Audit events: `outbound_share.requested`, `outbound_share.decided`,
//! `outbound_share.downloaded`, `outbound_share.purged`,
//! `outbound_share.removed` (hard-delete after retention).

use crate::config::VaultConfig;
use crate::error::AppError;
use crate::services::{audit, file_crypto, vault};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Postgres};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;
use uuid::Uuid;

/// Maximum staged file size (mirrors inbound Quick Share).
pub const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;

/// Default TTL applied to every staged outbound share, in days. Short
/// by design: outbound shares are an export gate, not an archive — once
/// the requester (or approver) has had a chance to act, the staged
/// blob and sealed DEK should be wiped from disk. `chrono::Duration::days`
/// is not a `const fn` in chrono 0.4, so we expose the integer here
/// and build the `Duration` at use sites.
pub const DEFAULT_TTL_DAYS: i64 = 1;

/// How long an `outbound_shares` row remains in the table (visible in
/// the admin history) after its `purged_at` timestamp before being
/// hard-deleted by Phase 2 of [`purge_expired`]. The row no longer
/// carries any secret material once `purged_at` is set — this window
/// is purely for human-readable audit/history surfacing.
pub const HISTORY_RETENTION_AFTER_PURGE_DAYS: i64 = 7;

/// Default TTL applied to every staged outbound share.
#[inline]
pub fn default_ttl() -> Duration {
    Duration::days(DEFAULT_TTL_DAYS)
}

/// Reference threshold representing "this submission would be considered
/// high-risk by the heuristic DLP scorer." No longer used as a runtime
/// gate — the per-user `outbound_share_requires_approval = FALSE` bypass
/// is an unconditional admin override and submissions from non-bypassed
/// users are always queued regardless of score (see [`submit`]). Kept as
/// a `pub` constant because the tests and the [`compute_dlp_score`]
/// docstring reference it as the documented "would-be-flagged" boundary.
/// Pure heuristic — designed to be loud, not airtight.
#[allow(dead_code)]
pub const DLP_AUTO_FLAG_SCORE: i32 = 50;

/// Status of an outbound share row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutboundShareStatus {
    /// Awaiting an approver decision.
    Pending,
    /// Approved — a one-shot download token is available.
    Approved,
    /// Denied by an approver. Blob purged.
    Denied,
    /// Already downloaded; one-shot token consumed.
    Downloaded,
    /// Expired or denied → blob removed from disk.
    Purged,
}

impl OutboundShareStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Downloaded => "downloaded",
            Self::Purged => "purged",
        }
    }
}

/// Row in `outbound_shares`. Sealed DEK / nonce / on-disk path are present
/// only while the file is still staged on disk (i.e. not yet purged).
#[derive(Debug, Clone, FromRow, Serialize)]
pub struct OutboundShare {
    pub id: Uuid,
    pub requester_user_id: Uuid,
    pub session_id: Option<String>,
    pub connection_id: Option<Uuid>,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub sha256: String,
    pub storage_path: Option<String>,
    #[serde(skip_serializing)]
    pub sealed_dek_ciphertext: Option<Vec<u8>>,
    #[serde(skip_serializing)]
    pub sealed_dek_nonce: Option<Vec<u8>>,
    pub justification: Option<String>,
    pub dlp_score: i32,
    pub dlp_reasons: serde_json::Value,
    pub status: String,
    pub decided_by: Option<Uuid>,
    pub decided_at: Option<DateTime<Utc>>,
    pub decision_reason: Option<String>,
    // Held in the row so SELECT lists can use a single column set.
    // Surfaced in JSON so the requester (and approvers/super-admins,
    // who are the only other callers that can list shares) can build
    // a `/api/user/outbound-shares/download/<token>` URL without an
    // extra round-trip. The download endpoint itself still re-checks
    // requester / super-admin before serving the file, so leaking the
    // token to a same-tenant approver is not a privilege escalation.
    pub download_token: Option<String>,
    pub downloaded_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub purged_at: Option<DateTime<Utc>>,
    /// Username of the requester. Populated by [`list_pending`] /
    /// [`list_all`] via a LEFT JOIN so approvers without
    /// `can_manage_users` (i.e. non-admin compliance officers viewing
    /// the queue from `/approvals`) still see a friendly name. Other
    /// queries (`find`, `decide`, `consume_download_token`,
    /// `list_for_user`) leave it `None` — `#[sqlx(default)]` allows
    /// the column to be absent from the SELECT.
    #[sqlx(default)]
    pub requester_username: Option<String>,
    /// Encrypted format of the staged blob; see migration 100. Selected
    /// only where the blob is read.
    #[sqlx(default)]
    #[serde(skip_serializing)]
    pub blob_format: i16,
}

/// Input for [`submit`]. Caller has already streamed the upload to disk.
pub struct SubmitInput<'a> {
    pub requester_user_id: Uuid,
    pub session_id: Option<&'a str>,
    pub connection_id: Option<Uuid>,
    pub filename: &'a str,
    pub content_type: &'a str,
    pub justification: Option<&'a str>,
    /// The plaintext, staged on disk. Left in place for the caller to remove.
    pub source: &'a Path,
    pub staging_root: &'a Path,
    pub requires_approval: bool,
    /// Verdict from the AV scanner that inspected the upload's temp
    /// file *before* sealing. Persisted into the `av_*` columns. The
    /// route layer is responsible for blocking Infected uploads
    /// before they reach this function — by the time we're here the
    /// verdict is informational (Clean / Skipped / allowed-Error).
    pub av_verdict: &'a crate::services::av::Verdict,
    /// Backend tag (`off` / `clamav` / `command`) of the scanner that
    /// produced [`av_verdict`]. Persisted alongside the verdict so the
    /// audit trail records *which* engine spoke.
    pub av_backend: &'a str,
}

/// Outcome of a successful [`submit`] call. Returned to the caller so it
/// can decide whether to surface a download URL straight away (Approved
/// path) or just confirm receipt (Pending path).
#[derive(Debug, Serialize)]
pub struct SubmitOutcome {
    pub id: Uuid,
    pub status: OutboundShareStatus,
    pub dlp_score: i32,
    pub dlp_reasons: Vec<String>,
    pub download_token: Option<String>,
    pub expires_at: DateTime<Utc>,
    /// Plaintext bytes staged.
    pub size: u64,
}

// ── Bounded file encryption (PERF-03) ───────────────────────────────────────

/// How long a transfer may wait for an encryption slot before it is refused.
const CRYPTO_QUEUE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

static CRYPTO_SLOTS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(crypto_slots())));

/// Concurrent file encryptions and verifications:
/// `STRATA_FILE_CRYPTO_CONCURRENCY`, else one per CPU up to 4.
fn crypto_slots() -> usize {
    std::env::var("STRATA_FILE_CRYPTO_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n: &usize| *n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map_or(1, |n| n.get())
                .min(4)
        })
}

/// Run a whole-file crypto job on the blocking pool, a bounded number at a
/// time. The slot and the job's result belong to the task, so a cancelled
/// request neither frees the slot early nor strands what the job produced.
async fn run_crypto<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppError> {
    let permit = tokio::time::timeout(CRYPTO_QUEUE_WAIT, Arc::clone(&CRYPTO_SLOTS).acquire_owned())
        .await
        .map_err(|_| AppError::RateLimited("The server is busy. Please try again.".into()))?
        .map_err(|_| AppError::Internal("file encryption unavailable".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        job()
    })
    .await
    .map_err(|e| AppError::Internal(format!("file encryption failed: {e}")))
}

/// A staged blob that is deleted when dropped unless [`kept`](Self::keep).
struct StagedBlob(Option<PathBuf>);

impl StagedBlob {
    fn keep(mut self) {
        self.0 = None;
    }
}

impl Drop for StagedBlob {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

// ── Submission ────────────────────────────────────────────────────────

/// Stage and persist a new outbound share. Always seals via Vault.
///
/// Auto-approval happens iff `requires_approval == false`. The DLP
/// score is computed and persisted in either case for audit/UI
/// surfacing, but it does not gate auto-approval — the per-user bypass
/// is a deliberate admin override that says "trust this user". When
/// `requires_approval == true` the row is created in `Pending` for an
/// approver to decide regardless of DLP score.
pub async fn submit(
    pool: &Pool<Postgres>,
    vault_cfg: &VaultConfig,
    input: SubmitInput<'_>,
) -> Result<SubmitOutcome, AppError> {
    let size = tokio::fs::metadata(input.source)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read upload: {e}")))?
        .len();
    if size == 0 {
        return Err(AppError::Validation("Empty file".into()));
    }
    if size > MAX_FILE_SIZE {
        return Err(AppError::Validation(
            "File exceeds maximum allowed size".into(),
        ));
    }

    // Encrypt to the staging root under a per-file key wrapped by Vault.
    // Ciphertext lives on disk and the wrapped key in the DB, so
    // decrypting needs *both* file-system and DB access. The plaintext is
    // hashed while it is read so the receiver / auditor can verify
    // integrity end-to-end.
    let id = Uuid::new_v4();
    let (key, wrapped_key) = vault::new_data_key(vault_cfg).await?;
    let storage_path = ensure_staging_path(input.staging_root, id).await?;
    let source = input.source.to_path_buf();
    let dst = storage_path.clone();
    let blob = StagedBlob(Some(storage_path.clone()));
    let (blob, sealed) = run_crypto(move || {
        let sealed = file_crypto::encrypt_file(&source, &dst, &*key, id, MAX_FILE_SIZE);
        (blob, sealed)
    })
    .await?;
    let sealed = sealed.map_err(|e| match e.kind() {
        std::io::ErrorKind::FileTooLarge => {
            AppError::Validation("File exceeds maximum allowed size".into())
        }
        _ => AppError::Internal(format!("Failed to stage outbound blob: {e}")),
    })?;
    let (size, sha256) = (sealed.size, sealed.sha256);

    // Basic DLP heuristic — score + reasons recorded with the row.
    let (dlp_score, dlp_reasons) =
        compute_dlp_score(input.filename, input.content_type, size as i64);

    let now = Utc::now();
    let expires_at = now + default_ttl();

    // Decide initial status. Auto-approval is granted whenever the
    // requester has been opted out of approval — the per-user bypass is
    // a deliberate admin override that means "trust this user", so the
    // DLP score is recorded for audit but does NOT veto the bypass.
    // Users without the bypass are always queued for an approver.
    let auto_approve = !input.requires_approval;
    let (status, download_token) = if auto_approve {
        (OutboundShareStatus::Approved, Some(mint_token()))
    } else {
        (OutboundShareStatus::Pending, None)
    };

    let reasons_json = serde_json::Value::Array(
        dlp_reasons
            .iter()
            .map(|r| serde_json::Value::String(r.clone()))
            .collect(),
    );

    sqlx::query(
        "INSERT INTO outbound_shares (
            id, requester_user_id, session_id, connection_id,
            filename, content_type, size, sha256,
            storage_path, sealed_dek_ciphertext, sealed_dek_nonce,
            justification, dlp_score, dlp_reasons,
            status, download_token, created_at, expires_at,
            av_scan_status, av_signature, av_scanned_at, av_scanner_backend,
            blob_format
        ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, NULL,
            $11, $12, $13,
            $14, $15, $16, $17,
            $18, $19, $20, $21,
            2
        )",
    )
    .bind(id)
    .bind(input.requester_user_id)
    .bind(input.session_id)
    .bind(input.connection_id)
    .bind(input.filename)
    .bind(input.content_type)
    .bind(size as i64)
    .bind(&sha256)
    .bind(storage_path.to_string_lossy().to_string())
    .bind(&wrapped_key)
    .bind(input.justification)
    .bind(dlp_score)
    .bind(&reasons_json)
    .bind(status.as_str())
    .bind(download_token.as_deref())
    .bind(now)
    .bind(expires_at)
    .bind(input.av_verdict.as_str())
    .bind(input.av_verdict.signature())
    .bind(now)
    .bind(input.av_backend)
    .execute(pool)
    .await?;
    blob.keep();

    let _ = audit::log(
        pool,
        Some(input.requester_user_id),
        "outbound_share.requested",
        &serde_json::json!({
            "share_id": id,
            "filename": input.filename,
            "size": size,
            "sha256": sha256,
            "dlp_score": dlp_score,
            "dlp_reasons": dlp_reasons,
            "auto_approved": auto_approve,
            "session_id": input.session_id,
            "connection_id": input.connection_id,
            "av_status": input.av_verdict.as_str(),
            "av_signature": input.av_verdict.signature(),
            "av_backend": input.av_backend,
        }),
    )
    .await;

    Ok(SubmitOutcome {
        id,
        status,
        dlp_score,
        dlp_reasons,
        download_token,
        expires_at,
        size,
    })
}

// ── Approver decision ────────────────────────────────────────────────

/// Input for [`decide`]. `approve = false` triggers blob purge.
pub struct DecideInput<'a> {
    pub share_id: Uuid,
    pub approver_user_id: Uuid,
    pub approve: bool,
    pub reason: Option<&'a str>,
    /// When `true`, skip the belt-and-braces lookup in
    /// `outbound_share_approvers`. Super-admins (`can_manage_system`)
    /// are implicit approvers per the route-layer policy in
    /// `require_approver`, so a super-admin who has *not* been added
    /// to the explicit approver list must still be allowed to decide.
    pub caller_is_super_admin: bool,
}

/// Outcome of a successful [`decide`].
#[derive(Debug, Serialize)]
pub struct DecideOutcome {
    pub id: Uuid,
    pub status: OutboundShareStatus,
    pub download_token: Option<String>,
}

/// Approve or deny a `Pending` share. Caller must already have verified
/// the approver via [`is_outbound_approver`]; we re-check inside the
/// transaction as a belt-and-braces measure.
pub async fn decide(
    pool: &Pool<Postgres>,
    input: DecideInput<'_>,
) -> Result<DecideOutcome, AppError> {
    let mut tx = pool.begin().await?;

    // Belt-and-braces: re-validate approver inside the transaction.
    // Super-admins are implicit approvers (see `require_approver` in
    // the route layer) and may not be present in the explicit
    // `outbound_share_approvers` table, so honour the caller's
    // super-admin assertion here.
    if !input.caller_is_super_admin {
        let is_approver: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM outbound_share_approvers WHERE user_id = $1)",
        )
        .bind(input.approver_user_id)
        .fetch_one(&mut *tx)
        .await?;
        if !is_approver {
            return Err(AppError::Forbidden);
        }
    }

    // Lock the row.
    let row: Option<OutboundShare> = sqlx::query_as(
        "SELECT id, requester_user_id, session_id, connection_id,
                filename, content_type, size, sha256, storage_path,
                sealed_dek_ciphertext, sealed_dek_nonce,
                justification, dlp_score, dlp_reasons, status,
                decided_by, decided_at, decision_reason,
                download_token, downloaded_at, created_at, expires_at, purged_at
         FROM outbound_shares
         WHERE id = $1
         FOR UPDATE",
    )
    .bind(input.share_id)
    .fetch_optional(&mut *tx)
    .await?;

    let row = row.ok_or_else(|| AppError::NotFound("Outbound share not found".into()))?;
    if row.status != OutboundShareStatus::Pending.as_str() {
        return Err(AppError::Validation(format!(
            "Share is not pending (status: {})",
            row.status
        )));
    }
    if row.expires_at <= Utc::now() {
        return Err(AppError::Validation("Share has already expired".into()));
    }

    let (new_status, download_token, storage_to_purge) = if input.approve {
        (OutboundShareStatus::Approved, Some(mint_token()), None)
    } else {
        (OutboundShareStatus::Denied, None, row.storage_path.clone())
    };

    sqlx::query(
        "UPDATE outbound_shares
         SET status = $2,
             decided_by = $3,
             decided_at = NOW(),
             decision_reason = $4,
             download_token = $5,
             sealed_dek_ciphertext = CASE WHEN $6 THEN NULL ELSE sealed_dek_ciphertext END,
             sealed_dek_nonce = CASE WHEN $6 THEN NULL ELSE sealed_dek_nonce END,
             storage_path = CASE WHEN $6 THEN NULL ELSE storage_path END,
             purged_at = CASE WHEN $6 THEN NOW() ELSE purged_at END
         WHERE id = $1",
    )
    .bind(input.share_id)
    .bind(new_status.as_str())
    .bind(input.approver_user_id)
    .bind(input.reason)
    .bind(download_token.as_deref())
    .bind(!input.approve)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Purge the blob on disk after commit so the row state is authoritative.
    if let Some(path) = storage_to_purge {
        let _ = tokio::fs::remove_file(&path).await;
    }

    let _ = audit::log(
        pool,
        Some(input.approver_user_id),
        "outbound_share.decided",
        &serde_json::json!({
            "share_id": input.share_id,
            "approved": input.approve,
            "reason": input.reason,
        }),
    )
    .await;

    Ok(DecideOutcome {
        id: input.share_id,
        status: new_status,
        download_token,
    })
}

// ── Download ─────────────────────────────────────────────────────────

/// Result of [`consume_download_token`]: the share row plus its plaintext.
pub struct DownloadMaterial {
    pub share: OutboundShare,
    /// Decrypted chunk by chunk as it is sent (format 2), or in one piece
    /// for blobs staged before PERF-03.
    pub body: axum::body::Body,
    pub length: u64,
}

/// Atomically consume a one-shot download token. The row is locked, the
/// caller is authorised, the whole file is authenticated, and only then is
/// the token cleared — a refused caller or a damaged file leaves it usable.
pub async fn consume_download_token(
    pool: &Pool<Postgres>,
    vault_cfg: &VaultConfig,
    token: &str,
    caller_id: Uuid,
    caller_is_admin: bool,
) -> Result<DownloadMaterial, AppError> {
    let mut tx = pool.begin().await?;

    let row: Option<OutboundShare> = sqlx::query_as(
        "SELECT id, requester_user_id, session_id, connection_id,
                filename, content_type, size, sha256, storage_path,
                sealed_dek_ciphertext, sealed_dek_nonce,
                justification, dlp_score, dlp_reasons, status,
                decided_by, decided_at, decision_reason,
                download_token, downloaded_at, created_at, expires_at, purged_at,
                blob_format
         FROM outbound_shares
         WHERE download_token = $1
         FOR UPDATE",
    )
    .bind(token)
    .fetch_optional(&mut *tx)
    .await?;

    let row = row.ok_or_else(|| AppError::NotFound("Invalid or expired token".into()))?;

    if row.requester_user_id != caller_id && !caller_is_admin {
        return Err(AppError::Forbidden);
    }
    if row.status != OutboundShareStatus::Approved.as_str() {
        return Err(AppError::Forbidden);
    }
    if row.expires_at <= Utc::now() {
        return Err(AppError::Validation("Share has already expired".into()));
    }

    let storage_path = PathBuf::from(
        row.storage_path
            .as_deref()
            .ok_or_else(|| AppError::Internal("Share missing storage path".into()))?,
    );
    let sealed_dek = row
        .sealed_dek_ciphertext
        .as_deref()
        .ok_or_else(|| AppError::Internal("Share missing sealed DEK".into()))?;
    let key = vault::unwrap_data_key(vault_cfg, sealed_dek).await?;

    // Everything that can fail happens *before* the token is cleared, so
    // a failure never spends the link without delivering the file.
    let (body, length) = if row.blob_format == 2 {
        // Opened now: the stream keeps reading this file even if a purge
        // unlinks it after the commit.
        let file = tokio::fs::File::open(&storage_path)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to open staged blob: {e}")))?;
        let length = u64::try_from(row.size)
            .map_err(|_| AppError::Internal("Share has a negative size".into()))?;
        let (verify_key, id) = (key.clone(), row.id);
        run_crypto(move || file_crypto::verify_file(&storage_path, &verify_key, id, length))
            .await?
            .map_err(|e| AppError::Internal(format!("Staged blob failed verification: {e}")))?;
        let stream = file_crypto::decrypt_stream(file, &key, row.id)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to read staged blob: {e}")))?;
        (axum::body::Body::from_stream(stream), length)
    } else {
        let nonce = row
            .sealed_dek_nonce
            .as_deref()
            .ok_or_else(|| AppError::Internal("Share missing sealed nonce".into()))?;
        let ciphertext = tokio::fs::read(&storage_path)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to read staged blob: {e}")))?;
        let plaintext = vault::decrypt_with_key(&key, &ciphertext, nonce)?;
        let length = plaintext.len() as u64;
        (axum::body::Body::from(plaintext), length)
    };
    drop(key);

    sqlx::query(
        "UPDATE outbound_shares
         SET status = $2,
             downloaded_at = NOW(),
             download_token = NULL
         WHERE id = $1",
    )
    .bind(row.id)
    .bind(OutboundShareStatus::Downloaded.as_str())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    let _ = audit::log(
        pool,
        Some(caller_id),
        "outbound_share.downloaded",
        &serde_json::json!({
            "share_id": row.id,
            "requester_user_id": row.requester_user_id,
            "filename": row.filename,
            "size": row.size,
        }),
    )
    .await;

    Ok(DownloadMaterial {
        share: row,
        body,
        length,
    })
}

/// Record that an auto-approved share was handed straight to its requester
/// over the session's file channel, so its one-shot link is spent too.
pub async fn mark_delivered(pool: &Pool<Postgres>, id: Uuid) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE outbound_shares
         SET status = $2,
             downloaded_at = NOW(),
             download_token = NULL
         WHERE id = $1 AND status = $3",
    )
    .bind(id)
    .bind(OutboundShareStatus::Downloaded.as_str())
    .bind(OutboundShareStatus::Approved.as_str())
    .execute(pool)
    .await?;
    Ok(())
}

// ── Listings & lookups ───────────────────────────────────────────────

/// All shares for a single requester, newest first.
pub async fn list_for_user(
    pool: &Pool<Postgres>,
    user_id: Uuid,
) -> Result<Vec<OutboundShare>, AppError> {
    let rows: Vec<OutboundShare> = sqlx::query_as(
        "SELECT id, requester_user_id, session_id, connection_id,
                filename, content_type, size, sha256, storage_path,
                sealed_dek_ciphertext, sealed_dek_nonce,
                justification, dlp_score, dlp_reasons, status,
                decided_by, decided_at, decision_reason,
                download_token, downloaded_at, created_at, expires_at, purged_at
         FROM outbound_shares
         WHERE requester_user_id = $1
         ORDER BY created_at DESC
         LIMIT 200",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// All shares currently awaiting decision, oldest first (FIFO queue).
///
/// LEFT JOIN on `users` so the response includes the requester's
/// username — non-admin approvers (compliance officers) viewing the
/// queue from `/approvals` cannot call `/admin/users`, so the JOIN is
/// the only way they get a friendly name.
pub async fn list_pending(pool: &Pool<Postgres>) -> Result<Vec<OutboundShare>, AppError> {
    let rows: Vec<OutboundShare> = sqlx::query_as(
        "SELECT os.id, os.requester_user_id, os.session_id, os.connection_id,
                os.filename, os.content_type, os.size, os.sha256, os.storage_path,
                os.sealed_dek_ciphertext, os.sealed_dek_nonce,
                os.justification, os.dlp_score, os.dlp_reasons, os.status,
                os.decided_by, os.decided_at, os.decision_reason,
                os.download_token, os.downloaded_at, os.created_at, os.expires_at, os.purged_at,
                u.username AS requester_username
         FROM outbound_shares os
         LEFT JOIN users u ON u.id = os.requester_user_id
         WHERE os.status = 'pending'
         ORDER BY os.created_at ASC
         LIMIT 200",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// All non-purged shares — used by the admin overview and the
/// `/approvals` queue. JOINed with `users` for the same reason as
/// [`list_pending`].
pub async fn list_all(pool: &Pool<Postgres>) -> Result<Vec<OutboundShare>, AppError> {
    let rows: Vec<OutboundShare> = sqlx::query_as(
        "SELECT os.id, os.requester_user_id, os.session_id, os.connection_id,
                os.filename, os.content_type, os.size, os.sha256, os.storage_path,
                os.sealed_dek_ciphertext, os.sealed_dek_nonce,
                os.justification, os.dlp_score, os.dlp_reasons, os.status,
                os.decided_by, os.decided_at, os.decision_reason,
                os.download_token, os.downloaded_at, os.created_at, os.expires_at, os.purged_at,
                u.username AS requester_username
         FROM outbound_shares os
         LEFT JOIN users u ON u.id = os.requester_user_id
         ORDER BY os.created_at DESC
         LIMIT 500",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Look up a share by id (any user, used by admin).
pub async fn find(pool: &Pool<Postgres>, id: Uuid) -> Result<Option<OutboundShare>, AppError> {
    let row: Option<OutboundShare> = sqlx::query_as(
        "SELECT id, requester_user_id, session_id, connection_id,
                filename, content_type, size, sha256, storage_path,
                sealed_dek_ciphertext, sealed_dek_nonce,
                justification, dlp_score, dlp_reasons, status,
                decided_by, decided_at, decision_reason,
                download_token, downloaded_at, created_at, expires_at, purged_at
         FROM outbound_shares
         WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Whether the given user is a registered outbound-share approver.
pub async fn is_outbound_approver(pool: &Pool<Postgres>, user_id: Uuid) -> Result<bool, AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM outbound_share_approvers WHERE user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

/// User ids that should be notified when a new outbound share lands in
/// `Pending`. Union of designated approvers (`outbound_share_approvers`)
/// and implicit super-admin approvers (users whose role has
/// `can_manage_system = TRUE`, joined through `users.role_id -> roles.id`).
/// Mirrors the route-layer policy that lets super-admins decide outbound
/// shares without being explicitly listed. Soft-deleted users are filtered
/// out and duplicates are deduped.
pub async fn approvers_for_notifications(pool: &Pool<Postgres>) -> Result<Vec<Uuid>, AppError> {
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT DISTINCT u.id
           FROM users u
           JOIN roles r ON u.role_id = r.id
          WHERE u.deleted_at IS NULL
            AND (
              u.id IN (SELECT user_id FROM outbound_share_approvers)
              OR r.can_manage_system = TRUE
            )",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// One row from `outbound_share_approvers`, joined with the user table
/// for display.
#[derive(serde::Serialize, sqlx::FromRow, Debug, Clone)]
pub struct OutboundShareApproverRow {
    pub user_id: Uuid,
    pub username: String,
    pub email: String,
    pub full_name: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// List every registered outbound-share approver with their display
/// fields, ordered by username.
pub async fn list_approvers(
    pool: &Pool<Postgres>,
) -> Result<Vec<OutboundShareApproverRow>, AppError> {
    let rows: Vec<OutboundShareApproverRow> = sqlx::query_as(
        "SELECT a.user_id, u.username, u.email, u.full_name, a.created_at
         FROM outbound_share_approvers a
         JOIN users u ON u.id = a.user_id
         WHERE u.deleted_at IS NULL
         ORDER BY u.username",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Add a user to the outbound-share approver list. Idempotent: returns
/// `true` on insert, `false` if the user was already an approver. Errors
/// when the user does not exist or has been soft-deleted.
pub async fn add_approver(pool: &Pool<Postgres>, user_id: Uuid) -> Result<bool, AppError> {
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    if exists.is_none() {
        return Err(AppError::NotFound("User not found".into()));
    }
    let res = sqlx::query(
        "INSERT INTO outbound_share_approvers (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Remove a user from the outbound-share approver list. Returns `true`
/// when a row was deleted, `false` when the user was not an approver.
pub async fn remove_approver(pool: &Pool<Postgres>, user_id: Uuid) -> Result<bool, AppError> {
    let res = sqlx::query("DELETE FROM outbound_share_approvers WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

// ── Periodic purge worker ────────────────────────────────────────────

/// Two-phase sweep run on a schedule by [`spawn_purge_worker`].
///
/// Phase 1 — zeroise: rows past `expires_at` that have not been purged
/// yet have their on-disk blob unlinked and their sealed DEK / nonce /
/// storage path / download token NULL'd. `Pending`/`Approved` rows
/// flip to `Purged`; `Downloaded`/`Denied` rows keep their status so
/// the history still records *how* the row ended (the new `purged_at`
/// timestamp tells the UI that the material on disk is gone).
///
/// Phase 2 — hard-delete: rows whose `purged_at` is older than
/// [`HISTORY_RETENTION_AFTER_PURGE_DAYS`] are removed from the table
/// entirely so the admin history view does not grow without bound.
/// These rows carry no secret material by this point so deletion is
/// safe; an `outbound_share.removed` audit event records each removal
/// for the compliance trail.
///
/// Returns the number of rows zeroised in Phase 1 (Phase 2 deletions
/// are logged separately via tracing + audit). Errors on individual
/// rows are logged but do not abort the sweep.
pub async fn purge_expired(pool: &Pool<Postgres>) -> Result<u64, AppError> {
    let candidates: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT id, storage_path
         FROM outbound_shares
         WHERE purged_at IS NULL
           AND expires_at <= NOW()
         LIMIT 500",
    )
    .fetch_all(pool)
    .await?;

    let mut purged = 0u64;
    for (id, path) in candidates {
        if let Some(p) = path {
            let _ = tokio::fs::remove_file(&p).await;
        }
        let res = sqlx::query(
            "UPDATE outbound_shares
             SET status = CASE WHEN status IN ('pending','approved') THEN 'purged' ELSE status END,
                 sealed_dek_ciphertext = NULL,
                 sealed_dek_nonce = NULL,
                 storage_path = NULL,
                 download_token = NULL,
                 purged_at = NOW()
             WHERE id = $1 AND purged_at IS NULL",
        )
        .bind(id)
        .execute(pool)
        .await;

        match res {
            Ok(r) if r.rows_affected() > 0 => {
                purged += 1;
                let _ = audit::log(
                    pool,
                    None,
                    "outbound_share.purged",
                    &serde_json::json!({ "share_id": id }),
                )
                .await;
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("outbound_shares purge_expired: {id}: {e}");
            }
        }
    }

    // ── Phase 2: hard-delete history rows past their retention window ──
    // Rows reach this branch only after Phase 1 has already zeroised
    // their secret material (sealed DEK / nonce / storage_path /
    // download_token are all NULL), so deletion does not lose anything
    // a `Purge` admin button could still act on. We list the ids before
    // deleting so each removal can be audited individually.
    let to_remove: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT id
         FROM outbound_shares
         WHERE purged_at IS NOT NULL
           AND purged_at <= NOW() - make_interval(days => $1)
         LIMIT 500",
    )
    .bind(HISTORY_RETENTION_AFTER_PURGE_DAYS as i32)
    .fetch_all(pool)
    .await?;

    let mut removed = 0u64;
    for (id,) in to_remove {
        let res = sqlx::query("DELETE FROM outbound_shares WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await;
        match res {
            Ok(r) if r.rows_affected() > 0 => {
                removed += 1;
                let _ = audit::log(
                    pool,
                    None,
                    "outbound_share.removed",
                    &serde_json::json!({ "share_id": id }),
                )
                .await;
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("outbound_shares purge_expired (hard-delete): {id}: {e}");
            }
        }
    }
    if removed > 0 {
        tracing::info!("outbound_shares: hard-deleted {removed} history row(s) past retention");
    }

    Ok(purged)
}

/// Spawn the periodic purge worker. Mirrors other `spawn_*` services in
/// this crate so `main.rs` can register it alongside the rest.
pub fn spawn_purge_worker(
    state: crate::services::app_state::SharedState,
    shutdown: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    use crate::services::worker::{spawn_periodic, PeriodicConfig};
    use std::time::Duration as StdDuration;

    spawn_periodic(
        PeriodicConfig {
            label: "outbound_shares_purge",
            initial_delay: StdDuration::from_secs(120),
            interval: StdDuration::from_secs(3600),
            iteration_timeout: StdDuration::from_secs(300),
            error_backoff_base: StdDuration::from_secs(30),
        },
        shutdown,
        move || {
            let state = state.clone();
            async move {
                let pool = {
                    let s = state.read().await;
                    if s.phase != crate::services::app_state::BootPhase::Running {
                        return Ok::<(), AppError>(());
                    }
                    match &s.db {
                        Some(d) => d.pool.clone(),
                        None => return Ok(()),
                    }
                };
                let n = purge_expired(&pool).await?;
                if n > 0 {
                    tracing::info!("outbound_shares: purged {n} expired share(s)");
                }
                Ok(())
            }
        },
    )
}

// ── Helpers ──────────────────────────────────────────────────────────

fn mint_token() -> String {
    // 256 bits of randomness via UUIDv4 + a second UUIDv4 — enough entropy
    // for a one-shot capability URL even though UUIDv4 is only 122 bits
    // each. Concatenation gives ~244 bits of effective randomness.
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

async fn ensure_staging_path(root: &Path, id: Uuid) -> Result<PathBuf, AppError> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create staging dir: {e}")))?;
    Ok(root.join(format!("{}.bin", id)))
}

/// Basic content scanner. Pure heuristic — designed to flag the
/// obviously-bad-looking uploads (executables, archives, certain
/// keywords) without pretending to be a real DLP product.
///
/// Returns `(score, reasons)`. [`DLP_AUTO_FLAG_SCORE`] is a reference
/// threshold for "this file looks risky"; the score is recorded on
/// every row and surfaced to approvers/admins, but it does NOT
/// override the per-user bypass — opting a user out of approval is a
/// deliberate admin decision that means "trust this user".
pub fn compute_dlp_score(filename: &str, content_type: &str, size: i64) -> (i32, Vec<String>) {
    let mut score = 0i32;
    let mut reasons: Vec<String> = Vec::new();

    let name_lc = filename.to_ascii_lowercase();
    let mime_lc = content_type.to_ascii_lowercase();

    // Executable / installer extensions
    const HIGH_RISK_EXT: &[&str] = &[
        ".exe", ".dll", ".msi", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".jar", ".sh", ".scr",
        ".com", ".cpl", ".reg",
    ];
    for ext in HIGH_RISK_EXT {
        if name_lc.ends_with(ext) {
            score += 60;
            reasons.push(format!("Executable extension {ext}"));
            break;
        }
    }

    // Archive extensions — not dangerous on their own but worth flagging
    // because they can hide payloads from this scanner.
    const ARCHIVE_EXT: &[&str] = &[
        ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".iso", ".cab",
    ];
    for ext in ARCHIVE_EXT {
        if name_lc.ends_with(ext) {
            score += 25;
            reasons.push(format!("Archive extension {ext}"));
            break;
        }
    }

    // Credential / config-looking names
    const SENSITIVE_TOKENS: &[&str] = &[
        "password",
        "secret",
        "credential",
        "token",
        "private",
        "id_rsa",
        ".pem",
        ".pfx",
        ".p12",
        ".kdbx",
        ".keystore",
    ];
    for tok in SENSITIVE_TOKENS {
        if name_lc.contains(tok) {
            score += 40;
            reasons.push(format!("Sensitive-looking name token: {tok}"));
            break;
        }
    }

    // Office docs with macros
    if name_lc.ends_with(".docm") || name_lc.ends_with(".xlsm") || name_lc.ends_with(".pptm") {
        score += 30;
        reasons.push("Macro-enabled Office document".into());
    }

    // MIME-side checks (defence in depth — filename can lie)
    if mime_lc.contains("executable")
        || mime_lc.contains("x-msdownload")
        || mime_lc.contains("x-msi")
    {
        score += 40;
        reasons.push(format!("Executable MIME type: {content_type}"));
    }

    // Large file — caps at 25
    let mb = size / (1024 * 1024);
    if mb >= 100 {
        score += 25;
        reasons.push(format!("Large file ({mb} MiB)"));
    } else if mb >= 25 {
        score += 10;
        reasons.push(format!("Medium-large file ({mb} MiB)"));
    }

    // Clamp to a sane range.
    if score > 100 {
        score = 100;
    }

    (score, reasons)
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_lowercase() {
        let v = serde_json::to_value(OutboundShareStatus::Pending).unwrap();
        assert_eq!(v, serde_json::json!("pending"));
        let v = serde_json::to_value(OutboundShareStatus::Approved).unwrap();
        assert_eq!(v, serde_json::json!("approved"));
    }

    #[test]
    fn status_as_str_round_trips() {
        for s in [
            OutboundShareStatus::Pending,
            OutboundShareStatus::Approved,
            OutboundShareStatus::Denied,
            OutboundShareStatus::Downloaded,
            OutboundShareStatus::Purged,
        ] {
            assert!(!s.as_str().is_empty());
        }
    }

    #[test]
    fn dlp_clean_text_file_scores_low() {
        let (score, reasons) = compute_dlp_score("notes.txt", "text/plain", 1024);
        assert!(score < DLP_AUTO_FLAG_SCORE, "score was {score}");
        assert!(reasons.is_empty(), "reasons: {:?}", reasons);
    }

    #[test]
    fn dlp_executable_is_flagged() {
        let (score, reasons) =
            compute_dlp_score("installer.exe", "application/octet-stream", 2 * 1024 * 1024);
        assert!(score >= DLP_AUTO_FLAG_SCORE, "score was {score}");
        assert!(reasons.iter().any(|r| r.contains(".exe")));
    }

    #[test]
    fn dlp_executable_mime_is_flagged_even_if_extension_is_hidden() {
        let (score, _reasons) = compute_dlp_score("update", "application/x-msdownload", 1024);
        assert!(score >= 40);
    }

    #[test]
    fn dlp_secret_file_is_flagged() {
        let (score, reasons) = compute_dlp_score("id_rsa", "text/plain", 2048);
        assert!(score >= 40, "score was {score}");
        assert!(reasons
            .iter()
            .any(|r| r.contains("id_rsa") || r.contains("private")));
    }

    #[test]
    fn dlp_zip_is_flagged_as_archive() {
        let (score, reasons) = compute_dlp_score("logs.zip", "application/zip", 10 * 1024 * 1024);
        assert!(score >= 25, "score was {score}");
        assert!(reasons.iter().any(|r| r.contains(".zip")));
    }

    #[test]
    fn dlp_large_file_adds_size_reason() {
        let (_score, reasons) = compute_dlp_score("video.mp4", "video/mp4", 150 * 1024 * 1024);
        assert!(reasons.iter().any(|r| r.contains("MiB")));
    }

    #[test]
    fn dlp_score_is_clamped_to_100() {
        let (score, _reasons) = compute_dlp_score(
            "secret_password_id_rsa.exe",
            "application/x-msdownload",
            200 * 1024 * 1024,
        );
        assert_eq!(score, 100);
    }

    #[test]
    fn mint_token_is_unique() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a, b);
        // 32-char simple UUID × 2 = 64
        assert_eq!(a.len(), 64);
    }

    /// A Transit stand-in that "wraps" a key by tagging it.
    async fn fake_vault() -> VaultConfig {
        use axum::{routing::post, Json, Router};
        async fn encrypt(Json(b): Json<serde_json::Value>) -> Json<serde_json::Value> {
            let pt = b["plaintext"].as_str().unwrap_or_default();
            Json(serde_json::json!({ "data": { "ciphertext": format!("vault:v1:{pt}") } }))
        }
        async fn decrypt(Json(b): Json<serde_json::Value>) -> Json<serde_json::Value> {
            let ct = b["ciphertext"].as_str().unwrap_or_default();
            let pt = ct.trim_start_matches("vault:v1:");
            Json(serde_json::json!({ "data": { "plaintext": pt } }))
        }
        let app = Router::new()
            .route("/v1/transit/encrypt/{key}", post(encrypt))
            .route("/v1/transit/decrypt/{key}", post(decrypt));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        VaultConfig {
            address: format!("http://{addr}"),
            token: "test-token".into(),
            transit_key: "strata-key".into(),
            mode: crate::config::VaultMode::Local,
            unseal_key: None,
        }
    }

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database.
    #[tokio::test]
    async fn shares_are_staged_encrypted_and_streamed_back() {
        let Some(pool) = std::env::var("TEST_DATABASE_URL")
            .ok()
            .and_then(|url| sqlx::PgPool::connect_lazy(&url).ok())
        else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let vault_cfg = fake_vault().await;
        let tag = Uuid::new_v4().simple().to_string();
        let role: Uuid = sqlx::query_scalar("INSERT INTO roles (name) VALUES ($1) RETURNING id")
            .bind(format!("r-{tag}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        let user: Uuid = sqlx::query_scalar(
            "INSERT INTO users (username, email, role_id) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(format!("u-{tag}"))
        .bind(format!("{tag}@example.test"))
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();

        let dir = tempfile::TempDir::new().unwrap();
        let staging = dir.path().join("staging");
        let source = dir.path().join("upload");
        let data: Vec<u8> = (0..3 * file_crypto::CHUNK + 5)
            .map(|i| (i % 251) as u8)
            .collect();
        tokio::fs::write(&source, &data).await.unwrap();
        let verdict = crate::services::av::Verdict::Clean;
        let submit_one = || {
            submit(
                &pool,
                &vault_cfg,
                SubmitInput {
                    requester_user_id: user,
                    session_id: None,
                    connection_id: None,
                    filename: "report.bin",
                    content_type: "application/octet-stream",
                    justification: None,
                    source: &source,
                    staging_root: &staging,
                    requires_approval: false,
                    av_verdict: &verdict,
                    av_backend: "off",
                },
            )
        };
        let data_len = data.len() as u64;
        let download = |token: String, caller: Uuid| {
            let (pool, vault_cfg) = (pool.clone(), vault_cfg.clone());
            async move {
                let mat = consume_download_token(&pool, &vault_cfg, &token, caller, false).await?;
                assert_eq!(mat.length, data_len);
                let bytes = axum::body::to_bytes(mat.body, usize::MAX)
                    .await
                    .map_err(|e| AppError::Internal(e.to_string()))?;
                Ok::<_, AppError>(bytes.to_vec())
            }
        };

        // Staged as format 2, hashed, and nothing readable on disk.
        let good = submit_one().await.unwrap();
        assert_eq!(good.size, data.len() as u64);
        let (format, sha, path, nonce): (i16, String, String, Option<Vec<u8>>) = sqlx::query_as(
            "SELECT blob_format, sha256, storage_path, sealed_dek_nonce
             FROM outbound_shares WHERE id = $1",
        )
        .bind(good.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((format, nonce), (2, None));
        let digest = <sha2::Sha256 as sha2::Digest>::digest(&data);
        let expected: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(sha, expected);
        let on_disk = tokio::fs::read(&path).await.unwrap();
        assert!(!on_disk.windows(64).any(|w| w == &data[..64]));

        // Another user cannot spend the link.
        let token = good.download_token.clone().unwrap();
        assert!(matches!(
            download(token.clone(), Uuid::new_v4()).await,
            Err(AppError::Forbidden)
        ));

        // A damaged blob is refused and leaves the link usable.
        let damaged = submit_one().await.unwrap();
        let (damaged_path,): (String,) =
            sqlx::query_as("SELECT storage_path FROM outbound_shares WHERE id = $1")
                .bind(damaged.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let mut bytes = tokio::fs::read(&damaged_path).await.unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        tokio::fs::write(&damaged_path, bytes).await.unwrap();
        let damaged_token = damaged.download_token.unwrap();
        assert!(download(damaged_token.clone(), user).await.is_err());
        let status: String =
            sqlx::query_scalar("SELECT status FROM outbound_shares WHERE download_token = $1")
                .bind(&damaged_token)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "approved");

        // The owner gets the exact bytes back, once.
        assert_eq!(download(token.clone(), user).await.unwrap(), data);
        assert!(download(token, user).await.is_err());

        // Blobs staged before the chunked format still download.
        let sealed = vault::seal(&vault_cfg, &data).await.unwrap();
        let legacy_path = dir.path().join("legacy.bin");
        tokio::fs::write(&legacy_path, &sealed.ciphertext)
            .await
            .unwrap();
        let legacy_token = mint_token();
        sqlx::query(
            "INSERT INTO outbound_shares (
                id, requester_user_id, filename, content_type, size, sha256,
                storage_path, sealed_dek_ciphertext, sealed_dek_nonce,
                dlp_score, dlp_reasons, status, download_token, expires_at
             ) VALUES ($1, $2, 'old.bin', 'application/octet-stream', $3, $4,
                       $5, $6, $7, 0, '[]', 'approved', $8, NOW() + INTERVAL '1 hour')",
        )
        .bind(Uuid::new_v4())
        .bind(user)
        .bind(data.len() as i64)
        .bind(&expected)
        .bind(legacy_path.to_string_lossy().to_string())
        .bind(&sealed.encrypted_dek)
        .bind(&sealed.nonce)
        .bind(&legacy_token)
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(download(legacy_token, user).await.unwrap(), data);
    }
}
