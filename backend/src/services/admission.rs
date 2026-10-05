// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Session admission (PERF-04).
//!
//! Before a session touches its target (credential checkout, VDI
//! container, browser, network connection) it reserves an estimate of the
//! memory it will use against a process-wide budget, and counts against
//! its user's concurrent-session limit. Both are released when the
//! [`Reservation`] is dropped at the end of the session. A request that
//! would exceed either is refused cleanly instead of pushing the process
//! towards its container memory limit.
//!
//! The budget defaults to three quarters of the container (cgroup) memory
//! limit, or of system memory without one, less the session replay
//! budget, which bounds itself. `STRATA_SESSION_MEMORY_BUDGET_MB`
//! overrides it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use uuid::Uuid;

use crate::error::AppError;

const MIB: u64 = 1024 * 1024;

/// Per-session overhead of the engine, codecs and channels.
const SESSION_OVERHEAD: u64 = 8 * MIB;

/// A text protocol (SSH, Telnet, Kubernetes) needs little beyond its
/// terminal buffer.
const TERMINAL_SESSION: u64 = 4 * MIB;

/// A web session runs a whole Chromium in this process's container.
const BROWSER_SESSION: u64 = 384 * MIB;

/// Largest display an estimate allows for (8K).
const MAX_PIXELS: u64 = 7680 * 4320;

/// Session-wide numbers for the metrics endpoint.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct AdmissionStats {
    pub reserved_bytes: u64,
    pub limit_bytes: u64,
    pub rejected: u64,
    /// Sessions currently holding a reservation.
    pub sessions: u32,
}

struct Ledger {
    limit: u64,
    reserved: AtomicU64,
    rejected: AtomicU64,
    per_user: Mutex<HashMap<Uuid, u32>>,
}

static LEDGER: LazyLock<Ledger> = LazyLock::new(|| Ledger::new(default_limit()));

impl Ledger {
    fn new(limit: u64) -> Self {
        Self {
            limit,
            reserved: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            per_user: Mutex::new(HashMap::new()),
        }
    }

    fn admit(
        &'static self,
        user: Uuid,
        user_limit: Option<u32>,
        bytes: u64,
    ) -> Result<Reservation, AppError> {
        let mut per_user = self.per_user.lock().unwrap_or_else(|e| e.into_inner());
        let held = per_user.get(&user).copied().unwrap_or(0);
        if let Some(limit) = user_limit {
            if held >= limit {
                self.rejected.fetch_add(1, Ordering::Relaxed);
                return Err(AppError::RateLimited(format!(
                    "You already have {held} open session(s), the most your role allows. \
                     Close one and try again."
                )));
            }
        }
        let fits = self
            .reserved
            .try_update(Ordering::AcqRel, Ordering::Acquire, |r| {
                (r + bytes <= self.limit).then_some(r + bytes)
            })
            .is_ok();
        if !fits {
            self.rejected.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                reserved_mb = self.reserved.load(Ordering::Relaxed) / MIB,
                limit_mb = self.limit / MIB,
                request_mb = bytes / MIB,
                "session refused: memory budget exhausted"
            );
            return Err(AppError::RateLimited(
                "The server is at capacity. Try again in a few minutes.".into(),
            ));
        }
        per_user.insert(user, held + 1);
        Ok(Reservation {
            ledger: self,
            user,
            bytes,
        })
    }

    fn release(&self, user: Uuid, bytes: u64) {
        self.reserved.fetch_sub(bytes, Ordering::AcqRel);
        let mut per_user = self.per_user.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(held) = per_user.get_mut(&user) {
            *held -= 1;
            if *held == 0 {
                per_user.remove(&user);
            }
        }
    }

    fn stats(&self) -> AdmissionStats {
        let per_user = self.per_user.lock().unwrap_or_else(|e| e.into_inner());
        AdmissionStats {
            reserved_bytes: self.reserved.load(Ordering::Relaxed),
            limit_bytes: self.limit,
            rejected: self.rejected.load(Ordering::Relaxed),
            sessions: per_user.values().sum(),
        }
    }
}

/// A session's place in the budget; released on drop.
#[must_use = "dropping the reservation ends the session's admission"]
pub struct Reservation {
    ledger: &'static Ledger,
    user: Uuid,
    bytes: u64,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.ledger.release(self.user, self.bytes);
    }
}

/// Estimated memory for a session of `protocol` at the requested size.
#[must_use]
pub fn estimate(protocol: &str, width: Option<u32>, height: Option<u32>) -> u64 {
    let pixels = u64::from(width.unwrap_or(1920).max(1)) * u64::from(height.unwrap_or(1080).max(1));
    // Front and back framebuffers at four bytes a pixel.
    let framebuffer = pixels.min(MAX_PIXELS) * 4 * 2;
    match protocol {
        "ssh" | "telnet" | "kubernetes" => TERMINAL_SESSION,
        "web" => BROWSER_SESSION + framebuffer,
        _ => SESSION_OVERHEAD + framebuffer,
    }
}

/// Reserve room for one session of `user`, whose role allows at most
/// `user_limit` at once (`None` for no limit).
pub fn admit(user: Uuid, user_limit: Option<u32>, bytes: u64) -> Result<Reservation, AppError> {
    LEDGER.admit(user, user_limit, bytes)
}

#[must_use]
pub fn stats() -> AdmissionStats {
    LEDGER.stats()
}

/// The role limit, or `STRATA_MAX_SESSIONS_PER_USER` when the role has
/// none (unset or 0 means no limit).
#[must_use]
pub fn user_limit(role_limit: Option<i32>) -> Option<u32> {
    role_limit
        .and_then(|n| u32::try_from(n).ok())
        .or_else(|| {
            std::env::var("STRATA_MAX_SESSIONS_PER_USER")
                .ok()
                .and_then(|v| v.trim().parse().ok())
        })
        .filter(|n| *n > 0)
}

fn default_limit() -> u64 {
    if let Some(mb) = std::env::var("STRATA_SESSION_MEMORY_BUDGET_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|mb| *mb > 0)
    {
        return mb * MIB;
    }
    let total = cgroup_limit().unwrap_or_else(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.total_memory()
    });
    let nvr = std::env::var("STRATA_NVR_MEMORY_BUDGET_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(1024)
        * MIB;
    (total / 4 * 3).saturating_sub(nvr).max(256 * MIB)
}

/// The container's memory limit, from cgroup v2 or v1.
fn cgroup_limit() -> Option<u64> {
    [
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ]
    .iter()
    .find_map(|path| std::fs::read_to_string(path).ok())
    .and_then(|raw| raw.trim().parse::<u64>().ok())
    // cgroup v1 reports "no limit" as a huge sentinel.
    .filter(|limit| *limit < (1 << 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger(limit_mb: u64) -> &'static Ledger {
        Box::leak(Box::new(Ledger::new(limit_mb * MIB)))
    }

    #[test]
    fn estimates_follow_protocol_and_display_size() {
        assert_eq!(estimate("ssh", Some(1920), Some(1080)), TERMINAL_SESSION);
        let hd = estimate("rdp", Some(1920), Some(1080));
        assert_eq!(hd, SESSION_OVERHEAD + 1920 * 1080 * 8);
        assert!(estimate("rdp", Some(3840), Some(2160)) > hd);
        assert!(estimate("web", None, None) > BROWSER_SESSION);
        // An absurd size is clamped rather than reserving the world.
        assert_eq!(
            estimate("vnc", Some(u32::MAX), Some(u32::MAX)),
            SESSION_OVERHEAD + MAX_PIXELS * 8
        );
    }

    #[test]
    fn the_budget_refuses_what_does_not_fit_and_frees_on_drop() {
        let ledger = ledger(100);
        let user = Uuid::new_v4();
        let a = ledger.admit(user, None, 60 * MIB).unwrap();
        assert!(ledger.admit(Uuid::new_v4(), None, 60 * MIB).is_err());
        assert_eq!(ledger.stats().rejected, 1);
        assert_eq!(ledger.stats().sessions, 1);
        drop(a);
        assert_eq!(ledger.stats().reserved_bytes, 0);
        assert_eq!(ledger.stats().sessions, 0);
        let _b = ledger.admit(user, None, 60 * MIB).unwrap();
    }

    #[test]
    fn a_user_is_held_to_their_limit() {
        let ledger = ledger(1000);
        let user = Uuid::new_v4();
        let first = ledger.admit(user, Some(2), MIB).unwrap();
        let _second = ledger.admit(user, Some(2), MIB).unwrap();
        assert!(ledger.admit(user, Some(2), MIB).is_err());
        // Someone else is unaffected.
        let _other = ledger.admit(Uuid::new_v4(), Some(2), MIB).unwrap();
        drop(first);
        let _third = ledger.admit(user, Some(2), MIB).unwrap();
    }

    #[test]
    fn a_role_limit_overrides_the_default_and_zero_means_none() {
        assert_eq!(user_limit(Some(3)), Some(3));
        assert_eq!(user_limit(Some(0)), None);
    }
}
