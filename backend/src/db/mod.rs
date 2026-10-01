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
        //   idle_timeout       60s   (recycle before middleboxes silently drop idle conns)
        //   max_lifetime     3600s   (force periodic reconnect; prevents indefinitely-stale TCP state)
        //   statement_timeout 90s   (kill runaway queries; large AD-sync upserts need more than 30s)
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
            .unwrap_or(60);
        let max_lifetime_secs: u64 = std::env::var("DATABASE_MAX_LIFETIME_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3600);
        let statement_timeout_ms: u64 = std::env::var("DATABASE_STATEMENT_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(90_000);

        let pool = PgPoolOptions::new()
            .max_connections(max_conns)
            .acquire_timeout(Duration::from_secs(acquire_timeout_secs))
            .idle_timeout(Some(Duration::from_secs(idle_timeout_secs)))
            .max_lifetime(Some(Duration::from_secs(max_lifetime_secs)))
            .after_connect(move |conn, _meta| {
                Box::pin(async move {
                    sqlx::query(&format!("SET statement_timeout = {statement_timeout_ms}"))
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

        // sqlx::migrate!().run() requires a Pool, but we hold the lock on
        // `conn`.  The lock prevents other instances from running migrations
        // concurrently.  The migrator may use any pool connection for DDL,
        // which is safe because only one process reaches this point.
        let result = match verify_applied_checksums(&mut conn, &migrator).await {
            Ok(()) => migrator.run(&self.pool).await.map_err(anyhow::Error::from),
            Err(err) => Err(err),
        };

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

/// Why a stored checksum that differs from the build may still be updated.
#[derive(Debug, PartialEq, Eq)]
enum ChecksumRepair {
    /// Same SQL, checked out with different line endings.
    LineEndings,
    /// A historical edit listed in [`KNOWN_EDITS`].
    KnownEdit,
    /// Named in `STRATA_MIGRATION_REPAIR_VERSIONS`.
    Operator,
}

/// Checksums of migration contents that shipped in a release and were later
/// changed, in both line-ending forms. Version 29 was briefly reused by
/// `029_case_insensitive_email.sql` (0.11.1) before it moved to 030.
const KNOWN_EDITS: &[(i64, &str)] = &[
    (29, "c277f20fe638aa15e2e6de56b64f1f365b7825f9b04385fe89349ca1c3647f0f7d5ef85c7bd39fbf24eb1ec808f3fe49"),
    (29, "e8e5e1d79ea2323f8a900fe3aff85022f7ac2bacd6e0df4575773f65433934ccfd0e47b71771a86c14c294fdf7ae5a60"),
    (29, "8c21a00a6e8cf61e936cef6c0a81070c513fe53c622a4e71383ffd3fb69d02e322f09d8a7ae06372733f21a9603805e1"),
    (29, "3b762114628b6f98427c8fccbe38c611cc9721fea5e85a1e754328212e355df24599bbd796a743402be7b042a0f9a9e2"),
];

/// Versions the operator has explicitly allowed to be re-checksummed.
fn operator_repair_versions() -> Vec<i64> {
    std::env::var("STRATA_MIGRATION_REPAIR_VERSIONS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect()
}

fn checksum_repair(
    version: i64,
    sql: &str,
    stored: &[u8],
    operator_versions: &[i64],
) -> Option<ChecksumRepair> {
    use sha2::{Digest, Sha384};
    let lf = sql.replace("\r\n", "\n");
    let crlf = lf.replace('\n', "\r\n");
    if [lf, crlf]
        .iter()
        .any(|variant| Sha384::digest(variant.as_bytes())[..] == *stored)
    {
        return Some(ChecksumRepair::LineEndings);
    }
    let stored_hex = hex::encode(stored);
    if KNOWN_EDITS
        .iter()
        .any(|(v, sum)| *v == version && *sum == stored_hex)
    {
        return Some(ChecksumRepair::KnownEdit);
    }
    operator_versions
        .contains(&version)
        .then_some(ChecksumRepair::Operator)
}

/// Refuse to run when an applied migration no longer matches its source,
/// unless [`checksum_repair`] accepts the difference (SEC-22).
async fn verify_applied_checksums(
    conn: &mut sqlx::PgConnection,
    migrator: &sqlx::migrate::Migrator,
) -> anyhow::Result<()> {
    let table_exists: bool =
        sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations') IS NOT NULL")
            .fetch_one(&mut *conn)
            .await?;
    if !table_exists {
        return Ok(());
    }
    let operator_versions = operator_repair_versions();
    let mut refused = Vec::new();
    for migration in migrator.iter() {
        let version = migration.version;
        let new_checksum = migration.checksum.as_ref();
        let stored: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = $1")
                .bind(version)
                .fetch_optional(&mut *conn)
                .await?;
        let Some(stored) = stored else { continue };
        if stored == new_checksum {
            continue;
        }
        match checksum_repair(version, &migration.sql, &stored, &operator_versions) {
            Some(ChecksumRepair::LineEndings) => tracing::info!(
                version,
                "migration differs only in line endings; updating its checksum"
            ),
            Some(ChecksumRepair::KnownEdit) => tracing::warn!(
                version,
                "migration matches a reviewed historical edit; updating its checksum"
            ),
            Some(ChecksumRepair::Operator) => tracing::error!(
                version,
                old_checksum = %hex::encode(&stored),
                new_checksum = %hex::encode(new_checksum),
                "migration checksum overwritten at the operator's request \
                 (STRATA_MIGRATION_REPAIR_VERSIONS)"
            ),
            None => {
                refused.push(version);
                continue;
            }
        }
        sqlx::query("UPDATE _sqlx_migrations SET checksum = $1 WHERE version = $2")
            .bind(new_checksum)
            .bind(version)
            .execute(&mut *conn)
            .await?;
    }
    if !refused.is_empty() {
        anyhow::bail!(
            "applied migration(s) {refused:?} no longer match the SQL in this build. \
             Applied migrations must not be edited: restore the original file and put \
             the change in a new migration. If you have verified the schema and taken \
             a backup, set STRATA_MIGRATION_REPAIR_VERSIONS to those versions to \
             accept the new checksums."
        );
    }
    Ok(())
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
    /// Operator's public source IP at the time the recording started, as
    /// resolved from `X-Forwarded-For` with a `ConnectInfo` peer-IP fallback.
    /// `None` for recordings created before migration 065.
    pub client_ip: Option<String>,
    /// `guacd` or `native`, so a session can be attributed to the engine
    /// that served it. `None` for recordings predating migration 081.
    pub engine: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha384};
    use sqlx::postgres::PgSslMode;

    fn sum(sql: &str) -> Vec<u8> {
        Sha384::digest(sql.as_bytes()).to_vec()
    }

    #[test]
    fn an_edited_migration_is_not_silently_accepted() {
        let stored = sum("CREATE TABLE a (id int);\n");
        assert_eq!(
            checksum_repair(90, "CREATE TABLE a (id bigint);\n", &stored, &[]),
            None
        );
    }

    #[test]
    fn a_line_ending_difference_is_not_an_edit() {
        let sql = "CREATE TABLE a (\n  id int\n);\n";
        let crlf = sql.replace('\n', "\r\n");
        assert_eq!(
            checksum_repair(90, sql, &sum(&crlf), &[]),
            Some(ChecksumRepair::LineEndings)
        );
        assert_eq!(
            checksum_repair(90, &crlf, &sum(sql), &[]),
            Some(ChecksumRepair::LineEndings)
        );
    }

    #[test]
    fn a_reviewed_historical_edit_is_accepted_only_for_its_version() {
        let (version, hex_sum) = KNOWN_EDITS[0];
        let stored = hex::decode(hex_sum).unwrap();
        assert_eq!(
            checksum_repair(version, "anything", &stored, &[]),
            Some(ChecksumRepair::KnownEdit)
        );
        assert_eq!(checksum_repair(version + 1, "anything", &stored, &[]), None);
    }

    #[test]
    fn an_operator_can_accept_a_named_version() {
        let stored = sum("old");
        assert_eq!(
            checksum_repair(90, "new", &stored, &[90]),
            Some(ChecksumRepair::Operator)
        );
        assert_eq!(checksum_repair(91, "new", &stored, &[90]), None);
    }

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
            client_ip: None,
            engine: Some("native".into()),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["session_id"], "sess-001");
        assert_eq!(v["connection_name"], "My Server");
        assert_eq!(v["username"], "admin");
        assert_eq!(v["duration_secs"], 120);
        assert_eq!(v["storage_type"], "local");
        assert_eq!(v["engine"], "native");
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
            client_ip: None,
            engine: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["duration_secs"].is_null());
        assert_eq!(v["storage_type"], "azure");
        // Predates migration 081, so the engine is genuinely unknown.
        assert!(v["engine"].is_null());
    }
}
