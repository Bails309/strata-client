# Antivirus (AV) operations

> **When to use:** scanner outage triage, signature-update troubleshooting,
> false-positive remediation, the EICAR smoke test, and routine AV
> capacity checks. For the design rationale see
> [ADR-0011](../adr/ADR-0011-av-scanning.md); for the operator deep-dive
> see [av-scanning.md](../av-scanning.md).

## Purpose

Step-by-step procedures for keeping the v1.12.0+ AV scanning feature
healthy in production.

## Prerequisites

- Docker compose shell access to the stack (`docker compose exec`).
- Postgres read access to query `audit_logs` and `outbound_shares`.
- For commercial-engine sites (`STRATA_AV_BACKEND=command`): the
  scanner's vendor console and the wrapper-script path.

## Safety checks

Before touching anything:

```bash
# 1. Verify the backend is healthy
curl -fsS http://localhost:8080/api/health | jq

# 2. Verify which AV backend is active
docker compose exec backend env | grep STRATA_AV_

# 3. Look at the most recent block events
docker compose exec postgres-local \
  psql -U guacuser -d guacclient -c "
    SELECT created_at, details->>'signature' AS sig, details->>'av_backend' AS engine
    FROM audit_logs
    WHERE action='file.av_blocked'
    ORDER BY created_at DESC LIMIT 10;"
```

## Procedure A — Scanner is down

**Symptoms:** users see `400 File rejected by malware scan: ...
scanner error` on every Quick Share upload; audit log shows a burst
of `file.av_blocked` rows with `details->>'av_backend'` set but
`details->>'signature'` empty or set to an error string.

### A.1 Confirm the scanner is unreachable

```bash
# ClamAV backend
docker compose exec backend nc -zv clamav 3310
# Expected: "Connection to clamav 3310 port [tcp/*] succeeded!"
# If "Connection refused" → daemon down.
# If "Temporary failure in name resolution" → DNS / service missing.

# command backend
docker compose exec backend which $(echo "$STRATA_AV_CMD" | awk '{print $1}')
# Expected: full path
# If missing → command not installed in backend container.
```

### A.2 ClamAV — restart the sidecar

```bash
docker compose --profile av restart clamav
docker compose logs --tail=200 clamav | grep -iE '(database|fatal|error)'
```

Common causes:

- **OOM-killed.** The signature DB load needs ≥ 1.5 GB. Check
  `docker compose ps clamav` for status `exited (137)`. Raise the
  memory limit in `docker-compose.yml` and `docker compose --profile av up -d`.
- **freshclam still pulling.** First boot can take 3–5 min for the
  initial ~250 MB download. The healthcheck's `start_period: 300s`
  covers this — if you see the container `unhealthy` *during* the
  first pull, check outbound bandwidth and that `clamav.net` isn't
  blocked at your egress.
- **Corrupt signature DB.** Delete the volume and re-pull:
  ```bash
  docker compose --profile av down
  docker volume rm strata-client_clamav-db
  docker compose --profile av up -d
  ```
  ⚠ DESTRUCTIVE — only run if `freshclam` is failing on the existing volume.

### A.3 command backend — verify the scanner

```bash
# Run the configured command against a temp file as the backend user
docker compose exec backend sh -c '
  printf "X5O!P%%@AP[4\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*" > /tmp/eicar.com
  eval "$STRATA_AV_CMD" | tail -n 5
  echo "exit=$?"
  rm /tmp/eicar.com'
```

Expected: scanner reports EICAR, exit code 1. If the command isn't
found, mount the binary or re-base the backend image with the
scanner installed.

### A.4 If the scanner cannot be restored quickly

Choose one:

**Option 1 — Flip to fail-open (impacts security posture):**

```bash
# Append to .env
echo 'STRATA_AV_FAIL_MODE=allow' >> .env
docker compose up -d
```

Uploads will pass through with `av_status=error` audit rows.
**Infected verdicts are still rejected** under `allow` — only error
verdicts degrade-pass. Schedule a follow-up to restore the
scanner and flip back to `block`.

**Option 2 — Disable scanning entirely:**

```bash
echo 'STRATA_AV_BACKEND=off' >> .env
docker compose --profile av down    # optional, frees memory
docker compose up -d
```

Subsequent uploads land with `av_status=skipped`,
`av_scanner_backend=off`.

## Procedure B — Signatures aren't updating

**Symptoms:** ClamAV `daily.cvd` is more than 48 hours old. EICAR
still detected (it's in `main.cvd`) but new threats are missed.

### B.1 Check freshclam logs

```bash
docker compose logs --since=48h clamav | grep -iE '(freshclam|database)'
```

Look for `ClamAV update process started` and `daily.cvd database
updated`. If you see `WARNING: Can't query current.cvd.clamav.net`
the container can't reach the upstream mirror.

### B.2 Manual update

```bash
docker compose exec clamav freshclam --verbose
```

Watch for "is up-to-date" or "updated" lines per signature DB.

### B.3 Air-gapped sites — verify the mirror

If you've configured a private mirror per the
[av-scanning.md → Signature freshness](../av-scanning.md#signature-freshness) guide:

```bash
docker compose exec clamav cat /etc/clamav/freshclam.conf | grep DatabaseMirror
curl -sI $(docker compose exec clamav awk '/DatabaseMirror/{print $2}' /etc/clamav/freshclam.conf)/main.cvd
# Expected: HTTP 200
```

If the mirror is stale, refresh it from upstream and try again.

## Procedure C — False-positive triage

**Symptoms:** a known-good file is rejected; user reports their
legitimate Office document / installer / signed binary is blocked.

### C.1 Verify the file is actually safe

⚠ **Do not whitelist anything you haven't independently verified.**

1. Hash the file:
   ```bash
   sha256sum /path/to/file
   ```
2. Submit the hash to VirusTotal or your second-opinion engine.
   Look for a clear majority verdict from multiple vendors.
3. If verdict is mixed, escalate to the user's security team before
   proceeding — do not whitelist a borderline file.

### C.2 ClamAV — add to the local whitelist

```bash
# Find the signature name from the audit row
docker compose exec postgres-local \
  psql -U guacuser -d guacclient -c "
    SELECT details->>'signature' FROM audit_logs
    WHERE action='file.av_blocked'
      AND details->>'filename' = '<filename>'
    ORDER BY created_at DESC LIMIT 1;"

# Add to the local whitelist
docker compose exec clamav sh -c \
  'echo "<signature-name>" >> /var/lib/clamav/whitelist.fp'

# Reload the scanner
docker compose --profile av restart clamav
```

The `.fp` (false-positive) file is read on clamd startup; entries
suppress only the named signature, not every detection on the
file.

### C.3 Report upstream

For genuine false positives in ClamAV signatures, report at
[https://www.clamav.net/reports/fp](https://www.clamav.net/reports/fp).
The signature will typically be revised within 1–2 sig-DB
updates.

### C.4 Commercial-engine false positives

Submit per vendor (Microsoft Defender:
`Submit a file for malware analysis`; Sophos: SophosLabs sample
submission; ESET: contact support). Until the vendor updates,
either whitelist via the engine's own mechanism or move the user
to a different scanner via `STRATA_AV_CMD`.

## Procedure D — EICAR smoke test (routine verification)

Run after any scanner change, container rebuild, or signature
update.

> **Prerequisites.** The smoke-test user must have **Use Quick
> Share** enabled on their role (Admin → Roles), or be a
> super-admin. Otherwise the upload returns
> `403 {"code":"FORBIDDEN","error":"Forbidden"}` before the
> scanner is consulted. Log out and back in after changing the
> role so the new claims land in the cookie.
>
> **Copy-paste warning.** The command below uses `\`
> line-continuations. If your terminal strips them (PowerShell
> always; some pasters silently do), each line runs as a separate
> command and you'll see a mix of `curl: (6) Could not resolve
> host: -H` errors and a single `{"code":"FORBIDDEN"}` from the
> orphaned first `curl`. Keep the backslashes intact or put it
> all on one line.

```bash
# 1. Write the test string
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.com

# 2. POST through Strata (replace $TOKEN and $SESSION with valid values
#    captured from a logged-in browser via DevTools → Application → Cookies
#    and a recent /api/sessions response)
curl -sS -X POST https://strata.example.com/api/files/upload \
  -H "Cookie: access_token=$TOKEN" \
  -F "session_id=$SESSION" \
  -F "file=@/tmp/eicar.com" \
  -o /tmp/scan-resp.json -w '\nHTTP %{http_code}\n'

# Expected:
# HTTP 400
# {"error":"validation","message":"File rejected by malware scan: Win.Test.EICAR_HDB-1"}

# 3. Confirm the audit row landed
docker compose exec postgres-local \
  psql -U guacuser -d guacclient -c "
    SELECT created_at, details->>'signature' AS sig
    FROM audit_logs
    WHERE action='file.av_blocked'
    ORDER BY created_at DESC LIMIT 1;"

# 4. Cleanup
rm /tmp/eicar.com /tmp/scan-resp.json
```

Failure modes:

| Result | Likely cause |
|--------|--------------|
| HTTP 200 | `STRATA_AV_BACKEND=off`, or ClamAV first-boot signature pull not complete |
| HTTP 400 with `scanner error` (no signature) | Daemon unreachable — run procedure A |
| HTTP 400 with a different signature | Engine is working but detected a different test pattern; check you wrote the canonical EICAR string |
| HTTP 401 `{"code":"UNAUTHORIZED"}` | `$TOKEN` is empty, expired, or for a different host — re-capture the `access_token` cookie |
| HTTP 403 `{"code":"FORBIDDEN"}` | Smoke-test user's role lacks **Use Quick Share** (and isn't super-admin) — see prerequisites above |
| HTTP 400 `Missing session_id field` / `Missing file field` | Multi-line command was split by the shell — keep `\` line-continuations or run on a single line |

## Procedure E — Capacity / latency check

For sites with growing Quick Share volume, sample scan latency:

```bash
# Pull the last 1000 outbound submissions and look at the distribution
# of scanned_at - created_at as a rough proxy for scan latency
docker compose exec postgres-local \
  psql -U guacuser -d guacclient -c "
    SELECT
      width_bucket(EXTRACT(MILLISECOND FROM (av_scanned_at - created_at)), 0, 5000, 10) AS bucket,
      count(*)
    FROM outbound_shares
    WHERE av_scanned_at IS NOT NULL
      AND created_at > now() - interval '7 days'
    GROUP BY 1 ORDER BY 1;"
```

If the distribution skews toward the upper buckets (>2 s),
consider:

1. Raising `STRATA_AV_MAX_SCAN_SIZE` *downward* so oversize files
   skip the scan (note: this leaves large files unscanned — only
   do this if your threat model accepts it).
2. Running a second ClamAV replica (see
   [deployment-kubernetes.md → high-availability note](../deployment-kubernetes.md#antivirus-scanning-sidecar-v1120)).
3. Switching to a commercial engine via `command` (typically
   2–4× faster than clamd for large files).

## Verification

After every procedure above:

- EICAR smoke test (procedure D) returns HTTP 400 with the
  expected signature.
- `docker compose ps clamav` reports `Up (healthy)` (only if the
  `av` profile is in use).
- `docker compose logs --tail=20 backend` contains no recent
  `av: scan failed` lines.
- Audit log shows scan attempts (clean or infected) for any
  uploads run during verification.

## Rollback

If a procedure made things worse:

- Revert the env-var change in `.env` and `docker compose up -d`.
- If you deleted the `clamav-db` volume in procedure A.2, the
  next sidecar start will re-pull signatures from upstream
  (3–5 min on a normal-bandwidth host).
- If you whitelisted a signature in procedure C.2 by mistake,
  remove the line from `/var/lib/clamav/whitelist.fp` and
  restart the sidecar.

## Related

- [../adr/ADR-0011-av-scanning.md](../adr/ADR-0011-av-scanning.md) — decision rationale
- [../av-scanning.md](../av-scanning.md) — operator deep-dive
- [../deployment.md](../deployment.md#antivirus-scanning-v1120) — deployment guide
- [../deployment-kubernetes.md](../deployment-kubernetes.md#antivirus-scanning-sidecar-v1120) — K8s sidecar manifest
- [../threat-model.md](../threat-model.md) §2.11 — Quick Share file mover STRIDE

---

_Last reviewed: 2026-06-09_
