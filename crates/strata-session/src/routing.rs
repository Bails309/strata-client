//! Which protocols this deployment will serve.
//!
//! The native engine is the only engine (ADR-0015); guacd was removed in
//! v2. What survives from the dual-stack period is the part that earned
//! its keep: a per-protocol switch, held as a pure function with no I/O
//! so it can be reasoned about and tested rather than discovered in
//! production.
//!
//! One property matters more than the policy itself: **a protocol with
//! no compiled engine is never claimed as servable.** Enabling `ssh` but
//! not `rdp` in the build must refuse RDP with a reason, not accept the
//! session and then fail somewhere further in.

use std::collections::HashSet;

use crate::engine::Protocol;

/// Whether a session can be served, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionBackend {
    /// `crates/strata-session` will serve it.
    Native,
    /// Nothing will. The reason on the decision says what to fix.
    Refused,
}

/// A routing decision plus why it was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoutingDecision {
    /// The outcome.
    pub backend: SessionBackend,
    /// Stable reason string, safe to log and to aggregate on.
    pub reason: &'static str,
}

impl RoutingDecision {
    const fn refused(reason: &'static str) -> Self {
        Self {
            backend: SessionBackend::Refused,
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

/// Which protocols the engine is allowed to serve here.
#[derive(Debug, Clone)]
pub struct RoutingPolicy {
    available: HashSet<Protocol>,
    eligible: HashSet<Protocol>,
}

impl RoutingPolicy {
    /// Protocols this build can serve.
    #[must_use]
    pub fn available(&self) -> &HashSet<Protocol> {
        &self.available
    }

    /// Protocols this deployment allows.
    #[must_use]
    pub fn eligible(&self) -> &HashSet<Protocol> {
        &self.eligible
    }

    /// A policy over the protocols this build actually has engines for.
    #[must_use]
    pub fn new(available: HashSet<Protocol>) -> Self {
        Self {
            eligible: available.clone(),
            available,
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

    /// Restrict serving to a subset of the available protocols.
    #[must_use]
    pub fn with_eligible_protocols(mut self, protocols: HashSet<Protocol>) -> Self {
        self.eligible = protocols;
        self
    }

    /// Decide whether a session can be served.
    #[must_use]
    pub fn decide(&self, protocol: Protocol) -> RoutingDecision {
        if !self.available.contains(&protocol) {
            return RoutingDecision::refused("no engine compiled for protocol");
        }
        if !self.eligible.contains(&protocol) {
            return RoutingDecision::refused("protocol disabled by configuration");
        }
        RoutingDecision::native("protocol enabled")
    }
}

impl Default for RoutingPolicy {
    fn default() -> Self {
        Self::new(Self::compiled_protocols())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh_only() -> HashSet<Protocol> {
        HashSet::from([Protocol::Ssh])
    }

    #[test]
    fn the_default_policy_serves_every_compiled_protocol() {
        let policy = RoutingPolicy::default();
        for protocol in RoutingPolicy::compiled_protocols() {
            assert_eq!(
                policy.decide(protocol).backend,
                SessionBackend::Native,
                "{protocol:?} is compiled in but the default policy refuses it"
            );
        }
    }

    #[test]
    fn a_protocol_without_an_engine_is_never_claimed() {
        // The dangerous case: configuration names a protocol on a build
        // that only has an SSH engine.
        let policy = RoutingPolicy::new(ssh_only())
            .with_eligible_protocols(HashSet::from([Protocol::Ssh, Protocol::Rdp]));

        let rdp = policy.decide(Protocol::Rdp);
        assert_eq!(rdp.backend, SessionBackend::Refused);
        assert_eq!(rdp.reason, "no engine compiled for protocol");

        assert_eq!(policy.decide(Protocol::Ssh).backend, SessionBackend::Native);
    }

    #[test]
    fn narrowing_the_eligible_set_refuses_the_rest() {
        let ssh: HashSet<Protocol> = RoutingPolicy::compiled_protocols()
            .into_iter()
            .filter(|p| *p == Protocol::Ssh)
            .collect();
        let policy =
            RoutingPolicy::new(RoutingPolicy::compiled_protocols()).with_eligible_protocols(ssh);

        let decision = policy.decide(Protocol::Rdp);
        assert_eq!(decision.backend, SessionBackend::Refused);
        assert!(matches!(
            decision.reason,
            "protocol disabled by configuration" | "no engine compiled for protocol"
        ));
    }

    #[test]
    fn a_protocol_always_lands_on_the_same_answer() {
        let policy = RoutingPolicy::new(ssh_only());
        let first = policy.decide(Protocol::Ssh);
        for _ in 0..100 {
            assert_eq!(policy.decide(Protocol::Ssh), first);
        }
    }

    #[test]
    fn decisions_carry_a_reason_for_triage() {
        let policy = RoutingPolicy::new(ssh_only()).with_eligible_protocols(HashSet::new());
        assert_eq!(
            policy.decide(Protocol::Ssh).reason,
            "protocol disabled by configuration"
        );
    }
}
