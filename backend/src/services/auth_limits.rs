//! Attempt limits for login and password change (SEC-19), kept in Postgres
//! so every backend replica counts against the same sliding windows. An
//! attempt is admitted, and recorded, before any password work starts.

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limit {
    pub name: &'static str,
    pub max: i32,
    pub window_secs: i32,
}

/// Guesses at one account from one address.
pub const LOGIN_ACCOUNT_FROM_ADDRESS: Limit = Limit {
    name: "login_account_ip",
    max: 5,
    window_secs: 60,
};
/// Guesses at one account from any address, so spreading them over many
/// addresses gains little. Wide enough that one address cannot lock a user out.
pub const LOGIN_ACCOUNT: Limit = Limit {
    name: "login_account",
    max: 30,
    window_secs: 900,
};
/// Attempts from one address, across accounts.
pub const LOGIN_ADDRESS: Limit = Limit {
    name: "login_ip",
    max: 20,
    window_secs: 300,
};
/// Password-change attempts by one signed-in user.
pub const PASSWORD_CHANGE: Limit = Limit {
    name: "password_change",
    max: 5,
    window_secs: 3600,
};

const DEFAULT_LOGIN_PER_MINUTE: i32 = 600;

/// Every local login attempt on the deployment, per minute.
/// `STRATA_LOGIN_ATTEMPTS_PER_MINUTE` overrides the default of 600.
pub fn login_overall() -> Limit {
    let max = std::env::var("STRATA_LOGIN_ATTEMPTS_PER_MINUTE")
        .ok()
        .and_then(|v| v.trim().parse::<i32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_LOGIN_PER_MINUTE);
    Limit {
        name: "login_all",
        max,
        window_secs: 60,
    }
}

/// Attempts admitted by [`reserve`], one per limit.
#[derive(Debug, Default)]
pub struct Reservation {
    ids: Vec<i64>,
}

fn bucket(limit: Limit, key: &str) -> String {
    format!("{}:{}", limit.name, key)
}

/// Admit one attempt under every `(limit, key)` in turn. The first limit
/// that is full refuses the request with its retry delay, and the attempts
/// already admitted for it are given back.
pub async fn reserve(
    pool: &sqlx::PgPool,
    checks: &[(Limit, &str)],
    message: &str,
) -> Result<Reservation, AppError> {
    let mut reservation = Reservation::default();
    for (limit, key) in checks {
        let (id, retry_after): (Option<i64>, i32) = sqlx::query_as(
            "SELECT attempt_id, retry_after_secs FROM auth_attempt_reserve($1, $2, $3)",
        )
        .bind(bucket(*limit, key))
        .bind(limit.max)
        .bind(limit.window_secs)
        .fetch_one(pool)
        .await?;
        match id {
            Some(id) => reservation.ids.push(id),
            None => {
                release(pool, reservation).await;
                return Err(AppError::TooManyAttempts {
                    message: message.to_owned(),
                    retry_after_secs: u32::try_from(retry_after).unwrap_or(1).max(1),
                });
            }
        }
    }
    Ok(reservation)
}

/// Give the attempts back, as if they had not been made.
pub async fn release(pool: &sqlx::PgPool, reservation: Reservation) {
    if reservation.ids.is_empty() {
        return;
    }
    if let Err(e) = sqlx::query("DELETE FROM auth_attempts WHERE id = ANY($1)")
        .bind(&reservation.ids)
        .execute(pool)
        .await
    {
        tracing::warn!("could not release auth attempts: {e}");
    }
}

/// Forget every attempt counted under `limit` for `key`.
pub async fn clear(pool: &sqlx::PgPool, limit: Limit, key: &str) {
    if let Err(e) = sqlx::query("DELETE FROM auth_attempts WHERE bucket = $1")
        .bind(bucket(limit, key))
        .execute(pool)
        .await
    {
        tracing::warn!("could not clear auth attempts: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> Option<sqlx::PgPool> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(16)
            .connect_lazy(&url)
            .ok()
    }

    fn unique(name: &'static str, max: i32, window_secs: i32) -> (Limit, String) {
        (
            Limit {
                name,
                max,
                window_secs,
            },
            uuid::Uuid::new_v4().to_string(),
        )
    }

    #[test]
    fn the_overall_budget_reads_its_override() {
        std::env::remove_var("STRATA_LOGIN_ATTEMPTS_PER_MINUTE");
        assert_eq!(login_overall().max, DEFAULT_LOGIN_PER_MINUTE);
        std::env::set_var("STRATA_LOGIN_ATTEMPTS_PER_MINUTE", "0");
        assert_eq!(login_overall().max, DEFAULT_LOGIN_PER_MINUTE);
        std::env::set_var("STRATA_LOGIN_ATTEMPTS_PER_MINUTE", "50");
        assert_eq!(login_overall().max, 50);
        std::env::remove_var("STRATA_LOGIN_ATTEMPTS_PER_MINUTE");
    }

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_attempts_never_exceed_the_limit() {
        let Some(pool) = pool() else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let (limit, key) = unique("test_burst", 5, 60);
        let tasks: Vec<_> = (0..40)
            .map(|_| {
                let (pool, key) = (pool.clone(), key.clone());
                tokio::spawn(async move { reserve(&pool, &[(limit, &key)], "busy").await })
            })
            .collect();
        let mut admitted = 0;
        let mut retry = 0;
        for t in tasks {
            match t.await.unwrap() {
                Ok(_) => admitted += 1,
                Err(AppError::TooManyAttempts {
                    retry_after_secs, ..
                }) => retry = retry.max(retry_after_secs),
                Err(e) => panic!("unexpected {e:?}"),
            }
        }
        assert_eq!(admitted, 5);
        assert!((1..=60).contains(&retry), "retry after {retry}s");
        clear(&pool, limit, &key).await;
    }

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database.
    #[tokio::test]
    async fn a_refusal_gives_back_what_earlier_limits_admitted() {
        let Some(pool) = pool() else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let (wide, wide_key) = unique("test_wide", 10, 60);
        let (narrow, narrow_key) = unique("test_narrow", 1, 60);
        let checks = [(wide, wide_key.as_str()), (narrow, narrow_key.as_str())];
        reserve(&pool, &checks, "busy").await.unwrap();
        for _ in 0..3 {
            assert!(reserve(&pool, &checks, "busy").await.is_err());
        }
        let (counted,): (i64,) =
            sqlx::query_as("SELECT count(*) FROM auth_attempts WHERE bucket = $1")
                .bind(bucket(wide, &wide_key))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(counted, 1);
        clear(&pool, wide, &wide_key).await;
        clear(&pool, narrow, &narrow_key).await;
    }

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database.
    #[tokio::test]
    async fn released_and_cleared_attempts_no_longer_count() {
        let Some(pool) = pool() else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let (limit, key) = unique("test_release", 1, 60);
        let first = reserve(&pool, &[(limit, &key)], "busy").await.unwrap();
        assert!(reserve(&pool, &[(limit, &key)], "busy").await.is_err());
        release(&pool, first).await;
        reserve(&pool, &[(limit, &key)], "busy").await.unwrap();
        clear(&pool, limit, &key).await;
        reserve(&pool, &[(limit, &key)], "busy").await.unwrap();
        clear(&pool, limit, &key).await;
    }

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database.
    #[tokio::test]
    async fn a_window_frees_up_as_attempts_age_out() {
        let Some(pool) = pool() else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let (limit, key) = unique("test_window", 1, 1);
        reserve(&pool, &[(limit, &key)], "busy").await.unwrap();
        match reserve(&pool, &[(limit, &key)], "busy").await {
            Err(AppError::TooManyAttempts {
                retry_after_secs, ..
            }) => assert_eq!(retry_after_secs, 1),
            other => panic!("expected a refusal, got {other:?}"),
        }
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        reserve(&pool, &[(limit, &key)], "busy").await.unwrap();
        clear(&pool, limit, &key).await;
    }
}
