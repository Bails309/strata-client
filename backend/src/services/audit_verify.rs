//! Audit chain verification and keyed checkpoints (SEC-17).
//!
//! The chain alone cannot stop someone who can write to the database from
//! editing a row and recomputing every digest after it. Checkpoints carry a
//! MAC under a key the database never holds and are also written to the log,
//! so such a rewrite fails against the last checkpoint. Rows appended since
//! that checkpoint are protected by the chain alone.

use crate::services::worker::{spawn_periodic, PeriodicConfig};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Pool, Postgres};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const BATCH: i64 = 1000;
const MAX_BREAKS: usize = 20;
const FULL_SCAN_EVERY: Duration = Duration::from_secs(24 * 3600);

/// The newest row of a verified stretch of the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub id: i64,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Break {
    /// `previous_hash` is not the digest of the row before: a row was
    /// removed, reordered or inserted out of band.
    Link(i64),
    /// The stored digest does not match the row.
    Digest(i64),
    /// A legacy-format row after the chain moved to v2, which would
    /// otherwise skip the digest check.
    Legacy(i64),
}

impl std::fmt::Display for Break {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Link(id) => write!(f, "row {id} does not follow the row before it"),
            Self::Digest(id) => write!(f, "row {id} does not match its digest"),
            Self::Legacy(id) => write!(f, "row {id} is in the legacy format after the v2 switch"),
        }
    }
}

#[derive(Debug, Default)]
pub struct Report {
    pub head: Option<Head>,
    pub rows: u64,
    pub breaks: Vec<Break>,
    /// Link breaks among legacy rows, which predate serialised writes.
    pub legacy_link_breaks: u64,
}

impl Report {
    fn push(&mut self, b: Break) {
        if self.breaks.len() < MAX_BREAKS {
            self.breaks.push(b);
        }
    }
}

/// First row hashed with the v2 encoding.
pub async fn first_v2(conn: &mut PgConnection) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT min(id) FROM audit_logs WHERE hash_version = 2")
        .fetch_one(conn)
        .await
}

/// Walk the chain after `from` (or from the start), checking every link and
/// every v2 digest. Rows from `first_v2` on must be v2.
pub async fn verify(
    conn: &mut PgConnection,
    from: Option<&Head>,
    first_v2: Option<i64>,
) -> sqlx::Result<Report> {
    let mut report = Report {
        head: from.cloned(),
        ..Report::default()
    };
    let mut expected_previous = from.map_or_else(String::new, |h| h.hash.clone());
    let mut after = from.map_or(0, |h| h.id);
    loop {
        let rows: Vec<(i64, i16, String, String, Option<bool>)> = sqlx::query_as(
            "SELECT id, hash_version, previous_hash, current_hash,
                    CASE WHEN hash_version = 2 THEN current_hash =
                        audit_hash_v2(id, created_at, user_id, action_type, details, previous_hash)
                    END
             FROM audit_logs WHERE id > $1 ORDER BY id LIMIT $2",
        )
        .bind(after)
        .bind(BATCH)
        .fetch_all(&mut *conn)
        .await?;
        let Some(last) = rows.last() else {
            break;
        };
        after = last.0;
        for (id, version, previous, current, digest_ok) in rows {
            let legacy = first_v2.is_none_or(|v2| id < v2);
            if previous != expected_previous {
                if legacy {
                    report.legacy_link_breaks += 1;
                } else {
                    report.push(Break::Link(id));
                }
            }
            match (version, digest_ok) {
                (2, Some(true)) => {}
                (1, _) if legacy => {}
                (1, _) => report.push(Break::Legacy(id)),
                _ => report.push(Break::Digest(id)),
            }
            report.rows += 1;
            expected_previous = current.clone();
            report.head = Some(Head { id, hash: current });
        }
    }
    Ok(report)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    pub head: Head,
    pub first_v2: Option<i64>,
}

pub struct CheckpointKey {
    key: Vec<u8>,
    id: String,
}

impl CheckpointKey {
    pub fn new(secret: &[u8]) -> Self {
        // Domain-separated so this never MACs with the raw JWT secret.
        let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes any key length");
        mac.update(b"strata-audit-checkpoint-key-v1");
        let key = mac.finalize().into_bytes().to_vec();
        let id = hex::encode(&Sha256::digest(&key)[..8]);
        Self { key, id }
    }

    /// `STRATA_AUDIT_CHECKPOINT_KEY`, else derived from the JWT secret.
    pub fn from_env() -> Option<Self> {
        std::env::var("STRATA_AUDIT_CHECKPOINT_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
            .or_else(|| crate::config::JWT_SECRET.get().cloned())
            .map(|s| Self::new(s.as_bytes()))
    }

    fn mac(&self, cp: &Checkpoint) -> Hmac<Sha256> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).expect("HMAC takes any key length");
        mac.update(
            format!(
                "strata-audit-checkpoint-v1\n{}\n{}\n{}",
                cp.head.id,
                cp.head.hash,
                cp.first_v2.map(|id| id.to_string()).unwrap_or_default()
            )
            .as_bytes(),
        );
        mac
    }

    pub fn sign(&self, cp: &Checkpoint) -> String {
        hex::encode(self.mac(cp).finalize().into_bytes())
    }

    pub fn verify(&self, cp: &Checkpoint, mac: &str) -> bool {
        hex::decode(mac).is_ok_and(|m| self.mac(cp).verify_slice(&m).is_ok())
    }
}

async fn latest_checkpoint(
    conn: &mut PgConnection,
    key: &CheckpointKey,
) -> sqlx::Result<Option<(Checkpoint, String)>> {
    let row: Option<(i64, String, Option<i64>, String)> = sqlx::query_as(
        "SELECT last_id, last_hash, first_v2_id, mac FROM audit_checkpoints
         WHERE key_id = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(&key.id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(id, hash, first_v2, mac)| {
        (
            Checkpoint {
                head: Head { id, hash },
                first_v2,
            },
            mac,
        )
    }))
}

/// Problems with a stored checkpoint: its MAC, the row it names, or where
/// the v2 rows begin.
pub async fn check_checkpoint(
    conn: &mut PgConnection,
    key: &CheckpointKey,
    cp: &Checkpoint,
    mac: &str,
) -> sqlx::Result<Vec<String>> {
    let id = cp.head.id;
    if !key.verify(cp, mac) {
        return Ok(vec![format!("the checkpoint at row {id} fails its MAC")]);
    }
    let mut problems = Vec::new();
    let stored: Option<String> =
        sqlx::query_scalar("SELECT current_hash FROM audit_logs WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    match stored {
        None => problems.push(format!("row {id}, the last checkpoint, is missing")),
        Some(hash) if hash != cp.head.hash => {
            problems.push(format!("row {id} no longer matches the last checkpoint"));
        }
        Some(_) => {}
    }
    if cp.first_v2.is_some() {
        let now = first_v2(conn).await?;
        if now != cp.first_v2 {
            problems.push(format!(
                "v2 rows began at {:?} at the last checkpoint and now begin at {now:?}",
                cp.first_v2
            ));
        }
    }
    Ok(problems)
}

#[derive(Default)]
struct VerifierState {
    last_full: Option<Instant>,
    /// Newest checkpoint this process has seen, to notice checkpoints
    /// being deleted.
    known_checkpoint: Option<i64>,
    alarm: Vec<String>,
}

/// Verify new rows every 10 minutes and the whole chain daily, checkpoint
/// the head when it is intact, and log and audit any break.
pub fn spawn_verifier(pool: Pool<Postgres>, shutdown: CancellationToken) -> JoinHandle<()> {
    let state = Arc::new(Mutex::new(VerifierState::default()));
    spawn_periodic(
        PeriodicConfig {
            label: "audit_verify",
            initial_delay: Duration::from_secs(120),
            interval: Duration::from_secs(600),
            iteration_timeout: Duration::from_secs(30 * 60),
            error_backoff_base: Duration::from_secs(60),
        },
        shutdown,
        move || {
            let pool = pool.clone();
            let state = state.clone();
            async move { run(&pool, &mut *state.lock().await).await }
        },
    )
}

async fn run(pool: &Pool<Postgres>, state: &mut VerifierState) -> anyhow::Result<()> {
    let key = CheckpointKey::from_env()
        .ok_or_else(|| anyhow::anyhow!("no audit checkpoint key is available"))?;
    let mut conn = pool.acquire().await?;

    let mut problems = Vec::new();
    let mut boundary = first_v2(&mut conn).await?;
    let latest = latest_checkpoint(&mut conn, &key).await?;
    let mut start = None;
    if let Some((cp, mac)) = &latest {
        let found = check_checkpoint(&mut conn, &key, cp, mac).await?;
        if found.is_empty() {
            start = Some(cp.head.clone());
            boundary = cp.first_v2.or(boundary);
            state.known_checkpoint = state.known_checkpoint.max(Some(cp.head.id));
        }
        problems.extend(found);
    }
    if let Some(known) = state.known_checkpoint {
        if latest.as_ref().is_none_or(|(cp, _)| cp.head.id < known) {
            problems.push(format!("checkpoints up to row {known} have been removed"));
        }
    }

    let full = !problems.is_empty()
        || !state.alarm.is_empty()
        || state
            .last_full
            .is_none_or(|t| t.elapsed() >= FULL_SCAN_EVERY);
    let report = verify(
        &mut conn,
        if full { None } else { start.as_ref() },
        boundary,
    )
    .await?;
    problems.extend(report.breaks.iter().map(ToString::to_string));
    if full && report.legacy_link_breaks > 0 {
        tracing::warn!(
            count = report.legacy_link_breaks,
            "audit rows written before the v2 chain have link breaks; their contents cannot be verified"
        );
    }

    if !problems.is_empty() {
        for p in &problems {
            tracing::error!(target: "strata::audit_integrity", "audit chain: {p}");
        }
        if problems != state.alarm {
            let details = serde_json::json!({ "problems": problems });
            if let Err(e) =
                crate::services::audit::log(pool, None, "audit.integrity_failed", &details).await
            {
                tracing::error!("could not record the audit integrity failure: {e}");
            }
            state.alarm = problems;
        }
        return Ok(());
    }

    if !state.alarm.is_empty() {
        tracing::info!("audit chain verifies again");
        state.alarm.clear();
    }
    if full {
        state.last_full = Some(Instant::now());
        tracing::info!(rows = report.rows, "audit chain verified");
    }
    let Some(head) = report.head else {
        return Ok(());
    };
    if latest.as_ref().is_some_and(|(cp, _)| cp.head.id >= head.id) {
        return Ok(());
    }
    let cp = Checkpoint {
        head,
        first_v2: boundary,
    };
    let mac = key.sign(&cp);
    sqlx::query(
        "INSERT INTO audit_checkpoints (last_id, last_hash, first_v2_id, key_id, mac)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(cp.head.id)
    .bind(&cp.head.hash)
    .bind(cp.first_v2)
    .bind(&key.id)
    .bind(&mac)
    .execute(&mut *conn)
    .await?;
    // Shipped logs hold a copy of every checkpoint outside the database.
    tracing::info!(
        target: "strata::audit_checkpoint",
        last_id = cp.head.id,
        last_hash = %cp.head.hash,
        first_v2_id = ?cp.first_v2,
        key_id = %key.id,
        mac = %mac,
        "audit checkpoint"
    );
    state.known_checkpoint = Some(cp.head.id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    fn checkpoint() -> Checkpoint {
        Checkpoint {
            head: Head {
                id: 42,
                hash: "ab".repeat(32),
            },
            first_v2: Some(7),
        }
    }

    #[test]
    fn a_checkpoint_verifies_only_unchanged_under_its_key() {
        let key = CheckpointKey::new(b"a-secret-of-at-least-thirty-two-bytes");
        let cp = checkpoint();
        let mac = key.sign(&cp);
        assert!(key.verify(&cp, &mac));

        let mut moved = cp.clone();
        moved.head.id = 41;
        assert!(!key.verify(&moved, &mac));
        let mut rehashed = cp.clone();
        rehashed.head.hash = "cd".repeat(32);
        assert!(!key.verify(&rehashed, &mac));
        let mut relabelled = cp.clone();
        relabelled.first_v2 = None;
        assert!(!key.verify(&relabelled, &mac));

        let other = CheckpointKey::new(b"another-secret-of-thirty-two-bytes!!");
        assert!(!other.verify(&cp, &mac));
        assert_ne!(key.id, other.id);
        assert!(!key.verify(&cp, "not hex"));
    }

    async fn test_pool() -> Option<PgPool> {
        let url = std::env::var("TEST_DATABASE_URL").ok()?;
        PgPool::connect(&url).await.ok()
    }

    async fn head(conn: &mut PgConnection) -> Option<Head> {
        sqlx::query_as::<_, (i64, String)>(
            "SELECT id, current_hash FROM audit_logs ORDER BY id DESC LIMIT 1",
        )
        .fetch_optional(conn)
        .await
        .unwrap()
        .map(|(id, hash)| Head { id, hash })
    }

    async fn append(conn: &mut PgConnection, action: &str) -> i64 {
        sqlx::query_scalar("SELECT audit_append(gen_random_uuid(), $1, '{\"k\": \"v\"}')")
            .bind(action)
            .fetch_one(conn)
            .await
            .unwrap()
    }

    async fn exec(conn: &mut PgConnection, sql: &str, id: i64) {
        sqlx::query(sql).bind(id).execute(conn).await.unwrap();
    }

    /// Needs `TEST_DATABASE_URL` pointing at a migrated database. Each case
    /// runs in a transaction that is rolled back.
    #[tokio::test]
    async fn every_kind_of_tampering_is_detected() {
        let Some(pool) = test_pool().await else {
            eprintln!("TEST_DATABASE_URL unset, skipping");
            return;
        };
        let key = CheckpointKey::new(b"a-secret-of-at-least-thirty-two-bytes");
        let cases = [
            "none", "actor", "time", "details", "delete", "legacy", "rewrite",
        ];
        for case in cases {
            let mut tx = pool.begin().await.unwrap();
            // Chain lock before table lock, the order audit_append takes
            // them, or a concurrent append deadlocks with this.
            sqlx::query("SELECT pg_advisory_xact_lock(x'5354415544495400'::bigint)")
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("ALTER TABLE audit_logs DISABLE TRIGGER USER")
                .execute(&mut *tx)
                .await
                .unwrap();
            let start = head(&mut tx).await;
            let ids = [
                append(&mut tx, "test.a").await,
                append(&mut tx, "test.b").await,
                append(&mut tx, "test.c").await,
            ];
            let boundary = first_v2(&mut tx).await.unwrap();
            let cp = Checkpoint {
                head: head(&mut tx).await.unwrap(),
                first_v2: boundary,
            };
            let mac = key.sign(&cp);
            let mid = ids[1];

            let expected = match case {
                "none" => vec![],
                "actor" => {
                    exec(
                        &mut tx,
                        "UPDATE audit_logs SET user_id = gen_random_uuid() WHERE id = $1",
                        mid,
                    )
                    .await;
                    vec![Break::Digest(mid)]
                }
                "time" => {
                    exec(&mut tx, "UPDATE audit_logs SET created_at = created_at + interval '1 second' WHERE id = $1", mid).await;
                    vec![Break::Digest(mid)]
                }
                "details" => {
                    exec(
                        &mut tx,
                        "UPDATE audit_logs SET details = '{\"k\": \"w\"}' WHERE id = $1",
                        mid,
                    )
                    .await;
                    vec![Break::Digest(mid)]
                }
                "delete" => {
                    exec(&mut tx, "DELETE FROM audit_logs WHERE id = $1", mid).await;
                    vec![Break::Link(ids[2])]
                }
                "legacy" => {
                    let h = head(&mut tx).await.unwrap();
                    let id: i64 = sqlx::query_scalar(
                        "INSERT INTO audit_logs (action_type, previous_hash, current_hash)
                         VALUES ('test.d', $1, 'forged') RETURNING id",
                    )
                    .bind(&h.hash)
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
                    vec![Break::Legacy(id)]
                }
                "rewrite" => {
                    // Edit a row and recompute every digest after it: the
                    // chain is consistent again, so only the checkpoint
                    // can tell.
                    exec(
                        &mut tx,
                        "UPDATE audit_logs SET details = '{\"k\": \"w\"}' WHERE id = $1",
                        mid,
                    )
                    .await;
                    for id in &ids[1..] {
                        exec(
                            &mut tx,
                            "UPDATE audit_logs a SET
                                 previous_hash = p.current_hash,
                                 current_hash = audit_hash_v2(a.id, a.created_at, a.user_id,
                                     a.action_type, a.details, p.current_hash)
                             FROM audit_logs p
                             WHERE a.id = $1
                               AND p.id = (SELECT max(id) FROM audit_logs WHERE id < $1)",
                            *id,
                        )
                        .await;
                    }
                    vec![]
                }
                _ => unreachable!(),
            };

            let report = verify(&mut tx, start.as_ref(), boundary).await.unwrap();
            assert_eq!(report.breaks, expected, "case {case}");
            let checkpoint_problems = check_checkpoint(&mut tx, &key, &cp, &mac).await.unwrap();
            assert_eq!(
                !checkpoint_problems.is_empty(),
                case == "rewrite",
                "case {case}: {checkpoint_problems:?}"
            );
            tx.rollback().await.unwrap();
        }
    }
}
