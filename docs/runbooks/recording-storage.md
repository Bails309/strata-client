# Runbook — Recordings not reaching Azure, or the recordings volume filling up

## Purpose

Find out why finished session recordings are staying on the gateway's
recordings volume instead of moving to Azure Blob Storage, fix the cause,
and keep the volume from filling while you do.

## When to use

- The admin **Sessions** recordings list (or **My Recordings**) shows
  recordings with storage **LOCAL** long after their session ended, while
  **Storage Backend** is set to Azure Blob Storage.
- Disk-usage alerts on the Docker host, or on the volume behind
  `/var/lib/guacamole/recordings` (`guac-recordings`).
- New recordings show **FAILED** (the file could not be created) or
  **INCOMPLETE** (a write failed) because the volume is full, or, with
  **Require recording** on, sessions are refused with *"This connection
  must be recorded, and the recording could not be started."*
- The backend logs `Azure Blob upload failed for …`,
  `recording_sync: iteration exceeded … budget — dropped`, or
  `Azure backend selected but config is incomplete`.

## Prerequisites

- A shell on the Docker host, in the `strata-client` checkout (commands are
  for Ubuntu / any Linux with Docker Engine and the Compose v2 plugin).
- For the SQL steps: the bundled database (`postgres-local`), or `psql`
  access to an external one.
- For configuration changes: an admin account with `can_manage_system`.
- For Azure-side checks: read access to the storage account in the Azure
  portal (networking, access keys, containers).

## Safety checks

1. **Do not delete files from the recordings volume by hand.** Each file
   has a `recordings` row that points at it; a missing file makes the
   recording unplayable and is not reported anywhere else. Let retention or
   the upload remove files.
2. **Restarting the backend ends every live session.** Steps marked ⚠ do
   it.
3. **Lowering retention deletes recordings** — locally and in Azure — on the
   next pass. Steps marked ⚠ DESTRUCTIVE do it. Check your records-retention
   obligations first.

## How it works

The backend's `recording_sync` worker
([`services/recordings.rs`](../../backend/src/services/recordings.rs)) runs
20 s after start and then every 60 s, **only while session recording is
enabled**. Each pass:

1. **Retention** — deletes local files, DB rows and Azure blobs older than
   **Retention (days)** (`0` = keep for ever).
2. **Upload** (Storage Backend = Azure Blob Storage only) — lists the
   volume, skips dot-files, directories, files changed in the last 30 s and
   files in back-off, and uploads the rest **oldest first** as block blobs:
   8 MiB `Put Block` requests, each retried up to 3 times, then
   `Put Block List`. On success the row's `storage_type` becomes `azure`
   and the local file is deleted.
3. A failed file is skipped for 1 min, then 2, 4 … up to 1 h between
   attempts (`retry_at`, in memory — a backend restart clears it).

A pass may run for up to 2 hours. **Before v2.3.10** the order, limits and
retention placement were different and are themselves the most common cause
of this symptom — see step 1.

## Procedure

### 1. Check the version

```bash
cat VERSION   # in the checkout the running images were built from
```

The running version is also shown on the in-app **What's New** card.

**Below 2.3.10:** upgrade. Earlier versions sent each recording in one
request limited to 60 s and to 5000 MiB, and abandoned each pass after 10
minutes, restarting it in the same order, so a few large recordings blocked
every recording behind them and stopped retention running. The upgrade
needs no manual clean-up; skip to *Verification* afterwards.

```bash
git pull
docker compose build backend frontend
docker compose up -d   # ⚠ ends live sessions
```

### 2. Confirm the worker is running and configured

```bash
docker compose logs --since 10m backend \
  | grep -E "sync_pass tick|Azure config loaded|config is incomplete|cannot read recordings directory|Vault is not configured|Failed to decrypt Azure access key"
```

Expected, once a minute:

```text
recordings: sync_pass tick … "enabled":true … "storage_type":"AzureBlob" … "retry_pending":0
recordings: Azure config loaded; scanning recordings directory … "account":"<account>","container":"recordings"
```

| You see | Cause | Fix |
| ------- | ----- | --- |
| No `sync_pass tick` at all | The backend is not running the worker (still in setup, or no database) | Check `docker compose ps backend` and the start-up log |
| `"enabled":false` | Session recording is off. **With recording off, neither upload nor retention runs** — recordings already on the volume stay there | Turn **Enable session recording** on, or move/accept the files left behind |
| `"storage_type":"Local"` | Storage Backend is not Azure Blob Storage | Set it in **Admin → Recordings** |
| `config is incomplete; uploads disabled` | Account name or access key is empty, or the sealed key could not be unsealed | Re-enter the account name and access key in **Admin → Recordings** and save |
| `Failed to decrypt Azure access key` / `vault-encrypted but Vault is not configured` | The key was sealed by a Vault the backend can no longer use | Fix Vault ([vault-operations.md](vault-operations.md)), or re-enter the key |
| `cannot read recordings directory` | The volume is not mounted or not readable | See [security.md § Recordings Volume](../security.md#recordings-volume--cross-container-posix-permissions-model) |

### 3. Measure the backlog

```bash
# Space left on the volume
df -h "$(docker volume inspect -f '{{ .Mountpoint }}' strata-client_guac-recordings)"

# Oldest and largest files still on it
docker compose exec backend sh -c \
  'cd /var/lib/guacamole/recordings && ls -ltr | head -20 && echo --- && ls -lS | head -10'
```

```bash
docker compose exec postgres-local psql -U strata strata -c "
SELECT storage_type, status, count(*) AS recordings,
       min(started_at) AS oldest, max(started_at) AS newest
FROM recordings GROUP BY 1, 2 ORDER BY 1, 2;"
```

Rows with `storage_type = local` and a `status` other than `recording` that
ended more than a few minutes ago are the backlog.

### 4. Read why uploads fail

```bash
docker compose logs --since 2h backend \
  | grep -E "Azure Blob upload failed|azure_blob.upload: attempt|iteration exceeded|Azure sync pass complete"
```

Each pass ends with a summary:

```text
recordings: Azure sync pass complete … "scanned":412,"skipped_too_new":2,"skipped_cached":0,"skipped_backoff":17,"uploaded":9,"failed":1
```

and each failure names the file, the attempt count and when it will be
retried:

```text
Azure Blob upload failed for <file>: <reason> … "failures":3,"retry_in_secs":240
```

| `<reason>` contains | Cause | Fix |
| ------------------- | ----- | --- |
| `403` … `AuthenticationFailed` | The access key is wrong or was rotated in Azure | Copy **key1** or **key2** from the storage account's **Access keys** and save it in **Admin → Recordings**. If the key is certainly right and this started with v2.3.10, report it with the log line — the request signature would be at fault |
| `403` … `AuthorizationFailure` / `This request is not authorized to perform this operation` | The storage account's firewall does not admit the gateway's outbound address | Add the gateway's egress IP under **Networking** on the storage account, or use a private endpoint the gateway can resolve |
| `404` … `ContainerNotFound` | The container named in **Admin → Recordings** does not exist | Create it (private access level), or correct the name |
| `413` … `RequestBodyTooLarge` | Pre-v2.3.10 single-request upload of a file over 5000 MiB | Upgrade (step 1) |
| `error sending request` / `operation timed out` | No route to `<account>.blob.core.windows.net`, a proxy blocking it, or a link slower than 256 KiB/s | Test from the host: `curl -sI https://<account>.blob.core.windows.net/` — any HTTP status (typically `400`) proves reachability; a timeout or DNS error does not |
| `dns error` / `failed to lookup address` | The backend cannot resolve the storage host | Check the Docker host's resolver; **Admin → Network** DNS applies to session targets only, not to Azure |
| `5xx` … `ServerBusy` / `InternalError` | Azure throttling or an outage | Nothing; the back-off retries. Check Azure status if it persists |
| `Cannot open` / `Cannot read` | The file vanished or is unreadable | Check permissions (step 2 table, last row) |

`recording_sync: iteration exceeded 7200s budget — dropped` on v2.3.10 or
later means a single pass ran for two hours: the link is too slow for the
volume of recordings produced. The back-off keeps the remaining files
moving, but the backlog will grow until throughput rises.

### 5. Retry a file now

Failed files wait up to an hour between attempts. To retry everything at
once after fixing the cause:

```bash
docker compose restart backend   # ⚠ ends live sessions; clears the back-off
```

Otherwise wait: each file is retried when its back-off expires, without a
restart.

### 6. If the volume is about to fill

In order of preference:

1. **Fix the upload** (steps 2–5). Uploaded files are deleted from the
   volume straight away.
2. **Grow the volume** (or the host disk it lives on). Nothing is lost.
3. ⚠ DESTRUCTIVE — **Lower Retention (days)** in **Admin → Recordings**.
   The next pass deletes every recording older than the new value, local
   *and* already in Azure, together with its database row. Set it back
   afterwards.

Do not delete `.guac` files by hand (see *Safety checks*).

## Verification

```bash
docker compose logs -f backend | grep -E "Synced recording to Azure Blob|Azure sync pass complete"
```

- `Synced recording to Azure Blob: <file>` lines appear, oldest files first.
- The pass summary shows `uploaded` > 0 and `failed` falling to 0;
  `retry_pending` in `sync_pass tick` falls to 0.
- The step 3 SQL shows the `local` count falling, and `df -h` shows space
  returning.
- A recording that was **LOCAL** plays from **Recordings** after it shows
  **AZURE**.

## Rollback

This runbook changes configuration only. If you lowered **Retention
(days)**, set it back once the volume has recovered; recordings it already
deleted are gone. If an upgrade to v2.3.10 must be rolled back, rebuild the
previous tag: recordings already in Azure stay playable, but the original
upload problem returns.

## Related

- [architecture.md § Off-box upload to Azure Blob Storage](../architecture.md#off-box-upload-to-azure-blob-storage-v2310)
- [security.md § Session Recording & Retention](../security.md#session-recording--retention)
- [deployment.md § Azure Blob Storage](../deployment.md#azure-blob-storage)
- [api-reference.md § `PUT /api/admin/settings/recordings`](../api-reference.md#put-apiadminsettingsrecordings)
- [CHANGELOG.md § 2.3.10](../../CHANGELOG.md#2310--2026-10-08)

_Last reviewed: 2026-10-08._
