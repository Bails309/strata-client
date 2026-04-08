//! In-memory JWT token revocation list.
//! Tokens are stored as SHA-256 hashes with their expiry time.
//! Expired entries are pruned periodically to prevent unbounded growth.

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
    let mut map = REVOKED_TOKENS.lock().unwrap();

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

/// Check if a token has been revoked.
pub fn is_revoked(token: &str) -> bool {
    let hash = token_hash(token);
    let map = REVOKED_TOKENS.lock().unwrap();
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
}
