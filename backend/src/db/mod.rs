pub mod pool;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{Pool, Postgres};
use std::str::FromStr;

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

        let migrator = sqlx::migrate!("./migrations");

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
