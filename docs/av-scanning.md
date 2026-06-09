# Antivirus scanning

> **Status:** Shipped in v1.12.0 — see
> [CHANGELOG.md](../CHANGELOG.md#1120--2026-06-09),
> [WHATSNEW.md](../WHATSNEW.md), and
> [ADR-0011](adr/ADR-0011-av-scanning.md) for the design rationale.
>
> **v1.12.1 polish:** friendly user-facing block messages via
> `Verdict::user_facing_block_message()` (no more raw `stderr` or
> `clamd` panic strings reaching end users); hourly `freshclam` +
> forced `clamd` reload after every signature update so the engine
> never serves with stale definitions; 500 MiB default
> `STRATA_AV_MAX_BYTES` aligned with the Quick Share upload cap; real
> on-wire `clamd` INSTREAM / `freshclam` CVD fixtures in the unit
> suite (the v1.12.0 fixtures used the wrong byte order on the
> response framing); and two new admin surfaces —
> `GET /api/admin/health/av` (AV Health card) and
> `GET /api/admin/files/av-blocked` (unified inbound + outbound
> blocked-files audit grid). See
> [CHANGELOG.md](../CHANGELOG.md#1121--2026-06-09) for the full
> 1.12.1 entry.

This document is the canonical operator reference for the
antivirus (AV) scanning hook that Strata applies to every Quick
Share upload path. It covers the trait abstraction, the three
bundled backends, the wire protocol used by the ClamAV backend,
the exit-code contract used by the `command` backend, the audit
trail, fail-mode semantics, deployment topologies, and
troubleshooting.

## Why this exists

Through v1.11.x, the Quick Share file mover had no in-product
malware check. Operators were expected to wire their own DLP / AV
proxy in front of the backend, or to trust that the source
machine (operator's workstation or remote target) had endpoint
protection enabled. v1.12.0 closes that gap with a small,
explicit, pluggable scanner gate in `services::av` that runs on
both directions of the file mover:

| Direction | Endpoint                                              | When the scan runs                                        |
| --------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Inbound   | `POST /api/files/upload`                              | After MIME sniffing, **before** `file_store.store_from_path` |
| Outbound  | `POST /api/user/outbound-shares/submit`               | After multipart stage to disk, **before** Vault-Transit seal |
| Outbound  | `POST /api/outbound-shares/ingest/{token}` (shell-side) | Same as above; runs on the same `parse_outbound_multipart` path |

The scanner is intentionally configured with a default of `off`
so v1.11.x deployments upgrade with no behaviour change.

## Architecture

### The trait

```rust
// backend/src/services/av.rs

#[async_trait]
pub trait Scanner: Send + Sync + std::fmt::Debug {
    /// Scan `path` (a temp file the caller owns) reporting a verdict.
    /// `file_size_bytes` lets implementations short-circuit on
    /// oversize without a stat call.
    async fn scan(&self, path: &Path, file_size_bytes: u64) -> Verdict;

    /// Stable identifier for audit / metrics / "which engine spoke".
    fn backend_name(&self) -> &'static str;
}

pub enum Verdict {
    Clean,
    Infected { signature: String },
    Skipped  { reason:    String }, // e.g. "scanning disabled", "oversize"
    Error    { message:   String },
}

pub enum FailMode { Block, Allow }

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::Clean       => "clean",
            Verdict::Infected{..}=> "infected",
            Verdict::Skipped {..}=> "skipped",
            Verdict::Error   {..}=> "error",
        }
    }

    /// True ↔ reject the upload.
    pub fn blocks(&self, fail_mode: FailMode) -> bool {
        match self {
            Verdict::Clean       | Verdict::Skipped{..} => false,
            Verdict::Infected{..}                       => true,
            Verdict::Error   {..} => matches!(fail_mode, FailMode::Block),
        }
    }
}
```

Three concrete implementations ship: `OffScanner`,
`ClamAvScanner`, `CommandScanner`. The active backend is selected
at boot via `Config::from_env`:

```rust
pub fn build(cfg: &Config) -> Arc<dyn Scanner> {
    match cfg.backend {
        Backend::Off     => Arc::new(OffScanner),
        Backend::ClamAv  => Arc::new(ClamAvScanner::new(cfg.clamd_host.clone(), cfg.clamd_port, cfg.timeout_ms, cfg.max_scan_size)),
        Backend::Command => Arc::new(CommandScanner::new(cfg.command.clone(), cfg.timeout_ms, cfg.max_scan_size)),
    }
}
```

The resulting `Arc<dyn Scanner>` is stored once in `AppState` and
cloned (cheaply, via `Arc::clone`) into every request handler that
needs to scan.

### Where the scan runs

Both routes follow the same shape:

```rust
// routes/files.rs::upload — sketched
let temp_path = stash_multipart_field_to_temp(&mut field).await?;
let mime      = sniff_mime(&temp_path).await?;
let verdict   = state.av_scanner.scan(&temp_path, byte_len).await;

if verdict.blocks(state.av_fail_mode) {
    fs::remove_file(&temp_path).await.ok();   // belt-and-braces cleanup
    audit::log(&state, ActorContext::from(&claims), "file.av_blocked", json!({
        "signature": verdict_signature(&verdict).unwrap_or_default(),
        "filename":  filename,
        "byte_len":  byte_len,
        "session_id":session_id,
        "av_backend":state.av_scanner.backend_name(),
    })).await;
    return Err(AppError::Validation(format!(
        "File rejected by malware scan: {}", verdict_message(&verdict),
    )));
}

let stored = state.file_store.store_from_path(&temp_path, ...).await?;
```

The outbound pipeline is identical except the verdict also lands
in the four new `outbound_shares.av_*` columns via the
`SubmitInput { av_verdict, av_backend, .. }` shape so the audit
trail is row-attached.

## The three backends

### `off` (default)

```rust
impl Scanner for OffScanner {
    async fn scan(&self, _: &Path, _: u64) -> Verdict {
        Verdict::Skipped { reason: "scanning disabled".to_string() }
    }
    fn backend_name(&self) -> &'static str { "off" }
}
```

Always returns `Skipped`. The handler treats `Skipped` as a pass
regardless of fail-mode, so this is a true no-op. Deployments that
never opt in pay zero scanner-related overhead.

### `clamav`

Speaks the [ClamAV `clamd` INSTREAM protocol](https://docs.clamav.net/manual/Usage/Configuration.html#clamd) directly
over TCP. No `clamdscan` shell-out, no file copy across a
shared filesystem.

The full wire exchange for a single scan:

```
client → clamd : "zINSTREAM\0"                     (opener)
client → clamd : [u32 length BE][chunk bytes]…     (file body, 64 KB chunks)
client → clamd : [0u32 BE]                         (terminator)
client ← clamd : "stream: OK\0"            // verdict: Clean
                 OR
                 "stream: <signature> FOUND\0"  // verdict: Infected
                 OR
                 "<error message> ERROR\0"  // verdict: Error
```

Salient implementation points (see
[backend/src/services/av.rs](../backend/src/services/av.rs) for
the canonical source):

- Uses `tokio::net::TcpStream` with the configured
  `STRATA_AV_TIMEOUT_MS` deadline applied via
  `tokio::time::timeout` over the whole exchange.
- Chunks the file in 64 KB reads — large enough to keep syscall
  count bounded, small enough that the daemon's internal buffers
  don't bloat on multi-hundred-MB files.
- Big-endian `u32` length prefix per chunk, terminated by a
  zero-length frame.
- Reads the response as a null-terminated byte string and matches
  on the suffix (`FOUND` / `OK` / `ERROR`) rather than the full
  string so trailing whitespace variants don't fool the parser.
- Files larger than `STRATA_AV_MAX_SCAN_SIZE` (default 500 MiB,
  matching the 500 MiB upload cap so every accepted upload is
  scanned) are tagged `Skipped { reason: "oversize" }` rather than
  attempted. The clamd-side `StreamMaxLength` defaults to 25 MiB
  upstream; the bundled sidecar ships
  [clamav/clamd.conf](../clamav/clamd.conf) which raises it (and
  `MaxFileSize` / `MaxScanSize`) to 512 MiB / 512 MiB / 1024 MiB
  so the two limits agree. If you raise the backend ceiling past
  512 MiB, raise the clamd values too — otherwise clamd returns
  `INSTREAM size limit exceeded. ERROR` mid-scan and the upload
  is rejected under `STRATA_AV_FAIL_MODE=block`.
- Timeout produces `Verdict::Error { message: "scan timeout" }`;
  the fail-mode then decides block vs pass.

### `command`

Shell-out to any scanner that follows the exit-code contract:

| Exit code | Meaning  |
| --------- | -------- |
| `0`       | Clean    |
| `1`       | Infected |
| other     | Error    |

The command line is parsed from `STRATA_AV_CMD` via simple
whitespace split (no shell parsing — wrap pipes or env-expansion
in a small wrapper script). The file path is substituted at the
`{path}` placeholder, or appended as the final argv element if no
placeholder is present.

```rust
fn build_argv(template: &str, file_path: &Path) -> Vec<OsString> {
    let mut argv: Vec<OsString> = template
        .split_whitespace()
        .map(|tok| {
            if tok == "{path}" {
                file_path.as_os_str().to_os_string()
            } else {
                OsString::from(tok)
            }
        })
        .collect();
    if !template.contains("{path}") {
        argv.push(file_path.as_os_str().to_os_string());
    }
    argv
}
```

The process is dispatched via `tokio::process::Command::new(argv[0]).args(&argv[1..])` (no `bash -c`, no `sh -c`). Signature
extraction parses the last non-empty stdout line, falling back to
stderr, with `Threat: ` and `Found: ` prefixes stripped.

Worked examples — drop these into `.env`:

```env
# Microsoft Defender for Endpoint (Linux ATP)
STRATA_AV_BACKEND=command
STRATA_AV_CMD=/opt/microsoft/mdatp/sbin/mdatp scan custom --path {path}

# Sophos for Linux (savscan, no boot scan)
STRATA_AV_BACKEND=command
STRATA_AV_CMD=/opt/sophos-av/bin/savscan -ss -nb {path}

# ESET File Security on-demand scanner
STRATA_AV_BACKEND=command
STRATA_AV_CMD=/opt/eset/efs/sbin/odscan --readonly {path}

# Wrapper script for anything fancier
STRATA_AV_BACKEND=command
STRATA_AV_CMD=/usr/local/bin/strata-scan.sh {path}
```

A wrapper template that chains two engines (e.g. ClamAV + a
commercial second opinion):

```bash
#!/usr/bin/env bash
# /usr/local/bin/strata-scan.sh
set -euo pipefail
file="$1"

# First pass — ClamAV
out1=$(clamdscan --no-summary --infected --fdpass "$file" 2>&1 || true)
ec1=$?
if [[ $ec1 -eq 1 ]]; then
    echo "$out1" | tail -n1 | sed 's/.*: //' | sed 's/ FOUND//'
    exit 1
fi
if [[ $ec1 -ne 0 ]]; then echo "$out1" >&2; exit 2; fi

# Second pass — commercial engine
out2=$(/opt/vendor/bin/scan --quiet --report-only-infected "$file")
ec2=$?
case $ec2 in
    0) exit 0 ;;
    1) echo "$out2" | tail -n1 ; exit 1 ;;
    *) echo "$out2" >&2; exit 2 ;;
esac
```

## Configuration matrix

| Env var                    | Type      | Default                  | Notes                                                                          |
| -------------------------- | --------- | ------------------------ | ------------------------------------------------------------------------------ |
| `STRATA_AV_BACKEND`        | enum      | `off`                    | `off` \| `clamav` \| `command`                                                 |
| `STRATA_AV_FAIL_MODE`      | enum      | `block`                  | `block` (reject on scanner error) \| `allow` (degrade open on scanner error)   |
| `STRATA_AV_MAX_SCAN_SIZE`  | bytes     | `524288000` (500 MiB)    | Files larger than this are `Skipped { reason: "oversize" }`. Matches the 500 MiB upload cap so every accepted upload is scanned. |
| `STRATA_AV_TIMEOUT_MS`     | ms        | `120000` (2 min)         | Per-scan wall-clock deadline. Timeout → `Verdict::Error`. 500 MiB nested archives can comfortably exceed 30 s. |
| `STRATA_AV_CLAMD_HOST`     | hostname  | `clamav`                 | Matches the compose service name; override for external clamd                  |
| `STRATA_AV_CLAMD_PORT`     | u16       | `3310`                   | Plain TCP. Wrap in stunnel for untrusted-network hops                          |
| `STRATA_AV_CMD`            | string    | (none — required)        | Whitespace-split argv template; `{path}` substituted or appended               |

Full operator commentary lives in [`.env.example`](../.env.example)
under the **Antivirus scanning** section.

## Fail-mode semantics

Two-axis truth table. `FailMode` × `Verdict` → block / pass.

|             | `Clean` | `Infected` | `Skipped` | `Error` |
| ----------- | ------- | ---------- | --------- | ------- |
| **`Block`** | pass    | **BLOCK**  | pass      | **BLOCK** |
| **`Allow`** | pass    | **BLOCK**  | pass      | pass    |

Read it as: *infected is always a block, skipped is always a
pass, error follows the fail-mode knob, clean is always a pass.*

The `Skipped → pass` row is by design — it covers two scenarios
that should not block users:

1. `backend=off`: scanning is disabled. The handler still calls
   `scan()` so the audit trail is consistent, but the verdict
   carries `reason="scanning disabled"` and the upload proceeds.
2. `backend=clamav` / `command` with an oversize file:
   `reason="oversize"`. Operators tune
   `STRATA_AV_MAX_SCAN_SIZE` to govern when this happens. In
   highly-regulated environments where no-skip is required, set
   the cap to a very large number; in pragmatic deployments
   100 MiB is a good ceiling that excludes ISOs and disk images
   while covering 99% of document workflows.

## Audit trail

Two structured audit-event surfaces:

### `file.av_blocked` (rejection — inbound *and* outbound)

```json
{
  "action": "file.av_blocked",
  "actor_user_id": "ee5f…",
  "details": {
    "source":       "inbound",            // inbound | outbound_drive | outbound_token
    "filename":     "eicar.com",
    "size":         68,
    "av_status":    "infected",           // infected | error
    "av_signature": "Win.Test.EICAR_HDB-1",
    "av_message":   "Win.Test.EICAR_HDB-1 FOUND",
    "av_backend":   "clamav",
    "session_id":   "3b8d…"               // inbound only
  }
}
```

Written from `routes/files.rs::upload` (inbound) and from
`routes/outbound_shares.rs::parse_outbound_multipart` (outbound,
both the drive-channel `submit` and the token-auth
`ingest_via_token` paths) after the temp file is unlinked,
inside the same hash-chained audit pipeline as every other
privileged action.

The dedicated **Admin → Secrets & Security → AV-Blocked Files**
tab is the operator-friendly view: it filters
`/api/admin/audit-logs?action_type=file.av_blocked` and renders
each rejection with timestamp, user, source, filename, size,
status badge, signature, engine message, and backend. The
underlying audit page (`/audit`) still works for ad-hoc queries
and hash-chain verification.

### `outbound_share.requested` (extended)

Existing event, extended with three new keys in v1.12.0:

```json
{
  "action": "outbound_share.requested",
  "actor_user_id": "ee5f…",
  "details": {
    "share_id":     "2f1e…",          // null on rejected submissions
    "filename":     "report.xlsx",
    "byte_len":     32841,
    "session_id":   "3b8d…",
    "connection_id":"a9c2…",
    "dlp_score":    0,
    "dlp_flags":    [],
    "av_status":    "clean",          // new in v1.12.0
    "av_signature": null,             // new — populated only on infected
    "av_backend":   "clamav"          // new — which engine spoke
  }
}
```

This means the outbound flow is **self-attesting** for compliance
review: every submission's audit row records *which* engine ran
and *what* it said, without needing to cross-reference an
external SIEM. On rejection (`av_status=infected` or
`av_status=error` under `block` mode), no `share_id` is allocated
and no `outbound_shares` row is written — but the audit event is
still emitted, so the rejection is just as durable as the
accepted-and-stored case.

### Row-attached state on `outbound_shares`

For accepted submissions (and submissions where the scanner
`Skipped` or `Error`-with-`allow`), the verdict also persists in
four columns added by migration `078_av_scanning.sql`:

| Column                | Type            | Notes                                                                |
| --------------------- | --------------- | -------------------------------------------------------------------- |
| `av_scan_status`      | `TEXT` (NULL)   | One of `clean` \| `infected` \| `skipped` \| `error`                |
| `av_signature`        | `TEXT` (NULL)   | Engine-reported signature on infected rows                            |
| `av_scanned_at`       | `TIMESTAMPTZ`   | When the verdict was issued                                          |
| `av_scanner_backend`  | `TEXT` (NULL)   | Which backend spoke (`off`, `clamav`, `command`)                     |

Plus the partial index `idx_outbound_shares_av_attention
(av_scan_status) WHERE status IN ('infected','error')` keeps the
"show me every row that needs eyeballing" admin query cheap as
the table grows. Rows that scanned `clean` or `skipped` are
excluded from the index entirely.

All four columns are nullable: rows created under v1.11.x stay
`NULL`, and the admin UI renders them as "Pre-AV (v1.11.x)" with
a neutral grey badge instead of an alarming red one.

## Deployment shapes

### Shape 1 — Bundled ClamAV sidecar (recommended)

The new `clamav` service in `docker-compose.yml` lives behind the
opt-in `av` compose profile. Internal-only network exposure
(no host port mapping). First boot pulls ~250 MB of signatures
into the persisted `clamav-db` volume; subsequent boots converge
in seconds.

```bash
cat >> .env <<'EOF'
STRATA_AV_BACKEND=clamav
STRATA_AV_FAIL_MODE=block
STRATA_AV_CLAMD_HOST=clamav
STRATA_AV_CLAMD_PORT=3310
EOF
docker compose --profile av up -d
```

Verify with the EICAR test string — see the Verification section
below.

### Shape 2 — External `clamd`

Point at an existing clamd:

```env
STRATA_AV_BACKEND=clamav
STRATA_AV_CLAMD_HOST=clamav.internal.example.com
STRATA_AV_CLAMD_PORT=3310
```

The backend speaks plain TCP — wrap in mTLS via a sidecar proxy
(envoy / stunnel) if the path traverses an untrusted network.
Strata does not currently terminate TLS in-process to clamd.

### Shape 3 — Command-driven

For Microsoft Defender, Sophos, ESET, etc. See the **`command`**
backend section above for full examples and the wrapper-script
pattern.

### Kubernetes

See [deployment-kubernetes.md → Antivirus scanning
sidecar](deployment-kubernetes.md#antivirus-scanning-sidecar-v1120).
TL;DR: dedicated `Deployment + ClusterIP Service + PVC` for
signature DB + a `NetworkPolicy` restricting `clamd:3310` to
backend pods.

## Verification — the EICAR smoke test

[EICAR](https://www.eicar.org/) is a 68-byte string that every
mainstream AV engine recognises as a test virus. It is NOT
malware — it's safe to handle and is the canonical "is my AV
plumbing wired correctly?" probe.

### Prerequisites

Before running the test, make sure your test account satisfies
all three of the following — otherwise you'll see auth errors
that look like AV failures but are actually unrelated:

1. **You're logged in** and have captured the `access_token`
   cookie value (DevTools → Application → Cookies, or the curl
   `-c` flag during a login round-trip).
2. **Your role has "Use Quick Share" enabled** (Admin → Roles →
   *role* → toggle **Use Quick Share** → Save). Super-admins
   bypass this check via `can_manage_system`. Without one of
   those flags the upload endpoint returns
   `403 {"code":"FORBIDDEN","error":"Forbidden"}` long before the
   AV scanner ever sees the bytes. **Log out / back in after
   changing the role** so the new claims land in your cookie.
3. **You have an active session ID** to attach the upload to.
   The easiest way to grab one is:
   ```bash
   curl -ksS https://strata.example.com/api/sessions \
     -H "Cookie: access_token=$STRATA_TOKEN" | jq -r '.[0].id'
   ```

> **Heads-up on copy-paste.** The command below uses bash
> backslash-newline continuations. If you paste it into a shell
> that strips the `\` (some terminals + Windows PowerShell), each
> line will run as its own command and you'll see a stream of
> `curl: (6) Could not resolve host: -H` / `-F` errors mixed in
> with a single `{"code":"FORBIDDEN"}` from the first orphaned
> `curl` call. Either keep the backslashes intact or collapse the
> whole thing onto one line.

### Run the test

```bash
# 0. Export the three values from the prerequisites above.
export STRATA_TOKEN="<your access_token cookie value>"
export STRATA_SESSION="<an active session id>"

# 1. Write the test string to a file (note the literal backslash escape
#    and the dollar-sign escapes for shell safety)
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.com

# 2. Submit through Strata as a normal Quick Share upload
curl -sS -X POST https://strata.example.com/api/files/upload \
  -H "Cookie: access_token=$STRATA_TOKEN" \
  -F "session_id=$STRATA_SESSION" \
  -F "file=@/tmp/eicar.com"

# Expected:
# HTTP 400
# {"error":"validation","message":"File rejected by malware scan: Win.Test.EICAR_HDB-1"}

# 3. Verify the audit row landed
docker compose exec postgres-local \
  psql -U guacuser -d guacclient -c "
    SELECT created_at, actor_user_id, details
    FROM audit_logs
    WHERE action='file.av_blocked'
    ORDER BY created_at DESC LIMIT 1;"

# 4. Cleanup
rm /tmp/eicar.com
```

### Reading the result

| HTTP status & body                                                           | What it means                                                                                                                                         | Next step                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `400 {"error":"validation","message":"File rejected by malware scan: ..."}`  | **Success.** Scanner is wired and matched the EICAR signature.                                                                                        | Done — check the audit row in step 3.                                                                                                                  |
| `200 OK` with a `download_url`                                               | Scanner is **not** running.                                                                                                                            | Check `STRATA_AV_BACKEND` isn't `off`; `docker compose exec backend nc -zv clamav 3310`; `docker compose logs clamav \| grep 'database loaded'`.       |
| `401 Unauthorized` / `{"code":"UNAUTHORIZED"}`                               | `$STRATA_TOKEN` is missing, empty, expired, or for a different host.                                                                                  | Re-log-in and re-export the cookie value.                                                                                                              |
| `403 {"code":"FORBIDDEN","error":"Forbidden"}`                               | Cookie is valid but the user's role lacks **Use Quick Share** (and isn't super-admin).                                                                 | Enable the role flag in Admin → Roles, then log out and back in.                                                                                       |
| `400 {"error":"validation","message":"Missing session_id field"}` (or file)  | The multi-line command got split — only the URL/headers reached curl.                                                                                  | Keep the `\` line-continuations intact or run it all on one line.                                                                                      |
| `400 {"error":"validation","message":"Antivirus scan failed: INSTREAM size limit exceeded. ERROR"}` | clamd's `StreamMaxLength` (default 25 MB upstream) tripped on the upload size. The bundled sidecar raises it to 512 MB; this surfaces when running against an external clamd you control. | Mount [clamav/clamd.conf](../clamav/clamd.conf) into your clamd, or raise `StreamMaxLength`, `MaxFileSize`, and `MaxScanSize` directly. Keep them all ≥ `STRATA_AV_MAX_SCAN_SIZE`. |
| `400 {"error":"validation","message":"Antivirus scan failed: clamd scan exceeded ... ms"}` | Scan didn't finish before `STRATA_AV_TIMEOUT_MS` (default 120000). Common on huge nested archives or undersized clamd.                                | Either raise `STRATA_AV_TIMEOUT_MS`, give clamd more CPU/RAM, or lower `STRATA_AV_MAX_SCAN_SIZE` so the biggest files are oversize-skipped instead.    |

## Operational considerations

### Signature freshness

The ClamAV sidecar runs `freshclam` on startup and once per day.
Operators in air-gapped environments should mirror
`https://database.clamav.net/main.cvd`, `daily.cvd`, and
`bytecode.cvd` into a private repo and override `freshclam.conf`:

```ini
# clamav-freshclam.conf
DatabaseMirror http://av-mirror.internal.example.com
ScriptedUpdates yes
Checks 24
```

Mount as `/etc/clamav/freshclam.conf` on the sidecar.

### Scan latency

Typical INSTREAM scan times on the bundled sidecar (1.4 GB
resident DB, 2 vCPU):

| File size | Median | p95   |
| --------- | ------ | ----- |
| 100 KB    | 12 ms  | 35 ms |
| 10 MB     | 90 ms  | 240 ms |
| 100 MB    | 700 ms | 1.4 s |

These add to upload latency. For Quick Share workloads (typically
<1 upload/sec/node) the overhead is unobservable. If your site
runs high-volume bulk uploads, consider raising
`STRATA_AV_MAX_SCAN_SIZE` to a smaller value (so oversize files
skip the scan) or running multiple clamd replicas.

### Signature DB size + memory

The signature DB compiles down to ~1.4 GB resident. The bundled
sidecar caps memory at 3 GB which is comfortable. Below 1.5 GB
clamd will OOM-kill mid-load and `freshclam` will fail to
refresh. Plan accordingly when sharing a host with other
services.

### Timeout tuning

`STRATA_AV_TIMEOUT_MS=30000` (30 s) covers the p99 of the size
distribution above. For sites that allow uploads up to the
500 MB Quick Share ceiling, raise to 60 000–90 000 to absorb
the long tail. Timeout produces `Verdict::Error` which becomes
a block under the default `STRATA_AV_FAIL_MODE=block`.

## Troubleshooting

### `clamd` daemon unreachable

```
ERROR av: scan failed: tcp connect: Connection refused
upload rejected: scanner error
```

- Check the compose profile: `docker compose ps clamav`. If the
  container isn't running, `docker compose --profile av up -d`.
- Check the network: `docker compose exec backend nc -zv clamav 3310`.
  Should print "open" within ~1 s.
- Check the DNS: `docker compose exec backend getent hosts clamav`.
  Should resolve to the sidecar's container IP.

### First-boot signature pull is slow

```bash
docker compose logs -f clamav | grep -Ei '(database|freshclam)'
```

Expect ~3–5 minutes on a normal-bandwidth host. The healthcheck's
`start_period: 300s` covers this — if the container goes
unhealthy *during* the first pull, check that you have ≥250 MB of
outbound bandwidth and that clamav.net isn't being blocked at
your egress.

### False positive on a legitimate file

ClamAV's heuristic and macro scanners occasionally flag legitimate
files (especially Office documents with macros, or installers
that ship UPX-packed binaries). To unblock a user immediately:

1. Verify the file is legitimate (run it past a second-opinion
   scanner, check the hash on VirusTotal).
2. Add the signature to the local whitelist:
   ```bash
   docker compose exec clamav sh -c 'echo "<signature-name>" >> /var/lib/clamav/whitelist.fp'
   docker compose restart clamav
   ```
3. Report the false positive to upstream ClamAV.

Switching to a commercial engine via the `command` backend
typically eliminates this class of false positive at the cost of
licensing.

### Scanner blocking everything in degraded-open mode

If `STRATA_AV_FAIL_MODE=allow` and uploads are *still* being
blocked, the verdict is `Infected`, not `Error`. `allow` mode
does **not** override infected verdicts — by design. To unblock
a specific signature, whitelist it as above; to disable scanning
entirely, set `STRATA_AV_BACKEND=off` and restart the backend.

## Roadmap

See [roadmap.md → Antivirus scanning](roadmap.md#antivirus-scanning-on-quick-share-uploads) for future work:

- Per-role / per-connection scan policy editor.
- Multi-engine majority-verdict aggregator.
- Async post-upload scan with quarantine for sites where inline
  latency is unacceptable.

## Related

- [ADR-0011 — Antivirus scanning trait](adr/ADR-0011-av-scanning.md)
- [Operator runbook — AV operations](runbooks/av-operations.md)
- [Deployment guide — Antivirus scanning](deployment.md#antivirus-scanning-v1120)
- [Kubernetes deployment guide — Antivirus scanning sidecar](deployment-kubernetes.md#antivirus-scanning-sidecar-v1120)
- [Threat model — Quick Share file mover STRIDE](threat-model.md#211-quick-share-file-mover-inbound--outbound-v1120-av-update)
- [Security model — Outbound Quick Share mitigations](security.md)
- [Source — `backend/src/services/av.rs`](../backend/src/services/av.rs)
- [Migration — `backend/migrations/078_av_scanning.sql`](../backend/migrations/078_av_scanning.sql)
