// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Round-robin pool of guacd instances.
//!
//! When multiple guacd instances are configured (via `guacd_instances` in
//! config or `GUACD_INSTANCES` env), the pool distributes new tunnel
//! connections across them using a simple atomic counter.

use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone)]
pub struct GuacdPool {
    instances: Vec<(String, u16)>,
    counter: std::sync::Arc<AtomicUsize>,
}

impl GuacdPool {
    /// Build the pool from primary + additional instances.
    pub fn new(primary_host: &str, primary_port: u16, extras: &[String]) -> Self {
        let mut instances = vec![(primary_host.to_string(), primary_port)];

        for entry in extras {
            let parts: Vec<&str> = entry.splitn(2, ':').collect();
            let host = parts[0].to_string();
            let port = parts.get(1)
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(4822);
            instances.push((host, port));
        }

        Self {
            instances,
            counter: std::sync::Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Pick the next guacd instance (round-robin).
    pub fn next(&self) -> (&str, u16) {
        let idx = self.counter.fetch_add(1, Ordering::Relaxed) % self.instances.len();
        let (ref host, port) = self.instances[idx];
        (host, port)
    }

    /// Number of configured instances.
    pub fn len(&self) -> usize {
        self.instances.len()
    }
}
