# Runbook — Vault Operations (Unseal & Rekey)

**Purpose:** Unseal a stopped / restarted Vault, rotate the Transit
encryption key, and rekey the Shamir shards.

## When to use

- Vault container restarted (every compose `up` after a stop → needs unseal).
- After disaster-recovery restore.
- Scheduled Transit-key rotation (every 12 months, or after any suspected
  key exposure).
- Operator departure: the ex-operator's unseal shard must no longer be
  sufficient to unseal the cluster.

## Prerequisites

- `docker compose` access to the Strata host.
- The quorum of **unseal-key shards** — typically 3 of 5. If you don't have
  the quorum, this runbook cannot help you; see
  [disaster-recovery.md](disaster-recovery.md) for the "lost keys" path.
- The Vault root token (for rekey / rotate).

## Safety checks

1. Verify Vault is actually sealed:

   ```bash
   docker compose exec vault vault status
   ```

   Expected when sealed:

   ```
   Sealed      true
   Total Shares 5
   Threshold    3
   ```

2. Before any rekey, confirm all current shard-holders are on a call or
   available — rekey fails half-way if shard-holders go dark.

## Procedure — Unseal

Repeat step 1 with a different shard-holder until Vault reports `Sealed
false`.

### 1. Supply one unseal key shard

```bash
docker compose exec vault vault operator unseal <shard-1>
# output: Unseal Progress 1/3
docker compose exec vault vault operator unseal <shard-2>
# output: Unseal Progress 2/3
docker compose exec vault vault operator unseal <shard-3>
# output: Sealed false
```

### 2. Poke the backend to re-cache secrets

```bash
docker compose restart backend
```

Expected: backend log contains `vault: reachable, transit key ready`
within 15 s.

## Procedure — Rotate the Transit key

Use this **without** rekeying Shamir shards when the Transit key alone
is suspected — the Shamir shards protect Vault itself, which is a
separate concern.

### 1. Rotate

```bash
docker compose exec vault \
  vault write -f transit/keys/guac-master-key/rotate
```

Expected output includes a new `latest_version` one higher than the
previous.

### 2. Re-encrypt existing data to the new version

> ⚠ Rewrap re-encrypts with a higher key version without exposing
> plaintext. It is safe to run while the app is live.

Strata will wrap new writes with the latest version automatically
(see ADR-0006). To promote existing rows:

```bash
docker compose exec backend \
  /usr/local/bin/strata-admin rewrap-secrets
```

Expected output: a summary like `rewrapped 37 rows across 4 tables`.

### 3. Optionally delete older versions

Only after you are satisfied that every row is on the latest
version. **Do not** delete key versions while older ciphertexts
still exist — it will brick every secret still wrapped under them.

```bash
docker compose exec vault \
  vault write transit/keys/guac-master-key/config min_decryption_version=<N>
```

## Procedure — Rekey Shamir shards

Use when the set of shard-holders changes (operator rotation, suspected
shard exposure, or quorum-policy change).

### 1. Start a rekey operation

```bash
docker compose exec vault \
  vault operator rekey -init -key-shares=5 -key-threshold=3
```

Record the `Nonce` from the output.

### 2. Each current shard-holder submits their shard

```bash
docker compose exec vault \
  vault operator rekey -nonce=<nonce> <old-shard>
# repeat for each of the threshold shard-holders
```

### 3. Distribute the new shards

The final submission prints five new shards. Distribute **each** to a
different shard-holder over a secure channel. **Never** store all five
on the same machine.

### 4. Verify

```bash
docker compose exec vault vault status
```

`Total Shares` and `Threshold` reflect the new config. Old shards no
longer work.

## Verification

- `vault status` reports `Sealed false`, `Initialized true`.
- Backend `GET /api/admin/health` reports `vault: healthy`.
- Admin UI → Vault tab shows green.
- After a rotate, a newly-written sealed secret begins with
  `vault:v<new>:...` (visible in `settings` rows after any admin
  save).

## Rollback

- **Unseal failed (wrong shard)**: Vault discards the attempt;
  resume with the correct shard.
- **Rotate already complete**: there is no rollback — run another
  rotate to move to a newer version instead.
- **Rekey abandoned mid-flight**:

  ```bash
  docker compose exec vault vault operator rekey -cancel
  ```

  The old shards remain valid.

## Related

- [../adr/ADR-0006-vault-transit-envelope.md](../adr/ADR-0006-vault-transit-envelope.md)
- [disaster-recovery.md](disaster-recovery.md)
- [security-incident.md](security-incident.md)

---

_Last reviewed: 2026-04-21_
