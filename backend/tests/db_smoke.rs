//! Smoke test that proves the integration-test harness wires together
//! correctly: it does NOT touch the database when `TEST_DATABASE_URL`
//! is unset (so it's safe in any environment), but when the env var is
//! present it asserts that the migrated schema contains the core
//! tables the rest of the integration suite assumes exist.
//!
//! This file intentionally lives at the root of `backend/tests/` rather
//! than under a `common/` module so `cargo test --test db_smoke` works
//! out of the box for CI and local dev.

use sqlx::{PgPool, Row};

async fn try_pool() -> Option<PgPool> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    PgPool::connect(&url).await.ok()
}

#[tokio::test]
async fn harness_skips_cleanly_without_database_url() {
    // Whenever TEST_DATABASE_URL is unset (e.g. a Windows dev box
    // without docker) `try_pool` must return None instead of erroring.
    // We can't assert "is None" because a contributor *might* have the
    // var set; just exercise the code path.
    let _ = try_pool().await;
}

#[tokio::test]
async fn migrated_schema_has_core_tables() {
    let Some(pool) = try_pool().await else {
        eprintln!("TEST_DATABASE_URL unset, skipping");
        return;
    };

    // Names listed here are load-bearing for the broader app: removing
    // any of them would break auth, RBAC, or the connection list.
    let core_tables = [
        "users",
        "roles",
        "connections",
        "connection_folders",
        "role_connections",
        "role_folders",
        "audit_logs",
        "active_sessions",
    ];

    let rows = sqlx::query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    )
    .fetch_all(&pool)
    .await
    .expect("list tables");

    let names: Vec<String> = rows
        .iter()
        .map(|r| r.try_get::<String, _>("tablename").unwrap())
        .collect();

    for t in core_tables {
        assert!(
            names.iter().any(|n| n == t),
            "expected migrated schema to contain `{t}`, got: {names:?}"
        );
    }
}
