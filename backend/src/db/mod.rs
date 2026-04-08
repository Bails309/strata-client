pub mod pool;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{Pool, Postgres};
use std::str::FromStr;

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
            let pg_mode = match mode.to_lowercase().as_str() {
                "disable" => PgSslMode::Disable,
                "allow" => PgSslMode::Allow,
                "prefer" => PgSslMode::Prefer,
                "require" => PgSslMode::Require,
                "verify-ca" => PgSslMode::VerifyCa,
                "verify-full" => PgSslMode::VerifyFull,
                _ => anyhow::bail!(
                    "Invalid DATABASE_SSL_MODE: {mode}. \
                     Valid values: disable, allow, prefer, require, verify-ca, verify-full"
                ),
            };
            opts = opts.ssl_mode(pg_mode);
        }

        if let Some(cert_path) = ca_cert {
            if !cert_path.is_empty() {
                opts = opts.ssl_root_cert(cert_path);
            }
        }

        let pool = PgPoolOptions::new()
            .max_connections(20)
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

        // sqlx::migrate!().run() requires a Pool, but we hold the lock on
        // `conn`.  The lock prevents other instances from running migrations
        // concurrently.  The migrator may use any pool connection for DDL,
        // which is safe because only one process reaches this point.
        let result = sqlx::migrate!("./migrations")
            .run(&self.pool)
            .await;

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
