use std::collections::HashSet;

// ── Recording config ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum StorageType {
    Local,
    AzureBlob,
}

/// Parse a storage type string from settings into a `StorageType` enum.
pub fn parse_storage_type(s: &str) -> StorageType {
    match s {
        "azure_blob" => StorageType::AzureBlob,
        _ => StorageType::Local,
    }
}

/// Parse a retention days string, defaulting to 30 on invalid input.
pub fn parse_retention_days(s: &str) -> u32 {
    s.parse().unwrap_or(30)
}

/// Check whether recordings are enabled from a settings string value.
pub fn parse_recording_enabled(s: &str) -> bool {
    s == "true"
}

pub struct RecordingConfig {
    pub enabled: bool,
    /// Refuse or end a session rather than let it run unrecorded.
    pub required: bool,
    pub retention_days: u32,
    pub storage_type: StorageType,
}

pub async fn get_config(pool: &sqlx::Pool<sqlx::Postgres>) -> anyhow::Result<RecordingConfig> {
    let enabled = parse_recording_enabled(
        &crate::services::settings::get(pool, "recordings_enabled")
            .await?
            .unwrap_or_else(|| "false".into()),
    );
    let required = crate::services::settings::get(pool, "recordings_required")
        .await?
        .is_some_and(|v| v == "true");

    let retention_days = parse_retention_days(
        &crate::services::settings::get(pool, "recordings_retention_days")
            .await?
            .unwrap_or_else(|| "30".into()),
    );

    let storage_type = parse_storage_type(
        &crate::services::settings::get(pool, "recordings_storage_type")
            .await?
            .unwrap_or_else(|| "local".into()),
    );

    Ok(RecordingConfig {
        enabled,
        required,
        retention_days,
        storage_type,
    })
}

// ── Azure Blob Storage ─────────────────────────────────────────────────

#[derive(Clone)]
pub struct AzureBlobConfig {
    pub account_name: String,
    pub container_name: String,
    pub access_key: String,
}

pub async fn get_azure_config(
    pool: &sqlx::Pool<sqlx::Postgres>,
    vault: Option<&crate::config::VaultConfig>,
) -> anyhow::Result<Option<AzureBlobConfig>> {
    let account_name =
        crate::services::settings::get(pool, "recordings_azure_account_name").await?;
    let access_key_raw =
        crate::services::settings::get(pool, "recordings_azure_access_key").await?;
    let container_name =
        crate::services::settings::get(pool, "recordings_azure_container_name").await?;

    // DIAG: surface which settings are present (never log key material).
    let raw_kind = match access_key_raw.as_deref() {
        None => "missing",
        Some("") => "empty",
        Some(s) if s.starts_with("vault:") => "vault-sealed",
        Some(_) => "plaintext",
    };
    tracing::info!(
        target: "recordings.diag",
        account_name_present = account_name.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
        account_name = account_name.as_deref().unwrap_or(""),
        container_name = container_name.as_deref().unwrap_or(""),
        access_key_kind = raw_kind,
        vault_configured = vault.is_some(),
        "recordings: loaded Azure settings from DB"
    );

    // Decrypt access key if vault-encrypted
    let access_key = match access_key_raw {
        Some(ref raw) if raw.starts_with("vault:") => {
            if let Some(vc) = vault {
                match crate::services::vault::unseal_setting(vc, raw).await {
                    Ok(decrypted) => {
                        tracing::info!(
                            target: "recordings.diag",
                            "recordings: Azure access key unsealed from Vault"
                        );
                        Some(decrypted)
                    }
                    Err(e) => {
                        tracing::error!("Failed to decrypt Azure access key: {e}");
                        None
                    }
                }
            } else {
                tracing::warn!("Azure access key is vault-encrypted but Vault is not configured");
                None
            }
        }
        other => other,
    };

    match (account_name, access_key) {
        (Some(name), Some(key)) if !name.is_empty() && !key.is_empty() => {
            Ok(Some(AzureBlobConfig {
                account_name: name,
                container_name: container_name.unwrap_or_else(|| "recordings".into()),
                access_key: key,
            }))
        }
        (name, key) => {
            tracing::warn!(
                target: "recordings.diag",
                account_name_empty_or_missing = name.as_deref().map(str::is_empty).unwrap_or(true),
                access_key_empty_or_missing = key.as_deref().map(str::is_empty).unwrap_or(true),
                "recordings: Azure backend selected but config is incomplete; uploads disabled"
            );
            Ok(None)
        }
    }
}

impl AzureBlobConfig {
    fn blob_url(&self, blob: &str) -> anyhow::Result<reqwest::Url> {
        let encoded = urlencoding::encode(blob);
        let raw = format!(
            "https://{}.blob.core.windows.net/{}/{}",
            self.account_name, self.container_name, encoded
        );
        let url = reqwest::Url::parse(&raw)
            .map_err(|e| anyhow::anyhow!("Invalid Azure Blob URL: {e}"))?;
        if url.scheme() != "https" {
            anyhow::bail!("Refusing to transmit credentials: Azure Blob URL must use HTTPS");
        }
        Ok(url)
    }

    fn sign(
        &self,
        verb: &str,
        content_length: usize,
        content_type: &str,
        x_headers: &str,
        resource: &str,
    ) -> anyhow::Result<String> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        use hmac::{Hmac, KeyInit, Mac};
        use sha2::Sha256;

        let cl = if content_length > 0 {
            content_length.to_string()
        } else {
            String::new()
        };
        let string_to_sign =
            format!("{verb}\n\n\n{cl}\n\n{content_type}\n\n\n\n\n\n\n{x_headers}\n{resource}");

        let key_bytes = B64
            .decode(&self.access_key)
            .map_err(|e| anyhow::anyhow!("invalid base64 storage key: {e}"))?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key_bytes)
            .map_err(|e| anyhow::anyhow!("HMAC init failed: {e}"))?;
        mac.update(string_to_sign.as_bytes());
        let sig = B64.encode(mac.finalize().into_bytes());

        Ok(format!("SharedKey {}:{sig}", self.account_name))
    }
}

#[allow(dead_code)]
pub async fn upload_to_azure(
    cfg: &AzureBlobConfig,
    blob: &str,
    data: Vec<u8>,
) -> anyhow::Result<()> {
    let url = cfg.blob_url(blob)?;
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let ct = "application/octet-stream";
    let x_headers = format!("x-ms-blob-type:BlockBlob\nx-ms-date:{date}\nx-ms-version:2023-11-03");
    let resource = format!("/{}/{}/{blob}", cfg.account_name, cfg.container_name);
    let auth = cfg.sign("PUT", data.len(), ct, &x_headers, &resource)?;

    let client = crate::services::http_client::azure_client();
    let resp = client
        .put(url)
        .header("Authorization", auth)
        .header("x-ms-date", &date)
        .header("x-ms-version", "2023-11-03")
        .header("x-ms-blob-type", "BlockBlob")
        .header("Content-Type", ct)
        .body(data)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Azure Blob upload failed ({status}): {body}");
    }

    Ok(())
}

/// Stream a file from disk to Azure Blob Storage without loading it entirely into memory.
///
/// W3-4 — wraps the single-shot operation in `retry_transient_with_jitter`
/// so a network blip or 5xx from Azure does not immediately surface as a
/// recording-upload failure.
pub async fn upload_file_to_azure(
    cfg: &AzureBlobConfig,
    blob: &str,
    file_path: &str,
) -> anyhow::Result<()> {
    crate::services::retry::retry_transient_with_jitter(
        "azure_blob.upload",
        || upload_file_to_azure_once(cfg, blob, file_path),
        crate::services::retry::is_http_transient,
        3,
        std::time::Duration::from_millis(500),
    )
    .await
}

async fn upload_file_to_azure_once(
    cfg: &AzureBlobConfig,
    blob: &str,
    file_path: &str,
) -> anyhow::Result<()> {
    let meta = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| anyhow::anyhow!("Cannot stat {file_path}: {e}"))?;
    let file_len = meta.len() as usize;

    let url = cfg.blob_url(blob)?;
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let ct = "application/octet-stream";
    let x_headers = format!("x-ms-blob-type:BlockBlob\nx-ms-date:{date}\nx-ms-version:2023-11-03");
    let resource = format!("/{}/{}/{blob}", cfg.account_name, cfg.container_name);
    let auth = cfg.sign("PUT", file_len, ct, &x_headers, &resource)?;

    let file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| anyhow::anyhow!("Cannot open {file_path}: {e}"))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    let body = reqwest::Body::wrap_stream(stream);

    let client = crate::services::http_client::azure_client();
    let resp = client
        .put(url)
        .header("Authorization", auth)
        .header("x-ms-date", &date)
        .header("x-ms-version", "2023-11-03")
        .header("x-ms-blob-type", "BlockBlob")
        .header("Content-Type", ct)
        .header("Content-Length", file_len)
        .body(body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("Azure Blob upload failed ({status}): {text}");
    }

    Ok(())
}

/// W3-4 — retrying wrapper around a single GET.
pub async fn download_from_azure(cfg: &AzureBlobConfig, blob: &str) -> anyhow::Result<Vec<u8>> {
    crate::services::retry::retry_transient_with_jitter(
        "azure_blob.download",
        || download_from_azure_once(cfg, blob),
        crate::services::retry::is_http_transient,
        3,
        std::time::Duration::from_millis(500),
    )
    .await
}

async fn download_from_azure_once(cfg: &AzureBlobConfig, blob: &str) -> anyhow::Result<Vec<u8>> {
    let url = cfg.blob_url(blob)?;
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let x_headers = format!("x-ms-date:{date}\nx-ms-version:2023-11-03");
    let resource = format!("/{}/{}/{blob}", cfg.account_name, cfg.container_name);
    let auth = cfg.sign("GET", 0, "", &x_headers, &resource)?;

    let client = crate::services::http_client::azure_client();
    let resp = client
        .get(url)
        .header("Authorization", auth)
        .header("x-ms-date", &date)
        .header("x-ms-version", "2023-11-03")
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Azure Blob download failed ({status}): {body}");
    }

    Ok(resp.bytes().await?.to_vec())
}

pub async fn download_stream_from_azure(
    cfg: &AzureBlobConfig,
    blob: &str,
) -> anyhow::Result<impl futures_util::Stream<Item = reqwest::Result<bytes::Bytes>>> {
    let url = cfg.blob_url(blob)?;
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let x_headers = format!("x-ms-date:{date}\nx-ms-version:2023-11-03");
    let resource = format!("/{}/{}/{blob}", cfg.account_name, cfg.container_name);
    let auth = cfg.sign("GET", 0, "", &x_headers, &resource)?;

    let client = crate::services::http_client::azure_client();
    let resp = client
        .get(url)
        .header("Authorization", auth)
        .header("x-ms-date", &date)
        .header("x-ms-version", "2023-11-03")
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Azure Blob download failed ({status}): {body}");
    }

    Ok(resp.bytes_stream())
}

// ── Background sync task ───────────────────────────────────────────────

/// Delete a blob from Azure Blob Storage (W3-4 retrying wrapper).
pub async fn delete_from_azure(cfg: &AzureBlobConfig, blob: &str) -> anyhow::Result<()> {
    crate::services::retry::retry_transient_with_jitter(
        "azure_blob.delete",
        || delete_from_azure_once(cfg, blob),
        crate::services::retry::is_http_transient,
        3,
        std::time::Duration::from_millis(500),
    )
    .await
}

async fn delete_from_azure_once(cfg: &AzureBlobConfig, blob: &str) -> anyhow::Result<()> {
    let url = cfg.blob_url(blob)?;
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let x_headers = format!("x-ms-date:{date}\nx-ms-version:2023-11-03");
    let resource = format!("/{}/{}/{blob}", cfg.account_name, cfg.container_name);
    let auth = cfg.sign("DELETE", 0, "", &x_headers, &resource)?;

    let client = crate::services::http_client::azure_client();
    let resp = client
        .delete(url)
        .header("Authorization", auth)
        .header("x-ms-date", &date)
        .header("x-ms-version", "2023-11-03")
        .send()
        .await?;

    // 202 Accepted = success, 404 = already gone (both fine)
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("Azure Blob delete failed ({status}): {body}");
    }

    Ok(())
}

/// W2-4 / W2-7 — shared worker harness: cancellation, per-iteration timeout,
/// jittered error backoff. The `synced` set is kept across iterations via an
/// `Arc<Mutex<_>>` so repeated work is not re-done on every tick.
pub fn spawn_sync_task(
    state: crate::services::app_state::SharedState,
    shutdown: tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    use crate::services::worker::{spawn_periodic, PeriodicConfig};
    let synced = std::sync::Arc::new(tokio::sync::Mutex::new(HashSet::<String>::new()));
    tracing::info!(
        target: "recordings.diag",
        "recordings: spawning sync task (initial_delay=20s, interval=60s)"
    );
    spawn_periodic(
        PeriodicConfig {
            label: "recording_sync",
            initial_delay: std::time::Duration::from_secs(20),
            interval: std::time::Duration::from_secs(60),
            // Uploads can be chunky; cap the pass at 10 minutes.
            iteration_timeout: std::time::Duration::from_secs(10 * 60),
            error_backoff_base: std::time::Duration::from_secs(15),
        },
        shutdown,
        move || {
            let state = state.clone();
            let synced = synced.clone();
            async move {
                let (pool, vault) = {
                    let s = state.read().await;
                    let pool = match s.db.as_ref() {
                        Some(db) => db.pool.clone(),
                        None => return Ok(()),
                    };
                    let vault = s.config.as_ref().and_then(|c| c.vault.clone());
                    (pool, vault)
                };
                let mut synced = synced.lock().await;
                sync_pass(&pool, &mut synced, vault.as_ref()).await
            }
        },
    )
}

async fn sync_pass(
    pool: &sqlx::Pool<sqlx::Postgres>,
    synced: &mut HashSet<String>,
    vault: Option<&crate::config::VaultConfig>,
) -> anyhow::Result<()> {
    let config = get_config(pool).await?;
    tracing::info!(
        target: "recordings.diag",
        enabled = config.enabled,
        storage_type = ?config.storage_type,
        retention_days = config.retention_days,
        synced_cache_size = synced.len(),
        "recordings: sync_pass tick"
    );
    if !config.enabled {
        return Ok(());
    }

    let dir = "/var/lib/guacamole/recordings";

    // ── Azure Blob sync (if configured) ──
    if config.storage_type == StorageType::AzureBlob {
        let azure = match get_azure_config(pool, vault).await? {
            Some(c) => c,
            None => {
                tracing::warn!(
                    target: "recordings.diag",
                    "recordings: storage_type=azure_blob but get_azure_config returned None; skipping upload pass"
                );
                return Ok(());
            }
        };
        tracing::info!(
            target: "recordings.diag",
            account = %azure.account_name,
            container = %azure.container_name,
            dir = %dir,
            "recordings: Azure config loaded; scanning recordings directory"
        );

        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(
                    target: "recordings.diag",
                    error = %e,
                    dir = %dir,
                    "recordings: cannot read recordings directory"
                );
                return Ok(());
            }
        };

        let mut scanned: usize = 0;
        let mut skipped_too_new: usize = 0;
        let mut skipped_cached: usize = 0;
        let mut uploaded: usize = 0;
        let mut failed: usize = 0;

        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            scanned += 1;
            if name.starts_with('.') {
                continue;
            }
            if synced.contains(&name) {
                skipped_cached += 1;
                continue;
            }

            // Skip files still being written (modified < 30 s ago)
            if let Ok(meta) = entry.metadata().await {
                if let Ok(modified) = meta.modified() {
                    let age = modified.elapsed().unwrap_or_default();
                    if age < std::time::Duration::from_secs(30) {
                        skipped_too_new += 1;
                        tracing::debug!(
                            target: "recordings.diag",
                            file = %name,
                            age_secs = age.as_secs(),
                            "recordings: skip — file modified <30s ago"
                        );
                        continue;
                    }
                }
            }

            let path = format!("{dir}/{name}");
            tracing::info!(
                target: "recordings.diag",
                file = %name,
                "recordings: uploading to Azure Blob"
            );
            match upload_file_to_azure(&azure, &name, &path).await {
                Ok(_) => {
                    uploaded += 1;
                    synced.insert(name.clone());

                    // Update database metadata to reflect Azure storage
                    let res = sqlx::query(
                        "UPDATE recordings SET storage_type = 'azure' WHERE storage_path = $1",
                    )
                    .bind(&name)
                    .execute(pool)
                    .await;
                    match res {
                        Ok(r) => tracing::info!(
                            target: "recordings.diag",
                            file = %name,
                            rows_updated = r.rows_affected(),
                            "recordings: DB storage_type updated to 'azure'"
                        ),
                        Err(e) => tracing::warn!(
                            target: "recordings.diag",
                            file = %name,
                            error = %e,
                            "recordings: failed to update DB storage_type"
                        ),
                    }

                    // Delete local file after successful upload to prevent disk growth
                    if let Err(e) = tokio::fs::remove_file(&path).await {
                        tracing::warn!(
                            "Failed to delete local recording after upload: {name}: {e}"
                        );
                    }
                    tracing::info!("Synced recording to Azure Blob: {name}");
                }
                Err(e) => {
                    failed += 1;
                    tracing::warn!("Azure Blob upload failed for {name}: {e}");
                }
            }
        }

        tracing::info!(
            target: "recordings.diag",
            scanned, skipped_too_new, skipped_cached, uploaded, failed,
            "recordings: Azure sync pass complete"
        );
    }

    // ── Retention-based cleanup for local recordings ──
    if config.retention_days > 0 {
        let max_age = std::time::Duration::from_secs(config.retention_days as u64 * 86_400);
        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };

        // Aggregate read-only filesystem failures into a single warning per
        // cleanup cycle. When the recordings volume is mounted RO the per-
        // file warning loop flooded the logs (one line per expired file,
        // every cycle, forever).
        let mut ro_fs_count: usize = 0;

        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if let Ok(meta) = entry.metadata().await {
                if let Ok(modified) = meta.modified() {
                    if modified.elapsed().unwrap_or_default() > max_age {
                        let path = format!("{dir}/{name}");
                        if let Err(e) = tokio::fs::remove_file(&path).await {
                            // errno 30 (EROFS) on Linux / ErrorKind::ReadOnlyFilesystem
                            // on newer Rust. Either way: the FS is RO, the
                            // file will still be here next cycle, so don't
                            // flood the logs.
                            let is_ro = e.raw_os_error() == Some(30);
                            if is_ro {
                                ro_fs_count += 1;
                                tracing::debug!(
                                    "Skipped expired recording on read-only FS: {name}"
                                );
                            } else {
                                tracing::warn!("Failed to delete expired recording: {name}: {e}");
                            }
                        } else {
                            synced.remove(&name);
                            tracing::info!(
                                "Deleted expired recording (>{} days): {name}",
                                config.retention_days
                            );
                        }
                    }
                }
            }
        }

        if ro_fs_count > 0 {
            tracing::warn!(
                "Skipped {ro_fs_count} expired recording(s): recordings directory \
                 is on a read-only filesystem ({dir})"
            );
        }

        // W5-1: DB + Azure blob purge for rows older than retention.
        // The filesystem pass above handles any local files that survived an
        // earlier sync cycle; here we clear the corresponding DB rows and,
        // for Azure-backed recordings, the remote blob too.
        let doomed: Vec<(String, String)> = sqlx::query_as(
            "SELECT storage_path, storage_type
             FROM recordings
             WHERE created_at < now() - make_interval(days => $1)",
        )
        .bind(config.retention_days as i32)
        .fetch_all(pool)
        .await
        .unwrap_or_default();

        if !doomed.is_empty() {
            let azure_cfg = if config.storage_type == StorageType::AzureBlob {
                get_azure_config(pool, vault).await.ok().flatten()
            } else {
                None
            };

            let mut purged_local = 0usize;
            let mut purged_azure = 0usize;
            for (storage_path, storage_type) in &doomed {
                match storage_type.as_str() {
                    "azure" | "azure_blob" => {
                        if let Some(ref cfg) = azure_cfg {
                            match delete_from_azure(cfg, storage_path).await {
                                Ok(_) => purged_azure += 1,
                                Err(e) => tracing::warn!(
                                    "Azure retention purge failed for {storage_path}: {e}"
                                ),
                            }
                        }
                    }
                    _ => {
                        // Local files should already be gone from the pass
                        // above, but attempt a best-effort unlink to mop up
                        // orphans (e.g. DB row survived a crash mid-delete).
                        let p = format!("{dir}/{storage_path}");
                        if tokio::fs::remove_file(&p).await.is_ok() {
                            purged_local += 1;
                        }
                    }
                }
            }

            let deleted_rows = sqlx::query(
                "DELETE FROM recordings WHERE created_at < now() - make_interval(days => $1)",
            )
            .bind(config.retention_days as i32)
            .execute(pool)
            .await?
            .rows_affected();

            if deleted_rows > 0 {
                tracing::info!(
                    "Retention purge: removed {deleted_rows} recording row(s), \
                     {purged_azure} azure blob(s), {purged_local} orphan local file(s)"
                );
            }
        }
    }

    Ok(())
}

// ── User-facing recording queries ──────────────────────────────────────

/// List recordings owned by a user, optionally filtered by connection.
pub async fn list_for_user(
    pool: &sqlx::Pool<sqlx::Postgres>,
    user_id: uuid::Uuid,
    connection_id: Option<uuid::Uuid>,
    search: Option<String>,
    limit: i64,
    offset: i64,
) -> Result<Vec<crate::db::Recording>, crate::error::AppError> {
    let search_pattern = search.map(|s| format!("%{}%", s));
    let rows = sqlx::query_as::<_, crate::db::Recording>(
        "SELECT * FROM recordings
         WHERE user_id = $1
           AND ($2::uuid IS NULL OR connection_id = $2)
           AND ($3::text IS NULL OR connection_name ILIKE $3 OR username ILIKE $3)
         ORDER BY started_at DESC, id DESC
         LIMIT $4 OFFSET $5",
    )
    .bind(user_id)
    .bind(connection_id)
    .bind(search_pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Fetch a recording iff it belongs to `user_id`.
pub async fn get_owned_by_user(
    pool: &sqlx::Pool<sqlx::Postgres>,
    recording_id: uuid::Uuid,
    user_id: uuid::Uuid,
) -> Result<Option<crate::db::Recording>, crate::error::AppError> {
    let row = sqlx::query_as("SELECT * FROM recordings WHERE id = $1 AND user_id = $2")
        .bind(recording_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// Insert the initial row marking the start of a session recording.
/// Storage type is always `'local'` at handshake — Azure uploads are
/// performed asynchronously after the session ends.
#[allow(clippy::too_many_arguments)]
pub async fn insert_start(
    pool: &sqlx::Pool<sqlx::Postgres>,
    session_id: String,
    connection_id: uuid::Uuid,
    connection_name: String,
    user_id: uuid::Uuid,
    username: String,
    storage_path: String,
    started_at: chrono::DateTime<chrono::Utc>,
    client_ip: Option<String>,
) -> Result<(), crate::error::AppError> {
    sqlx::query(
        "INSERT INTO recordings (session_id, connection_id, connection_name, user_id, username, storage_path, storage_type, started_at, client_ip, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'local', $7, $8, 'recording')",
    )
    .bind(session_id)
    .bind(connection_id)
    .bind(connection_name)
    .bind(user_id)
    .bind(username)
    .bind(storage_path)
    .bind(started_at)
    .bind(client_ip)
    .execute(pool)
    .await?;
    Ok(())
}

/// Record that a recording failed or stopped short.
pub async fn mark_failed(
    pool: &sqlx::Pool<sqlx::Postgres>,
    session_id: &str,
    status: &str,
    failure: &str,
) {
    if let Err(e) =
        sqlx::query("UPDATE recordings SET status = $2, failure = $3 WHERE session_id = $1")
            .bind(session_id)
            .bind(status)
            .bind(failure)
            .execute(pool)
            .await
    {
        tracing::error!(session_id, error = %e, "could not record the recording failure");
    }
}

/// Recordings still marked in progress when the backend starts were cut
/// short by the previous process ending. The backend runs as one replica,
/// so none of them can still be live.
pub async fn mark_interrupted(pool: &sqlx::Pool<sqlx::Postgres>) -> Result<u64, sqlx::Error> {
    let r = sqlx::query(
        "UPDATE recordings SET status = 'incomplete',
             failure = 'the backend stopped before the session ended'
         WHERE status = 'recording'",
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

// ── Admin session stats (30-day window) ────────────────────────────────

/// Scalar aggregates over the 30-day recordings window.
/// Tuple: (total_sessions, total_hours, unique_users, avg_duration_mins,
/// median_duration_mins, total_bandwidth_bytes).
pub type SessionStatsScalars = (i64, f64, i64, f64, f64, i64);

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct TopConnectionRow {
    pub name: String,
    pub protocol: String,
    pub sessions: i64,
    pub total_hours: f64,
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct TopUserRow {
    pub username: String,
    pub sessions: i64,
    pub total_hours: f64,
    pub last_session: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct DailyTrendRow {
    pub date: chrono::NaiveDate,
    pub sessions: i64,
    pub hours: f64,
    pub unique_users: i64,
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct ProtocolDistributionRow {
    pub protocol: String,
    pub sessions: i64,
    pub total_hours: f64,
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct PeakHourRow {
    pub hour: f64,
    pub sessions: i64,
}

/// Scalar aggregates for the admin session-stats dashboard.
pub async fn fetch_session_stats_scalars(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> Result<SessionStatsScalars, crate::error::AppError> {
    let row = sqlx::query_as(
        "WITH cutoff_data AS (
            SELECT * FROM recordings WHERE started_at >= NOW() - INTERVAL '30 days'
        )
        SELECT
            (SELECT COUNT(*) FROM cutoff_data),
            (SELECT COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) FROM cutoff_data),
            (SELECT COUNT(DISTINCT user_id) FROM cutoff_data),
            (SELECT COALESCE(AVG(duration_secs::float) / 60.0, 0.0) FROM cutoff_data WHERE duration_secs IS NOT NULL),
            (SELECT COALESCE((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_secs))::float / 60.0, 0.0) FROM cutoff_data WHERE duration_secs IS NOT NULL),
            (SELECT COALESCE(SUM(COALESCE(bytes_down, 0) + COALESCE(bytes_up, 0)), 0)::bigint FROM cutoff_data)",
    )
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Daily session totals for the last 30 days.
pub async fn fetch_daily_trend(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> Result<Vec<DailyTrendRow>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT started_at::date AS date,
                COUNT(*) AS sessions,
                COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) AS hours,
                COUNT(DISTINCT user_id) AS unique_users
         FROM recordings
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY started_at::date
         ORDER BY date",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Session counts by connection protocol over the last 30 days.
pub async fn fetch_protocol_distribution(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> Result<Vec<ProtocolDistributionRow>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT COALESCE((SELECT protocol FROM connections c WHERE c.id = r.connection_id), 'unknown') AS protocol,
                COUNT(*) AS sessions,
                COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) AS total_hours
         FROM recordings r
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY protocol
         ORDER BY sessions DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Session counts bucketed by hour-of-day over the last 30 days.
pub async fn fetch_peak_hours(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> Result<Vec<PeakHourRow>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT EXTRACT(HOUR FROM started_at)::float AS hour,
                COUNT(*) AS sessions
         FROM recordings
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY hour
         ORDER BY hour",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Top-10 connections by session count over the last 30 days.
pub async fn fetch_top_connections(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> Result<Vec<TopConnectionRow>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT connection_name AS name,
                COALESCE((SELECT protocol FROM connections c WHERE c.id = r.connection_id), 'rdp') AS protocol,
                COUNT(*) AS sessions,
                COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) AS total_hours
         FROM recordings r
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY connection_id, connection_name
         ORDER BY sessions DESC
         LIMIT 10",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Top-10 users by session count over the last 30 days.
pub async fn fetch_top_users(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> Result<Vec<TopUserRow>, crate::error::AppError> {
    let rows = sqlx::query_as(
        "SELECT username,
                COUNT(*) AS sessions,
                COALESCE(SUM(duration_secs)::float / 3600.0, 0.0) AS total_hours,
                MAX(started_at) AS last_session
         FROM recordings
         WHERE started_at >= NOW() - INTERVAL '30 days'
         GROUP BY user_id, username
         ORDER BY sessions DESC
         LIMIT 10",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// ── Admin listing / lookup ─────────────────────────────────────────────

/// Paginated recordings list with optional `user_id` / `connection_id` filters.
pub async fn list_admin(
    pool: &sqlx::Pool<sqlx::Postgres>,
    user_id: Option<uuid::Uuid>,
    connection_id: Option<uuid::Uuid>,
    search: Option<String>,
    limit: i64,
    offset: i64,
) -> Result<Vec<crate::db::Recording>, crate::error::AppError> {
    let search_pattern = search.map(|s| format!("%{}%", s));
    let rows = sqlx::query_as::<_, crate::db::Recording>(
        "SELECT * FROM recordings
         WHERE ($1::uuid IS NULL OR user_id = $1)
           AND ($2::uuid IS NULL OR connection_id = $2)
           AND ($3::text IS NULL OR connection_name ILIKE $3 OR username ILIKE $3)
         ORDER BY started_at DESC, id DESC
         LIMIT $4 OFFSET $5",
    )
    .bind(user_id)
    .bind(connection_id)
    .bind(search_pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Fetch a single recording by id, regardless of ownership.
pub async fn get_by_id(
    pool: &sqlx::Pool<sqlx::Postgres>,
    id: uuid::Uuid,
) -> Result<Option<crate::db::Recording>, crate::error::AppError> {
    let row = sqlx::query_as("SELECT * FROM recordings WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

// ── Session Recording Conversion & Download ────────────────────────────

/// Cheap signature check, used to skip obvious junk before attempting a decode.
///
/// Deliberately has no size floor: lossless WebP of a flat damage
/// rectangle is routinely under a hundred bytes, so one would discard
/// valid frames. [`frame_to_png`] is the real validator.
fn is_valid_image(buf: &[u8]) -> bool {
    buf.starts_with(b"\x89PNG\r\n\x1a\n")
        || buf.starts_with(b"\xFF\xD8\xFF")
        || (buf.len() >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP")
}

/// Normalise a decoded frame to PNG.
///
/// The RDP engine emits PNG for small damage rectangles and WebP for
/// large ones, so a recording carries both. ffmpeg's `image2` demuxer
/// picks one decoder for the whole `frame_%05d.png` sequence, so a mixed
/// sequence decodes as garbage or fails outright — every frame has to
/// reach it in the same format.
///
/// Decoding doubles as validation: a truncated payload fails here rather
/// than poisoning the ffmpeg run.
fn frame_to_png(decoded: &[u8]) -> Option<Vec<u8>> {
    // Already the target format, and re-encoding would only lose time.
    if decoded.starts_with(b"\x89PNG\r\n\x1a\n") && decoded.ends_with(b"IEND\xaeB`\x82") {
        return Some(decoded.to_vec());
    }
    let img = image::load_from_memory(decoded).ok()?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

async fn extract_and_save_guac_frames(data: &[u8], work_dir: &std::path::Path) -> usize {
    use base64::Engine;
    use std::collections::HashMap;

    let mut streams: HashMap<Vec<u8>, Vec<u8>> = HashMap::new();
    let mut count = 0;

    let len = data.len();
    let mut pos = 0;
    let mut current_instruction: Vec<&[u8]> = Vec::new();

    while pos < len {
        let mut num_end = pos;
        while num_end < len && data[num_end].is_ascii_digit() {
            num_end += 1;
        }

        if num_end == pos || num_end >= len || data[num_end] != b'.' {
            while pos < len && data[pos] != b';' {
                pos += 1;
            }
            pos += 1;
            current_instruction.clear();
            continue;
        }

        let elem_len_str = match std::str::from_utf8(&data[pos..num_end]) {
            Ok(s) => s,
            Err(_) => {
                pos = num_end + 1;
                continue;
            }
        };

        let elem_len: usize = match elem_len_str.parse() {
            Ok(n) => n,
            Err(_) => {
                pos = num_end + 1;
                continue;
            }
        };

        let elem_start = num_end + 1;
        let elem_end = elem_start + elem_len;
        if elem_end > len {
            break;
        }

        let elem_val = &data[elem_start..elem_end];
        current_instruction.push(elem_val);

        pos = elem_end;
        if pos < len {
            let delimiter = data[pos];
            pos += 1;

            if delimiter == b';' {
                if !current_instruction.is_empty() {
                    let cmd = current_instruction[0];
                    match cmd {
                        b"png" | b"jpeg" | b"webp" if current_instruction.len() >= 2 => {
                            let stream_idx = current_instruction[1].to_vec();
                            streams.insert(stream_idx, Vec::new());
                        }
                        b"blob" if current_instruction.len() >= 3 => {
                            let stream_idx = current_instruction[1];
                            let chunk = current_instruction[2];
                            if let Some(buf) = streams.get_mut(stream_idx) {
                                buf.extend_from_slice(chunk);
                            } else {
                                streams.insert(stream_idx.to_vec(), chunk.to_vec());
                            }
                        }
                        b"end" if current_instruction.len() >= 2 => {
                            let stream_idx = current_instruction[1];
                            if let Some(b64_bytes) = streams.remove(stream_idx) {
                                let clean_b64: Vec<u8> = b64_bytes
                                    .into_iter()
                                    .filter(|&b| !b.is_ascii_whitespace())
                                    .collect();

                                if let Ok(decoded) =
                                    base64::engine::general_purpose::STANDARD.decode(&clean_b64)
                                {
                                    if is_valid_image(&decoded) {
                                        if let Some(png) = frame_to_png(&decoded) {
                                            count += 1;
                                            let frame_path =
                                                work_dir.join(format!("frame_{count:05}.png"));
                                            let _ = tokio::fs::write(frame_path, png).await;
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                current_instruction.clear();
            }
        }
    }

    // Flush any remaining stream buffers containing valid PNG/JPEG/WEBP images
    for (_idx, b64_bytes) in streams {
        let clean_b64: Vec<u8> = b64_bytes
            .into_iter()
            .filter(|&b| !b.is_ascii_whitespace())
            .collect();

        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&clean_b64) {
            if is_valid_image(&decoded) {
                if let Some(png) = frame_to_png(&decoded) {
                    count += 1;
                    let frame_path = work_dir.join(format!("frame_{count:05}.png"));
                    let _ = tokio::fs::write(frame_path, png).await;
                }
            }
        }
    }

    count
}

/// Scan the first ~64 KiB of a `.guac` recording for the initial `size,0,W,H`
/// instruction (the primary display's dimensions). Returns `None` if we can't
/// find one, in which case callers should fall back to a sensible default.
///
/// Guacamole instructions are length-prefixed: `4.size,1.0,4.1920,4.1080;`.
/// We iterate over every `4.size,` occurrence in the scan window and return
/// the first one that targets layer 0 — this makes us robust against guacd
/// emitting audio/overlay layer size instructions ahead of the primary display.
fn read_recording_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    let scan_len = data.len().min(65_536);
    let hay = &data[..scan_len];
    let needle = b"4.size,";
    let mut search_from = 0;

    while let Some(rel) = hay[search_from..]
        .windows(needle.len())
        .position(|w| w == needle)
    {
        let start = search_from + rel + needle.len();
        search_from = start; // advance past this needle so a bail-out doesn't loop forever

        if let Some(dims) = parse_size_instruction_body(hay, start) {
            return Some(dims);
        }
    }
    None
}

/// Parse the body of a `size,<layer>,<width>,<height>;` instruction starting
/// at the byte after `4.size,`. Returns `None` if the layer isn't 0, if any
/// token is malformed, or if the parsed dimensions are outside sane bounds.
fn parse_size_instruction_body(hay: &[u8], start: usize) -> Option<(u32, u32)> {
    // Parse layer index token: <digits>.<value>,
    let mut p = start;
    while p < hay.len() && hay[p].is_ascii_digit() {
        p += 1;
    }
    if p >= hay.len() || hay[p] != b'.' {
        return None;
    }
    let layer_len: usize = std::str::from_utf8(&hay[start..p]).ok()?.parse().ok()?;
    p += 1;
    let layer_end = p + layer_len;
    if layer_end >= hay.len() || hay[layer_end] != b',' {
        return None;
    }
    if std::str::from_utf8(&hay[p..layer_end]).ok()? != "0" {
        return None;
    }
    p = layer_end + 1;

    // Parse width token: <digits>.<value>,
    let width_num_start = p;
    while p < hay.len() && hay[p].is_ascii_digit() {
        p += 1;
    }
    if p >= hay.len() || hay[p] != b'.' {
        return None;
    }
    let width_len: usize = std::str::from_utf8(&hay[width_num_start..p])
        .ok()?
        .parse()
        .ok()?;
    p += 1;
    if p + width_len > hay.len() {
        return None;
    }
    let width: u32 = std::str::from_utf8(&hay[p..p + width_len])
        .ok()?
        .parse()
        .ok()?;
    p += width_len;
    if p >= hay.len() || hay[p] != b',' {
        return None;
    }
    p += 1;

    // Parse height token: <digits>.<value>;
    let height_num_start = p;
    while p < hay.len() && hay[p].is_ascii_digit() {
        p += 1;
    }
    if p >= hay.len() || hay[p] != b'.' {
        return None;
    }
    let height_len: usize = std::str::from_utf8(&hay[height_num_start..p])
        .ok()?
        .parse()
        .ok()?;
    p += 1;
    if p + height_len > hay.len() {
        return None;
    }
    let height: u32 = std::str::from_utf8(&hay[p..p + height_len])
        .ok()?
        .parse()
        .ok()?;

    // Clamp to sane bounds — reject garbage / accidental matches.
    if !(320..=7680).contains(&width) || !(240..=4320).contains(&height) {
        return None;
    }
    Some((width, height))
}

/// Helper to convert a local `.guac` recording file to an `.mp4` video file using `guacenc` (with `ffmpeg` fallback).
///
/// `guacenc` is Apache Guacamole's session recording encoding utility.
/// When given a `.guac` input file, it renders the instruction stream and outputs an H.264 video file.
///
/// Quality tuning: guacenc defaults to a 640×480 canvas at 2 Mbps, which crushes
/// modern desktop recordings into unreadable VGA. We probe the recording for its
/// actual display dimensions and pass them via `-s`, and force a much higher
/// bitrate via `-r`.
///
/// Conversions are single-flight per recording version and limited to
/// [`MAX_CONVERSIONS`] at once (PERF-05). Each runs in its own scratch
/// directory and its result is published by rename, so a cached output is
/// only ever a complete one.
pub async fn convert_guac_to_mp4(
    guac_path: &std::path::Path,
) -> Result<std::path::PathBuf, crate::error::AppError> {
    let meta = tokio::fs::metadata(guac_path)
        .await
        .map_err(|_| crate::error::AppError::NotFound("Recording file not found on disk".into()))?;
    let cache_dir = std::env::temp_dir().join(mp4_cache_name(guac_path, &meta));
    let output = cache_dir.join("recording.mp4");
    if output.exists() {
        return Ok(output);
    }

    let job = conversion_lock(&cache_dir);
    let _single_flight = job.lock().await;
    // Whoever held the lock before us may have produced it.
    if output.exists() {
        return Ok(output);
    }
    let _slot = CONVERSION_SLOTS
        .acquire()
        .await
        .map_err(|_| crate::error::AppError::Internal("recording conversion unavailable".into()))?;

    sweep_stale_mp4_caches().await;
    tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| {
        crate::error::AppError::Internal(format!("Failed to create conversion directory: {e}"))
    })?;
    let scratch = tempfile::Builder::new()
        .prefix("job-")
        .tempdir_in(&cache_dir)
        .map_err(|e| {
            crate::error::AppError::Internal(format!("Failed to create conversion directory: {e}"))
        })?;

    let encoded = encode_mp4(guac_path, scratch.path()).await?;
    tokio::fs::rename(&encoded, &output).await.map_err(|e| {
        crate::error::AppError::Internal(format!("Failed to publish converted recording: {e}"))
    })?;
    Ok(output)
}

/// Conversions allowed to run at once; each is a CPU-heavy child process.
const MAX_CONVERSIONS: usize = 2;
/// Wall-clock limit on one encoder run.
const ENCODE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Converted recordings older than this are removed.
const MP4_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 3600);
/// Bumped whenever encoder settings change, so older outputs are not reused.
const MP4_CACHE_VERSION: &str = "v3";

static CONVERSION_SLOTS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_CONVERSIONS);

type JobLocks = std::sync::Mutex<
    std::collections::HashMap<std::path::PathBuf, std::sync::Weak<tokio::sync::Mutex<()>>>,
>;
static CONVERSION_JOBS: std::sync::LazyLock<JobLocks> = std::sync::LazyLock::new(Default::default);

/// One lock per recording version, shared by every concurrent request for it.
fn conversion_lock(key: &std::path::Path) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let mut jobs = CONVERSION_JOBS.lock().unwrap_or_else(|e| e.into_inner());
    jobs.retain(|_, weak| weak.strong_count() > 0);
    if let Some(lock) = jobs.get(key).and_then(std::sync::Weak::upgrade) {
        return lock;
    }
    let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    jobs.insert(key.to_path_buf(), std::sync::Arc::downgrade(&lock));
    lock
}

/// Cache directory name for one version of a recording: a recording that is
/// still growing gets a new name rather than a stale video.
fn mp4_cache_name(guac_path: &std::path::Path, meta: &std::fs::Metadata) -> String {
    let stem = guac_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    format!(
        "strata-mp4-{MP4_CACHE_VERSION}-{stem}-{}-{modified}",
        meta.len()
    )
}

/// Remove converted recordings past [`MP4_CACHE_TTL`], including caches
/// from older encoder versions. Best effort.
async fn sweep_stale_mp4_caches() {
    let Ok(mut entries) = tokio::fs::read_dir(std::env::temp_dir()).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("strata-mp4-") {
            continue;
        }
        let stale = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > MP4_CACHE_TTL);
        if stale {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

/// Run `cmd` to completion within [`ENCODE_DEADLINE`], killing it on timeout.
async fn run_encoder(mut cmd: tokio::process::Command, what: &str) -> Option<std::process::Output> {
    cmd.kill_on_drop(true);
    match tokio::time::timeout(ENCODE_DEADLINE, cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => Some(out),
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stderr: String = stderr.chars().take(2000).collect();
            tracing::warn!("{what} returned non-zero: {stderr}");
            None
        }
        Ok(Err(e)) => {
            tracing::warn!("{what} could not be run: {e}");
            None
        }
        Err(_) => {
            tracing::warn!("{what} exceeded {ENCODE_DEADLINE:?} and was stopped");
            None
        }
    }
}

/// Encode `guac_path` inside `scratch` and return the finished file.
async fn encode_mp4(
    guac_path: &std::path::Path,
    scratch: &std::path::Path,
) -> Result<std::path::PathBuf, crate::error::AppError> {
    // guacenc writes next to its input, so it gets a private copy.
    let temp_guac = scratch.join("recording.guac");
    tokio::fs::copy(guac_path, &temp_guac).await.map_err(|e| {
        crate::error::AppError::Internal(format!(
            "Failed to stage recording file for conversion: {e}"
        ))
    })?;

    // Probe the recording for its actual display dimensions. Fall back to 1920×1080
    // (a common enterprise RDP size) if we can't find a size instruction — better to
    // slightly upscale/letterbox than to downscale everything to VGA.
    let (width, height) = read_head(&temp_guac, DIMENSION_SCAN_BYTES)
        .await
        .and_then(|head| read_recording_dimensions(&head))
        .unwrap_or((1920, 1080));
    // libavcodec's H.264 encoder rejects odd dimensions with yuv420p; round up to even.
    let width = width + (width & 1);
    let height = height + (height & 1);

    let guacenc_bin = first_existing(&["/usr/local/bin/guacenc", "/usr/bin/guacenc"], "guacenc");
    let mut guacenc = tokio::process::Command::new(guacenc_bin);
    guacenc
        .arg("-s")
        .arg(format!("{width}x{height}"))
        // 12 Mbps handles crisp text at up to 1440p; overkill for VGA but the file size penalty is small.
        .arg("-r")
        .arg("12000000")
        .arg("-f")
        .arg(&temp_guac);
    if run_encoder(guacenc, "guacenc").await.is_some() {
        for name in ["recording.guac.m4v", "recording.guac.mp4"] {
            let candidate = scratch.join(name);
            if non_empty(&candidate).await {
                return Ok(candidate);
            }
        }
    }

    // Tier 2 Fallback: ffmpeg + frame extraction
    let ffmpeg_out = scratch.join("recording_fallback.mp4");
    if let Ok(guac_bytes) = tokio::fs::read(&temp_guac).await {
        if extract_and_save_guac_frames(&guac_bytes, scratch).await > 0 {
            let ffmpeg_bin =
                first_existing(&["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"], "ffmpeg");
            let mut ffmpeg = tokio::process::Command::new(ffmpeg_bin);
            ffmpeg
                .arg("-y")
                .arg("-framerate")
                .arg("5")
                .arg("-i")
                .arg(scratch.join("frame_%05d.png"))
                .arg("-c:v")
                .arg("libx264")
                .arg("-pix_fmt")
                .arg("yuv420p")
                .arg(&ffmpeg_out);
            if run_encoder(ffmpeg, "ffmpeg").await.is_some() && non_empty(&ffmpeg_out).await {
                return Ok(ffmpeg_out);
            }
        }
    }

    Err(crate::error::AppError::Internal(
        "Neither guacenc nor ffmpeg could convert the recording to MP4".into(),
    ))
}

/// Bytes scanned for the display size; [`read_recording_dimensions`] looks no further.
const DIMENSION_SCAN_BYTES: u64 = 65_536;

async fn read_head(path: &std::path::Path, limit: u64) -> Option<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut head = Vec::new();
    file.take(limit).read_to_end(&mut head).await.ok()?;
    Some(head)
}

async fn non_empty(path: &std::path::Path) -> bool {
    tokio::fs::metadata(path).await.is_ok_and(|m| m.len() > 0)
}

fn first_existing(paths: &[&'static str], fallback: &'static str) -> &'static str {
    paths
        .iter()
        .copied()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or(fallback)
}

/// Prepare a recording file for download (either in `.mp4` format playable on Windows or raw `.guac` format).
pub async fn prepare_recording_for_download(
    recording: &crate::db::Recording,
    format: &str, // "mp4" or "guac"
    pool: &sqlx::Pool<sqlx::Postgres>,
    vault: Option<&crate::config::VaultConfig>,
) -> Result<(std::path::PathBuf, String, String), crate::error::AppError> {
    let safe_conn_name: String = recording
        .connection_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();

    let ext = if format == "mp4" { "mp4" } else { "guac" };
    let download_filename = format!("{}_{}.{}", safe_conn_name, recording.id, ext);
    let content_type = if format == "mp4" {
        "video/mp4".to_string()
    } else {
        "application/octet-stream".to_string()
    };

    let dir = "/var/lib/guacamole/recordings";
    let guac_path = if std::path::Path::new(&recording.storage_path).exists() {
        std::path::PathBuf::from(&recording.storage_path)
    } else {
        std::path::PathBuf::from(dir).join(&recording.storage_path)
    };

    if recording.storage_type == "local" {
        if !guac_path.exists() {
            return Err(crate::error::AppError::NotFound(
                "Recording file not found on disk".into(),
            ));
        }

        if format == "mp4" {
            match convert_guac_to_mp4(&guac_path).await {
                Ok(video_path) => Ok((video_path, download_filename, content_type)),
                Err(e) => {
                    tracing::warn!(
                        "MP4 conversion failed ({e}); serving raw .guac recording file for download"
                    );
                    let guac_filename = format!("{}_{}.guac", safe_conn_name, recording.id);
                    Ok((
                        guac_path,
                        guac_filename,
                        "application/octet-stream".to_string(),
                    ))
                }
            }
        } else {
            Ok((guac_path, download_filename, content_type))
        }
    } else {
        // Azure storage
        let azure_cfg = get_azure_config(pool, vault)
            .await?
            .ok_or_else(|| crate::error::AppError::Config("Azure storage not configured".into()))?;

        let temp_dir = std::env::temp_dir().join("strata-recordings-dl");
        tokio::fs::create_dir_all(&temp_dir).await.ok();
        let local_temp_guac = temp_dir.join(format!("{}.guac", recording.id));

        if !local_temp_guac.exists() {
            let data = download_from_azure(&azure_cfg, &recording.storage_path).await?;
            tokio::fs::write(&local_temp_guac, data)
                .await
                .map_err(|e| {
                    crate::error::AppError::Internal(format!(
                        "Failed to write temp guac recording: {}",
                        e
                    ))
                })?;
        }

        if format == "mp4" {
            match convert_guac_to_mp4(&local_temp_guac).await {
                Ok(video_path) => Ok((video_path, download_filename, content_type)),
                Err(e) => {
                    tracing::warn!(
                        "MP4 conversion failed ({e}); serving raw .guac recording file for download"
                    );
                    let guac_filename = format!("{}_{}.guac", safe_conn_name, recording.id);
                    Ok((
                        local_temp_guac,
                        guac_filename,
                        "application/octet-stream".to_string(),
                    ))
                }
            }
        } else {
            Ok((local_temp_guac, download_filename, content_type))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode a solid RGB rectangle the way the RDP engine does.
    fn webp_frame(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut out)
            .encode(
                &vec![0x2d; (w * h * 3) as usize],
                w,
                h,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        out
    }

    fn png_frame(w: u32, h: u32) -> Vec<u8> {
        use image::ImageEncoder as _;
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                &vec![0x2d; (w * h * 3) as usize],
                w,
                h,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        out
    }

    /// A flat 64x64 rectangle encodes to well under a hundred bytes in
    /// lossless WebP. The old size floor discarded exactly these.
    #[test]
    fn small_webp_frames_are_not_discarded() {
        let frame = webp_frame(64, 64);
        assert!(
            frame.len() < 100,
            "expected a sub-100-byte frame to exercise the floor, got {}",
            frame.len()
        );
        assert!(is_valid_image(&frame));
        assert!(frame_to_png(&frame).is_some());
    }

    /// ffmpeg's image2 demuxer decodes a whole sequence with one codec,
    /// so WebP damage rectangles have to reach it as PNG.
    #[test]
    fn frames_are_normalised_to_a_single_codec() {
        for frame in [webp_frame(96, 96), png_frame(96, 96)] {
            let png = frame_to_png(&frame).expect("frame should normalise");
            assert!(
                png.starts_with(b"\x89PNG\r\n\x1a\n"),
                "every extracted frame must be PNG on disk"
            );
            assert!(png.ends_with(b"IEND\xaeB`\x82"));
        }
    }

    #[test]
    fn malformed_frames_are_rejected_rather_than_written() {
        // Right signature, truncated payload.
        let mut truncated = webp_frame(96, 96);
        truncated.truncate(20);
        assert!(frame_to_png(&truncated).is_none());

        assert!(!is_valid_image(b"not an image at all"));
        assert!(!is_valid_image(&[]));
    }

    #[test]
    fn storage_type_equality() {
        assert_eq!(StorageType::Local, StorageType::Local);
        assert_eq!(StorageType::AzureBlob, StorageType::AzureBlob);
        assert_ne!(StorageType::Local, StorageType::AzureBlob);
    }

    #[test]
    fn storage_type_debug() {
        assert_eq!(format!("{:?}", StorageType::Local), "Local");
        assert_eq!(format!("{:?}", StorageType::AzureBlob), "AzureBlob");
    }

    #[test]
    fn recording_config_fields() {
        let cfg = RecordingConfig {
            enabled: true,
            required: false,
            retention_days: 90,
            storage_type: StorageType::AzureBlob,
        };
        assert!(cfg.enabled);
        assert_eq!(cfg.retention_days, 90);
        assert_eq!(cfg.storage_type, StorageType::AzureBlob);
    }

    #[test]
    fn blob_url_format() {
        let cfg = AzureBlobConfig {
            account_name: "mystorageaccount".into(),
            container_name: "recordings".into(),
            access_key: String::new(),
        };
        assert_eq!(
            cfg.blob_url("session-123.guac").unwrap().as_str(),
            "https://mystorageaccount.blob.core.windows.net/recordings/session-123.guac"
        );
    }

    #[test]
    fn blob_url_custom_container() {
        let cfg = AzureBlobConfig {
            account_name: "acct".into(),
            container_name: "custom-container".into(),
            access_key: String::new(),
        };
        assert_eq!(
            cfg.blob_url("file.bin").unwrap().as_str(),
            "https://acct.blob.core.windows.net/custom-container/file.bin"
        );
    }

    #[test]
    fn sign_produces_shared_key() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        // Use a known base64-encoded key (32 bytes)
        let key_bytes = [0u8; 32];
        let cfg = AzureBlobConfig {
            account_name: "testacct".into(),
            container_name: "recordings".into(),
            access_key: B64.encode(key_bytes),
        };
        let sig = cfg
            .sign(
                "PUT",
                1024,
                "application/octet-stream",
                "x-ms-date:Thu, 01 Jan 2026 00:00:00 GMT\nx-ms-version:2023-11-03",
                "/testacct/recordings/test.bin",
            )
            .unwrap();
        assert!(sig.starts_with("SharedKey testacct:"));
    }

    #[test]
    fn sign_invalid_base64_key_fails() {
        let cfg = AzureBlobConfig {
            account_name: "acct".into(),
            container_name: "rec".into(),
            access_key: "not-valid-base64!!!".into(),
        };
        let result = cfg.sign("GET", 0, "", "", "/acct/rec/file.bin");
        assert!(result.is_err());
    }

    #[test]
    fn read_recording_dimensions_parses_1080p() {
        // Real-world opening of a guacd RDP recording: version handshake first,
        // then size for layer 0.
        let data = b"5.args,1.0;4.size,1.0,4.1920,4.1080;5.ready,4.$abc;";
        assert_eq!(read_recording_dimensions(data), Some((1920, 1080)));
    }

    #[test]
    fn read_recording_dimensions_parses_4k() {
        let data = b"4.size,1.0,4.3840,4.2160;";
        assert_eq!(read_recording_dimensions(data), Some((3840, 2160)));
    }

    #[test]
    fn read_recording_dimensions_ignores_non_layer_zero() {
        // Layer 1 is not the primary display; skip until we see layer 0.
        let data = b"4.size,1.1,3.800,3.600;4.size,1.0,4.1024,3.768;";
        assert_eq!(read_recording_dimensions(data), Some((1024, 768)));
    }

    #[test]
    fn read_recording_dimensions_rejects_absurd() {
        let data = b"4.size,1.0,2.10,2.10;";
        assert_eq!(read_recording_dimensions(data), None);
    }

    #[test]
    fn read_recording_dimensions_none_when_no_size() {
        let data = b"5.hello,5.world;";
        assert_eq!(read_recording_dimensions(data), None);
    }

    #[test]
    fn blob_url_encodes_special_chars() {
        let cfg = AzureBlobConfig {
            account_name: "acct".into(),
            container_name: "rec".into(),
            access_key: String::new(),
        };
        let url = cfg.blob_url("file with spaces.guac").unwrap();
        assert!(url.as_str().contains("file%20with%20spaces.guac"));
    }

    #[test]
    fn sign_empty_content_length_for_get() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        let key_bytes = [1u8; 32];
        let cfg = AzureBlobConfig {
            account_name: "acct".into(),
            container_name: "rec".into(),
            access_key: B64.encode(key_bytes),
        };
        let sig = cfg
            .sign("GET", 0, "", "x-ms-date:now", "/acct/rec/f.bin")
            .unwrap();
        assert!(sig.starts_with("SharedKey acct:"));
        assert!(sig.len() > "SharedKey acct:".len());
    }

    #[test]
    fn sign_different_verbs_produce_different_signatures() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        let key_bytes = [42u8; 32];
        let cfg = AzureBlobConfig {
            account_name: "acct".into(),
            container_name: "rec".into(),
            access_key: B64.encode(key_bytes),
        };
        let sig_put = cfg
            .sign("PUT", 100, "text/plain", "x-ms-date:now", "/acct/rec/f")
            .unwrap();
        let sig_get = cfg
            .sign("GET", 0, "", "x-ms-date:now", "/acct/rec/f")
            .unwrap();
        assert_ne!(sig_put, sig_get);
    }

    #[test]
    fn storage_type_clone() {
        let a = StorageType::AzureBlob;
        let b = a.clone();
        assert_eq!(a, b);
    }

    #[test]
    fn azure_blob_config_clone() {
        let cfg = AzureBlobConfig {
            account_name: "a".into(),
            container_name: "b".into(),
            access_key: "c".into(),
        };
        let cloned = cfg.clone();
        assert_eq!(cloned.account_name, "a");
        assert_eq!(cloned.container_name, "b");
    }

    #[test]
    fn recording_config_disabled() {
        let cfg = RecordingConfig {
            enabled: false,
            required: false,
            retention_days: 0,
            storage_type: StorageType::Local,
        };
        assert!(!cfg.enabled);
        assert_eq!(cfg.storage_type, StorageType::Local);
    }

    // ── parse_storage_type ─────────────────────────────────────────

    #[test]
    fn parse_storage_type_local() {
        assert_eq!(parse_storage_type("local"), StorageType::Local);
    }

    #[test]
    fn parse_storage_type_azure_blob() {
        assert_eq!(parse_storage_type("azure_blob"), StorageType::AzureBlob);
    }

    #[test]
    fn parse_storage_type_unknown_defaults_local() {
        assert_eq!(parse_storage_type("s3"), StorageType::Local);
        assert_eq!(parse_storage_type(""), StorageType::Local);
        assert_eq!(parse_storage_type("AZURE_BLOB"), StorageType::Local);
    }

    // ── parse_retention_days ───────────────────────────────────────

    #[test]
    fn parse_retention_days_valid() {
        assert_eq!(parse_retention_days("90"), 90);
    }

    #[test]
    fn parse_retention_days_default() {
        assert_eq!(parse_retention_days("invalid"), 30);
        assert_eq!(parse_retention_days(""), 30);
    }

    #[test]
    fn parse_retention_days_zero() {
        assert_eq!(parse_retention_days("0"), 0);
    }

    #[test]
    fn parse_retention_days_large() {
        assert_eq!(parse_retention_days("3650"), 3650);
    }

    // ── parse_recording_enabled ────────────────────────────────────

    #[test]
    fn parse_recording_enabled_true() {
        assert!(parse_recording_enabled("true"));
    }

    #[test]
    fn parse_recording_enabled_false() {
        assert!(!parse_recording_enabled("false"));
    }

    #[test]
    fn parse_recording_enabled_empty() {
        assert!(!parse_recording_enabled(""));
    }

    #[test]
    fn parse_recording_enabled_other() {
        assert!(!parse_recording_enabled("yes"));
        assert!(!parse_recording_enabled("1"));
        assert!(!parse_recording_enabled("TRUE"));
    }

    #[tokio::test]
    async fn test_convert_guac_to_mp4_missing_file() {
        let missing = std::path::Path::new("/non/existent/recording.guac");
        let res = convert_guac_to_mp4(missing).await;
        assert!(res.is_err());
    }

    #[test]
    fn a_recording_that_grows_gets_a_new_cache_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc.guac");
        std::fs::write(&path, b"4.sync,1.0;").unwrap();
        let before = mp4_cache_name(&path, &std::fs::metadata(&path).unwrap());
        std::fs::write(&path, b"4.sync,1.0;4.sync,1.1;").unwrap();
        let after = mp4_cache_name(&path, &std::fs::metadata(&path).unwrap());
        assert_ne!(before, after);
        assert!(before.starts_with(&format!("strata-mp4-{MP4_CACHE_VERSION}-abc-")));
    }

    #[test]
    fn concurrent_requests_for_one_recording_share_a_lock() {
        let key = std::path::Path::new("/tmp/strata-mp4-test-shared");
        let a = conversion_lock(key);
        let b = conversion_lock(key);
        assert!(std::sync::Arc::ptr_eq(&a, &b));
        let other = conversion_lock(std::path::Path::new("/tmp/strata-mp4-test-other"));
        assert!(!std::sync::Arc::ptr_eq(&a, &other));
    }

    #[tokio::test]
    async fn only_the_head_is_read_for_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.guac");
        std::fs::write(&path, vec![b'x'; 200_000]).unwrap();
        let head = read_head(&path, DIMENSION_SCAN_BYTES).await.unwrap();
        assert_eq!(head.len() as u64, DIMENSION_SCAN_BYTES);
    }
}
