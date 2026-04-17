// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

mod config;
mod db;
mod error;
mod routes;
mod services;
mod tunnel;

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing_subscriber::{fmt, EnvFilter};

use crate::config::{AppConfig, DatabaseMode, LocalVaultSecrets, VaultConfig, VaultMode};
use crate::db::Database;
use crate::services::app_state::{AppState, BootPhase};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialise tracing
    fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .json()
        .init();

    // Initialize rustls crypto provider
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    tracing::info!(
        version = env!("STRATA_VERSION"),
        "Strata Backend starting …"
    );

    // ── Resolve configuration from environment + persisted config ──
    let config_path = AppConfig::config_path();
    let persisted = AppConfig::load(&config_path).ok();

    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        persisted
            .as_ref()
            .map(|c| c.database_url.clone())
            .unwrap_or_else(|| {
                "postgresql://strata:strata_default@postgres-local:5432/strata".into()
            })
    });

    let db_mode = if db_url.contains("postgres-local") {
        DatabaseMode::Local
    } else {
        DatabaseMode::External
    };

    let db_ssl_mode = std::env::var("DATABASE_SSL_MODE")
        .ok()
        .or_else(|| persisted.as_ref().and_then(|c| c.database_ssl_mode.clone()));
    let db_ca_cert = std::env::var("DATABASE_CA_CERT")
        .ok()
        .or_else(|| persisted.as_ref().and_then(|c| c.database_ca_cert.clone()));

    let vault = resolve_vault_config(&persisted);

    let guacd_host = std::env::var("GUACD_HOST")
        .ok()
        .or_else(|| persisted.as_ref().and_then(|c| c.guacd_host.clone()))
        .unwrap_or_else(|| "guacd".into());
    let guacd_port: u16 = std::env::var("GUACD_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .or_else(|| persisted.as_ref().and_then(|c| c.guacd_port))
        .unwrap_or(4822);

    // ── Connect to database ──
    tracing::info!("Connecting to database …");
    let db = Database::connect(&db_url, db_ssl_mode.as_deref(), db_ca_cert.as_deref()).await?;
    db.migrate().await?;
    tracing::info!("Database connected and migrations applied");

    // ── Ensure default admin account exists ──
    ensure_default_admin(&db).await?;

    // ── Resolve JWT signing secret ──
    // Priority: JWT_SECRET env → persisted config → system secrets file → generate new random secret.
    let jwt_secret = if let Ok(s) = std::env::var("JWT_SECRET") {
        s
    } else if let Some(s) = persisted.as_ref().and_then(|c| c.jwt_secret.clone()) {
        s
    } else if let Some(s) = config::SystemSecrets::load().map(|s| s.jwt_secret) {
        s
    } else {
        use base64::Engine;
        let mut key = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut key);
        let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
        tracing::info!("Generated new JWT signing secret");

        // Persist to system-secrets.json immediately so it survives restarts
        let secrets = config::SystemSecrets {
            jwt_secret: secret.clone(),
        };
        if let Err(e) = secrets.save() {
            tracing::warn!("Failed to persist JWT secret: {e}");
        } else {
            tracing::info!("JWT secret persisted to system-secrets.json");
        }
        secret
    };

    // Publish to process-wide OnceLock so auth/middleware can read it
    config::JWT_SECRET
        .set(jwt_secret.clone())
        .expect("JWT_SECRET already initialized");

    // ── Auto-unseal bundled Vault on startup ──
    if let Some(ref v) = vault {
        if v.mode == VaultMode::Local {
            if let Some(ref unseal_key) = v.unseal_key {
                tracing::info!("Bundled Vault detected — checking seal status …");
                match services::vault_provisioning::provision(
                    &v.address,
                    &v.transit_key,
                    Some(unseal_key),
                    Some(&v.token),
                )
                .await
                {
                    Ok(_) => tracing::info!("Bundled Vault is ready"),
                    Err(e) => tracing::warn!("Vault auto-unseal failed (will retry on use): {e}"),
                }
            }
        }
    }

    // ── Parse additional guacd instances ──
    let guacd_instances: Vec<String> = std::env::var("GUACD_INSTANCES")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
                .collect()
        })
        .or_else(|| persisted.as_ref().map(|c| c.guacd_instances.clone()))
        .unwrap_or_default();

    let guacd_pool =
        services::guacd_pool::GuacdPool::new(&guacd_host, guacd_port, &guacd_instances);
    if guacd_pool.len() > 1 {
        tracing::info!("guacd pool: {} instances configured", guacd_pool.len());
    }

    // ── Persist config (secrets are skip_serializing — only safe fields go to disk) ──
    let cfg = AppConfig {
        database_url: db_url,
        database_mode: db_mode,
        database_ssl_mode: db_ssl_mode,
        database_ca_cert: db_ca_cert,
        vault: vault.clone(),
        guacd_host: Some(guacd_host),
        guacd_port: Some(guacd_port),
        guacd_instances,
        jwt_secret: Some(jwt_secret.clone()),
    };
    cfg.save(&config_path)
        .map_err(|e| anyhow::anyhow!("Failed to save config: {e}"))?;

    // ── Build state – always starts in Running ──
    let state = Arc::new(RwLock::new(AppState {
        phase: BootPhase::Running,
        config: Some(cfg),
        db: Some(db),
        session_registry: services::session_registry::SessionRegistry::new(),
        guacd_pool: Some(guacd_pool),
        file_store: services::file_store::FileStore::new(std::path::PathBuf::from(
            "/tmp/strata-files",
        )),
        started_at: std::time::Instant::now(),
    }));

    // ── Spawn recording sync background task ──
    services::recordings::spawn_sync_task(state.clone());

    // ── Spawn AD sync scheduler ──
    services::ad_sync::spawn_sync_scheduler(state.clone());

    // ── Spawn User cleanup background task ──
    services::user_cleanup::spawn_cleanup_task(state.clone());

    let addr: std::net::SocketAddr = "0.0.0.0:8080".parse()?;
    let app = routes::build_router(state.clone());

    tracing::info!("Listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;

    Ok(())
}

/// Resolve Vault config from env vars, falling back to persisted config.
/// For local vault mode, secrets are loaded from the vault-secrets file.
fn resolve_vault_config(persisted: &Option<AppConfig>) -> Option<VaultConfig> {
    let addr = std::env::var("VAULT_ADDR").ok();
    let token = std::env::var("VAULT_TOKEN").ok();
    let key = std::env::var("VAULT_TRANSIT_KEY").ok();

    match (addr, token.clone(), key) {
        (Some(a), Some(t), Some(k)) => Some(VaultConfig {
            address: a,
            token: t,
            transit_key: k,
            mode: VaultMode::External,
            unseal_key: None,
        }),
        _ => {
            // Fall back to persisted config for address/transit_key/mode.
            persisted
                .as_ref()
                .and_then(|c| c.vault.clone())
                .map(|mut v| {
                    // Env vars take highest priority
                    if let Ok(t) = std::env::var("VAULT_TOKEN") {
                        v.token = t;
                    }
                    if let Ok(uk) = std::env::var("VAULT_UNSEAL_KEY") {
                        v.unseal_key = Some(uk);
                    }

                    // For local vault mode, fill in missing token/unseal_key from
                    // the persisted secrets file (written during setup).
                    if v.mode == VaultMode::Local && (v.token.is_empty() || v.unseal_key.is_none())
                    {
                        if let Some(secrets) = LocalVaultSecrets::load() {
                            if v.token.is_empty() {
                                v.token = secrets.token;
                            }
                            if v.unseal_key.is_none() {
                                v.unseal_key = Some(secrets.unseal_key);
                            }
                            tracing::info!("Loaded local vault secrets from persisted file");
                        }
                    }

                    v
                })
        }
    }
}

/// Create the default admin user on first boot if no admin user exists.
async fn ensure_default_admin(db: &Database) -> anyhow::Result<()> {
    // Check if any admin user already exists
    let existing: Option<(uuid::Uuid,)> = sqlx::query_as(
        "SELECT u.id FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'admin' LIMIT 1",
    )
    .fetch_optional(&db.pool)
    .await?;

    if existing.is_some() {
        tracing::info!("Admin account already exists – skipping creation");
        return Ok(());
    }

    let username = std::env::var("DEFAULT_ADMIN_USERNAME").unwrap_or_else(|_| "admin".into());
    let password = std::env::var("DEFAULT_ADMIN_PASSWORD").unwrap_or_else(|_| {
        // Generate a random 16-character password for first boot
        use base64::Engine;
        let mut buf = [0u8; 12];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut buf);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
    });

    // Hash the password with Argon2
    let salt =
        argon2::password_hash::SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    let hash = argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("Password hashing failed: {e}"))?
        .to_string();

    // Get the admin role ID
    let admin_role: (uuid::Uuid,) = sqlx::query_as("SELECT id FROM roles WHERE name = 'admin'")
        .fetch_one(&db.pool)
        .await?;

    sqlx::query(
        "INSERT INTO users (username, email, password_hash, auth_type, role_id)
         VALUES ($1, $2, $3, 'local', $4)
         ON CONFLICT (LOWER(username)) WHERE deleted_at IS NULL DO NOTHING",
    )
    .bind(&username)
    .bind(&username)
    .bind(&hash)
    .bind(admin_role.0)
    .execute(&db.pool)
    .await?;

    tracing::info!("Default admin account created (username: {username})");
    tracing::warn!("╔════════════════════════════════════════════════════════════╗");
    tracing::warn!("║  A default admin password has been generated.             ║");
    tracing::warn!("║  Set DEFAULT_ADMIN_PASSWORD env var to control it,        ║");
    tracing::warn!("║  or change it immediately after first login.              ║");
    tracing::warn!("╚════════════════════════════════════════════════════════════╝");

    Ok(())
}

use argon2::PasswordHasher;
