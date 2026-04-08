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
            let port = parts
                .get(1)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_instance_always_returns_primary() {
        let pool = GuacdPool::new("guacd", 4822, &[]);
        assert_eq!(pool.len(), 1);

        let (host, port) = pool.next();
        assert_eq!(host, "guacd");
        assert_eq!(port, 4822);
    }

    #[test]
    fn round_robin_across_instances() {
        let extras = vec!["guacd2:4823".into(), "guacd3:4824".into()];
        let pool = GuacdPool::new("guacd1", 4822, &extras);
        assert_eq!(pool.len(), 3);

        let (h1, p1) = pool.next();
        let (h2, p2) = pool.next();
        let (h3, p3) = pool.next();
        let (h4, p4) = pool.next(); // wraps around

        assert_eq!((h1, p1), ("guacd1", 4822));
        assert_eq!((h2, p2), ("guacd2", 4823));
        assert_eq!((h3, p3), ("guacd3", 4824));
        assert_eq!((h4, p4), ("guacd1", 4822)); // wrap-around
    }

    #[test]
    fn extras_without_port_default_to_4822() {
        let extras = vec!["guacd2".into()];
        let pool = GuacdPool::new("guacd1", 4822, &extras);
        assert_eq!(pool.len(), 2);

        let _ = pool.next(); // skip primary
        let (host, port) = pool.next();
        assert_eq!(host, "guacd2");
        assert_eq!(port, 4822);
    }
}
