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

use argon2::{Algorithm, Argon2, Params, Version};

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
