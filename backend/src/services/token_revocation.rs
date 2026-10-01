//! In-memory JWT token revocation list with database-backed persistence.
//! Tokens are stored as SHA-256 hashes with their expiry time.
//! Expired entries are pruned periodically to prevent unbounded growth.
//!
//! On startup, previously-revoked tokens are reloaded from the
//! `revoked_tokens` database table so that revocations survive restarts.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Entry in the revocation list: the token's `exp` claim (Unix timestamp).
struct RevokedEntry {
    expires_at: u64,
}

static REVOKED_TOKENS: LazyLock<Mutex<HashMap<String, RevokedEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Maximum entries in the revocation list.
const MAX_ENTRIES: usize = 100_000;

/// How often each replica pulls revocations made by the others.
const SYNC_INTERVAL: Duration = Duration::from_secs(15);
/// Pull a little before the last sync, so a revocation committed late by a
/// slow transaction is not missed.
const SYNC_OVERLAP_SECS: i64 = 60;
/// With no successful sync for this long, every token is treated as revoked.
const STALE_AFTER: Duration = Duration::from_secs(300);

/// When the cache last matched the database. `None` until syncing starts,
/// which keeps a process without a database (tests, setup) from failing closed.
static LAST_SYNC: Mutex<Option<Instant>> = Mutex::new(None);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Compute a SHA-256 hash of the token (we never store the raw token).
fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Revoke a token. `exp` is the token's expiry as a Unix timestamp.
pub fn revoke(token: &str, exp: u64) {
    let hash = token_hash(token);
    let mut map = REVOKED_TOKENS.lock().unwrap_or_else(|e| e.into_inner());

    // Prune expired entries if the map is getting large. Unexpired entries
    // are never dropped: forgetting one would make a revoked token valid.
    if map.len() > MAX_ENTRIES / 2 {
        let now = now_secs();
        map.retain(|_, e| e.expires_at > now);
        if map.len() >= MAX_ENTRIES {
            tracing::warn!(
                entries = map.len(),
                "token revocation list is unusually large; keeping every live entry"
            );
        }
    }

    map.insert(hash, RevokedEntry { expires_at: exp });
}

/// Persist a revocation to the database (best-effort, non-blocking).
/// Call this after `revoke()` to survive restarts.
///
/// DB errors are logged at `error!` level — they previously were silently
/// swallowed, which meant a transient DB outage during logout could leave
/// the revocation in-memory only and lost on the next restart.
pub async fn persist_revocation(pool: &sqlx::Pool<sqlx::Postgres>, token: &str, exp: u64) {
    let hash = token_hash(token);
    let expires_at = match chrono::DateTime::from_timestamp(exp as i64, 0) {
        Some(dt) => dt,
        None => {
            tracing::warn!(
                exp,
                "persist_revocation: invalid timestamp, using +24h fallback"
            );
            chrono::Utc::now() + chrono::Duration::hours(24)
        }
    };
    if let Err(e) = sqlx::query(
        "INSERT INTO revoked_tokens (token_hash, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(&hash)
    .bind(expires_at)
    .execute(pool)
    .await
    {
        tracing::error!(
            error = %e,
            "persist_revocation: failed to write revoked_tokens row \
             (in-memory revocation still active, but will be lost on restart)"
        );
    }
}

/// Load revoked tokens from the database into the in-memory cache.
/// Called once at startup to restore revocations across restarts.
pub async fn load_from_db(pool: &sqlx::Pool<sqlx::Postgres>) {
    let now_ts = now_secs() as i64;
    let now_dt = chrono::DateTime::from_timestamp(now_ts, 0);
    let rows: Vec<(String, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT token_hash, expires_at FROM revoked_tokens WHERE expires_at > $1")
            .bind(now_dt)
            .fetch_all(pool)
            .await
            .unwrap_or_default();

    if !rows.is_empty() {
        let mut map = REVOKED_TOKENS.lock().unwrap_or_else(|e| e.into_inner());
        for (hash, expires_at) in rows {
            map.insert(
                hash,
                RevokedEntry {
                    expires_at: expires_at.timestamp() as u64,
                },
            );
        }
        tracing::info!("Loaded {} revoked token(s) from database", map.len());
    }

    // Prune expired rows from DB (best-effort cleanup)
    let _ = sqlx::query("DELETE FROM revoked_tokens WHERE expires_at <= $1")
        .bind(now_dt)
        .execute(pool)
        .await;
}

/// Pull revocations made since `since` (by any replica) into the cache.
/// Returns the database time to pass as `since` next time.
async fn sync_since(
    pool: &sqlx::Pool<sqlx::Postgres>,
    since: chrono::DateTime<chrono::Utc>,
) -> Result<chrono::DateTime<chrono::Utc>, sqlx::Error> {
    let db_now: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT now()").fetch_one(pool).await?;
    let rows: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT token_hash, expires_at FROM revoked_tokens
         WHERE created_at >= $1 AND expires_at > now()",
    )
    .bind(since)
    .fetch_all(pool)
    .await?;
    if !rows.is_empty() {
        let mut map = REVOKED_TOKENS.lock().unwrap_or_else(|e| e.into_inner());
        for (hash, expires_at) in rows {
            map.insert(
                hash,
                RevokedEntry {
                    expires_at: expires_at.timestamp() as u64,
                },
            );
        }
    }
    Ok(db_now - chrono::Duration::seconds(SYNC_OVERLAP_SECS))
}

/// Keep this replica's cache in step with revocations made by the others.
/// Call once, after [`load_from_db`].
pub async fn run_sync(pool: sqlx::Pool<sqlx::Postgres>) {
    *LAST_SYNC.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    let mut since = chrono::Utc::now() - chrono::Duration::seconds(SYNC_OVERLAP_SECS);
    let mut ticker = tokio::time::interval(SYNC_INTERVAL);
    loop {
        ticker.tick().await;
        match sync_since(&pool, since).await {
            Ok(next) => {
                since = next;
                *LAST_SYNC.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
            }
            Err(e) => tracing::error!(error = %e, "token revocation sync failed"),
        }
    }
}

/// Whether revocations made elsewhere may have been missed for too long.
fn sync_is_stale() -> bool {
    LAST_SYNC
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some_and(|at| at.elapsed() > STALE_AFTER)
}

/// Check if a token has been revoked.
pub fn is_revoked(token: &str) -> bool {
    if sync_is_stale() {
        tracing::warn!("token revocation list is out of date; refusing tokens until it syncs");
        return true;
    }
    let hash = token_hash(token);
    let map = REVOKED_TOKENS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = map.get(&hash) {
        // Only consider it revoked if it hasn't naturally expired yet
        entry.expires_at > now_secs()
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_hash_is_deterministic() {
        let h1 = token_hash("test-token-abc");
        let h2 = token_hash("test-token-abc");
        assert_eq!(h1, h2);
    }

    #[test]
    fn token_hash_differs_for_different_tokens() {
        let h1 = token_hash("token-a");
        let h2 = token_hash("token-b");
        assert_ne!(h1, h2);
    }

    #[test]
    fn revoke_and_check() {
        let token = "unique-test-token-revoke-check";
        let future_exp = now_secs() + 3600;
        revoke(token, future_exp);
        assert!(is_revoked(token));
    }

    #[test]
    fn not_revoked_if_never_added() {
        assert!(!is_revoked("never-added-token-xyz"));
    }

    #[test]
    fn expired_revocation_not_reported() {
        let token = "unique-expired-token-test";
        // Expire in the past
        revoke(token, 1);
        assert!(!is_revoked(token));
    }

    #[test]
    fn graduated_eviction_under_pressure() {
        // Fill past half capacity to trigger pruning
        let base_exp = now_secs() + 60;
        for i in 0..(MAX_ENTRIES / 2 + 1) {
            revoke(&format!("pressure-token-{i}"), base_exp);
        }
        revoke("final-pressure-token", now_secs() + 86400);
        assert!(is_revoked("final-pressure-token"));
        // Pressure must never make a live revocation forgettable.
        assert!(is_revoked("pressure-token-0"));
    }

    #[test]
    fn token_hash_is_hex_64_chars() {
        let h = token_hash("any-token");
        assert_eq!(h.len(), 64); // SHA-256 = 32 bytes = 64 hex chars
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn now_secs_returns_recent() {
        let ts = now_secs();
        // After 2020-01-01
        assert!(ts > 1_577_836_800);
    }

    #[test]
    fn revoke_same_token_twice() {
        let token = "double-revoke-test-token";
        let exp = now_secs() + 3600;
        revoke(token, exp);
        revoke(token, exp);
        assert!(is_revoked(token));
    }

    #[test]
    fn max_entries_constant() {
        assert_eq!(MAX_ENTRIES, 100_000);
    }
}
