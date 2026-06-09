# Strata Client Roadmap

This roadmap captures proposed feature work beyond the current shipped releases.
All items below are **Proposed** and unscheduled; they represent direction and
intent, not committed delivery dates.

Status legend:

- **Proposed** — accepted into the roadmap but not yet scheduled
- **Researching** — under active design / spike
- **In progress** — on a development branch
- **Shipped** — released (see _What's New_)

## Lifecycle of shipped items

Shipped entries stay on the roadmap for **one minor version** after the
release that delivered them, then are removed. In practice:

- An item marked **Shipped** during the `0.N.x` line (any patch release)
  remains visible for the rest of that line.
- When `0.(N+1).0` is cut, every entry that was flagged **Shipped** during
  `0.N.x` is deleted from this document, and any matching override rows in
  `system_settings.roadmap_statuses` are cleared in the same change.
- The canonical record of past releases lives in
  [`CHANGELOG.md`](../CHANGELOG.md) and
  [`WHATSNEW.md`](../WHATSNEW.md); the roadmap is intentionally
  forward-looking.

---

---

## Protocols & Session Types

### Kubernetes Pod Console

**Status:** Proposed
**Area:** Protocols · guacd

Native terminal execution inside Kubernetes pods without requiring SSH or
tunnels to the node. Uses the backend's Kubernetes client to pipe stdin/stdout
to the guacd WebSocket stream.

---

## Recording Enhancements

### Historic Recording Screenshots

**Status:** Proposed  
**Area:** Recordings · Client

While playing back a historic recording, a dedicated capture button snapshots
the current video frame. The client keeps a rolling buffer of the **most
recent 5 screenshots**; the sixth capture overwrites the oldest. Screenshots
are held **in-memory only** while the playback page is open — nothing is
persisted server-side.

Users can preview the buffer, reorder, and download individual screenshots
(PNG) or all 5 as a zip for incident documentation. Leaving the page clears
the buffer.

### Automatic PII Redaction in Recordings

**Status:** Researching  
**Area:** Recordings · Privacy · Compliance

On-the-fly redaction of personally identifiable information (PII) in recorded
sessions so reviewers never see raw data. Candidate approach: OCR pass over
rendered frames detects patterns (NI numbers, credit-card PANs, email
addresses, etc.) and overlays a blur / black bar on the affected regions in
the played-back stream.

Redaction rules should be configurable per tenant / per connection tag, with
an audit trail of every rule change.

---

## Security & Zero Trust Access

### Antivirus scanning on Quick Share uploads

**Status:** Shipped — v1.12.0 (operator-experience polish in v1.12.1)
**Area:** File Transfer · DLP

Pluggable AV scanner runs against both Quick Share upload paths
(inbound `POST /api/files/upload` and outbound
`POST /api/user/outbound-shares/submit` plus its token-auth shell
variant `POST /api/outbound-shares/ingest/{token}`). Three backends
ship: `off` (default no-op, preserves v1.11.x behaviour), `clamav`
(full `clamd` INSTREAM TCP wire protocol against the opt-in
bundled sidecar), and `command` (exit-code contract for Microsoft
Defender, Sophos, ESET, or any wrapper script). Fail-closed by
default (`STRATA_AV_FAIL_MODE=block`); infected verdicts are
always rejected. Migration 078 persists the verdict on each
`outbound_shares` row in four new columns (`av_scan_status`,
`av_signature`, `av_scanned_at`, `av_scanner_backend`) with a
partial index keeping the operator-attention dashboard query
cheap. See [av-scanning.md](av-scanning.md),
[ADR-0011](adr/ADR-0011-av-scanning.md), and the
[av-operations runbook](runbooks/av-operations.md).

**v1.12.1 follow-on (Shipped):** friendly user-facing block
messages (`Verdict::user_facing_block_message()`), hourly
`freshclam` + forced `clamd` reload after every signature update,
500 MiB default scan-size cap aligned with the Quick Share upload
cap, real on-wire CVD / `clamd` fixtures in the unit suite, and
two new admin surfaces — `GET /api/admin/health/av` (AV Health
card on Admin → Health tab) and `GET /api/admin/files/av-blocked`
(unified Admin → AV-Blocked Files audit grid covering inbound
`file.av_blocked` events and outbound `(infected|error)` rows).
The outbound copy-snippet flow gained an indeterminate "Awaiting
AV scan" progress indicator plus explicit `Expect: 100-continue`
suppression in the shipped curl / PowerShell snippets so progress
meters render even when the public ingest router rejects a stale
token with `400 Bad Request`.

Future iterations on the trail of this feature live below as
separate proposals.

### Per-role AV scan-policy editor

**Status:** Proposed (v1.12.0 builds the substrate)
**Area:** File Transfer · DLP

The v1.12.0 scanner is a single global engine selected by env var.
A future admin UI would let operators define per-role or
per-connection policies — e.g. "Tier-3 SOC roles bypass the
oversize-skip ceiling because they handle disk images", or
"Customer-facing connections always reject any `application/x-msdownload`
regardless of scan verdict". The four-column verdict shape on
`outbound_shares` already supports per-row policy correlation
without a new migration; the missing piece is the policy
authoring UI and a `policy_id` column on the audit row.

### Multi-engine AV with majority verdict

**Status:** Proposed
**Area:** File Transfer · DLP

Some compliance regimes require two independent engines to clear
a file before egress. The `Scanner` trait already supports this
shape — a `MultiScanner { engines: Vec<Arc<dyn Scanner>>, mode:
{ All, Majority, Any } }` would be a thin wrapper. Surface the
per-engine verdicts as an array on the audit row rather than a
single `av_signature` field.

### Color-Coded Security Tiers ("Red" Servers)

**Status:** Proposed  
**Area:** Access Control · Auth

Introduce a visible tiering scheme for ultra-sensitive environments (PCI,
PII-processing hosts, DR controllers). Servers flagged **Red** require a
genuine third factor on top of the existing username + password / SSO:

- Mutually-authenticated device certificate, **or**
- Hardware security token (YubiKey, FIDO2)

Lower tiers (Green / Amber) retain the current auth flow. UI clearly badges
tier throughout the dashboard, session bar, and admin views.

### Immutable Security Flags

**Status:** Proposed  
**Area:** Access Control · Governance

A Red designation must **not** be downgradable from the standard admin UI so
a compromised admin account cannot quietly weaken a high-tier host. Options:

- Tier definitions loaded from a read-only config file / IaC source at boot
- DB constraint + signed change-log requiring two-person approval
- Write-once column: once a connection is marked Red, only a filesystem /
  IaC change can revert it

### Context-Aware Access (Device Posture)

**Status:** Proposed  
**Area:** Access Control · Client

Before a session — especially to Red hosts — the client evaluates local
posture:

- Source IP within a recognised corporate CIDR
- OS patch level within policy window
- Active endpoint protection / AV signatures fresh
- Disk encryption enabled

Failures block the connection (Red), warn the user (Amber), or log silently
(Green). Posture checks are performed client-side and cryptographically
attested to the backend.

---

## Auditing, Analytics & Compliance

### OCR Over Recorded Sessions

**Status:** Proposed  
**Area:** Auditing · Search

Background OCR job transcribes rendered text from recordings into a searchable
index. Auditors can then query the entire archive (e.g. _find every session
where a window titled "Payroll" was opened_ or _every time `sudo rm -rf`
appeared on screen_) and jump directly to the timestamp.

### Anomaly Detection

**Status:** Researching  
**Area:** Auditing · Risk

Learn each user's normal access pattern (servers, times, source IPs,
protocols). Flag significant deviations — e.g. a UK-hours developer suddenly
hitting a finance DB at 03:00 from a new IP — and either:

- Block and require JIT approval, or
- Allow but elevate to real-time review.

Model is per-user; alerts are written to the audit log and surfaced on the
admin dashboard.

### Personal Metrics & Usage Reports

**Status:** Proposed  
**Area:** Analytics

Dashboards for users (_my sessions this month, time spent per host_) and
admins (_top users by access volume, idle servers, peak concurrency_).
Exportable CSV / PDF for management reporting.

---

## Workflows & Collaboration

### Quick-Share Outbound (Approval-Gated)

**Status:** Shipped in v1.11.0  
**Area:** File Transfer · DLP

Mirror of the existing inbound Quick-Share but in reverse: a user in a
session requests to export a file. The file is copied to a **staging area**
(encrypted at rest) and held until:

- A designated admin approves the release, **or**
- An automated DLP policy clears the content.

Approved files are released to the user's browser as a time-limited download;
rejected files are purged. Every request + decision is logged.

For environments where group policy disables RDP / SFTP drive redirection
(so the in-session virtual drive interceptor never fires), v1.11.0 also
ships an **HTTPS upload-command** path: the Outbound Share panel mints a
single-use, 10-minute token rendered as a `curl` / `curl.exe` / PowerShell 7
`-Form` one-liner. The user pastes it inside the remote session shell; the
file uploads back over HTTPS on the connection the browser is already
using (no SMB, no port 445, no drive channel) and runs through the same
DLP / approval / audit pipeline. Tokens are bound to the minting user +
session + connection + justification, burn on first use, and re-check the
user's `can_use_quick_share_outbound` permission at consume time.

---

## Notifications & Email

---

_Have a feature suggestion? Raise an issue in the project tracker and tag it
`roadmap`._
