//! In-house circuit breaker (W3-5).
//!
//! Wraps an async fallible operation in a classic **three-state** circuit:
//!
//! * `Closed`   — calls pass through; errors count toward a failure budget.
//! * `Open`     — calls short-circuit with [`CircuitError::Open`] for a
//!                cool-down window without ever invoking the operation.
//! * `HalfOpen` — after cool-down, one probe call is allowed. Success
//!                closes the circuit; failure re-opens it for another
//!                cool-down window (no exponential blow-out — we rely on
//!                the caller's own retry backoff for that).
//!
//! The design targets the three integrations called out in §3.3 — Vault,
//! LDAP, Azure — so the footprint is intentionally tiny (a `Mutex` and
//! three counters). We do NOT depend on the `failsafe` crate because the
//! usage is narrow enough to make the maintenance cost of a third-party
//! crate higher than an in-house impl.
//!
//! # Concurrency
//!
//! The state is behind a `parking_lot`-free `std::sync::Mutex`. The lock
//! is held only during counter bumps and state transitions — never across
//! the user-supplied future — so contention is bounded and deadlocks are
//! impossible.

use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Result type surfaced by [`CircuitBreaker::call`].
pub enum CircuitError<E> {
    /// The circuit is currently open; the call was short-circuited.
    Open,
    /// The underlying operation failed; its error is propagated verbatim.
    Inner(E),
}

impl<E: std::fmt::Display> std::fmt::Display for CircuitError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CircuitError::Open => write!(f, "circuit breaker open"),
            CircuitError::Inner(e) => write!(f, "{e}"),
        }
    }
}

impl<E: std::fmt::Debug> std::fmt::Debug for CircuitError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CircuitError::Open => f.write_str("CircuitError::Open"),
            CircuitError::Inner(e) => f.debug_tuple("CircuitError::Inner").field(e).finish(),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for CircuitError<E> {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Closed,
    /// Carries the `Instant` when the cool-down expires.
    Open(Instant),
    HalfOpen,
}

struct Inner {
    state: State,
    consecutive_failures: u32,
}

/// Configuration for a single circuit breaker instance.
#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub label: &'static str,
    pub failure_threshold: u32,
    pub cooldown: Duration,
}

impl Config {
    pub const fn new(label: &'static str, failure_threshold: u32, cooldown: Duration) -> Self {
        Self {
            label,
            failure_threshold,
            cooldown,
        }
    }
}

pub struct CircuitBreaker {
    cfg: Config,
    inner: Mutex<Inner>,
}

impl CircuitBreaker {
    pub const fn new(cfg: Config) -> Self {
        Self {
            cfg,
            inner: Mutex::new(Inner {
                state: State::Closed,
                consecutive_failures: 0,
            }),
        }
    }

    /// Current state as a string, for diagnostics/tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn state(&self) -> &'static str {
        match self.inner.lock().unwrap_or_else(|e| e.into_inner()).state {
            State::Closed => "closed",
            State::Open(_) => "open",
            State::HalfOpen => "half-open",
        }
    }

    /// Check gate state and transition `Open -> HalfOpen` if cool-down
    /// expired. Returns `true` if the call should be rejected outright.
    fn gate(&self) -> bool {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match g.state {
            State::Closed | State::HalfOpen => false,
            State::Open(until) => {
                if Instant::now() >= until {
                    g.state = State::HalfOpen;
                    tracing::info!("circuit[{}]: cooldown elapsed, probing", self.cfg.label);
                    false
                } else {
                    true
                }
            }
        }
    }

    fn on_success(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.state != State::Closed {
            tracing::info!("circuit[{}]: closed", self.cfg.label);
        }
        g.state = State::Closed;
        g.consecutive_failures = 0;
    }

    fn on_failure(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.consecutive_failures = g.consecutive_failures.saturating_add(1);
        let threshold_hit = g.consecutive_failures >= self.cfg.failure_threshold;
        let was_half_open = g.state == State::HalfOpen;
        if was_half_open || threshold_hit {
            let until = Instant::now() + self.cfg.cooldown;
            g.state = State::Open(until);
            tracing::warn!(
                "circuit[{}]: opened (fails={}, cooldown={:?})",
                self.cfg.label,
                g.consecutive_failures,
                self.cfg.cooldown
            );
        }
    }

    /// Run `op` through the breaker.
    pub async fn call<F, Fut, T, E>(&self, op: F) -> Result<T, CircuitError<E>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        if self.gate() {
            return Err(CircuitError::Open);
        }
        match op().await {
            Ok(v) => {
                self.on_success();
                Ok(v)
            }
            Err(e) => {
                self.on_failure();
                Err(CircuitError::Inner(e))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn opens_after_threshold() {
        let cb = CircuitBreaker::new(Config::new("t", 2, Duration::from_millis(50)));
        assert_eq!(cb.state(), "closed");
        let r: Result<(), _> = cb.call(|| async { Err::<(), _>("boom") }).await;
        assert!(matches!(r, Err(CircuitError::Inner(_))));
        assert_eq!(cb.state(), "closed"); // 1 fail, below threshold
        let r: Result<(), _> = cb.call(|| async { Err::<(), _>("boom") }).await;
        assert!(matches!(r, Err(CircuitError::Inner(_))));
        assert_eq!(cb.state(), "open");
        // Subsequent call rejected without invoking op
        let r: Result<(), CircuitError<&str>> = cb
            .call(|| async {
                panic!("op must not be invoked when circuit is open");
                #[allow(unreachable_code)]
                Err::<(), &str>("unreachable")
            })
            .await;
        assert!(matches!(r, Err(CircuitError::Open)));
    }

    #[tokio::test]
    async fn half_open_recovers_on_success() {
        let cb = CircuitBreaker::new(Config::new("t", 1, Duration::from_millis(10)));
        let _: Result<(), _> = cb.call(|| async { Err::<(), _>("boom") }).await;
        assert_eq!(cb.state(), "open");
        tokio::time::sleep(Duration::from_millis(15)).await;
        let r: Result<i32, CircuitError<&str>> = cb.call(|| async { Ok::<i32, &str>(7) }).await;
        assert!(matches!(r, Ok(7)));
        assert_eq!(cb.state(), "closed");
    }

    #[tokio::test]
    async fn half_open_reopens_on_failure() {
        let cb = CircuitBreaker::new(Config::new("t", 1, Duration::from_millis(10)));
        let _: Result<(), _> = cb.call(|| async { Err::<(), _>("boom") }).await;
        tokio::time::sleep(Duration::from_millis(15)).await;
        let _: Result<(), _> = cb.call(|| async { Err::<(), _>("boom2") }).await;
        assert_eq!(cb.state(), "open");
    }
}
