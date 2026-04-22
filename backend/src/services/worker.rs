//! Shared scaffolding for long-running periodic background workers.
//!
//! Coding Standards §3.3 / W2-4..W2-7 require every spawned background task
//! to:
//!
//! 1. Tick on a bounded interval (no tight loops).
//! 2. Wrap each iteration in `tokio::time::timeout` so a hanging DB / Vault /
//!    LDAP call cannot stall the worker forever.
//! 3. Back off with **jitter** after an error so concurrent replicas don't
//!    retry in lockstep and re-collide on the same transient fault.
//! 4. Listen on a shared `CancellationToken` and return cleanly when it
//!    fires, so SIGTERM/SIGINT can drain the worker set before the process
//!    exits.
//!
//! This module provides [`spawn_periodic`], which encapsulates all four
//! requirements. Call-sites supply the tick period, an iteration budget, and
//! an async closure; everything else is handled centrally.

use rand::RngExt;
use std::future::Future;
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Configuration for a periodic worker.
pub struct PeriodicConfig {
    /// Human-readable label, used as a tracing span name and error prefix.
    pub label: &'static str,
    /// Delay after boot before the first iteration runs. Staggers warm-up
    /// work across the worker set.
    pub initial_delay: Duration,
    /// Interval between the **start** of successive iterations
    /// (`tokio::time::interval` semantics: missed ticks are coalesced).
    pub interval: Duration,
    /// Per-iteration hard budget. An iteration that exceeds this is dropped
    /// and logged at warn level; the next tick proceeds normally.
    pub iteration_timeout: Duration,
    /// Minimum extra delay inserted after an error before the next tick.
    /// Actual delay is `error_backoff_base * U[0.5, 1.5)` so two replicas
    /// hitting the same transient fault do not retry in lockstep.
    pub error_backoff_base: Duration,
}

impl PeriodicConfig {
    /// Sensible defaults for a 60s poller.
    pub const fn every_60s(label: &'static str) -> Self {
        Self {
            label,
            initial_delay: Duration::from_secs(30),
            interval: Duration::from_secs(60),
            iteration_timeout: Duration::from_secs(45),
            error_backoff_base: Duration::from_secs(5),
        }
    }
}

/// Spawn a periodic background worker.
///
/// The closure `run` is invoked once per tick. It returns `Result<(), E>`;
/// errors are logged at warn level and trigger a jittered backoff before the
/// next tick, but never terminate the worker.
///
/// The returned [`JoinHandle`] completes when the supplied
/// `CancellationToken` is cancelled.
pub fn spawn_periodic<F, Fut, E>(
    cfg: PeriodicConfig,
    shutdown: CancellationToken,
    mut run: F,
) -> JoinHandle<()>
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), E>> + Send,
    E: std::fmt::Display + Send,
{
    tokio::spawn(async move {
        // Initial delay — but honour cancellation while we wait.
        tokio::select! {
            _ = tokio::time::sleep(cfg.initial_delay) => {}
            _ = shutdown.cancelled() => {
                tracing::debug!("{}: cancelled before first run", cfg.label);
                return;
            }
        }

        let mut interval = tokio::time::interval(cfg.interval);
        // `Burst` would have us fire N catch-up ticks after a missed window.
        // For pollers we only need one.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {
                    tracing::info!("{}: shutdown requested, exiting worker loop", cfg.label);
                    return;
                }
                _ = interval.tick() => {}
            }

            let iter_fut = run();
            let result = tokio::select! {
                biased;
                _ = shutdown.cancelled() => {
                    tracing::info!("{}: cancelled mid-iteration, exiting", cfg.label);
                    return;
                }
                r = tokio::time::timeout(cfg.iteration_timeout, iter_fut) => r,
            };

            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    tracing::warn!("{}: iteration failed: {e}", cfg.label);
                    sleep_with_jitter(cfg.error_backoff_base, &shutdown).await;
                }
                Err(_elapsed) => {
                    tracing::warn!(
                        "{}: iteration exceeded {}s budget — dropped",
                        cfg.label,
                        cfg.iteration_timeout.as_secs()
                    );
                    sleep_with_jitter(cfg.error_backoff_base, &shutdown).await;
                }
            }
        }
    })
}

async fn sleep_with_jitter(base: Duration, shutdown: &CancellationToken) {
    if base.is_zero() {
        return;
    }
    let base_ms = base.as_millis() as u64;
    // U[0.5, 1.5) multiplier — keeps the expected delay at `base` but
    // decorrelates retries across replicas.
    let jitter: f64 = 0.5 + rand::rng().random::<f64>();
    let delay = Duration::from_millis(((base_ms as f64) * jitter) as u64);
    tokio::select! {
        _ = tokio::time::sleep(delay) => {}
        _ = shutdown.cancelled() => {}
    }
}
