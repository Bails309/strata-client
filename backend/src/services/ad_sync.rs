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
    pub group_id: Option<Uuid>,
    pub tls_skip_verify: bool,
    pub sync_interval_minutes: i32,
    pub enabled: bool,
    pub auth_method: String,
    pub keytab_path: Option<String>,
    pub krb5_principal: Option<String>,
    pub ca_cert_pem: Option<String>,
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
struct DiscoveredComputer {
    dn: String,
    name: String,
    dns_host_name: Option<String>,
    description: Option<String>,
}

// ── Execute a full sync for one config ─────────────────────────────────

pub async fn run_sync(pool: &Pool<Postgres>, config: &AdSyncConfig) -> anyhow::Result<Uuid> {
    // Create run record
    let run_id: Uuid = sqlx::query_scalar(
        "INSERT INTO ad_sync_runs (config_id) VALUES ($1) RETURNING id",
    )
    .bind(config.id)
    .fetch_one(pool)
    .await?;

    match do_sync(pool, config, run_id).await {
        Ok(_) => {
            sqlx::query(
                "UPDATE ad_sync_runs SET status = 'success', finished_at = now() WHERE id = $1",
            )
            .bind(run_id)
            .execute(pool)
            .await?;
        }
        Err(e) => {
            let msg = format!("{e:#}");
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
    let computers = ldap_query(config).await?;
    tracing::info!(
        "AD sync '{}': discovered {} computer(s) in {:?}",
        config.label,
        computers.len(),
        config.search_bases,
    );

    // Phase 2: Fetch existing connections for this source
    let existing: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT id, COALESCE(ad_dn,''), hostname FROM connections WHERE ad_source_id = $1 AND soft_deleted_at IS NULL",
    )
    .bind(config.id)
    .fetch_all(pool)
    .await?;

    let existing_dns: std::collections::HashSet<String> =
        existing.iter().map(|(_, dn, _)| dn.clone()).collect();

    let discovered_dns: std::collections::HashSet<String> =
        computers.iter().map(|c| c.dn.clone()).collect();

    let mut created = 0i32;
    let mut updated = 0i32;

    // Phase 3: Upsert discovered computers
    for computer in &computers {
        let hostname = computer
            .dns_host_name
            .as_deref()
            .unwrap_or(&computer.name)
            .to_lowercase();
        let name = computer.name.to_lowercase();

        let desc = computer
            .description
            .as_deref()
            .unwrap_or_default()
            .to_string();
        let description = if desc.is_empty() {
            format!("Imported from AD: {}", config.label)
        } else {
            desc
        };

        if existing_dns.contains(&computer.dn) {
            // Update hostname, name, description, domain if changed
            let changed = sqlx::query(
                "UPDATE connections SET hostname = $1, name = $2, description = $5, domain = $6, soft_deleted_at = NULL, updated_at = now()
                 WHERE ad_source_id = $3 AND ad_dn = $4 AND (hostname != $1 OR name != $2 OR description IS DISTINCT FROM $5 OR domain IS DISTINCT FROM $6 OR soft_deleted_at IS NOT NULL)",
            )
            .bind(&hostname)
            .bind(&name)
            .bind(config.id)
            .bind(&computer.dn)
            .bind(&description)
            .bind(&config.domain_override)
            .execute(pool)
            .await?;
            if changed.rows_affected() > 0 {
                updated += 1;
            }
        } else {
            // Check if soft-deleted — resurrect
            let resurrected = sqlx::query(
                "UPDATE connections SET soft_deleted_at = NULL, hostname = $1, name = $2, description = $5, domain = $6, updated_at = now()
                 WHERE ad_source_id = $3 AND ad_dn = $4 AND soft_deleted_at IS NOT NULL",
            )
            .bind(&hostname)
            .bind(&name)
            .bind(config.id)
            .bind(&computer.dn)
            .bind(&description)
            .bind(&config.domain_override)
            .execute(pool)
            .await?;

            if resurrected.rows_affected() == 0 {
                // Truly new
                sqlx::query(
                    "INSERT INTO connections (name, protocol, hostname, port, domain, description, group_id, ad_source_id, ad_dn, extra)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb)",
                )
                .bind(&name)
                .bind(&config.protocol)
                .bind(&hostname)
                .bind(config.default_port)
                .bind(&config.domain_override)
                .bind(&description)
                .bind(config.group_id)
                .bind(config.id)
                .bind(&computer.dn)
                .execute(pool)
                .await?;
                created += 1;
            } else {
                updated += 1;
            }
        }
    }

    // Phase 4: Soft-delete connections whose DN vanished from LDAP
    let mut soft_deleted = 0i32;
    for (id, dn, _) in &existing {
        if !dn.is_empty() && !discovered_dns.contains(dn) {
            let affected = sqlx::query(
                "UPDATE connections SET soft_deleted_at = now() WHERE id = $1 AND soft_deleted_at IS NULL",
            )
            .bind(id)
            .execute(pool)
            .await?;
            if affected.rows_affected() > 0 {
                soft_deleted += 1;
            }
        }
    }

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
    for cert in rustls_native_certs::load_native_certs().unwrap_or_else(|_| vec![]) {
        let _ = root_store.add(&rustls::Certificate(cert.0));
    }

    // Parse and add custom CA cert(s) from PEM
    let mut reader = std::io::BufReader::new(pem.as_bytes());
    let certs = rustls_pemfile::certs(&mut reader)
        .map_err(|e| anyhow::anyhow!("Failed to parse CA certificate PEM: {e}"))?;

    if certs.is_empty() {
        anyhow::bail!("No certificates found in the provided PEM data");
    }

    for cert_der in certs {
        root_store.add(&rustls::Certificate(cert_der))
            .map_err(|e| anyhow::anyhow!("Failed to add CA certificate: {e}"))?;
    }

    let config = rustls::ClientConfig::builder()
        .with_safe_defaults()
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

async fn ldap_query_simple(config: &AdSyncConfig, search_base: &str) -> anyhow::Result<Vec<DiscoveredComputer>> {
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

    let (results, _res) = ldap
        .search(
            search_base,
            scope,
            filter,
            vec!["cn", "dNSHostName", "distinguishedName", "name", "description"],
        )
        .await?
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

        let dns_host_name = se
            .attrs
            .get("dNSHostName")
            .and_then(|v| v.first())
            .cloned();

        let description = se
            .attrs
            .get("description")
            .and_then(|v| v.first())
            .cloned();

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

async fn ldap_query_kerberos(config: &AdSyncConfig, search_base: &str) -> anyhow::Result<Vec<DiscoveredComputer>> {
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

    // Use a per-config credential cache to avoid races between concurrent syncs
    let ccache = format!("FILE:/tmp/krb5cc_adsync_{}", config.id);

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
        if config.search_filter.is_empty() { "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))" } else { &config.search_filter },
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

    // If custom CA cert provided, write to temp file and point ldapsearch at it
    let ca_cert_path = if let Some(ref pem) = config.ca_cert_pem {
        if !pem.is_empty() && !config.tls_skip_verify {
            let path = format!("/tmp/adsync_ca_{}.crt", config.id);
            tokio::fs::write(&path, pem.as_bytes()).await
                .map_err(|e| anyhow::anyhow!("Failed to write CA cert for ldapsearch: {e}"))?;
            cmd.env("LDAPTLS_CACERT", &path);
            Some(path)
        } else {
            None
        }
    } else {
        None
    };

    let output = cmd
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to run ldapsearch: {e}. Is the openldap-clients package installed?"))?;

    if !output.status.success() {
        anyhow::bail!(
            "ldapsearch failed (exit {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    // Clean up credential cache and CA cert temp file
    let _ = tokio::fs::remove_file(format!("/tmp/krb5cc_adsync_{}", config.id)).await;
    if let Some(path) = ca_cert_path {
        let _ = tokio::fs::remove_file(&path).await;
    }

    let ldif = String::from_utf8_lossy(&output.stdout);
    parse_ldif(&ldif)
}

/// Parse LDIF output from ldapsearch into DiscoveredComputer entries.
fn parse_ldif(ldif: &str) -> anyhow::Result<Vec<DiscoveredComputer>> {
    let mut computers = Vec::new();
    let mut current_dn = String::new();
    let mut attrs: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let flush = |dn: &str, attrs: &std::collections::HashMap<String, String>| -> Option<DiscoveredComputer> {
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

    for line in ldif.lines() {
        if line.is_empty() {
            if let Some(c) = flush(&current_dn, &attrs) {
                computers.push(c);
            }
            current_dn.clear();
            attrs.clear();
            continue;
        }

        // LDIF continuation line (leading space)
        if line.starts_with(' ') {
            continue;
        }

        // Skip comments
        if line.starts_with('#') {
            continue;
        }

        if let Some((key, value)) = line.split_once(": ") {
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

pub fn spawn_sync_scheduler(pool: Pool<Postgres>) {
    tokio::spawn(async move {
        // Wait 30s after boot before first check
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            if let Err(e) = scheduler_tick(&pool).await {
                tracing::warn!("AD sync scheduler error: {e}");
            }
        }
    });
}

async fn scheduler_tick(pool: &Pool<Postgres>) -> anyhow::Result<()> {
    // Check global enable
    let enabled = crate::services::settings::get(pool, "ad_sync_enabled")
        .await?
        .unwrap_or_else(|| "false".into())
        == "true";
    if !enabled {
        return Ok(());
    }

    // Get all enabled configs
    let configs: Vec<AdSyncConfig> = sqlx::query_as(
        "SELECT * FROM ad_sync_configs WHERE enabled = true",
    )
    .fetch_all(pool)
    .await?;

    for config in &configs {
        // Check if enough time has passed since last run
        let last_run: Option<DateTime<Utc>> = sqlx::query_scalar(
            "SELECT MAX(started_at) FROM ad_sync_runs WHERE config_id = $1",
        )
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
            if let Err(e) = run_sync(pool, config).await {
                tracing::error!("AD sync scheduler failed for '{}': {e}", config.label);
            }
        }
    }

    Ok(())
}
