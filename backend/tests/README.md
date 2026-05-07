# Backend integration tests

Integration tests live here (separate from `#[cfg(test)] mod tests {}` blocks
inside service files, which exercise pure helpers without a database).

## Why a separate directory

Cargo treats every `*.rs` file under `tests/` as its own integration-test
crate that links against `strata-backend` as if it were an external library.
That isolation is important because:

* Tests can spin up real Postgres connections and exercise full
  `routes::*` handlers end-to-end against a migrated DB.
* The crate boundary forces us to use only the public surface of
  `strata-backend`, which catches accidental coupling to private items.
* Failures here don't pollute the unit-test runner timing.

## DB-backed tests

Tests that need Postgres should:

1. Read `TEST_DATABASE_URL` from the env (CI sets this in `ci.yml` →
   `migrations-check` job style; locally use `docker compose up -d
   postgres` and export
   `TEST_DATABASE_URL=postgres://strata:strata@localhost:5432/strata`).
2. Skip themselves with `eprintln!` + early-return if the env var is
   missing — never panic, so contributors without a local DB still see
   a green `cargo test`.
3. Run inside a single transaction that is rolled back at the end so
   tests don't leak state between runs.

See `db_smoke.rs` for the canonical pattern.

## Adding a new test file

```rust
// backend/tests/<your_feature>.rs
use sqlx::PgPool;

async fn pool() -> Option<PgPool> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    PgPool::connect(&url).await.ok()
}

#[tokio::test]
async fn my_feature_round_trip() {
    let Some(pool) = pool().await else {
        eprintln!("TEST_DATABASE_URL unset, skipping");
        return;
    };
    let mut tx = pool.begin().await.unwrap();
    // ...exercise + assert...
    tx.rollback().await.unwrap();
}
```
