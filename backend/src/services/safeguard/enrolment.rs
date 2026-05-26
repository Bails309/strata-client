//! Safeguard sign-in enrolment codes.
//!
//! Bridges the user's PowerShell-side `Connect-Safeguard -Browser`
//! flow back to Strata without making the operator copy a 1 KB JWT
//! out of the terminal. The flow is:
//!
//!   1. UI: user clicks **Sign in**.
//!   2. Backend [`mint`]s a single-use code (5-minute TTL, scoped to
//!      the requesting `user_id`), embeds it in the rendered PS
//!      snippet, returns it to the UI.
//!   3. PS snippet: `Connect-Safeguard -Browser` produces `$SGToken`,
//!      then `Invoke-RestMethod` POSTs `{ code, token }` to
//!      `/api/safeguard/enrol`.
//!   4. Backend [`consume`]s the code (validates it exists, isn't
//!      already used, isn't expired; atomically flips it to used and
//!      returns the bound `user_id`), then seals the token via the
//!      existing Vault envelope path and writes to
//!      `safeguard_user_tokens` exactly as the manual paste endpoint
//!      does.
//!
//! The code is the only thing that authenticates the unauthenticated
//! `POST /api/safeguard/enrol` call — so it is:
//!   - generated from `getrandom`, 8 chars of crockford-base32 (~40
//!     bits, ~1e12 search space) inside a 5-minute window;
//!   - single-use (the `used_at` UPDATE-and-fetch is atomic);
//!   - rate-limited per user at the route layer (5 mints/min).

use crate::error::AppError;
use chrono::{DateTime, Duration, Utc};
use rand::RngExt;
use sqlx::PgPool;
use uuid::Uuid;

/// How long a freshly-minted code is valid for before the user has to
/// click **Sign in** again. Five minutes is plenty for a federated
/// browser sign-in even when the IdP throws in MFA.
pub const CODE_TTL_SECONDS: i64 = 5 * 60;

/// Cap concurrent mints per user: more than this in any one-minute
/// window almost certainly indicates someone hammering Sign in /
/// scripting against the endpoint. Enforced at the route layer.
pub const MAX_MINTS_PER_MINUTE: i64 = 5;

/// Char set used for code generation. Crockford base32 minus the
/// visually-ambiguous I/L/O/U — operators read these out loud over
/// helpdesk calls so legibility matters.
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";

/// What [`mint`] returns: the code itself and when it expires.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EnrolmentCode {
    pub code: String,
    pub expires_at: DateTime<Utc>,
}

/// Generate an 8-char code from `getrandom` and store it. The code is
/// formatted with a dash (`XXXX-XXXX`) for human readability — when
/// stored / submitted we accept both with and without the dash so the
/// user can't typo themselves into a mismatch.
pub async fn mint(
    pool: &PgPool,
    user_id: Uuid,
    created_ip: Option<&str>,
) -> Result<EnrolmentCode, AppError> {
    // Best-effort rate limit: cap mints per user per minute.
    let recent: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM safeguard_enrolment_codes
            WHERE user_id = $1 AND created_at > now() - interval '1 minute'",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if recent.0 >= MAX_MINTS_PER_MINUTE {
        return Err(AppError::Validation(
            "Too many sign-in attempts. Wait a minute and try again.".into(),
        ));
    }

    let raw = generate_raw();
    let canonical = canonicalize(&raw);
    let pretty = format!("{}-{}", &raw[..4], &raw[4..]);
    let expires_at = Utc::now() + Duration::seconds(CODE_TTL_SECONDS);

    sqlx::query(
        "INSERT INTO safeguard_enrolment_codes
            (code, user_id, expires_at, created_at, created_ip)
         VALUES ($1, $2, $3, now(), $4)",
    )
    .bind(&canonical)
    .bind(user_id)
    .bind(expires_at)
    .bind(created_ip)
    .execute(pool)
    .await?;

    Ok(EnrolmentCode {
        code: pretty,
        expires_at,
    })
}

/// Atomically validate and consume a code. Returns the bound
/// `user_id` on success; an `AppError::Validation` ("Invalid or
/// expired sign-in code.") in every failure path so the caller can't
/// distinguish unknown-code from already-used from expired (denies an
/// attacker an oracle).
pub async fn consume(pool: &PgPool, submitted: &str) -> Result<Uuid, AppError> {
    let canonical = canonicalize(submitted);
    if canonical.len() != 8 || !canonical.bytes().all(|b| ALPHABET.contains(&b)) {
        return Err(AppError::Validation(
            "Invalid or expired sign-in code.".into(),
        ));
    }

    let row: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE safeguard_enrolment_codes
            SET used_at = now()
          WHERE code = $1
            AND used_at IS NULL
            AND expires_at > now()
          RETURNING user_id",
    )
    .bind(&canonical)
    .fetch_optional(pool)
    .await?;

    row.map(|(uid,)| uid).ok_or_else(|| {
        AppError::Validation("Invalid or expired sign-in code.".into())
    })
}

/// Delete codes whose TTL has long elapsed. Called from the existing
/// daily cleanup worker so the table doesn't accumulate unbounded
/// rows. Tolerant of repeated invocation.
pub async fn purge_expired(pool: &PgPool) -> Result<u64, AppError> {
    let res = sqlx::query(
        "DELETE FROM safeguard_enrolment_codes
          WHERE expires_at < now() - interval '1 day'",
    )
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Strip the user-visible dash and upper-case so `mn3p-q7r2` and
/// `MN3PQ7R2` resolve to the same row.
fn canonicalize(input: &str) -> String {
    input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// 8 chars of cryptographic randomness mapped to [`ALPHABET`].
fn generate_raw() -> String {
    // 8 bytes is plenty of entropy for an 8-char draw; we discard the
    // high bits via modulo. Bias against the last char of ALPHABET is
    // negligible (256 mod 30 = 16 -> max 1.07x bias on a 1-in-30 slot;
    // for a one-shot 5-min code this is fine).
    let buf: [u8; 8] = rand::rng().random();
    buf.iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_strips_dashes_and_uppercases() {
        assert_eq!(canonicalize("mn3p-q7r2"), "MN3PQ7R2");
        assert_eq!(canonicalize("MN3P-Q7R2"), "MN3PQ7R2");
        assert_eq!(canonicalize("  mn3pq7r2  "), "MN3PQ7R2");
    }

    #[test]
    fn generated_code_is_in_alphabet() {
        for _ in 0..1000 {
            let raw = generate_raw();
            assert_eq!(raw.len(), 8);
            for b in raw.bytes() {
                assert!(ALPHABET.contains(&b), "char {b:?} not in alphabet");
            }
        }
    }
}
