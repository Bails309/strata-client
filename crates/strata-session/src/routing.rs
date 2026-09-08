//! Dual-stack routing: which engine serves a given session.
//!
//! During Phase 2 (ADR-0015) `guacd` and the native engine run side by
//! side. This module owns the decision, deliberately as a pure function
//! with no I/O, so the rollout can be reasoned about and tested rather
//! than discovered in production.
//!
//! Two properties matter more than the policy itself:
//!
//! - **A protocol with no compiled engine can never be routed native.**
//!   Enabling `ssh` but not `rdp` and then setting the rollout to 100%
//!   must not black-hole every RDP session.
//! - **The decision is stable per target host.** Bucketing on the
//!   hostname means a given host is consistently served by one engine,
//!   so "host X is on the new engine" is a statement an operator can
//!   make. Bucketing per session would flap on every reconnect and make
//!   any bug report unreproducible.

use std::collections::HashSet;

use crate::engine::Protocol;

/// Which session tier serves a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionBackend {
    /// The legacy Apache Guacamole daemon.
    Guacd,
    /// `crates/strata-session`.
    Native,
}

/// A routing decision plus why it was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoutingDecision {
    /// The chosen tier.
    pub backend: SessionBackend,
    /// Stable reason string, safe to log and to aggregate on.
    pub reason: &'static str,
}

impl RoutingDecision {
    const fn guacd(reason: &'static str) -> Self {
        Self {
            backend: SessionBackend::Guacd,
            reason,
        }
    }

    const fn native(reason: &'static str) -> Self {
        Self {
            backend: SessionBackend::Native,
            reason,
        }
    }
}

/// Rollout policy for the native session engine.
#[derive(Debug, Clone)]
pub struct RoutingPolicy {
    available: HashSet<Protocol>,
    eligible: HashSet<Protocol>,
    pinned_hosts: HashSet<String>,
    rollout_percent: u8,
    enabled: bool,
}

impl RoutingPolicy {
    /// A policy that routes everything to `guacd`.
    ///
    /// This is the safe default and the state the kill switch returns
    /// to.
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            available: HashSet::new(),
            eligible: HashSet::new(),
            pinned_hosts: HashSet::new(),
            rollout_percent: 0,
            enabled: false,
        }
    }

    /// A policy over the protocols this build actually has engines for.
    #[must_use]
    pub fn new(available: HashSet<Protocol>) -> Self {
        Self {
            eligible: available.clone(),
            available,
            pinned_hosts: HashSet::new(),
            rollout_percent: 0,
            enabled: true,
        }
    }

    /// Protocols compiled into this build, derived from cargo features.
    #[must_use]
    pub fn compiled_protocols() -> HashSet<Protocol> {
        // Stays unmutated when every engine feature is off.
        #[allow(unused_mut)]
        let mut set = HashSet::new();
        #[cfg(feature = "ssh")]
        set.insert(Protocol::Ssh);
        #[cfg(feature = "rdp")]
        set.insert(Protocol::Rdp);
        #[cfg(feature = "vnc")]
        set.insert(Protocol::Vnc);
        #[cfg(feature = "kubernetes")]
        set.insert(Protocol::KubeExec);
        set
    }

    /// Restrict the rollout to a subset of the available protocols.
    #[must_use]
    pub fn with_eligible_protocols(mut self, protocols: HashSet<Protocol>) -> Self {
        self.eligible = protocols;
        self
    }

    /// Always route these hosts to the native engine — the pilot cohort.
    #[must_use]
    pub fn with_pinned_hosts(mut self, hosts: HashSet<String>) -> Self {
        self.pinned_hosts = hosts;
        self
    }

    /// Percentage of eligible hosts served natively, clamped to 0..=100.
    #[must_use]
    pub fn with_rollout_percent(mut self, percent: u8) -> Self {
        self.rollout_percent = percent.min(100);
        self
    }

    /// Master switch. Setting this false is the Phase 2 rollback.
    #[must_use]
    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Decide where a session should go.
    #[must_use]
    pub fn decide(&self, protocol: Protocol, hostname: &str) -> RoutingDecision {
        if !self.enabled {
            return RoutingDecision::guacd("native engine disabled");
        }
        if !self.available.contains(&protocol) {
            return RoutingDecision::guacd("no native engine compiled for protocol");
        }
        if !self.eligible.contains(&protocol) {
            return RoutingDecision::guacd("protocol not in rollout");
        }
        if self.pinned_hosts.contains(hostname) {
            return RoutingDecision::native("host pinned to native engine");
        }
        if self.rollout_percent == 0 {
            return RoutingDecision::guacd("rollout at 0%");
        }
        if u32::from(host_bucket(hostname)) < u32::from(self.rollout_percent) {
            RoutingDecision::native("host inside rollout bucket")
        } else {
            RoutingDecision::guacd("host outside rollout bucket")
        }
    }
}

impl Default for RoutingPolicy {
    fn default() -> Self {
        Self::disabled()
    }
}

/// Stable bucket in `0..100` for a hostname.
///
/// FNV-1a: not a security primitive, and does not need to be — it only
/// has to be deterministic across processes and restarts so a canary
/// cohort stays put.
fn host_bucket(hostname: &str) -> u8 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in hostname.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (hash % 100) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh_only() -> HashSet<Protocol> {
        HashSet::from([Protocol::Ssh])
    }

    #[test]
    fn the_default_policy_sends_everything_to_guacd() {
        let policy = RoutingPolicy::default();
        assert_eq!(
            policy.decide(Protocol::Ssh, "host.internal").backend,
            SessionBackend::Guacd
        );
        assert_eq!(
            policy.decide(Protocol::Rdp, "host.internal").backend,
            SessionBackend::Guacd
        );
    }

    #[test]
    fn a_protocol_without_an_engine_is_never_routed_native() {
        // The dangerous case: rollout cranked to 100% on a build that
        // only has an SSH engine.
        let policy = RoutingPolicy::new(ssh_only())
            .with_eligible_protocols(HashSet::from([Protocol::Ssh, Protocol::Rdp]))
            .with_rollout_percent(100);

        let rdp = policy.decide(Protocol::Rdp, "win.internal");
        assert_eq!(rdp.backend, SessionBackend::Guacd);
        assert_eq!(rdp.reason, "no native engine compiled for protocol");

        assert_eq!(
            policy.decide(Protocol::Ssh, "linux.internal").backend,
            SessionBackend::Native
        );
    }

    #[test]
    fn pinned_hosts_bypass_the_percentage() {
        let policy = RoutingPolicy::new(ssh_only())
            .with_rollout_percent(0)
            .with_pinned_hosts(HashSet::from(["pilot.internal".to_owned()]));

        assert_eq!(
            policy.decide(Protocol::Ssh, "pilot.internal").backend,
            SessionBackend::Native
        );
        assert_eq!(
            policy.decide(Protocol::Ssh, "other.internal").backend,
            SessionBackend::Guacd
        );
    }

    #[test]
    fn the_kill_switch_overrides_everything() {
        let policy = RoutingPolicy::new(ssh_only())
            .with_rollout_percent(100)
            .with_pinned_hosts(HashSet::from(["pilot.internal".to_owned()]))
            .with_enabled(false);

        let decision = policy.decide(Protocol::Ssh, "pilot.internal");
        assert_eq!(decision.backend, SessionBackend::Guacd);
        assert_eq!(decision.reason, "native engine disabled");
    }

    #[test]
    fn a_host_always_lands_on_the_same_engine() {
        let policy = RoutingPolicy::new(ssh_only()).with_rollout_percent(50);
        let first = policy.decide(Protocol::Ssh, "host-42.internal");
        for _ in 0..100 {
            assert_eq!(policy.decide(Protocol::Ssh, "host-42.internal"), first);
        }
    }

    #[test]
    fn the_rollout_percentage_is_roughly_honoured() {
        let hosts: Vec<String> = (0..1000).map(|i| format!("host-{i}.internal")).collect();
        for target in [10u8, 25, 50, 90] {
            let policy = RoutingPolicy::new(ssh_only()).with_rollout_percent(target);
            let native = hosts
                .iter()
                .filter(|h| policy.decide(Protocol::Ssh, h).backend == SessionBackend::Native)
                .count();
            let observed = (native as f64) / (hosts.len() as f64) * 100.0;
            assert!(
                (observed - f64::from(target)).abs() < 5.0,
                "target {target}% produced {observed:.1}%"
            );
        }
    }

    #[test]
    fn a_full_rollout_takes_every_eligible_host() {
        let policy = RoutingPolicy::new(ssh_only()).with_rollout_percent(100);
        for i in 0..500 {
            assert_eq!(
                policy
                    .decide(Protocol::Ssh, &format!("host-{i}.internal"))
                    .backend,
                SessionBackend::Native
            );
        }
    }

    #[test]
    fn rollout_percent_is_clamped() {
        let policy = RoutingPolicy::new(ssh_only()).with_rollout_percent(200);
        assert_eq!(
            policy.decide(Protocol::Ssh, "anything.internal").backend,
            SessionBackend::Native
        );
    }

    #[test]
    fn decisions_carry_a_reason_for_triage() {
        let policy = RoutingPolicy::new(ssh_only()).with_rollout_percent(0);
        assert_eq!(
            policy.decide(Protocol::Ssh, "host.internal").reason,
            "rollout at 0%"
        );
    }
}
