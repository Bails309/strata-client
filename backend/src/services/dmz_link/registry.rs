//! Per-endpoint link state, shared between the supervisor task and any
//! observers (admin UI, `/readyz`, Prometheus exporter).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use tokio_util::sync::CancellationToken;

use super::config::LinkEndpoint;

/// Coarse-grained lifecycle state of a single link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    /// Supervisor has not yet attempted a connection.
    Initializing,
    /// Currently dialing the underlying transport.
    Connecting,
    /// Transport is up; running the auth handshake.
    Authenticating,
    /// Link is up and ready to carry requests.
    Up,
    /// Link is down and the supervisor is sleeping before the next dial.
    Backoff,
    /// Supervisor was stopped (cancellation token fired).
    Stopped,
}

impl LinkState {
    /// True iff this state should count toward `/readyz`.
    pub fn is_ready(self) -> bool {
        matches!(self, LinkState::Up)
    }

    /// Human-readable label for logs/metrics.
    pub fn as_str(self) -> &'static str {
        match self {
            LinkState::Initializing => "initializing",
            LinkState::Connecting => "connecting",
            LinkState::Authenticating => "authenticating",
            LinkState::Up => "up",
            LinkState::Backoff => "backoff",
            LinkState::Stopped => "stopped",
        }
    }
}

/// Snapshot of a single link's status.
#[derive(Debug, Clone)]
pub struct LinkStatus {
    /// Endpoint URL.
    pub endpoint: String,
    /// Current state.
    pub state: LinkState,
    /// Reason for the most recent disconnect / failure, if any.
    pub last_error: Option<String>,
    /// Wall-clock time of the most recent state transition.
    pub since: SystemTime,
    /// Total successful handshakes since process start.
    pub connects: u64,
    /// Total dial / handshake / runtime failures since process start.
    /// Reset to zero each time the link reaches `Up`, so the counter
    /// reflects only failures since the last successful connection.
    pub failures: u64,
    /// Internal flag set by [`LinkRegistry::kick`] so the supervisor
    /// can distinguish an admin-requested reconnect from a real
    /// disconnect when the active stream is cancelled. Not exposed
    /// over the wire (the API only surfaces `last_error`).
    pub(crate) kicked: bool,
}

/// Process-wide registry of link statuses, one entry per configured endpoint.
#[derive(Clone, Default)]
pub struct LinkRegistry {
    inner: Arc<RwLock<HashMap<String, LinkStatus>>>,
    /// Per-endpoint cancellation token for the *current* connection
    /// cycle (dial → handshake → serve). Replaced by the supervisor
    /// at the top of each cycle so [`LinkRegistry::kick`] always
    /// targets the live stream rather than a stale one.
    active_tokens: Arc<RwLock<HashMap<String, CancellationToken>>>,
}

impl LinkRegistry {
    /// New empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert / replace the status entry for `endpoint`.
    #[allow(dead_code)]
    pub(super) fn put(&self, status: LinkStatus) {
        let mut g = self.inner.write().expect("LinkRegistry poisoned");
        g.insert(status.endpoint.clone(), status);
    }

    /// Update only the state field (and bump `since`), preserving counters.
    pub(crate) fn set_state(&self, endpoint: &str, state: LinkState, err: Option<String>) {
        let mut g = self.inner.write().expect("LinkRegistry poisoned");
        if let Some(s) = g.get_mut(endpoint) {
            s.state = state;
            s.since = SystemTime::now();
            if err.is_some() {
                s.last_error = err;
                s.failures = s.failures.saturating_add(1);
            }
            if state == LinkState::Up {
                s.connects = s.connects.saturating_add(1);
                s.last_error = None;
                // A real successful connection wipes the failures
                // counter so the UI shows fresh-since-Up failures
                // only. Without this the column accrues forever and
                // becomes meaningless after enough time.
                s.failures = 0;
            }
        }
    }

    /// Mark `endpoint` as `Backoff` with `reason` recorded in
    /// `last_error`, but do NOT increment the failures counter.
    /// Used for admin-requested reconnects so the failures column
    /// reflects only real connectivity problems.
    pub(crate) fn set_backoff_without_failure(&self, endpoint: &str, reason: String) {
        let mut g = self.inner.write().expect("LinkRegistry poisoned");
        if let Some(s) = g.get_mut(endpoint) {
            s.state = LinkState::Backoff;
            s.since = SystemTime::now();
            s.last_error = Some(reason);
        }
    }

    /// Register the cancellation token that controls the current
    /// connection cycle. Called by the supervisor at the top of each
    /// loop iteration. Replaces any previously-registered token.
    pub(super) fn register_active_token(&self, endpoint: &str, token: CancellationToken) {
        self.active_tokens
            .write()
            .expect("LinkRegistry poisoned")
            .insert(endpoint.to_string(), token);
    }

    /// Drop the active token for `endpoint`. Called by the supervisor
    /// once it's left the serve loop and is about to start a new cycle.
    pub(super) fn clear_active_token(&self, endpoint: &str) {
        self.active_tokens
            .write()
            .expect("LinkRegistry poisoned")
            .remove(endpoint);
    }

    /// Admin-requested reconnect. Cancels the active connection token
    /// (forcing the supervisor's serve loop to unwind) and stamps the
    /// `kicked` flag so the supervisor knows the next disconnect is
    /// not a real failure. Returns true iff a live token was present
    /// (i.e. the link was past the dial phase).
    pub fn kick(&self, endpoint: &str) -> bool {
        let cancelled = {
            let g = self
                .active_tokens
                .read()
                .expect("LinkRegistry poisoned");
            if let Some(tok) = g.get(endpoint) {
                tok.cancel();
                true
            } else {
                false
            }
        };
        let mut inner = self.inner.write().expect("LinkRegistry poisoned");
        if let Some(s) = inner.get_mut(endpoint) {
            s.kicked = true;
        }
        cancelled
    }

    /// Drain and return the `kicked` flag. The supervisor calls this
    /// after `serve_h2` returns to decide whether to suppress the
    /// failure counter and skip the backoff sleep.
    pub(super) fn take_kicked(&self, endpoint: &str) -> bool {
        let mut g = self.inner.write().expect("LinkRegistry poisoned");
        match g.get_mut(endpoint) {
            Some(s) => std::mem::replace(&mut s.kicked, false),
            None => false,
        }
    }

    /// Snapshot every link status. Cheap (clones a small Vec).
    pub fn snapshot(&self) -> Vec<LinkStatus> {
        let g = self.inner.read().expect("LinkRegistry poisoned");
        g.values().cloned().collect()
    }

    /// True iff at least one configured link is `Up`. Empty registry → false.
    #[allow(dead_code)]
    pub fn any_up(&self) -> bool {
        let g = self.inner.read().expect("LinkRegistry poisoned");
        g.values().any(|s| s.state.is_ready())
    }

    /// Initialise an entry for each endpoint in `Initializing` state.
    pub(super) fn seed(&self, endpoints: &[LinkEndpoint]) {
        let mut g = self.inner.write().expect("LinkRegistry poisoned");
        for ep in endpoints {
            g.entry(ep.url.clone()).or_insert_with(|| LinkStatus {
                endpoint: ep.url.clone(),
                state: LinkState::Initializing,
                last_error: None,
                since: SystemTime::now(),
                connects: 0,
                failures: 0,
                kicked: false,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(url: &str) -> LinkEndpoint {
        LinkEndpoint {
            url: url.to_string(),
        }
    }

    #[test]
    fn seed_creates_entries_in_initializing() {
        let r = LinkRegistry::new();
        r.seed(&[ep("a"), ep("b")]);
        let snap = r.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|s| s.state == LinkState::Initializing));
        assert!(!r.any_up());
    }

    #[test]
    fn set_state_up_increments_connects_and_clears_error() {
        let r = LinkRegistry::new();
        r.seed(&[ep("a")]);
        r.set_state("a", LinkState::Backoff, Some("dial failed".into()));
        r.set_state("a", LinkState::Up, None);
        let snap = r.snapshot();
        let s = snap.iter().find(|s| s.endpoint == "a").unwrap();
        assert_eq!(s.state, LinkState::Up);
        assert_eq!(s.connects, 1);
        assert!(s.last_error.is_none());
        assert!(r.any_up());
    }

    #[test]
    fn set_state_failure_increments_failures() {
        let r = LinkRegistry::new();
        r.seed(&[ep("a")]);
        r.set_state("a", LinkState::Backoff, Some("e1".into()));
        r.set_state("a", LinkState::Backoff, Some("e2".into()));
        let snap = r.snapshot();
        let s = snap.iter().find(|s| s.endpoint == "a").unwrap();
        assert_eq!(s.failures, 2);
        assert_eq!(s.last_error.as_deref(), Some("e2"));
    }

    #[test]
    fn set_state_for_unknown_endpoint_is_noop() {
        let r = LinkRegistry::new();
        r.seed(&[ep("a")]);
        r.set_state("nope", LinkState::Up, None);
        assert!(!r.any_up());
    }

    #[test]
    fn up_resets_failures_counter() {
        let r = LinkRegistry::new();
        r.seed(&[ep("a")]);
        // Three failed dials accumulate the counter.
        r.set_state("a", LinkState::Backoff, Some("e1".into()));
        r.set_state("a", LinkState::Backoff, Some("e2".into()));
        r.set_state("a", LinkState::Backoff, Some("e3".into()));
        assert_eq!(r.snapshot()[0].failures, 3);
        // A successful connection wipes the slate.
        r.set_state("a", LinkState::Up, None);
        let snap = r.snapshot();
        assert_eq!(snap[0].failures, 0);
        assert_eq!(snap[0].connects, 1);
    }

    #[test]
    fn kick_cancels_active_token_and_sets_flag() {
        let r = LinkRegistry::new();
        r.seed(&[ep("a")]);
        let tok = CancellationToken::new();
        r.register_active_token("a", tok.clone());

        assert!(r.kick("a"), "kick should report a live token was present");
        assert!(tok.is_cancelled(), "kick must cancel the registered token");
        assert!(r.take_kicked("a"), "take_kicked drains the flag");
        assert!(
            !r.take_kicked("a"),
            "second take_kicked returns false (flag already drained)"
        );
    }

    #[test]
    fn kick_without_active_token_still_marks_flag() {
        let r = LinkRegistry::new();
        r.seed(&[ep("a")]);
        // No register_active_token — link is in dial / backoff phase.
        assert!(!r.kick("a"), "no live token => kick returns false");
        assert!(
            r.take_kicked("a"),
            "kicked flag is still set so the next disconnect is treated as admin-requested"
        );
    }

    #[test]
    fn set_backoff_without_failure_does_not_increment_counter() {
        let r = LinkRegistry::new();
        r.seed(&[ep("a")]);
        r.set_backoff_without_failure("a", "admin-requested reconnect".into());
        let s = &r.snapshot()[0];
        assert_eq!(s.state, LinkState::Backoff);
        assert_eq!(s.failures, 0);
        assert_eq!(s.last_error.as_deref(), Some("admin-requested reconnect"));
    }
}
