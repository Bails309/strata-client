// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Per-key async locks for cache single-flight (PERF-14).
//!
//! Callers that miss a cache for the same key queue behind the first, which
//! fetches while the rest wait; after acquiring the lock each caller rechecks
//! the cache. No global lock is held across the fetch, so unrelated keys
//! never wait on each other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

#[derive(Default)]
pub struct KeyedLocks {
    locks: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}

impl KeyedLocks {
    /// The lock shared by every current caller for `key`.
    pub fn get(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, weak| weak.strong_count() > 0);
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(key.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callers_for_one_key_share_a_lock() {
        let locks = KeyedLocks::default();
        let a = locks.get("k");
        let b = locks.get("k");
        assert!(Arc::ptr_eq(&a, &b));
        assert!(!Arc::ptr_eq(&a, &locks.get("other")));
    }

    #[test]
    fn idle_keys_are_forgotten() {
        let locks = KeyedLocks::default();
        drop(locks.get("a"));
        let _b = locks.get("b");
        assert_eq!(locks.locks.lock().unwrap().len(), 1);
    }
}
