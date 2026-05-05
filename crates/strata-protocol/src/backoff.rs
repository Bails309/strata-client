//! Decorrelated-jitter exponential backoff for the link reconnect loop.
//!
//! The internal node tries hard to keep the link up — but if a DMZ is
//! genuinely down (or rejecting auth), spamming it with reconnects
//! costs CPU on both ends and pollutes logs. We use the AWS
//! "decorrelated jitter" algorithm: each delay is uniformly random in
//! `[base, prev * 3]`, capped at `max`. The randomness prevents
//! thundering-herd reconnects when N internal nodes converge on a
//! recovering DMZ at once.

use rand::{Rng, RngExt};
use std::time::Duration;

/// Tunable backoff parameters.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    /// Minimum delay after the first failure.
    pub base: Duration,
    /// Maximum delay between attempts (cap).
    pub max: Duration,
    /// Internal: previous delay (so callers do not have to track it).
    prev: Duration,
}

impl Backoff {
    /// New backoff with the given base and cap.
    pub const fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            prev: base,
        }
    }

    /// Reset after a successful connection.
    pub fn reset(&mut self) {
        self.prev = self.base;
    }

    /// Compute the next delay and advance internal state.
    ///
    /// Decorrelated jitter: `next = min(max, random(base, prev * 3))`.
    pub fn next_delay<R: Rng + ?Sized>(&mut self, rng: &mut R) -> Duration {
        let lo = self.base.as_millis() as u64;
        let hi = (self.prev.as_millis() as u64).saturating_mul(3);
        let hi = hi.max(lo + 1);
        let pick = rng.random_range(lo..hi);
        let pick = pick.min(self.max.as_millis() as u64);
        let next = Duration::from_millis(pick);
        self.prev = next;
        next
    }
}

/// Default reconnect backoff: 250ms base, 30s cap.
pub const fn default_link_backoff() -> Backoff {
    Backoff::new(Duration::from_millis(250), Duration::from_secs(30))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::StdRng, SeedableRng};

    #[test]
    fn never_exceeds_cap() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_secs(1));
        let mut rng = StdRng::seed_from_u64(0);
        for _ in 0..100 {
            let d = b.next_delay(&mut rng);
            assert!(d <= Duration::from_secs(1), "exceeded cap: {d:?}");
        }
    }

    #[test]
    fn never_below_base() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_secs(10));
        let mut rng = StdRng::seed_from_u64(7);
        for _ in 0..50 {
            let d = b.next_delay(&mut rng);
            assert!(d >= Duration::from_millis(100), "below base: {d:?}");
        }
    }

    #[test]
    fn reset_returns_to_base_window() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_secs(60));
        let mut rng = StdRng::seed_from_u64(1);
        for _ in 0..20 {
            let _ = b.next_delay(&mut rng);
        }
        b.reset();
        // After reset the next sample's upper bound is `prev * 3` = `base * 3` = 300ms.
        let d = b.next_delay(&mut rng);
        assert!(d <= Duration::from_millis(300), "reset did not shrink window: {d:?}");
    }

    #[test]
    fn distribution_eventually_reaches_cap_neighborhood() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_secs(2));
        let mut rng = StdRng::seed_from_u64(42);
        let mut max_seen = Duration::ZERO;
        for _ in 0..50 {
            max_seen = max_seen.max(b.next_delay(&mut rng));
        }
        // After 50 iterations with 3x growth, we should clearly hit the cap.
        assert!(max_seen >= Duration::from_secs(1));
    }
}
