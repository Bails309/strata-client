// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Temporary file CDN routes.
//!
//! - `POST /api/files/upload`  — Upload a file (authenticated, multipart).
//! - `GET  /api/files/:token`  — Download a file (public, token = auth).
//! - `GET  /api/files/session/:session_id` — List files for a session (authenticated).
//! - `DELETE /api/files/:token` — Delete a file (authenticated, owner only).

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Extension;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use tokio_util::io::ReaderStream;

use axum::extract::connect_info::ConnectInfo;
use std::net::SocketAddr;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::file_store::StoredFile;
use crate::services::middleware::AuthUser;

/// Per-IP rate limiter for public file downloads.
static DOWNLOAD_RATE_LIMIT: std::sync::LazyLock<Mutex<HashMap<String, Vec<Instant>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Maximum downloads per IP per minute.
const MAX_DOWNLOADS_PER_IP: usize = 60;
const DOWNLOAD_WINDOW_SECS: u64 = 60;
const MAX_DOWNLOAD_RATE_ENTRIES: usize = 50_000;

#[derive(Serialize)]
pub struct FileUploadResponse {
    pub token: String,
    pub filename: String,
    pub size: u64,
    pub content_type: String,
    pub download_url: String,
}

#[derive(Serialize)]
pub struct FileListEntry {
    pub token: String,
    pub filename: String,
    pub size: u64,
    pub content_type: String,
    pub download_url: String,
    pub created_at: String,
}

impl From<&StoredFile> for FileListEntry {
    fn from(f: &StoredFile) -> Self {
        Self {
            token: f.token.clone(),
            filename: f.filename.clone(),
            size: f.size,
            content_type: f.content_type.clone(),
            download_url: format!("/api/files/{}", f.token),
            created_at: f.created_at.to_rfc3339(),
        }
    }
}

/// `POST /api/files/upload` — Upload a file via multipart form data.
///
/// Required form fields:
/// - `session_id` (text) — the active session ID to associate the file with.
/// - `file` (file) — the binary file payload.
pub async fn upload(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    mut multipart: axum::extract::Multipart,
) -> Result<axum::Json<FileUploadResponse>, AppError> {
    // RBAC: Quick Share must be explicitly enabled on the user's role.
    crate::services::middleware::check_quick_share_permission(&user)?;

    let file_store = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.file_store.clone()
    };

    let mut session_id: Option<String> = None;
    let mut file_data: Option<(String, String, std::path::PathBuf, u64)> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "session_id" => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| AppError::Validation(format!("Invalid session_id: {e}")))?;
                session_id = Some(text);
            }
            "file" => {
                let filename = field.file_name().unwrap_or("upload").to_string();
                let content_type = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                // Stream to a temp file on disk with incremental size checking
                // to avoid loading large uploads entirely into memory.
                use futures_util::TryStreamExt;
                use tokio::io::AsyncWriteExt;
                let temp_path =
                    std::env::temp_dir().join(format!("strata-upload-{}", uuid::Uuid::new_v4()));
                let mut temp_file = tokio::fs::File::create(&temp_path)
                    .await
                    .map_err(|e| AppError::Internal(format!("Failed to create temp file: {e}")))?;
                let mut written: u64 = 0;
                let mut stream = field;
                while let Some(chunk) = stream.try_next().await.map_err(|e| {
                    // Clean up temp file on read error
                    let _ = std::fs::remove_file(&temp_path);
                    AppError::Validation(format!("Failed to read file: {e}"))
                })? {
                    written += chunk.len() as u64;
                    if written > crate::services::file_store::MAX_FILE_SIZE {
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
                file_data = Some((filename, content_type, temp_path, written));
            }
            _ => { /* ignore unknown fields */ }
        }
    }

    let session_id =
        session_id.ok_or_else(|| AppError::Validation("Missing session_id field".into()))?;
    let (filename, claimed_content_type, temp_path, size) =
        file_data.ok_or_else(|| AppError::Validation("Missing file field".into()))?;

    // ── W3-6 — magic-number / MIME sniffing ────────────────────────────
    //
    // The multipart header-level `content_type` is attacker-controlled:
    // a malicious client can upload an `.exe` and label it `image/png`.
    // We re-detect the type by reading the first 512 bytes from disk and
    // running it through `infer`, which matches against known magic-number
    // signatures. If the claimed type is a concrete MIME type (e.g.
    // "image/png") we require the detected type to match; unknown claimed
    // types ("application/octet-stream" or empty) fall through to the
    // detected value so generic downloads still work.
    let content_type = sniff_mime(&temp_path, &claimed_content_type)
        .await
        .inspect_err(|_e| {
            let _ = std::fs::remove_file(&temp_path);
        })?;

    let meta = file_store
        .store_from_path(
            &session_id,
            user.id,
            &filename,
            &content_type,
            &temp_path,
            size,
        )
        .await
        .map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            AppError::Validation(e.to_string())
        })?;

    tracing::info!(
        user = %user.username,
        session = %session_id,
        token = %meta.token,
        filename = %meta.filename,
        size = meta.size,
        "File uploaded to temp CDN"
    );

    Ok(axum::Json(FileUploadResponse {
        token: meta.token.clone(),
        filename: meta.filename,
        size: meta.size,
        content_type: meta.content_type,
        download_url: format!("/api/files/{}", meta.token),
    }))
}

/// Read the first 512 bytes of `path` and run them through `infer` to
/// derive the true MIME type. If the client's claimed `content_type` is a
/// concrete `type/subtype` (not `application/octet-stream` or empty), we
/// require it to match the detected type. A mismatch is rejected with
/// `AppError::Validation` so a `.exe` labelled `image/png` never lands in
/// the CDN. Detected-then-claimed wins when `infer` returns a result; we
/// fall back to the claimed value for types `infer` does not recognise
/// (e.g. plain text, CSV) as long as the claim looks well-formed.
async fn sniff_mime(path: &std::path::Path, claimed: &str) -> Result<String, AppError> {
    use tokio::io::AsyncReadExt;
    const HEAD_BYTES: usize = 512;

    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to reopen upload: {e}")))?;
    let mut buf = vec![0u8; HEAD_BYTES];
    let n = f
        .read(&mut buf)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read upload head: {e}")))?;
    buf.truncate(n);

    let detected = infer::get(&buf).map(|k| k.mime_type().to_string());
    let claimed_trimmed = claimed.trim();
    let claim_is_generic = claimed_trimmed.is_empty()
        || claimed_trimmed.eq_ignore_ascii_case("application/octet-stream");

    match (detected, claim_is_generic) {
        (Some(d), true) => Ok(d),
        (Some(d), false) => {
            if d.eq_ignore_ascii_case(claimed_trimmed) {
                Ok(d)
            } else {
                Err(AppError::Validation(format!(
                    "Declared content type '{claimed_trimmed}' does not match detected '{d}'"
                )))
            }
        }
        (None, _) => {
            // `infer` has no signature for this file (likely plain text /
            // CSV / JSON). Accept the claim as-is, but enforce a sane
            // MIME shape to prevent header-injection shenanigans.
            if claim_is_generic {
                return Ok("application/octet-stream".into());
            }
            if !claimed_trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '+' | '-'))
                || !claimed_trimmed.contains('/')
            {
                return Err(AppError::Validation(format!(
                    "Invalid content type: {claimed_trimmed}"
                )));
            }
            Ok(claimed_trimmed.to_string())
        }
    }
}

/// `GET /api/files/:token` — Download a file.
///
/// This endpoint is intentionally **unauthenticated**.  The random UUID token
/// serves as a capability — anyone with the URL can download the file.
/// This allows the remote desktop (which has no Strata auth) to fetch it.
pub async fn download(
    State(state): State<SharedState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    Path(token): Path<String>,
) -> Result<Response, AppError> {
    // Per-IP rate limiting on the public download endpoint.
    // Reuse the shared extraction logic; fall back to the socket addr
    // so that direct connections get a real IP instead of "unknown".
    let client_ip = {
        let xff = super::auth::extract_client_ip(&headers);
        if xff == "unknown" {
            addr.ip().to_string()
        } else {
            xff
        }
    };
    {
        let mut map = DOWNLOAD_RATE_LIMIT
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if map.len() > MAX_DOWNLOAD_RATE_ENTRIES {
            let cutoff = Instant::now() - std::time::Duration::from_secs(DOWNLOAD_WINDOW_SECS);
            map.retain(|_, attempts| {
                attempts.retain(|t| *t > cutoff);
                !attempts.is_empty()
            });
            if map.len() > MAX_DOWNLOAD_RATE_ENTRIES {
                map.clear();
            }
        }
        let cutoff = Instant::now() - std::time::Duration::from_secs(DOWNLOAD_WINDOW_SECS);
        let attempts = map.entry(client_ip).or_default();
        attempts.retain(|t| *t > cutoff);
        if attempts.len() >= MAX_DOWNLOADS_PER_IP {
            return Err(AppError::Auth(
                "Too many download requests. Please try again later.".into(),
            ));
        }
        attempts.push(Instant::now());
    }

    let file_store = {
        let s = state.read().await;
        s.file_store.clone()
    };

    let meta = file_store
        .get(&token)
        .await
        .ok_or_else(|| AppError::NotFound("File not found or expired".into()))?;

    // Stream the file from disk.
    let file = tokio::fs::File::open(&meta.path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read file: {e}")))?;

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    // Use RFC 5987 encoding for Content-Disposition to handle special characters safely.
    let safe_filename = meta.filename.replace('"', "'");
    let encoded_filename = urlencoding::encode(&meta.filename);
    let disposition = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        safe_filename, encoded_filename
    );

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, meta.content_type.as_str().to_string()),
            (header::CONTENT_DISPOSITION, disposition),
            (header::CONTENT_LENGTH, meta.size.to_string()),
        ],
        body,
    )
        .into_response())
}

/// `GET /api/files/session/:session_id` — List files for a session (authenticated).
///
/// Only users who own files in the session can list them.
pub async fn list_session_files(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(session_id): Path<String>,
) -> Result<axum::Json<Vec<FileListEntry>>, AppError> {
    let file_store = {
        let s = state.read().await;
        s.file_store.clone()
    };

    let files = file_store.list_session(&session_id).await;
    // Filter to only files owned by the requesting user (or show all if admin)
    let entries: Vec<FileListEntry> = files
        .iter()
        .filter(|f| f.user_id == user.id || user.has_any_admin_permission())
        .map(FileListEntry::from)
        .collect();
    Ok(axum::Json(entries))
}

/// `DELETE /api/files/:token` — Delete a file (authenticated, owner only).
pub async fn delete_file(
    State(state): State<SharedState>,
    Extension(user): Extension<AuthUser>,
    Path(token): Path<String>,
) -> Result<StatusCode, AppError> {
    let file_store = {
        let s = state.read().await;
        s.file_store.clone()
    };

    // Verify ownership.
    let meta = file_store
        .get(&token)
        .await
        .ok_or_else(|| AppError::NotFound("File not found".into()))?;

    if meta.user_id != user.id {
        return Err(AppError::Forbidden);
    }

    file_store.delete(&token).await;

    tracing::info!(
        user = %user.username,
        token = %token,
        filename = %meta.filename,
        "File deleted from temp CDN"
    );

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::file_store::StoredFile;
    use chrono::{TimeZone, Utc};
    use std::path::PathBuf;
    use uuid::Uuid;

    #[test]
    fn file_list_entry_from_stored_file() {
        let now = Utc.with_ymd_and_hms(2026, 4, 20, 10, 0, 0).unwrap();
        let f = StoredFile {
            token: "abc-123".into(),
            session_id: "sess-456".into(),
            user_id: Uuid::new_v4(),
            filename: "test.txt".into(),
            content_type: "text/plain".into(),
            path: PathBuf::from("/tmp/test.txt"),
            size: 1024,
            created_at: now,
        };

        let entry = FileListEntry::from(&f);
        assert_eq!(entry.token, "abc-123");
        assert_eq!(entry.filename, "test.txt");
        assert_eq!(entry.size, 1024);
        assert_eq!(entry.content_type, "text/plain");
        assert_eq!(entry.download_url, "/api/files/abc-123");
        assert_eq!(entry.created_at, "2026-04-20T10:00:00+00:00");
    }

    #[test]
    fn file_upload_response_serialization() {
        let resp = FileUploadResponse {
            token: "t".into(),
            filename: "f".into(),
            size: 100,
            content_type: "c".into(),
            download_url: "d".into(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["token"], "t");
        assert_eq!(json["filename"], "f");
    }

    #[test]
    fn file_rate_limit_constants() {
        assert_eq!(MAX_DOWNLOADS_PER_IP, 60);
        assert_eq!(DOWNLOAD_WINDOW_SECS, 60);
        const { assert!(MAX_DOWNLOAD_RATE_ENTRIES > 0) };
    }

    // ── W4-7 / W4-8: MIME sniffer coverage ────────────────────────

    async fn write_temp(contents: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let name = format!("sniff-test-{}.bin", Uuid::new_v4());
        let path = dir.join(name);
        tokio::fs::write(&path, contents).await.unwrap();
        path
    }

    #[tokio::test]
    async fn sniff_mime_accepts_matching_png() {
        // 8-byte PNG magic → infer returns image/png.
        let path = write_temp(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).await;
        let out = sniff_mime(&path, "image/png").await.unwrap();
        assert_eq!(out, "image/png");
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn sniff_mime_rejects_png_labelled_as_jpeg() {
        // W4-8: payload/label mismatch must fail validation, never succeed.
        let path = write_temp(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).await;
        let err = sniff_mime(&path, "image/jpeg").await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn sniff_mime_replaces_octet_stream_with_detected() {
        let path = write_temp(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).await;
        let out = sniff_mime(&path, "application/octet-stream").await.unwrap();
        assert_eq!(out, "image/png");
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn sniff_mime_accepts_well_formed_claim_for_unknown_body() {
        // Plain ASCII — infer returns None; a sane claim survives.
        let path = write_temp(b"hello,world\n1,2\n").await;
        let out = sniff_mime(&path, "text/csv").await.unwrap();
        assert_eq!(out, "text/csv");
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn sniff_mime_rejects_header_injection_in_claim() {
        // W4-8: CRLF in a claimed MIME is a classic header-injection probe.
        let path = write_temp(b"just some text").await;
        let err = sniff_mime(&path, "text/plain\r\nX-Evil: 1")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn sniff_mime_rejects_missing_slash_in_claim() {
        let path = write_temp(b"bytes").await;
        let err = sniff_mime(&path, "notamime").await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn sniff_mime_empty_file_falls_back_to_octet_stream_claim() {
        let path = write_temp(b"").await;
        let out = sniff_mime(&path, "").await.unwrap();
        assert_eq!(out, "application/octet-stream");
        let _ = tokio::fs::remove_file(path).await;
    }
}
