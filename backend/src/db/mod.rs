pub mod pool;

use sqlx::postgres::PgPoolOptions;
use sqlx::{Pool, Postgres};

#[derive(Debug, Clone)]
pub struct Database {
    pub pool: Pool<Postgres>,
}

impl Database {
    /// Connect to PostgreSQL with a connection string.
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(20)
            .connect(url)
            .await?;
        Ok(Self { pool })
    }

    /// Run migrations with advisory-lock protection to prevent HA race conditions.
    pub async fn migrate(&self) -> anyhow::Result<()> {
        // Acquire a PostgreSQL advisory lock (key = hash of "strata-migrations")
        const LOCK_ID: i64 = 0x5354_5241_5441; // "STRATA" in hex-ish

        sqlx::query("SELECT pg_advisory_lock($1)")
            .bind(LOCK_ID)
            .execute(&self.pool)
            .await?;

        tracing::info!("Advisory lock acquired – running migrations");
        sqlx::migrate!("./migrations").run(&self.pool).await?;
        tracing::info!("Migrations complete");

        sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(LOCK_ID)
            .execute(&self.pool)
            .await?;

        Ok(())
    }
}
