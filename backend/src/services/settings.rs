use sqlx::{Pool, Postgres};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Cache TTL — settings are re-read from the DB after this period.
/// NOTE: This cache is process-local. In multi-replica deployments, a write
/// on one instance will not invalidate the cache on others until the TTL
/// expires.  Security-critical settings (e.g. `sso_enabled`,
/// `local_auth_enabled`) may therefore take up to CACHE_TTL to propagate.
const CACHE_TTL: Duration = Duration::from_secs(30);

struct CacheEntry {
    value: Option<String>,
    fetched_at: Instant,
}

static CACHE: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Read a setting value, returning a cached copy if available and fresh.
pub async fn get(pool: &Pool<Postgres>, key: &str) -> anyhow::Result<Option<String>> {
    // Check cache first
    {
        let cache = CACHE.lock().unwrap();
        if let Some(entry) = cache.get(key) {
            if entry.fetched_at.elapsed() < CACHE_TTL {
                return Ok(entry.value.clone());
            }
        }
    }

    // Cache miss or stale — query the DB
    let row: Option<String> =
        sqlx::query_scalar("SELECT value FROM system_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await?;

    // Update cache
    {
        let mut cache = CACHE.lock().unwrap();
        cache.insert(
            key.to_string(),
            CacheEntry {
                value: row.clone(),
                fetched_at: Instant::now(),
            },
        );
    }

    Ok(row)
}

/// Upsert a setting value and invalidate the cache entry.
pub async fn set(pool: &Pool<Postgres>, key: &str, value: &str) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;

    // Invalidate cache for this key
    {
        let mut cache = CACHE.lock().unwrap();
        cache.remove(key);
    }

    Ok(())
}

/// Read all settings as key-value pairs.
pub async fn get_all(pool: &Pool<Postgres>) -> anyhow::Result<Vec<(String, String)>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM system_settings ORDER BY key")
            .fetch_all(pool)
            .await?;

    // Populate cache with fresh values
    {
        let mut cache = CACHE.lock().unwrap();
        let now = Instant::now();
        for (k, v) in &rows {
            cache.insert(
                k.clone(),
                CacheEntry {
                    value: Some(v.clone()),
                    fetched_at: now,
                },
            );
        }
    }

    Ok(rows)
}

/// Explicitly invalidate the entire settings cache.
/// Call after bulk changes or vault mode switches.
pub fn invalidate_all() {
    let mut cache = CACHE.lock().unwrap();
    cache.clear();
}
