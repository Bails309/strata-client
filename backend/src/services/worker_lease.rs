//! One replica at a time for a periodic job (PERF-09). A pass claims the
//! job's row in `worker_leases`; the claim lapses on its own if the holder
//! dies, and writes made by the pass can check they still hold it.

use sqlx::{Pool, Postgres};
use std::time::Duration;
use uuid::Uuid;

/// Claim `name` for `ttl`, unless another holder's claim is live or a pass
/// started less than `min_gap` ago (so replicas on the same schedule do the
/// work once between them, not once each).
pub async fn try_claim(
    pool: &Pool<Postgres>,
    name: &str,
    holder: Uuid,
    ttl: Duration,
    min_gap: Duration,
) -> Result<bool, sqlx::Error> {
    let claimed: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO worker_leases (name, holder, started_at, expires_at)
         VALUES ($1, $2, now(), now() + make_interval(secs => $3))
         ON CONFLICT (name) DO UPDATE
         SET holder = EXCLUDED.holder,
             started_at = EXCLUDED.started_at,
             expires_at = EXCLUDED.expires_at
         WHERE worker_leases.expires_at <= now()
           AND worker_leases.started_at <= now() - make_interval(secs => $4)
         RETURNING holder",
    )
    .bind(name)
    .bind(holder)
    .bind(ttl.as_secs_f64())
    .bind(min_gap.as_secs_f64())
    .fetch_optional(pool)
    .await?;
    Ok(claimed == Some(holder))
}

/// End the claim and record the pass as completed. The start time is kept,
/// so the gap before the next pass still counts from it.
pub async fn complete(pool: &Pool<Postgres>, name: &str, holder: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE worker_leases SET expires_at = now(), completed_at = now()
         WHERE name = $1 AND holder = $2",
    )
    .bind(name)
    .bind(holder)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_replica_wins_each_pass() {
        let Some(pool) = std::env::var("TEST_DATABASE_URL").ok().and_then(|url| {
            sqlx::postgres::PgPoolOptions::new()
                .max_connections(8)
                .connect_lazy(&url)
                .ok()
        }) else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let name = format!("test-{}", Uuid::new_v4());
        let (ttl, gap) = (Duration::from_secs(60), Duration::from_secs(3600));

        let replicas: Vec<Uuid> = (0..6).map(|_| Uuid::new_v4()).collect();
        let claims: Vec<_> = replicas
            .iter()
            .map(|r| {
                let (pool, name, r) = (pool.clone(), name.clone(), *r);
                tokio::spawn(async move { try_claim(&pool, &name, r, ttl, gap).await.unwrap() })
            })
            .collect();
        let mut winners = Vec::new();
        for (r, c) in replicas.iter().zip(claims) {
            if c.await.unwrap() {
                winners.push(*r);
            }
        }
        assert_eq!(winners.len(), 1, "exactly one replica runs the pass");
        let winner = winners[0];

        // Completed, but the gap since the pass started has not passed.
        complete(&pool, &name, winner).await.unwrap();
        let completed: Option<chrono::DateTime<chrono::Utc>> =
            sqlx::query_scalar("SELECT completed_at FROM worker_leases WHERE name = $1")
                .bind(&name)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(completed.is_some());
        assert!(!try_claim(&pool, &name, replicas[1], ttl, gap)
            .await
            .unwrap());

        // The gap has passed since that pass started.
        sqlx::query(
            "UPDATE worker_leases SET started_at = now() - interval '2 hours' WHERE name = $1",
        )
        .bind(&name)
        .execute(&pool)
        .await
        .unwrap();
        assert!(try_claim(&pool, &name, replicas[1], ttl, gap)
            .await
            .unwrap());
        // A live claim cannot be taken over, nor completed by another holder.
        assert!(!try_claim(&pool, &name, replicas[2], ttl, Duration::ZERO)
            .await
            .unwrap());
        complete(&pool, &name, replicas[2]).await.unwrap();
        let holder: Uuid = sqlx::query_scalar(
            "SELECT holder FROM worker_leases WHERE name = $1 AND expires_at > now()",
        )
        .bind(&name)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(holder, replicas[1]);

        sqlx::query("DELETE FROM worker_leases WHERE name = $1")
            .bind(&name)
            .execute(&pool)
            .await
            .unwrap();
    }
}
