//! In-memory JWT token revocation list with database-backed persistence.
//! Tokens are stored as SHA-256 hashes with their expiry time.
//! Expired entries are pruned periodically to prevent unbounded growth.
//!
//! On startup, previously-revoked tokens are reloaded from the
//! `revoked_tokens` database table so that revocations survive restarts.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Entry in the revocation list: the token's `exp` claim (Unix timestamp).
struct RevokedEntry {
    expires_at: u64,
}

static REVOKED_TOKENS: LazyLock<Mutex<HashMap<String, RevokedEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Maximum entries in the revocation list.
const MAX_ENTRIES: usize = 100_000;

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

    // Prune expired entries if the map is getting large
    if map.len() > MAX_ENTRIES / 2 {
        let now = now_secs();
        map.retain(|_, e| e.expires_at > now);
    }

    // Hard cap — if still too large, evict entries closest to natural expiry
    if map.len() >= MAX_ENTRIES {
        let now = now_secs();
        // Evict entries that expire within the next 5 minutes first (soonest to expire)
        map.retain(|_, e| e.expires_at > now + 300);
        // If still over limit, evict entries expiring within the next hour
        if map.len() >= MAX_ENTRIES {
            map.retain(|_, e| e.expires_at > now + 3600);
        }
        // Last resort: keep only entries with > 6 hours remaining
        if map.len() >= MAX_ENTRIES {
            map.retain(|_, e| e.expires_at > now + 21600);
        }
    }

    map.insert(hash, RevokedEntry { expires_at: exp });
}

/// Persist a revocation to the database (best-effort, non-blocking).
/// Call this after `revoke()` to survive restarts.
pub async fn persist_revocation(
    pool: &sqlx::Pool<sqlx::Postgres>,
    token: &str,
    exp: u64,
) {
    let hash = token_hash(token);
    let expires_at = match chrono::DateTime::from_timestamp(exp as i64, 0) {
        Some(dt) => dt,
        None => {
            tracing::warn!(exp, "persist_revocation: invalid timestamp, using +24h fallback");
            chrono::Utc::now() + chrono::Duration::hours(24)
        }
    };
    let _ = sqlx::query(
        "INSERT INTO revoked_tokens (token_hash, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(&hash)
    .bind(expires_at)
    .execute(pool)
    .await;
}

/// Load revoked tokens from the database into the in-memory cache.
/// Called once at startup to restore revocations across restarts.
pub async fn load_from_db(pool: &sqlx::Pool<sqlx::Postgres>) {
    let now_ts = now_secs() as i64;
    let now_dt = chrono::DateTime::from_timestamp(now_ts, 0);
    let rows: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT token_hash, expires_at FROM revoked_tokens WHERE expires_at > $1",
    )
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

/// Check if a token has been revoked.
pub fn is_revoked(token: &str) -> bool {
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
        let base_exp = now_secs() + 60; // expire in 60s (within 5min window)
        for i in 0..(MAX_ENTRIES / 2 + 1) {
            revoke(&format!("pressure-token-{i}"), base_exp);
        }
        // Should not panic — pruning should handle it
        revoke("final-pressure-token", now_secs() + 86400);
        assert!(is_revoked("final-pressure-token"));
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
