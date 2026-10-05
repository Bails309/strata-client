// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Measured session cost (v2.3.7).
//!
//! The capacity figures used to rest on fixed guesses: 0.15 CPU and two
//! framebuffers per session. Production showed ~0.04 CPU and ~50 MB, so
//! the card under-reported CPU headroom and admission under-reserved
//! memory. This samples what the container actually uses every
//! [`SAMPLE_INTERVAL`] and keeps smoothed per-session averages, which size
//! the capacity card and scale admission estimates up when they are low.
//!
//! The container's cgroup is read in preference to the process, so the
//! Chromium and Xvnc that web sessions start count towards their cost.
//! Memory is anonymous memory only: page cache from recordings is
//! reclaimable and would otherwise inflate every session.

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(30);

/// Below this many sessions the averages are mostly baseline noise.
const MIN_SESSIONS: u32 = 5;
/// Weight of each new sample: about five minutes of history at 30 s.
const ALPHA: f64 = 0.1;
/// Idle memory assumed until the backend is seen with no sessions.
const DEFAULT_BASELINE: u64 = 256 * 1024 * 1024;
/// Admission never scales an estimate by more than this.
const MAX_CALIBRATION: f64 = 4.0;

/// One reading of the container.
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    /// Seconds since an arbitrary fixed point.
    pub at_secs: f64,
    /// Cumulative CPU time, in microseconds, if it could be read.
    pub cpu_usec: Option<u64>,
    /// Anonymous memory in use.
    pub memory: u64,
    /// Replay history held for observers, which has its own budget.
    pub replay: u64,
    /// Sessions holding an admission reservation.
    pub sessions: u32,
    /// Memory those sessions reserved at admission.
    pub reserved: u64,
}

/// Smoothed per-session cost.
#[derive(Debug, Default, Clone)]
pub struct Model {
    last_cpu: Option<(u64, f64)>,
    baseline: Option<u64>,
    cpu_per_session: Option<f64>,
    memory_per_session: Option<f64>,
    calibration: Option<f64>,
}

fn ewma(slot: &mut Option<f64>, value: f64) {
    *slot = Some(slot.map_or(value, |old| old + ALPHA * (value - old)));
}

impl Model {
    pub fn observe(&mut self, s: Sample) {
        let cores = match (self.last_cpu, s.cpu_usec) {
            (Some((before, then)), Some(now)) if s.at_secs > then && now >= before => {
                Some((now - before) as f64 / 1_000_000.0 / (s.at_secs - then))
            }
            _ => None,
        };
        if let Some(now) = s.cpu_usec {
            self.last_cpu = Some((now, s.at_secs));
        }

        if s.sessions == 0 {
            self.baseline = Some(self.baseline.map_or(s.memory, |b| b.min(s.memory)));
            return;
        }
        if s.sessions < MIN_SESSIONS {
            return;
        }
        let n = f64::from(s.sessions);
        if let Some(cores) = cores {
            ewma(&mut self.cpu_per_session, cores / n);
        }
        let used = s
            .memory
            .saturating_sub(self.baseline.unwrap_or(DEFAULT_BASELINE))
            .saturating_sub(s.replay);
        if used > 0 {
            ewma(&mut self.memory_per_session, used as f64 / n);
        }
        if let (Some(measured), true) = (self.memory_per_session, s.reserved > 0) {
            // Reservations were made at the current factor; undo it so the
            // comparison is with the raw estimates and does not chase itself.
            let estimated = s.reserved as f64 / n / self.calibration();
            ewma(
                &mut self.calibration,
                (measured / estimated).clamp(1.0, MAX_CALIBRATION),
            );
        }
    }

    /// Cores one session uses, once enough has been seen.
    #[must_use]
    pub fn cpu_per_session(&self) -> Option<f64> {
        self.cpu_per_session
    }

    /// Bytes one session uses, once enough has been seen.
    #[must_use]
    pub fn memory_per_session(&self) -> Option<f64> {
        self.memory_per_session
    }

    /// Factor applied to admission estimates; 1 until sessions cost more.
    #[must_use]
    pub fn calibration(&self) -> f64 {
        self.calibration.unwrap_or(1.0)
    }
}

static MODEL: LazyLock<Mutex<Model>> = LazyLock::new(Mutex::default);
static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

/// The current per-session model.
#[must_use]
pub fn model() -> Model {
    MODEL.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// `estimate` scaled by what sessions have been measured to cost.
#[must_use]
pub fn calibrate(estimate: u64) -> u64 {
    (estimate as f64 * model().calibration()) as u64
}

/// Read the container and fold the reading into the model.
pub fn sample() {
    let admission = crate::services::admission::stats();
    let reading = Sample {
        at_secs: EPOCH.elapsed().as_secs_f64(),
        cpu_usec: cgroup_cpu_usec().or_else(process_cpu_usec),
        memory: cgroup_anon_bytes().unwrap_or_else(process_rss),
        replay: crate::services::session_registry::replay_bytes_in_use(),
        sessions: admission.sessions,
        reserved: admission.reserved_bytes,
    };
    MODEL
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .observe(reading);
}

/// Sample every [`SAMPLE_INTERVAL`] until shutdown.
pub fn spawn_sampler(shutdown: tokio_util::sync::CancellationToken) -> tokio::task::JoinHandle<()> {
    use crate::services::worker::{spawn_periodic, PeriodicConfig};
    spawn_periodic(
        PeriodicConfig {
            label: "capacity_sampler",
            initial_delay: Duration::from_secs(5),
            interval: SAMPLE_INTERVAL,
            iteration_timeout: Duration::from_secs(10),
            error_backoff_base: Duration::from_secs(5),
        },
        shutdown,
        || async {
            tokio::task::spawn_blocking(sample)
                .await
                .map_err(|e| e.to_string())
        },
    )
}

fn stat_field(path: &str, key: &str) -> Option<u64> {
    std::fs::read_to_string(path)
        .ok()?
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(' ')?;
            (name == key).then(|| value.trim().parse().ok()).flatten()
        })
}

/// cgroup v2 `usage_usec`, else cgroup v1 `cpuacct.usage` (nanoseconds).
fn cgroup_cpu_usec() -> Option<u64> {
    stat_field("/sys/fs/cgroup/cpu.stat", "usage_usec").or_else(|| {
        std::fs::read_to_string("/sys/fs/cgroup/cpuacct/cpuacct.usage")
            .ok()?
            .trim()
            .parse::<u64>()
            .ok()
            .map(|ns| ns / 1000)
    })
}

/// cgroup v2 `anon`, else cgroup v1 `total_rss`.
fn cgroup_anon_bytes() -> Option<u64> {
    stat_field("/sys/fs/cgroup/memory.stat", "anon")
        .or_else(|| stat_field("/sys/fs/cgroup/memory/memory.stat", "total_rss"))
}

fn with_own_process<T>(read: impl FnOnce(&sysinfo::Process) -> T) -> Option<T> {
    let pid = sysinfo::get_current_pid().ok()?;
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        false,
        sysinfo::ProcessRefreshKind::nothing()
            .with_memory()
            .with_cpu(),
    );
    sys.process(pid).map(read)
}

fn process_cpu_usec() -> Option<u64> {
    with_own_process(|p| p.accumulated_cpu_time().saturating_mul(1000))
}

fn process_rss() -> u64 {
    with_own_process(sysinfo::Process::memory).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    fn reading(at: f64, cpu_secs: f64, memory_mib: u64, sessions: u32) -> Sample {
        Sample {
            at_secs: at,
            cpu_usec: Some((cpu_secs * 1_000_000.0) as u64),
            memory: memory_mib * MIB,
            replay: 0,
            sessions,
            reserved: u64::from(sessions) * 23 * MIB,
        }
    }

    #[test]
    fn production_figures_come_out_per_session() {
        let mut m = Model::default();
        m.observe(reading(0.0, 0.0, 300, 0));
        // 39 sessions using 1.6 cores and 2.25 GiB over 30 s.
        m.observe(reading(30.0, 48.0, 300 + 39 * 50, 39));
        let cpu = m.cpu_per_session().unwrap();
        assert!((cpu - 1.6 / 39.0).abs() < 1e-9, "{cpu}");
        let mem = m.memory_per_session().unwrap() / MIB as f64;
        assert!((mem - 50.0).abs() < 1e-6, "{mem}");
        // Measured 50 MB against 23 MB reserved.
        assert!((m.calibration() - 50.0 / 23.0).abs() < 1e-6);
    }

    #[test]
    fn few_sessions_leave_the_model_alone() {
        let mut m = Model::default();
        m.observe(reading(0.0, 0.0, 300, 2));
        m.observe(reading(30.0, 60.0, 900, 2));
        assert!(m.cpu_per_session().is_none());
        assert!(m.memory_per_session().is_none());
        assert_eq!(m.calibration(), 1.0);
    }

    #[test]
    fn calibration_never_shrinks_or_runs_away() {
        let mut cheap = Model::default();
        cheap.observe(reading(0.0, 0.0, 300, 0));
        cheap.observe(reading(30.0, 1.0, 300 + 10 * 5, 10));
        assert_eq!(cheap.calibration(), 1.0);

        let mut heavy = Model::default();
        heavy.observe(reading(0.0, 0.0, 300, 0));
        heavy.observe(reading(30.0, 1.0, 300 + 10 * 500, 10));
        assert_eq!(heavy.calibration(), MAX_CALIBRATION);
    }

    #[test]
    fn calibrated_reservations_do_not_pull_the_factor_back_down() {
        let mut m = Model::default();
        m.observe(reading(0.0, 0.0, 300, 0));
        m.observe(reading(30.0, 48.0, 300 + 39 * 50, 39));
        let factor = m.calibration();
        // The same sessions, now reserved at the calibrated size.
        let mut s = reading(60.0, 96.0, 300 + 39 * 50, 39);
        s.reserved = (s.reserved as f64 * factor) as u64;
        m.observe(s);
        assert!(
            (m.calibration() - factor).abs() < 1e-3,
            "{}",
            m.calibration()
        );
    }

    #[test]
    fn replay_history_is_not_charged_to_sessions() {
        let mut m = Model::default();
        m.observe(reading(0.0, 0.0, 300, 0));
        let mut s = reading(30.0, 10.0, 300 + 1024 + 10 * 20, 10);
        s.replay = 1024 * MIB;
        m.observe(s);
        let mem = m.memory_per_session().unwrap() / MIB as f64;
        assert!((mem - 20.0).abs() < 1e-6, "{mem}");
    }

    #[test]
    fn a_counter_reset_is_skipped_not_read_as_negative() {
        let mut m = Model::default();
        m.observe(reading(0.0, 100.0, 300, 10));
        m.observe(reading(30.0, 5.0, 300, 10));
        assert!(m.cpu_per_session().is_none());
    }

    #[test]
    fn the_baseline_is_the_quietest_idle_reading() {
        let mut m = Model::default();
        m.observe(reading(0.0, 0.0, 400, 0));
        m.observe(reading(30.0, 0.0, 350, 0));
        m.observe(reading(60.0, 3.0, 350 + 5 * 40, 5));
        let mem = m.memory_per_session().unwrap() / MIB as f64;
        assert!((mem - 40.0).abs() < 1e-6, "{mem}");
    }
}
