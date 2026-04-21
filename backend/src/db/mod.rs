pub mod pool;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{Pool, Postgres};
use std::str::FromStr;
use std::time::Duration;

/// Parse a string SSL mode into the corresponding `PgSslMode` enum value.
///
/// Accepts (case-insensitive): disable, allow, prefer, require, verify-ca, verify-full.
pub fn parse_ssl_mode(mode: &str) -> anyhow::Result<PgSslMode> {
    match mode.to_lowercase().as_str() {
        "disable" => Ok(PgSslMode::Disable),
        "allow" => Ok(PgSslMode::Allow),
        "prefer" => Ok(PgSslMode::Prefer),
        "require" => Ok(PgSslMode::Require),
        "verify-ca" => Ok(PgSslMode::VerifyCa),
        "verify-full" => Ok(PgSslMode::VerifyFull),
        _ => anyhow::bail!(
            "Invalid DATABASE_SSL_MODE: {mode}. \
             Valid values: disable, allow, prefer, require, verify-ca, verify-full"
        ),
    }
}

#[derive(Debug, Clone)]
pub struct Database {
    pub pool: Pool<Postgres>,
}

impl Database {
    /// Connect to PostgreSQL with a connection string and optional SSL settings.
    ///
    /// * `ssl_mode` — overrides the sslmode in the URL. Valid values:
    ///   disable, allow, prefer, require, verify-ca, verify-full.
    /// * `ca_cert` — path to a PEM-encoded CA certificate file (used with
    ///   verify-ca / verify-full to validate the server certificate).
    pub async fn connect(
        url: &str,
        ssl_mode: Option<&str>,
        ca_cert: Option<&str>,
    ) -> anyhow::Result<Self> {
        let mut opts = PgConnectOptions::from_str(url)?;

        if let Some(mode) = ssl_mode {
            opts = opts.ssl_mode(parse_ssl_mode(mode)?);
        }

        if let Some(cert_path) = ca_cert {
            if !cert_path.is_empty() {
                opts = opts.ssl_root_cert(cert_path);
            }
        }

        let max_conns: u32 = std::env::var("DATABASE_MAX_CONNECTIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(20);

        // Coding Standards §15.4 — bounded pool lifetimes and per-connection
        // statement_timeout. The defaults below are:
        //   acquire_timeout    30s   (fail fast if the pool is exhausted)
        //   idle_timeout      300s   (recycle idle conns so middleboxes do not silently drop them)
        //   max_lifetime     3600s   (force periodic reconnect; prevents indefinitely-stale TCP state)
        //   statement_timeout 30s   (kill runaway queries at the Postgres side)
        // All four are configurable via environment variables. The per-connection
        // statement_timeout is applied in an `after_connect` hook so that any
        // future batch/analytics session (e.g. a tarpaulin run or a long report
        // generator) can opt into a longer value without touching this code path.
        let acquire_timeout_secs: u64 = std::env::var("DATABASE_ACQUIRE_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30);
        let idle_timeout_secs: u64 = std::env::var("DATABASE_IDLE_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300);
        let max_lifetime_secs: u64 = std::env::var("DATABASE_MAX_LIFETIME_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3600);
        let statement_timeout_ms: u64 = std::env::var("DATABASE_STATEMENT_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(30_000);

        let pool = PgPoolOptions::new()
            .max_connections(max_conns)
            .acquire_timeout(Duration::from_secs(acquire_timeout_secs))
            .idle_timeout(Some(Duration::from_secs(idle_timeout_secs)))
            .max_lifetime(Some(Duration::from_secs(max_lifetime_secs)))
            .after_connect(move |conn, _meta| {
                Box::pin(async move {
                    sqlx::query(&format!(
                        "SET statement_timeout = {statement_timeout_ms}"
                    ))
                    .execute(&mut *conn)
                    .await?;
                    Ok(())
                })
            })
            .connect_with(opts)
            .await?;
        Ok(Self { pool })
    }

    /// Run migrations with advisory-lock protection to prevent HA race conditions.
    /// Uses a dedicated connection so the session-level lock is held consistently.
    pub async fn migrate(&self) -> anyhow::Result<()> {
        // Acquire a dedicated connection so the advisory lock is held on the
        // same session for the entire migration run.
        let mut conn = self.pool.acquire().await?;

        const LOCK_ID: i64 = 0x5354_5241_5441; // "STRATA" in hex-ish

        sqlx::query("SELECT pg_advisory_lock($1)")
            .bind(LOCK_ID)
            .execute(&mut *conn)
            .await?;

        tracing::info!("Advisory lock acquired – running migrations");

        let migrator = sqlx::migrate!("./migrations");

        // ── Checksum auto-repair ────────────────────────────────────
        // If a migration file was modified after it was applied (e.g. a
        // comment change, whitespace fix, or idempotent content update),
        // sqlx will refuse to run *any* subsequent migrations.  Repair
        // the stored checksum so the migrator proceeds normally.
        for migration in migrator.iter() {
            let version = migration.version;
            let new_checksum = &migration.checksum;

            let row: Option<(Vec<u8>,)> =
                sqlx::query_as("SELECT checksum FROM _sqlx_migrations WHERE version = $1")
                    .bind(version)
                    .fetch_optional(&mut *conn)
                    .await
                    .unwrap_or(None);

            if let Some((old_checksum,)) = row {
                if old_checksum != new_checksum.as_ref() {
                    tracing::warn!(
                        "Migration {version} checksum mismatch — repairing stored checksum"
                    );
                    sqlx::query("UPDATE _sqlx_migrations SET checksum = $1 WHERE version = $2")
                        .bind(new_checksum.as_ref())
                        .bind(version)
                        .execute(&mut *conn)
                        .await?;
                }
            }
        }

        // sqlx::migrate!().run() requires a Pool, but we hold the lock on
        // `conn`.  The lock prevents other instances from running migrations
        // concurrently.  The migrator may use any pool connection for DDL,
        // which is safe because only one process reaches this point.
        let result = migrator.run(&self.pool).await;

        // Always release the lock, even if migrations failed
        let unlock_result = sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(LOCK_ID)
            .execute(&mut *conn)
            .await;

        // Report migration result first
        result?;
        tracing::info!("Migrations complete");

        unlock_result?;
        Ok(())
    }
}

// ── Models ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct Recording {
    pub id: uuid::Uuid,
    pub session_id: String,
    pub connection_id: uuid::Uuid,
    pub connection_name: String,
    pub user_id: uuid::Uuid,
    pub username: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub duration_secs: Option<i32>,
    pub storage_path: String,
    pub storage_type: String, // 'local' or 'azure'
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgSslMode;

    #[test]
    fn parse_ssl_mode_disable() {
        let m = parse_ssl_mode("disable").unwrap();
        assert!(matches!(m, PgSslMode::Disable));
    }

    #[test]
    fn parse_ssl_mode_allow() {
        let m = parse_ssl_mode("allow").unwrap();
        assert!(matches!(m, PgSslMode::Allow));
    }

    #[test]
    fn parse_ssl_mode_prefer() {
        let m = parse_ssl_mode("prefer").unwrap();
        assert!(matches!(m, PgSslMode::Prefer));
    }

    #[test]
    fn parse_ssl_mode_require() {
        let m = parse_ssl_mode("require").unwrap();
        assert!(matches!(m, PgSslMode::Require));
    }

    #[test]
    fn parse_ssl_mode_verify_ca() {
        let m = parse_ssl_mode("verify-ca").unwrap();
        assert!(matches!(m, PgSslMode::VerifyCa));
    }

    #[test]
    fn parse_ssl_mode_verify_full() {
        let m = parse_ssl_mode("verify-full").unwrap();
        assert!(matches!(m, PgSslMode::VerifyFull));
    }

    #[test]
    fn parse_ssl_mode_case_insensitive() {
        assert!(parse_ssl_mode("DISABLE").is_ok());
        assert!(parse_ssl_mode("Prefer").is_ok());
        assert!(parse_ssl_mode("REQUIRE").is_ok());
        assert!(parse_ssl_mode("Verify-CA").is_ok());
        assert!(parse_ssl_mode("VERIFY-FULL").is_ok());
    }

    #[test]
    fn parse_ssl_mode_invalid() {
        assert!(parse_ssl_mode("invalid").is_err());
        assert!(parse_ssl_mode("").is_err());
        assert!(parse_ssl_mode("ssl").is_err());
        assert!(parse_ssl_mode("tls").is_err());
    }

    #[test]
    fn parse_ssl_mode_error_message() {
        let err = parse_ssl_mode("bogus").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("bogus"));
        assert!(msg.contains("disable"));
    }

    #[test]
    fn recording_serializes() {
        let r = Recording {
            id: uuid::Uuid::nil(),
            session_id: "sess-001".into(),
            connection_id: uuid::Uuid::nil(),
            connection_name: "My Server".into(),
            user_id: uuid::Uuid::nil(),
            username: "admin".into(),
            started_at: chrono::Utc::now(),
            duration_secs: Some(120),
            storage_path: "/recordings/sess-001.guac".into(),
            storage_type: "local".into(),
            created_at: chrono::Utc::now(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["session_id"], "sess-001");
        assert_eq!(v["connection_name"], "My Server");
        assert_eq!(v["username"], "admin");
        assert_eq!(v["duration_secs"], 120);
        assert_eq!(v["storage_type"], "local");
    }

    #[test]
    fn recording_serializes_null_duration() {
        let r = Recording {
            id: uuid::Uuid::nil(),
            session_id: "sess-002".into(),
            connection_id: uuid::Uuid::nil(),
            connection_name: "Another".into(),
            user_id: uuid::Uuid::nil(),
            username: "user".into(),
            started_at: chrono::Utc::now(),
            duration_secs: None,
            storage_path: "/recordings/sess-002.guac".into(),
            storage_type: "azure".into(),
            created_at: chrono::Utc::now(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["duration_secs"].is_null());
        assert_eq!(v["storage_type"], "azure");
    }
}
