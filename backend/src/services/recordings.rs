use std::collections::HashSet;

// ── Recording config ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum StorageType {
    Local,
    AzureBlob,
}

pub struct RecordingConfig {
    pub enabled: bool,
    #[allow(dead_code)]
    pub retention_days: u32,
    pub storage_type: StorageType,
}

pub async fn get_config(
    pool: &sqlx::Pool<sqlx::Postgres>,
) -> anyhow::Result<RecordingConfig> {
    let enabled = crate::services::settings::get(pool, "recordings_enabled")
        .await?
        .unwrap_or_else(|| "false".into())
        == "true";

    let retention_days: u32 = crate::services::settings::get(pool, "recordings_retention_days")
        .await?
        .unwrap_or_else(|| "30".into())
        .parse()
        .unwrap_or(30);

    let storage_type = match crate::services::settings::get(pool, "recordings_storage_type")
        .await?
        .unwrap_or_else(|| "local".into())
        .as_str()
    {
        "azure_blob" => StorageType::AzureBlob,
        _ => StorageType::Local,
    };

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
) -> anyhow::Result<Option<AzureBlobConfig>> {
    let account_name = crate::services::settings::get(pool, "recordings_azure_account_name").await?;
    let access_key = crate::services::settings::get(pool, "recordings_azure_access_key").await?;
    let container_name = crate::services::settings::get(pool, "recordings_azure_container_name").await?;

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
    fn blob_url(&self, blob: &str) -> String {
        format!(
            "https://{}.blob.core.windows.net/{}/{}",
            self.account_name, self.container_name, blob
        )
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
        let string_to_sign = format!(
            "{verb}\n\n\n{cl}\n\n{content_type}\n\n\n\n\n\n\n{x_headers}\n{resource}"
        );

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

pub async fn upload_to_azure(
    cfg: &AzureBlobConfig,
    blob: &str,
    data: Vec<u8>,
) -> anyhow::Result<()> {
    let url = cfg.blob_url(blob);
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let ct = "application/octet-stream";
    let x_headers = format!(
        "x-ms-blob-type:BlockBlob\nx-ms-date:{date}\nx-ms-version:2023-11-03"
    );
    let resource = format!("/{}/{}/{blob}", cfg.account_name, cfg.container_name);
    let auth = cfg.sign("PUT", data.len(), ct, &x_headers, &resource)?;

    let resp = reqwest::Client::new()
        .put(&url)
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

pub async fn download_from_azure(
    cfg: &AzureBlobConfig,
    blob: &str,
) -> anyhow::Result<Vec<u8>> {
    let url = cfg.blob_url(blob);
    let date = chrono::Utc::now()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let x_headers = format!("x-ms-date:{date}\nx-ms-version:2023-11-03");
    let resource = format!("/{}/{}/{blob}", cfg.account_name, cfg.container_name);
    let auth = cfg.sign("GET", 0, "", &x_headers, &resource)?;

    let resp = reqwest::Client::new()
        .get(&url)
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

// ── Background sync task ───────────────────────────────────────────────

pub fn spawn_sync_task(pool: sqlx::Pool<sqlx::Postgres>) {
    tokio::spawn(async move {
        let mut synced: HashSet<String> = HashSet::new();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = sync_pass(&pool, &mut synced).await {
                tracing::warn!("Recording sync error: {e}");
            }
        }
    });
}

async fn sync_pass(
    pool: &sqlx::Pool<sqlx::Postgres>,
    synced: &mut HashSet<String>,
) -> anyhow::Result<()> {
    let config = get_config(pool).await?;
    if !config.enabled || config.storage_type != StorageType::AzureBlob {
        return Ok(());
    }

    let azure = match get_azure_config(pool).await? {
        Some(c) => c,
        None => return Ok(()),
    };

    let dir = "/var/lib/guacamole/recordings";
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
                if modified.elapsed().unwrap_or_default()
                    < std::time::Duration::from_secs(30)
                {
                    continue;
                }
            }
        }

        let path = format!("{dir}/{name}");
        match tokio::fs::read(&path).await {
            Ok(data) => match upload_to_azure(&azure, &name, data).await {
                Ok(_) => {
                    synced.insert(name.clone());
                    tracing::info!("Synced recording to Azure Blob: {name}");
                }
                Err(e) => tracing::warn!("Azure Blob upload failed for {name}: {e}"),
            },
            Err(e) => tracing::warn!("Failed to read recording {name}: {e}"),
        }
    }

    Ok(())
}
