//! Resume registry for transient link-drop continuity.
//!
//! When a user's WebSocket session traverses the DMZ → internal link
//! and the link blips, the public-facing socket on the DMZ side stays
//! up but the internal-side h2 stream tears down. Without help, that
//! kills the underlying guacd connection and the user's RDP/VNC
//! session evaporates.
//!
//! Phase 1h installs the primitive that keeps the session alive: when
//! the internal h2 stream drops, the route handler **suspends** the
//! guacd connection (or any other resumable payload) into a registry
//! keyed by a 16-byte token id, and returns a sealed
//! [`strata_protocol::resume_token`] to the DMZ. The DMZ relays the
//! token to the user's browser as part of the close frame. On
//! reconnect the user presents the token; the internal node verifies
//! it, looks up the entry, and re-attaches.
//!
//! Properties:
//!
//! * **Window** — entries auto-expire after [`DEFAULT_RESUME_WINDOW`]
//!   (30s). A background sweeper task evicts on the same cadence so a
//!   crashed/disconnected user doesn't pin a guacd connection forever.
//! * **Single-shot** — [`ResumeRegistry::take`] removes the entry; a
//!   token can only be redeemed once.
//! * **HMAC sealed** — tokens are HMAC-SHA-256 tagged; tampered or
//!   foreign tokens fail closed without distinguishing reasons.
//! * **Generic over payload** — the registry doesn't care what's
//!   suspended. Internal-side handlers can stash a guacd connection,
//!   a per-session encryption ratchet, anything `Send + 'static`.
//!
//! Out of scope for this phase:
//! * Wiring the registry into the actual WebSocket route — handlers
//!   that need it can be migrated incrementally in follow-up PRs.
//! * Cross-node resume (i.e. resuming on a different internal node).
//!   For now the entry lives in-process; a multi-node deployment must
//!   route reconnect attempts back to the originating node via the
//!   DMZ's connection-affinity layer.

// Phase 7 scaffolding: the resume registry is fully unit-tested but
// not yet wired into the WebSocket upgrade path on `tunnel.rs`. The
// inner-attribute allow keeps the module compiling clean while the
// runtime integration is staged.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use strata_protocol::resume_token::{self, ResumeToken, DEFAULT_RESUME_WINDOW};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

/// Outcome of attempting to take an entry from the registry.
#[derive(Debug, thiserror::Error)]
pub enum ResumeError {
    /// Token failed cryptographic verification, was malformed, or
    /// expired according to its own embedded timestamp.
    ///
    /// This **must** be the response to: bad MAC, wrong key, expired
    /// expiry-ms, malformed base64, wrong length. Callers MUST NOT
    /// distinguish these reasons to the user — see the resume_token
    /// module for the rationale.
    #[error("invalid resume token")]
    Invalid,
    /// Token verified, but no matching entry is present in the local
    /// registry. Either it was already taken, or it was swept out
    /// after expiry, or it belongs to a different internal node.
    ///
    /// To callers, this is functionally identical to `Invalid` — both
    /// mean "the user must start a fresh session".
    #[error("no live entry for resume token")]
    NotFound,
}

struct Entry<T> {
    payload: T,
    /// Wall-clock unix-ms at which this entry must be evicted. Set to
    /// `mint_time + window`; the sweeper compares against `Utc::now()`.
    expiry_ms: i64,
}

/// In-memory registry of suspended session payloads.
///
/// Cheap to clone — internally an `Arc`. All mutating operations are
/// brief and serialised through a single `Mutex`; resume events are
/// rare relative to overall request volume so contention is a non-
/// issue (resume_count/sec on a busy node is bounded by reconnect
/// rate, ~ones-per-second).
#[derive(Clone)]
pub struct ResumeRegistry<T: Send + 'static> {
    inner: Arc<Inner<T>>,
}

struct Inner<T> {
    map: Mutex<HashMap<[u8; 16], Entry<T>>>,
    /// HMAC key for sealing/unsealing tokens. Held in `Zeroizing` so
    /// the bytes are wiped on drop.
    key: Zeroizing<Vec<u8>>,
    window: Duration,
}

impl<T: Send + 'static> ResumeRegistry<T> {
    /// Construct a registry with the supplied HMAC key and window.
    /// The key MUST be at least 32 bytes; HMAC-SHA-256 accepts any
    /// length but anything shorter risks brute force.
    pub fn new(key: Vec<u8>, window: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                map: Mutex::new(HashMap::new()),
                key: Zeroizing::new(key),
                window,
            }),
        }
    }

    /// Construct with the protocol-default 30 s window.
    pub fn with_default_window(key: Vec<u8>) -> Self {
        Self::new(key, DEFAULT_RESUME_WINDOW)
    }

    /// Suspend `payload` and mint a fresh resume token.
    ///
    /// Returns the wire-encoded token (URL-safe base64, no padding)
    /// for handing to the DMZ → user. The internal node holds onto
    /// the payload until either [`take`](Self::take) is called or the
    /// window elapses.
    pub fn put(&self, payload: T) -> String {
        let now_ms = Utc::now().timestamp_millis();
        let expiry_ms = now_ms + self.inner.window.as_millis() as i64;
        let (rt, wire) = resume_token::seal(expiry_ms, &self.inner.key);
        let mut g = self.inner.map.lock().expect("resume map mutex poisoned");
        g.insert(rt.token_id, Entry { payload, expiry_ms });
        wire
    }

    /// Verify, look up, and remove an entry.
    ///
    /// Returns `Err(Invalid)` for any token that fails verification
    /// (the resume_token oracle-resistance contract); `Err(NotFound)`
    /// for verified-but-absent tokens.
    pub fn take(&self, token: &str) -> Result<T, ResumeError> {
        let now_ms = Utc::now().timestamp_millis();
        let rt: ResumeToken = resume_token::unseal(token, &self.inner.key, now_ms)
            .map_err(|_| ResumeError::Invalid)?;
        let mut g = self.inner.map.lock().expect("resume map mutex poisoned");
        // Belt-and-suspenders: even if the cryptographic expiry passes
        // (because the entry was about to be swept on the next tick),
        // honour the registry-side expiry too.
        if let Some(entry) = g.remove(&rt.token_id) {
            if now_ms <= entry.expiry_ms {
                return Ok(entry.payload);
            }
        }
        Err(ResumeError::NotFound)
    }

    /// Number of entries currently held. Cheap; for observability.
    pub fn len(&self) -> usize {
        self.inner
            .map
            .lock()
            .expect("resume map mutex poisoned")
            .len()
    }

    /// True iff no entries are currently held.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Sweep expired entries. Returns the number evicted. Exposed for
    /// tests and for the background sweeper task.
    pub fn sweep(&self) -> usize {
        let now_ms = Utc::now().timestamp_millis();
        let mut g = self.inner.map.lock().expect("resume map mutex poisoned");
        let before = g.len();
        g.retain(|_, e| now_ms <= e.expiry_ms);
        before - g.len()
    }
}

/// Spawn a background task that calls [`ResumeRegistry::sweep`] every
/// `interval` until `shutdown` is cancelled. Returns the task handle
/// so the caller can `await` it during graceful shutdown.
///
/// `interval` should be small relative to the registry's window —
/// `window / 2` is a reasonable default, e.g. 15 s for the default
/// 30 s window.
pub fn spawn_sweeper<T: Send + Sync + 'static>(
    registry: ResumeRegistry<T>,
    interval: Duration,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // Skip the immediate tick; first sweep happens after `interval`.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let _ = ticker.tick().await;
        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break,
                _ = ticker.tick() => {
                    let n = registry.sweep();
                    if n > 0 {
                        tracing::debug!(evicted = n, held = registry.len(), "resume registry sweeper evicted expired entries");
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Vec<u8> {
        b"super-long-resume-key-32-bytes-yo".to_vec()
    }

    #[tokio::test]
    async fn put_then_take_roundtrips() {
        let r = ResumeRegistry::<u64>::with_default_window(key());
        let token = r.put(42);
        assert_eq!(r.len(), 1);
        let got = r.take(&token).unwrap();
        assert_eq!(got, 42);
        assert!(r.is_empty());
    }

    #[tokio::test]
    async fn take_is_single_shot() {
        let r = ResumeRegistry::<u64>::with_default_window(key());
        let token = r.put(7);
        assert!(r.take(&token).is_ok());
        let again = r.take(&token);
        assert!(matches!(again, Err(ResumeError::NotFound)));
    }

    #[tokio::test]
    async fn rejects_token_signed_with_wrong_key() {
        let alice = ResumeRegistry::<u64>::with_default_window(key());
        let bob = ResumeRegistry::<u64>::with_default_window(b"different-key".to_vec());
        let token = alice.put(99);
        let r = bob.take(&token);
        assert!(matches!(r, Err(ResumeError::Invalid)));
        // alice still holds the entry — bob's bad attempt mustn't evict it.
        assert_eq!(alice.len(), 1);
    }

    #[tokio::test]
    async fn rejects_garbage_token() {
        let r = ResumeRegistry::<u64>::with_default_window(key());
        let bad = r.take("not-a-real-token");
        assert!(matches!(bad, Err(ResumeError::Invalid)));
    }

    #[tokio::test]
    async fn rejects_truncated_token() {
        let r = ResumeRegistry::<u64>::with_default_window(key());
        let token = r.put(1);
        let truncated = &token[..token.len() - 4];
        assert!(matches!(r.take(truncated), Err(ResumeError::Invalid)));
        // Original still resolvable — failed take must not consume.
        assert!(r.take(&token).is_ok());
    }

    #[tokio::test]
    async fn expired_entry_is_swept() {
        // 0 ms window: every entry is born already expired.
        let r = ResumeRegistry::<u64>::new(key(), Duration::from_millis(0));
        let _ = r.put(1);
        let _ = r.put(2);
        let _ = r.put(3);
        // Tiny sleep to ensure now_ms > mint_ms.
        tokio::time::sleep(Duration::from_millis(2)).await;
        let evicted = r.sweep();
        assert_eq!(evicted, 3);
        assert!(r.is_empty());
    }

    #[tokio::test]
    async fn take_of_expired_entry_returns_invalid_or_notfound() {
        // resume_token::unseal already rejects on its own expiry check,
        // so a token whose `expiry_ms` has passed should surface as
        // Invalid (NOT NotFound) — verifying the oracle contract.
        let r = ResumeRegistry::<u64>::new(key(), Duration::from_millis(0));
        let token = r.put(5);
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert!(matches!(r.take(&token), Err(ResumeError::Invalid)));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn sweeper_evicts_in_background() {
        let r = ResumeRegistry::<u64>::new(key(), Duration::from_millis(50));
        let _ = r.put(1);
        let _ = r.put(2);

        let shutdown = CancellationToken::new();
        let h = spawn_sweeper(r.clone(), Duration::from_millis(10), shutdown.clone());

        // Advance past entry expiry plus at least one sweep interval.
        tokio::time::advance(Duration::from_millis(200)).await;
        // Yield repeatedly so the sweeper task gets to run.
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }

        assert!(r.is_empty(), "sweeper should have evicted expired entries");

        shutdown.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(1), h).await;
    }

    /// Distinct payloads must round-trip independently and concurrently.
    #[tokio::test]
    async fn registry_is_concurrent_safe() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let r: ResumeRegistry<u64> = ResumeRegistry::with_default_window(key());
        let counter = Arc::new(AtomicU64::new(0));
        let mut handles = Vec::new();
        for i in 0..32u64 {
            let r2 = r.clone();
            let c = counter.clone();
            handles.push(tokio::spawn(async move {
                let token = r2.put(i);
                let got = r2.take(&token).unwrap();
                assert_eq!(got, i);
                c.fetch_add(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(counter.load(Ordering::SeqCst), 32);
        assert!(r.is_empty());
    }
}
