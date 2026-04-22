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
    pub retention_days: u32,
    pub storage_type: StorageType,
}

pub async fn get_config(pool: &sqlx::Pool<sqlx::Postgres>) -> anyhow::Result<RecordingConfig> {
    let enabled = parse_recording_enabled(
        &crate::services::settings::get(pool, "recordings_enabled")
            .await?
            .unwrap_or_else(|| "false".into()),
    );

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

    // Decrypt access key if vault-encrypted
    let access_key = match access_key_raw {
        Some(ref raw) if raw.starts_with("vault:") => {
            if let Some(vc) = vault {
                match crate::services::vault::unseal_setting(vc, raw).await {
                    Ok(decrypted) => Some(decrypted),
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
        _ => Ok(None),
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
        use hmac::{Hmac, Mac};
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
    if !config.enabled {
        return Ok(());
    }

    let dir = "/var/lib/guacamole/recordings";

    // ── Azure Blob sync (if configured) ──
    if config.storage_type == StorageType::AzureBlob {
        let azure = match get_azure_config(pool, vault).await? {
            Some(c) => c,
            None => return Ok(()),
        };

        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };

        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || synced.contains(&name) {
                continue;
            }

            // Skip files still being written (modified < 30 s ago)
            if let Ok(meta) = entry.metadata().await {
                if let Ok(modified) = meta.modified() {
                    if modified.elapsed().unwrap_or_default() < std::time::Duration::from_secs(30) {
                        continue;
                    }
                }
            }

            let path = format!("{dir}/{name}");
            match upload_file_to_azure(&azure, &name, &path).await {
                Ok(_) => {
                    synced.insert(name.clone());

                    // Update database metadata to reflect Azure storage
                    let _ = sqlx::query(
                        "UPDATE recordings SET storage_type = 'azure' WHERE storage_path = $1",
                    )
                    .bind(&name)
                    .execute(pool)
                    .await;

                    // Delete local file after successful upload to prevent disk growth
                    if let Err(e) = tokio::fs::remove_file(&path).await {
                        tracing::warn!(
                            "Failed to delete local recording after upload: {name}: {e}"
                        );
                    }
                    tracing::info!("Synced recording to Azure Blob: {name}");
                }
                Err(e) => tracing::warn!("Azure Blob upload failed for {name}: {e}"),
            }
        }
    }

    // ── Retention-based cleanup for local recordings ──
    if config.retention_days > 0 {
        let max_age = std::time::Duration::from_secs(config.retention_days as u64 * 86_400);
        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };

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
                            tracing::warn!("Failed to delete expired recording: {name}: {e}");
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
