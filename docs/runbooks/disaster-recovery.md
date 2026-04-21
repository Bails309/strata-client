# Runbook — Disaster Recovery

**Purpose:** Restore Strata to a working state after a catastrophic loss of
the host or of the persistent volumes.

## When to use

- The host is unrecoverable (hardware failure, hostile tenant, destroyed VM).
- A `postgres-data` volume is corrupted and won't start.
- An operator wants to exercise the RTO / RPO drill (quarterly).

## Targets

| Metric | Target | Measured against |
|---|---|---|
| **RTO** (time to user-facing service restore) | **≤ 4 hours** | Last green `docker-compose up` on the replacement host |
| **RPO** (acceptable data loss) | **≤ 24 hours** | Most recent successful nightly backup |

## Prerequisites

- Access to the **offsite backup store** (S3 / Azure Blob / NFS — deployment-
  specific; see [../deployment.md](../deployment.md)).
- A replacement host with Docker 26+ and Docker Compose v2.
- The operator's Vault **unseal-key shard** and the recovery quorum of other
  key holders reachable (see [vault-operations.md](vault-operations.md)).
- The TLS cert + key for the public hostname (or the ability to re-issue via
  ACME — see [certificate-rotation.md](certificate-rotation.md)).
- The repo checked out at the **same tag** that produced the backup. Running
  a newer schema against an older dump risks migration drift.

## Safety checks

1. Confirm the incident is real: the old host really is unreachable /
   unrecoverable. Do **not** restore onto a still-running instance.
2. Verify the backup you intend to use is intact:

   ```bash
   sha256sum strata-backup-YYYYMMDD.tar.gz
   ```

   Compare against the hash recorded in the backup manifest.
3. Confirm DNS can be pointed at the new host before you start; an
   `A`-record TTL of 5 min is standard.

## Procedure

### 1. Provision the replacement host

```bash
# On the new host, as root:
apt-get update && apt-get install -y docker.io docker-compose-plugin
git clone https://github.com/<org>/strata-client.git
cd strata-client
git checkout <tag-matching-backup>
```

### 2. Restore persistent volumes

```bash
# Copy the backup bundle into place
scp backup-host:/srv/strata-backups/strata-backup-YYYYMMDD.tar.gz .
tar xzvf strata-backup-YYYYMMDD.tar.gz
# Produces: ./restore/postgres-dump.sql.gz
#           ./restore/recordings.tar.gz
#           ./restore/certs.tar.gz
```

### 3. Start **only** Postgres

```bash
docker compose up -d postgres-local
# Wait for healthy
docker compose ps
```

### 4. ⚠ DESTRUCTIVE — restore the Postgres dump

```bash
# Pipe the dump into psql inside the container
gunzip -c restore/postgres-dump.sql.gz | \
  docker compose exec -T postgres-local \
  psql -U strata -d strata
```

Expected output: a long stream of `SET`, `CREATE TABLE`, `COPY`,
`CREATE INDEX`, `ALTER TABLE` lines and a final `ANALYZE`. Any
`ERROR:` line aborts the restore — stop and investigate.

### 5. Restore recordings volume

```bash
# Recordings live in the named Docker volume `recordings-data`
docker run --rm -v recordings-data:/data -v $PWD/restore:/restore alpine \
  sh -c "cd /data && tar xzf /restore/recordings.tar.gz"
```

### 6. Restore TLS certs

```bash
tar xzf restore/certs.tar.gz -C ./certs
```

### 7. Start the full stack

```bash
docker compose up -d
docker compose ps
```

All six services (`postgres-local`, `vault`, `backend`, `guacd`,
`nginx`, and any recording-storage helper) must show `healthy`.

### 8. Unseal Vault

Follow [vault-operations.md § Unseal](vault-operations.md) using the
quorum of unseal-key shards. Until Vault is unsealed, **no secret
can be decrypted**, so login / SSO / PM checkout will all 500.

### 9. Point DNS at the new host

Update the `A` / `AAAA` record for the public hostname. TTL should
already be 5 min from your pre-check.

## Verification

1. `curl -fsSL https://<host>/api/health` returns `{"status":"ok"}`.
2. Log in as an admin user that existed in the backup. You should
   see the same folders, connections, and recordings that existed
   at backup time.
3. Open one connection end-to-end to confirm guacd is healthy.
4. `docker compose logs backend | grep -i error` is empty since
   boot.

## Rollback

There is no rollback beyond "redirect DNS back to the old host".
If the old host is gone, this runbook **is** the recovery path —
failing forward is the only option. If step 4 (dump restore) fails,
drop and recreate the `postgres-data` volume and try a different
backup.

## Related

- [vault-operations.md](vault-operations.md)
- [certificate-rotation.md](certificate-rotation.md)
- [database-operations.md](database-operations.md)
- [../adr/ADR-0006-vault-transit-envelope.md](../adr/ADR-0006-vault-transit-envelope.md)

---

_Last reviewed: 2026-04-21_
