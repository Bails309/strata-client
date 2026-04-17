// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Session-scoped temporary file store.
//!
//! Files are stored on disk in a temp directory and tracked in an in-memory
//! index.  Each file is associated with a session ID and a random, unguessable
//! token.  When a session disconnects the tunnel cleanup code calls
//! `cleanup_session` to delete all files for that session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

/// Metadata for a stored file.
#[derive(Debug, Clone)]
pub struct StoredFile {
    /// Random token used in the download URL.
    pub token: String,
    /// Session that uploaded this file.
    pub session_id: String,
    /// User who uploaded.
    pub user_id: Uuid,
    /// Original filename from the upload.
    pub filename: String,
    /// MIME type (best-effort from the upload).
    pub content_type: String,
    /// Size in bytes.
    pub size: u64,
    /// Absolute path on disk.
    pub path: PathBuf,
    /// When the file was uploaded.
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// Thread-safe file store backed by a temp directory.
#[derive(Clone)]
pub struct FileStore {
    inner: Arc<RwLock<FileStoreInner>>,
}

struct FileStoreInner {
    /// token → file metadata
    files: HashMap<String, StoredFile>,
    /// session_id → list of tokens
    sessions: HashMap<String, Vec<String>>,
    /// Root directory for stored files.
    root: PathBuf,
}

/// Maximum file size: 500 MB.
pub const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;

/// Maximum files per session.
pub const MAX_FILES_PER_SESSION: usize = 20;

impl FileStore {
    /// Create a new file store.  `root` is created if it does not exist.
    pub async fn new(root: PathBuf) -> Self {
        tokio::fs::create_dir_all(&root).await.ok();
        Self {
            inner: Arc::new(RwLock::new(FileStoreInner {
                files: HashMap::new(),
                sessions: HashMap::new(),
                root,
            })),
        }
    }

    /// Store a file from an already-written temp path and return its metadata.
    /// The file at `temp_path` is moved (renamed) into the store directory.
    pub async fn store_from_path(
        &self,
        session_id: &str,
        user_id: Uuid,
        filename: &str,
        content_type: &str,
        temp_path: &std::path::Path,
        size: u64,
    ) -> Result<StoredFile, FileStoreError> {
        if size > MAX_FILE_SIZE {
            return Err(FileStoreError::TooLarge);
        }

        let safe_name = Path::new(filename)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("upload")
            .to_string();

        let token = Uuid::new_v4().to_string();

        let inner = self.inner.write().await;

        let count = inner.sessions.get(session_id).map(|v| v.len()).unwrap_or(0);
        if count >= MAX_FILES_PER_SESSION {
            return Err(FileStoreError::TooManyFiles);
        }

        let dir = inner.root.join(&token);
        let file_path = dir.join(&safe_name);

        // Release the lock before doing I/O, then re-acquire to update index.
        drop(inner);
        tokio::fs::create_dir_all(&dir).await.map_err(FileStoreError::Io)?;

        // Move (rename) the temp file into the store; fall back to copy+delete
        // if rename fails (e.g. cross-filesystem).
        if tokio::fs::rename(temp_path, &file_path).await.is_err() {
            tokio::fs::copy(temp_path, &file_path).await.map_err(FileStoreError::Io)?;
            let _ = tokio::fs::remove_file(temp_path).await;
        }

        let meta = StoredFile {
            token: token.clone(),
            session_id: session_id.to_string(),
            user_id,
            filename: safe_name,
            content_type: content_type.to_string(),
            size,
            path: file_path,
            created_at: chrono::Utc::now(),
        };

        let mut inner = self.inner.write().await;
        inner.files.insert(token.clone(), meta.clone());
        inner
            .sessions
            .entry(session_id.to_string())
            .or_default()
            .push(token);

        Ok(meta)
    }

    /// Look up a file by its download token.
    pub async fn get(&self, token: &str) -> Option<StoredFile> {
        self.inner.read().await.files.get(token).cloned()
    }

    /// List all files for a session.
    pub async fn list_session(&self, session_id: &str) -> Vec<StoredFile> {
        let inner = self.inner.read().await;
        inner
            .sessions
            .get(session_id)
            .map(|tokens| {
                tokens
                    .iter()
                    .filter_map(|t| inner.files.get(t).cloned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Delete a single file by token.  Returns `true` if it existed.
    pub async fn delete(&self, token: &str) -> bool {
        let mut inner = self.inner.write().await;
        if let Some(meta) = inner.files.remove(token) {
            // Remove from session index.
            if let Some(tokens) = inner.sessions.get_mut(&meta.session_id) {
                tokens.retain(|t| t != token);
                if tokens.is_empty() {
                    inner.sessions.remove(&meta.session_id);
                }
            }
            // Remove from disk (release lock first).
            let dir = meta.path.parent().unwrap_or(Path::new("")).to_path_buf();
            drop(inner);
            tokio::fs::remove_dir_all(&dir).await.ok();
            true
        } else {
            false
        }
    }

    /// Delete ALL files for a session.  Called when the tunnel disconnects.
    /// Returns the number of files cleaned up.
    pub async fn cleanup_session(&self, session_id: &str) -> usize {
        let mut inner = self.inner.write().await;
        if let Some(tokens) = inner.sessions.remove(session_id) {
            let count = tokens.len();
            let mut dirs_to_remove = Vec::new();
            for token in tokens {
                if let Some(meta) = inner.files.remove(&token) {
                    let dir = meta.path.parent().unwrap_or(Path::new("")).to_path_buf();
                    dirs_to_remove.push(dir);
                }
            }
            drop(inner);
            for dir in dirs_to_remove {
                tokio::fs::remove_dir_all(&dir).await.ok();
            }
            count
        } else {
            0
        }
    }
}

impl std::fmt::Debug for FileStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileStore").finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FileStoreError {
    #[error("File exceeds the maximum size of {MAX_FILE_SIZE} bytes")]
    TooLarge,
    #[error("Maximum of {MAX_FILES_PER_SESSION} files per session")]
    TooManyFiles,
    #[error("I/O error: {0}")]
    Io(std::io::Error),
}
