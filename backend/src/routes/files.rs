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
use tokio_util::io::ReaderStream;

use crate::error::AppError;
use crate::services::app_state::{BootPhase, SharedState};
use crate::services::file_store::StoredFile;
use crate::services::middleware::AuthUser;

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
    let file_store = {
        let s = state.read().await;
        if s.phase != BootPhase::Running {
            return Err(AppError::SetupRequired);
        }
        s.file_store.clone()
    };

    let mut session_id: Option<String> = None;
    let mut file_data: Option<(String, String, Vec<u8>)> = None;

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
                let filename = field
                    .file_name()
                    .unwrap_or("upload")
                    .to_string();
                let content_type = field
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::Validation(format!("Failed to read file: {e}")))?;
                file_data = Some((filename, content_type, data.to_vec()));
            }
            _ => { /* ignore unknown fields */ }
        }
    }

    let session_id =
        session_id.ok_or_else(|| AppError::Validation("Missing session_id field".into()))?;
    let (filename, content_type, data) =
        file_data.ok_or_else(|| AppError::Validation("Missing file field".into()))?;

    let meta = file_store
        .store(&session_id, user.id, &filename, &content_type, &data)
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?;

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

/// `GET /api/files/:token` — Download a file.
///
/// This endpoint is intentionally **unauthenticated**.  The random UUID token
/// serves as a capability — anyone with the URL can download the file.
/// This allows the remote desktop (which has no Strata auth) to fetch it.
pub async fn download(
    State(state): State<SharedState>,
    Path(token): Path<String>,
) -> Result<Response, AppError> {
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

    // Use Content-Disposition: attachment so the browser downloads it.
    let disposition = format!(
        "attachment; filename=\"{}\"",
        meta.filename.replace('"', "'")
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
pub async fn list_session_files(
    State(state): State<SharedState>,
    Extension(_user): Extension<AuthUser>,
    Path(session_id): Path<String>,
) -> Result<axum::Json<Vec<FileListEntry>>, AppError> {
    let file_store = {
        let s = state.read().await;
        s.file_store.clone()
    };

    let files = file_store.list_session(&session_id).await;
    let entries: Vec<FileListEntry> = files.iter().map(FileListEntry::from).collect();
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
