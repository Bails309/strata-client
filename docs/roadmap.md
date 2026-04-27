# Strata Client Roadmap

This roadmap captures proposed feature work beyond the current shipped releases.
All items below are **Proposed** and unscheduled; they represent direction and
intent, not committed delivery dates.

Status legend:

- **Proposed** — accepted into the roadmap but not yet scheduled
- **Researching** — under active design / spike
- **In progress** — on a development branch
- **Shipped** — released (see *What's New*)

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

## Rendering & Session Quality

### In-session IDR keyframe request (H.264 ghost recovery)
**Status:** Shipped in v0.27.0
**Area:** `guacd` · `SessionClient`

Reports during v0.26.x testing surfaced a class of rendering corruption
where rapid window minimise/maximise cycles cause H.264 GFX
reference-frame desynchronisation between the server-side encoder and
the in-browser decoder. The canvas ends up showing multiple overlapping
window states at once and no client-side operation can recover the true
frame — the decoder state itself is corrupt.

Before v0.27.0 the only recovery was clicking **Reconnect** in the
Session Bar, which tears down and re-establishes the tunnel — effective
but visible (~1 s of black screen plus the cost of a fresh TLS/Guac
handshake).

**Shipped implementation:** rather than introduce a new Guacamole
protocol opcode (which would require patching `guacamole-common-js`
and version-handshake logic), v0.27.0 hijacks the existing `size`
instruction. The forked guacd
([`guacd/patches/004-refresh-on-noop-size.patch`](../guacd/patches/004-refresh-on-noop-size.patch))
intercepts a `size W H` whose dimensions match the current remote
desktop size and calls `context->update->RefreshRect()` with full-screen
dimensions. Frontend wires `manualRefresh()` in `SessionClient.tsx` so
the Session Bar's Refresh Display button now does compositor nudge +
no-op `sendSize(cw, ch)`. A 1-second per-session cooldown in the patch
prevents flood conditions. Approach is invisible at the wire-protocol
layer: stock guacd silently ignores the no-op resize, so the frontend
change runs safely against un-patched containers.

Follow-up ideas (not yet planned):
- **Auto-refresh on prolonged flush silence.** An earlier attempt at
  auto-trigger on "no `onflush` for 1.5s" was reverted in v0.26.0 for
  false-positive firing. A revisit once the v0.27.0 refresh path is
  field-tested could re-introduce it with a longer threshold.
- **Refresh Rect behaviour telemetry.** We currently have no
  observability into whether a given server actually emits an IDR in
  response. A per-connection counter (`refresh_rect_sent`,
  `frame_received_after_refresh_delta_ms`) would quantify real-world
  effectiveness across the Windows/Linux RDP target spread.

---

## Protocols & Session Types

### Web Browser Sessions
**Status:** Shipped (v0.30.0)  
**Area:** Protocols · Sessions · guacd  
**Roadmap ID:** `protocols-web-sessions`

New `web` connection type that launches an ephemeral Chromium kiosk inside an
Xvnc display and tunnels it through guacd as a standard VNC session. Brings
parity with [rustguac](https://github.com/sol1/rustguac)'s web-session feature.

Scope:

- Backend service `web_session.rs` with display allocator (`:100`–`:199`) and
  ephemeral profile dir under `/tmp/strata-chromium-{uuid}`.
- Optional credential autofill via Chromium's encrypted Login Data SQLite
  (PBKDF2 `peanuts`/`saltysalt`, AES-128-CBC, v10 prefix).
- Allowed-domain enforcement via Chromium `--host-rules`; egress further bounded
  by a `web_allowed_networks` CIDR list at the backend.
- Login automation via Chrome DevTools Protocol on per-session ports
  `9200`–`9299` with a 120 s timeout.
- Frontend: new `WebSections.tsx` in the connection form (URL, allowed domains,
  autofill builder, login-script picker). `AdSyncTab` guarded to
  `rdp|ssh|vnc` only — `web` is interactive-create only.

### VDI Desktop Containers
**Status:** Shipped (v0.30.0)  
**Area:** Protocols · Sessions · Infrastructure  
**Roadmap ID:** `protocols-vdi-containers`

New `vdi` connection type that provisions a Docker container running `xrdp` on
demand and tunnels it through guacd as a standard RDP session. Brings parity
with [rustguac](https://github.com/sol1/rustguac)'s VDI feature.

Scope:

- `VdiDriver` trait with a `DockerVdiDriver` (bollard) v1; future drivers
  (Nomad, Proxmox) deferred.
- Container reuse-by-name; persistent home via bind mount under a configurable
  `home_base`.
- Idle reaper extension to `session_cleanup.rs`; logout vs tab-close
  differentiation from xrdp disconnect reason.
- Image whitelist surfaced via `GET /api/admin/vdi/images`; sample image at
  `contrib/vdi-sample/`.
- Frontend: new `VdiSections.tsx` (image picker, CPU/memory/idle limits,
  env-var editor, persistent-home toggle).
- Security: `docker.sock` = host root — opt-in via `docker-compose.yml`.
  Production guidance recommends a privileged sidecar exposing a narrow gRPC
  API rather than mounting the socket directly.
- **Out of scope v1:** shared driver state across multi-replica backends.

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
index. Auditors can then query the entire archive (e.g. *find every session
where a window titled "Payroll" was opened* or *every time `sudo rm -rf`
appeared on screen*) and jump directly to the timestamp.

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

Dashboards for users (*my sessions this month, time spent per host*) and
admins (*top users by access volume, idle servers, peak concurrency*).
Exportable CSV / PDF for management reporting.

---

## Workflows & Collaboration

### Multiplayer / Co-Pilot Mode
**Status:** Proposed  
**Area:** Sessions · Collaboration

Extend the current share-link feature into real-time collaboration:

- **Named, distinct cursors** per participant (colour + label)
- **Text chat** overlay anchored to the session
- **WebRTC audio** channel (optional, browser-native) for voice assist
- Turn-based keyboard handoff to prevent input collisions

Primary use cases: pair programming, IT remote support, and on-boarding.

### Quick-Share Outbound (Approval-Gated)
**Status:** Proposed  
**Area:** File Transfer · DLP

Mirror of the existing inbound Quick-Share but in reverse: a user in a
session requests to export a file. The file is copied to a **staging area**
(encrypted at rest) and held until:

- A designated admin approves the release, **or**
- An automated DLP policy clears the content.

Approved files are released to the user's browser as a time-limited download;
rejected files are purged. Every request + decision is logged.

---

## Notifications & Email

### Modern Managed-Account Notification Emails
**Status:** Shipped (v0.25.0)  
**Area:** Notifications · Email · Managed Accounts

Redesigned transactional emails covering the full managed-account checkout
lifecycle — **approval**, **rejection**, and **self-approval** — sent
automatically from a single modern template. Renders cleanly in Outlook
(dark-mode safe) and mobile clients.

Every email includes:

- Requesting user (display name + username)
- Target AD account being accessed
- Justification supplied with the request
- Expiry / TTL of the granted checkout
- Approver identity (self-approval is labelled as such)
- One-click links back to the approvals page and the audit log entry

Tenant-brandable header + footer with a neutral fallback so bare deployments
still look professional.

---

*Have a feature suggestion? Raise an issue in the project tracker and tag it
`roadmap`.*
