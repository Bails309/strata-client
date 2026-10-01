//! Centralised password-hashing parameters.
//!
//! All new password hashes are produced with explicit Argon2id parameters
//! that are pinned in source so a future change to the `argon2` crate's
//! `Default` implementation can't silently weaken the hashes we write to
//! the database. Verification (`Argon2::default().verify_password(...)`)
//! is unaffected: the PHC string carries its own params and is portable
//! across implementations.
//!
//! Targets the OWASP "Argon2id minimum" recommendation (m=64 MiB, t=3,
//! p=4). If you raise these, existing hashes still verify — only newly
//! produced hashes use the higher cost.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use argon2::password_hash::SaltString;
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use tokio::sync::Semaphore;

use crate::error::AppError;

/// Memory cost in KiB (64 MiB).
const M_COST_KIB: u32 = 64 * 1024;
/// Time cost (iterations).
const T_COST: u32 = 3;
/// Parallelism / lanes.
const P_COST: u32 = 4;

/// Build an [`Argon2`] hasher with the project's pinned Argon2id params.
/// Use this for every `hash_password(...)` call site. Verification can
/// continue to use `Argon2::default()` because params are encoded in the
/// PHC string.
pub fn pinned_argon2() -> Argon2<'static> {
    let params = Params::new(M_COST_KIB, T_COST, P_COST, None)
        .expect("pinned Argon2 params are valid by construction");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

// ── Bounded execution (PERF-01) ─────────────────────────────────────
//
// Each hash takes ~64 MiB and tens of milliseconds of CPU, so it runs on
// the blocking pool behind a small semaphore instead of on a request worker.

/// How long a request may wait for a hashing slot before it is turned away.
const QUEUE_WAIT: Duration = Duration::from_secs(10);

static SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(slots())));

/// Concurrent hashes: `STRATA_PASSWORD_HASH_CONCURRENCY`, else one per CPU up to 4.
fn slots() -> usize {
    std::env::var("STRATA_PASSWORD_HASH_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n: &usize| *n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map_or(1, |n| n.get())
                .min(4)
        })
}

/// Hash of a throwaway password with the production parameters, so an
/// unknown username costs the same as a wrong password.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    let salt = SaltString::from_b64("c29tZXNhbHRzb21lc2FsdA").expect("valid static salt");
    pinned_argon2()
        .hash_password(b"dummy-password-for-timing-equalisation", &salt)
        .expect("argon2 hash")
        .to_string()
});

async fn run<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> Result<T, AppError> {
    let permit = tokio::time::timeout(QUEUE_WAIT, Arc::clone(&SLOTS).acquire_owned())
        .await
        .map_err(|_| AppError::RateLimited("The server is busy. Please try again.".into()))?
        .map_err(|_| AppError::Internal("password hashing unavailable".into()))?;
    // The permit moves into the task: a cancelled request must not free a
    // slot while its hash is still running.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        job()
    })
    .await
    .map_err(|e| AppError::Internal(format!("password hashing failed: {e}")))
}

/// Hash a new password with the pinned parameters.
pub async fn hash(password: String) -> Result<String, AppError> {
    run(move || {
        let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
        pinned_argon2()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| AppError::Internal(format!("Argon2 error: {e}")))
    })
    .await?
}

/// Whether `password` matches the stored PHC string. An unparsable hash
/// is a mismatch.
pub async fn verify(password: String, stored: String) -> Result<bool, AppError> {
    run(move || {
        PasswordHash::new(&stored).is_ok_and(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
    })
    .await
}

/// Spend the same effort as [`verify`] against an account that does not exist.
pub async fn verify_dummy(password: String) -> Result<(), AppError> {
    verify(password, DUMMY_HASH.clone()).await.map(|_| ())
}

/// Compute the dummy hash at startup rather than on the first unknown login.
pub async fn warm_up() {
    let _ = tokio::task::spawn_blocking(|| LazyLock::force(&DUMMY_HASH)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_hash_verifies_its_own_password_only() {
        let stored = hash("correct horse".into()).await.unwrap();
        assert!(verify("correct horse".into(), stored.clone()).await.unwrap());
        assert!(!verify("wrong".into(), stored).await.unwrap());
    }

    #[tokio::test]
    async fn an_unparsable_hash_never_matches() {
        assert!(!verify("x".into(), "not-a-hash".into()).await.unwrap());
    }

    #[test]
    fn the_dummy_hash_costs_the_same_as_a_real_one() {
        let parsed = PasswordHash::new(&DUMMY_HASH).unwrap();
        let real = pinned_argon2();
        assert_eq!(parsed.algorithm, argon2::Algorithm::Argon2id.ident());
        assert_eq!(
            parsed.params.get_decimal("m"),
            Some(real.params().m_cost())
        );
        assert_eq!(parsed.params.get_decimal("t"), Some(real.params().t_cost()));
        assert_eq!(parsed.params.get_decimal("p"), Some(real.params().p_cost()));
    }
}
