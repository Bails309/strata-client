# Strata Client Roadmap

This roadmap captures proposed feature work beyond the current shipped releases.
All items below are **Proposed** and unscheduled; they represent direction and
intent, not committed delivery dates.

Status legend:

- **Proposed** — accepted into the roadmap but not yet scheduled
- **Researching** — under active design / spike
- **In progress** — on a development branch
- **Shipped** — released (see *What's New*)

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
**Status:** Proposed  
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
