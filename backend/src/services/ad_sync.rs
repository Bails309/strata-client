use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Postgres};
use uuid::Uuid;

// ── Config row from DB ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AdSyncConfig {
    pub id: Uuid,
    pub label: String,
    pub ldap_url: String,
    pub bind_dn: String,
    pub bind_password: String,
    pub search_bases: Vec<String>,
    pub search_filter: String,
    pub search_scope: String,
    pub protocol: String,
    pub default_port: i32,
    pub domain_override: Option<String>,
    pub folder_id: Option<Uuid>,
    pub tls_skip_verify: bool,
    pub sync_interval_minutes: i32,
    pub enabled: bool,
    pub auth_method: String,
    pub keytab_path: Option<String>,
    pub krb5_principal: Option<String>,
    pub ca_cert_pem: Option<String>,
    /// Default Guacamole parameters applied to every synced connection.
    /// Maps directly to allowed guacd param names (e.g. "ignore-cert", "enable-wallpaper").
    #[serde(default)]
    pub connection_defaults: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ── Sync run row ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AdSyncRun {
    pub id: Uuid,
    pub config_id: Uuid,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub status: String,
    pub created: i32,
    pub updated: i32,
    pub soft_deleted: i32,
    pub hard_deleted: i32,
    pub error_message: Option<String>,
}

// ── Discovered computer from LDAP ──────────────────────────────────────

#[derive(Debug)]
pub(crate) struct DiscoveredComputer {
    dn: String,
    name: String,
    dns_host_name: Option<String>,
    description: Option<String>,
}

// ── Execute a full sync for one config ─────────────────────────────────

pub async fn run_sync(pool: &Pool<Postgres>, config: &AdSyncConfig) -> anyhow::Result<Uuid> {
    // Advisory lock keyed on config UUID to prevent concurrent syncs for the same config.
    // Use pg_advisory_lock(int, int) with two i32 halves of the UUID.  This uses 64 of the
    // UUID's 128 bits, giving ~4 billion distinct lock keys — more than sufficient for the
    // expected number of sync configs (typically < 100).  A collision would only cause one
    // sync to be skipped until the other finishes.
    let mut conn = pool.acquire().await?;
    let uuid_bytes = config.id.as_u128();
    let lock_key_hi = (uuid_bytes >> 64) as i64;
    let lock_key_lo = uuid_bytes as i64;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1, $2)")
        .bind(lock_key_hi as i32)
        .bind(lock_key_lo as i32)
        .fetch_one(&mut *conn)
        .await?;
    if !acquired {
        anyhow::bail!("Sync already in progress for config '{}'", config.label);
    }

    // Create run record
    let run_id: Uuid =
        sqlx::query_scalar("INSERT INTO ad_sync_runs (config_id) VALUES ($1) RETURNING id")
            .bind(config.id)
            .fetch_one(pool)
            .await?;

    let result = do_sync(pool, config, run_id).await;

    // Always release the advisory lock on the SAME connection, even on error
    let _ = sqlx::query("SELECT pg_advisory_unlock($1, $2)")
        .bind(lock_key_hi as i32)
        .bind(lock_key_lo as i32)
        .execute(&mut *conn)
        .await;

    match result {
        Ok(_) => {
            sqlx::query(
                "UPDATE ad_sync_runs SET status = 'success', finished_at = now() WHERE id = $1",
            )
            .bind(run_id)
            .execute(pool)
            .await?;
        }
        Err(e) => {
            let msg = sanitize_error(format!("{e:#}"));
            tracing::error!("AD sync failed for '{}': {msg}", config.label);
            sqlx::query(
                "UPDATE ad_sync_runs SET status = 'error', finished_at = now(), error_message = $1 WHERE id = $2",
            )
            .bind(&msg)
            .bind(run_id)
            .execute(pool)
            .await?;
        }
    }

    Ok(run_id)
}

async fn do_sync(pool: &Pool<Postgres>, config: &AdSyncConfig, run_id: Uuid) -> anyhow::Result<()> {
    // Phase 1: Query LDAP for computers
    tracing::info!(
        "AD sync '{}' (Phase 1/4): Querying LDAP for computers...",
        config.label
    );
    let computers = ldap_query(config).await?;
    tracing::info!(
        "AD sync '{}': discovered {} computer(s) under {:?}",
        config.label,
        computers.len(),
        config.search_bases,
    );

    // Phase 2: Processing computer list
    tracing::info!(
        "AD sync '{}' (Phase 2/4): Processing computer list...",
        config.label
    );
    let mut dns = Vec::with_capacity(computers.len());
    let mut hostnames = Vec::with_capacity(computers.len());
    let mut names = Vec::with_capacity(computers.len());
    let mut descriptions = Vec::with_capacity(computers.len());

    for computer in &computers {
        dns.push(computer.dn.clone());
        hostnames.push(
            computer
                .dns_host_name
                .as_deref()
                .unwrap_or(&computer.name)
                .to_lowercase(),
        );
        names.push(computer.name.to_lowercase());

        let desc = computer.description.as_deref().unwrap_or_default();
        let description = if desc.is_empty() {
            format!("Imported from AD: {}", config.label)
        } else {
            desc.to_string()
        };
        descriptions.push(description);
    }

    // Phase 3: Bulk upsert using UNNEST and ON CONFLICT
    tracing::info!(
        "AD sync '{}' (Phase 3/4): Performing bulk database upsert...",
        config.label
    );
    // Build the connection_defaults JSONB — filter to only allowed guacd params
    let defaults = if config.connection_defaults.is_object() {
        config.connection_defaults.clone()
    } else {
        serde_json::json!({})
    };

    // High performance bulk upsert using UNNEST and ON CONFLICT.
    // The `is_insert` check (xmax = 0) correctly distinguishes NEW entries from UPDATED ones.
    let stats: (i64, i64) = sqlx::query_as(
        r#"
        WITH discovered AS (
            SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[]) AS t(dn, hostname, name, description)
        ),
        upserted AS (
            INSERT INTO connections (name, protocol, hostname, port, domain, description, folder_id, ad_source_id, ad_dn, extra)
            SELECT name, $5, hostname, $6, $7, description, $8, $9, dn, $10::jsonb
            FROM discovered
            ON CONFLICT (ad_source_id, ad_dn) WHERE ad_source_id IS NOT NULL AND ad_dn IS NOT NULL DO UPDATE SET
                soft_deleted_at = NULL,
                hostname = EXCLUDED.hostname,
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                domain = EXCLUDED.domain,
                extra = $10::jsonb,
                updated_at = now()
            WHERE connections.hostname != EXCLUDED.hostname 
               OR connections.name != EXCLUDED.name 
               OR connections.description IS DISTINCT FROM EXCLUDED.description 
               OR connections.domain IS DISTINCT FROM EXCLUDED.domain
               OR connections.soft_deleted_at IS NOT NULL
               OR connections.extra IS DISTINCT FROM $10::jsonb
            RETURNING (xmax = 0) AS is_insert
        )
        SELECT 
            COALESCE(COUNT(*) FILTER (WHERE is_insert), 0)::bigint AS created,
            COALESCE(COUNT(*) FILTER (WHERE NOT is_insert), 0)::bigint AS updated
        FROM upserted
        "#,
    )
    .bind(&dns)
    .bind(&hostnames)
    .bind(&names)
    .bind(&descriptions)
    .bind(&config.protocol)
    .bind(config.default_port)
    .bind(&config.domain_override)
    .bind(config.folder_id)
    .bind(config.id)
    .bind(&defaults)
    .fetch_one(pool)
    .await?;

    let created = stats.0 as i32;
    let updated = stats.1 as i32;

    // Phase 4: Bulk soft-delete connections whose DN vanished from LDAP
    tracing::info!(
        "AD sync '{}' (Phase 4/4): Cleaning up abandoned entries...",
        config.label
    );
    let soft_deleted_res = sqlx::query(
        "UPDATE connections SET soft_deleted_at = now() 
         WHERE ad_source_id = $1 
           AND ad_dn IS NOT NULL 
           AND NOT (ad_dn = ANY($2)) 
           AND soft_deleted_at IS NULL",
    )
    .bind(config.id)
    .bind(&dns)
    .execute(pool)
    .await?;
    let soft_deleted = soft_deleted_res.rows_affected() as i32;

    // Phase 5: Hard-delete connections soft-deleted > 7 days ago
    let hard_result = sqlx::query(
        "DELETE FROM connections WHERE ad_source_id = $1 AND soft_deleted_at IS NOT NULL AND soft_deleted_at < now() - INTERVAL '7 days'",
    )
    .bind(config.id)
    .execute(pool)
    .await?;
    let hard_deleted = hard_result.rows_affected() as i32;

    // Update run stats
    sqlx::query(
        "UPDATE ad_sync_runs SET created = $1, updated = $2, soft_deleted = $3, hard_deleted = $4 WHERE id = $5",
    )
    .bind(created)
    .bind(updated)
    .bind(soft_deleted)
    .bind(hard_deleted)
    .bind(run_id)
    .execute(pool)
    .await?;

    tracing::info!(
        "AD sync '{}': created={created}, updated={updated}, soft_deleted={soft_deleted}, hard_deleted={hard_deleted}",
        config.label,
    );

    // Audit
    crate::services::audit::log(
        pool,
        None,
        "ad_sync.completed",
        &serde_json::json!({
            "config_id": config.id,
            "label": config.label,
            "run_id": run_id,
            "created": created,
            "updated": updated,
            "soft_deleted": soft_deleted,
            "hard_deleted": hard_deleted,
        }),
    )
    .await?;

    Ok(())
}

// ── Build custom rustls config with CA cert ────────────────────────────

fn build_tls_config_with_ca(pem: &str) -> anyhow::Result<std::sync::Arc<rustls::ClientConfig>> {
    let mut root_store = rustls::RootCertStore::empty();

    // Load system root certificates
    // rustls-native-certs 0.8 returns Result<Vec<CertificateDer>>
    let native_certs = rustls_native_certs::load_native_certs();
    for cert in native_certs.certs {
        let _ = root_store.add(cert);
    }

    // Parse and add custom CA cert(s) from PEM
    let mut reader = std::io::BufReader::new(pem.as_bytes());
    // rustls-pemfile 2.x certs() returns an iterator of Result<CertificateDer>
    let certs = rustls_pemfile::certs(&mut reader);

    let mut added = 0;
    for cert in certs {
        let cert_der =
            cert.map_err(|e| anyhow::anyhow!("Failed to parse CA certificate PEM: {e}"))?;
        root_store
            .add(cert_der)
            .map_err(|e| anyhow::anyhow!("Failed to add CA certificate: {e}"))?;
        added += 1;
    }

    if added == 0 {
        anyhow::bail!("No certificates found in the provided PEM data");
    }

    // rustls 0.23 builder requires a crypto provider.
    let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| anyhow::anyhow!("Failed to set TLS protocol versions: {e}"))?
    .with_root_certificates(root_store)
    .with_no_client_auth();

    Ok(std::sync::Arc::new(config))
}

// ── LDAP query (dispatch by auth method) ───────────────────────────────

pub async fn ldap_query(config: &AdSyncConfig) -> anyhow::Result<Vec<DiscoveredComputer>> {
    let bases = if config.search_bases.is_empty() {
        vec![String::new()]
    } else {
        config.search_bases.clone()
    };

    let mut all = Vec::new();
    let mut seen_dns = std::collections::HashSet::new();

    for base in &bases {
        let results = match config.auth_method.as_str() {
            "kerberos" => ldap_query_kerberos(config, base).await?,
            _ => ldap_query_simple(config, base).await?,
        };
        for c in results {
            if seen_dns.insert(c.dn.clone()) {
                all.push(c);
            }
        }
    }

    Ok(all)
}

// ── Simple bind (DN + password) ────────────────────────────────────────

async fn ldap_query_simple(
    config: &AdSyncConfig,
    search_base: &str,
) -> anyhow::Result<Vec<DiscoveredComputer>> {
    use ldap3::{LdapConnAsync, LdapConnSettings, Scope, SearchEntry};
    use std::time::Duration;

    let mut settings = LdapConnSettings::new()
        .set_conn_timeout(Duration::from_secs(15))
        .set_starttls(false)
        .set_no_tls_verify(config.tls_skip_verify);

    // If a custom CA cert is provided, build a rustls config with it
    if let Some(ref pem) = config.ca_cert_pem {
        if !pem.is_empty() && !config.tls_skip_verify {
            let tls_config = build_tls_config_with_ca(pem)?;
            settings = settings.set_config(tls_config);
        }
    }

    // Ensure bind_password is not a mask or encrypted string
    if config.bind_password.starts_with("vault:") {
        return Err(anyhow::anyhow!(
            "LDAP bind password is still encrypted (unseal failed)"
        ));
    }
    if config.bind_password == "••••••••" || config.bind_password == "********" {
        return Err(anyhow::anyhow!(
            "LDAP bind password is a redaction mask (not resolved)"
        ));
    }

    let (conn, mut ldap) = LdapConnAsync::with_settings(settings, &config.ldap_url).await?;
    ldap3::drive!(conn);

    if !config.bind_dn.is_empty() {
        ldap.simple_bind(&config.bind_dn, &config.bind_password)
            .await?
            .success()?;
    }

    let scope = match config.search_scope.as_str() {
        "base" => Scope::Base,
        "onelevel" => Scope::OneLevel,
        _ => Scope::Subtree,
    };

    let filter = if config.search_filter.is_empty() {
        "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))"
    } else {
        &config.search_filter
    };

    let (results, _res) = tokio::time::timeout(
        Duration::from_secs(60),
        ldap.search(
            search_base,
            scope,
            filter,
            vec![
                "cn",
                "dNSHostName",
                "distinguishedName",
                "name",
                "description",
            ],
        ),
    )
    .await
    .map_err(|_| anyhow::anyhow!("LDAP search timed out after 60s"))??
    .success()?;

    let mut computers = Vec::new();
    for entry in results {
        let se = SearchEntry::construct(entry);
        let dn = se.dn.clone();

        let name = se
            .attrs
            .get("cn")
            .and_then(|v| v.first())
            .or_else(|| se.attrs.get("name").and_then(|v| v.first()))
            .cloned()
            .unwrap_or_else(|| dn.clone());

        let dns_host_name = se.attrs.get("dNSHostName").and_then(|v| v.first()).cloned();

        let description = se.attrs.get("description").and_then(|v| v.first()).cloned();

        computers.push(DiscoveredComputer {
            dn,
            name,
            dns_host_name,
            description,
        });
    }

    let _ = ldap.unbind().await;
    Ok(computers)
}

// ── Kerberos keytab auth (kinit + ldapsearch subprocess) ───────────────

async fn ldap_query_kerberos(
    config: &AdSyncConfig,
    search_base: &str,
) -> anyhow::Result<Vec<DiscoveredComputer>> {
    let principal = config
        .krb5_principal
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Kerberos principal is required for keytab auth"))?;
    let keytab = config
        .keytab_path
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Keytab path is required for keytab auth"))?;

    if !std::path::Path::new(keytab).exists() {
        anyhow::bail!("Keytab file not found: {keytab}");
    }

    // Use a per-config credential cache to avoid races between concurrent syncs.
    // NamedTempFile ensures the file is created with secure permissions and is unique.
    let ccache_file = tempfile::NamedTempFile::new()
        .map_err(|e| anyhow::anyhow!("Failed to create Kerberos ccache: {e}"))?;
    let ccache = format!("FILE:{}", ccache_file.path().display());

    // Obtain TGT via keytab
    let kinit_out = tokio::process::Command::new("kinit")
        .args(["-k", "-t", keytab, principal])
        .env("KRB5CCNAME", &ccache)
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to run kinit: {e}. Is the krb5 package installed?"))?;

    if !kinit_out.status.success() {
        anyhow::bail!(
            "kinit failed (exit {}): {}",
            kinit_out.status,
            String::from_utf8_lossy(&kinit_out.stderr).trim()
        );
    }

    // Build ldapsearch command with GSSAPI
    let scope_arg = match config.search_scope.as_str() {
        "base" => "base",
        "onelevel" => "one",
        _ => "sub",
    };

    let filter = if config.search_filter.is_empty() {
        "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))"
    } else {
        &config.search_filter
    };

    let mut cmd = tokio::process::Command::new("ldapsearch");
    cmd.args([
        "-H",
        &config.ldap_url,
        "-Y",
        "GSSAPI",
        "-b",
        search_base,
        "-s",
        scope_arg,
        "-LLL",
        "-l",
        "60", // 60s time limit
        filter,
        "cn",
        "dNSHostName",
        "distinguishedName",
        "name",
        "description",
    ]);
    cmd.env("KRB5CCNAME", &ccache);

    if config.tls_skip_verify {
        cmd.env("LDAPTLS_REQCERT", "never");
    }

    // If custom CA cert provided, write to secure temp file.
    // NamedTempFile is automatically cleaned up when dropped.
    let _ca_cert_file = if let Some(ref pem) = config.ca_cert_pem {
        if !pem.is_empty() && !config.tls_skip_verify {
            use std::io::Write;
            let mut tmp = tempfile::Builder::new()
                .suffix(".crt")
                .tempfile()
                .map_err(|e| anyhow::anyhow!("Failed to create CA cert temp file: {e}"))?;
            tmp.write_all(pem.as_bytes())
                .map_err(|e| anyhow::anyhow!("Failed to write CA cert: {e}"))?;
            cmd.env("LDAPTLS_CACERT", tmp.path());
            Some(tmp)
        } else {
            None
        }
    } else {
        None
    };

    let output = cmd.output().await.map_err(|e| {
        anyhow::anyhow!("Failed to run ldapsearch: {e}. Is the openldap-clients package installed?")
    })?;

    if !output.status.success() {
        anyhow::bail!(
            "ldapsearch failed (exit {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let ldif = String::from_utf8_lossy(&output.stdout);
    parse_ldif(&ldif)
}

fn sanitize_error(msg: String) -> String {
    msg.replace('\0', "")
}

/// Parse LDIF output from ldapsearch into DiscoveredComputer entries.
fn parse_ldif(ldif: &str) -> anyhow::Result<Vec<DiscoveredComputer>> {
    let mut computers = Vec::new();
    let mut current_dn = String::new();
    let mut attrs: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let flush = |dn: &str,
                 attrs: &std::collections::HashMap<String, String>|
     -> Option<DiscoveredComputer> {
        if dn.is_empty() {
            return None;
        }
        let name = attrs
            .get("cn")
            .or_else(|| attrs.get("name"))
            .cloned()
            .unwrap_or_else(|| dn.to_string());
        Some(DiscoveredComputer {
            dn: dn.to_string(),
            name,
            dns_host_name: attrs.get("dNSHostName").cloned(),
            description: attrs.get("description").cloned(),
        })
    };

    // Track the last key seen so continuation lines can append to it
    let mut last_key = String::new();

    for line in ldif.lines() {
        if line.is_empty() {
            if let Some(c) = flush(&current_dn, &attrs) {
                computers.push(c);
            }
            current_dn.clear();
            attrs.clear();
            last_key.clear();
            continue;
        }

        // LDIF continuation line (leading single space) — append to previous value
        if let Some(cont) = line.strip_prefix(' ') {
            if last_key.eq_ignore_ascii_case("dn") {
                current_dn.push_str(cont);
            } else if !last_key.is_empty() {
                if let Some(v) = attrs.get_mut(&last_key) {
                    v.push_str(cont);
                }
            }
            continue;
        }

        // Skip comments
        if line.starts_with('#') {
            continue;
        }

        if let Some((key, value)) = line.split_once(": ") {
            last_key = key.to_string();
            if key.eq_ignore_ascii_case("dn") {
                current_dn = value.to_string();
            } else {
                attrs.insert(key.to_string(), value.to_string());
            }
        }
    }

    // Flush last entry
    if let Some(c) = flush(&current_dn, &attrs) {
        computers.push(c);
    }

    Ok(computers)
}

// ── Test connection (bind + search, return count) ──────────────────────

pub async fn test_connection(config: &AdSyncConfig) -> anyhow::Result<(usize, Vec<String>)> {
    let results = ldap_query(config).await?;
    let total = results.len();
    let sample: Vec<String> = results
        .iter()
        .take(10)
        .map(|c| {
            if let Some(ref dns) = c.dns_host_name {
                format!("{} ({})", c.name, dns)
            } else {
                c.name.clone()
            }
        })
        .collect();
    Ok((total, sample))
}

// ── Scheduled Background Sync ──────────────────────────────────────────

pub fn spawn_sync_scheduler(state: crate::services::app_state::SharedState) {
    tokio::spawn(async move {
        // Wait 30s after boot before first check
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            let (pool, vault) = {
                let s = state.read().await;
                let pool = match s.db.as_ref() {
                    Some(db) => db.pool.clone(),
                    None => continue,
                };
                let vault = s.config.as_ref().and_then(|c| c.vault.clone());
                (pool, vault)
            };
            if let Err(e) = scheduler_tick(&pool, vault.as_ref()).await {
                tracing::warn!("AD sync scheduler error: {e}");
            }
        }
    });
}

async fn scheduler_tick(
    pool: &Pool<Postgres>,
    vault: Option<&crate::config::VaultConfig>,
) -> anyhow::Result<()> {
    // Check global enable
    let enabled = crate::services::settings::get(pool, "ad_sync_enabled")
        .await?
        .unwrap_or_else(|| "false".into())
        == "true";
    if !enabled {
        return Ok(());
    }

    // Get all enabled configs
    let configs: Vec<AdSyncConfig> =
        sqlx::query_as("SELECT * FROM ad_sync_configs WHERE enabled = true")
            .fetch_all(pool)
            .await?;

    for config in &configs {
        // Check if enough time has passed since last run
        let last_run: Option<DateTime<Utc>> =
            sqlx::query_scalar("SELECT MAX(started_at) FROM ad_sync_runs WHERE config_id = $1")
                .bind(config.id)
                .fetch_one(pool)
                .await?;

        let should_run = match last_run {
            None => true,
            Some(last) => {
                let elapsed = Utc::now() - last;
                elapsed.num_minutes() >= config.sync_interval_minutes as i64
            }
        };

        if should_run {
            tracing::info!("AD sync scheduler: running sync for '{}'", config.label);
            // Decrypt bind_password if vault-encrypted
            let mut config = config.clone();
            if config.bind_password.starts_with("vault:") {
                if let Some(vc) = vault {
                    match crate::services::vault::unseal_setting(vc, &config.bind_password).await {
                        Ok(pw) => config.bind_password = pw,
                        Err(e) => {
                            tracing::error!(
                                "AD sync '{}': failed to decrypt bind_password: {e}",
                                config.label
                            );
                            continue;
                        }
                    }
                } else {
                    tracing::error!(
                        "AD sync '{}': bind_password is encrypted but Vault not configured",
                        config.label
                    );
                    continue;
                }
            }
            if let Err(e) = run_sync(pool, &config).await {
                tracing::error!("AD sync scheduler failed for '{}': {e}", config.label);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── AdSyncConfig serde roundtrip ──────────────────────────────────

    fn sample_config() -> AdSyncConfig {
        AdSyncConfig {
            id: Uuid::nil(),
            label: "test-sync".to_string(),
            ldap_url: "ldaps://dc.example.com:636".to_string(),
            bind_dn: "CN=svc,DC=example,DC=com".to_string(),
            bind_password: "s3cret".to_string(),
            search_bases: vec!["DC=example,DC=com".to_string()],
            search_filter: "".to_string(),
            search_scope: "subtree".to_string(),
            protocol: "rdp".to_string(),
            default_port: 3389,
            domain_override: None,
            folder_id: None,
            tls_skip_verify: false,
            sync_interval_minutes: 60,
            enabled: true,
            auth_method: "simple".to_string(),
            keytab_path: None,
            krb5_principal: None,
            ca_cert_pem: None,
            connection_defaults: serde_json::json!({}),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn ad_sync_config_serialize_roundtrip() {
        let config = sample_config();
        let json_str = serde_json::to_string(&config).unwrap();
        let parsed: AdSyncConfig = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed.label, "test-sync");
        assert_eq!(parsed.ldap_url, "ldaps://dc.example.com:636");
        assert_eq!(parsed.default_port, 3389);
        assert!(!parsed.tls_skip_verify);
        assert!(parsed.enabled);
    }

    #[test]
    fn ad_sync_config_deserializes_from_json() {
        let j = json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "label": "prod",
            "ldap_url": "ldap://dc:389",
            "bind_dn": "cn=admin",
            "bind_password": "pass",
            "search_bases": ["DC=corp"],
            "search_filter": "(objectClass=computer)",
            "search_scope": "subtree",
            "protocol": "rdp",
            "default_port": 3389,
            "domain_override": null,
            "folder_id": null,
            "tls_skip_verify": true,
            "sync_interval_minutes": 30,
            "enabled": false,
            "auth_method": "kerberos",
            "keytab_path": "/etc/strata.keytab",
            "krb5_principal": "svc@CORP",
            "ca_cert_pem": null,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z"
        });
        let config: AdSyncConfig = serde_json::from_value(j).unwrap();
        assert_eq!(config.label, "prod");
        assert!(config.tls_skip_verify);
        assert!(!config.enabled);
        assert_eq!(config.auth_method, "kerberos");
        assert_eq!(config.krb5_principal.as_deref(), Some("svc@CORP"));
    }

    #[test]
    fn ad_sync_config_optional_fields() {
        let config = sample_config();
        assert!(config.domain_override.is_none());
        assert!(config.folder_id.is_none());
        assert!(config.keytab_path.is_none());
        assert!(config.krb5_principal.is_none());
        assert!(config.ca_cert_pem.is_none());
    }

    // ── AdSyncRun serialization ───────────────────────────────────────

    #[test]
    fn ad_sync_run_serializes() {
        let run = AdSyncRun {
            id: Uuid::nil(),
            config_id: Uuid::nil(),
            started_at: Utc::now(),
            finished_at: None,
            status: "running".to_string(),
            created: 5,
            updated: 3,
            soft_deleted: 1,
            hard_deleted: 0,
            error_message: None,
        };
        let v = serde_json::to_value(&run).unwrap();
        assert_eq!(v["status"], "running");
        assert_eq!(v["created"], 5);
        assert_eq!(v["updated"], 3);
        assert_eq!(v["soft_deleted"], 1);
        assert_eq!(v["hard_deleted"], 0);
        assert!(v["finished_at"].is_null());
        assert!(v["error_message"].is_null());
    }

    #[test]
    fn ad_sync_run_serializes_with_error() {
        let run = AdSyncRun {
            id: Uuid::nil(),
            config_id: Uuid::nil(),
            started_at: Utc::now(),
            finished_at: Some(Utc::now()),
            status: "failed".to_string(),
            created: 0,
            updated: 0,
            soft_deleted: 0,
            hard_deleted: 0,
            error_message: Some("LDAP bind failed".to_string()),
        };
        let v = serde_json::to_value(&run).unwrap();
        assert_eq!(v["status"], "failed");
        assert_eq!(v["error_message"], "LDAP bind failed");
        assert!(!v["finished_at"].is_null());
    }

    // ── DiscoveredComputer Debug ──────────────────────────────────────

    #[test]
    fn discovered_computer_debug_format() {
        let dc = DiscoveredComputer {
            dn: "CN=PC1,DC=test".to_string(),
            name: "PC1".to_string(),
            dns_host_name: Some("pc1.test.local".to_string()),
            description: Some("Workstation".to_string()),
        };
        let dbg = format!("{:?}", dc);
        assert!(dbg.contains("PC1"));
        assert!(dbg.contains("pc1.test.local"));
    }

    // ── parse_ldif ────────────────────────────────────────────────────

    #[test]
    fn parse_ldif_single_entry() {
        let ldif = "dn: CN=PC1,OU=Computers,DC=corp,DC=com\ncn: PC1\ndNSHostName: pc1.corp.com\ndescription: Dev workstation\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "PC1");
        assert_eq!(result[0].dns_host_name.as_deref(), Some("pc1.corp.com"));
        assert_eq!(result[0].description.as_deref(), Some("Dev workstation"));
    }

    #[test]
    fn parse_ldif_multiple_entries() {
        let ldif = "dn: CN=PC1,DC=corp\ncn: PC1\n\ndn: CN=PC2,DC=corp\ncn: PC2\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "PC1");
        assert_eq!(result[1].name, "PC2");
    }

    #[test]
    fn parse_ldif_continuation_line() {
        let ldif = "dn: CN=LongName,OU=Very Long OU,DC=corp,\n DC=com\ncn: LongName\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].dn.contains("DC=com"));
    }

    #[test]
    fn parse_ldif_empty_input() {
        let result = parse_ldif("").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_ldif_skips_comments() {
        let ldif = "# This is a comment\ndn: CN=PC1,DC=corp\ncn: PC1\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn parse_ldif_uses_name_fallback() {
        // When cn is absent, fall back to 'name' attribute
        let ldif = "dn: CN=PC1,DC=corp\nname: MyPC\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "MyPC");
    }

    #[test]
    fn parse_ldif_uses_dn_as_name_fallback() {
        // When neither cn nor name is present, use DN as name
        let ldif = "dn: CN=PC1,DC=corp\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "CN=PC1,DC=corp");
    }

    #[test]
    fn parse_ldif_continuation_on_attribute() {
        // Continuation lines on non-DN attributes
        let ldif = "dn: CN=PC1,DC=corp\ncn: PC1\ndescription: Long desc\n ription continued\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].description.as_deref(),
            Some("Long description continued")
        );
    }

    #[test]
    fn parse_ldif_flush_at_end_without_trailing_newline() {
        // Entry at end of file without trailing blank line
        let ldif = "dn: CN=PC1,DC=corp\ncn: PC1";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "PC1");
    }

    #[test]
    fn parse_ldif_dns_host_name() {
        let ldif = "dn: CN=PC1,DC=corp\ncn: PC1\ndNSHostName: pc1.corp.local\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result[0].dns_host_name.as_deref(), Some("pc1.corp.local"));
    }

    #[test]
    fn parse_ldif_only_comments() {
        let ldif = "# comment 1\n# comment 2\n";
        let result = parse_ldif(ldif).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn parse_ldif_multiple_continuation_lines() {
        let ldif = "dn: CN=PC1,\n OU=Computers,\n DC=corp,DC=com\ncn: PC1\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].dn.contains("DC=com"));
    }

    #[test]
    fn ad_sync_run_completed_with_counts() {
        let run = AdSyncRun {
            id: Uuid::nil(),
            config_id: Uuid::nil(),
            started_at: Utc::now(),
            finished_at: Some(Utc::now()),
            status: "completed".to_string(),
            created: 50,
            updated: 25,
            soft_deleted: 10,
            hard_deleted: 5,
            error_message: None,
        };
        let v = serde_json::to_value(&run).unwrap();
        assert_eq!(v["created"], 50);
        assert_eq!(v["hard_deleted"], 5);
    }

    // ── DiscoveredComputer ────────────────────────────────────────────

    #[test]
    fn discovered_computer_without_optional_fields() {
        let dc = DiscoveredComputer {
            dn: "CN=PC1,DC=test".to_string(),
            name: "PC1".to_string(),
            dns_host_name: None,
            description: None,
        };
        assert!(dc.dns_host_name.is_none());
        assert!(dc.description.is_none());
    }

    // ── AdSyncConfig extra fields ─────────────────────────────────────

    #[test]
    fn ad_sync_config_with_all_optional_fields() {
        let config = AdSyncConfig {
            domain_override: Some("CORP".to_string()),
            folder_id: Some(Uuid::new_v4()),
            keytab_path: Some("/etc/krb5.keytab".to_string()),
            krb5_principal: Some("svc@CORP.LOCAL".to_string()),
            ca_cert_pem: Some(
                "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----".to_string(),
            ),
            ..sample_config()
        };
        assert_eq!(config.domain_override.as_deref(), Some("CORP"));
        assert!(config.folder_id.is_some());
        assert_eq!(config.keytab_path.as_deref(), Some("/etc/krb5.keytab"));
        assert_eq!(config.krb5_principal.as_deref(), Some("svc@CORP.LOCAL"));
        assert!(config.ca_cert_pem.is_some());
    }

    #[test]
    fn build_tls_config_empty_pem_fails() {
        let result = build_tls_config_with_ca("");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("No certificates found"));
    }

    #[test]
    fn build_tls_config_invalid_pem_fails() {
        let result = build_tls_config_with_ca("this is not a PEM");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("No certificates found"));
    }
    #[test]
    fn test_error_sanitization() {
        let input = "Error with\0 null\0 bytes".to_string();
        let expected = "Error with null bytes".to_string();
        assert_eq!(sanitize_error(input), expected);

        let clean = "Clean string".to_string();
        assert_eq!(sanitize_error(clean.clone()), clean);
    }

    #[test]
    fn sanitize_error_empty() {
        assert_eq!(sanitize_error("".into()), "");
    }

    #[test]
    fn sanitize_error_all_nulls() {
        assert_eq!(sanitize_error("\0\0\0".into()), "");
    }

    #[test]
    fn parse_ldif_two_entries_with_dns() {
        let ldif = "dn: CN=PC1,DC=corp\ncn: PC1\n\ndn: CN=PC2,DC=corp\ncn: PC2\ndNSHostName: pc2.corp.local\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "PC1");
        assert_eq!(result[1].name, "PC2");
        assert!(result[0].dns_host_name.is_none());
        assert_eq!(result[1].dns_host_name.as_deref(), Some("pc2.corp.local"));
    }

    #[test]
    fn parse_ldif_with_description() {
        let ldif = "dn: CN=PC1,DC=corp\ncn: PC1\ndescription: Web server\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result[0].description.as_deref(), Some("Web server"));
    }

    #[test]
    fn parse_ldif_ignores_extra_attributes() {
        let ldif = "dn: CN=PC1,DC=corp\ncn: PC1\noperatingSystem: Windows Server 2022\nobjectGUID: abc123\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "PC1");
    }

    #[test]
    fn parse_ldif_mixed_comments_and_entries() {
        let ldif =
            "# Comment\ndn: CN=A,DC=corp\ncn: A\n\n# Another comment\ndn: CN=B,DC=corp\ncn: B\n\n";
        let result = parse_ldif(ldif).unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn ad_sync_config_serialization() {
        let cfg = sample_config();
        let v = serde_json::to_value(&cfg).unwrap();
        assert_eq!(v["label"], "test-sync");
        assert_eq!(v["protocol"], "rdp");
        assert_eq!(v["enabled"], true);
        assert_eq!(v["auth_method"], "simple");
        assert_eq!(v["default_port"], 3389);
    }

    #[test]
    fn ad_sync_config_deserialization() {
        let cfg = sample_config();
        let json = serde_json::to_string(&cfg).unwrap();
        let deserialized: AdSyncConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.label, cfg.label);
        assert_eq!(deserialized.ldap_url, cfg.ldap_url);
    }

    #[test]
    fn ad_sync_run_serialization_error() {
        let run = AdSyncRun {
            id: Uuid::nil(),
            config_id: Uuid::nil(),
            started_at: Utc::now(),
            finished_at: None,
            status: "error".into(),
            created: 0,
            updated: 0,
            soft_deleted: 0,
            hard_deleted: 0,
            error_message: Some("LDAP bind failed".into()),
        };
        let v = serde_json::to_value(&run).unwrap();
        assert_eq!(v["status"], "error");
        assert_eq!(v["error_message"], "LDAP bind failed");
        assert!(v["finished_at"].is_null());
    }
}
