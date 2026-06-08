// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! In-session ingest tokens for the outbound Quick-Share pipeline.
//!
//! The user clicks **Generate upload command** in the Outbound Share
//! panel; the backend mints a single-use, 10-minute token bound to
//! the user, the originating session, the connection UUID, and an
//! optional justification. The SPA renders the token into a `curl`
//! or `Invoke-WebRequest` one-liner the user pastes inside the
//! remote session shell. The remote session POSTs the file at
//! `/api/outbound-shares/ingest/{token}` (no cookie / no CSRF — the
//! token IS the auth) and the bytes flow into the existing
//! `services::outbound_shares::submit` pipeline.
//!
//! Tokens are:
//!   - 32-char URL-safe base64 (~192 bits of entropy);
//!   - single-use (the consume UPDATE is atomic);
//!   - rate-limited per user at the route layer (10 mints/min);
//!   - reaped by the existing daily cleanup worker.

use crate::error::AppError;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use rand::RngExt;
use sqlx::PgPool;
use uuid::Uuid;

/// How long a freshly-minted token is valid for. Longer than the
/// Safeguard sign-in code (5 min) because uploads of large files can
/// run for several minutes once the user finally pastes the snippet.
pub const TOKEN_TTL_SECONDS: i64 = 10 * 60;

/// Per-user rate cap. Enforced at the route layer; the count window
/// is the trailing minute against the `created_at` column.
pub const MAX_MINTS_PER_MINUTE: i64 = 10;

/// Returned by [`mint`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct IngestToken {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

/// Returned by [`consume`] — every field the original SPA caller
/// supplied at mint time, so the unauthenticated ingest handler can
/// rebuild the audit context.
#[derive(Debug, Clone)]
pub struct IngestContext {
    pub user_id: Uuid,
    pub session_id: Option<String>,
    pub connection_id: Option<Uuid>,
    pub justification: Option<String>,
}

/// Mint a token. `session_id` / `connection_id` / `justification`
/// are taken verbatim from the SPA request and are NOT validated
/// against the user (the user is the one supplying them, so any
/// later misuse shows up against their own audit log).
pub async fn mint(
    pool: &PgPool,
    user_id: Uuid,
    session_id: Option<&str>,
    connection_id: Option<Uuid>,
    justification: Option<&str>,
    created_ip: Option<&str>,
) -> Result<IngestToken, AppError> {
    let recent: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM outbound_share_ingest_tokens
            WHERE user_id = $1 AND created_at > now() - interval '1 minute'",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if recent.0 >= MAX_MINTS_PER_MINUTE {
        return Err(AppError::Validation(
            "Too many upload tokens requested. Wait a minute and try again."
                .into(),
        ));
    }

    let token = generate_token();
    let expires_at = Utc::now() + Duration::seconds(TOKEN_TTL_SECONDS);

    sqlx::query(
        "INSERT INTO outbound_share_ingest_tokens
            (token, user_id, session_id, connection_id, justification,
             expires_at, created_at, created_ip)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7)",
    )
    .bind(&token)
    .bind(user_id)
    .bind(session_id)
    .bind(connection_id)
    .bind(justification)
    .bind(expires_at)
    .bind(created_ip)
    .execute(pool)
    .await?;

    Ok(IngestToken { token, expires_at })
}

/// Atomically validate and consume a token. Returns the bound
/// context on success; an opaque `Validation` error in every failure
/// path (unknown / used / expired) so an attacker cannot enumerate.
pub async fn consume(
    pool: &PgPool,
    submitted: &str,
    used_ip: Option<&str>,
) -> Result<IngestContext, AppError> {
    // Length-bound the input so unbounded strings can't pressure the
    // database. The generated tokens are always 43 chars (32 bytes
    // base64-url no-pad), but we accept 16..128 to leave headroom.
    if submitted.len() < 16 || submitted.len() > 128 {
        return Err(AppError::Validation(
            "Invalid or expired upload token.".into(),
        ));
    }

    let row: Option<(Uuid, Option<String>, Option<Uuid>, Option<String>)> =
        sqlx::query_as(
            "UPDATE outbound_share_ingest_tokens
                SET used_at = now(),
                    used_ip = $2
              WHERE token = $1
                AND used_at IS NULL
                AND expires_at > now()
              RETURNING user_id, session_id, connection_id, justification",
        )
        .bind(submitted)
        .bind(used_ip)
        .fetch_optional(pool)
        .await?;

    row.map(|(user_id, session_id, connection_id, justification)| IngestContext {
        user_id,
        session_id,
        connection_id,
        justification,
    })
    .ok_or_else(|| AppError::Validation("Invalid or expired upload token.".into()))
}

/// Delete tokens whose TTL has long elapsed. Wired into the
/// existing daily user_cleanup worker so the table doesn't grow
/// unbounded. Tolerant of repeated invocation.
pub async fn purge_expired(pool: &PgPool) -> Result<u64, AppError> {
    let res = sqlx::query(
        "DELETE FROM outbound_share_ingest_tokens
          WHERE expires_at < now() - interval '1 day'",
    )
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// 32 bytes of cryptographic randomness, URL-safe base64-encoded
/// without padding (43 chars). The token appears directly in the
/// URL path of the ingest endpoint so URL-safety matters.
fn generate_token() -> String {
    let buf: [u8; 32] = rand::rng().random();
    URL_SAFE_NO_PAD.encode(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_url_safe_base64_no_pad_43_chars() {
        let t = generate_token();
        assert_eq!(t.len(), 43);
        assert!(
            t.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "non URL-safe char in {t}"
        );
        assert!(!t.contains('='));
    }

    #[test]
    fn token_ttl_is_ten_minutes() {
        assert_eq!(TOKEN_TTL_SECONDS, 600);
    }
}
