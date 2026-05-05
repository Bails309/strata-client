//! Per-endpoint link state, shared between the supervisor task and any
//! observers (admin UI, `/readyz`, Prometheus exporter).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

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
    pub failures: u64,
}

/// Process-wide registry of link statuses, one entry per configured endpoint.
#[derive(Clone, Default)]
pub struct LinkRegistry {
    inner: Arc<RwLock<HashMap<String, LinkStatus>>>,
}

impl LinkRegistry {
    /// New empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert / replace the status entry for `endpoint`.
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
            }
        }
    }

    /// Snapshot every link status. Cheap (clones a small Vec).
    pub fn snapshot(&self) -> Vec<LinkStatus> {
        let g = self.inner.read().expect("LinkRegistry poisoned");
        g.values().cloned().collect()
    }

    /// True iff at least one configured link is `Up`. Empty registry → false.
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
}
