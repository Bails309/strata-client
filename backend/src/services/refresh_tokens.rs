// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

//! Durable refresh-token rotation (SEC-07).
//!
//! Every refresh token issued has a row here, grouped into a family that
//! starts at sign-in. Rotation consumes the presented token and records its
//! successor in one transaction, so of two requests racing with the same
//! token exactly one succeeds. Presenting a token that was consumed earlier
//! is treated as theft and revokes its whole family.

use chrono::{DateTime, Utc};
use sqlx::{Pool, Postgres};
use uuid::Uuid;

use crate::error::AppError;

/// A token consumed this recently was most likely spent by another tab of
/// the same browser, not replayed by an attacker.
const CONCURRENT_GRACE_SECS: f64 = 30.0;

/// The successor to record when a token is rotated.
pub struct Successor {
    pub jti: Uuid,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Rotation {
    Rotated,
    /// Spent moments ago, probably by a parallel request from the same browser.
    Concurrent,
    /// Spent long ago, or revoked: the family is now revoked.
    Reused,
    /// No record of this token.
    Unknown,
}

/// Record a token that starts a new family, at sign-in.
pub async fn record_new(
    pool: &Pool<Postgres>,
    jti: Uuid,
    family_id: Uuid,
    user_id: Uuid,
    expires_at: DateTime<Utc>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO refresh_tokens (jti, family_id, user_id, expires_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(jti)
    .bind(family_id)
    .bind(user_id)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Consume `jti` and record `next` in the same family, atomically.
///
/// `family_id` is the family named in the token. A token minted before this
/// table existed carries none and has no row; it is adopted into a new family
/// the first time it is presented, which a conflicting insert still makes a
/// one-time event.
pub async fn rotate(
    pool: &Pool<Postgres>,
    jti: Uuid,
    user_id: Uuid,
    family_id: Option<Uuid>,
    old_expires_at: DateTime<Utc>,
    next: &Successor,
) -> Result<Rotation, AppError> {
    let mut tx = pool.begin().await?;

    let mut consumed: Option<Uuid> = sqlx::query_scalar(
        "UPDATE refresh_tokens SET consumed_at = now()
         WHERE jti = $1 AND user_id = $2
           AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         RETURNING family_id",
    )
    .bind(jti)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;

    if consumed.is_none() && family_id.is_none() {
        consumed = sqlx::query_scalar(
            "INSERT INTO refresh_tokens (jti, family_id, user_id, expires_at, consumed_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (jti) DO NOTHING
             RETURNING family_id",
        )
        .bind(jti)
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(old_expires_at)
        .fetch_optional(&mut *tx)
        .await?;
    }

    if let Some(family) = consumed {
        sqlx::query(
            "INSERT INTO refresh_tokens (jti, family_id, user_id, expires_at)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(next.jti)
        .bind(family)
        .bind(user_id)
        .bind(next.expires_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Rotation::Rotated);
    }

    let row: Option<(Uuid, Option<f64>, bool)> = sqlx::query_as(
        "SELECT family_id,
                EXTRACT(EPOCH FROM now() - consumed_at)::float8,
                revoked_at IS NOT NULL
         FROM refresh_tokens WHERE jti = $1 AND user_id = $2",
    )
    .bind(jti)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((family, consumed_secs_ago, revoked)) = row else {
        return Ok(Rotation::Unknown);
    };
    let outcome = classify(consumed_secs_ago, revoked);
    if outcome == Rotation::Reused {
        revoke_family_in(&mut tx, family).await?;
        tx.commit().await?;
    }
    Ok(outcome)
}

/// How to treat a token that could not be consumed.
fn classify(consumed_secs_ago: Option<f64>, revoked: bool) -> Rotation {
    match consumed_secs_ago {
        Some(age) if !revoked && age < CONCURRENT_GRACE_SECS => Rotation::Concurrent,
        Some(_) => Rotation::Reused,
        // Unconsumed yet not consumable: revoked or expired.
        None => Rotation::Reused,
    }
}

async fn revoke_family_in(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    family_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now()
         WHERE family_id = $1 AND revoked_at IS NULL",
    )
    .bind(family_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Revoke the family `jti` belongs to, at sign-out.
pub async fn revoke_family_of(pool: &Pool<Postgres>, jti: Uuid) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now()
         WHERE revoked_at IS NULL
           AND family_id = (SELECT family_id FROM refresh_tokens WHERE jti = $1)",
    )
    .bind(jti)
    .execute(pool)
    .await?;
    Ok(())
}

/// Drop rows whose tokens can no longer be presented.
pub async fn prune_expired(pool: &Pool<Postgres>) -> Result<u64, AppError> {
    let done =
        sqlx::query("DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'")
            .execute(pool)
            .await?;
    Ok(done.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_spent_moments_ago_is_a_parallel_refresh() {
        assert_eq!(classify(Some(2.0), false), Rotation::Concurrent);
    }

    #[test]
    fn a_token_spent_long_ago_is_a_replay() {
        assert_eq!(
            classify(Some(CONCURRENT_GRACE_SECS + 1.0), false),
            Rotation::Reused
        );
    }

    #[test]
    fn a_revoked_token_is_never_a_parallel_refresh() {
        assert_eq!(classify(Some(1.0), true), Rotation::Reused);
        assert_eq!(classify(None, true), Rotation::Reused);
    }
}
