# Runbook — Database Operations (Failover & Migration Rollback)

**Purpose:** Fail over to a Postgres replica and roll back a bad Strata
schema migration.

## When to use

- Primary Postgres is unresponsive or data-corrupted.
- A Strata deployment landed a migration that causes the backend to crash-
  loop on startup or returns consistent 500s on a specific endpoint.
- Pre-production drill of the above.

## Prerequisites

- Shell access to the Strata host and to the replica host (if any).
- A current `pg_dump` of the primary (or a recent WAL/base-backup pair for
  streaming replication setups).
- A backup of the repo at the **previous** Strata tag (for migration
  rollback).
- Admin role in Strata.

## Safety checks

1. Confirm the primary really is failing and the replica (if any) is
   caught up:

   ```bash
   # On the replica
   docker compose exec postgres-replica \
     psql -U strata -d strata -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"
   ```

   Lag above 60 s means data loss on failover. Decide whether that is
   acceptable *before* you cut over.
2. Confirm no operator is mid-migration on the primary:

   ```bash
   docker compose exec postgres-local \
     psql -U strata -d strata -c "SELECT pid, state, query FROM pg_stat_activity WHERE state='active';"
   ```

3. Have a fresh `pg_dump` before any destructive step:

   ```bash
   docker compose exec postgres-local \
     pg_dump -U strata strata | gzip > pre-change-$(date +%s).sql.gz
   ```

## Procedure — Failover to replica

> Only applicable if you run streaming replication. A single-instance
> deployment should follow [disaster-recovery.md](disaster-recovery.md) instead.

### 1. Stop the Strata backend

```bash
docker compose stop backend
```

This prevents new writes from landing on the old primary during the
cutover and drifting from the replica.

### 2. Promote the replica

```bash
# On the replica host
docker compose exec postgres-replica \
  pg_ctl promote -D /var/lib/postgresql/data
```

Expected: the replica switches to read-write. Confirm:

```bash
docker compose exec postgres-replica \
  psql -U strata -d strata -c "SELECT pg_is_in_recovery();"
# expects `f`
```

### 3. Point the backend at the promoted instance

Update `DATABASE_URL` in the backend's env (either `docker-compose.yml`
or your deployment's secrets manager) so it resolves to the promoted
host. Restart:

```bash
docker compose up -d backend
```

### 4. Verify

```bash
curl -fsSL https://<host>/api/health
# {"status":"ok","components":{"database":"ok",...}}
```

### 5. Rebuild a new replica

The old primary, if recoverable, must be **rebuilt as a new replica
against the promoted instance**, not booted back as a primary — that
would cause split-brain.

## Procedure — Migration rollback

Strata migrations are numbered (`001_initial_schema.sql` …
`NNN_feature.sql`) and gated by an advisory lock so at most one runs at a
time.

### 1. Identify the bad migration

```bash
docker compose exec postgres-local \
  psql -U strata -d strata -c "SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 10;"
```

### 2. ⚠ DESTRUCTIVE — write a compensating migration, do not edit history

Strata **does not** support `DOWN` migrations. The rollback path is:

1. Check out the Strata tag that contains the last known-good
   migration set (one lower than the bad migration's number).
2. Write a new migration with a fresh, higher number whose body
   reverses the bad change. Example:

   ```sql
   -- migrations/NNN_revert_MMM_feature.sql
   BEGIN;
   ALTER TABLE users DROP COLUMN IF EXISTS broken_column;
   DELETE FROM schema_migrations WHERE version = 'MMM_feature';
   COMMIT;
   ```

3. Deploy that version. The advisory lock still applies; no second
   migration will race.

### 3. If the backend cannot even start

(Because a migration crashed mid-flight and the server now panics on
boot.)

```bash
# Drop into Postgres manually and inspect
docker compose exec postgres-local psql -U strata -d strata

# Check schema_migrations
SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5;

# If the last row is the bad migration and the transaction did not
# commit cleanly, you'll see partial DDL. Revert it by hand inside a
# single transaction, then:
DELETE FROM schema_migrations WHERE version = 'MMM_feature';
```

Then start the previous Strata tag:

```bash
git checkout <previous-tag>
docker compose up -d backend
```

### 4. If data was written that must be preserved

Dump the affected tables before running any `ALTER` / `DROP`:

```bash
docker compose exec postgres-local \
  pg_dump -U strata -d strata -t <table> > rescue-<table>.sql
```

Restore into the reverted schema with a scripted transform — this is
application-specific and should go through code review before running.

## Verification

- `docker compose exec postgres-local psql -U strata -d strata -c "SELECT 1;"`
  returns `1`.
- Backend boots without panic: `docker compose logs backend | tail -50`.
- `/api/health` is green.
- Automated test suite against a staging replica of the fixed DB passes.

## Rollback of the rollback

If the compensating migration itself broke things:

1. Restore the pre-change dump you took in the safety-checks phase:

   ```bash
   gunzip -c pre-change-<ts>.sql.gz | \
     docker compose exec -T postgres-local \
     psql -U strata -d strata
   ```

2. Deploy the tag from before either change.

## Related

- [disaster-recovery.md](disaster-recovery.md)
- [../adr/ADR-0001-rate-limit-single-instance.md](../adr/ADR-0001-rate-limit-single-instance.md)
- [../architecture.md](../architecture.md)

---

_Last reviewed: 2026-04-21_
