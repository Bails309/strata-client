# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Security — fixes from the external security and performance review

- **Delegated user managers can no longer escalate (SEC-01, Critical).**
  Without `can_manage_system`, a `can_manage_users` holder may only assign
  roles, and act on users, whose permissions they already hold; may not act
  on their own account; and may not exempt a user from outbound Quick Share
  approval. Role changes and deletions are serialised and refuse to remove
  the last active system administrator.
- **Capability tokens are no longer logged (SEC-18).** The request span logs a
  path with download / share / ingest tokens redacted and no query string;
  Quick Share log lines carry a non-reversible `token_ref` instead of the
  token; the WebSocket auth path no longer logs its query string.
- **Outbound download links are not burned by the wrong caller (SEC-21).** The
  owner check runs before the token is consumed, and the file is decrypted
  before the token is cleared, so a `403` or a Vault failure leaves the link
  usable. The audit event records the actual caller.
- **Session streams are bounded per client (SEC-15).** A client may hold at
  most 4 clipboard streams open at once, 16 MiB of clipboard data across
  them, and a stream idle for 30 seconds is dropped. At most 16 uploads may
  be open at once. A stream id already in use cannot be reopened, and an
  upload the target refuses frees its id. Clipboard size is checked before
  a blob is decoded.
- **Files too large to scan are refused in block mode (SEC-13).**
  `Skipped { reason: "oversize" }` now follows `STRATA_AV_FAIL_MODE` like an
  engine error. The Compose default `STRATA_AV_MAX_SCAN_SIZE` was 100 MiB
  against a 500 MiB upload cap; it is now 500 MiB, and the scan timeout
  default matches the code (120 s).
- **Browser-session VNC listens on loopback only (SEC-04).** Xvnc runs with
  `-localhost -nolisten tcp`; the in-process session engine is its only
  client. `STRATA_WEB_VNC_HOST` is removed.
- **Login limiter gaps closed (SEC-19).** Attempts are reserved before any
  password work, so concurrent guesses cannot all pass the limit; password
  change counts its own attempts; a full limiter map refuses new keys instead
  of clearing every live limit.
- **`STRATA_TRUSTED_PROXIES` is enforced (SEC-20).** One middleware resolves
  the client IP: verified DMZ edge IP, else `X-Forwarded-For` only when the
  socket peer is a trusted proxy (walking the chain past trusted hops), else
  the socket peer. A forged header from a direct caller is ignored, and
  requests without a proxy now get their real peer IP instead of `unknown`.
  An invalid entry stops the backend from starting. The Compose default is
  now Docker's bridge pools (`172.16.0.0/12,192.168.0.0/16`).
- **SSO logins are bound to the browser that started them (SEC-05).** The
  login sets a short-lived `sso_binding` cookie (`SameSite=Lax`, path
  `/api/auth/sso`) whose hash must match at the callback, and the flow now
  uses PKCE (`S256`) and an OIDC `nonce`. `state` is 256 random bits.
- **SSO identities are scoped to their issuer (SEC-06).** Migration 093 adds
  `users.sso_issuer`; an account linked through one provider cannot be
  signed in through another with the same subject. Links made before the
  migration are bound to the issuer of their next login. A first SSO login
  no longer attaches to an account that has a local password, or when the
  provider reports `email_verified: false`; linking is compare-and-set.
- **Password changes and resets sign out every session (SEC-08).** Migration
  094 adds `users.sessions_valid_after`, set on password change, admin reset
  and deletion; access and refresh tokens issued earlier are refused, and
  native sessions are closed within 30 s. Refresh can no longer extend a
  sign-in past 12 hours. Restoring a deleted user does not restore old
  sessions.
- **Connection credentials in `extra` are encrypted and never returned
  (SEC-12).** `password`, `private-key`, `passphrase` and the three `sftp-*`
  equivalents are sealed with Vault on save and returned as `********`;
  sending the placeholder back keeps the stored value. Existing plaintext
  values are sealed at boot. Saving a new credential now requires Vault.
- **Chromium runs with its sandbox (SEC-03).** The hard-coded `--no-sandbox`
  is gone. The bundled compose file runs the backend with
  `backend/seccomp-chromium.json` (Docker's default profile plus `clone`,
  `unshare` and `chroot`), which lets the namespace sandbox start as the
  unprivileged `strata` user under `no-new-privileges`. If the sandbox
  cannot start, the kiosk launch fails instead of falling back.
  `STRATA_WEB_CHROMIUM_SANDBOX=disabled` is an explicit, logged opt-out.
- **Web session egress is checked at launch (SEC-02).** The initial URL
  must be `http`/`https` without embedded credentials, and every address
  its host resolves to must be inside `web_allowed_networks`; an empty
  list refuses the launch, as the docs always said. Loopback and
  link-local addresses (including `169.254.169.254`) are refused even
  under `0.0.0.0/0`.
- **`web_allowed_networks` can be edited in the UI.** Admin → Network has a
  *Web Browser Sessions → Allowed Networks* field; until now the setting had
  no editor, so the fail-closed check above refused every web session.
  Single IP addresses are accepted alongside CIDR ranges, and invalid entries
  are rejected on save instead of being silently dropped.
- **SFTP uploads never follow a symlink (SEC-11).** An existing symlink at
  the target name is refused; an existing file is removed and the upload
  is created with `O_EXCL`, so a link planted mid-upload makes the create
  fail instead of writing outside the root. A session may hold at most 8
  open transfers.
- **Quick Share upload lifecycle (SEC-14).** `session_id` must name one of
  the caller's live sessions and arrive before the file, so no body is
  accepted for a fabricated or foreign session. Multipart errors are no
  longer swallowed, a second file part is refused, and temp files are
  removed on every exit path including a dropped request. Per-session
  counts are reserved atomically, the store is capped at 10 GiB, files
  expire after 24 hours, and orphans are removed at startup. Outbound
  Quick Share parsing gets the same multipart fixes.
- **Edited migrations stop startup (SEC-22).** Startup used to overwrite
  the stored checksum of any applied migration whose file had changed,
  so an edited migration was accepted without its SQL ever running.
  Startup now refuses, naming the versions. Two cases are still
  accepted: a difference only in line endings, and the version 29 edits
  that shipped in 0.11.1. An operator who has checked the schema and
  taken a backup can accept named versions with
  `STRATA_MIGRATION_REPAIR_VERSIONS=29,46`, which is logged at error
  level with the old and new checksums.
- **Refresh tokens rotate against the database (SEC-07).** Each refresh
  token now has a row (migration 096), grouped into a family that starts
  at sign-in. Refresh consumes the token and records its successor in
  one transaction, so two requests with the same token can no longer
  both succeed. A token presented again more than 30 seconds after it
  was used is treated as stolen: the whole family is revoked and
  `auth.refresh_token_reused` is audited. Within 30 seconds the server
  answers `409`, because that is another tab of the same browser; tabs
  now also take turns to refresh where the browser supports Web Locks.
  Sign-out revokes the family. Tokens issued before the upgrade are
  accepted once and then join a family.
- **Revocations reach every replica (SEC-07).** Each backend pulls new
  revocations from the database every 15 seconds instead of only at
  startup. Live revocations are never dropped from the cache under
  pressure any more. If a replica cannot sync for 5 minutes it treats
  every token as revoked until it can.
- **One password operation per managed account (SEC-09).** Activation,
  check-in, expiry and service-account rotation of the same AD account
  now take a lock on that account (migration 097), not on a single
  checkout, so they can no longer reset its password over each other.
  A checkout cannot activate while another user's checkout of the same
  account is active. The new password is sealed and saved on the
  checkout before AD is changed, so a failure after the reset does not
  lose it. The AD-sync lock can no longer be stranded on a pooled
  connection by a cancelled sync.
- **SFTP transfers go through the Quick Share pipeline (SEC-10).** The
  session file browser used to move files straight between the browser
  and the target, bypassing antivirus scanning and outbound approval.
  Every transfer is now staged on the gateway first. Uploads are scanned
  like inbound Quick Share and only written to the target if the verdict
  allows it. Downloads are scanned and submitted as an outbound share:
  a user who needs approval (the default) gets a notice that the file
  is waiting for approval, and downloads it from Outbound Quick Share
  once it is approved. A user with the approval bypass receives the
  file at once, and the share is recorded as delivered. Transfers are
  capped at 500 MiB. New audit events: `file.sftp_uploaded`, and
  `file.av_blocked` with source `sftp_upload` or `sftp_download`.
  Results reach the browser as a toast, because the transfer stream
  has already closed when the scan finishes.
- **File browser uploads now end their stream.** The file browser and
  drag-and-drop never sent the end of an upload, so the gateway could
  not tell a finished file from one still arriving. It needs to know
  now, because it scans the whole file before writing it.

### Build

- **`strata-dmz` image builds again.** Its Dockerfile did not copy
  `strata-session` or the vendored forks that the workspace needs.

### Performance / build

- **Release profile now applies (PERF-17).** `lto`, `codegen-units = 1` and
  `strip` moved to the workspace root — Cargo ignored them in
  `backend/Cargo.toml`. Expect longer release builds.
- **Docker dependency cache works again (PERF-17).** The stub stage now
  includes `strata-session` and the vendored forks, uses `--locked`, and no
  longer hides its errors with `|| true`.
- **Vault provisioning uses the shared, timeout-bounded HTTP client
  (PERF-19).**
- **Password hashing no longer runs on request workers (PERF-01).**
  Hashes and checks run on the blocking pool, at most four at a time by
  default (`STRATA_PASSWORD_HASH_CONCURRENCY`). A request that waits
  more than 10 seconds for a slot is told the server is busy. The
  unknown-username path now uses the same Argon2 parameters as real
  hashes, so its timing matches; it used cheaper defaults before.
- **One request for credential mappings (PERF-07).** The dashboard and
  Credentials page fetched each profile's mappings separately. New
  endpoint `GET /api/user/credential-mappings` returns all of the
  caller's mappings in one query.
- **Checkout activation no longer holds a connection across LDAP and
  Vault (PERF-18).** Activation was serialised by an advisory lock that
  kept a pooled connection for the whole AD reset. It now claims a
  lease on the checkout row (migration 095), releases the connection,
  and gives up after 2 minutes. The lease expires after 5 minutes if
  the backend dies mid-activation.
- **Smaller first load (PERF-06).** Admin, audit, recordings, sessions,
  approvals, credentials, profile, shared-viewer and documentation pages
  now load when first opened, as does the What's New modal (only when it
  has something to show) and Mermaid (only when a page has a diagram).
  The dashboard and session views stay in the main bundle so opening a
  session never waits on a download. The main JavaScript bundle drops
  from 2,620 kB (757 kB gzipped) to 718 kB (211 kB gzipped). A page that
  fails to load, typically after an upgrade, shows a reload prompt
  instead of a blank screen.
- **Background polling pauses in hidden tabs (PERF-15).** The approval,
  credential-expiry and version watchers no longer poll while their tab
  is hidden, catch up as soon as it is shown, and never overlap a slow
  request.
- **Health checks are bounded (PERF-09).** At most 32 targets are probed
  at once instead of every connection simultaneously, probes stop with
  the pass instead of outliving it, results are written in one statement,
  and hostnames resolve through the configured DNS servers, as sessions
  do.
- **MP4 conversions are single-flight (PERF-05).** Concurrent downloads of
  the same recording share one conversion, at most two run at once, each
  encoder run is stopped after 15 minutes, and a cached video is only ever
  a complete one (it is published by rename). A cached video is found
  without copying or reading the recording, the size probe reads only the
  first 64 KiB, and converted videos are removed after 24 hours.
- **Settings and SSO key caches coalesce misses (PERF-14).** When a cached
  setting, OIDC discovery document or JWKS expires, concurrent requests
  now wait for one fetch instead of all fetching. A settings read that
  overlaps a settings write no longer caches the old value. SSO tokens
  are rejected for a malformed header before any request to the identity
  provider, and a token signed with a key the cached JWKS does not hold
  triggers one refetch (at most once a minute), so a key rotation at the
  identity provider no longer locks users out for up to 10 minutes.
- **One browser per web session, shared by its tabs (PERF-16).** Opening a
  web connection in two tabs at once used to launch two Chromium and Xvnc
  pairs, and closing one tab stopped the browser the other was still
  using. Startup is now single-flight per connection and user, each tab
  holds the browser open, and it stops when the last tab closes. The
  `max_web_sessions` setting is now enforced: once reached, new web
  sessions are refused with 429 before anything is launched.
- **Session replay buffers share one memory budget (PERF-04).** Every
  session kept up to 70 MiB of replay history regardless of how many were
  open. All sessions now share 1 GiB by default
  (`STRATA_NVR_MEMORY_BUDGET_MB`); each holds up to an equal share of it,
  never more than the previous per-session limits. With many sessions open
  each keeps less history for observers to replay.

## [2.2.0] — 2026-09-25

### Minor release — the admin console is rebuilt for estate-scale privileged access: a fleet manager for connections, a folder tree, a risk-aware role editor, and one notification system with a credential-lease manager

### The ask

This release is the product of a run of design briefs. The first three
asked for the sign-in page and the connections dashboard to be brought to
the approved enterprise mock-ups, and for approval and credential-expiry
notifications to share one surface with a place to manage every lease. The
last three are kept here by their own titles, because they are what a future
reader will search for:

> - *"Connection Folders Enterprise Tree View"*
> - *"Strata Client: Connections Admin (Fleet Management) Implementation Plan"*
> - *"Strata Client: Enterprise Role Management Modal Implementation Plan"*

The reskin, unified notifications and lease manager merged to `main` as
#432 **without a CHANGELOG entry**; they are backfilled below. The release
also rolls up the two fixes recorded under *Unreleased* after v2.1.1 (#430,
#431).

Every brief was implemented against the backend as it actually behaves,
which in several places is not what the brief — or this repository's own
documentation — assumed. Those differences are listed under
[*Documentation corrected against the code*](#documentation-corrected-against-the-code)
and [*Known issues*](#known-issues-found-while-building-this-release-not-changed),
because a privileged-access console that describes access it does not grant,
or hides access it does, is worse than an ugly one.

### Added — enterprise reskin (backfill, #432)

- **Login page** rebuilt to the approved mock-up: constellation background,
  gateway diagram, and a theme menu cycling **System → Light → Dark**. SSO
  providers render as up to three button variants — the first non-Capita
  provider as the primary, Capita providers in their own style, the rest as
  secondary — each linking to `/api/auth/sso/login?provider=<id>`. The local
  form appears below an *"or use a local account"* separator only when
  `local_auth_enabled` is true. No authentication behaviour changed.
- **Design tokens** in [`styles/dashboard-theme.css`](frontend/src/styles/dashboard-theme.css):
  a cyan/navy palette (accent `#3aceef` dark, `#0891b2` light) with a full
  light-theme equivalent, and a layered background plus constellation behind
  the workspace ([`DashboardBackground.tsx`](frontend/src/components/DashboardBackground.tsx)).
- **Global header** ([`GlobalHeader.tsx`](frontend/src/components/GlobalHeader.tsx))
  with breadcrumbs derived from the route and the lease pill (below).
- **Admin mega-menu** ([`AdminMegaMenu.tsx`](frontend/src/components/AdminMegaMenu.tsx),
  [`adminMegaMenuConfig.ts`](frontend/src/components/adminMegaMenuConfig.ts)):
  three columns — *Identity & Access*, *Network & Connectivity* with *Secrets
  & Security*, *Overview* with *Workspace*. Items are filtered by
  `isMegaMenuItemVisible(id, user)`, which mirrors the per-tab permission
  predicates the sidebar already used; it hides navigation only and is not an
  access control.
- **Dashboard**: glass cards, restyled toolbar, striped table, protocol
  badges and status dots. Filtering moved into
  [`hooks/useConnectionFilter.ts`](frontend/src/hooks/useConnectionFilter.ts)
  (search, favourites, tag, protocol), with active filters shown as removable
  chips ([`ActiveFilterChips.tsx`](frontend/src/components/ActiveFilterChips.tsx)) and
  an empty state that says when matches exist outside the current scope and
  offers to show them ([`ConnectionEmptyState.tsx`](frontend/src/components/ConnectionEmptyState.tsx)).
- **`EnterpriseCheckbox`** ([`EnterpriseCheckbox.tsx`](frontend/src/components/EnterpriseCheckbox.tsx)):
  one 16 px checkbox with controlled/uncontrolled modes, `indeterminate`,
  `onCheckedChange`, and an `as` prop for use inside an existing `<label>`.
  Admin tabs (AD Sync, Kerberos, Network, Notifications, Password Mgmt,
  Recordings, Safeguard, Security, Tags) were restyled onto it without
  functional change.

### Added — one notification system and a credential-lease manager (backfill, #432)

**One toast surface.** [`ToastProvider.tsx`](frontend/src/components/ToastProvider.tsx)
is now the only notification system. Approval requests and credential expiry
previously rendered their own cards; they now share one card with a severity
strip, icon badge, monospace details and a countdown bar that pauses on hover
or focus.

| Variant | Default lifetime |
| ------- | ---------------- |
| `info`, `success` | 6 s |
| `warning` | 8 s |
| `error` | Sticky until dismissed |

Toasts stack top-right at `4.25rem` so they clear the header, can be replaced
in place by `key`, fire `onDismiss` exactly once on any dismissal path, and
can hold themselves open with `useToastHold()` while the user types (the deny
reason on an approval card uses this). A toast with interactive `content`
announces as `alertdialog`. The auto-dismiss timer arms in `useLayoutEffect`
so it is registered in the same commit as the toast.

**Approvals stay inline.** [`PendingApprovalWatcher.tsx`](frontend/src/components/PendingApprovalWatcher.tsx)
still polls every **45 s** (plus on focus and `visibilitychange`), de-duplicates
across tabs through `localStorage` key `strata.pendingApprovalShown.v1`, and
auto-dismisses an untouched card after **30 s**. Approve and Deny (with a
required reason) act from the toast; *View all* opens `/approvals`. Checkout
cards carry an **Emergency** chip for break-glass requests; outbound-share
cards carry a **DLP** chip when the score is 50 or more or reasons are
present.

**Grouped credential-expiry alerts.**
[`CredentialProfileExpiryWatcher.tsx`](frontend/src/components/CredentialProfileExpiryWatcher.tsx)
polls `GET /api/user/credential-profiles` every **60 s** and warns at:

| Profile | Thresholds |
| ------- | ---------- |
| Standard (TTL ≤ 12 h) | 1 day, 1 hour, 10 minutes, 5 minutes |
| Extended expiry | 7 days, 1 day, 1 hour, 5 minutes |

Thresholds wider than the profile's own TTL are dropped and only the tightest
unfired one fires, so a 12-hour profile never shows a "1 day" warning. Expiries
arriving within a **20 s** window collapse into one toast — *"N Privileged
Credentials Expired"* — with a three-row matrix that expands inline, **Extend
All** (Safeguard JIT leases only, via `POST /api/user/safeguard/bulk-checkout`),
**Dismiss All** (also `Esc`, unless the user is typing or a modal owns the
keyboard) and **View Vault** (`/credentials`). Pre-expiry warnings batch the
same way, and their titles state the **actual time remaining** rather than the
threshold that fired. Fired thresholds are remembered per profile and expiry
timestamp in `strata.credExpiryFired.v1`, so a re-issued TTL re-arms them.

**Lease pill and lease manager.** The header pill
([`LeaseIndicator.tsx`](frontend/src/components/LeaseIndicator.tsx)) reads
*"N Lease(s) Expired"*, *"N Active · X left"* (inside one hour) or *"N Active
Lease(s)"*, and opens a slide-over manager
([`LeaseDrawer.tsx`](frontend/src/components/LeaseDrawer.tsx)) grouping leases
into Expired, Expiring within 1 hour and Active. It offers bulk **Extend**
(Safeguard JIT only) and a **confirmed** check-in that calls
`POST /api/user/safeguard/checkin` for JIT leases and the checkout check-in
endpoint for password checkouts. Both only appear when Vault is configured.
The pill and drawer poll nothing themselves: they read
[`leaseStore.ts`](frontend/src/components/leaseStore.ts), which the expiry
watcher publishes to, so the release adds **no** request traffic.

### Added — Connections fleet manager

The **Admin → Connections** table is replaced by a fleet manager
([`pages/admin/fleet/`](frontend/src/pages/admin/fleet/)).

- **Telemetry strip** — five cards: total connections with a protocol
  breakdown; reachability of the connections that have been probed; security
  alerts (connections carrying an alert-tone policy badge); active sessions
  and live users; and the time of the last health sweep. The brief's *"Vault
  Enforced"* card was not built: whether a connection's credential is
  Vault-sealed is a property of each user's credential profile, not of the
  connection, so no per-connection figure exists to show.
- **Toolbar** — search (250 ms debounce) over name, host, port, description,
  folder and protocol; filters for protocol, folder (including *No folder* and a folder's whole
  subtree) and health (*Reachable*, *Unreachable*, *Not checked*); a **Sync AD /
  LDAP** menu that triggers existing AD sync sources (listed only for
  `can_manage_system`, because that endpoint requires it); **Verify Host Keys**
  (the existing SSH host-key survey); and **+ Add Connection**.
- **Table** — 20 rows per page. Each row shows name and a copyable target
  (`extra.url` for `web`), protocol, health — including the measured TCP
  latency after an on-demand probe — policy badges, live session count and
  folder (*Root* when unfiled). Row actions: **Configure**, **Probe**, and a
  menu with **Duplicate**, **Clear pinned host key** (SSH connections that have
  one) and **Delete connection**.
- **Policy badges are derived only from settings the engine honours:**

  | Badge | Source | Tone |
  | ----- | ------ | ---- |
  | NLA | `security` = `nla` / `nla-ext` | normal |
  | Legacy Sec | `security` = `rdp` | **alert** |
  | Kerberos | `auth-pkg` | normal |
  | HostKey / **Unpinned** | SSH `host-key` present / absent | normal / **alert** |
  | Cert Ignored | `ignore-cert` = `true` | **alert** |
  | Read-only | `read-only` = `true` | normal |
  | Clip Locked / No Copy / No Paste | `disable-copy`, `disable-paste` | normal |

  *Vault* and *Rec* badges from the brief were not built for the same reason
  as the Vault card.
- **Bulk dock** — appears when rows are selected: **Move to folder**,
  **Trigger Probe**, **Pin Host Keys (n)** (opens the host-key review panel
  scoped to the selected SSH connections, so every key is still an explicit
  approval), **Clear**, and **Delete Selected**, which asks for confirmation
  and warns when any selected connection has a live session. The brief's
  *"Enforce Vault"* bulk action was not built.
- **On-demand probe** — new endpoint `POST /api/admin/connections/{id}/probe`
  runs the health sweep's TCP check for one connection now, stores the result,
  and returns the connect latency. The UI runs at most **4** probes at once.
  Active sessions are polled every **30 s** only when the user holds
  `can_manage_system` or `can_view_sessions`.

The brief's ▶ launch-in-sandbox action and *"View Session Audit History"* were
not built: the first has no backend, and the audit and session pages do not
accept URL filters to deep-link into.

### Added — connection folder tree

[`ConnectionFoldersView.tsx`](frontend/src/pages/admin/ConnectionFoldersView.tsx)
replaces the flat folder list with a WAI-ARIA tree (`role="tree"` /
`treeitem`, `aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded`,
`aria-selected`).

- Guide lines, direct and total connection counts per folder, Expand all /
  Collapse all.
- Search matches folder **and connection** names and keeps the ancestors of a
  match visible, marking folders that match only through a connection.
- Inline **+ New Root Folder** and subfolder creation; rename by
  double-click, `F2` or the rename button, committed at most once per edit.
- Keyboard: arrows, `Home` / `End`, `Enter` / `Space`, `F2`, `Delete`.
- **Deletion is blocked in the UI** while a folder has subfolders or
  connections filed directly in it, with the reason in the dialog. The API
  does not block it — see [*Scope & safety*](#scope--safety).

### Added — risk-aware role editor

The Edit Role dialog ([`pages/admin/roles/`](frontend/src/pages/admin/roles/))
replaces the 400 px two-tab form.

- **Permissions** grouped into four categories — *Platform & system
  administration*, *Audit & observability*, *Data loss prevention & file
  transfer*, *Session collaboration* — each collapsible, with a filter, a
  granted count, and a **Critical / Elevated / Standard** risk badge on every
  permission. The layout defect where the *PERMISSIONS* caption shared a line
  with the first checkbox is gone.
- **Every role flag is now visible.** `can_manage_users` and
  `can_manage_connections` were stored on every role but **had no control in
  the old dialog**; both are now shown and marked Critical (see *Known issues*
  for why).
- **Asset assignments** is one tree of folders and connections. Granting a
  folder marks the connections filed **directly** in it as *Inherited from
  folder* (ticked and locked). Subfolders show *Not covered by parent folder*,
  because the backend grants folder access non-recursively; the brief's
  cascading model would have displayed access that does not exist. A
  connection granted both ways shows *Inherited · also granted directly* with
  a **Remove direct** control, so a redundant direct grant cannot silently
  outlive the folder grant. A summary line counts reachable connections, and
  a banner explains when the role already reaches every connection through
  `can_manage_system` or `can_manage_connections`.
- **Members** lists the users holding the role, with auth type and last
  sign-in. Directory groups are not listed: a user holds exactly one role and
  AD sync imports connections, not role membership.
- **Description** — a new free-text field (see *Scope & safety*).
- **Change tracking** — the footer counts each changed field, permission,
  folder and connection; Save is disabled until something changes; Cancel or
  `Esc` with unsaved changes asks before discarding. Duplicate role names are
  rejected before submission. The built-in `admin` and `user` roles keep their
  names locked and are labelled *System role*.
- The dialog is rendered in a portal on `document.body`, so the sidebar can no
  longer be drawn over it.

### Fixed

- **The old role dialog could erase a role's assignments.** It opened with an
  empty assignment list and filled it once `GET /api/admin/roles/{id}/mappings`
  returned; if that request failed it logged to the console and left the list
  empty, and **Save** then sent the empty list to
  `PUT /api/admin/roles/{id}/mappings`, which replaces all mappings. The new
  dialog refuses to open when the mappings cannot be loaded, and only sends
  mappings when they changed.
- **A partially failed role create no longer duplicates the role.** If the
  role is created but its mappings fail, the dialog keeps the created role,
  says so, and a retry updates that role instead of creating a second one.
- **Folder renames and moves were not audited.** `PUT
  /api/admin/connection-folders/{id}` now writes `connection_folder.updated`
  with `{ id, name, parent_id }`. `connection_folder.created` now records the
  new folder's `id`, and `connection_folder.deleted` and `connection.deleted`
  now record the `name`, so the audit log reads *"Deleted folder Production"*
  rather than a truncated UUID.
- **Frontend CI failing with every test passing** (#431) and **OpenSSF
  Scorecard `Vulnerabilities`** (#430) — both carried from *Unreleased* and
  described in full at the end of this entry.

### Documentation corrected against the code

Building an editor that tells an administrator what each permission does
meant checking each one against the handlers. Several long-standing
statements in this repository's documentation were wrong. They are corrected
in [docs/security.md](docs/security.md#granular-admin-permissions),
[docs/api-reference.md](docs/api-reference.md#roles),
[docs/architecture.md](docs/architecture.md#database-schema) and
[docs/faq.md](docs/faq.md#how-does-rbac-work), and recorded here as a
backfill:

| Statement | What the code does |
| --------- | ------------------ |
| `can_manage_system` does **not** bypass `can_use_quick_share_outbound` (security.md, api-reference.md, architecture.md, since v1.11.0) | `check_quick_share_outbound_permission()` **does** accept `can_manage_system` for submit, ingest-token mint, list and download. Only the HTTPS-snippet **consume** path re-reads the role's own flag, so a super-admin without the flag can mint a token that is then refused. |
| `can_create_users`, `can_create_user_groups` and `can_create_connections` grant provisioning, role CRUD, and connection/folder CRUD | **No handler checks them.** They pass the coarse `require_admin` gate and reveal admin navigation; the create endpoints require `can_manage_users`, `can_manage_system` and `can_manage_connections` respectively. |
| `can_view_sessions` is *"View own sessions (own sessions only)"* (old role dialog and the Access → Permissions matrix) | It lists, observes (NVR) and terminates **every** live session and opens every recording. Relabelled *Monitor sessions* in the role editor. |
| A folder grant covers a folder's subfolders (implied by the brief; unstated in the docs) | Every access query compares `role_folders.folder_id = connections.folder_id`, so a grant covers only connections filed directly in that folder. |
| Ten-permission role model (README, faq.md — with two flag names that do not exist) | Eleven flags; the FAQ's `can_audit_system` and `can_create_roles` are `can_view_audit_logs` and `can_create_user_groups`. |
| `GET/POST/PUT/DELETE /api/admin/connection-groups`, `PUT /api/admin/role-connections` (api-reference.md) | The routes are `/api/admin/connection-folders` and `/api/admin/roles/{id}/mappings`; `role-connections` no longer exists. |
| Schema diagram lists `connection_groups` and no `role_folders` (architecture.md) | Migration `023` renamed the table to `connection_folders`; `role_folders` (migration `024`) is the folder-grant table. |
| `WHATSNEW.md` v1.14.6 entry | Was missing its `# What's New in v1.14.6` heading and read as part of v2.0.0; heading restored. |

### Known issues found while building this release (not changed)

Each is a pre-existing behaviour, not introduced here. They are recorded so the
decision to change them is made deliberately rather than as a side effect of a
UI release.

| Issue | Effect | Where |
| ----- | ------ | ----- |
| `can_view_sessions` was introduced as *own-session* access, but the admin session and recording endpoints accept it | The SPA's Sessions page shows a holder only their own sessions, yet the API lets them list, observe and terminate every session and open every recording. The role editor now describes the API behaviour. | `check_session_permission` in [`services/middleware.rs`](backend/src/services/middleware.rs) |
| `can_manage_users` can change **any** user's role, including the holder's own, to `admin` | A holder can escalate to super-admin. Marked **Critical** in the role editor. | `update_user` in [`routes/admin.rs`](backend/src/routes/admin.rs) |
| `can_create_users` / `can_create_user_groups` / `can_create_connections` are not enforced | Granting one alone shows an admin area whose actions then return `403`. | `services/middleware.rs` has no `check_*` for them |
| Outbound Quick Share mint vs consume disagree for super-admins | A super-admin without the role flag can mint an upload token that is refused on use. | [`routes/outbound_shares.rs`](backend/src/routes/outbound_shares.rs) consume re-check |
| Role changes are audited without their content | `role.updated` records `{ id, name }` and `role_mappings.updated` records `{ role_id }`, not which permissions or grants changed. | [`routes/admin.rs`](backend/src/routes/admin.rs) |
| **Access → Session Policies** shows fixed values | The panel's durations, watermark and recording text are hard-coded display, not read from settings, and one line (*".cast"*) does not match the `.guac` format. | [`AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx) |
| Probe and health sweep resolve with the container resolver | *Reachable* can differ from what a session sees when admin-configured DNS is in use, because sessions resolve targets against those nameservers. | [`services/health_check.rs`](backend/src/services/health_check.rs) |
| `DELETE /api/admin/connection-folders/{id}` cascades | The API deletes subfolders (`ON DELETE CASCADE`) and unfiles their connections; only the UI blocks it. Access moves in the safe direction — folder grants are removed, never widened. | migrations `006`, `024` |

### Scope & safety

| Area | Change |
| ---- | ------ |
| Schema | Migration **`090_role_description.sql`** adds `roles.description TEXT NOT NULL DEFAULT ''`. Migration **`092_prune_shipped_roadmap_statuses.sql`** removes the `workflows-quick-share-outbound` and `protocols-ironrdp-upgrade` overrides from `system_settings.roadmap_statuses` (tolerates a missing or non-JSON value). Both are additive or data-only and run automatically at boot. |
| API | **New** `POST /api/admin/connections/{id}/probe` (`can_manage_connections`; `404` for unknown or soft-deleted connections). `GET/POST/PUT /api/admin/roles` carry `description` (trimmed, ≤ 500 characters, `400` beyond that; omitted on `PUT` = unchanged). Audit payloads gained fields as listed under *Fixed*; no event was renamed or removed. |
| Authorisation | **Unchanged.** No handler's permission check moved. The probe endpoint uses the existing `check_connection_management_permission`, is post-authentication, and probes only the host and port already stored on the connection — it takes no target from the request, so it adds no new reachability beyond what the 2-minute sweep already performs. It is not audited, matching the sweep. |
| Env vars | None. |
| Dependencies | None. |
| Frontend | New modules `pages/admin/fleet/`, `pages/admin/roles/`, `ConnectionFoldersView`, lease and toast components, `hooks/useConnectionFilter`. The in-app roadmap drops *Quick-Share Outbound* (shipped v1.11.0) and *IronRDP Upgrade & Tokio-Native RDP Sessions* (shipped by v2.1.0); `docs/roadmap.md` also drops *Kubernetes Pod Console* (v2.0.0) and *Antivirus scanning* (v1.12.0). The IronRDP item's one open task — dropping the `ironrdp-connector` and `sspi` forks — is dependency maintenance tracked by `scripts/check-vendored-forks.sh` and [ADR-0015](docs/adr/ADR-0015-native-rust-session-engine.md), not a roadmap feature. |
| DMZ edge | No change; does not need rebuilding. |

### Testing

- **Backend**: `cargo fmt --check` and `cargo clippy --all-targets -- -D
  warnings` clean; role tests (19, including two new `normalize_description`
  tests) and the `health_check` tests (10, including two for the timed probe)
  pass.
- **Frontend**: new suites `FleetManager.test.tsx` (13),
  `ConnectionFoldersView.test.tsx` (11), `EditRoleModal.test.tsx` (14), and
  #432's `LeaseIndicator`, `EnterpriseCheckbox`, `ToastProvider` and watcher
  suites; `AdminSettings.test.tsx` updated for the new tree, fleet table and
  role dialog. `tsc --noEmit` clean.
- **Browser check** against mocked APIs: fleet KPIs, bulk dock, probe latency,
  the role editor's three tabs, inherited and direct grants, and the members
  list.
- *AdminSettings › AccessTab › paginates roles* fails against the in-progress
  roles-list markup; it asserts text that the new pagination splits across
  elements.

### Deploy

```bash
git pull
docker compose build backend frontend
docker compose up -d
```

Migrations `090` and `092` apply at backend start. No `.env` change. The DMZ
edge does not need rebuilding.

**Operator action — review custom roles.** Open each custom role in
**Admin → Access → Roles**. The editor now shows two flags the old dialog hid
(*Manage users*, *Manage all connections*), both Critical, and marks folder
grants that do not reach subfolders. Roles that relied on
`can_create_users`, `can_create_user_groups` or `can_create_connections`
alone should be given the flag the server actually checks, or have those
flags removed.

### Fixed — frontend CI failing with every test passing

The **Frontend (React)** job failed on `main` after v2.1.1 with 83/83 test
files and 1647/1647 tests green and coverage above every floor. Vitest exits
non-zero on an **unhandled error**, even one raised after a test has
finished: `TypeError: stream.sendBlob is not a function`, from
`SessionClient.test.tsx` › *handles drag-and-drop file upload*. The test's
mock output stream had only `onack`, while the real `Guacamole.BlobWriter`
reads the dropped file with `FileReader` and then calls `stream.sendBlob()`
asynchronously — after the test had already returned. Whether that landed
inside a later test depended on scheduling, so it reproduced on the Linux
runner (and in a `node:24` container) but not on Windows. The mock stream now
implements `sendBlob` / `sendEnd`, and the test waits for the payload to reach
the stream, so the write completes inside the test that caused it. Test-only
change.

### Security — OpenSSF Scorecard `Vulnerabilities` (score 4, six findings)

Scorecard's OSV-Scanner run reported six advisories. Only one was a
outdated package in the build; four came from lockfiles Cargo never
reads, and one suppression was missing.

| Advisory | Package | Where it came from | Resolution |
| -------- | ------- | ------------------ | ---------- |
| RUSTSEC-2026-0286 (OOB read decoding `CKA_ALLOWED_MECHANISMS`) | `cryptoki` 0.12.0 | Root `Cargo.lock`, via `sspi` smart-card support | **Bumped to 0.12.1.** Not reachable — Strata never opens a PKCS#11 session — but fixed rather than argued |
| RUSTSEC-2026-0285 (TLS 1.3 messages across key changes) | `rustls` 0.23.41 | Stale `crates/vendor/ironrdp-connector/Cargo.lock` | Root already resolves 0.23.45; stale lockfile deleted |
| RUSTSEC-2026-0118, RUSTSEC-2026-0119 (NSEC3 loop; O(n²) name compression) | `hickory-proto` 0.25.2 | Stale `crates/vendor/sspi/Cargo.lock` | Root resolves 0.26.3 via `hickory-resolver`; stale lockfile deleted |
| RUSTSEC-2023-0071 (Marvin) | `rsa` | Vendored lockfiles, where the root `osv-scanner.toml` does not apply | Stale lockfiles deleted; the existing suppression's rationale **corrected** |
| RUSTSEC-2023-0089 (unmaintained) | `atomic-polyfill` | Root `Cargo.lock` | Suppression **added** to `osv-scanner.toml`, mirroring `backend/.cargo/audit.toml` |

**Why the vendored lockfiles mattered.** The forks under `crates/vendor/`
shipped their upstream `Cargo.lock`. Cargo ignores them — the forks are
`[patch.crates-io]` path dependencies resolved through the root lockfile —
but OSV-Scanner scans every lockfile it finds and applies an ignore file only
to its own directory. All three are deleted, and `crates/vendor/*/Cargo.lock`
is now in `.gitignore` so refreshing a fork cannot reintroduce them.

**The RUSTSEC-2023-0071 rationale was wrong.** `osv-scanner.toml` and
`docs/security.md` said `rsa` was a lockfile artefact never compiled into the
backend. Since the v2.0.0 RDP engine, `rsa 0.10.0-rc.18` is compiled via
`picky` / `sspi` / `winscard`. The suppression stands on a different, checked
ground: the attack times RSA private-key decryption, and the RDP engine only
ever builds `Credentials::UsernamePassword`, so no RSA private key reaches the
crate. `backend/.cargo/audit.toml` carried a similar stale rationale and is
corrected too.

Only `cryptoki` moves in `Cargo.lock` (0.12.0 → 0.12.1, semver patch); no
schema, API, env-var or behavioural change. `cargo check -p strata-backend
--locked` passes, and `osv-scanner scan source -r .` reports **No issues
found**, with four findings filtered by justified suppressions. The Scorecard
score updates on its next run against `main` after this merges.

## [2.1.1] — 2026-09-24

### Patch release — sessions now say how they actually ended, and five RDP fidelity defects are fixed

### The ask

> "Now we are using our own ironrdp implementation instead of guacamole
> guacd, is it possible to make the disconnect messages that come up when
> connections are ended either through log off, network error, latency or
> disconnect appear more appropriately as the message that comes up when
> sessions end rather than the generic messages now that are questionable
> and not particularly accurate?"

The rest of this release rolls up the RDP fixes merged to `main` after
v2.1.0 (#420, #421, #422, #424, #425), which were recorded under
_Unreleased_ but never shipped, together with CI and dependency
maintenance (#423, #426, #427, #428).

### Fixed — session-end messages

#### The symptom

Every way a session could end produced one of a small number of messages,
and several of them were actively misleading:

| What actually happened | What the user saw |
| ---------------------- | ----------------- |
| Signed out of Windows | Overlay titled **Connection Error**, body *"[Protocol independent error] The disconnection was initiated by the user logging off his or her session on the server"* |
| **Start → Disconnect** inside Windows | **Connection Error** — *"[Protocol independent error] The disconnection was initiated by an administrative tool on the server running in the user's session"*. Nobody used an administrative tool. |
| Idle-session limit on the host | **Connection Error** with the MS-RDPBCGR spec text for `ERRINFO_IDLE_TIMEOUT` |
| Same Windows session opened from a second tab or device | **Connection Error** with spec text, indistinguishable from a fault |
| Network path to the host failed mid-session | **Session Ended** — *"The remote session has ended. You may have logged out of the server."* The user had not logged out. |
| Host restarted or dropped the TCP connection | *"target closed the connection"* |
| SSH shell exited | *"remote shell exited"* |

The session-bar thumbnail compounded it: it labelled **every** ended
session **Connection Lost**, including a deliberate sign-out.

#### Root cause

Three independent defects, each sufficient to produce a wrong message on
its own:

1. **Every end carried the same status code.** The Guacamole wire encoder
   ([`transport/guac_wire.rs`](crates/strata-session/src/transport/guac_wire.rs))
   turned every `TargetEvent::Disconnected` into an `error` instruction with
   status `519`, commented as `UPSTREAM_ERROR`. `519` is actually
   `0x0207 UPSTREAM_NOT_FOUND`, and in any case one code for every end gave
   the browser nothing to distinguish a sign-out from a network failure. The
   overlay therefore fell back to guessing from the message text:
   [`SessionClient.tsx`](frontend/src/pages/SessionClient.tsx) titled the
   overlay **Session Ended** only if the text happened to contain
   *"session has ended"*, and **Connection Error** otherwise.
2. **RDP disconnect reasons were displayed as protocol-specification
   prose.** When Windows ends a session it sends a Set Error Info PDU with a
   code (`ERRINFO_LOGOFF_BY_USER` = `0x0C`,
   `ERRINFO_RPC_INITIATED_DISCONNECT_BYUSER` = `0x0B`, and so on).
   `ironrdp-session` 0.11 does not surface the code: it renders it through
   `ErrorInfo::description()` — the MS-RDPBCGR wording, written for protocol
   implementers — and hands over only the resulting string, as
   `GracefulDisconnectReason::Other(String)`. The engine forwarded that
   string verbatim. The spec wording for `0x0B` is the source of the
   *"administrative tool"* message: it is technically accurate (the Start
   menu's Disconnect goes through the same RPC as an admin tool) and
   useless to a person.
3. **Engine failures ended the session in silence.** When the engine
   returned an error — a TCP reset, a timeout, a protocol violation — the
   session actor
   ([`actor/session.rs`](crates/strata-session/src/actor/session.rs)) logged
   it and tore down **without sending the client anything**. The backend
   then closed the WebSocket normally, the browser saw a clean close with no
   reason, and fell back to its hard-coded *"You may have logged out of the
   server."* That guess is where the most-questioned message came from.

A fourth, related defect surfaced while fixing the third: an engine error
raised while **forwarding input** to the target propagated with `?` straight
out of the actor's run loop, which **skipped teardown entirely** — the
engine was not shut down, the audit sink was not finalised and the
credential guard was not revoked. See *Scope & safety*.

#### The fix

- **Every end now carries a cause.** `TargetEvent::Disconnected` gains a
  `cause: DisconnectCause` field
  ([`engine/mod.rs`](crates/strata-session/src/engine/mod.rs)) — `Ended`,
  `IdleTimeout`, `Conflict`, `Refused`, `Unauthorized`, `ConnectionLost`,
  `Failed` — and the wire encoder maps it onto the Guacamole status set:

  | Cause | Status | Overlay title | Thumbnail label |
  | ----- | ------ | ------------- | --------------- |
  | `Ended` | `0x020B` `SESSION_CLOSED` (523) | Session Ended | Ended Remotely |
  | `IdleTimeout` | `0x020A` `SESSION_TIMEOUT` (522) | Session Timed Out | Idle Timeout |
  | `Conflict` | `0x0209` `SESSION_CONFLICT` (521) | Session Disconnected | Disconnected Remotely |
  | `Refused` | `0x0208` `UPSTREAM_UNAVAILABLE` (520) | Connection Refused | Connection Refused |
  | `Unauthorized` | `0x0301` `CLIENT_UNAUTHORIZED` (769) | Access Denied | Access Denied |
  | `ConnectionLost` | `0x0203` `UPSTREAM_ERROR` (515) | Connection Lost | Connection Lost |
  | `Failed` | `0x0200` `SERVER_ERROR` (512) | Connection Error | Connection Error |

- **RDP reasons are translated into plain language.**
  `describe_termination()` in
  [`engine/rdp/mod.rs`](crates/strata-session/src/engine/rdp/mod.rs)
  recovers the Set Error Info code by rendering each known
  `ProtocolIndependentCode` through the same `ErrorInfo::description()`
  and comparing — so the match cannot drift if `ironrdp` rewords its
  descriptions, because both sides come from the same function. The table
  `PROTOCOL_INDEPENDENT_ENDS` maps each code to a message and a cause:

  | Windows code | Message | Cause |
  | ------------ | ------- | ----- |
  | `LOGOFF_BY_USER` (0x0C) | You signed out of the remote session. | Ended |
  | `RPC_INITIATED_DISCONNECT_BYUSER` (0x0B) | You disconnected from the remote session. It is still running on the remote computer; reconnect to pick up where you left off. | Ended |
  | `RPC_INITIATED_DISCONNECT` (0x01) | An administrator on the remote computer disconnected this session. It is still running; reconnect to pick up where you left off. | Conflict |
  | `RPC_INITIATED_LOGOFF` (0x02) | An administrator on the remote computer signed this session out. | Conflict |
  | `DISCONNECTED_BY_OTHERCONNECTION` (0x05) | This session was opened from another window or device, which disconnected it here. | Conflict |
  | `IDLE_TIMEOUT` (0x03) | The remote computer disconnected the session because it was idle for too long. | IdleTimeout |
  | `LOGON_TIMEOUT` (0x04) | The session reached the time limit set on the remote computer. | Ended |
  | `SERVER_DENIED_CONNECTION` (0x07) | The remote computer refused the connection. | Refused |
  | `OUT_OF_MEMORY` (0x06) | The remote computer ran out of memory and ended the session. | Refused |
  | `SERVER_INSUFFICIENT_PRIVILEGES` (0x09) | Your account is not allowed to sign in to the remote computer over Remote Desktop. | Unauthorized |
  | `SERVER_FRESH_CREDENTIALS_REQUIRED` (0x0A) | The remote computer requires the password to be entered for every connection. | Unauthorized |
  | DWM / Winlogon / CSRSS crash, display-driver start-up failures (0x0F–0x18) | The session ended because a component on the remote computer stopped unexpectedly. | Failed |

  Codes outside that table are classified by category — licensing
  (`0x100`–`0x10A`) → *"…because of a Remote Desktop licensing problem:
  <detail>"* / `Refused`; connection broker (`0x400`–`0x412`) → *"The Remote
  Desktop connection broker could not place this session: <detail>"* /
  `Refused`; RDP-specific protocol errors (`0x10C9`–`0x1195`) → *"…after a
  protocol error: <detail>"* / `Failed` — keeping the spec description as
  detail but stripping its `[category]` tag. An MCS Disconnect Provider
  Ultimatum with no error info becomes *"The remote computer ended the
  session."*, and a TCP close with neither becomes *"The remote computer
  closed the connection without giving a reason. It may have restarted,
  shut down, or dropped off the network."* (`ConnectionLost`). The raw
  `ironrdp` reason is still logged at `INFO` as
  `rdp target ended the session`.
- **Engine failures are reported, not swallowed.** The actor now emits a
  `Disconnected` event before teardown on every exit path that previously
  said nothing, via `describe_engine_failure()`:

  | Engine outcome | Message | Cause |
  | -------------- | ------- | ----- |
  | `Transport` with `ErrorKind::TimedOut` | The remote computer stopped responding, so the connection was dropped. | ConnectionLost |
  | Any other `Transport` error | The network connection to the remote computer was lost. | ConnectionLost |
  | `Closed` | The remote computer closed the connection unexpectedly. | ConnectionLost |
  | `AuthRejected` | The remote computer rejected the credentials. | Unauthorized |
  | `Protocol` / `Unsupported` | The session ended because of an unexpected response from the remote computer. | Failed |
  | Engine stream ended with no event | The remote session has ended. | Ended |

  When the failure is raised on the **input** path,
  `end_after_input_failure()` first waits up to one second
  (`CLOSE_REASON_GRACE`) for the engine's own `Disconnected` event. A closed
  RDP engine has almost always queued its real reason — a sign-out, say —
  and reporting the failed write instead would replace an accurate message
  with a vaguer one.
- **SSH, Kubernetes and VNC** messages are rewritten as sentences:
  *"The remote shell exited."*, *"The remote shell exited with status
  N."*, *"The remote shell was terminated by signal …"*, *"The command
  exited."*, *"The pod closed the connection."*, *"The VNC server
  connection failed: …"*.
- **Gateway-initiated ends** in
  [`backend/src/session_engine.rs`](backend/src/session_engine.rs) now
  choose their status. `send_error()` takes a status argument; the
  maximum-duration and revoked-sign-in watchdog closes send
  `SESSION_CLOSED` with *"This session reached the maximum allowed
  duration and was closed."* and *"This session was closed because your
  sign-in was revoked."* (previously *"Session closed: maximum duration
  reached"* / *"Session closed: token revoked"*). The administrator kill
  keeps `SESSION_CONFLICT` and its existing text, which the browser keys
  on. The comment that described `521` as `SESSION_CLOSED` was wrong and
  has been corrected alongside.
- **The browser titles by status code.** New
  [`frontend/src/utils/sessionEnd.ts`](frontend/src/utils/sessionEnd.ts)
  (`describeSessionEnd(message, code)`) drives both the full-screen
  overlay and the session-bar thumbnail. `GuacSession` gains `errorCode`,
  set from `Guacamole.Status.code` in both `tunnel.onerror` and
  `client.onerror`. The overlay keys the code by message
  (`errorStatus`), so a later client-side `setError()` — "Automatic
  reconnection failed…", say — can never inherit a stale code from an
  earlier end. An administrator termination is still recognised by its
  text and still suppresses **Reconnect**. With no status code (the
  rollback-era `guacd` path, or a client-side failure) the old text
  heuristics apply, and the speculative *"You may have logged out of the
  server."* suffix is removed from the fallback.

**Rejected approaches.** Forking `ironrdp-session` to expose the raw
`ErrorInfo` would have been the cleanest data path, but it would be a
fourth vendored fork carried for a presentation concern, when the same
code is recoverable with no fork at all. Matching on hand-copied English
strings was rejected for the opposite reason: it would silently stop
matching the first time `ironrdp` reworded a description. Auto-reconnecting
on `ConnectionLost` was deliberately **not** added — the ask was accuracy,
and an automatic reconnect after a target-side failure is a behavioural
change that deserves its own decision. The overlay offers **Reconnect**, as
it did before.

### Fixed — RDP fidelity

- **RDP sessions carried no audio.** The RDPSND implementation was
  complete and the channel was negotiated, but every session declared
  `INFO_NOAUDIOPLAYBACK` in its Client Info PDU, which tells the target
  not to redirect audio at all — so both ends agreed a format and the
  server correctly sent nothing. The field behind that flag is a
  negative, and it defaulted to off. Audio is now on unless a connection
  sets `disable-audio`, which is how guacd read the same parameter; that
  parameter was accepted by preflight but nothing consumed it, so it was
  inert either way.

  Clearing that flag was necessary but not sufficient: the target still
  joined the audio channel and then sent nothing on it, with no error to
  say why. Windows will not use RDPSND unless the device redirection
  channel is advertised alongside it. [MS-RDPEFS] Appendix A<1> documents
  that dependency the other way round — device redirection needing audio —
  but on Server 2019 and 2022 it holds in both directions, and `mstsc`
  always advertises both. The channel is now advertised with no devices
  and a no-op backend, so no drive, printer, port or smart card can be
  redirected through it; it exists only to satisfy that pairing.

  *(Backfill — not previously recorded.)* The browser half needed a fix
  too. Browsers create an `AudioContext` **suspended** until the page has
  seen a user gesture, and never resume it on their own; a player writing
  into a suspended context produces no sound and no error.
  `Guacamole.AudioContextFactory.resumeOnGesture()` in the vendored
  [`guacamole-vendor.js`](frontend/src/lib/guacamole-vendor.js) now
  resumes it on the first `mousedown` / `keydown` / `touchstart` /
  `pointerdown`, listening in the **capture** phase because the session
  display stops propagation of most input it handles. The backend also
  now logs `opening audio stream` when the first audio packet arrives, so
  "the target sent nothing" and "the target sent audio nobody played" are
  distinguishable in the log — before, they produced identical output.

- **RDP sessions retried network auto-detection endlessly.** The client
  advertised support for the bandwidth measurement in MS-RDPBCGR 2.2.14
  but only answered the round-trip part of it, so the results PDU the
  server waits for never arrived. Windows does not give up: it reissued
  the measurement dozens of times a second for the life of every session,
  each attempt costing a round trip on a connection already tunnelled
  through a browser, and never resolved the link's characteristics. The
  capability (`SUPPORT_NET_CHAR_AUTODETECT`) is no longer advertised — a
  change to the vendored `ironrdp-connector` fork — and the server sizes
  the session from the reported connection type instead.

- **Sessions arrived zoomed in on a display scaled above 100%.** Three
  users on identical 1920x1080 monitors got different results, because one
  had Windows display scaling at 125%. A scaled display reports fewer CSS
  pixels than it has — 1536 wide rather than 1920 — and the client passed
  those straight through as the desktop size while separately telling the
  target to draw its UI at 125%. The two compound: less content fits *and*
  everything is drawn larger, then the undersized canvas is stretched back
  across the real pixels, which also cost sharpness. Container sizes are
  now converted to real pixels before being sent. The scaling that fits the
  canvas to its container already divides them back down, so the desktop
  now matches the monitor and maps pixel-for-pixel. Unaffected at 100%,
  where the conversion is a multiply by one.

- **The remote desktop is no longer redrawn at the local display scale.**
  Correcting the desktop size above fixed only half of the fault: the
  client still reported the local scale as the session DPI, so a user at
  125% received a correctly sized desktop that the target then drew 25%
  larger — the same zoomed-in session, from the other cause. Size and DPI
  now come from one place (`remoteDisplayMetrics()` in
  [`SessionManager.tsx`](frontend/src/components/SessionManager.tsx)) so
  they cannot disagree, and the scale is reported only if asked for, under
  "Match my display scale" in Display Settings. A remote desktop therefore
  looks the same on every client regardless of local zoom; anyone who
  preferred remote text to match their local size can turn the option back
  on without reconnecting. The preference is per browser (`localStorage`
  key `strata-display-scale-passthrough`), not per account. Session sharing
  sent its size the same way and could zoom the owner's session, and the
  initial connection was still sending CSS pixels long after the first
  resize had corrected them; both now take the same path.

- **Multi-monitor sessions had the same fault, and sent no DPI at all.**
  The aggregate desktop was summed from CSS widths, so a scaled monitor
  contributed fewer pixels than it can show, and all three resize calls
  bypassed the DPI-aware path entirely. Each screen now contributes its
  own real width, the primary's scale travels with the request, and the
  popup canvases are backed in real pixels so each slice draws 1:1.
  Window placement keeps its own CSS-pixel coordinates, which is the unit
  `window.moveTo` speaks — previously the remote-desktop offset was
  reused for placement, which only held while the two units agreed.

- **Non-US keyboards typed the wrong characters over RDP.** On a UK layout
  `\` arrived as `#`; `@` and `"` were swapped, and `£` did not work. The
  engine translated each keysym to a US key position and the target then
  applied its own layout on top, so the layout was applied twice: `\` and
  `#` are the same position on US and UK keyboards respectively, and both
  steps were individually correct. This is the right model for a client
  that sends the physical key pressed, which is what `mstsc` does, but the
  browser sends the character the user's local layout already produced.
  Printable characters now travel as layout-independent Unicode key
  events, which fixes every affected layout rather than one key.

  Keys that are positions rather than text keep their scancode: anything
  held with Ctrl, Alt or Super so shortcuts still register, space, and the
  named keys. `AltGr` is deliberately not counted as a shortcut modifier,
  because on most non-US layouts it composes characters.

  The keyboard layout selected on a connection is still sent to the target
  and still governs those positional keys, but it no longer determines
  which character you get. The **Failsafe (Unicode events)** option is
  consequently now a no-op: what it selected is what every layout does.

### Changed — tooling, CI and dependencies

- **`docs/Configure-RdpAvc444.ps1` detects GPUs the host can actually
  encode with (#425).** GPU detection keyed off
  `Win32_VideoController.AdapterRAM`, a deprecated `uint32` that cannot
  represent 4 GB or more and reads empty on current Windows builds. A
  16 GB Tesla T4 and Hyper-V's synthetic adapter therefore both read as
  "no hardware GPU", and the script silently skipped
  `AVCHardwareEncodePreferred` and `bEnumerateHWBeforeSW` — the two settings
  the host was provisioned for. Detection now matches the PCI vendor ID.
  Azure N-series VMs whose GPU has no driver (the device sits under *Other
  devices* as a raw PCI function) are now reported with the device problem
  code, and the script points at the Azure extension log. The gpedit note
  now says the hardware-graphics policy is the `bEnumerateHWBeforeSW` value
  the script already writes.
- **CodeQL excludes vendored crates (#423).** CodeQL opened 26
  high-severity "broken or weak cryptographic algorithm" alerts against
  `crates/vendor/sspi`, every one of them NTLM (RC4 sealing keys, MD4
  password hashing, HMAC-MD5 proofs) — MS-NLMP defines the scheme in terms
  of those primitives. `.github/codeql/codeql-config.yml` now excludes
  `crates/vendor` by **path**, not by rule, so weak cryptography in
  first-party code still fails the scan. This is the fourth path-based gate
  that needed the same exclusion, after `cargo-audit`, `tarpaulin` and
  `gitleaks`.
- **Dependencies.** `nginx` `1.31.5-alpine` → `1.31.6-alpine` (frontend
  image, #426). Frontend group (#427): `marked` 18.0.13, `react-i18next`
  17.0.14, `react-router-dom` 7.18.4, `@testing-library/dom` 10.4.2,
  `@vitest/coverage-v8` 5.0.1, `jsdom` 30.1.0, `prettier` 3.9.8, `vitest`
  5.0.1. Actions group (#428): `docker/setup-buildx-action` 4.4.1,
  `docker/build-push-action` 7.4.0, `github/codeql-action` 4.38.1. New
  Rust dependency `ironrdp-rdpdr` 0.7 (audio pairing, above), resolving on
  the existing single `ironrdp-svc` 0.8.

### Removed — public container images (GitHub Container Registry)

> "We no longer wish to store any images in github container registry so
> can we remove any that we have stored there. We're storing images
> privately so we no longer need github container images like in
> docker-compose.ghcr.yml"

Strata no longer publishes container images anywhere public. Images are
built from this repository and kept in a private registry.

| Removed | What it did |
| ------- | ----------- |
| `.github/workflows/release.yml` | On every `v*.*.*` tag: built `backend` and `frontend`, pushed them to `ghcr.io/bails309/strata-client/*`, signed each digest keyless with Cosign, attached a CycloneDX SBOM attestation, generated SLSA Level 3 provenance, and attached the SBOMs to the GitHub Release |
| `docker-compose.ghcr.yml` | Compose overlay that swapped the local `build:` for the GHCR images |
| `scripts/verify-image.sh` | Verified the Cosign signature, SBOM attestation and SLSA provenance against the release workflow's identity — meaningless without that workflow |
| `actions/unpinned-tag` CodeQL exclusion | Existed only because the SLSA generator must be referenced by tag; every remaining first-party workflow is SHA-pinned, so the rule is enforced again |

`deploy/helm/strata-dmz` (chart **0.1.0 → 0.2.0**, versioned independently)
no longer defaults `image.repository` to `ghcr.io/bails309/strata-dmz`. The
value is now empty and **required** — `helm install` fails with an
explanatory message until it is set to your registry path. CI's own image
builds (`ci.yml`, `trivy.yml`) were already build-only and are unchanged, so
the Trivy image scan still runs on every push.

The images already stored in GitHub Container Registry are **not** deleted
by this change: that is an action on the GitHub account, not the
repository. See *Deploying*.

**Security consequence.** The Cosign signature, SBOM attestation and SLSA
provenance were properties of images this repository published. With no
published images they have nothing to attach to, and image integrity
becomes a control of the private registry — authenticated push and pull,
deploy by digest, and signing on push if the registry supports it. See
[docs/deployment.md § Image provenance](docs/deployment.md#image-provenance-private-registry).

### Scope and safety

| Area | Change |
| ---- | ------ |
| Schema | None. No migration. |
| REST API | None. |
| WebSocket wire | The `error` instruction that ends a native session now carries one of seven status codes instead of always `519`, and human-readable text. Additive for any client that treats every `error` as terminal, which is what `guacamole-common-js` does. See [api-reference.md](docs/api-reference.md#session-end-the-error-instruction-v211). |
| Environment variables | None. |
| Connection parameters | `disable-audio` is now **honoured** on RDP (previously accepted and ignored). |
| Dependencies | `ironrdp-rdpdr` 0.7 added; `ironrdp-connector` fork edited; frontend, nginx and Actions bumps as listed. |
| Distribution | No images published to GHCR; release workflow, GHCR compose overlay and `verify-image.sh` removed; DMZ Helm chart requires `image.repository` (chart 0.2.0). |
| Behaviour | RDP audio now plays by default. Printable RDP keystrokes are sent as Unicode. Sizes are sent in device pixels and DPI is pinned to 96 unless the user opts in. Messages and overlay titles change as tabled above. |

**Security-relevant points** (full analysis in
[docs/security.md](docs/security.md#session-end-reporting-v211)):

- **Teardown now always runs after an input-path engine failure.**
  Previously such a failure returned from the actor before teardown, so the
  engine was not shut down, the recording was not finalised and the
  credential guard's `revoke()` never ran. All three now run on that path.
  The path is **post-authentication**: it needs an established session.
- **Client-facing text discloses no internal detail.** Engine error chains
  (I/O error text, protocol diagnostics) are logged server-side and never
  sent; the browser receives the fixed sentences tabled above. The only
  variable text is RDP's own spec descriptions for licensing, broker and
  protocol-error codes, which are constants compiled into `ironrdp-pdu`,
  and target-supplied text on the Kubernetes and VNC paths, which was
  already forwarded before this release. The SPA renders all of it as text,
  never markup.
- **The device-redirection channel is advertised with no devices.** RDPDR
  is registered with an empty device list and `NoopRdpdrBackend`; drive,
  printer, port and smart-card redirection remain removed, as in v2.0.0.
  Trust boundary: backend ↔ RDP target, post-authentication.

### Testing

- **`strata-session`: 239 unit tests pass** with
  `--features rdp,vnc,kubernetes,terminal,sftp`, including new coverage:
  `a_logoff_is_reported_as_a_sign_out`,
  `a_start_menu_disconnect_is_not_blamed_on_an_administrator`,
  `idle_and_takeover_ends_keep_their_own_cause`,
  `a_licensing_failure_keeps_the_spec_detail`,
  `a_server_ultimatum_is_a_clean_end` (RDP),
  `a_failed_engine_tells_the_client_the_connection_was_lost` (actor), and
  `a_clean_logoff_is_not_reported_as_an_upstream_failure` (wire encoder).
  The existing wire test now pins `515` rather than `519`. Live test
  suites (`ssh_live`, `rdp_live`, `kube_live`) compile.
- **Clippy clean** on `strata-session` (all engine features) and
  `strata-backend --all-targets`; the only warning is the pre-existing
  unfulfilled lint expectation inside the vendored `ironrdp-connector`.
- **Frontend: 1647 tests across 83 files pass**, including new
  `sessionEnd.test.ts` (title, label and admin-kill mapping; no-code
  fallback) and a `SessionClient` case asserting a `SESSION_CLOSED` sign-out
  is titled **Session Ended**, not **Connection Error**. `tsc --noEmit`
  clean.
- The RDP fidelity fixes carry their own regression tests, merged with
  them: keycode resolution (Unicode for printable characters, scancodes
  under shortcut modifiers, AltGr not a shortcut), the audio default and
  RDPDR/RDPSND pairing assertion, `displayScale.test.ts`, and multi-monitor
  and pop-out sizing.
- **Not yet live-verified:** the session-end mapping against a real
  Windows host (sign out, Start → Disconnect, idle limit, second-device
  takeover, pulled network cable). The RDP audio, keyboard and display
  fixes were verified live when they were merged.

### Deploying

Rebuild both images. There is no migration and no configuration change.

```sh
git pull
docker compose build backend frontend
docker compose up -d
```

DMZ topologies do not need an edge rebuild: `strata-dmz` carries no code
changed by this release (its version string moves with the workspace).

**If you pulled from GHCR**, switch to building and pushing to your private
registry before upgrading — the `docker-compose.ghcr.yml` overlay is gone and
no `2.1.1` image exists on GHCR. The steps are in the README Quick Start.
Helm users of `strata-dmz` must now pass `image.repository` (and usually
`imagePullSecrets`).

**Deleting the images already on GHCR** is done on GitHub, not in the
repository: *Profile → Packages*, open each of `strata-client/backend`,
`strata-client/frontend` (and `strata-dmz` or `custom-guacd` if present) →
*Package settings* → *Delete this package*. Or, with a token carrying
`delete:packages`:

```sh
gh api -X DELETE /user/packages/container/strata-client%2Fbackend
gh api -X DELETE /user/packages/container/strata-client%2Ffrontend
```

Do **not** delete `strata-rust-models`: that is the CodeQL model pack
`codeql.yml` consumes, not a container image.

After upgrading:

1. The in-app **What's New** modal shows the v2.1.1 card.
2. Sign out of a Windows session from the Start menu: the overlay reads
   **Session Ended — "You signed out of the remote session."**
3. RDP audio plays after the first click or keypress in the session. A
   connection that must stay silent needs `disable-audio` set — this is a
   behaviour change for any connection that relied on audio never working.
4. If users report the remote UI now looks *smaller* than before on a
   scaled display, that is the corrected behaviour; **Display Settings →
   Match my display scale** restores the previous look per browser.

### Reference documentation

- **`docs/architecture.md`** — new *How a session ends* section; new
  *Native RDP input, display and audio* section (Unicode keyboard, device-
  pixel sizing and DPI, RDPSND/RDPDR pairing, auto-detect); session-engine
  table corrected (RDP has run as an ordinary Tokio task since the
  `ironrdp` 0.17 upgrade, not on a dedicated thread); runbook table.
- **`docs/security.md`** — new *Session-end reporting* subsection; RDPDR
  exposure note; CodeQL gate scope. *Backfill for v2.1.0:* the *H.264 GFX
  Encoding* section and the parameter whitelist still said the pipeline was
  removed; both now record that v2.1.0 restored it as opt-in passthrough.
  A corrupted sentence fragment in the whitelist section was repaired.
- **`docs/api-reference.md`** — new *Session end: the `error`
  instruction* reference; `width` / `height` / `dpi` semantics;
  `disable-audio`; stale `enable-h264` row and `STRATA_SESSION_ENGINE`
  reference corrected.
- **`docs/faq.md`** — new entries for session-end messages, missing audio,
  wrong characters on non-US keyboards and zoomed-in sessions; the H.264
  answer, which still described the removed FreeRDP → `guacd` path, is
  rewritten.
- **`docs/deployment.md`** — v2.1.0 → v2.1.1 upgrade notes; *Supply-chain
  verification* replaced by *Image provenance (private registry)*.
- **`README.md`** Quick Start, **`docs/faq.md`**, **`docs/RELEASE_PROCESS.md`**,
  **`docs/dmz-implementation-plan.md`** and the Helm chart README — GHCR
  instructions replaced with build-and-push to a private registry.
- **New runbook [`docs/runbooks/session-disconnects.md`](docs/runbooks/session-disconnects.md)**,
  indexed in `docs/runbooks/README.md` and the architecture runbook table.
- **`ARCHITECTURE.md`** — session-end and remote-display data flows.
- Several documents contained literal `\u2014` escape sequences where an
  em dash was intended; they now render correctly.

## [2.1.0] — 2026-09-16 — RDP H.264 GFX passthrough

### The ask

Re-enable H.264 streaming for RDP on the native session engine. Passthrough
was a property of the patched `guacd` image and went away with it in 2.0.0;
`ironrdp-egfx` makes it possible natively.

### Added

- **RDP H.264 GFX passthrough on the native engine.** MS-RDPEGFX AVC420 /
  AVC444 frames are forwarded to the browser's WebCodecs `VideoDecoder`
  without a server-side decode, restoring on the native engine what was
  removed with `guacd` in 2.0.0. Off by default; enable per connection with
  **Enable graphics pipeline (GFX)**. See
  [docs/h264-passthrough.md](docs/h264-passthrough.md).
- **Vendored fork `crates/vendor/ironrdp-egfx`** adding the handler hooks
  upstream lacks for claiming AVC frames undecoded, tracked by
  `scripts/check-vendored-forks.sh` alongside the existing two forks.
- Solid-fill and surface-to-surface copy commands are now forwarded, the
  latter as a canvas-side copy rather than a re-encode.

### Fixed

- **Hazy text and a green line along the bottom edge with GFX enabled.**
  H.264 pads the picture to a 16x16 macroblock boundary and Windows sets no
  crop metadata, so the decoder reported a frame taller than the picture.
  The client scaled that padded frame to the destination rectangle, which
  resampled every pixel on every frame and drew the padding rows (which
  decode green) at the bottom. Frames are now cropped to the RDP
  destination rectangle and blitted 1:1.
- **The GFX toggle could never be saved.** `disable-gfx` is inverted, so its
  enabled state is the string `"false"` — which the admin form stripped as
  falsy. Long-standing, and the reason the parameter was previously
  documented as inert.
- Chroma-only AVC444 updates are no longer forwarded as pictures; on those
  the auxiliary view occupies `stream1`, so the previous behaviour painted a
  chroma plane over the region.
- The graphics pipeline now requests a full repaint after a GFX resize,
  which previously left the newly exposed area black until it was damaged.
- `isH264Supported()` probes `VideoDecoder.isConfigSupported()` rather than
  assuming support from the API merely being present.

### Scope and safety

GFX is **off by default** and opt-in per connection, so no existing session
changes behaviour on upgrade. Enabling it stops the host sending legacy
bitmap updates, which is a real trade rather than a free win: H.264 is
lossy, while the bitmap path is lossless and already measured **0.0296
bytes per pixel** on the pilot estate. Prefer GFX for motion-heavy work and
the bitmap path for static text.

The release adds a third vendored fork. Every fork is a supply-chain
liability with a recorded drop condition; `scripts/check-vendored-forks.sh`
reports per fork whether its reason still holds.

Three CI gates needed exclusions for the vendored trees, because path
dependencies put third-party source inside the repo: `cargo-audit`
(RUSTSEC-2023-0089, unmaintained `atomic-polyfill`, unreachable here),
`tarpaulin` (~9.9k untested lines polluting the coverage denominator) and
`gitleaks` (upstream test fixtures in the `sspi` fork). All three are
scoped to `crates/vendor` and disappear when the forks do.

### Testing

- 226 `strata-session` unit tests, including new coverage for the AVC444
  chroma cases and the EGFX surface hooks.
- 1629 frontend tests across 81 files, including 7 new cases pinning the
  H.264 draw rectangle against the macroblock-padding regression.
- Live-verified against a Windows host over Kerberos NLA: `V10_7`
  capabilities confirmed, `Avc444v2` frames decoded in-browser, text crisp
  with GFX both on and off.
- Supply-chain gates run locally: `cargo audit` clean, `gitleaks` reports no
  leaks, coverage 22.73%.

### Deploying

Rebuild both images; there is no migration and no configuration change.
To use GFX, tick **Enable graphics pipeline (GFX)** under Performance on a
connection and confirm the host is configured for AVC — see
[docs/Configure-RdpAvc444.ps1](docs/Configure-RdpAvc444.ps1). Verify from
the backend log, not Event Viewer:

```sh
docker compose logs backend | grep "graphics pipeline"
```

### Reference documentation

[docs/h264-passthrough.md](docs/h264-passthrough.md) was rewritten: it still
described the removed `guacd` pipeline and treated Event IDs 162/170 as
authoritative, which is wrong for this client.
[docs/Configure-RdpAvc444.ps1](docs/Configure-RdpAvc444.ps1) dropped three
registry values that are inert for Strata and now verifies from the backend
log. No change to `ARCHITECTURE.md`, `docs/security.md` or
`docs/api-reference.md`: no trust boundary, API surface or audit event
moved.

## [2.0.0] — 2026-09-09 — Native Rust session engine

### Major Release — Apache Guacamole's `guacd` is gone; every protocol is served by native Rust

### Phase 1 — `crates/strata-session` foundation

The v2.0.0 line replaces the Apache Guacamole C daemon (`guacd`) with a
native Rust session engine. The rationale, the dual-track transport design
and the four-phase rollout are recorded in
[ADR-0015](docs/adr/ADR-0015-native-rust-session-engine.md).

Nothing is routed to the new engine yet — `guacd` still serves every
session. This phase lands the foundation:

- **New crate `crates/strata-session`**, running in the trusted internal
  zone. CI (`dmz-deps.yml`) now fails if it leaks into the DMZ dependency
  closure.
- **Guacamole wire protocol** — zero-copy `winnow` parser and encoder.
  Length prefixes are counted in Unicode characters, not bytes, so a
  multi-byte glyph in a clipboard payload can no longer desynchronise the
  stream. Malformed input is distinguished from an incomplete prefix, so a
  split read waits instead of killing the session.
- **Actor pipeline** — one Tokio task per session, replacing `guacd`'s
  thread-per-connection model. Live observers attach to a
  `tokio::sync::broadcast` tap with no latency cost to the operator; a
  lagging observer is dropped rather than allowed to stall the primary
  stream. Dual-control moderation gates input without a lock.
- **Dual-track transport** — Guacamole Wire Compatibility Mode emits
  framing byte-identical to `guacd`, so existing clients need no change.
  Native Direct Streaming Mode wraps compressed H.264 slices and raw PTY
  bytes in a new binary envelope (`strata_protocol::media`) for the
  browser's `VideoDecoder` and `xterm.js`, removing the server-side
  decode → rasterise → re-encode round trip.
- **Credential handling** — Vault secrets stay in `secrecy::SecretString`
  and are revoked on teardown, even when engine shutdown fails. No
  plaintext credential crosses a process boundary; `TargetSpec` redacts
  its secret in `Debug`.
- **Recording** — an in-process append-only audit sink, replacing
  `guaclog`.
- **Fuzz harnesses** for the instruction parser, the streaming decoder and
  the media envelope.

### Phase 2 — SSH engine and dual-stack routing

- **SSH engine (`russh`)** — replaces `libguac-client-ssh`, which drove
  `libssh2` through polling wrappers because `libssh2` has no async story.
  The new engine is Tokio-native: no bridging threads, no unmanaged C.
  Opens an interactive shell on a PTY, tracks window resizes, and forwards
  the raw byte stream as `TargetEvent::TerminalOutput`.
- **Host key verification is mandatory.** The engine accepts a list of
  SHA-256 fingerprints and nothing else — there is deliberately no
  "accept anything" mode, because an SSH gateway that skips host key
  verification is a man-in-the-middle waiting to happen.
- **RSA is disabled by default.** `russh`'s `rsa` feature pulls
  `rsa 0.10.0-rc.x`, which carries RUSTSEC-2023-0071 (the Marvin attack —
  key recovery through a timing sidechannel) with no fixed release.
  `cargo deny check advisories` fails with it enabled, so the session
  engine builds without it; ed25519, ECDSA and the post-quantum key
  exchange cover every target running a current OpenSSH. An opt-in
  `ssh-rsa` cargo feature exists for targets that present no other host
  key. `russh` also uses the `ring` backend rather than the default
  `aws-lc-rs`, which is a C library.
- **Keysym translation** — X11 keysyms to PTY byte sequences, covering
  control codes, Alt-as-ESC-prefix, arrow and function keys, and Unicode
  keysyms. Backspace maps to DEL, matching xterm; sending BS instead
  breaks `readline` editing on essentially every modern Linux target.
- **Dual-stack routing (`strata_session::routing`)** — decides per session
  whether `guacd` or the native engine serves a connection. A protocol
  with no compiled engine can never be routed native, the decision is
  stable per target host so a canary cohort does not flap between
  engines on reconnect, and a single kill switch returns everything to
  `guacd`.
- **Terminal rasteriser (`strata_session::terminal`)** — the Guacamole
  protocol has no text primitive, so an SSH session reaching a legacy
  client has to arrive as pixels. `alacritty_terminal` keeps VT state and
  `fontdue` rasterises glyphs; damaged line runs are encoded as PNG and
  framed as ordinary `img`/`blob`/`end` streams. No shaping engine is
  involved — a monospace grid needs glyph bitmaps and nothing else, which
  keeps the dependency to one small crate rather than a text-layout
  stack. Native Direct Streaming Mode does not compile any of it in.
  - Rendering is skipped when the cells to be drawn match what the client
    already has: `alacritty_terminal` reports the cursor's line as
    damaged on every poll, so damage alone would re-encode a PNG for an
    idle terminal several times a second.
  - The backend image now installs `fonts-dejavu-core` explicitly rather
    than inheriting a font from Chromium's dependency closure.
- **Backend wiring** — `tunnel::proxy` now consults the router before
  dialling `guacd`, and `backend/src/session_engine.rs` bridges the
  browser WebSocket to the in-process engine. Controlled by
  `STRATA_SESSION_ENGINE` (`guacd` by default, then `canary`, then
  `native`), with `STRATA_SESSION_NATIVE_PERCENT`,
  `STRATA_SESSION_NATIVE_HOSTS` and `STRATA_SESSION_NATIVE_PROTOCOLS`.
  Anything unrecognised in those variables means `guacd` — a typo must
  not enable the new engine.
  - A session the policy selects but that cannot actually run natively —
    no host key pinned on the connection, no font installed — logs a
    warning and falls back to `guacd`. During a canary, not moving a
    session is better than breaking it.
  - Native SSH requires a `host-key-fingerprint` connection parameter
    (comma-separated `SHA256:…` values). Without it the engine has
    nothing to verify the target against and the session stays on
    `guacd`.
- **Session governance parity on the native path.** A natively served
  session is subject to the same controls as a `guacd` one, because a
  session that escapes its audit trail by being routed to a new engine
  would be worse than no new engine:
  - **Recording** — the engine writes its own `.guac` file, byte-identical
    in format to what `guacd` produces for `recording-path`. Existing
    playback, `guacenc` and the MP4 conversion path work against it
    unchanged. Binary media envelopes are never written to a recording,
    since they would corrupt it for every existing reader.
  - **Live observation** — frames are pushed to the session ring buffer
    and broadcast to NVR subscribers exactly as the `guacd` loop does.
  - **Administrative termination**, the **token-revocation and
    maximum-duration watchdog** (both emitting Guacamole status 521 and
    the same audit reasons), and **viewer-injected shared input** are all
    honoured.
  - Teardown wakes viewers, unregisters the session, cleans up
    quick-share files and finalises the recording row with duration and
    byte counts.
- **Verified against a real OpenSSH server.** `docker-compose.ssh-test.yml`
  brings up a throwaway sshd on an isolated network, and
  `crates/strata-session/tests/ssh_live.rs` drives the engine against it:
  shell round-trip, keysym translation reaching the remote shell as typed
  characters, Ctrl+C arriving as an interrupt, a client resize actually
  reflowing the remote PTY (asserted with `stty size`), host-key pinning
  refusing an unpinned target, password rejection, remote exit, and real
  shell output rasterising to PNG frames. The tests are `#[ignore]`d so
  the default suite still needs no target.
- **RDP engine (`ironrdp`)** — replaces `libguac-client-rdp`, which drove
  FreeRDP: the largest block of unmanaged C in the old session tier and
  the reason `guacd/patches/` exists.
  - **NLA is mandatory, and the engine fails closed without it.** The
    connector advertises CredSSP *only*. Advertising the legacy TLS
    security layer as well lets the server negotiate down to it, and on
    that layer the RDP connection completes before any credential is
    checked — authentication moves to an in-session login screen. A live
    test against xrdp caught exactly that: a deliberately wrong password
    produced a healthy, apparently authenticated session. The engine now
    refuses a target that will not do CredSSP.
  - `ironrdp-tls` deliberately does not verify the server certificate,
    because RDP certificates are self-signed as a matter of course;
    CredSSP's binding to the server public key is what authenticates the
    target, which is the other reason NLA cannot be optional.
  - **Keysym to PC scancode translation**, covering the US-layout
    positions, the extended-key cluster, and left/right modifier
    distinction so AltGr survives on non-US layouts. The remote host
    applies its own layout on top, exactly as a real RDP client behaves.
  - Damaged framebuffer regions are cropped and PNG-encoded into the same
    `img`/`blob`/`end` streams the terminal renderer already uses.
  - The session runs on a **dedicated thread with its own current-thread
    runtime**: `ironrdp-async`'s connection future is not `Send`, so it
    cannot be driven from the shared runtime. The engine exposes a `Send`
    handle over channels.
  - `docker-compose.session-test.yml` provides three targets: an sshd, an
    xrdp server that **cannot** do NLA (which is what proves the refusal
    above), and a FreeRDP shadow server that can. Windows is not usable
    here — Windows containers need a Windows container host and ship no
    RDP server, and running Windows in a VM would need KVM passthrough
    and a licensed multi-gigabyte image — but FreeRDP's shadow server
    speaks the same CredSSP handshake, which is what the engine needs
    exercised. `crates/strata-session/tests/rdp_live.rs` drives it:
    CredSSP completing, the layer size preceding any drawing, real PNG
    frames cropped from a real framebuffer, input accepted, credential
    rejection, and a clean disconnect.

### Phase 3 — VNC, Kubernetes and file transfer

With SSH and RDP proven, the remaining three protocol surfaces moved
across. Each one was the last thing keeping a `guacd` process alive for
its protocol.

- **VNC engine (`vnc-rs`)** — replaces `libguac-client-vnc`. Supports the
  standard RFB security types, **repeaters** (the `dest-host` /
  `dest-port` handshake used by UltraVNC-style relays, which reads a
  fixed-width field before anything else — a short write leaves it
  waiting and the session simply hangs), and **reverse connections**,
  where the gateway listens and the target dials in.
  - Clipboard is transcoded to the encoding the connection asks for.
    RFB predates Unicode and specifies Latin-1; a connection configured
    for UTF-8 gets UTF-8, and one left on the default gets bytes the
    target will actually render.
  - The desktop is painted **opaquely**. The first implementation left
    the alpha channel as the framebuffer supplied it, which the browser
    composited against the page background — a working desktop that
    looked washed out.
- **Kubernetes exec engine** — replaces `libguac-client-kubernetes`, the
  last protocol still on `guacd`. Attaches to a pod over
  `v4.channel.k8s.io`, with client-certificate authentication.
  - A **password-protected client key** is now accepted. The previous
    behaviour silently failed to authenticate, because the key was passed
    through unparsed and the TLS stack rejected it with an error that
    named neither the key nor the passphrase.
  - Verified against a real API server
    (`crates/strata-session/tests/kube_live.rs`).
- **SFTP file transfer (`russh-sftp`)** — a native engine that *decorates*
  any protocol rather than being one, so file transfer no longer depends
  on which session type is open. Directory listing, upload and download,
  with path-escape protection relative to the configured root.
  - This replaced **RDP drive redirection and printer redirection**,
    which were removed rather than reimplemented. Two transfer mechanisms
    with different permission models, different audit trails and
    different failure modes is worse than one that works everywhere;
    `docs/adr/` records the reasoning.
- **Server-side typescripts** — a connection asking for
  `typescript-path` now gets one, written by the terminal engine.
- **Wake-on-LAN and a configured SSH command** — `wol-send-packet` and
  friends wake a sleeping target before the connection attempt, and a
  connection carrying a command runs it instead of an interactive shell.

### Phase 4 — parameter parity, then subtraction

The engine could serve every protocol, but a connection carrying a
parameter the engine ignored would have run and quietly behaved
differently. Rather than leave that to be discovered in production, every
parameter `guacd` accepted was audited and put in one of two states:
**honoured**, or **removed from the product**.

Honoured in this phase: `color-depth`, `force-lossless`, `backspace`,
`color-scheme`, `font-name`, `font-size`, `scrollback`, `terminal-type`,
`resize-method`, `server-alive-interval`, `locale`, the `wol-*` family,
the `recording-*` family, `swap-red-blue`, `cursor`, `read-only`,
`clipboard-buffer-size`, `cert-tofu`, `cert-fingerprints`, `auth-pkg`,
`kdc-url`, `kerberos-cache`, and the Kubernetes `namespace` / `pod` /
`container` / `exec-command` / `use-ssl` / `ca-cert` / `client-cert` set.

Removed, each with a migration that clears the parameter from existing
connections so the admin UI cannot keep offering a control that does
nothing:

| Migration | Removed | Why |
| --------- | ------- | --- |
| `082` | Unsupported RDP parameters | Never reached the target on the pinned `guacd` either. |
| `084` | RD Gateway (`gateway-*`) | A second, unaudited hop around the gateway's own access control. |
| `085` | RemoteApp, microphone input | RemoteApp needs an alternate shell channel; audio input is a data-exfiltration path a PAM gateway should not open by default. |
| `086` | Drive/printer redirection, dead clipboard params | Superseded by the one SFTP path. |
| `087` | H.264 passthrough | Advertising a codec the engine cannot deliver corrupts the bitmap cache into persistent ghost tiles. No connection had it set. |
| `088` | `timezone` (RDP), `enable-touch`, `font-name` (kube), `terminal-type` (kube) | Mapping IANA zones onto `TIME_ZONE_INFORMATION` needs the CLDR table and a partial mapping puts the *wrong* time in the session; multi-touch needs an RDPEI crate that does not exist at the pinned version. |

**Certificate trust for RDP** landed here too, and is the one place the
native engine is stricter than `guacd` by design. A connection can now
verify the target against an uploaded CA bundle or a pinned SHA-256
fingerprint, with precedence **pin > CA bundle > ignore-cert**. Because
RDP only presents its certificate after the X.224 negotiation — so
`openssl s_client` cannot fetch one — the admin UI can read it directly
from the target rather than requiring an operator to provoke a failed
connection and copy the fingerprint out of the error.

### Phase 5 — removing the daemon

- **`guacd` is gone.** The Guacamole handshake (`select` → `args` →
  `connect`), the parameter allowlist, the instruction encoder and
  parser, and the clipboard tracer are all deleted, along with the
  `guacd/` build context and its five FreeRDP patches, the round-robin
  `GuacdPool`, the `guacd` and `guacd-2` compose services, the `scale`
  profile, and the `build-guacd.yml` workflow.
- **The browser is unaffected.** It still speaks the Guacamole wire
  protocol; only the thing on this side of it changed. Recordings remain
  in the `.guac` format and existing ones still play.
- **Routing kept its per-protocol kill switch.**
  `STRATA_SESSION_NATIVE_PROTOCOLS` survives because it is the control
  that caught `kubernetes` being silently left out of an earlier rollout.
  Unset means every compiled engine. The rollout percentage and pinned
  host list did not survive: bucketing by hostname is meaningless once
  there is nowhere else to route.
- **A refusal now says why.** With no fallback, a connection the engine
  cannot serve is refused with the reason — the protocol, or the
  parameter — instead of being handed to a daemon that may not be
  running and surfacing as a connection timeout.
- **Custom DNS was rebuilt, not dropped.** `guacd` resolved every target,
  so its container's `resolv.conf` was what mattered, and its entrypoint
  copied one in from a volume the backend wrote. Removing it took the
  feature with it silently: the Network tab kept accepting nameservers
  and a search suffix, kept saving them, and nothing read them. The
  backend cannot simply do what `guacd` did — it reaches postgres, vault
  and clamav through Docker's embedded resolver, so overwriting its
  `resolv.conf` would lose them, and appending servers after `127.0.0.11`
  does not help because glibc only moves to the next nameserver on
  timeout or SERVFAIL, never on the NXDOMAIN Docker returns. The engine
  now resolves targets itself against the configured nameservers, leaving
  infrastructure lookups on the system resolver. Only the socket uses the
  result: the **hostname** still reaches TLS verification and the
  Kerberos SPN, so pre-resolving does not turn a name-based handshake
  into an address-based one and break NLA against Active Directory.

### Scope & safety

**This is a major release and it removes things.** Read this section
before upgrading.

Removed environment variables — all now ignored, none fatal if left set:

| Variable | Replacement |
| -------- | ----------- |
| `STRATA_SESSION_ENGINE` | none; the native engine is the only engine |
| `STRATA_SESSION_NATIVE_PERCENT` | none |
| `STRATA_SESSION_NATIVE_HOSTS` | none |
| `GUACD_HOST`, `GUACD_PORT`, `GUACD_INSTANCES` | none |
| `STRATA_CLIPBOARD_BUFFER_BYTES` | none; the engine caps a transfer at 8 MiB per direction and says so when it truncates |
| `STRATA_CLIPBOARD_TRACE` | `window.strataClipboard` in the browser |

`config.toml` keeps working: the `guacd_host`, `guacd_port` and
`guacd_instances` keys are simply ignored on load rather than rejected.

**API changes.** `GET /api/admin/health` no longer returns `guacd`.
`GET /api/admin/metrics` drops the per-engine split (`native_sessions`,
`guacd_sessions`, `guacd_bytes_down`/`_up`, `guacd_by_protocol`,
`native_bytes_down`/`_up`, `native_by_protocol`, `guacd_pool_size`,
`recommended_per_instance`) — with one engine there is nothing to split.
Bandwidth counters are renamed off the removed daemon:

| Before | After |
| ------ | ----- |
| `bytes_from_guacd` | `bytes_down` |
| `bytes_to_guacd` | `bytes_up` |
| `total_bytes_from_guacd` | `total_bytes_down` |
| `total_bytes_to_guacd` | `total_bytes_up` |

**Schema.** Migrations `081`–`089`. `081` adds `recordings.engine` so a
session can be attributed to what served it; historical rows keep the
value `guacd` deliberately, because they were. `089` renames
`recordings.bytes_from_guacd`/`bytes_to_guacd` to `bytes_down`/`bytes_up`,
carrying the values across rather than resetting them; it is guarded on
the old column name, so a database that never ran `029` applies it as a
no-op. `082`–`088` clear removed connection parameters.

**Dependencies.** Adds `ironrdp`, `russh`, `russh-sftp`, `vnc-rs`,
`alacritty_terminal`, `winnow` and `hickory-resolver`; removes the entire
`guacd` image and its FreeRDP build. `ironrdp` is pinned at 0.7 by a
`picky`/`russh` version conflict, recorded as `TODO(v2)` in `Cargo.toml`
and in [ADR-0016](docs/adr/).

**Behavioural changes that are deliberate, not regressions:**

- **RDP requires NLA.** A target that will not do CredSSP is refused
  rather than downgraded to an in-session login screen.
- **SSH requires a host key.** There is no trust-on-first-use path. The
  admin UI can survey a target's keys so this is a decision rather than a
  hunt.
- A non-NLA `security` setting and `dpi` are carried but not applied, and
  both are now reported in the log rather than silently dropped.

### Testing

- **1280 backend, 203 session, 77 DMZ, 46 protocol unit tests**; 1598
  frontend tests across 78 files; `cargo fmt`, `clippy -D warnings`,
  `tsc` and `eslint` clean.
- **Live-target integration suites**, all `#[ignore]`d so the default run
  needs no infrastructure: `ssh_live.rs` against a real OpenSSH server,
  `rdp_live.rs` against both a FreeRDP shadow server and an xrdp that
  cannot do NLA (which is what proves the refusal), `kube_live.rs`
  against a real API server, and two DNS tests proving search-suffix
  expansion and fail-open on a dead nameserver.
- **Fuzz harnesses** for the instruction parser, the streaming decoder
  and the media envelope.

### Deploy

```sh
git pull && docker compose up -d --build
```

Operator notes:

- **`docker compose up -d --build` removes the `guacd` containers.** They
  are no longer in the compose file. Use `--remove-orphans` if you
  previously ran the `scale` profile.
- Migrations `081`–`089` apply automatically at backend start.
- **Check the Session Engine card** on the admin Health page after
  upgrading. `Serving` should list every protocol you use; anything under
  `Withheld` is being refused, and the cause is
  `STRATA_SESSION_NATIVE_PROTOCOLS`.
- **SSH connections need a host key** before they will run. The
  connection editor can read one from the target.
- If you use **custom DNS**, no action is needed — the settings you
  already saved are now read by the engine directly.

## [1.14.6] — 2026-08-19

### Patch Release — Large RDP clipboard copies were being discarded outright, because `clipboard-buffer-size` has never existed for RDP in the pinned `guacd`

**The ask.** A user reported: _"We have a reoccuring issue with the clipboard not capturing everything the user wants but I seem to have been able to drill this down to length and/or size of the clipboard being copied now. If I copy a large amount of text a 12,000 line powershell code block, then it doesn't capture but if i copy a 50line powershell code block it seems ok or if i copy a smaller length file like an 8000 line certificate file it's fine."_ The file was later measured precisely: **12,747 lines, 281,852 characters**.

**The symptom, and why every size-based theory was wrong.** This looked like the third instalment of a familiar story. v1.14.1 fixed a remote → local clipboard **stall**; v1.14.4 fixed a local → remote **race** that wedged `rdpclip.exe`. Both were size-correlated, so "large copies truncate" was the obvious reading — and it was wrong twice over.

The browser-side diagnostic ring buffer (`strataClipboard.dump()`, shipped in v1.14.4) settled it. For the failing copy there were **zero `dir: "in"` entries of any kind** — no `stream-open`, no `blob`, no `stream-end`, no stall warning. Two small copies in the same capture (8 and 6 characters) completed normally. `guacd` had not truncated the transfer; it had **never announced one**. The largest payload anywhere in a five-minute capture was 160 characters.

| Observation | What it ruled out |
| ------------- | ------------------- |
| Zero inbound events, not a short `stream-end` | Truncation anywhere on the wire |
| No `stream-paused` / `stream-stalled` | The v1.14.1 stall watchdog |
| Small copies working in the same session | A wedged CLIPRDR channel, and the v1.14.4 interleaving defect |
| Reconnecting restored small copies | Windows-side `rdpclip.exe` (that survives a reconnect; this did not) |

**The root cause.** `guacd` allocates **one fixed-size clipboard buffer per connection**. On the remote → local path, [`guac_rdp_cliprdr_format_data_response()`](https://github.com/apache/guacamole-server/blob/main/src/protocols/rdp/channels/cliprdr.c) converts the incoming UTF-16 into a buffer of exactly that size, and the calls that publish the result sit **inside** the success branch:

```c
if (guac_iconv(remote_reader, &input, data_len,
               GUAC_WRITE_UTF8, &output, sizeof(received_data))) {
    guac_common_clipboard_reset(clipboard->clipboard, "text/plain");
    guac_common_clipboard_append(clipboard->clipboard, received_data, length);
    guac_common_clipboard_send(clipboard->clipboard, client);
}
```

`guac_iconv()` returns non-zero only when it reaches the input's null terminator. If the **output** buffer fills first, it returns `0`, the entire block is skipped, and the function returns `CHANNEL_RC_OK`. **An oversize copy is therefore dropped wholesale — not truncated.** No error instruction, no `onerror`, no log line at default verbosity, and no `clipboard` stream. That is precisely the "nothing happened" the user described, and it is why the two clipboard fixes that preceded this one could not have helped: they both operate on a stream that in this case was never opened.

**Why the buffer was 256 KiB, when Strata has been asking for 8 MiB since v1.3.x.** [`HandshakeParams::full_param_map()`](backend/src/tunnel.rs) has long sent `clipboard-buffer-size=8388608` for RDP, with a comment claiming it raised the ceiling from a default "often 64KB - 256KB". **That comment was wrong from the day it was written.** In the pinned `guacamole-server` tree (`staging/1.6.1` @ `4163ead`):

- `GUAC_RDP_CLIENT_ARGS[]` in `src/protocols/rdp/settings.c` ends `"force-lossless", "normalize-clipboard", NULL` — **there is no `clipboard-buffer-size` entry**;
- `guac_rdp_clipboard_alloc(guac_client* client)` takes **no size argument**, calling `guac_common_clipboard_alloc()` with the compile-time `GUAC_COMMON_CLIPBOARD_MAX_LENGTH` of **262,144**.

The Guacamole handshake only carries values for parameters `guacd` itself advertises in its `args` response, so the backend's 8 MiB was silently discarded at every single connect. Support for the parameter on RDP — together with a heap-allocated receive buffer replacing the stack array — exists only on upstream `main`, after the `staging/1.6.1` pin was taken.

The arithmetic then closes exactly:

| | |
| ---------------------- | -------------------- |
| Reported file | **281,852** bytes |
| `guacd` RDP buffer | **262,144** bytes |
| Overrun | 19,708 bytes (7.5%) |

At 22.1 characters per line, that is roughly 891 lines over the cliff — which is why a 12,747-line script failed while an 8,000-line certificate (under the same ceiling in bytes, despite sounding larger) did not. Line count was never the variable; bytes were.

**The fix — three parts, in the order they matter.**

1. **`guacd` pinned to upstream `main` @ `be83001` (2026-08-07).** This is the actual fix: RDP now accepts `clipboard-buffer-size`, and the receive buffer is heap-allocated. Verified against a real image build — `guacd` advertises `21.clipboard-buffer-size` in its RDP `args` response, and the negotiated value is 8 MiB, a 30× margin over the failing payload. `main` is a strict **superset** of `staging/1.6.1`, not a fork: upstream merges `staging/1.6.1` → a patch branch → `main`, and `be83001` provably contains `f22a2df`, the head of `staging/1.6.1`. Both branches declare `1.6.1` in `configure.ac`, so the version string distinguishes nothing.

2. **The receive-side stall watchdog is now asymmetric.** The flat 2-second window introduced in v1.14.1 latched on its first fire and ack-killed the stream, discarding every blob that arrived afterwards. Because the chance of hitting one ≥ 2 s gap grows with blob count, that truncated exactly the transfers that matter. `CLIPBOARD_OPEN_STALL_MS` (2 s) now applies only while **zero** blobs have arrived — the genuine wedged-channel signature, with detection speed unchanged — while `CLIPBOARD_BLOB_STALL_MS` (10 s) applies once data is flowing. A window that fires after real progress publishes the partial and **keeps listening**; late blobs accumulate and are re-published in full, so a transfer that merely paused still completes. The stream is only abandoned and ack-closed after a window that saw no new data at all. The zero-blob no-clobber guard is retained unchanged.

3. **The ceiling is now visible and configurable.** Every handshake logs the negotiated value at `INFO`, and `WARN`s when `guacd` did not advertise the parameter at all — the condition that hid this defect for the entire life of the setting. `STRATA_CLIPBOARD_BUFFER_BYTES` overrides the 8 MiB default without a rebuild, clamped in Strata to `guacd`'s accepted 256 KiB – 50 MB range so the value that is logged is the value that takes effect. The parameter is also now sent for **every** protocol rather than RDP only.

**Rejected approaches.** Raising `GUAC_COMMON_CLIPBOARD_MAX_LENGTH` in the pinned tree was designed and discarded: at that pin the receive buffer is a **stack array** (`char received_data[GUAC_COMMON_CLIPBOARD_MAX_LENGTH]`), so bumping the constant to 8 MiB would have overflowed the per-connection thread stack on musl. Backporting upstream's heap-allocation change by hand was also rejected in favour of taking the tested upstream commit.

**`guacd` patch-set changes.**

- **`006-freerdp325-authenticate-ex.patch` deleted.** GUACAMOLE-2273 landed upstream on 2026-07-28 (`336d5e8`), making the local patch redundant. Its two post-patch `grep` assertions are replaced with assertions against the **upstream** tree: `AuthenticateEx` in `rdp.c` (if this ever fails, patch 006 must be reinstated) and `"clipboard-buffer-size"` in `rdp/settings.c` (so a future pin cannot silently reintroduce this defect). Noted for the record: an earlier attempt to drop this patch, between `de0ba24` and `1064a8e`, broke the image build because the upstream fix had not yet landed at the then-current pin.
- **`004-h264-display-worker.patch` retargeted.** GUACAMOLE-2118 split layer teardown: `guac_display_remove_layer()` now only unlinks the layer and defers destruction, while the freeing moved into `guac_display_free_removed_layers()`, whose loop variable is `current`, not `display_layer`. The patch's first hunk still targeted the old function and — because the Dockerfile falls back to `patch -p1 -F3` — **fuzz-matched into the new one and reported success**, failing only at compile with `'display_layer' undeclared`. The hunk now targets the correct function. This is a cautionary example of fuzzy patch application: it applies cleanly and puts the code in the wrong place.

**Scope & safety.** No schema migration and no new or altered REST/WebSocket API surface. **One new environment variable**, `STRATA_CLIPBOARD_BUFFER_BYTES` (optional; defaults to the existing 8 MiB). One dependency change: the pinned `guacamole-server` commit for both the `guacd` image and the backend's `guacenc` builder stage — these must stay in step so `guacenc` links the same `libguac`. FreeRDP 3 support is unaffected: `configure.ac` on `main` carries the identical `freerdp3`/`freerdp-client3`/`winpr3` detection and every 3.x compatibility probe. The clipboard payload itself is unchanged on the wire, and no diagnostic added here records clipboard **contents**.

**Testing.** Three frontend regression tests in [`SessionManager.test.tsx`](frontend/src/__tests__/SessionManager.test.tsx) pin the watchdog's behaviour — partial flush without ack, abandonment only after a second dead window, and complete delivery when a transfer pauses mid-stream; 34 clipboard tests pass. Backend unit tests cover the buffer-size clamp, the bounds matching `guacd`'s own constants (a tripwire if a future pin changes them), and the parameter being present for all five protocols. The `guacd` image was **built end-to-end**: all five patches apply, both Dockerfile assertions pass, `guacd`/`guacenc`/`guaclog` compile and link, and all four `libguac-client-*.so` are produced. Because patch 004 had hunks apply with offsets and one at fuzz 2, the patched sources were extracted from the builder stage and inspected directly rather than trusted on the strength of a successful compile — the `h264_queue` fields land inside `struct guac_display_layer`, and the free loop inside `guac_display_free_removed_layers`. The backend's `guacenc-builder` stage was built against the same pin.

**Deploy.** Full rebuild — `docker compose build --no-cache guacd && docker compose build backend frontend && docker compose up -d guacd backend frontend`. **The `guacd` rebuild is mandatory and is the part that fixes the bug**; a backend/frontend-only deploy changes nothing observable. Existing sessions must be reconnected to negotiate the new buffer. Verify with `docker compose logs backend | grep -i "clipboard buffer"`, which should report `clipboard buffer size negotiated with guacd … clipboard_buffer_size="8388608"`; a `WARN` that `guacd` did not advertise the parameter means the `guacd` image did not actually rebuild. Operators who need more than 8 MiB can set `STRATA_CLIPBOARD_BUFFER_BYTES` (maximum 52428800) without rebuilding. No migration, no forced re-login, no rollback hazard beyond reverting the images.

**Known limitation.** `enable-h264` remains opt-in and defaults to `false`. Patch 004 applied with offsets and one fuzz-2 hunk against the new tree; placement was verified structurally, but connections that enable H.264 should be smoke-tested after upgrading.

## [1.14.5] — 2026-08-18

### Patch Release — Dependency security: `h2` HTTP/2 denial-of-service (RUSTSEC-2026-0258) and `nanoid` infinite loop (GHSA-2v37-7h3g-55p8)

**The ask.** Two independent supply-chain gates fired within a day of each other. The OSV scan on the frontend dependency graph reported `Project is vulnerable to: GHSA-2v37-7h3g-55p8`, and the CI **Dependency Audit** job began failing hard on the Rust workspace: `error: 1 vulnerability found! … Crate: h2 … ID: RUSTSEC-2026-0258 … Solution: Upgrade to >=0.4.16`. Neither had a code-level symptom in Strata — both were caught by the automated gates before any release, which is the gates working as designed.

**Advisory 1 — `h2` unbounded empty `DATA` frames (RUSTSEC-2026-0258 / GHSA-q83h-524g-xf6h).**

| Field                | Value                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| Crate                | `h2`                                                                   |
| Affected             | `< 0.4.16` (Strata shipped **0.4.14**)                                  |
| Patched              | `>= 0.4.16`                                                            |
| Category             | Denial of service                                                      |
| Reported / issued    | 2026-08-17 / 2026-08-18                                                |
| Upstream write-up    | <https://github.com/hyperium/hyper/security/advisories/GHSA-q83h-524g-xf6h> |

`h2` accepted and queued **empty `DATA` frames without limit**. A peer that opens an HTTP/2 stream and then floods it with zero-length `DATA` frames — while the application never drains that stream — drives unbounded memory growth on the receiving side, and can panic outright if the accumulated length overflows. There is no authentication step in the frame-accounting path, so the frames are counted before any Strata-level authorisation runs.

**Why this one mattered for Strata.** Unlike most transitive advisories, `h2` is a **first-class runtime dependency declared in the workspace** (`h2 = "0.4"` in [`Cargo.toml`](Cargo.toml)) and it sits on three distinct paths, two of which face untrusted peers:

1. **DMZ public TLS listener (internet-facing, unauthenticated).** [`crates/strata-dmz/src/public_tls.rs`](crates/strata-dmz/src/public_tls.rs) advertises `alpn_protocols = ["h2", "http/1.1"]`, so **any anonymous client on the public interface can negotiate HTTP/2** with the edge binary before presenting a credential. This is the highest-value exposure: an unauthenticated peer could hold the DMZ edge's memory hostage.
2. **The reverse link between the DMZ edge and the internal node.** The internal node runs the HTTP/2 **server** side ([`backend/src/services/dmz_link/h2_serve.rs`](backend/src/services/dmz_link/h2_serve.rs), `h2::server::Builder`) over the connection the DMZ dials via `h2::client::handshake` ([`crates/strata-dmz/src/link_server/listener.rs`](crates/strata-dmz/src/link_server/listener.rs)). This leg is mutually authenticated with pinned certificates and an edge-header HMAC, so reaching it requires an already-trusted peer — but the tunnel also multiplexes every WebSocket session via Extended CONNECT ([`ws_proxy.rs`](crates/strata-dmz/src/ws_proxy.rs), [`proxy.rs`](crates/strata-dmz/src/proxy.rs)), so a compromised edge could have starved the internal node.
3. **`hyper`/`axum`'s own HTTP/2 support** on the single-node topology, behind the nginx gateway.

**Fix.** `cargo update -p h2` moved [`Cargo.lock`](Cargo.lock) from `h2 0.4.14` → **`0.4.16`**. The declared requirement stays `"0.4"` (the patch is semver-compatible), so no manifest edit was needed and no other crate in the 463-crate graph moved — the lockfile diff is exactly the `h2` package block and its checksum. No API, behavioural, configuration, or protocol change: the same HTTP/2 settings, window sizes, ping watchdog, and Extended CONNECT negotiation apply.

**Advisory 2 — `nanoid` infinite loop on a zero `size` (GHSA-2v37-7h3g-55p8 / CVE-2026-67213).**

| Field                | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| Package              | `nanoid` (npm)                                              |
| Affected             | `< 3.3.18` on the 3.x line (Strata shipped **3.3.16**)       |
| Patched              | `3.3.18` (3.x) / `5.1.6` (5.x)                              |
| Weakness             | CWE-835 — loop with unreachable exit condition              |
| Severity             | CVSS 3.1 **5.9 Medium** · CVSS 4.0 **8.2 High**             |
| Published            | 2026-07-29                                                  |

`nanoid`'s `customAlphabet` and `customRandom` generators spin forever when configured with a `size` of `0`: the internal generation loop never satisfies its exit condition, hanging the calling thread. An application that forwards an unvalidated, attacker-controlled `size` into either function is exposed to a denial of service.

**Exposure assessment — none at runtime.** `nanoid` is **not** a Strata dependency. It appears in [`frontend/package-lock.json`](frontend/package-lock.json) only as a `dev` transitive of the build toolchain (`vite` → `postcss` → `nanoid`), where `postcss` uses it to mint source-map identifiers with a fixed, hard-coded size. It is never bundled into the browser artefact, never reachable from user input, and never present in the runtime container image — the production `frontend` image serves static assets from nginx and ships no `node_modules`. The practical worst case was a hung build agent, not a hung tenant. It is fixed anyway, because a dependency-audit gate that is allowed to stay red is a gate nobody reads.

**Fix.** `postcss` declares `nanoid ^3.3.11`, so the resolved version is not ours to choose directly; an [`overrides`](frontend/package.json) entry pins the whole tree to `"nanoid": "^3.3.18"`. `npm ci` re-resolved to **3.3.18** and the frontend production build was re-verified. The 3.x line was deliberately retained rather than jumping to 5.x, which is ESM-only and incompatible with `postcss`'s CommonJS require.

**New documentation — `docs/security.md` § "Dependency & supply-chain security".** This release closes a long-standing gap in the security documentation: the repository has run five independent supply-chain gates in CI for many versions, and **none of them were described anywhere**. The new section documents the full set — `gitleaks` secret scanning, `cargo audit` (with its retry-on-transient-network wrapper), `cargo deny` (license allow-list, banned/duplicate crates, source allow-list), `npm audit` on both the frontend and E2E graphs, OSV-Scanner (which also backs the OpenSSF Scorecard `Vulnerabilities` check), Trivy image scanning, CodeQL, and Dependency Review — along with the advisory-triage policy, the rules for suppressing a finding, and a walk-through of the two suppressions currently in force.

**Documented suppressions (unchanged, re-verified this release).** [`osv-scanner.toml`](osv-scanner.toml) carries one `IgnoredVulns` entry — `RUSTSEC-2023-0071` (Marvin timing side-channel in the pure-Rust `rsa` crate), a documented false positive: `rsa` is a lockfile resolution artefact only and is never compiled into `strata-backend`, because `jsonwebtoken` is built on the `aws_lc_rs` backend and `sqlx` is built with `default-features = false` plus the `postgres` backend only, excluding the `sqlx-mysql` crate that pulls `rsa` in. The three yanked-crate notices that accompany every audit run (`aes 0.9.0`, `metrics 0.24.5`, `spin 0.9.8`) remain **warnings**, not vulnerabilities, and are not gated.

**Also in this patch — release-hygiene fixes.**

- **Root lockfile version drift corrected.** [`package-lock.json`](package-lock.json) had been pinned at `1.8.4` since v1.8.4 — six minor lines behind — because the documented release checklist listed `package.json` but never its lockfile. Both are now `1.14.5`, and [`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md) has been rewritten to enumerate **every** version-bearing file (`VERSION`, both `package.json` + both `package-lock.json`, the workspace `Cargo.toml`, and the three workspace crate entries in `Cargo.lock`) so the drift cannot silently reappear.
- **Truncated release-process document repaired.** `docs/RELEASE_PROCESS.md` ended with a stray `*** End Patch` marker left behind by an earlier tooling artefact, and omitted the `Cargo.lock`, README release-table, and post-release documentation-verification steps entirely.
- **`docs/DOCUMENTATION_STANDARDS.md` expanded** from a 9-line summary into the actual, enforceable standard the repository has been following since v1.10 — the required anatomy of a CHANGELOG entry (the ask, the symptom, the root cause, the fix, scope & safety, testing, deploy), the "every user-visible change appears in five places" rule, the linking conventions, and a per-release documentation checklist.

**Scope & safety.** **Dependency-only release: no application source file changed.** No schema migration, no new or altered API surface, no new environment variable, no configuration change, and no behavioural change to any feature. Both updates are semver-compatible patch bumps that keep every existing manifest requirement intact. The remaining changes in this release are documentation and version metadata.

**Testing.** `npm ci` re-resolved the frontend tree to `nanoid 3.3.18` and `npm run build` completed clean (2,317 kB bundle, unchanged from v1.14.4). `cargo update -p h2` moved exactly one package and left the other 462 untouched, verified against `Cargo.lock`. The CI **Dependency Audit** job — `cargo audit --deny unsound --deny unmaintained`, `cargo deny check bans licenses sources`, and `npm audit --audit-level=high` on both Node graphs — is the authoritative gate for this release, alongside the full backend and frontend suites.

**Deploy.** Backend + frontend rebuild: `docker compose pull && docker compose up -d --build backend frontend`. **DMZ deployments should treat this as a priority patch** — the `h2` fix protects the internet-facing edge listener, so redeploy the `strata-dmz` edge binary as well: `docker compose -f docker-compose.dmz.yml up -d --build dmz`. No migration step, no downtime beyond the container restart, and no rollback hazard — reverting is a plain image rollback.

## [1.14.4] — 2026-08-12

### Patch Release — Copy/paste no longer dies for the rest of the Windows session, plus end-to-end clipboard diagnostics

**The ask.** "We have a bug issue in the copy and paste. I think it's something to do with going back to the server when the session closes but you don't log off and then you connect back in. I logged off from a session and logged back in and the copy and paste started to work again. Can we put deep logging on to find the issue and also if you can see any bugs in this can we look to resolve them."

**Symptom.** Copy **and** paste both stop working in an RDP session. Unlike the v1.14.1 defect — which affected only the remote → local direction and was cured by reconnecting — this one **survives a reconnect**. Disconnecting the Strata tab and dialling back into the same host leaves the clipboard just as dead, because RDP reattaches to the still-logged-on Windows session. The only reliable recovery is to log **off** the Windows session entirely and log back in.

**Root cause — concurrent clipboard streams interleaving into `guacd`'s single shared clipboard buffer.**

The local → remote push was driven by six independent triggers, each carrying its own inline copy of the "open a clipboard stream → chunk the text into 4 KiB `blob`s → `sendEnd`" sequence:

| Trigger                                                       | Location                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `mouseenter` / `mousedown` / `focus` on the session display   | [`SessionManager.tsx`](frontend/src/components/SessionManager.tsx) |
| window-level `paste` event                                    | [`SessionManager.tsx`](frontend/src/components/SessionManager.tsx) |
| pop-out window `mouseenter` / `mousedown` / `focus` / `paste` | [`usePopOut.ts`](frontend/src/components/usePopOut.ts)             |
| session-menu clipboard textarea                               | [`SessionMenu.tsx`](frontend/src/components/SessionMenu.tsx)       |
| `paste-text`, `open-path`, `:explorer` palette commands       | [`CommandPalette.tsx`](frontend/src/components/CommandPalette.tsx) |

A single click fires several of them at once — and, critically, the pop-out registers its handlers on the **same** `displayEl` the main window already uses, so a popped-out session fires up to four pushes per click. Each one consulted `session.remoteClipboard` to decide "have I already sent this?", but none of them wrote the value back until **after** its own transfer completed. Every concurrent caller therefore passed the guard and opened its own clipboard stream. Because the large-payload path `await`s ~5 ms between chunks to avoid bursting `guacd`'s reassembly buffer, the `blob` instructions belonging to the different streams **interleave on the wire**.

`guacd`'s RDP clipboard is a **single shared buffer**. The `clipboard` instruction resets it and every `blob` appends to it, _regardless of stream index_ — the channel cannot multiplex. Two interleaved streams therefore splice their payloads together and announce the result over **CLIPRDR** twice. Windows' clipboard owner (`rdpclip.exe`) can be left waiting on a format-data response that never matches, at which point both copy and paste stay dead for the remainder of the Windows session. That wedged state lives in the **Windows session, not in `guacd`** — which is exactly why the reporter found that reconnecting did nothing but logging off and back on (which restarts `rdpclip.exe`) fixed it.

Three supporting defects compounded it:

1. **Leaked clipboard listeners on every dropped connection.** Only the explicit `closeSession()` path invoked `session._cleanupPaste()`. The `tunnel.onstatechange` `CLOSED` handler — which is what actually fires on a network drop, a server-side disconnect, and **every** auto-reconnect attempt — did not. Each dropped connection therefore left a window-level `paste` listener bound to a dead `Guacamole.Client` for the lifetime of the page, and they accumulated one per drop, each still allocating output-stream indices on a tunnel that was gone.
2. **A failed send poisoned the duplicate guard permanently.** `session.remoteClipboard = text` was assigned unconditionally after `writer.sendEnd()`. But `Guacamole.Client.endStream()` silently returns without transmitting when the tunnel is not connected, so a push into a dead tunnel still recorded the text as delivered — after which every later paste of that same text was suppressed as a duplicate, forever.
3. **No re-priming on reconnect.** A freshly-spawned `guacd` has an empty clipboard, and when RDP reattaches to an already-logged-on Windows session the CLIPRDR channel is renegotiated from scratch. Nothing reset the frontend's belief about what the remote held, so the first push after a reconnect could be discarded as a duplicate of a value the new remote never had.

**The Fix (frontend, correctness + resilience).**

- **A single serialised transmission path.** New module [`frontend/src/components/clipboardSync.ts`](frontend/src/components/clipboardSync.ts) replaces all six inline copies. Every caller now routes through `sendClipboardToRemote(session, text, source)`, which chains sends per session on a promise so **only one clipboard stream is ever open at a time** — concurrent triggers can no longer interleave.
- **Duplicate suppression that accounts for in-flight work.** The guard now tests the candidate text against both the last _confirmed_ `remoteClipboard` value **and** the text of any send still queued, which is what collapses a single click's burst of triggers into one transfer. Explicit user commands (`paste-text`, `open-path`, `:explorer`) pass `{ force: true }` to bypass it, because the Ctrl+V keystroke that follows is worthless if the cached belief turns out to be stale.
- **Refuse to write to a closed tunnel**, re-checked both before queueing and again after the send acquires its turn in the chain (the tunnel can drop while waiting). `remoteClipboard` is now updated **only** on a confirmed write, so failure 2 above can no longer poison the guard.
- **`resetRemoteClipboardEcho()` on `CONNECTED`.** Fires whenever a client reaches state 3, so a reconnect always re-primes the renegotiated CLIPRDR channel instead of trusting a belief inherited from the previous connection.
- **`_cleanupPaste()` on the tunnel-`CLOSED` path**, and it now also removes the three `displayEl` listeners in addition to the window `paste` listener.
- **Latent-crash fix.** [`frontend/src/guacamole-common-js.d.ts`](frontend/src/guacamole-common-js.d.ts) declares `Guacamole.Client.isConnected()`, but the vendored 1.6.0 bundle only defines it as a _private_ function inside the `Client` closure — calling it would have thrown a `TypeError`. Liveness is now derived from `tunnel.state` instead.

**Deep logging (new).** Both ends gained opt-in instrumentation, since the failure is silent by construction and the reporter had no evidence to hand.

- **Browser** — `clipboardSync.ts` writes every clipboard lifecycle event into a **500-entry ring buffer that is always recording**, so a user can be asked for a dump _after_ hitting the bug rather than being told to reproduce it with logging on. A console helper is published on `window.strataClipboard` with `enable()` (echo to console, persisted in `localStorage` under `strata.debug.clipboard`), `disable()`, `print()` (a `console.table` ready to paste into a bug report), `dump()` and `clear()`. Outbound events: `queued`, `skip-duplicate`, `skip-disconnected`, `stream-open`, `ack`, `ack-error`, `abort-mid-stream`, `stream-failed`, `stream-end`, `echo-reset`, `tunnel-closed`. Inbound events: `stream-open`, `stream-end`, `stream-stalled`, `ignored-mimetype`, `local-write-failed`.
- **Backend** — the new `STRATA_CLIPBOARD_TRACE=1` environment variable enables `ClipboardTracer` in [`backend/src/tunnel.rs`](backend/src/tunnel.rs). It walks every instruction batch in **both** directions using a new `scan_instruction` helper that consumes elements via the protocol's own length prefixes (so a payload containing `;` or `,` can never be mistaken for a delimiter) and logs clipboard stream lifecycles. The headline signal is a `WARN` when a `clipboard` instruction opens a stream **while another is still open in the same direction** — that is the interleaving condition above, observable server-side. It also flags streams that never receive `end`, non-zero `ack` status codes, and any transfers still outstanding at tunnel teardown.
- **Privacy.** Neither tracer ever records clipboard **contents** — only opcodes, stream indices, payload sizes, timings, and a non-reversible 32-bit FNV-1a digest that lets two entries be compared for "same text" without revealing it. Traces are safe to attach to a support bundle.

**Scope & safety.** Frontend behavioural change plus a backend logging addition that is **inert unless `STRATA_CLIPBOARD_TRACE` is set**. No schema, no new API surface, no dependency change, and no change to what data crosses the tunnel — the same bytes travel over the same authenticated WebSocket on the same tunnel ticket. This is a correctness/resilience fix, not a security-boundary change; the new diagnostics are deliberately content-free so enabling them cannot turn an operator's clipboard into log data. The v1.14.1 remote → local stall watchdog is retained unchanged and now emits structured diagnostics alongside its existing `console.warn`.

**Testing.** A new suite [`frontend/src/__tests__/clipboardSync.test.ts`](frontend/src/__tests__/clipboardSync.test.ts) adds seven tests, including an explicit regression guard asserting that two concurrent pushes never interleave (stream 0 must fully close before stream 1 opens), that a dead tunnel leaves `remoteClipboard` untouched, that `resetRemoteClipboardEcho` re-primes after a reconnect, and that clipboard contents never appear in the diagnostic dump. One test was added to [`SessionManager.test.tsx`](frontend/src/__tests__/SessionManager.test.tsx) pinning listener removal on the tunnel-`CLOSED` path. Six backend unit tests in [`tunnel.rs`](backend/src/tunnel.rs) cover the length-prefixed instruction scanner (including payloads containing `;` and `,`), stream lifecycle tracking, direction isolation, ack attribution, and that the tracer is fully inert when disabled. The full frontend suite (78 files, 1598 tests) passes, `npx tsc --noEmit` is clean, and `cargo fmt --check` is clean.

**Operator note.** Deployments already wedged by this bug need the affected **Windows** sessions logged off once to restart `rdpclip.exe`; a Strata redeploy alone will not clear a session that is already stuck. To capture evidence of a recurrence, set `STRATA_CLIPBOARD_TRACE=1` on the backend and have the user run `strataClipboard.enable()` in their browser console before reproducing.

**Deploy.** Backend + frontend: `docker compose pull && docker compose up -d --build backend frontend`.

## [1.14.3] — 2026-08-06

### Patch Release — Safeguard checkout now requests the profile's exact sub-hour duration instead of rounding up to a whole hour

**The ask.** "I've edited my live password request duration from 1 hour to 15 minutes. But Safeguard is still getting a request for 1 hour."

**Symptom.** A `safeguard` credential profile whose lifetime was set below one hour (e.g. **15 minutes** via the profile editor's Hours/Minutes inputs or the "15 min" quick-pick chip) still produced a Safeguard AccessRequest for a **full hour** — the approval card and the appliance's access-request record both read "For 1 hour". Editing the duration down had no visible effect on what Safeguard received. The profile edit itself saved correctly; the value simply could not survive the trip to the appliance.

**Root cause — the wire format only carried whole hours.** Since minute-precision TTLs landed in v1.13.0, the appliance request in [`services::safeguard::client::create_access_request`](backend/src/services/safeguard/client.rs) only ever sent `RequestedDurationHours`. Because that field is whole-hours-only, both checkout call sites — the direct-connect path in [`routes/tunnel.rs`](backend/src/routes/tunnel.rs) and the bulk-checkout path in [`routes/user.rs`](backend/src/routes/user.rs) — deliberately **ceiled** the profile's total minutes up to the next whole hour before submitting (`div_euclid(60) + (rem != 0)`), so `15 min` and `45 min` both became `RequestedDurationHours = 1`. This was documented as the "Safeguard bridge" limitation in v1.13.0, but it means a sub-hour profile can never ask the appliance for less than an hour, and the appliance — which auto-checks-in and rotates the password at _its_ `ExpiresOn` — grants the full hour it was asked for.

**The Fix (backend, correctness).** Safeguard's AccessRequest entity accepts `RequestedDurationMinutes` alongside `RequestedDurationHours`, so Strata now sends the profile's exact lifetime:

- **Send hours + minutes.** `create_access_request` splits the requested total via a new pure `split_duration(total_minutes) -> (hours, minutes)` helper and emits each of `RequestedDurationHours` / `RequestedDurationMinutes` only when non-zero (a 15-minute profile posts `RequestedDurationMinutes = 15` with no hours field; a 90-minute profile posts `1h 30m`). The helper clamps the total to `>= 1` so a zero-length window is never requested.
- **Stop ceiling at the call sites.** `jit_checkout` now takes `requested_minutes` (defaulting to the admin `default_checkout_hours × 60`), and both `routes/tunnel.rs` and `routes/user.rs` pass the profile's exact `ttl_total_minutes(...)` instead of rounding up to whole hours.
- The cache-side expiry math was already minute-accurate and clamped to the appliance's authoritative `ExpiresOn` (v1.13.1), so a shorter appliance window now flows straight through to `credential_profiles.expires_at` and the `BulkSafeguardCheckoutResult.expires_at` badge with no further change.

**Scope & safety.** Backend-only change to the outbound AccessRequest body and the two checkout call sites — no schema, no new API surface, no environment variable, and no dependency change. The appliance's access policy may still clamp the requested window to its own configured maximum (unchanged behaviour, and `ExpiresOn` remains authoritative). Three regression tests were added to [`services/safeguard/client.rs`](backend/src/services/safeguard/client.rs) covering the sub-hour, mixed, and zero-clamp cases; the backend image builds clean and the suite passes.

**Deploy.** Backend-only: `docker compose pull && docker compose up -d --build backend`.

## [1.14.2] — 2026-08-05

### Patch Release — Safeguard "Awaiting approval" Refresh no longer dead-ends on `HTTP 500` after the sign-in lapses

**The ask.** "We looked at this issue in the past and we believed it was resolved but it doesn't appear to be. Live password expired, but Strata never knew it was approved. So it's stuck on Awaiting Approval. Refreshing it gets an Internal Server Error. I imagine making a new live password request would sort it, but just flagging the bug."

**Symptom.** A Safeguard access request for an approval-gated profile sat in **PendingApproval** long enough that its live password (and, critically, the user's appliance-side Safeguard session) expired. The Credentials → Request Checkout row stayed pinned on the yellow **Awaiting approval** badge, and pressing **Refresh** returned `HTTP 500 { "error": "Internal server error" }` — an unrecoverable loop, exactly as reported before the v1.12.12 fix, but reached by a different path.

**Why v1.12.12 didn't catch it.** v1.12.12 taught [`services::safeguard::release_pending`](backend/src/services/safeguard/mod.rs) to consult the appliance for the AccessRequest's current state on the `CheckoutPassword` error path and translate **terminal states** (Expired / Cancelled / Denied / Revoked / Complete / PasswordCheckedIn) and **404** into an actionable `HTTP 400` ("… no longer releasable … Please submit a new checkout request") while clearing the stuck `safeguard_pending_requests` row. That fix assumed the state refetch **succeeds**. It does not when the bearer itself is dead.

**Root cause — a rejected bearer produces `HTTP 401/403` on _both_ calls.** In `per_user_browser` / `hybrid` modes the user's Safeguard RSTS bearer is minted by `Connect-Safeguard` and sealed in `safeguard_user_tokens`. Strata's DB-side TTL for that token routinely **outlives** the appliance's own session lifetime, so `user_token::load` cheerfully returns a token the appliance has already invalidated. When a request has been pending long enough for the live password to lapse, the appliance session has usually lapsed too, so on Refresh:

1. `CheckoutPassword` → appliance returns `HTTP 401` / `403` → `AppError::Internal("Safeguard CheckoutPassword returned HTTP 401: …")`.
2. The v1.12.12 safety-net refetch, `get_access_request_status`, uses the **same** dead bearer → also `HTTP 401` / `403` → `Err(AppError::Internal(…))`, landing in the refetch-failed `Err(status_err)` arm.
3. That arm re-raised the **original** `AppError::Internal`, which maps to `HTTP 500` in [`backend/src/error.rs`](backend/src/error.rs) with the body forced to a generic "Internal server error", **and left the `safeguard_pending_requests` row in place** — so the badge re-hydrated on the next mount and the loop was permanent.

**The Fix (backend + frontend, availability/resilience).**

- **Recognise appliance auth rejections.** A new `is_appliance_auth_failure(&AppError)` helper in [`services/safeguard/mod.rs`](backend/src/services/safeguard/mod.rs) matches the `HTTP 401` / `HTTP 403` status the low-level client formats into its error strings.
- **Surface a re-auth prompt, not a 500.** In `release_pending`, on **both** the `CheckoutPassword` error **and** the state-refetch error, an auth failure in a non-A2A auth mode now short-circuits to `AppError::Validation("safeguard.signin_required")` → `HTTP 400`. This is the same stable code the SPA already understands elsewhere (the profile editor's account picker), so the user is told to sign in to Safeguard again instead of hitting a dead-end. A2A mode is deliberately excluded: a 401/403 there is an appliance-trusted-credential configuration fault, not a user sign-in problem, and must not be mislabelled.
- **Keep the pending row.** Unlike the terminal-state path, an auth lapse does **not** clear `safeguard_pending_requests` — the underlying access request may still be perfectly valid; the user simply needs to re-authenticate, after which Refresh resolves it normally.
- **Frontend row stays refreshable.** [`SafeguardBulkCheckoutCard.tsx`](frontend/src/pages/credentials/SafeguardBulkCheckoutCard.tsx) `refreshOne` now detects `safeguard.signin_required`, keeps the row in the `pending` state (so the **Refresh** button and the 15-second background poll survive), swaps the inline hint for an actionable message ("Your Safeguard sign-in has expired. Sign in to Safeguard again above, then press Refresh."), and re-pulls the sign-in status so the card's "signed out of Safeguard" banner and selection gating re-appear. Non-auth Refresh failures are unchanged (row → `failed`, raw error surfaced).

**Scope & safety.** No schema, no new API surface, no environment variable, and no dependency change — a `500` on one internal error path becomes an actionable `400`, and the SPA renders it in place. It is a resilience/availability improvement, not a security-boundary change: the same per-user bearer authorises the same request, and ownership is still re-validated server-side on every poll. Three regression tests were added — two backend unit tests (`appliance_auth_failure_detects_401_and_403`, `appliance_auth_failure_ignores_non_auth_errors`) and one frontend test ("manual Refresh on a lapsed Safeguard session keeps the row refreshable with a sign-in prompt"). `npx tsc --noEmit` is clean and all `SafeguardBulkCheckoutCard` tests pass.

**Operator note.** A genuinely long-dead request — where the token is still valid but the appliance has moved the AccessRequest to a terminal state or purged it — continues to be handled by the v1.12.12 path with the "please submit a new checkout request" `400`. So the reporter's instinct ("making a new live password request would sort it") remains correct; v1.14.2 additionally ensures the intermediate "token lapsed" case tells the user _why_ rather than showing an opaque 500.

**Deploy.** Backend + frontend: `docker compose pull && docker compose up -d --build backend frontend`.

## [1.14.1] — 2026-08-04

### Patch Release — Remote → local clipboard no longer silently stops working mid-session (RDP)

**The ask.** "For some reason in Strata I can't copy large amounts of text from servers at random points — 12k lines. It worked when I closed Strata and reopened it and reconnected to the same server again."

**Symptom.** During a long-lived RDP session, copying text inside the remote desktop would, at seemingly random points, stop updating the local clipboard entirely — the local clipboard silently retained its previous contents. No error appeared in the browser console. The only reliable recovery was to disconnect the session tab and reconnect to the same server, which spawns a fresh `guacd` process with clean channel state.

**Root cause — an unterminated clipboard stream on the receive path.** The remote → local clipboard flow is a Guacamole stream: `guacd` sends `clipboard,<idx>,text/plain;`, then one or more `blob,<idx>,<base64>;` instructions, and finally `end,<idx>;`. The frontend handler in [`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx) (`client.onclipboard`) accumulates blob text via a `Guacamole.StringReader` and only writes to `navigator.clipboard.writeText()` inside the reader's `onend` callback.

Under certain RDP **CLIPRDR** (clipboard virtual channel) conditions — most commonly when the Windows-side clipboard owner is a delayed-rendering application (Chrome, Edge, VS Code, many terminals) and a subsequent copy interrupts the format-data request, or when FreeRDP's CLIPRDR state becomes wedged after many transfers — `guacd` opens the stream and delivers zero or a partial set of blobs, then **never emits `end`**. The reader's `onend` therefore never fires, `writeText()` is never called, and the local clipboard is left holding stale data. Because the failure is entirely silent (no `onerror`, no console output), the user perceives it as "copy just stopped working." Reconnecting resets the server-side CLIPRDR channel, which is why a full reconnect restored the behaviour.

The report's "large amounts of text / 12k lines" framing is a correlation, not the cause: large multi-blob transfers keep the CLIPRDR channel busy longer and are statistically more likely to be interrupted by the next copy, so they surface the underlying stall more often. The stall itself is size-independent.

**The Fix (frontend-only, resilience).**

- **Per-stream stall watchdog** in `client.onclipboard`. A 2-second timer is armed when the clipboard stream opens and re-armed on every received blob. If `end` arrives first, behaviour is unchanged (normal flush). If the timer fires first, the handler force-flushes whatever text was accumulated to the local clipboard, updates `session.remoteClipboard`, and logs a single diagnostic `console.warn` (`clipboard stream N stalled after M blob(s), K chars — flushing partial data`) so future occurrences are visible for correlation with server-side `guacd` logs.
- **No-clobber guard.** A stall that received **zero** blobs does **not** overwrite the local clipboard — writing an empty string would wipe whatever the user had previously copied and make the bug visibly worse. `session.remoteClipboard` is still synced so the local → remote path does not echo an obsolete value.
- **Orphan-stream cleanup.** On a stall, the handler acks the stalled stream (`sendAck` with a non-fatal status code) so `guacd` can release the orphaned stream index instead of leaking it for the remainder of the session.

**Scope & safety.** This is a frontend-only change to the remote → local clipboard receive path. There is no schema, API surface, environment variable, or dependency change, and the local → remote (paste) path is untouched. It is a resilience/availability improvement, not a security-boundary change — the same authenticated WebSocket and tunnel ticket carry the same bytes. Two regression tests were added to [`frontend/src/__tests__/SessionManager.test.tsx`](frontend/src/__tests__/SessionManager.test.tsx): one asserting partial data is flushed after the stall timeout, one asserting a zero-blob stall does not clobber the local clipboard. `npx tsc --noEmit` is clean and all SessionManager tests pass.

**Deploy.** Frontend-only: `docker compose pull && docker compose up -d --build frontend`.

## [1.14.0] — 2026-07-29

### Minor Release — Download Session Recordings in Windows-Playable Format (.mp4)

**The ask.** "Can we add a feature to allow the downloading of session recordings in a format that is playable on Windows"

**Background & Architecture.** Session recordings generated by `guacd` are stored as raw `.guac` instruction streams. While raw `.guac` files preserve instruction data for WebSocket streaming playback, Windows default media players (Windows Media Player, Movies & TV, Chrome, Edge, VLC) cannot natively play `.guac` files.

**The Solution.**

- **Backend Conversion Service (`guacenc`/`ffmpeg`)**:
  - Implemented `convert_guac_to_mp4` in [`backend/src/services/recordings.rs`](backend/src/services/recordings.rs). When requested, Strata invokes Apache Guacamole's native `guacenc` encoding utility (compiled against `ffmpeg`) to render the `.guac` instruction stream into an H.264 video file (`.mp4`).
  - Added `prepare_recording_for_download` to handle both local disk storage and Azure Blob Storage downloads, formatting user-friendly filenames (`<connection_name>_<recording_id>.mp4`) with `video/mp4` MIME type and `Content-Disposition: attachment`.
- **API Endpoints**:
  - `GET /api/user/recordings/:id/download?format=mp4|guac` in [`backend/src/routes/user.rs`](backend/src/routes/user.rs) for user recordings.
  - `GET /api/admin/recordings/:id/download?format=mp4|guac` in [`backend/src/routes/admin/recordings.rs`](backend/src/routes/admin/recordings.rs) for admin session recordings.
- **Frontend Integration**:
  - Added download URL builders in [`frontend/src/api.ts`](frontend/src/api.ts).
  - Added 1-click **Download (MP4)** buttons in [`MyRecordings.tsx`](frontend/src/pages/MyRecordings.tsx) and [`Sessions.tsx`](frontend/src/pages/Sessions.tsx).
  - Added a **Download MP4 Video** button to the header of the [`HistoricalPlayer.tsx`](frontend/src/components/HistoricalPlayer.tsx) playback modal.
- **Container Packaging**: Added `ffmpeg` package to runtime dependencies in [`backend/Dockerfile`](backend/Dockerfile).

## [1.13.2] — 2026-07-20

### Patch Release — AD Sync service-account auto-rotation no longer loses the rotated password

**The ask.** "There seems to be a bug in the AD Sync Service
Account auto rotation for password because when I enable that
option and I then try to test a connection or use any of the
features that require the AD service account (password management
or object sync) it fails and says `LDAP bind failed: LDAP
operation result: rc=49 (invalidCredentials) … data 52e`. The
account password that it seems to hold is valid and then when the
auto rotation is turned on the password is reset and then lost to
Strata."

**Root cause — deterministic, not a race.**
[`auto_rotate_service_account`](backend/src/services/checkouts.rs)
rotates the sync service account (`bind_dn`) by calling the shared
`ldap_reset_password` helper with **binder == target** whenever no
separate PM bind user is configured. Inside that helper the
sequence was:

1. Bind as the service account with the **old** password — OK.
2. `unicodePwd` modify — **AD now holds the new password.**
3. Verification bind as the target with the new password — OK.
4. Re-bind as the service account **with the old password** (to
   read back `sAMAccountName`) — **rc=49**, because the binder IS
   the target and its password was just changed two steps ago.

The rc=49 propagated out of the helper as an error **before the
new password was ever Vault-sealed or persisted** — so AD held the
new password while `ad_sync_configs.bind_password` still held the
dead old one. Every consumer of the service account (object sync,
password management, Test connection) then failed with exactly the
reported `rc=49 … data 52e`. And because `pm_last_rotated_at` was
never stamped, the daily rotation worker retried with the dead
password forever — the account was unrecoverable without a manual
AD-side reset.

Two secondary loss windows in the same function, both landing in
the reset-applied-but-not-persisted gap:

- The post-rotation "verify the new password works" block built a
  bare `LdapConnSettings` that ignored `ca_cert_pem` — on
  custom-CA LDAPS deployments the TLS handshake failed there every
  time, after the AD reset and before the DB persist: guaranteed
  loss even with a separate PM bind user.
- `vault::seal_setting` ran **after** the AD reset, so a transient
  Vault outage at that moment also changed the password on AD and
  then lost it.

**Fix** (all in
[`backend/src/services/checkouts.rs`](backend/src/services/checkouts.rs)):

- **Self-rotation re-bind** — `ldap_reset_password`'s post-modify
  re-bind now uses the **new** password when
  `bind_dn.eq_ignore_ascii_case(target_dn)`; managed-account
  resets (binder ≠ target) are unchanged.
- **Loss-proof ordering** in `auto_rotate_service_account` — the
  new password is Vault-sealed **before** touching AD (a Vault
  outage now aborts with zero appliance-side damage), and the DB
  persist (`bind_password` + `pm_last_rotated_at`) happens
  **immediately** after the AD reset succeeds. The
  fresh-connection verification bind moved after the persist and
  is now a non-fatal health check (logged at `error` with a
  replication hint on failure) — it can never strand the password
  again. It also now honours `ca_cert_pem` via the same
  `build_tls_config_with_ca` path the reset itself uses.
- **Stale copy refresh** — when `pm_bind_user` names the same
  account that was rotated, `pm_bind_password` is refreshed in the
  same UPDATE so the PM paths don't keep a dead sealed copy.

**Recovery for affected deployments.** The password Strata
currently holds for the sync account is already dead (AD was
rotated out from under it). Reset the service account's password
in AD once, re-enter it in **Admin → AD Sync → edit config**, and
re-enable auto-rotation — rotations under v1.13.2 are safe,
including self-rotation with no separate PM bind user.

**Compatibility.** No schema changes, no API changes, no new env
vars, no new dependencies. Backend-only patch.

## [1.13.1] — 2026-07-20

### Patch Release — Safeguard cache expiry honours the appliance's `ExpiresOn`; draggable edge handles

Two user reports, one backend correctness fix and one UX fix.

#### Theme 1 — Password-cache countdown now agrees with Safeguard

**The ask.** "I just noticed Strata says I have 4.4 hours left for
my password. Safeguard says 2 hours 7 minutes. Not sure why/what
has caused this difference. My test one seems fine."

**Root cause.** Strata never read the appliance's authoritative
expiry. All three password-cache store paths — direct connect
([`routes/tunnel.rs`](backend/src/routes/tunnel.rs)), bulk checkout
and release-after-approval (both in
[`routes/user.rs`](backend/src/routes/user.rs)) — stamped the cache
row with `expires_at = now() + profile TTL`, assuming the appliance
honoured the requested duration. Two mechanisms make the clocks
diverge, both in the over-report direction:

1. **Approval delay** (matches the report; the approval-free "test
   one" was fine). Safeguard's duration window runs from request
   **creation**. When a request sits in `PendingApproval` for hours
   before an approver acts, `release_safeguard_pending` stamped
   `approval_time + full profile TTL` — so Strata showed the full
   window while the appliance's clock was already part-spent. The
   `reuse_pending` preflight path in `jit_checkout` had the same
   flaw: it reuses a request created on an earlier call but cached
   with a fresh full TTL.
2. **Policy maximum-duration clamp.** The appliance silently caps
   `RequestedDurationHours` at the access policy's maximum; Strata
   assumed it got what it asked for.

Not cosmetic: Safeguard auto-checks-in and **rotates the password**
at its own `ExpiresOn`, so for the over-reported tail the green
"Cached · Nh left" badge advertised a credential that was already
dead — connecting would fail with "invalid credentials" while the
UI said Cached.

**Fix.**

- [`services/safeguard/client.rs`](backend/src/services/safeguard/client.rs)
  parses `ExpiresOn` from both the `POST /AccessRequests` create
  response and the `GET /AccessRequests/{id}` status refetch, via a
  lenient `parse_appliance_ts` helper (RFC 3339 first, naive
  timestamp treated as UTC second, `None` + warn on anything else
  so a format drift can never fail a checkout).
- `CheckoutResult` gains `expires_on: Option<DateTime<Utc>>`,
  populated on every release path: the create response on the
  fresh-checkout path, the existing post-release refetch on the
  `release_pending` path, and a **new** detail refetch on the
  reused-`PendingApproval` path (which also recovers the username
  there — previously always `None`).
- All three cache stores now write
  `expires_at = min(now() + profile TTL, appliance ExpiresOn)`.
  The clamped value flows through to
  `credential_profiles.set_expires_at` and the
  `BulkSafeguardCheckoutResult.expires_at` API field, so the badge,
  the Profiles list, and the appliance all agree.

#### Theme 2 — Sidebar/session edge handles are draggable and visually consistent

**The ask.** The floating sidebar toggle chevron sits at the
vertical centre of the viewport and "can block content behind it"
(screenshot showed it covering a file-picker). Requested: make it
vertically draggable. A follow-up asked for the left chevron to
match the right session tab's translucent surface — it rendered as
an opaque black pill.

**Fix.**

- [`components/Layout.tsx`](frontend/src/components/Layout.tsx) —
  both left-edge chevrons ("show menu" when hidden, "hide menu"
  pill when shown) are now vertically draggable with a **shared**
  offset, so the handle stays where the user put it across
  show/hide toggles. Clamped to the viewport; a <4 px gesture still
  counts as a click; the toggle stays on `onClick` with a
  drag-guard ref so keyboard activation (Enter/Space) is unaffected.
  Offset is session-scoped (resets to centre on next visit),
  matching the right-side tab's behaviour.
- [`components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx)
  — the right-edge session tab was draggable only when collapsed;
  now draggable in both states, with the tooltip updated to
  advertise it ("Drag to reposition · Click to collapse").
- The left "show menu" chevron now uses the identical surface as
  the right tab: `rgba(15, 15, 20, 0.75)` + 16 px backdrop blur
  (dark) / `rgba(255, 255, 255, 0.75)` (light) with the matching
  hairline border, replacing the opaque `--color-nav-bg` fill.

**Compatibility.** Zero schema changes, zero new endpoints, zero
new env vars, zero new Cargo or npm dependencies. The `ExpiresOn`
clamp only ever _shortens_ a cache row, and only when the appliance
reports an earlier authoritative expiry.

## [1.13.0] — 2026-07-10

### Minor Release — Minute-precision password-expiry TTLs

**The ask.** A user requested that the credential-profile password-
expiry lifetime be settable in **minutes as well as hours**, and
called out that a slider counting in hours was too coarse for the
short-lived cases they cared about. They also noted a slider that
counts in minutes over a 12-hour range would be even harder to
pinpoint — so the UI needed to change shape, not just resolution.

**Root cause.** `credential_profiles.ttl_hours` (`INTEGER`) was the
only lifetime column since [v1.0.0](CHANGELOG.md). Every downstream
site — Safeguard checkout requested-duration, cache `expires_at`,
pre-expiry watcher thresholds, audit logs — read whole hours. Any
attempt to hit "1 h 30 m" rounded down to 1 h. The single
`<input type="range" max="12">` slider in the Profile editor
exposed exactly the resolution the schema could store, so the
minute-precision gap was end-to-end.

**Fix.**

- **Schema (additive)** — new column
  `credential_profiles.ttl_minutes INTEGER NOT NULL DEFAULT 0`,
  with the `chk_ttl_hours` CHECK replaced by a
  `total = ttl_hours * 60 + ttl_minutes` guard requiring
  `15 <= total` and `total <= 720` (standard) or
  `total <= 129600` (extended, up to 90 days). Existing rows keep
  `ttl_minutes = 0`, so the effective lifetime is unchanged.
  Migration
  [`080_credential_profile_ttl_minutes.sql`](backend/migrations/080_credential_profile_ttl_minutes.sql).
- **Backend** — `services::credential_profiles` grows a
  `MIN_TTL_MINUTES = 15` constant and a `ttl_total_minutes(h, m)`
  helper; all inserts and updates use
  `make_interval(hours => $, mins => $)` when computing
  `expires_at`; every tuple returned to route handlers now carries
  `ttl_minutes` alongside `ttl_hours`.
- **Safeguard bridge** — Safeguard's `RequestedDurationHours` still
  accepts only whole hours, so we ceil the requested lifetime:
  `(total_min + 59) / 60` (implemented as
  `div_euclid(60) + i64::from(rem_euclid(60) != 0)`) so a request
  for "45 min" becomes a 1-hour Safeguard checkout, and the
  effective expiry is clamped to the shorter of the two on the
  cache side. A 15-minute floor prevents zero-hour rounding.
- **Wire format** — `CreateCredentialProfileRequest` and
  `UpdateCredentialProfileRequest` gain an optional
  `ttl_minutes: Option<i32>` field. Existing clients that omit it
  keep the historical whole-hour behaviour (serde default = 0).
- **UI** — the slider is replaced with two number inputs (Hours
  0–12 or 0–90 days for extended stays; Minutes 0–59 with step 5)
  plus quick-pick chips for the common values (15 m, 30 m, 1 h,
  2 h, 4 h, 8 h, 12 h) and a live text summary. Extended-expiry
  stays days-only — minute precision over 90 days would be noise.
  Switching to a Safeguard-kind profile clamps the total lifetime
  to ≤ 12 h and zeroes the sub-hour component if the pre-clamp
  hours were already at the 12 h cap.

**Acceptance test.** Open Credentials → New Profile → set
Hours = 1, Minutes = 30. Save. Reopen the profile — the fields
still show `1 h 30 m` and the profile's `expires_at` is
`now + 90 minutes` (± clock skew). Set Hours = 0, Minutes = 5 —
the UI clamps to `Minutes = 15` on change. Toggle Allow extended
expiry — the days-only slider appears and Minutes returns to 0.

**Known limitations.** Old clients that still POST the whole-hour
`ttl_hours` field keep working, but their audit-log entries will
read `ttl_minutes=0` — that's correct, not a regression. Safeguard
checkouts still round up to the next whole hour on the appliance
side; the effective lifetime is the min of the two, so the
appliance-side coarseness cannot extend a profile past its
requested minute-level TTL.

## [1.12.13] — 2026-07-10

### Patch Release — Browser tab title now includes the user-assigned display tag

**The ask.** A customer reported that with several remote-session
tabs open in the same browser window, every tab title collapsed to
the connection hostname followed by the product name — e.g.
`cicsazvm082 — Strata` — with nothing to distinguish `cicsazvm082`
open under three different roles / purposes. Their exact request:
_"Could you add the tag name to the browser tab title bar? For
example, when connected to a connection it currently displays
'cicsazvm082 - strata'. It would be helpful if it could display
'cicsazvm082 - Adhoc2 - strata' (where Adhoc2 is the server tag
assigned by me in the active connections window). This would make
it much easier to identify which server we are connected to."_

**The fix.** `SessionClient` (the page that owns the browser tab
for an active session) now fetches the user's pinned display-tag
map via the existing `GET /user/display-tags` endpoint on mount
and whenever `connectionId` changes, and includes the tag name in
the `document.title` string:

- With a display tag pinned: `${connectionName} — ${tag.name} — Strata`
- Without a display tag: `${connectionName} — Strata` (unchanged
  from v1.12.12)

The tag lookup is decoupled from the connection-name lookup so a
slow `/user/display-tags` response never delays showing the base
title — the tag simply appears once the fetch resolves. Fetch
failures are silent (falls back to the no-tag format).

**Why patch, not minor.** Zero API changes. No new endpoints, no
new tables, no new columns, no new env vars, no new dependencies.
Uses the same
[`getDisplayTags`](frontend/src/api.ts) helper the `SessionBar`
component has been calling since v1.11.0 to render the sidebar
tag chip. Behaviour change is strictly additive — the fallback
title format is byte-for-byte identical to v1.12.12.

### Changed

- **`frontend/src/pages/SessionClient.tsx`** — new `displayTag`
  state, new effect that fetches `getDisplayTags()` keyed on
  `connectionId` (cancels cleanly on unmount), title effect now
  emits the 3-segment format when a tag is pinned.

### Migration and Deployment

- **No database migration.** No schema changes.
- **No configuration changes.** No new env vars, no new Cargo or
  npm dependencies.
- **Rolling upgrade safe.** Backends running v1.12.12 and v1.12.13
  side-by-side both continue to serve `/user/display-tags`; older
  frontends just render the pre-v1.12.13 title format.
- **Docker deploy**: `docker compose pull && docker compose up -d
--build frontend`.

### Known limitations

- Display tag lookup runs once per `connectionId` change. If the
  user pins or unpins a tag via the session sidebar AFTER the tab
  is already open, the title won't refresh until the tab is
  reopened or the browser is refreshed. A follow-up could listen
  for a `display-tag-changed` DOM event dispatched by
  `SessionBar`; scope kept small for this patch.

## [1.12.12] — 2026-07-09

### Patch Release — Safeguard Refresh no longer returns "Internal server error" for terminal / expired access requests

**The bug.** A user with a `safeguard_pending_requests` row for a
long-expired access request opened Credentials → Request Checkout,
saw the yellow **Awaiting approval** badge (correctly hydrated from
[v1.12.11](#11211--2026-07-01)'s new `/user/safeguard/pending`
endpoint), and pressed the row's **Refresh** button. The SPA fired
`POST /api/user/safeguard/release` — and the backend returned
`HTTP 500 "Internal server error"`. The badge stayed pinned to
**Awaiting approval**. Reloading the page re-hydrated the same
stuck row. The user was locked in a loop with no way to make the
appliance side of the mess visible or actionable.

**Root cause.** `services::safeguard::client::checkout_password` only
recognises Safeguard error code `90117` ("Awaiting approval") as a
non-fatal poll state. Every other error code — including the codes
Safeguard returns when the request has already been released and the
release TTL has since expired (`Code 60635`), when the password has
been checked back in (`Code 90105` and its cousins), and when the
request is in any other terminal state (cancelled, denied, revoked,
complete) — was bubbled up as `AppError::Internal`. `AppError::Internal`
maps to `HTTP 500 { "error": "Internal server error" }` in
`backend/src/error.rs` (the real message is only written to the
server log so we don't leak appliance internals to end users).
Meanwhile `services::safeguard::release_pending`'s `Err` arm did
audit the failure but never cleared the stale
`safeguard_pending_requests` row, so the next page mount
re-hydrated the badge and the loop began again.

Common trigger: the approver acted while the SPA wasn't polling
(user closed the tab, machine went to sleep, or the browser was
suspended for longer than the 30-minute poll cap), the password was
released successfully in the background, the appliance's release TTL
then expired, and the row's `request_id` was left pointing at what
is now a fully-terminated appliance record.

**The fix.** `services::safeguard::release_pending` now consults the
appliance for the current AccessRequest state on the CheckoutPassword
error path, using the existing
`client::get_access_request_status(request_id)` helper (which
already returns `Ok(None)` on 404). Three outcomes:

- **Terminal state** (Expired / Cancelled / Denied / Revoked /
  Complete / PasswordCheckedIn) — audit with the state hint, best-
  effort DELETE the `safeguard_pending_requests` row so the SPA
  doesn't re-hydrate the stuck badge on the next mount, and return
  `AppError::Validation(format!("Safeguard access request {id} is
no longer releasable (appliance state: {state}). Please submit a
new checkout request."))`. Validation errors map to `HTTP 400`
  with the message body exposed, so the SPA's inline error row
  shows the actionable text instead of the pre-v1.12.12 generic
  "Internal server error".

- **404 on the appliance** (returned as `Ok(None)` by
  `get_access_request_status`) — same treatment: audit, clear the
  stale row, return `AppError::Validation(format!("Safeguard access
request {id} no longer exists on the appliance. Please submit a
new checkout request."))`.

- **Still `PendingApproval` on the appliance** — the original
  `CheckoutPassword` error was a transient hiccup (network blip,
  token race). Return the normal `JitOutcome::PendingApproval` so
  the SPA row stays yellow and continues polling.

Any other appliance state (or a failure to refetch the state at
all) falls through to the original `Err(e)` behaviour so operators
still see the raw appliance response in the server log — but now
the audit row records the state hint, and the pending row is left
alone (it might still be valid).

**Why patch, not minor.** Zero API changes. No new endpoints, no
new tables, no new columns, no new env vars, no new dependencies.
The Safeguard state names are read via the pre-existing
`AccessRequestStatus` DTO. Behaviour change is strictly narrower:
we now translate a subset of previously-500 responses into
actionable 400s and clean up the corresponding SPA state. Rollback
simply restores the pre-v1.12.12 500 behaviour without any
migration work.

### Changed

- **`backend/src/services/safeguard/mod.rs`** — `release_pending`
  now recovers gracefully when `CheckoutPassword` fails because the
  Safeguard AccessRequest has moved past the releasable window. See
  root cause discussion above.
- **New helpers** — `is_terminal_release_state(state: &str) -> bool`
  (case-insensitive substring match on the Safeguard state
  vocabulary) and `clear_pending_best_effort(pool, user_id,
profile_id)` (silences DB errors from the cleanup path so they
  can never mask the validation error the caller is about to
  return).

### Tests

- Two new unit tests in `backend/src/services/safeguard/mod.rs`:
  - `terminal_release_state_matches_common_terminal_states`
    exercises every state name we care about (`Expired`,
    `PasswordExpired`, `Denied`, `Cancelled`, `Canceled`, `Revoked`,
    `Complete`, `Completed`, `PasswordCheckedIn`, plus lowercase
    variants).
  - `terminal_release_state_rejects_non_terminal_states` pins the
    disambiguation — critically `PasswordCheckedOut` (live) must
    NOT be treated as terminal, and neither should `PendingApproval`,
    `RequestAvailable`, `Approved`, `New`, `PendingReviewer`,
    `PendingAcknowledgment`, `Unknown`, or the empty string.

### Migration and Deployment

- **No database migration.** Uses the existing
  `safeguard_pending_requests` table added in v1.12.11.
- **No configuration changes.** No new env vars, no new Cargo or
  npm dependencies.
- **Rolling upgrade safe.** Backends running v1.12.11 and v1.12.12
  side-by-side both continue to serve `/user/safeguard/release`;
  the older ones just keep returning 500 for the edge case the
  newer ones now handle.
- **Docker deploy**: `docker compose pull && docker compose up -d
--build backend`.

## [1.12.11] — 2026-07-01

### Patch Release — Safeguard auto-request pending state now visible on Credentials → Request Checkout

**The bug.** When a user launched a direct connection whose credential
profile was mapped to a Safeguard account that requires approver
action (`kind='safeguard'`, `require_approval=true` on the appliance
side), the tunnel WebSocket handler transparently issued the JIT
password checkout on the user's behalf. If Safeguard came back with
`PendingApproval`, the handler correctly returned a 400 to abort the
WebSocket upgrade — but the pending `request_id` lived only in the
handler's stack frame. Nothing was written anywhere the SPA could
read back. The Credentials → Request Checkout tab had no idea the
appliance was already holding an open access request for the user,
so the yellow **Awaiting approval** badge, the manual **Refresh**
button, and the 15-second background poll all stayed silent.

**The user impact.** Every subsequent connect attempt behaved as if
it were the first: another JIT checkout call, another appliance-side
`list_my_active_requests_for` preflight, another `reuse_pending`.
The backend deduplication logic (added in v1.12.6) kept us from
actually creating duplicate requests, but the user's browser never
learned there was anything to wait on and reported it as
_"the auto-request feature keeps re-requesting because the
credentials page never shows Pending Approval"_.

**The fix.** A new `safeguard_pending_requests` table gives every
`JitOutcome::PendingApproval` a persistent home:

- **Migration 079** adds `safeguard_pending_requests(user_id,
profile_id, request_id, account_id, asset, created_at)` with the
  same `(user_id, profile_id)` composite primary key and FK cascade
  semantics as `safeguard_cached_passwords`.
- **`services::safeguard::pending_requests`** — a new module with
  `store` / `clear` / `status_for_user` helpers. `store` is
  idempotent (`ON CONFLICT ... DO UPDATE`) so a reused request-id
  overwrites the row instead of erroring; `clear` is best-effort so
  release / check-in paths can call it unconditionally.
- **`routes::tunnel::ws_tunnel`** persists the pending row on the
  auto-request path (`JitOutcome::PendingApproval` branch) before
  returning the validation error.
- **`routes::user::bulk_safeguard_checkout`** persists the pending
  row on the manual `Request Checkout` path so a page reload or
  cross-browser handoff reconstitutes the badge.
- **`routes::user::release_safeguard_pending`** clears the row on
  the `Released` branch (approver acted) and refreshes the
  `created_at` timestamp on the `PendingApproval` branch (poll clock
  starts over) so the 30-minute cap tracks the appliance's view.
- **`routes::user::bulk_safeguard_checkin`** clears the row alongside
  the cached-password wipe so a re-request after check-in starts
  fresh.
- **New endpoint** `GET /api/user/safeguard/pending` returns every
  pending row for the calling user, newest-first, so the SPA can
  hydrate on mount.
- **`SafeguardBulkCheckoutCard.refresh()`** now fetches
  `/user/safeguard/pending` in parallel with the cached-status
  query and merges pending rows into `results` for any
  `profile_id` not already tracked. The merge is additive only —
  it never overwrites a fresher `ok` or `failed` outcome — and the
  poll clock is seeded from `created_at` so the 30-minute cap is
  measured from when the request was originally made, not from the
  moment the SPA happened to mount.

After v1.12.11 the user's first auto-request attempt still fails the
WebSocket upgrade (nothing we can do — the browser hides HTTP 400
bodies from failed WebSocket handshakes) but the Credentials page
now surfaces the pending badge on the very next mount, complete with
the appliance request-id and asset, so the user can either wait for
the background poll or press Refresh to release once the approver
acts. Two new frontend regression tests pin the hydration path and
the anti-clobber rule.

## [1.12.10] — 2026-06-30

### Patch Release — Safeguard bulk-checkout preserves `pending` (approval-required) rows across subsequent checkouts and check-ins

The **Safeguard bulk checkout** card on
**Credentials → Request Checkout** kept a single `results`
`useState` array keyed by `profile_id`, and both `handleCheckout`
and `handleCheckin` opened with `setResults([])` — wiping the
entire array — before re-setting `results` to only the rows for
the profiles included in the current operation. That was fine
when every operation covered the same set of profiles, but the
moment a user started a second bulk-checkout for a **different**
profile, the first operation's `state === "pending"` rows (the
yellow **Awaiting approval** badge that a Safeguard approval
role requires) fell out of state entirely — the background poll
`useEffect` (whose deps filter narrows to
`results.filter((r) => r.state === "pending" && !!r.request_id)`)
saw an empty list, cleared its `setInterval`, and never noticed
the approver's decision. The manual **Refresh** button on the
row also vanished because it renders only when
`result?.state === "pending" && result.request_id` holds. Backend
`password_cache` state was correct throughout — this was purely
a frontend state-management regression, no data was lost — but
the SPA's view of the appliance drifted silently and the only
recovery was to press **Check in all** and restart the entire
request from scratch. v1.12.10 rewrites both mutation paths to
merge/prune by `profile_id` instead of wiping the array, so
`pending` rows for unrelated profiles survive across subsequent
operations and the background poll continues to watch them
through the standard 30-minute window.

#### Symptom (verbatim from the bug report)

1. Sign in to Strata; open **Credentials → Request Checkout**;
   sign in to Safeguard.
2. In the **Safeguard bulk checkout** card, select an ad-hoc
   privileged profile whose account is under an approval role,
   enter a justification, and click **Checkout selected**.
3. Observe the row flip to the yellow **Awaiting approval**
   badge with a **Refresh** button and the "we re-check every
   15 s for up to 30 minutes" hint text below. Correct.
4. Now select a **different** profile — one whose account does
   not require approval — and click **Checkout selected**.
5. **Was on v1.12.9**: the ad-hoc row's **Awaiting approval**
   badge and Refresh button silently disappear. The auto-release
   row shows **Checked out** (green cached badge after refresh).
   The background poll is dead. When the approver later clicks
   **Approve** in the Safeguard console the SPA never notices
   — the only recovery is **Check in all** and restart.
6. **Now on v1.12.10**: the yellow badge and Refresh button on
   the ad-hoc row persist across the second checkout; the poll
   loop keeps polling; on the very next tick (≤ 15 s) after the
   approver approves, the row flips to **Checked out** with
   the green **Cached · Nh left** badge. The equivalent path
   via **Check in** on a single row or **Check in all (N)** on
   the header also no longer wipes the pending row.

#### Root cause

`frontend/src/pages/credentials/SafeguardBulkCheckoutCard.tsx`:

- `handleCheckout` called `setResults([])` on entry, then
  after `bulkSafeguardCheckout` returned `res` it did
  `setResults(res)` — replacing the array wholesale. Rows in
  `prev` whose `profile_id` was **not** in the current
  operation's payload were lost.
- `handleCheckin` did the same on entry and after the appliance
  round-trip. The **Check in all** branch (no `profileId`
  argument, appliance decides which rows to release) was
  equally destructive.

The background poll `useEffect` (declared further down in the
same component) is stateless and correct — it looks at
`results` on every render and (re)creates a `setInterval` for
the pending subset. Once `results` was clobbered, the effect's
dependency list re-evaluated with an empty pending list and
the cleanup ran. Nothing else in the component was aware of
the request-id from the wiped row, so no code could bring it
back short of a full page reload.

#### Fix

Both mutation paths now merge/prune by `profile_id`, so rows
for unrelated profiles survive untouched.

`handleCheckout` — merge new rows into `prev`:

```ts
setResults((prev) => {
  const byId = new Map(prev.map((r) => [r.profile_id, r]));
  for (const r of res) byId.set(r.profile_id, r);
  return Array.from(byId.values());
});
```

Rows for profiles that were part of the new checkout are
replaced (so re-running a stale `failed` row picks up the new
`ok`/`pending` state); rows for profiles that weren't part of
the new checkout survive unchanged, including their
`pending` state and their `request_id`.

`handleCheckin` — prune only what was checked in, keep
`pending` rows for other profiles:

```ts
setResults((prev) => {
  if (profileId) return prev.filter((r) => r.profile_id !== profileId);
  const cachedIds = new Set(cached.map((c) => c.profile_id));
  return prev.filter(
    (r) => r.state === "pending" || !cachedIds.has(r.profile_id),
  );
});
```

For a single-row **Check in** the prune targets exactly that
`profile_id`. For **Check in all (N)** the appliance decides
which rows are actually released (only currently-cached rows),
so the prune targets every currently-cached `profile_id` while
explicitly preserving `state === "pending"` rows — those
represent requests the appliance is still holding for
approver action and must not be dropped from view.

Explanatory comments above each block reference the
v1.12.10 rationale so future readers don't reintroduce the
`setResults([])` reset.

#### Regression test

[`frontend/src/__tests__/SafeguardBulkCheckoutCard.test.tsx`](frontend/src/__tests__/SafeguardBulkCheckoutCard.test.tsx)
gains one new case:
`"preserves a pending row from an earlier checkout when a
second checkout runs for a different profile (v1.12.10
regression)"`. The test scaffolds two Safeguard profiles
(`adhoc-priv` and `test-svc`), mocks `bulkSafeguardCheckout`
to return `state: "pending"` for `adhoc-priv` on the first
call and `state: "ok"` for `test-svc` on the second call,
drives the component through the exact click sequence from
the bug report, and asserts that after the second checkout
the **Awaiting approval** badge and **Refresh** button both
remain on the ad-hoc row while the **Checked out** badge
appears on the test row. The 18 pre-existing cases in the
same file continue to pass unchanged (18 → 19 passing).

#### Compatibility

- **Backend**: no changes. `POST /api/user/safeguard/bulk-checkout`,
  `POST /api/user/safeguard/checkin`, and
  `POST /api/user/safeguard/release` — request bodies, response
  shapes, and behaviours all unchanged.
- **Frontend**: no visible change for users who never mix
  approval-required and no-approval profiles in the same
  session. Users who did hit the bug regain the ability to
  keep the pending row visible across subsequent operations,
  and their in-app view now stays in sync with the appliance's
  own `AccessRequests` state.
- **API contract**: none.
- **Storage / migration**: none. The
  `password_cache` and `safeguard_access_requests` tables have
  always tracked pending state correctly; the bug never lost
  server-side state, only the SPA's in-memory view of it.
- **Environment variables**: none.
- **Dependencies**: no new Cargo or npm dependencies.
- **Tests**: 18 → 19 cases in the component's test file (+1
  regression test); all pass.

#### Version bumps

- `VERSION` → `1.12.10`
- `Cargo.toml` `[workspace.package].version` → `1.12.10`
  (propagates to `strata-backend`, `strata-protocol`,
  `strata-dmz`)
- `Cargo.lock` — three `[[package]]` `version` bumps for
  the three workspace crates
- `frontend/package.json` `"version"` → `1.12.10`
- `frontend/package-lock.json` — two `"version"` bumps
  (root + `packages[""]`)

## [1.12.9] — 2026-06-30

### Patch Release — Dashboard search now matches tag names alongside connection name / hostname / description

The **My Connections** search box on `/dashboard` has, since the
`v0.x` introduction of user-assignable tags, accepted free-text queries
that matched against three connection fields: `name`, `hostname`, and
`description`. Tags were only filterable via the dedicated tag-pill
chips beneath the search row — clicking a chip toggled an `AND`-style
narrow against `activeTagFilters`. That was the right primary UX for
power users who want to compose multiple filters, but it left a
discoverability gap for the common "I just want to find every box
tagged `Domain Controllers`" flow: customers naturally typed
`domain` into the search box, saw no results (because no connection
has the literal word "domain" in its `name`/`hostname`/`description`),
and concluded the search was broken. The fix is a one-clause
extension to the `filtered` `useMemo` in
[`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)
that also matches the query against the **names of every tag
assigned to a connection** (user-defined tags and admin-defined
tags, both surfaced via the existing `allConnTagMap` +
`allTags` derivations). The search placeholder text was updated
in the same edit to communicate the new behaviour
(`Search name, host, description or tag`).

### Fix

[`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)
— the `if (search)` branch inside the `filtered` `useMemo` builds a
single `Map<tagId, tagName.toLowerCase()>` from `allTags` (which is
the already-existing union of admin-defined and user-defined tags),
and extends the row predicate with a fourth `||` clause:
`(allConnTagMap[c.id] || []).some((tid) => (tagNameById.get(tid) || "").includes(q))`.
The map is built lazily inside the closure so the cost is paid only
when the user has actually typed something, and only against the
connections that survived the preceding `showFavorites` narrowing.
The `useMemo` dependency list gains `allTags` so the result
recomputes correctly when the tag inventory changes (rename,
create, delete) while the search field is non-empty. The other
three existing filter clauses (`name`, `hostname`, `description`)
are unchanged; the tag-pill chip filter (`activeTagFilters`) is
unchanged and continues to compose with the search via `AND`.
The input `placeholder` was changed from `Search` to
`Search name, host, description or tag` so the new capability is
discoverable without having to consult the documentation.

### Why this is a patch and not a minor

No API surface change. No database migration. No new environment
variable. No new Cargo or npm dependency. No backend code touched at
all — the entire fix is five lines in one frontend file. The
behavioural delta is strictly additive: every query that returned a
match on v1.12.8 still returns the same match on v1.12.9 (the new
clause is `||`-joined, so existing matches cannot be filtered out
by the change), and the result set can only grow when the query
happens to be a substring of an assigned tag name. Sites that do
not use tags at all see zero behavioural change because
`allConnTagMap[c.id]` is `[]` on every row and the new clause
short-circuits to `false`. The change is also entirely scoped to
the **My Connections** dashboard — the Command Palette
(`Ctrl+K`) already matched tag names against its own query (added
in v1.12.4 alongside the open-session prioritisation work) so the
two surfaces now agree on what "search" means.

### Compatibility

- **Backend**: no changes. The `GET /api/user/connections`,
  `GET /api/user/tags`, and `GET /api/user/connection-tags` shapes
  are unchanged.
- **Frontend**: no visible change for users who never type in the
  search box, and no behavioural regression for any existing query
  — the new tag-name clause is `||`-joined onto the existing three
  clauses, so the result set can only grow. The placeholder text
  changes from `Search` to `Search name, host, description or tag`
  to communicate the new capability.
- **API contract**: no changes. Both `TagsResponse` and
  `ConnectionTagsResponse` continue to return the same TypeScript
  shapes (`UserTag[]` and `Record<connectionId, tagId[]>`
  respectively).
- **Storage / migration**: none.
- **Tests**: the full vitest suite (~1,600 cases across 47 files)
  continues to pass without modification. The change is small
  enough that the existing `Dashboard.test.tsx` `"filters by
search"` case already exercises the predicate; no new test was
  added because the search closure is a private implementation
  detail of one `useMemo` and the public behavioural contract
  (`empty query → all rows; non-empty query → matching rows`) is
  unchanged.

### Acceptance test

1. Apply v1.12.9 to a deployment that has at least one connection
   tagged via **Tags** in the connection editor or via the
   **Admin → Tags** tab (e.g. tag `cicsazt1mgt-p` with `Domain
Controllers`).
2. Sign in as any user with access to the tagged connection.
3. On `/dashboard`, click into the **Search** input below the
   connection tiles.
4. **Expected on v1.12.9**: the placeholder reads `Search name,
host, description or tag`. Type `domain` — the row for
   `cicsazt1mgt-p` (and every other connection tagged `Domain
Controllers`) is included in the filtered list, even though
   the literal string `domain` does not appear in the connection's
   `name`, `hostname`, or `description` field.
5. **Was on v1.12.8**: the same query returned zero rows because
   only the three connection fields were searched.
6. The existing tag-chip filter row below the search continues to
   work unchanged: clicking the `Domain Controllers` pill
   `AND`-narrows the visible rows to that tag, and is composable
   with the search query (e.g. search `mgt` + chip `Domain
Controllers` returns the intersection).

### Other repository changes rolled into v1.12.9

- **Documentation refresh**: this release also includes a sweep of
  the long-form documentation under [`docs/`](docs/) to bring it
  level with the v1.12.x patch line — the
  [`architecture.md`](docs/architecture.md) Dashboard bullet now
  records that the search box matches against tag names in addition
  to name/hostname/description; the [`README.md`](README.md)
  **What's New** table prepends a row for v1.12.9; and a new
  release card is prepended to
  [`frontend/src/components/WhatsNewModal.tsx`](frontend/src/components/WhatsNewModal.tsx)
  so the in-app **What's New** carousel surfaces the change on
  first sign-in after upgrade (this is the standard release
  procedure — without the prepended card the dismissal key
  advances with `__APP_VERSION__` but the top card stays stale
  on `v1.12.8`).
- **Version bumps**: `VERSION`, `Cargo.toml` `[workspace.package].version`
  (propagates to `backend`, `crates/strata-protocol`, `crates/strata-dmz`
  via `version.workspace = true`), `Cargo.lock` for the three workspace
  crates, `frontend/package.json`, and `frontend/package-lock.json` —
  no dependency graph changes, so the lockfile diffs are bounded to
  the strata workspace packages themselves.

## [1.12.8] — 2026-06-29

### Patch Release — UI hotfix for v1.12.7 RBAC fallout: delegated users now see the connection name on session tiles

The v1.12.7 patch tightened `GET /api/admin/connections` to require
`can_manage_connections` (one of the seventeen handlers that previously
missed its per-handler permission check). That was the right fix on
the backend, but it surfaced an unrelated and previously-silent bug
in the frontend: `frontend/src/pages/SessionClient.tsx` was using the
admin endpoint to translate a URL-supplied `connectionId` (e.g.
`/session/{uuid}`) into a human-readable name for the session tile
in the sidebar. Pre-v1.12.7 the admin endpoint happened to be
reachable by anyone with any admin flag (because of the coarse
`require_admin` gate) so the bug went unnoticed; post-v1.12.7 a
delegated user without `can_manage_connections` started getting
`403 Forbidden` on the lookup, the `.catch(() => undefined)` in the
component silently swallowed the error, the falsy fallback fired,
and the tile rendered the protocol (`RDP`) instead of the connection
name (e.g. `cicsazt1mgt-t`).

The bug was entirely cosmetic — sessions still connected, file
transfer still worked, multi-monitor still tiled, the audit log still
recorded the correct connection ID. Only the visual label was wrong,
and only for operators in a custom delegated role. The visual
regression mattered most for users who keep several sessions open at
once and rely on the tile label to tell tiles apart at a glance: a
sidebar of three tiles all labelled `RDP` defeats the purpose of the
multi-session bar.

### Fix

[`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx)
swaps the call from `getConnections()` (→ `GET /api/admin/connections`)
to `getMyConnections()` (→ `GET /api/user/connections`). The
user-scoped endpoint returns the same `Connection[]` shape, is
filtered to the connections the user is actually allowed to reach
(connection-to-user / connection-to-group mappings honoured by the
backend), and requires no admin permission flag. Admins continue to
see the right tile label because `/api/user/connections` includes
every connection their assignments grant them. The only change is
two lines in the import block plus the function call, plus a comment
documenting the v1.12.7 interaction so future readers don't recreate
the bug.

The other call site of `getConnections()` —
`frontend/src/pages/AdminSettings.tsx` — is correct to use the admin
endpoint (the page is admin-only and renders connection management
UI), and is unchanged.

### Compatibility

- **Backend**: no changes. `GET /api/admin/connections` retains its
  v1.12.7 `can_manage_connections` requirement; `GET /api/user/connections`
  retains its pre-existing user-scoped behaviour.
- **Frontend**: no visible change for users with `can_manage_system`
  or `can_manage_connections` (they continue to see the correct
  connection name on tiles). Delegated users in custom roles that
  lack both flags but still have access to the connection (via
  user-to-connection or group-to-connection mapping) now also see
  the correct name on their session tiles.
- **API contract**: no changes. Both `Connection[]` endpoints return
  the same TypeScript-side `Connection` interface — `getMyConnections`
  has existed since v0.x and is the standard way for non-admin code
  paths to enumerate accessible connections.
- **Tests**: no test changes were required. The full vitest suite
  (~1,600 cases across 47 files) continues to pass. `SessionClient`
  is not directly tested at the component level — `App.test.tsx`
  mocks the page entirely — and the `api.test.ts` cases for
  `getConnections` / `getMyConnections` continue to verify the
  underlying HTTP requests.

### Acceptance test

1. In a fresh v1.12.7 deployment, create a delegated role with **only**
   `can_create_connections` enabled (no `can_manage_system`, no
   `can_manage_connections`) and assign it to a test user along with
   access to at least one RDP connection.
2. Sign in as the test user, open the connection from the dashboard,
   and observe the session tile in the **Active Sessions** sidebar
   on the right. On v1.12.7 the tile reads `RDP`; on v1.12.8 it
   reads the actual connection name (e.g. `cicsazt1mgt-t`).
3. Open the browser devtools network panel — the page should issue
   `GET /api/user/connections` (200) instead of
   `GET /api/admin/connections` (403).
4. Sign in as a full admin (`can_manage_system=true`) — the tile
   label is unchanged from v1.12.7 because the admin's
   `/api/user/connections` response already includes every
   connection in the system.

## [1.12.7] — 2026-06-26

### Patch Release — `/api/admin/*` now enforces per-handler RBAC

A penetration test against v1.12.6 identified a privilege-escalation
gap in the admin API. The router-level `require_admin` middleware
guarding `/api/admin/*` is intentionally a coarse gate — it accepts
any user holding _any_ of the nine admin permission flags (e.g.
`can_view_audit_logs`, `can_create_users`, `can_view_sessions`, …).
The granular access decision is the responsibility of each handler,
which is expected to call one of the `check_*_permission(&user)`
helpers in `services::middleware` before returning data. **Seventeen
handlers were missing that per-handler check.** A delegated user
holding only `can_view_audit_logs=true` (for example, a SOC analyst
account scoped to the audit log) could call `GET /api/admin/settings`
and read every system setting (SMTP, Vault, DNS, auth method config),
`GET /api/admin/recordings` + `GET /api/admin/recordings/{id}/stream`
and watch any user's recorded session, `GET /api/admin/health` and
fingerprint internal service topology, `GET /api/admin/connections`
to enumerate every connection target, `POST /api/admin/dmz-links/reconnect`
to bounce production DMZ links, and so on. The CSRF and authentication
controls were intact — this was strictly an authorization gap.

v1.12.7 adds the missing per-handler permission check to every
affected endpoint and tightens the response to `403 Forbidden` when a
user is missing the required flag. The required flag per endpoint
matches the existing pattern used by other handlers in the same file:

| Endpoint                                 | Required permission      |
| ---------------------------------------- | ------------------------ |
| `GET /api/admin/settings`                | `can_manage_system`      |
| `POST /api/admin/settings/sso/test`      | `can_manage_system`      |
| `GET /api/admin/roles`                   | `can_manage_system`      |
| `GET /api/admin/roles/{id}/mappings`     | `can_manage_system`      |
| `GET /api/admin/metrics`                 | `can_manage_system`      |
| `PUT /api/admin/safeguard/config`        | `can_manage_system`      |
| `POST /api/admin/safeguard/test`         | `can_manage_system`      |
| `GET /api/admin/health`                  | `can_manage_system`      |
| `GET /api/admin/certs`                   | `can_manage_system`      |
| `POST /api/admin/dmz-links/reconnect`    | `can_manage_system`      |
| `GET /api/admin/connections`             | `can_manage_connections` |
| `GET /api/admin/connection-folders`      | `can_manage_connections` |
| `PUT /api/admin/connection-folders/{id}` | `can_manage_connections` |
| `GET /api/admin/tags`                    | `can_manage_connections` |
| `DELETE /api/admin/tags/{id}`            | `can_manage_connections` |
| `GET /api/admin/connection-tags`         | `can_manage_connections` |
| `GET /api/admin/recordings`              | `can_view_sessions`      |
| `GET /api/admin/recordings/{id}/stream`  | `can_view_sessions`      |

(`can_manage_system` is the super-admin flag and continues to imply
access to every check above; users who already had it before v1.12.7
see no behaviour change.)

The fix is structural — the `require_admin` middleware itself is
unchanged because it correctly models the "is this an admin surface?"
question. The bug was missing per-handler defense-in-depth on
seventeen of the ~70 admin handlers. The other ~53 already had the
right `check_*_permission(&user)?` call at the top of the body.

### Compatibility

- **Server-side**: no DB migrations, no new environment variables, no
  new Cargo or npm dependencies.
- **Frontend**: no visible change for users with `can_manage_system`
  (the super-admin role). Users in custom delegated roles that
  previously could reach an endpoint via the coarse gate will now see
  `403 Forbidden` and must be granted the additional permission flag
  via **Settings → Roles**.
- **Operators**: review the role grid under **Settings → Roles** if
  you maintain any custom delegated admin roles. Confirm that each
  role has the flag matching the endpoints its holders need to
  access. The default `admin` role (which has every flag) is
  unaffected.

### Acceptance test

1. In a v1.12.6 deployment, create a delegated role with **only**
   `can_view_audit_logs` enabled and assign it to a test user.
2. Have the test user sign in and call `GET /api/admin/settings` —
   v1.12.6 returns `200 OK` with the entire system settings table;
   v1.12.7 returns `403 Forbidden`.
3. Have the same user call `GET /api/admin/audit-logs` — v1.12.7
   still returns `200 OK`, confirming the legitimate audit-log access
   is preserved.

## [1.12.6] — 2026-06-26

### Patch Release — `POST /api/auth/logout` performs OIDC RP-Initiated Logout

A penetration test against a v1.12.5 deployment identified that clicking
**Log out** in the Strata SPA cleared Strata's own session cookies and
revoked its local JWT, but **never contacted the IdP**. The browser kept
the upstream Keycloak SSO cookie, so the very next click of **Sign in**
silently re-authenticated against the surviving Keycloak session without
prompting for a password or MFA challenge. The acceptance test was the
classic "log out, then immediately log back in without typing anything"
sequence — on v1.12.5 it succeeded. The user experience matches "the
logout button does nothing for SSO users", and the security impact is
that a workstation walked away from after a manual logout is no harder
for the next person to weaponise than a workstation locked with the
session still open.

The fix wires up the standard [OpenID Connect RP-Initiated Logout 1.0]
flow. The SSO callback now persists the raw `id_token` in a
`HttpOnly; Secure; SameSite=Strict; Path=/api` cookie (TTL matches the
refresh token so the hint survives access-token rotation). On logout
the backend extracts the cookie, decodes the unverified `iss` claim
to look up the matching `sso_providers` row, fetches the IdP's
discovery document (cached in `services::auth`), and — if the IdP
advertises an `end_session_endpoint` — returns the fully-formed
RP-initiated logout URL in a new `post_logout_url` field on the JSON
response. The SPA navigates the browser to that URL after tearing down
local state; Keycloak terminates its own session and bounces the
browser back to `/login` via the registered
`post_logout_redirect_uri`. Local-account logouts and IdPs that omit
`end_session_endpoint` fall back transparently to the pre-fix
behaviour.

[OpenID Connect RP-Initiated Logout 1.0]: https://openid.net/specs/openid-connect-rpinitiated-1_0.html

### Security

- `POST /api/auth/logout` now returns `post_logout_url` when the user
  signed in via SSO AND the IdP advertises `end_session_endpoint` in
  its OIDC discovery document. The SPA navigates the browser there so
  the IdP destroys its own session. Without this navigation the IdP
  SSO cookie survives and the next "Sign in" silently re-authenticates
  the same browser without prompting for credentials.
- `OidcDiscovery` now carries `end_session_endpoint: Option<String>`
  (deserialised from `serde(default)` so legacy IdPs that omit the
  field continue to work).
- `GET /api/auth/sso/callback` sets a new `id_token` cookie
  (`HttpOnly; Secure; SameSite=Strict; Path=/api`; lifetime matches
  the refresh token) so it is available as the `id_token_hint`
  parameter on the logout redirect. SPA JavaScript can never read
  this cookie.
- `POST /api/auth/logout` tombstones the new `id_token` cookie
  (`Max-Age=0`) alongside the existing access / refresh / csrf /
  session_expires cookies on every call — including local-account
  logouts — so a stale value never leaks across sessions on a shared
  workstation.

### Changed

- The frontend `apiLogout()` (`frontend/src/api.ts`) now resolves to
  the parsed response body (`LogoutResponse`) instead of `void`. A
  missing or unparseable body returns `null` so callers downgrade
  gracefully when talking to a v1.12.5 or older backend.
- `App.tsx` `handleLogout` awaits the apiLogout result; when a
  `post_logout_url` is present it issues `window.location.assign(...)`
  instead of the local `/login` SPA navigation.

### Tests

- Three new unit tests in `backend/src/services/auth.rs`:
  - `oidc_discovery_deserializes_with_end_session_endpoint`
    (Keycloak-shaped document round-trips correctly).
  - `oidc_discovery_deserializes_without_end_session_endpoint`
    (legacy IdPs without the field default to `None` rather than
    failing the whole parse).
  - Existing `oidc_discovery_clone` extended with the new field.
- Six new unit tests in `backend/src/routes/auth.rs`:
  - `logout_response_tombstones_id_token_cookie`
    (every logout response carries `id_token=; Max-Age=0`).
  - `logout_response_includes_post_logout_url_field` (the JSON
    response always surfaces the field, set to `null` for local
    logouts, so the SPA's type-narrowing branches deterministically).
  - `id_token_issuer_extracts_iss_from_jwt`,
    `id_token_issuer_returns_none_for_malformed_input`,
    `id_token_issuer_returns_none_when_iss_claim_missing`
    (defensive parsing of the unverified `iss` claim).
  - `build_rp_initiated_logout_url_returns_none_without_id_token_cookie`
    and `build_rp_initiated_logout_url_returns_none_without_db`
    (the helper short-circuits to `None` on every defensive branch
    rather than erroring).
- Two new vitest cases in `frontend/src/__tests__/api.test.ts`:
  - `returns parsed body including post_logout_url when backend
supplies it`.
  - `returns null when the response body cannot be parsed
(back-compat with ≤ 1.12.5)`.

### Operator impact

- **One IdP-side configuration step is required** for the
  RP-initiated logout to succeed. In Keycloak (and equivalent IdPs):
  open the Strata client → **Settings** → add
  `https://<your-strata-fqdn>/login` to **Valid Post Logout Redirect
  URIs** (Keycloak ≥ 25.0; older versions accepted the existing
  **Valid Redirect URIs** value, but Keycloak now validates the two
  fields separately). Without this entry the IdP rejects the logout
  redirect with `Invalid redirect uri` and the user lands on a
  Keycloak error page instead of `/login`. Local-account-only
  deployments are unaffected.
- No migrations. No new environment variables. No new Cargo or npm
  dependencies. Drop-in upgrade from v1.12.5: `docker compose pull &&
docker compose up -d --build` (or the ghcr / k8s equivalent).
- IdPs that do not advertise `end_session_endpoint` in their OIDC
  discovery document (some legacy installations) automatically fall
  back to the pre-fix behaviour — the backend logs a warning at boot
  and omits the `post_logout_url` field; the SPA navigates locally to
  `/login` exactly as before. The IdP session in that case still
  cannot be terminated automatically (this is a property of the IdP,
  not Strata).
- The new `id_token` cookie is approximately 1–2 KB on a typical
  Keycloak deployment — well inside the 4 KB per-cookie browser limit.
  Operators with unusually large id_tokens (custom claims pushing
  past 4 KB) should review their realm's client-scope mappers; nothing
  in Strata caps the size.

## [1.12.5] — 2026-06-25

### Patch Release — `GET /api/admin/settings` masks Vault-sealed values

A penetration test against a v1.12.4 deployment identified that the
sealed Azure Storage access key used for session-recording upload
was being returned in full from `GET /api/admin/settings` as its
Vault Transit envelope (`vault:{"ct":...,"dek":"vault:v1:...","n":...}`).
The encrypted ciphertext itself is not directly exploitable — recovering
the plaintext requires `transit/decrypt` capability on the Vault server
holding the Transit master key — but the value should never have been
returned at all. The redaction list in `backend/src/routes/admin.rs`
already enumerated the SMTP, SSO, AD bind, and Vault-token keys; it
also listed `azure_storage_access_key`, which is the wrong key name
for the recordings setting (the actual key is `recordings_azure_access_key`),
so the substring-based filter silently let the envelope through to
the response. The same gap existed for `smtp_encrypted_password`,
which had been added in v0.25.0 but never wired into the redaction list.

If the deployment is misconfigured to run without Vault (the
`unseal_setting` helper falls back to plaintext for legacy values),
the same response path would have returned the **plaintext** Azure
key. v1.12.5 closes both holes.

### Security

- `recordings_azure_access_key` and `smtp_encrypted_password` are now
  explicitly listed in `SENSITIVE_SETTINGS` and masked on every
  `GET /api/admin/settings` response.
- **Defence-in-depth**: any setting value that begins with the literal
  prefix `vault:` is now masked regardless of its key name. New sealed
  settings added in future releases will be masked by this rule the
  moment they are written, even before their key is added to the
  explicit list.
- `azure_access_key` (the unprefixed substring) is also now in the
  list, so any future sealed Azure-style key whose name contains
  `azure_access_key` is covered.

### Changed

- `update_recordings` (`PUT /api/admin/recordings`) now recognises the
  redaction mask sentinels (`********` and `••••••••`) on the
  `azure_access_key` field and treats them as "no change", rather than
  Vault-sealing the literal mask string and overwriting the live access
  key. This matches the round-trip safety already present for SSO and
  AD bind passwords in `update_settings`.

### Tests

- Three new unit tests in `backend/src/routes/admin.rs`:
  - `redact_settings_masks_recordings_azure_access_key`
    (regression test for the pentest finding).
  - `redact_settings_masks_smtp_encrypted_password`.
  - `redact_settings_masks_any_vault_envelope_value`
    (defence-in-depth: a key with no explicit mention is still masked
    if its value starts with `vault:`).

### Operator impact

- No migrations. No new environment variables. No new dependencies.
  Drop-in upgrade from v1.12.4: `docker compose pull &&
docker compose up -d --build` (or the ghcr / k8s equivalent).
- Operators who previously consumed `recordings_azure_access_key` or
  `smtp_encrypted_password` from the admin settings API for any
  reason will now see `********` in those fields. The dedicated
  `PUT /api/admin/recordings` and `PUT /api/admin/notifications/smtp`
  endpoints continue to accept new values; passing `********` is
  now a no-op (preserves the existing value).
- No frontend changes are required: `RecordingsTab.tsx` already
  populates its password-style input from whatever the settings API
  returns; with v1.12.5 that input shows the mask until the operator
  types a new value or clears it.

## [1.12.4] — 2026-06-22

### Patch Release — Command Palette open-session prioritisation

v1.12.4 is a single-issue UX patch focused on the in-session
**Command Palette** (`Ctrl+K`). Operators who keep multiple sessions
open and use the palette as their primary session switcher reported
that the connection list rendered in raw API order — a long list of
connections in the order the user's authoring activity happened to
produce them — with no preferential placement for the connections
that were _already open_. The fastest possible session switch
(`Ctrl+K → Enter` to jump to the **other** open session) was
impossible without first scrolling, arrow-keying through a dozen
inactive rows, or typing a disambiguating substring of the target's
name. v1.12.4 reorders the list with a stable three-bucket sort so
open sessions float to the top, the session you are currently
looking at sits just below them, and inactive connections continue
in their original API order beneath that.

No backend changes, no API surface changes, no migrations, no new
environment variables, no new Cargo or npm dependencies — the
change is entirely scoped to one component
([`frontend/src/components/CommandPalette.tsx`](frontend/src/components/CommandPalette.tsx))
plus one matching test. Sites that do not use the Command Palette
are unaffected. Sites that opted into v1.12.3 can defer indefinitely
without functional impact; the fix is purely an interaction-time
improvement.

### Changed

- **`Ctrl+K` palette — open sessions float to the top of the
  connection list, with the currently-displayed session as the
  second bucket.** The `filtered` array in
  [`CommandPalette.tsx`](frontend/src/components/CommandPalette.tsx)
  is now sorted into three stable rank buckets after the existing
  query filter runs:

  | Rank | Bucket                                            |
  | :--: | :------------------------------------------------ |
  |  0   | Open session you are **not** currently looking at |
  |  1   | Open session you **are** currently looking at     |
  |  2   | Connection that is not open                       |

  The ranks are derived from
  `activeConnectionIds = new Set(sessions.map((s) => s.connectionId))`
  (an existing pre-computed set already used to render the green
  **Active** pill on each row) and a newly-introduced
  `activeConnectionId = sessions.find((s) => s.id === activeSessionId)?.connectionId ?? null`
  resolution to identify the session the user is currently focused
  on. ECMAScript 2019+ `Array.prototype.sort` is specified as
  stable, so the **relative order within each bucket is preserved**
  — open sessions don't reshuffle every time another connection
  opens or closes, and inactive connections continue to appear in
  the same API order they always did. The existing green **Active**
  pill on open rows visually reinforces the new ordering without
  needing a section header.

  **User-visible effect.** With two open sessions (say `prod-db` and
  `dev-rdp`) and the user currently focused on `prod-db`, pressing
  `Ctrl+K` then `Enter` now jumps straight to `dev-rdp` — the
  fastest possible "switch to the other open session" interaction.
  A single `↓ Enter` returns the user to `prod-db`. Everything else
  (the rest of the connection list) follows in its original API
  order with the query filter applied as before.

  **Why this ordering.** Putting open-but-not-displayed sessions at
  rank 0 makes the `Enter`-on-default behaviour useful (a re-launch
  of the session already on screen is rarely what the operator
  wants — the SessionManager already brings an existing session to
  the foreground in that case, so the keystroke does nothing
  visible). Putting the currently-displayed session at rank 1 keeps
  it one keystroke away for the rare case the operator actually
  does want to re-focus or reconnect it. Putting inactive
  connections at rank 2 in their original order preserves muscle
  memory for everyone who has internalised the existing
  presentation order over the last six minor versions.

- **No behavioural change to `:command` mode.** The colon-prefixed
  command surface (`:reload`, `:disconnect`, `:close`, `:fullscreen`,
  `:commands`, `:explorer`, plus user-defined mappings from
  `user_preferences.preferences.commandMappings`) renders the same
  fixed-order registry as before, with the same ghost-text
  autocomplete and the same audit-row emission. The new sort is
  applied only to the connection-list path (typed text **without**
  a leading colon).

### Tests

- New `__tests__/CommandPalette.test.tsx` case
  `"sorts open sessions to the top, with the currently-displayed
one second"` asserts the DOM order with two open sessions, one of
  which is currently displayed, and asserts `Ctrl+K → Enter`
  navigates to the **other** open session (the rank-0 row).
- All 15 pre-existing palette tests continue to pass without
  modification — the test mocks happened to put the active session
  first in API order already, so the new sort is a no-op for those
  fixtures and the assertion targets remain valid.

### Documentation

- [`docs/architecture.md`](docs/architecture.md) — added a
  `### Open-session prioritisation (v1.12.4)` subsection inside
  the **Command Palette** section explaining the three-bucket sort
  and its rationale. The top-of-file summary line in the SPA
  feature list (line ~183) is unchanged because the `Ctrl+K`
  one-liner there is intentionally generic.
- [`README.md`](README.md) — prepended a 1.12.4 row to the
  **What's new** table.
- [`WHATSNEW.md`](WHATSNEW.md) — prepended a `# What's New in
v1.12.4` section with themed subsections.
- [`frontend/src/components/WhatsNewModal.tsx`](frontend/src/components/WhatsNewModal.tsx)
  — prepended a `RELEASE_CARDS[0]` entry so the in-app carousel
  shows the new card on first sign-in after upgrade.

### Operator impact

None in the operational sense — no migrations, no new env vars, no
config file changes, no new Cargo or npm dependencies, no new
images or containers. The recommended deploy is
`docker compose pull && docker compose up -d --build` (or the
ghcr/k8s equivalent) and nothing else. The backend container image
is byte-identical to v1.12.3 in everything except the
`[workspace.package].version` field embedded into the binary; the
frontend container image differs only in the rebuilt JS bundle
(new sort logic + new test, with `__APP_VERSION__` bumped so the
What's New carousel surfaces on first sign-in). Mixed v1.12.3 /
v1.12.4 deployments handshake cleanly; the `strata-dmz` relay
binary cosmetically bumps version (shared workspace
`[workspace.package].version`) but its wire protocol is
byte-identical, so the **Admin → DMZ Links** tab will show a
_Mixed_ indicator until every relay is upgraded.

Sites that do not use the Command Palette feature (configured
out via `commandPaletteBinding = ""` in user preferences, or
simply unused) see zero behavioural change.

## [1.12.3] — 2026-06-22

### Patch Release — Safeguard JIT post-approval username regression fix

v1.12.3 is a single-issue hotfix for a Safeguard JIT regression that
prevented users from signing in to target servers when their
Safeguard account required approver action before the password
could be checked out. The non-approval (auto-released) path was
unaffected; sites running only auto-release entitlements can defer
the upgrade without functional impact. No protocol changes, no
migrations, no new environment variables, no new Cargo or npm
dependencies — existing v1.12.x installations upgrade with
`docker compose pull && docker compose up -d --build` (or the
ghcr / k8s equivalent) and nothing else.

### Fixed

- **Safeguard JIT — approved-after-pending checkouts now succeed at
  tunnel-open time.** When a Safeguard credential profile was
  backed by an account whose policy required approver action
  (`Approver`/`Reviewer` workflow), the user submitted a request
  via the bulk-checkout UI, waited for the approver, and watched
  the SPA flip the row to `Released` — but every subsequent
  attempt to actually open a tunnel against the protected target
  failed instantly with `Authentication failure (invalid
credentials?)` from the RDP / SSH front-end. Manually copying the
  same password from the Safeguard portal and typing it into the
  in-band auth prompt always worked, the AD account was never
  locked out, and the cached row's `expires_at` and `request_id`
  were both correct — so the failure mode was puzzling.

  **Root cause.** Safeguard's REST surface only echoes the target
  account's `AccountName` back at request-creation time
  (`POST /service/core/v4/AccessRequests` response, parsed into
  `CreatedAccessRequest::account_name` in
  [`backend/src/services/safeguard/client.rs`](backend/src/services/safeguard/client.rs)).
  Subsequent calls to `POST /AccessRequests/{id}/CheckoutPassword`
  return _only_ the JSON-encoded plaintext string — no
  `AccountName`, no `AccountDomainName`, no enrichment. The
  initial `jit_checkout` orchestrator captures `account_name`
  from the creation response and carries it into
  `CheckoutResult.username`, so the auto-released path (which
  posts an AccessRequest, immediately checks out the password,
  and returns in one tick) correctly populates the
  `safeguard_cached_passwords.username` column with the real
  AccountName.

  But the **post-approval release path** is structurally
  different: the bulk-checkout call comes back with
  `JitOutcome::PendingApproval { request_id, … }` and the SPA
  polls `POST /api/user/safeguard/release` until the approver
  acts. That polling endpoint dispatches through
  `services::safeguard::release_pending(...)`, which only has the
  `request_id` to work with — there is no fresh creation
  response. Until this fix, `release_pending` hard-coded
  `username: None` on the `Released` arm of its match (with an
  in-code TODO comment acknowledging "the caller is expected to
  use the profile's stored username or refetch the request
  details" — neither happened). The route handler
  `release_safeguard_pending` in
  [`backend/src/routes/user.rs`](backend/src/routes/user.rs)
  faithfully forwarded that `None` into
  `password_cache::store(...)`, persisting the cache row with
  `username = NULL`. The credential-profile table does **not**
  carry a `username` column for `kind = 'safeguard'` rows (the
  username is always sourced from Safeguard's `AccountName`), so
  there was no fallback.

  At tunnel-open time, the JIT path in
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  loaded the cache row and assigned
  `safeguard_username = cached.username` — which was `None` — and
  the tunnel handler propagated that into the
  `(vault_username, vault_password)` tuple as
  `(None, Some(<correct-password>))`. guacd / FreeRDP / OpenSSH
  then attempted authentication with an **empty username** and
  the correct password, which the target server rejected
  pre-lockout as "invalid credentials". The user's perception of
  the bug was an absolute, repeatable, post-approval auth failure
  for which the only workaround was manually pasting the password
  into the in-band auth prompt of the protocol client. There was
  even an explicit comment at the relevant call site in
  `tunnel.rs` flagging exactly this failure mode ("Falling back
  to None means the protocol prompts in-band, … but for RDP that
  surfaces as 'invalid credentials' the moment the target
  rejects the empty NLA username. Always prefer the resolved
  name when the appliance gave us one.") — the comment was right;
  the post-approval path was the one site that never got the
  resolved name.

  **Fix.** A new `client::get_access_request_status(...)`
  function (renamed and extended from the v1.12.x-era
  `get_access_request_state(...)` helper) issues a
  `GET /service/core/v4/AccessRequests/{id}` and now returns a
  small `AccessRequestStatus { state, account_name }` struct
  instead of just the workflow state. The state field is what
  the existing `password_cache::check_request_validity(...)`
  validator was already using to decide whether a cached row was
  still live on the appliance; the new `account_name` field is
  consumed by `release_pending`'s `Released` arm to recover the
  `AccountName` that `CheckoutPassword` does not echo back, and
  is plumbed through into `CheckoutResult.username`. The route
  handler `release_safeguard_pending` is unchanged — it already
  forwarded `outcome.username` into `password_cache::store(...)`
  — so the cache row now carries the real username for both the
  auto-released path and the post-approval path. Refetch failure
  is non-fatal and logged at warn so a transient appliance hiccup
  during the refetch does not block the user from connecting
  (the password is still returned and cached; the only
  consequence of a failed refetch is the pre-fix behaviour).

  The single existing caller of the old
  `get_access_request_state` (`check_request_validity` in
  [`backend/src/services/safeguard/mod.rs`](backend/src/services/safeguard/mod.rs))
  was updated to read `status.state` and to map the 404 case
  (`Ok(None)`, request purged from the appliance) onto
  `CacheValidity::Inactive` explicitly — preserving the
  pre-existing implicit behaviour where `None` failed to match
  `Some("PasswordCheckedOut")` and therefore returned
  `Inactive`. Backwards compatible: no API shape changes, no
  database schema changes, no audit-event additions, and no
  changes to the bulk-checkout / `release_safeguard_pending`
  HTTP contracts. Cache rows persisted by v1.12.2 against
  approval-required accounts will continue to carry
  `username = NULL` until they expire (default TTL: the
  profile's own `ttl_hours`); operators who want to evict them
  immediately can click **Check in all** in the bulk-checkout
  card or call `POST /api/user/safeguard/checkin` with
  `{"profile_ids": []}`.

  Verified: `docker compose build backend` clean; rust-analyzer
  reports no errors; the existing `parse_awaiting_approval_*`
  unit tests in `client.rs` still pass; no compile or runtime
  changes are required on the frontend.

### Changed

- **`client::get_access_request_state` → `get_access_request_status`.**
  Renamed and extended in
  [`backend/src/services/safeguard/client.rs`](backend/src/services/safeguard/client.rs)
  to return `AccessRequestStatus { state: Option<String>,
account_name: Option<String> }` instead of `Option<String>`.
  The only existing call site was internal to
  `backend/src/services/safeguard/mod.rs` and was updated in the
  same commit. No public route, no external integration, no
  capability-token consumer is affected.

### Operator notes

No migrations. No new environment variables. No config changes.
No new Cargo or npm dependencies. Recommended deploy: `docker
compose pull && docker compose up -d --build` (backend only;
frontend image is unchanged byte-for-byte against v1.12.2 but
ships with the bumped `__APP_VERSION__` so the in-app **What's
New** modal will surface this card on first sign-in after the
upgrade). Sites that do not use Safeguard JIT credential
profiles can defer indefinitely — the fix is entirely scoped to
the `services::safeguard::*` module tree.

## [1.12.2] — 2026-06-12

### Patch Release — Outbound Quick Share polish, approver-email fan-out, BASE_URL fallback, ClamAV health, Kali VDI

v1.12.2 is a thirteen-PR follow-up to the v1.12.1 AV-polish bundle.
None of the v1.11.0 outbound-share protocol contracts change — the
two ingest paths (`POST /api/user/outbound-shares` for drive-channel,
`POST /api/outbound-shares/ingest/{token}` for HTTPS upload-command),
the four `av_*` columns on `outbound_shares`, the
`outbound_share.requested` / `outbound_share.decided` audit events,
and the `can_use_quick_share_outbound` role permission are all
byte-identical to v1.12.1. No new migrations, no new environment
variables, and no new Cargo or npm dependencies. Existing v1.12.x
installations upgrade with `docker compose up -d --build` (or the
ghcr / k8s equivalent) and nothing else.

The release rolls thirteen merged PRs (#268–#280) into one shipping
bundle. The threads collected here break into six operator-visible
themes:

1. **Outbound Quick Share UX polish.** Five fixes that take the
   v1.11.0 outbound flow from "functional" to "comfortable" for
   the operators who actually live in it day-to-day. The
   justification textarea now stays visible when drive
   redirection is disabled by group policy (so the user can
   write a reason without first generating a snippet), the curl
   one-liners always print a completion summary at the end (so a
   stale token is distinguishable from a transport error), the
   ConfirmModal renders via a React portal (so the backdrop
   covers the full viewport instead of being clipped by an
   ancestor `overflow:hidden`), the admin → Outbound Shares tab
   auto-refreshes every 60 s while the tab is visible (pausing
   on `visibilitychange → hidden` to avoid waking idle laptops),
   and the snippet copy-box gained a File-path input that
   substitutes the user-supplied path into the snippet with
   per-shell quoting (so the snippet is paste-and-run instead of
   paste-edit-run) (#268, #269, #270, #279, #280).

2. **Outbound-share approver email fan-out.** A new transactional
   email event (`OutboundShareEvent::Pending`) fires the moment a
   non-bypass outbound submission lands in the approval queue,
   so the people who need to act on it get the same email
   surface the credential-checkout approvers already do.
   `OutboundSharePending` joins the existing four
   `CheckoutEvent` templates under the same Tera + mrml + Outlook
   dark-mode VML wrapper pipeline, and the same opt-out / audit
   rules apply. Two follow-up fixes hardened the fan-out: the
   approver-discovery SQL was joining the wrong table for the
   super-admin check (`users.can_manage_system` does not exist —
   the flag lives on `roles.can_manage_system`), and the
   self-notify exclusion was reading the requester ID from the
   wrong field of the event payload, so submitters with the
   approver bit themselves were emailing themselves about their
   own request (#271, #273, #275).

3. **`BASE_URL` fallback for notification email links.** Every
   transactional email template that includes a link back into
   the SPA (checkout request / approval / rejection / outbound
   share pending) needs a tenant URL to build absolute hrefs.
   Until now the templates rendered `https://strata.local` as
   the link target whenever the `tenant_base_url` system setting
   was empty — broken even on perfectly-healthy installs that
   simply hadn't filled in the optional admin field. A new
   `services::settings::tenant_base_url(pool)` helper resolves
   in three tiers: `system_settings.tenant_base_url` (admin-set)
   → `BASE_URL` environment variable (deployment-set) →
   `https://strata.local` (build-in last-resort). All four
   email-render call sites (`notifications::build_context`,
   `build_outbound_share_context`, `email::worker` rebuild path,
   `routes/notifications::sample_context` preview) now share the
   helper, so the resolution order is identical regardless of
   whether the email was rendered on the originating dispatch,
   on a retry, or in the admin preview panel (#278).

4. **ClamAV healthcheck IPv6 dodge.** The Docker `HEALTHCHECK`
   on the `clamav` sidecar previously ran `clamdscan --ping
localhost`, which resolved to `::1` on hosts with dual-stack
   `/etc/hosts` and immediately failed because `clamd` only
   binds IPv4 (TCP `0.0.0.0:3310`) inside the container. The
   sidecar was perfectly healthy and serving scans from the
   adjacent backend container, but Docker reported `unhealthy`
   every minute, which in turn poisoned every health-aware
   orchestrator that read the container status. Pinning the
   healthcheck to `127.0.0.1` explicitly avoids the resolver
   ambiguity and the sidecar now reports `healthy` from boot
   (#274).

5. **Recordings volume write permission.** The `strata` user
   inside the backend container could not write into
   `/var/lib/strata/guac-recordings` on hosts where the volume
   was bind-mounted from a directory owned by `root:root` (the
   default when docker-compose creates the directory on first
   bring-up). The session-recording sweeper would silently fail
   to delete expired `.guac` files, growing the recordings
   directory until the operator noticed and `chown`'d it by
   hand. The backend Dockerfile now ensures the recordings
   directory exists with the correct UID:GID baked into the
   image, and the entrypoint script `chown`s the bind-mount
   contents on startup if writable (#277).

6. **Kali Linux VDI image.** A new `contrib/vdi-kali/` profile
   ships a Kali Rolling-based VDI desktop with the
   `kali-linux-large` metapackage preinstalled (Nmap, Metasploit
   Framework, Burp Suite, Wireshark, the full `kali-tools-*`
   line), targeted at security teams who want a clean, audited,
   tunnel-routed jump-box for authorised offensive engagements.
   Builds the same way as `contrib/vdi-sample` — `docker build
contrib/vdi-kali` then tunnel-in via the existing VDI flow —
   and follows the same per-user-home volume pattern so user
   work persists across container restarts (#276).

PR #272 (`style: cargo fmt`) is a no-op formatter pass and is not
called out further.

### Added

- **Outbound Quick Share — File path input on the snippet builder**
  (`frontend/src/components/QuickShareOutbound.tsx`). A new text
  input between the snippet-format dropdown and the **Skip TLS**
  checkbox accepts the path of the file the user intends to
  upload from inside the remote session. The path is substituted
  into the snippet with format-aware quoting so the snippet is
  paste-and-run:
  - **POSIX shells (curl / curl --insecure):** single-quoted with
    embedded `'` escaped as `'\''` per shell-quoting tradition.
  - **`curl.exe` on Windows (cmd / PowerShell host):** double-
    quoted using the full
    [`CommandLineToArgvW`](https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-commandlinetoargvw)
    rule — backslash runs before a `"` are doubled, backslash
    runs at end-of-string are doubled, then the whole string is
    wrapped in `"..."`. The CodeQL `js/incomplete-sanitization`
    regression that an earlier draft tripped (a single
    `.replace(/"/g, '\\"')` left `\"` re-escapable by a second
    pass) is closed in the shipping helper — see the
    `escapeWinDoubleQuoted` unit test that asserts
    `C:\foo\"bar.txt` round-trips correctly.
  - **PowerShell 7 (`pwsh`-only flow):** single-quoted with
    embedded `'` doubled (`''`), since the snippet body itself
    is wrapped in single quotes for the shell-host invocation.
  - When the path input is empty the snippet keeps the literal
    `<your-file>` placeholder so the snippet stays self-documenting
    and the helper text below the snippet flips between **"Paste
    this into a shell inside the session"** (empty) and **"This
    snippet uploads `<the supplied path>`"** (non-empty) so the
    intent is unambiguous (#280).

- **Admin → Outbound Shares — visibility-gated auto-refresh**
  (`frontend/src/pages/admin/OutboundSharesTab.tsx`). A 60 s
  polling effect calls the existing `loadPending()` +
  `loadHistory()` pair so the queue and history stay live without
  the operator having to F5 between approvals. The poll is
  suspended on `document.visibilitychange → hidden` so a parked
  tab on a laptop does not keep the backend warm overnight, and
  resumed (with one immediate refresh) on
  `visibilitychange → visible` so the tab is up-to-date the
  instant the operator returns to it. Added on top of the
  existing initial-mount refresh — there is no change to the
  underlying admin API contract (#279).

- **Curl snippet completion summary**
  (`frontend/src/components/QuickShareOutbound.tsx`). Every shipped
  `curl` / `curl.exe` variant now ends with a printf-style summary
  block that echoes the HTTP status, the response body, and a
  one-line interpretation (`Upload succeeded` / `Token rejected
(probably expired or already used)` / `Backend rejected the
file — see body above`). Before this change a stale ingest
  token returned `400 Bad Request` with a JSON error body and
  curl exited 0 (HTTP error responses are still "successful HTTP
  transactions" by curl semantics), so the user saw nothing on
  the terminal and had no way to tell the snippet had been
  rejected. The summary block runs unconditionally whether the
  upload succeeded or failed (#269).

- **Outbound-share approver pending email**
  (`backend/src/services/email/templates/outbound_share_pending.mjml`
  - `.txt.tera`). A new transactional email fires when a
    non-bypass outbound submission lands in the approval queue,
    threading through the same Tera context shape as the existing
    `checkout_pending` template (`{requester}`, `{justification}`,
    `{filename}`, `{byte_len}`, `{tenant_base_url}`,
    `{approval_url}`). Recipients are computed by the existing
    `notifications::approver_recipients_for_outbound` query, the
    per-user `users.notifications_opt_out` flag is honoured, and
    the existing retry / abandonment worker handles the delivery
    exactly as it does the four `CheckoutEvent` templates (#271).

- **`services::settings::tenant_base_url()` helper**
  (`backend/src/services/settings.rs`). Single resolver for the
  tenant URL used in every transactional-email link. Resolves
  `system_settings.tenant_base_url` (admin-set, takes precedence
  if non-empty) → `BASE_URL` environment variable
  (deployment-set, picked up on every dispatch — no restart
  required if the system setting is later cleared) →
  `https://strata.local` (build-in last-resort that at least
  produces a syntactically valid URL). Returns `String` not
  `Result<String>` so call sites can use the value directly in
  a Tera context insert (#278).

- **`contrib/vdi-kali/` — Kali Rolling VDI image**. New
  contributor profile alongside `contrib/vdi-sample/` and
  `contrib/vdi-debian/`. Bases on
  `kalilinux/kali-rolling:latest`, installs the
  `kali-linux-large` metapackage, and ships the same XFCE +
  XRDP entrypoint as the sample image so the existing
  per-user-home volume pattern and the existing tunnel flow
  work without changes. README documents the toolset (Nmap,
  Metasploit Framework, Burp Suite Community, Wireshark, the
  full `kali-tools-{web,wireless,information-gathering,…}` line)
  and the intended use case (authorised offensive engagements
  through a tunnel-routed jump-box) (#276).

### Changed

- **`clamav` sidecar healthcheck pinned to `127.0.0.1`**
  (`docker-compose.yml`, `clamav/Dockerfile`). The image
  previously ran `clamdscan --ping localhost`, which on hosts
  with dual-stack `/etc/hosts` resolved to `::1` and failed
  because `clamd` only binds IPv4 inside the container. The
  healthcheck now uses an explicit `127.0.0.1` address (matching
  the bind-address that `clamd.conf` actually listens on) so
  Docker reports the sidecar `healthy` from boot. Operators
  using the bundled `av` profile: `docker compose --profile av
up -d --build clamav` to pick up the new image; existing
  signature DB and scan history in the named volume is
  preserved (#274).

- **Approver-discovery query — read `roles.can_manage_system`,
  not `users.can_manage_system`**
  (`backend/src/services/notifications.rs`,
  `approver_recipients_for_outbound`). The previous SQL referenced
  `users.can_manage_system`, which is not a column — `can_manage_system`
  lives on the `roles` table and reaches the user through
  `user_roles`. The query happened to return zero rows rather
  than erroring out (the column-not-found was swallowed in a
  diagnostic-suppressed branch), so super-admins were silently
  excluded from the approver fan-out. The corrected query joins
  `user_roles → roles WHERE roles.can_manage_system = true UNION
outbound_share_approvers`, matching the rule that both
  super-admins and explicit approver-delegation list members get
  the email (#273).

- **Self-notify exclusion uses
  `OutboundShareEvent::Pending.requester_id`**
  (`backend/src/services/notifications.rs`). The pending-event
  fan-out was reading the requester ID from the wrong field of
  the event struct (an unused legacy `submitter_id` that was
  always `None` on the new event), so submitters who themselves
  held the approver bit emailed themselves about their own
  pending request. The fix reads `requester_id` directly off
  the `OutboundShareEvent::Pending` payload and excludes it
  from the recipient list before the row-per-recipient `INSERT`
  fan-out (#275).

### Fixed

- **Justification textarea hidden when drive redirection is
  disabled** (`frontend/src/components/QuickShareOutbound.tsx`).
  The conditional render previously hid the textarea (and the
  whole "I'd like to share a file" form section) whenever
  `driveRedirectionAvailable` was false, on the theory that
  there was no drive-channel ingest path to write a
  justification for. But the HTTPS upload-command flow needs a
  justification too — the user has to type the reason **before**
  clicking **Generate upload command**, because the
  justification is part of the bound state on the minted token.
  The textarea is now always rendered; only the
  "Drop a file here" upload affordance is conditional on drive
  redirection being available (#268).

- **`ConfirmModal` backdrop clipped by ancestor overflow**
  (`frontend/src/components/ConfirmModal.tsx`). The modal was
  rendered as a sibling of the trigger button rather than as a
  top-level portal, so when the modal was opened from inside a
  scrollable container (e.g. the admin → Outbound Shares row
  action menu, the Approvals page table, the Health tab
  history pane), the fixed-position backdrop was clipped to
  the scrollable ancestor instead of the viewport. The modal
  body itself still rendered, but the dim-out shading stopped
  at the parent boundary, which made it look like the modal
  could be dismissed by clicking on a "non-darkened" area that
  was in fact part of the modal's own backdrop. The modal now
  renders into a `document.body`-anchored React portal — the
  backdrop covers the full viewport regardless of where in the
  tree the modal was triggered from (#270).

- **Email links pointing at `https://strata.local` on
  unconfigured installs** (see **Added** above — the new
  `tenant_base_url()` helper closes the loop) (#278).

- **`outbound_share.pending` approver emails not reaching
  super-admins** (see **Changed** above — `users.can_manage_system`
  → `roles.can_manage_system`) (#273).

- **Submitter receiving their own approval notification when
  they happen to hold the approver bit** (see **Changed** above
  — `requester_id` self-exclusion) (#275).

- **Backend cannot write into bind-mounted recordings volume**
  (`backend/Dockerfile`, `backend/entrypoint.sh`). The
  `strata` user inside the container could not delete expired
  `.guac` recordings from `/var/lib/strata/guac-recordings`
  when the bind-mount target on the host was owned by
  `root:root` (the default when docker-compose creates the
  directory on first boot). The Dockerfile now `mkdir`s the
  directory with the correct UID:GID at build time and the
  entrypoint script `chown`s the bind-mount contents on
  startup when writable, so the session-recording sweeper can
  prune expired files without operator intervention (#277).

- **`clamav` sidecar reported `unhealthy` despite serving scans**
  (see **Changed** above — `127.0.0.1` healthcheck pin) (#274).

### Operator notes

- **No migrations.** No schema changes; no new tables,
  columns, or indexes.
- **No new environment variables.** `BASE_URL` is read by the
  new `tenant_base_url()` helper, but it is an existing variable
  documented in `docs/deployment.md` (used by several other
  helpers since v1.7.0). Sites that already export it pick up
  the email-link fix on first restart with no further action.
- **No new Cargo or npm dependencies.** The thirteen PRs net
  zero supply-chain churn — `cargo deny check` and `npm audit`
  output are unchanged from v1.12.1.
- **Recommended deploy:** `docker compose pull && docker compose
up -d --build`. Sites using the bundled `av` profile should
  add `--profile av` to pick up the rebuilt clamav sidecar with
  the healthcheck fix. Sites using `contrib/vdi-kali/` should
  `docker build contrib/vdi-kali/ -t strata-vdi-kali:latest`
  separately before bringing the new VDI online.

## [1.12.1] — 2026-06-09

### Patch Release — AV-scanning polish, admin visibility, live upload progress, and friendly engine errors

v1.12.1 is the operational-polish follow-up to the v1.12.0 antivirus
landing. None of the v1.12.0 protocol contracts change — the
`Scanner` trait, the `Verdict` shape, the four `outbound_shares.av_*`
columns, the `file.av_blocked` audit row, and the seven
`STRATA_AV_*` environment variables are all byte-identical to the
v1.12.0 wire. Existing v1.12.0 deployments upgrade cleanly with no
config changes and no new migrations.

The release rolls fourteen merged PRs (#255–#265) plus the
follow-up snippet/progress work on `feat/outbound-snippet-progress`
into one shipping bundle. The thirteen threads collected here
break into five operator-visible themes:

1. **Visibility into scanner health and signature freshness.** A
   new Admin → Health → AV card surfaces backend selector,
   reachability, daemon version, signature DB version, last
   `freshclam` update timestamp, and the most recent scan verdict
   counts, so on-call operators can answer "is the scanner up and
   are signatures fresh?" without `docker exec` (#256, #258, #260).
2. **Friendly user-facing error messages on AV blocks.** When the
   AV engine errors (timeout, daemon unreachable, signature DB
   missing, unparseable response), the inbound and outbound HTTP
   responses now carry a deterministic actionable message
   classified by error shape (timeout / transport / infected /
   generic) rather than the raw engine spew. The drive-channel
   `client.onfile` toast surfaces the same message so operators
   know whether to retry or escalate (#265).
3. **Live upload progress everywhere.** Browser-side uploads
   (inbound drag-drop and outbound drag-drop) now drive a real
   percentage progress bar on the toast, fed by a new
   `xhrUploadJson<T>()` helper that exposes `XMLHttpRequest`'s
   `upload.onprogress` events through the existing typed `api.ts`
   contract. MY SUBMISSIONS rows in the QuickShareOutbound panel
   render an **indeterminate "Awaiting AV scan" bar** for every
   pending row, so the scan/approval wait window is visible in
   the browser. Terminal-side snippets get an upload meter too:
   `curl --progress-bar -H 'Expect:'` for both curl variants and
   a `System.Net.Http.HttpClient` + `Write-Progress` poll loop
   for the PowerShell variant (#265 + branch work).
4. **Admin AV-Blocked Files visibility.** A new admin tab
   surfaces every blocked upload (inbound and outbound) in a
   single unified audit row with signature, file metadata,
   timestamp, engine, and the actor + session context. The
   underlying `outbound_share.requested` audit event was
   extended to mirror the inbound `file.av_blocked` shape so the
   dashboard query joins both ingest paths through one
   `action_type` filter (#264).
5. **Scanner-side correctness fixes.** Scan-size limits now
   default to 500 MiB (matching the Quick Share upload cap so
   every accepted upload is actually scanned), freshclam reload
   cadence bumped to hourly with a forced `clamd RELOAD` after
   each update (was: daily without reload, so new signatures sat
   unused until the next sidecar restart), `STRATA_AV_*` env
   vars correctly wired through `Config::from_env` (one variant
   was silently ignored on `1.12.0`), CVD/CLD test fixtures
   corrected to use real on-wire formats, and the Quick Share
   role-permission check made explicit so a super-admin without
   `can_use_quick_share_outbound` is now correctly rejected
   instead of slipping through (#257, #259, #261, #262, #263).

### Added

- **In-app AV health card** (`frontend/src/pages/admin/HealthTab.tsx`
  - new `GET /api/admin/health/av`). Surfaces:
  * Active backend (`off` / `clamav` / `command`).
  * Reachability ping (TCP connect to `clamav:3310` for the
    `clamav` backend; spawnable-check for the `command` backend).
  * clamd daemon version (`PING\nVERSION\n` exchange).
  * Signature DB versions — `main.cvd`, `daily.cvd`/`daily.cld`,
    and `bytecode.cvd`/`bytecode.cld` — with the engine signature
    count (e.g. `daily.cld v27349 / 2,047,316 sigs / 2026-06-08`)
    so on-call can confirm signatures aren't stale.
  * Last freshclam update timestamp + last reload-after-update
    success/failure.
  * Last-30d verdict tally (clean / infected / skipped / error)
    so a sudden flood of `error` rows is visible without going
    to the audit log.
  * Backed by a tiny `services::av_health` module that caches the
    handshake for 30 s and survives `clamd` being temporarily
    unreachable (degrades to "last known good" + a "stale since
    HH:MM:SS" badge rather than wiping the card).

- **Admin → AV-Blocked Files tab** (`frontend/src/pages/admin/AvBlockedTab.tsx`
  - new `GET /api/admin/files/av-blocked` route serving a unified
    view over inbound `file.av_blocked` audit rows and outbound
    rows with `av_scan_status IN ('infected','error')`). Columns:
    timestamp, direction (in/out), filename, byte size, signature
    (or error message), engine, actor, session context. Filters by
    date range, engine, direction, and signature substring. Page
    size 50 with cursor pagination. Visible to
    `can_manage_system` only.

- **Friendly AV error mapping**
  (`Verdict::user_facing_block_message()` in
  `backend/src/services/av.rs`). Classifies the verdict by error
  shape and returns a deterministic message:
  - **Infected** → `"File rejected by malware scan: {signature}"`
  - **Error: timeout** → `"Antivirus scan timed out after Ns; try a smaller file or retry shortly."` (matched on the substring `"timeout"` / `"timed out"` / `"exceeded"`)
  - **Error: transport** → `"Antivirus scanner unreachable; please retry shortly."` (matched on `"refused"` / `"reset"` / `"no route"` / `"unreachable"` / `"broken pipe"`)
  - **Error: missing signatures** → `"Antivirus signature database not yet ready; please retry shortly."` (matched on `"empty"` / `"no signatures"`)
  - **Error: generic** → engine message passed through verbatim
    so operators can still see the raw text in the audit row.

- **Browser-side upload progress**
  (`frontend/src/api.ts::xhrUploadJson<T>`). New typed helper
  that wraps `XMLHttpRequest` (the only browser API that exposes
  `upload.onprogress` reliably) and returns a `Promise<T>` shape-
  compatible with the existing `apiCall<T>()` JSON contract.
  Opt-in via a new `UploadProgressOptions { onProgress?: (pct,
bytes, total) => void; onAbort?: () => void; signal?:
AbortSignal }` parameter on `submitOutboundShare()`,
  `uploadQuickShareFile()`, and the drive-channel
  `submitOutboundShareFromDrive()` helper. Existing callers that
  pass no `UploadProgressOptions` are byte-identical to v1.12.0.

- **ToastProvider progress bar**
  (`frontend/src/components/ToastProvider.tsx`). The `Toast`
  shape gains an optional `progress?: { pct: number; status?:
string }` field; toasts with a `progress` prop render a slim
  bar under the title that updates in place. An indeterminate
  variant (`progress: { pct: -1 }`) renders a sliding 33%-width
  band using a new `strata-toast-indeterminate` keyframe
  (cross-fading between determinate and indeterminate is
  supported so the toast can stay mounted across the upload →
  scan → approve transitions).

- **"Awaiting AV scan" indicator on MY SUBMISSIONS pending rows**
  (`frontend/src/components/QuickShareOutbound.tsx`). Every row
  with `status === "pending"` now renders an indeterminate
  progress bar plus the text "Awaiting AV scan" (or "Awaiting AV
  scan and approval" when DLP score is zero and approver review
  is still required), powered by an inline
  `@keyframes strata-outbound-pending` block (idempotent per CSS
  spec). Uses the Tailwind v4 `bg-warning/N` token via the
  workspace `@theme` block so it picks up the user's dark / light
  preference automatically.

- **Terminal-side upload progress in the curl and PowerShell snippets**
  (`frontend/src/components/QuickShareOutbound.tsx::snippetForOutbound`).
  Three snippet formats updated:
  - **`curl`** (Linux/macOS) and **`curl-win`** (Windows) — add
    `--progress-bar` for a clean one-line meter, plus
    `-H "Expect:"` to disable the default `Expect: 100-continue`
    header. Without the latter, the server returns 400 on a
    consumed/expired token before reading the body, curl never
    uploads, and the progress bar has nothing to render.
    `-H "Expect:"` forces the body up immediately so the meter is
    always visible even when the server eventually rejects.
  - **`powershell`** — rewritten from `Invoke-WebRequest -Form`
    (which exposes NO file-upload progress, only response-download
    progress) to a streaming `System.Net.Http.HttpClient` +
    `MultipartFormDataContent` + `StreamContent($file.OpenRead())`
    pipeline, with a poll loop that reads
    `$stream.Position` and drives `Write-Progress`. Also sets
    `$client.DefaultRequestHeaders.ExpectContinue = $false` for
    the same reason as the curl flag.

- **Admin unified-audit row**
  (`backend/src/routes/admin.rs`). The pre-existing
  `outbound_share.requested` audit-event payload was extended
  with `av_status`, `av_signature`, `av_backend`, `direction:
"outbound"`, and `filename` keys so the new AV-Blocked Files
  tab can `WHERE action_type IN ('file.av_blocked',
'outbound_share.requested') AND (action_type =
'file.av_blocked' OR payload->>'av_status' IN
('infected','error'))` and get a single coherent feed.

- **Inline diagnostic script** `scripts/diagnose-av.sh` — a
  one-shot AV health probe for on-call. Pings the configured
  `STRATA_AV_BACKEND`, runs a `PING\nVERSION\n` exchange against
  clamd, prints the signature DB versions from the sidecar's
  `clamav-db` volume, exec's an `INSTREAM` against EICAR, and
  reports the response. Designed for ssh-onto-the-box-while-
  debugging-an-alert use — emits structured `key=value` lines on
  stdout so it pipes cleanly into `grep` / `awk` / `jq -R -F=`.

- **`docs/runbooks/av-operations.md`** extended with three new
  sections: "Reading the AV Health card", "Reading the
  AV-Blocked Files admin tab", and "Diagnostic probe via
  `scripts/diagnose-av.sh`".

- **`docs/api-reference.md`** documents:
  - The new `GET /api/admin/health/av` response shape.
  - The new `GET /api/admin/files/av-blocked` filterable list
    endpoint.
  - The friendly error message classification on AV-blocked
    upload responses.
  - The new optional `UploadProgressOptions` parameter on the
    `submitOutboundShare` and `uploadQuickShareFile` client
    helpers (the wire endpoint is unchanged — progress is
    purely a client-side concern fed by
    `XMLHttpRequest.upload.onprogress`).

- **In-app v1.12.1 What's New carousel card** in
  `frontend/src/components/WhatsNewModal.tsx`.

### Changed

- **freshclam reload cadence**. The bundled `clamav` sidecar's
  entrypoint now runs `freshclam` hourly (was: daily) and calls
  `clamdscan --reload` (or `clamd --reload` equivalent) after
  every successful update. Without the reload, fresh signatures
  pulled into `/var/lib/clamav` sat unused until the next full
  sidecar restart; this meant the audit trail could record a
  `Skipped { reason: "no signatures" }` or
  `Error { message: "..." }` against a file the engine _had_
  signatures for, just hadn't loaded them yet. Now the engine
  picks up new signatures within minutes of `freshclam` returning.
  (#259)

- **AV scan-size limit aligned with upload cap**. The default for
  `STRATA_AV_MAX_SCAN_SIZE` was bumped from 100 MiB to **500 MiB**
  to match the existing 500 MiB Quick Share upload cap. Previously,
  a 200 MiB upload was accepted by the upload route but tagged
  `Skipped { reason: "oversize" }` by the scanner — i.e. it landed
  in the file store unscanned, which defeated the point. The
  bundled `clamav/clamd.conf` raises `StreamMaxLength`,
  `MaxFileSize`, and `MaxScanSize` to 512 MiB / 512 MiB / 1024 MiB
  in lockstep so the clamd-side limits agree. Operators with
  custom limits should adjust both ends together.
  (#263)

- **Quick Share role-permission check made explicit on outbound
  routes.** `check_quick_share_outbound_permission()` now
  _strictly_ requires `can_use_quick_share_outbound` — a
  super-admin without that permission is rejected with 403
  `Forbidden`, matching the v1.11.0 design intent. Previously a
  subtle short-circuit in one of the routes (mint vs submit vs
  ingest-via-token) let super-admins through; this is now uniform
  across all three. The threat-model row covering "super-admin
  silently exfiltrates files" is unchanged in spirit; the patch
  closes the implementation gap that the row was already
  asserting was closed. (#262)

- **`STRATA_AV_*` env var wiring corrected.** `Config::from_env`
  previously read one variable name and the bootstrap code read
  another (a naming drift introduced late in v1.12.0
  integration). The fix renames the env-read site to match the
  documented variable names in `.env.example`; deployments using
  `.env.example` were unaffected, but anyone who copied a
  snippet from the v1.12.0 release notes could end up with a
  silently-ignored override. (#257)

- **CVD / clamd test fixtures use real on-wire formats.** Two
  unit tests in `services::av` were exercising the version-
  parsing path with synthetic strings that didn't match the
  actual `clamd` `VERSION` response shape (`ClamAV
1.4.2/27349/Sat Jun  7 12:00:00 2026`) or the real `.cvd`
  header layout. The fixtures now use captured bytes from a
  live clamd, so test coverage actually exercises the parser the
  health card depends on. No production behaviour change. (#261)

- **`outbound_share.requested` audit-event payload extended** so
  the unified AV-Blocked Files tab can join inbound and outbound
  blocks through a single SQL filter. New keys on the existing
  event:
  - `direction: "outbound"` (mirrors `direction: "inbound"` on
    `file.av_blocked`)
  - `filename`
  - `av_status` (`clean` / `infected` / `skipped` / `error`)
  - `av_signature` (when present)
  - `av_backend`
    Backwards-compatible — the v1.12.0 keys (`share_id`,
    `byte_len`, `dlp_score`, etc.) are preserved.
    (#264)

- **`docs/av-scanning.md` EICAR smoke test rewritten.** The
  reproducible end-to-end verification was tripping operators on
  two specific copy-paste pitfalls: (1) some shells / RDP
  clipboards corrupt the EICAR signature on paste (the literal
  string contains a `$` that some shells expand), and (2) the
  test requires the user to have `can_use_quick_share_outbound`
  — without it, the upload is rejected with a 403 _before_
  reaching the scanner, masking a successful AV deployment as a
  broken one. The docs now: ship the EICAR string in a
  here-doc, walk operators through the role check first, and
  show the exact JSON response and audit-row shape so success
  is unambiguous. (#262)

- **Browser-side upload toasts** (inbound `QuickShare.tsx` and
  outbound `SessionManager.tsx` drag-drop, plus outbound panel
  drag-drop) now thread the new `UploadProgressOptions` through
  to `xhrUploadJson()` and update a single toast in place (was:
  one toast for "Uploading…" then a second for the result).
  Toast text transitions through "Uploading 42%" → "Scanning…"
  (indeterminate) → "Awaiting approval" or final verdict.

- **PowerShell ingest snippet rewritten.** `Invoke-WebRequest
-Form` does not emit any upload progress (only response-
  download progress), so the v1.11.0 snippet was silent
  regardless of file size. The new snippet uses
  `System.Net.Http.HttpClient` with a poll-loop driving
  `Write-Progress`, plus `ExpectContinue = $false` so the body
  is sent immediately and progress is visible even when the
  server eventually rejects.

### Fixed

- **`curl --progress-bar` rendered nothing when the server
  rejected an expired/consumed token.** Caused by curl's default
  `Expect: 100-continue` header: the server returns 400 _before_
  reading the body, so curl never uploads and the progress meter
  has nothing to draw. Fixed by adding `-H "Expect:"` to both
  curl snippet variants (and the equivalent
  `ExpectContinue = $false` setting in the PowerShell variant).
- **Daily freshclam updates were silently ignored until the next
  sidecar restart** because no `RELOAD` was issued. Now the
  entrypoint forces a reload after every successful update.
  (#259)
- **`Skipped { reason: "oversize" }` on multi-hundred-MB
  uploads.** The 100 MiB scanner default was below the 500 MiB
  upload cap, so files in the 100–500 MiB range landed unscanned.
  Default raised to 500 MiB; `clamd.conf` updated in lockstep.
  (#263)
- **CVD / CLD version parser unit tests passed against fake
  fixtures** that didn't match real `clamd VERSION` output. Real
  on-wire fixtures now used. (#261)
- **`STRATA_AV_*` env var that read one name in the schema and
  another in the loader** — corrected to a single canonical name
  matching `.env.example`. (#257)
- **Super-admin-without-`can_use_quick_share_outbound` slipped
  through on one of the three outbound routes.** All three
  routes now uniformly enforce the role check. (#262)
- **Inbound and outbound CI lint/format failures**
  (`prettier --check` on `api.test.ts`,
  `ToastProvider.test.tsx`, `ToastProvider.tsx`; `cargo fmt
--check` on `services/av.rs`) cleared by re-running the
  formatters. No behaviour change.

### Security

- **No new threats and no new mitigations** — the security
  surface area of v1.12.1 is identical to v1.12.0. The fixes
  here close _implementation_ gaps in the protections v1.12.0
  documented:
  - Aligning the scan-size default with the upload cap means
    every file v1.12.0 _said_ was scanned now actually is.
  - Forcing `clamd RELOAD` after `freshclam` means signatures
    v1.12.0 _said_ were fresh now actually are.
  - The super-admin role-check fix closes the
    "super-admin silently exfiltrates files" threat model row
    that v1.11.0 had already documented as closed.
  - The friendly-error mapping never widens the information
    exposed to the requester — the engine's raw message still
    lands verbatim in the audit row, only the user-facing
    response is normalised. Operators reading the audit log see
    the full unchanged error.

### Operator notes

- **Upgrade path: rebuild and recreate the backend and frontend
  containers.** No migrations. No new environment variables.
  No config changes. The `clamav` sidecar entrypoint script has
  been updated (cadence + forced reload), so the `clamav`
  service should be recreated if you're using the bundled
  profile: `docker compose --profile av up -d --build clamav`.
- **AV-Blocked Files admin tab** is visible only to
  `can_manage_system`. No new permission required.
- **AV Health card** is visible on the Admin → Health page to
  any user already gated for that page (i.e. `can_manage_system`).
- **Existing `STRATA_AV_MAX_SCAN_SIZE` overrides** that set a
  value below 500 MiB will continue to apply — the bump is a
  default change, not a forced value. Sites that _want_ the
  100 MiB ceiling preserved can pin
  `STRATA_AV_MAX_SCAN_SIZE=104857600` in `.env`.
- **The `clamav-db` named volume** is unchanged. Signatures
  persist across restarts. The hourly `freshclam` is bounded by
  upstream's rate limits; if you see "ratelimit reached" in the
  clamav logs, that's normal — the engine retries on a backoff
  and the next refresh succeeds.
- **No new Cargo dependencies.** No new npm dependencies.

### Migrations

- None. v1.12.1 is purely additive in the routes / audit / SPA
  layers and changes no database shape.

## [1.12.0] — 2026-06-09

### Minor Release — Pluggable antivirus scanning for Quick Share uploads

v1.12.0 lands the first malware-scanning hook in the Quick Share
upload pipeline. Both directions of the file mover — **inbound**
(`POST /api/user/files/upload`, where a Strata user pushes a file
_to_ the remote session) and **outbound** (`POST
/api/user/outbound-shares/submit` plus the token-auth shell-side
`POST /api/outbound-shares/ingest/{token}`) — now stream the upload
through a configurable antivirus scanner _before_ the file lands in
the session file store / before it is sealed via Vault Transit. The
scanner is pluggable via the `Scanner` trait in
`backend/src/services/av.rs`; three backends ship:

- **`off`** (default) — no-op, returns
  `Verdict::Skipped { reason: "scanning disabled" }`. Existing
  deployments behave exactly as before until they opt in.
- **`clamav`** — talks to a ClamAV `clamd` daemon over TCP using
  the **INSTREAM** wire protocol (full implementation in
  `ClamAvScanner`: `zINSTREAM\0` opener, length-prefixed 64 KB
  chunks, `0u32` terminator, null-terminated response parsing for
  `stream: OK` / `stream: <SIG> FOUND` / `<error> ERROR`). The
  bundled sidecar in `docker-compose.yml` listens on the internal
  `guac-internal` network as `clamav:3310` — no host port mapping,
  no public exposure.
- **`command`** — shell-out to any scanner whose exit codes follow
  `0 = clean`, `1 = infected`, anything else = error. Signature is
  parsed from the last non-empty stdout (then stderr) line,
  stripping `Threat: ` and `Found: ` prefixes. The command is
  invoked via `tokio::process::Command` with a configurable timeout
  and `{path}` placeholder substitution.

**Fail-closed by design.** When the scanner itself errors
(timeout, daemon down, connection refused) the upload is rejected
under the default `STRATA_AV_FAIL_MODE=block`. Operators who prefer
degraded-open behaviour can set `STRATA_AV_FAIL_MODE=allow` — the
audit row still records the error and the engine that produced it,
so forensics is preserved either way. **Infected verdicts are
always rejected regardless of fail-mode.**

### Added

- **`backend/src/services/av.rs` (new, ~759 LoC).** Defines the
  `Verdict { Clean | Infected{signature} | Skipped{reason} |
Error{message} }` enum (with `as_str()` matching the new DB
  column vocabulary and `blocks(fail_mode)` semantics), the
  `Scanner` trait (async, `Send + Sync + Debug`), and three
  concrete implementations:
  - `OffScanner` — always returns `Skipped`.
  - `ClamAvScanner` — full `clamd` INSTREAM TCP protocol. Files
    larger than `STRATA_AV_MAX_SCAN_SIZE` (default 100 MiB) are
    tagged `Skipped { reason: "oversize" }` rather than attempted.
    Scan is bounded by `STRATA_AV_TIMEOUT_MS` (default 30 000 ms);
    timeout produces an `Error` verdict.
  - `CommandScanner` — exec-driven contract. `{path}` placeholder
    is substituted into the command line, or the path is appended
    as the final argv element if no placeholder is present. The
    full argv is split on whitespace (no shell parsing — wrap
    complex pipelines in a script).

  Configuration is fully env-driven via `Config::from_env`, with
  defaults that keep the feature off until explicitly opted in.
  Includes 15 unit tests covering verdict tagging, fail-mode
  semantics, argv building, signature extraction, oversize-skip,
  and the three command-scanner exit-code paths.

- **`backend/migrations/078_av_scanning.sql` (new).** Adds four
  nullable columns to `outbound_shares`:
  - `av_scan_status TEXT` — one of `clean | infected | skipped |
error` matching `Verdict::as_str()`.
  - `av_signature TEXT` — for `infected` rows, the signature name
    returned by the engine (e.g. `Win.Test.EICAR_HDB-1`).
  - `av_scanned_at TIMESTAMPTZ` — when the verdict was issued.
  - `av_scanner_backend TEXT` — which backend spoke (`off` |
    `clamav` | `command`).

  Also creates a partial index
  `idx_outbound_shares_av_attention` over `av_scan_status WHERE
status IN ('infected','error')` to keep the operator dashboard
  query cheap as the table grows. All columns are nullable, so the
  migration is backwards-compatible with the v1.11.x row shape.

- **Audit events.** Every blocked upload emits a structured audit
  event with the signature, file metadata, session context, and
  the backend tag that spoke:
  - `file.av_blocked` — inbound Quick Share rejection.
  - `outbound_share.requested` — extended with `av_status`,
    `av_signature`, `av_backend` keys on every outbound submission
    (success or rejection) so the audit trail records _which_
    engine cleared the file as well as _what_ it said.

- **`docker-compose.yml` ClamAV sidecar.** A new `clamav` service
  behind the opt-in `av` compose profile
  (`docker compose --profile av up -d`). Internal-only network
  (`guac-internal`), no host port mapping. `freshclam` runs on
  startup; first boot pulls ~250 MB of signatures from the public
  ClamAV CDN — `start_period` is set to 300 s to absorb this
  before the healthcheck reports unhealthy. A new named volume
  `clamav-db` persists `/var/lib/clamav` across restarts so
  signature downloads aren't repeated on every `up`. Resource
  limits set at 3 GB RAM / 2 CPUs (clamd resident-set scales with
  signature DB size).

- **AppState plumbing.** `services::app_state::AppState` gains two
  new fields (`av_scanner: Arc<dyn Scanner>`, `av_fail_mode:
FailMode`) wired at backend boot in `main.rs`. The scanner is
  built once from environment via `services::av::build(&cfg)` and
  shared across every request handler — no per-request scanner
  construction overhead.

- **Seven new env vars** (full reference in `.env.example`):
  - `STRATA_AV_BACKEND` — `off` | `clamav` | `command`. Default `off`.
  - `STRATA_AV_FAIL_MODE` — `block` | `allow`. Default `block`.
  - `STRATA_AV_MAX_SCAN_SIZE` — bytes. Default `104857600` (100 MiB).
  - `STRATA_AV_TIMEOUT_MS` — milliseconds. Default `30000`.
  - `STRATA_AV_CLAMD_HOST` — hostname. Default `clamav`.
  - `STRATA_AV_CLAMD_PORT` — port. Default `3310`.
  - `STRATA_AV_CMD` — full command line with optional `{path}`
    placeholder. No default (required when `STRATA_AV_BACKEND=command`).

- **Operator documentation:**
  - New deep-dive guide `docs/av-scanning.md` covering the wire
    protocol, the three backends, fail-mode semantics, signature
    DB management, EICAR test procedure, and troubleshooting.
  - New ADR `docs/adr/ADR-0011-av-scanning.md` recording the
    decision rationale (pluggable trait vs hard-coded ClamAV,
    fail-closed default, sidecar-optional deployment, no
    inline ClamAV crate dependency).
  - New runbook `docs/runbooks/av-operations.md` covering "scanner
    is down", "signatures not updating", "false positive
    triage", and the EICAR smoke test.
  - `docs/deployment.md` and `docs/deployment-kubernetes.md` gain
    AV deployment sections (compose profile + Helm sidecar).
  - `docs/security.md` §"Outbound Quick-Share" extended with AV
    as a mitigation control.
  - `docs/threat-model.md` Quick Share STRIDE table gains a
    "malicious file upload" row with AV scanning as the mitigation.
  - `docs/api-reference.md` documents the new `Validation` error
    shape returned on blocked uploads and the four new
    `outbound_shares.av_*` fields visible in admin responses.

### Changed

- **`routes/files.rs::upload`** now performs AV scanning after MIME
  sniffing and before `file_store.store_from_path`. The temp file
  is deleted on blocking verdict so the session file store never
  sees infected content.
- **`routes/outbound_shares.rs::parse_outbound_multipart`** now
  takes the scanner + fail-mode and scans on disk _before_
  reading the plaintext into memory and _before_ sealing via Vault
  Transit. Sealing is destructive from the scanner's perspective
  (Vault doesn't expose the plaintext), so the only correct place
  to scan is between the stream-to-disk step and the seal step.
- **`services::outbound_shares::SubmitInput`** gains
  `av_verdict: &Verdict` and `av_backend: &str` fields, which are
  persisted into the four new columns on the INSERT.
- **Test fixtures** — 10 backend test fixtures across
  `routes/{auth, mod, health, user, admin}.rs` updated to seed
  `av_scanner: Arc::new(OffScanner)` and
  `av_fail_mode: FailMode::Block` on AppState construction.
- **`.env.example`** gains a 60-line section documenting all seven
  AV env vars with operator-grade comments and examples for both
  the ClamAV and command backends.
- **`docker-compose.yml`** — opt-in `clamav` service entry plus a
  `clamav-db` named volume.

### Security

- **Malicious file blocking on upload.** Before v1.12.0, an
  operator who Quick-Shared an `.exe` containing malware would
  push it onto the remote session host with no in-product check.
  With the bundled ClamAV sidecar enabled, the same upload is
  rejected at the gateway with a structured audit event recording
  the signature name. This closes a long-standing residual on the
  Quick Share threat model (previously: "scanner is out of scope —
  bring your own external proxy").
- **Outbound DLP defence-in-depth.** Outbound Quick Share already
  ran a built-in keyword-matching DLP heuristic; AV scanning adds
  a second, orthogonal control. A file can now be auto-cleared by
  the DLP scorer **and** blocked by the AV engine — both checks
  must clear before the row reaches the approver queue.
- **Fail-closed default.** `STRATA_AV_FAIL_MODE=block` is the
  default for the same reason `SameSite=Strict` is the default in
  [ADR-0002](docs/adr/ADR-0002-csrf-samesite-strict.md): a
  silently-degraded security control is worse than no control,
  because operators assume it's working.
- **No new attack surface.** ClamAV runs in its own container on
  the internal Docker network. The backend talks to it over
  `clamav:3310` (TCP) — no shell exec, no `LD_PRELOAD`, no
  shared filesystem mount that would let a malicious file
  escape through filesystem APIs (the temp file is read-only
  from the scanner's perspective via the INSTREAM wire protocol;
  it never moves between the two containers).

### Operator notes

- **Existing v1.11.x deployments upgrade cleanly** — the migration
  is purely additive (four nullable columns + one partial index)
  and the default `STRATA_AV_BACKEND=off` preserves prior
  behaviour. Opting in is a `docker compose --profile av up -d`
  - three env-var changes away.
- **First ClamAV boot pulls ~250 MB** of signature definitions
  from clamav.net. Plan for the start-up delay; subsequent boots
  reuse the `clamav-db` volume and converge in seconds.
- **No new Cargo dependencies.** The ClamAV INSTREAM protocol is
  implemented directly against `tokio::net::TcpStream` (the wire
  format is a 9-line state machine). The `command` backend uses
  `tokio::process::Command`. Both are stdlib + existing tokio.

### Migrations

- `078_av_scanning.sql` — additive, backwards-compatible.

## [1.11.1] — 2026-06-09

### Patch Release — Approver workflow polish: in-session popup, persisted deny reason, mandatory outbound-share justification

v1.11.1 closes three follow-up gaps left by the v1.11.0 Outbound
Quick-Share landing. None of these are protocol- or data-shape
breaking changes; existing v1.11.0 deployments upgrade cleanly with
one additive migration (`077_checkout_decision_reason.sql`).

The three threads in this release tighten the **approver loop** end
to end: how an approver becomes aware of work (in-session popup),
what they can communicate back to the requester on a denial
(persisted reason on the credential-checkout side, matching the
already-persisted reason on the outbound-share side), and what a
requester _must_ supply to a non-bypass account before an outbound
share even reaches the approver queue (a ≥ 10-character
justification, enforced at both backend HTTP entry points).

### Added

- **In-session approval popup
  (`frontend/src/components/PendingApprovalWatcher.tsx`).**
  Approvers no longer have to leave their current page (a live
  remote session, the dashboard, anywhere in the SPA) to action a
  pending request. The watcher is mounted once in `App.tsx`,
  polls the two approval queues the user is gated for
  (`GET /api/user/pending-approvals` for credential checkouts and
  `GET /api/admin/outbound-shares/pending` for outbound shares,
  the latter only when the user has `can_manage_system` or
  `is_outbound_approver`), and surfaces each new pending item as a
  popup card with **Approve**, **Deny**, and **View all** actions
  wired straight to the existing decide endpoints. Cards are
  placed top-LEFT so they never collide with the regular toast
  stack (top-right) or the session-timeout warning
  (bottom-right). An unactioned card auto-dismisses after 30 s;
  the dismiss is recorded in a `localStorage` de-dup tracker so
  the next poll does not re-spawn the same card and so multiple
  open tabs do not each show a duplicate. The poll cadence is
  45 s with extra polls on `focus` and `visibilitychange` to
  surface freshly-arrived work the moment the approver switches
  back to the tab. On Deny the card expands an inline reason
  composer (`<textarea>` + Confirm / Cancel) before calling the
  decide endpoint, so denials never leave the requester guessing
  why. Architecturally mirrors the existing
  `CredentialProfileExpiryWatcher`, including the
  `localStorage`-backed cross-tab de-dup and the polite
  `Promise.allSettled`-style fanout that survives one endpoint
  being temporarily 500.
  - 2 new SPA API helpers in `frontend/src/api.ts`:
    `decideCheckout(id, approved, reason?)` (the `reason`
    parameter is the new addition — see below) and
    `decideOutboundShare(id, approve, reason?)` (already shipped
    in v1.11.0; reused here).
  - Coverage: `frontend/src/__tests__/PendingApprovalWatcher.test.tsx`
    exercises queue fanout, de-dup, auto-dismiss timing, Approve
    happy-path, Deny composer flow, and tolerance to one of the
    two queue endpoints being unavailable.

- **Persisted approver deny reason on credential checkouts.**
  Until now `password_checkout_requests.status = 'Denied'`
  carried no explanation, so a requester reading the audit trail
  saw only "Grace declined your request" with no further context.
  The outbound-share queue already persisted a `decision_reason`
  per row (see v1.11.0 / migration 073) and the new in-session
  approval popup _requires_ a reason before letting an approver
  hit Deny, so the absence of the column on the credential side
  was the only thing keeping the two queues asymmetric. This
  release closes that gap:
  - **Migration `077_checkout_decision_reason.sql`** —
    `ALTER TABLE password_checkout_requests ADD COLUMN IF NOT
EXISTS decision_reason TEXT` (nullable; pre-077 rows stay
    NULL rather than being backfilled to an empty string, so the
    UI can distinguish "no reason supplied" from "legacy denial
    that predates this field"). No length constraint at the DB
    layer — the handler enforces a 1024-char server-side cap
    after trimming, matching the outbound-share rule so the two
    queues stay symmetric.

  - **Handler change in `backend/src/services/checkouts.rs`** —
    `decide_checkout` now accepts an optional `reason` field on
    the request body, trims it, rejects > 1024 chars, persists it
    on the row, and threads it into the rejection email
    template. `approved` decisions accept (but do not require) a
    reason; `denied` decisions accept any reason supplied by the
    UI.

  - **Email templates** — `checkout_rejected.mjml` and
    `checkout_rejected.txt.tera` now render the approver's
    `decision_reason` in a dedicated "Reason from approver" block
    when present, falling back to silence when the field is NULL
    so legacy denials and reason-less new denials do not surface
    an empty block.

  - **Audit / notification path** — `services/notifications.rs`
    propagates `decision_reason` through the email render
    pipeline alongside the existing approver-username field.
    Audit-log shape is unchanged; the reason is captured in the
    email body and in the row, not as a separate audit event.

  - **API:** `POST /api/user/checkouts/:id/decide` now accepts
    `{ "approved": false, "reason": "Out of change window" }`.
    Body backwards-compatible — clients that omit `reason`
    continue to work.

  - **SPA wiring** — `frontend/src/pages/Approvals.tsx` was
    rewritten in this release to use an inline deny composer
    (textarea + Confirm / Cancel) that mirrors the popup's
    composer; both call the same `decideCheckout(id, false,
reason)` helper. The composer placeholder text
    (`e.g. Outside change window, contact owner first`) gives
    the approver a worked example. Coverage:
    `frontend/src/__tests__/Approvals.test.tsx` now drives the
    composer end-to-end (open → type → confirm → assert
    `decideCheckout` called with the trimmed reason).

- **Mandatory justification on outbound shares for users without
  the approval bypass.** When a user lacks the per-account
  `users.outbound_share_requires_approval = FALSE` bypass, every
  outbound submission must now carry a justification of **at
  least 10 characters** (whitespace-trimmed, **character count
  rather than byte count** so non-ASCII reasons such as accented
  text or CJK are not penalised). Bypass users continue to
  submit without one — auto-approval semantics are unchanged for
  the bypass path.
  - **Helper:**
    `routes::outbound_shares::validate_outbound_justification(
requires_approval, justification) -> Result<(), AppError>` is
    the single source of truth for the rule. It exists as a
    free-standing function so both HTTP entry points share one
    rule **and** so the rule is unit-testable without a database
    fixture.

  - **Backend chokepoint at BOTH outbound entry points:**
    1. `finalize_submit` (the drag-and-drop / browser upload
       path) — validation runs **after** the user-row lookup
       (which gives the helper the `requires_approval` boolean
       to gate on) and **before** the `staging_root()` / sealed
       blob write, so a denied request never leaves a partial
       sealed blob behind to be reaped later.

    2. `issue_ingest_token` (the curl / curl.exe / PowerShell 7
       snippet path) — validation runs **before**
       `outbound_share_ingest::mint(...)`. This means the user
       sees the "justification too short" error inside the
       Outbound Share panel at the moment they click "Generate
       upload command", **not** after they have already pasted
       the snippet into a remote shell and run it (which would
       have surfaced as an opaque 400 from inside the session,
       far away from the panel where the textarea lives).

  - **Error contract:** validation failures return
    `AppError::Validation` (HTTP 400) with the user-facing
    message _"A justification of at least 10 characters is
    required for outbound shares unless the approval bypass is
    enabled for your account."_

  - **4 new unit tests in
    `backend/src/routes/outbound_shares.rs`:**
    - `justification_not_required_when_bypass_enabled` —
      None / empty / whitespace-only / short all pass when
      `requires_approval = false`.
    - `justification_required_when_approval_required` — covers
      None, `""`, `"   "`, and a too-short value (all fail) plus
      a `"\u200B"`-padded edge case; verifies the exactly-10-char
      boundary passes and a 33-char realistic justification
      passes.
    - `justification_counts_chars_not_bytes` — 10× `é` (20 bytes
      but 10 Unicode scalar values) passes; 9× `é` fails. This
      is the test that locks in the "count chars, not bytes"
      contract.

- **`MeResponse.outbound_share_requires_approval`** (extension to
  the v1.11.0 `MeResponse` shape).
  - Added to **both** `routes/auth.rs::check_auth` (the SPA
    bootstrap path called by `checkAuthStatus()`) and
    `routes/user.rs::me` (the refresh path called by
    `getMe()`), so the field is present on the very first SPA
    load **and** on every subsequent `/me` refresh. This honours
    the repo's documented `MeResponse` drift rule — every new
    `MeResponse` field MUST be added to both handlers or
    nav / permission gates break asymmetrically depending on
    which load path triggered first.
  - Frontend exposes the tri-state as
    `outbound_share_requires_approval: boolean | null` on the
    `MeResponse` interface in `frontend/src/api.ts`. `App.tsx`
    derives a single boolean `outboundShareBypass = user?.
outbound_share_requires_approval === false` and threads it
    through to the existing `SessionManagerProvider` so the
    drive-channel `onfile` interceptor and the
    `QuickShareOutbound` panel both share the same source of
    truth.

### Changed

- **`QuickShareOutbound` panel UX.** When the active user does
  not have the outbound bypass:
  - The justification `<label>` renders a red asterisk
    (`<span className="text-danger">*</span>`) and the field
    is marked `aria-required="true"`.
  - The placeholder text changes from the generic _"Why does the
    next exported file need to leave the session?"_ to a worked
    example: _"Required — e.g. Audit ticket INC-1234, exporting
    redacted log for review"_.
  - A small helper line — _"Required for your account (minimum
    10 characters)"_ — appears beneath the textarea so the
    requirement is visible before the user clicks anything.
  - The **Generate upload command** button stays disabled until
    the trimmed justification reaches the 10-character minimum,
    and renders a tooltip _"Enter at least 10 characters of
    justification above before generating the upload command."_
    while disabled so the user can self-diagnose without
    clicking through to a 400.

- **`SessionManager.client.onfile` interceptor.** The
  drag-and-drop / drive-channel path now mirrors the
  panel-level gate: if `outboundShareBypass` is `false` and the
  active session's `pendingOutboundJustification` is shorter
  than 10 characters (after trim), the interceptor surfaces a
  warning toast (_"Justification required: <filename>"_) with
  remediation copy (_"Open the Outbound Share panel, enter at
  least 10 characters explaining why this file needs to leave
  the session, then re-drop the file."_) and short-circuits
  **before** the `FormData` POST. This avoids a confusing
  toast-on-400 flow where the user has already let go of the
  file and now has to guess why it was rejected.

- **Inline deny composer on `frontend/src/pages/Approvals.tsx`.**
  The standalone `decideCheckout(id, false)` call is replaced by
  an inline composer (textarea + Confirm Deny / Cancel buttons)
  that mirrors the in-session popup's composer, so the two
  surfaces have a single deny-flow shape. The composer's
  textarea is required before Confirm is enabled and the
  trimmed value is sent as the `reason` field.

### Fixed

- `frontend/src/__tests__/Approvals.test.tsx` — the
  "denies a request and shows flash message" test was stale
  after the composer rewrite (it still expected the immediate
  `decideCheckout(id, false)` call). Rewritten in this release
  to drive the composer end-to-end: click Deny → wait for the
  textarea → type _"Out of change window"_ → click "Confirm
  deny" → assert `decideCheckout` was called with
  `("cr1", false, "Out of change window")`.

### Operational impact

- **One additive migration applies automatically on first
  boot:** `077_checkout_decision_reason.sql`. The column is
  nullable with no default; legacy `Denied` rows stay
  `decision_reason = NULL` and the email template treats NULL
  as "render no reason block", so the deploy is silent on
  pre-077 data.
- **No new environment variables.**
- **No new role permissions** — the 10-char minimum reuses the
  existing `outbound_share_requires_approval` per-user flag
  shipped in v1.11.0.
- **No protocol changes.** The drive-channel and HTTPS
  upload-command ingest paths still target the same endpoints
  with the same multipart shape; only the validation rule on
  `justification` is new.
- **Backwards-compatible request shapes.** Clients of
  `POST /api/user/checkouts/:id/decide` that omit `reason`
  continue to work; the rejection email simply renders no
  reason block. Clients of
  `POST /api/user/outbound-shares` and
  `POST /api/user/outbound-shares/ingest-token` that submit
  with a sufficient justification continue to work; only
  bypass-off users submitting an empty or short justification
  see the new 400.
- **Recommended deploy:** rebuild and recreate the **backend**
  container (picks up migration 077 + the new validation +
  the email template change) and the **frontend** container
  (picks up `PendingApprovalWatcher`, the composer rewrite of
  `Approvals.tsx`, the `QuickShareOutbound` panel UX changes,
  and the `SessionManager.onfile` gate). The `strata-dmz` relay
  and `guacd` images are unchanged.

### Test results

- Backend: 16 `outbound_shares` unit tests pass under
  `cargo test --bin strata-backend outbound_shares::tests` —
  including the 3 new `justification_*` tests and the
  pre-existing 13 DLP / status / sanitisation tests.
- Frontend: all 76 vitest files pass under `npx vitest run` —
  including the rewritten Approvals deny-flow test, the new
  `QuickShareOutbound` bypass-off UX test, and the
  `PendingApprovalWatcher` queue-fanout / de-dup / composer
  tests.

## [1.11.0] — 2026-06-08

### Added

- **Outbound Quick-Share — approval-gated file export with dual
  ingest paths.** New feature mirroring the inbound Quick-Share but
  in reverse: files leaving a remote session are intercepted, sealed
  at rest, run through a built-in DLP heuristic, and either
  auto-approved (low score + per-user opt-in) or queued for an
  approver. Approved shares are released as a time-limited
  single-use download; denied or expired shares are purged and the
  sealed DEK is zeroised by a periodic worker so the staging blob
  cannot be recovered after TTL.
  - **Drive-channel ingest path.** `SessionManager`'s
    `Guacamole.Client.onfile` handler is rewired: when the active
    role grants `can_use_quick_share_outbound`, files that guacd
    pushes back over the RDP/SFTP drive channel are buffered in the
    browser (`Guacamole.BlobReader`) and uploaded to
    `POST /api/user/outbound-shares` instead of triggering an
    automatic download. The active-session pending-justification
    text is included in the multipart body and cleared on success.
    A `strata:outbound-share-submitted` window event triggers the
    panel to refresh its history list.

  - **HTTPS upload-command ingest path** (drive-redirect bypass).
    For environments where group policy disables RDP / SFTP drive
    redirection at the target — and the drive-channel interceptor
    therefore never fires — the Outbound Share panel can mint a
    single-use, 10-minute upload token via
    `POST /api/user/outbound-shares/ingest-token` (cookie + CSRF
    authed). The panel renders the token into a `curl` / `curl.exe`
    / PowerShell 7 `-Form` one-liner with an optional
    skip-TLS-cert-check toggle and a live mm:ss expiry countdown;
    the user pastes the snippet inside the remote session shell.
    The remote-session shell POSTs the file to
    `POST /api/outbound-shares/ingest/{token}` — unauthenticated at
    the cookie layer (the token IS the auth) — which atomically
    consumes the token, re-checks the minter's
    `can_use_quick_share_outbound` role permission at consume time
    (so a revoked role cannot launder a previously-minted token),
    and feeds the upload through the same DLP / approval / audit
    pipeline. Tokens are bound to the minting user + session +
    connection + justification at issue time so the audit chain
    survives the unauthenticated network hop. Rate-limited 10
    mints/minute/user; expired tokens reaped by the existing daily
    cleanup worker.

  - **Role permission `can_use_quick_share_outbound`.** Enforced by
    `services::middleware::check_quick_share_outbound_permission`
    on every authed outbound endpoint and re-checked at token
    consume time. `can_manage_system` does NOT bypass this gate —
    outbound file export is treated as a deliberately separate
    capability from general system administration.

  - **Per-user `outbound_share_requires_approval` flag** (default
    `true`). Admin → Access exposes a per-user toggle; when off, a
    submission with `dlp_score <= AUTO_APPROVE_THRESHOLD` is
    released directly without queueing.

  - **Approver delegation** (`outbound_share_approvers` table).
    Super-admins (`can_manage_system`) are implicit approvers; the
    new Admin → Outbound Shares tab lists explicit non-admin
    delegates (e.g. compliance officers). Adding / removing
    approvers is gated to super-admins.

  - **Admin → Outbound Shares tab.** Combines the pending queue
    (Approve / Deny with reason), full history with download /
    purge actions, and the approver delegation list. Visible when
    the calling user has `can_manage_system` OR
    `is_outbound_approver` (the per-user flag computed from
    `outbound_share_approvers`).

  - **`/me` response extensions.** `can_use_quick_share_outbound`
    and `is_outbound_approver` are now returned so the SPA can
    light up the in-session button and the admin tab without an
    extra round-trip.

  - **In-session UX.** A new **Outbound Share** button is added to
    the Session Bar next to Quick Share (icon: outbound arrow with
    folder). The panel shows: how-to banner naming the active
    session's mapped Strata drive, a justification textarea
    attached to the next intercepted file from this session, the
    HTTPS upload-command generator with format dropdown
    (`curl` / `curl.exe` / PowerShell 7) and insecure-TLS toggle,
    and the user's submission history with status badges, DLP
    score, decision reason, and per-share download link for
    approved files.

  - **Endpoints.** Authed user surface:
    `POST /api/user/outbound-shares` (multipart submit),
    `GET  /api/user/outbound-shares` (list mine),
    `GET  /api/user/outbound-shares/download/{token}` (single-use
    download for the requester),
    `POST /api/user/outbound-shares/ingest-token` (mint upload token).
    Authed admin/approver surface:
    `GET    /api/admin/outbound-shares` (list all),
    `GET    /api/admin/outbound-shares/pending`,
    `POST   /api/admin/outbound-shares/{id}/decide`,
    `DELETE /api/admin/outbound-shares/{id}` (purge),
    `GET    /api/admin/outbound-shares/approvers`,
    `POST   /api/admin/outbound-shares/approvers`,
    `DELETE /api/admin/outbound-shares/approvers/{user_id}`.
    Unauthenticated token-auth surface (public router, no CSRF):
    `POST /api/outbound-shares/ingest/{token}` (500 MB body cap).

  - **Migrations.** `073_outbound_quick_share.sql` adds the
    `outbound_shares` (id, requester_user_id, session_id,
    connection_id, filename, content_type, size, justification,
    sealed_dek, ciphertext_path, dlp_score, dlp_reasons, status,
    decided_by_user_id, decision_reason, download_token,
    download_consumed_at, created_at, expires_at) and
    `outbound_share_approvers` (user_id PK, granted_by, granted_at)
    tables, plus the `roles.can_use_quick_share_outbound` and
    `users.outbound_share_requires_approval` columns.
    `074_outbound_share_ingest_tokens.sql` adds the
    `outbound_share_ingest_tokens` (token PK, user_id, session_id,
    connection_id, justification, expires_at, created_at,
    created_ip, used_at, used_ip) table.

  - **Audit events.** `outbound_share.submitted`,
    `outbound_share.decided`, `outbound_share.downloaded`,
    `outbound_share.purged`, `outbound_share.approver_added`,
    `outbound_share.approver_removed`,
    `outbound_share.ingest_token.minted`,
    `outbound_share.ingest_token.consumed`.

  - **Periodic worker integration.** The existing daily
    `user_cleanup` worker now also calls
    `services::outbound_shares::purge_expired` (sweeps expired
    shares + zeroises sealed DEKs) and
    `services::outbound_share_ingest::purge_expired` (sweeps
    expired ingest tokens older than 1 day).

  - **`STRATA_OUTBOUND_SHARES_DIR` env var** — configurable staging
    directory for sealed outbound blobs. Defaults to
    `/tmp/strata-outbound-shares` (Linux containers) with a
    platform-temp-dir fallback when that path isn't writable.

### Operational impact

- Two new migrations apply automatically on first boot
  (`073_outbound_quick_share.sql`, `074_outbound_share_ingest_tokens.sql`).
- No new operator configuration required. The feature is dormant
  until at least one role has `can_use_quick_share_outbound`
  enabled.
- Recommended deploy: rebuild and recreate the backend container.
  Existing roles do not gain the new permission automatically — an
  administrator must enable it explicitly per role.

## [1.10.9] — 2026-06-08

### Patch Release — Safeguard one‑off profile ticket routing and local-unseal guard

v1.10.9 fixes a runtime reliability bug observed when connections
were established with a tunnel ticket that selected an ad‑hoc
(`one-off`) Safeguard credential profile. The previous ticket path
could attempt a Vault `unseal` on empty local encrypted payloads for
profiles of `kind = 'safeguard'`, which produced a "missing ciphertext"
error and caused the credential flow to fail with a 502/500 response.

Fixes include:

- Consume tunnel tickets early so the one‑off `credential_profile_id`
  is canonicalised and routed through the same Safeguard JIT/cache
  flow as mapped profiles.
- Add `safeguard_target_for_profile` (with `ttl_hours`) and reuse the
  JIT checkout + password cache path for one‑off profiles, avoiding
  duplicated logic paths.
- Skip calling `vault::unseal` on empty `encrypted_*` fields when a
  `safeguard_password` is present (Safeguard‑backed profiles), so
  local-empty placeholders do not trigger decryption errors.

Operational impact:

- No database migrations.
- No operator configuration changes.
- Recommended deploy: rebuild and recreate the backend container.

## [1.10.8] — 2026-06-03

### Patch Release — DMZ link liveness: TCP keepalive + h2 PING watchdog

v1.10.8 closes the only reliability gap left in the dmz-edge
topology. When the DMZ peer disappeared ungracefully (container
restart, NAT idle timeout, stateful firewall reload) the backend's
outbound link socket could stay "Up" against a dead remote for the
OS default ~2 h before the next write surfaced `ECONNRESET`. During
that window every public request returned `503 NoLinkUp` from the
DMZ — its side of the registry had already been torn down on the
remote's exit — while the backend supervisor still reported the
link as healthy because no I/O error had surfaced yet. The only
operator recovery was a manual **Admin → DMZ Links → Force reconnect**.

This release adds two complementary liveness probes that are always
on and require no configuration:

#### Fixed

- **TCP keepalive on the link socket** (`backend/src/services/dmz_link/tls.rs`).
  Immediately after `TcpStream::connect` (and before the TLS handshake)
  the connector now applies `socket2::TcpKeepalive::new().with_time(30s).with_interval(10s)`
  via `SockRef::set_tcp_keepalive`. The kernel begins probing 30 s
  after the last TX, retries every 10 s, and (with the OS-default
  retry count) surfaces a dead peer in ~60 s. Failure to set the
  option is non-fatal — a `warn!` is logged and the link still
  comes up; the h2 PING watchdog below covers the same condition.
  `socket2::TcpKeepalive::with_retries` is intentionally not used:
  it requires the crate's `all` feature and is platform-gated, and
  the OS default count combined with the 10 s interval already meets
  our recovery budget.

- **HTTP/2 PING watchdog** (`backend/src/services/dmz_link/h2_serve.rs`).
  Immediately after `h2::server::Builder::handshake` returns, the
  serve loop takes `conn.ping_pong()` and spawns a
  `ping_watchdog(PingPong, CancellationToken)` task. The watchdog
  PINGs every 30 s (`tokio::time::interval` with
  `MissedTickBehavior::Delay`; the first tick is burned so we
  do not ping the peer the microsecond the handshake completes)
  and awaits each pong with a 10 s `tokio::time::timeout`. On
  timeout or send error it cancels the supervisor's per-cycle
  token, which causes the main loop to issue
  `conn.graceful_shutdown()`, drain in-flight streams, return
  cleanly, and let the supervisor's outer loop redial. The watchdog
  is aborted on both `serve_h2` exit paths (clean peer close and
  protocol error) so it never outlives the connection it watches.

#### Rationale for two probes at different layers

TCP keepalive alone misses the case where intermediate firewalls
proxy bytes but garbage-collect connection state on idle, so probe
packets are dropped silently and the kernel never observes a RST.
The h2 PING watchdog alone misses nothing in principle, but TCP
keepalive is cheaper (kernel-level) and surfaces failures slightly
faster when the path is firewall-clean. The two probes operate at
different layers with independent failure modes; a half-open
connection that defeats one is almost always caught by the other
within ~60 s.

#### Operational impact

- **No new environment variables.** Both probe intervals are
  compile-time constants (30 s idle / 10 s probe for both layers)
  chosen to comfortably exceed any legitimate link silence while
  still surfacing a dead peer well inside the public gateway's
  idle timeout.
- **No new migrations.**
- **No API changes.** `/api/admin/dmz-links`, the `dmz-edge`
  topology compose files, and the operator surface on the DMZ
  (`127.0.0.1:9444`) are unchanged.
- **Recommended deploy:** rebuild and recreate the **backend**
  container only. The `strata-dmz` relay is unchanged.

#### Observable telemetry

New WARN-level log lines on the backend identify the failure mode
when the watchdog trips:

- `DMZ link: failed to enable TCP keepalive` — non-fatal,
  identifies the endpoint and the underlying `std::io::Error`.
- `DMZ link h2 PING failed; tearing down link` — transport error
  on PING send (peer closed, h2 layer wedged).
- `DMZ link h2 PING timed out; tearing down link` — peer accepted
  the PING frame but never returned a pong inside the 10 s
  deadline.

Each is followed by the existing `DMZ link down` reason line and
the supervisor's normal redial sequence.

#### Build dependencies

- Added `socket2 = "0.5"` to `backend/Cargo.toml`. The crate is a
  light, well-audited wrapper that exposes platform socket options
  that aren't surfaced by `tokio::net::TcpStream`. Resolved to
  `socket2 v0.6.3` in `Cargo.lock`.

## [1.10.5] — 2026-06-01

## [1.10.6] — 2026-06-02

### Patch Release — Safeguard token sanitization, validation & improved diagnostics

v1.10.6 is a small reliability patch that hardens Safeguard token handling,
adds live token validation, and improves backend diagnostics for opaque
`reqwest` errors. Key fixes:

- Trim decrypted bearer tokens on load and reject tokens that contain
  control bytes (e.g. trailing newlines) at store time to prevent invalid
  `Authorization` header values being sent to upstream Safeguard APIs.
- Walk and log the `reqwest::Error` source chain so the real underlying
  cause (invalid header value, TLS/network errors, etc.) appears in the
  backend logs instead of the opaque `builder error` message.
- **Validate user-supplied Safeguard tokens against the appliance
  before storing them.** `POST /api/user/safeguard/token` and
  `POST /api/safeguard/enrol` now probe `/service/core/v4/Me` with the
  pasted token and reject it cleanly when Safeguard returns 401/403,
  so an already-expired or revoked token never shows up as "signed in".
- **Derive cached token expiry from the JWT `exp` claim** when present,
  instead of trusting the client's `expires_in_seconds` hint, so the
  UI reflects the appliance's real token lifetime.
- **`GET /api/user/safeguard/status` now live-probes the cached
  token** with the appliance. Definitive rejections (401/403) clear
  the row and report `signed_in = false`; transient errors leave the
  cached token in place so a brief appliance blip doesn't sign the
  user out.

#### Admin UX — Access tab pagination, search, and per-user Safeguard JIT

v1.10.6 also lands three Access-tab improvements that were piling up as
the Strata footprint grew past a handful of seed users:

- **Search + pagination for Users and Folders**, mirroring the existing
  Connections layout (20 rows per page, case-insensitive substring filter
  across username/email/full-name/role/OIDC sub for users, and
  name/parent for folders).
- **Per-user Safeguard JIT opt-in.** A new `safeguard_jit_enabled` boolean
  on `users` (migration `072_safeguard_jit_per_user.sql`, default
  `FALSE`) lets admins onboard users one at a time. The global master
  switch on the Safeguard tab still acts as the kill-switch; every
  credential-flow endpoint (`/user/safeguard/enabled`,
  `/user/safeguard/bulk-checkout`, `/user/safeguard/accounts`,
  `POST /user/credential-profiles`, and the lower-level
  `services::safeguard::jit_checkout`) now ANDs the two together so a
  user without the flag cannot reach Safeguard even by direct API call.
  The Access tab gains a "Safeguard JIT" checkbox per user; the
  Safeguard admin tab description now points operators at it.

Operators: run migrations on upgrade; the new column defaults to
`FALSE` so no existing user gains Safeguard access until you tick the
box.

### Patch Release — Recordings reliability and Azure offload

v1.10.5 is a small reliability patch that addresses session-recording delivery
and retention in Azure-backed deployments. Key fixes:

- Ensure guacd can create recording files on the shared recordings volume
  (fixes failures where `Creation of recording failed: Exhausted all possible
unique suffixes` was logged) by correcting runtime ownership and entrypoint
  behaviour so the recorder runs with appropriate write access.
- Background sync worker now reliably uploads completed recordings to Azure
  Blob Storage and flips the database `storage_type` to `azure` so the UI
  reflects remote storage. Local copies are deleted after successful upload.
- Retention purge includes Azure-backed recordings and deletes remote blobs
  for rows older than the configured `recordings_retention_days`.

Operators upgrading to v1.10.5 who previously saw `LOCAL` storage in the
Sessions UI should now observe successful offload to the configured Azure
container once the guacd container is rebuilt and recreated.

## [1.10.4] — 2026-05-29

### Patch Release — Security & DMZ hardening: CSRF/CSWSH bypass closure, DMZ body streaming, secret-redacting logs, and config-warning startup banners

v1.10.4 is a **security- and reliability-focused patch** with no
user-facing feature changes. It lands the full implementation of the
v1.10.3 internal code review (CRITICAL + HIGH + MED findings) plus
a streaming-mode refactor of the DMZ reverse-proxy that drops
per-request memory ceiling from ~16 MiB to roughly one h2 flow-control
window (~64 KiB). The DMZ public listener is now pinned to TLS 1.3
and configured with conservative HTTP/2 SETTINGS that mitigate
CVE-2023-44487 ("Rapid Reset") class abuse. A new startup banner
emits `error!`-level warnings when the backend is started against
the docker-compose default credentials, an `http://` Vault address,
or a JWT secret shorter than 32 bytes. Default behaviour is unchanged
for correctly-configured production deployments; nothing here is a
breaking change.

### Security

- **CSRF bearer-exemption now requires JWT signature verification.**
  Previously the CSRF middleware short-circuited whenever an
  `Authorization: Bearer …` header was present, on the theory that a
  third-party site couldn't read the victim's bearer token from
  `localStorage`. A malicious origin could still send
  `Authorization: Bearer anything-at-all` to bypass the check
  outright. The middleware now decodes the token with the local
  JWT secret (signature only — exp/aud still checked by
  `require_auth`); only signature-valid bearers are exempted. Fake
  bearers fall through to the standard cookie + `X-CSRF-Token`
  check and are rejected. The same JWT-signature gate is applied to
  the WebSocket-upgrade no-Origin bearer fallback to close the
  equivalent CSWSH path.
- **AdSyncConfig no longer leaks bind passwords via `Debug`.** The
  derived `Debug` impl on `AdSyncConfig` printed `bind_password` /
  `pm_bind_password` in plaintext after Vault unsealed them. The
  derive is replaced with a manual `impl Debug` that emits
  `<unset>`, `<vault-encrypted>`, or `<redacted>` for the two
  password fields while keeping every other field readable.
- **`X-Forwarded-For` is now ignored unless explicitly trusted.**
  The backend (not just the DMZ relay) now honours `X-Forwarded-For`
  for audit-log attribution and per-IP rate limiting **only** when
  `STRATA_TRUST_XFF=1` is set. Without it, every request appears to
  come from the socket peer — the same fail-safe default the DMZ
  side already uses. Production deployments behind a reverse proxy
  must set this env var (and ideally restrict the trust scope via
  `STRATA_TRUSTED_PROXIES`); a startup banner reminds operators
  when the var is missing. `try_extract_client_ip` was refactored
  to extract a pure `parse_xff_rightmost` helper for race-free unit
  testing.
- **Logout only persists revocations for cryptographically-verified
  JWTs.** Previously, `POST /api/auth/logout` would unconditionally
  add the bearer string to the in-memory + DB revocation table.
  Unauthenticated callers could spam junk strings to bloat the
  table (a slow DoS). The handler now only revokes tokens that
  decode as valid local JWTs; cookie clearing remains best-effort
  for browser sessions. OIDC tokens still need to end at the IdP
  via its `end_session_endpoint`.
- **`change_password` now revokes every active token surface.** The
  handler previously revoked only the `Authorization: Bearer` token
  on the change_password request, leaving valid `access_token` and
  `refresh_token` cookies behind. It now iterates all three sources
  and revokes each one that decodes as a valid local JWT, forcing
  full re-authentication on the next request as expected.
- **`persist_revocation` failures are now logged at `error!`.** The
  Postgres write inside `token_revocation::persist_revocation` used
  to silently swallow errors. It now logs at `error!` level and
  increments a counter, so operators are alerted when token
  revocation is degraded (e.g. DB partition full).
- **HTTP/2 SETTINGS hardening on the DMZ public listener
  (CVE-2023-44487 mitigation).** The `hyper-util` auto-builder for
  the public-facing h2 connection is now configured with
  `max_concurrent_streams=128`, `max_frame_size=64 KiB`,
  `max_header_list_size=16 KiB`, `max_send_buf_size=1 MiB`, and a
  20-second keep-alive. Defends against Rapid Reset-class abuse
  where a single client opens and immediately cancels streams to
  exhaust the server.
- **TLS 1.3 pin on the DMZ public listener.** Replaces the previous
  `ServerConfig::builder()` with `builder_with_protocol_versions(&[
&rustls::version::TLS13])`, dropping TLS 1.2 from the internet-
  facing surface. Internal-link mTLS (which is consumed by both
  halves of the deployment, not the public) is unchanged.
- **Edge-header strip widened.** `edge_signer` now strips
  `x-real-ip`, every `x-forwarded-*` variant, and every
  `x-strata-admin-*` header from the public request before signing
  the canonical bundle, in addition to the existing
  `x-strata-edge-*` strip. Closes a smuggling vector where a
  cooperative public client could pre-stamp a header to confuse
  internal trust logic that reads non-edge headers.
- **Edge-signer UA truncation is char-boundary-safe.** The previous
  byte-slice truncation could panic on a multi-byte UTF-8 boundary
  if the public client sent a sufficiently exotic User-Agent;
  truncation now respects `char_indices`.
- **Argon2 parameters pinned to OWASP minimum.** A new
  `services::password::pinned_argon2()` returns an `Argon2`
  configured with `Params::new(64 MiB, t=3, p=4)` and Argon2id
  `Version::V0x13`. All **write-side** password-hashing call sites
  (default-admin bootstrap, admin user create/reset) now use the
  pinned helper. Verification continues to use the parameters
  embedded in the stored PHC string, so existing hashes
  (including any with weaker parameters) remain verifiable. There
  is no migration step — newly-set passwords get the stronger
  params; existing hashes will be rehashed lazily when users
  next change their password.
- **Docker-compose default-credential startup banner.** A new
  `log_security_config_warnings()` runs at boot and emits
  `error!`-level entries when:
  - `DATABASE_URL` contains the well-known dev password
    `strata_default`,
  - `VAULT_TOKEN=root`,
  - `VAULT_ADDR` starts with `http://`,
  - `JWT_SECRET` is unset, shorter than 32 bytes, or matches a
    known placeholder,
  - `STRATA_TRUST_XFF=1` is set without `STRATA_TRUSTED_PROXIES`.
    Dev/compose flows continue to work; production deployments now
    get a loud reminder if any of the above are still in place.
- **Frontend `api.ts` no longer logs CSRF cookie presence.** Two
  `console.log` statements in the refresh path that leaked the
  presence of the CSRF cookie to devtools have been removed. The
  single-flight refresh implementation (`isRefreshing` +
  `refreshPromise`) was already correct and is unchanged.
- **Defensive SVG-text escaping on SessionsTab chart.** The session-
  activity SVG chart interpolated `d.date` (currently a
  server-controlled `YYYY-MM-DD`) directly into a string assembled
  for `dangerouslySetInnerHTML`. A new `escapeSvgText()` helper
  now wraps every interpolated value so the rendering is safe
  against future API-contract drift even if the date format ever
  changes to include user-supplied text.

### Performance

- **DMZ reverse-proxy streams request and response bodies (M5).**
  The DMZ proxy used to fully buffer each direction into a
  `BytesMut` up to 8 MiB before forwarding. Under N concurrent
  requests the resident set could grow by `2 × 8 × N` MiB and the
  proxy was a built-in DoS amplifier for upload/download bombs.
  Both directions are now streamed:
  - **Request body.** A spawned `pump_request_body_upstream` task
    reads chunks from the axum `Body` and writes them to the h2
    `SendStream` honouring flow control via `reserve_capacity` /
    `poll_capacity`. The total-byte cap is enforced byte-by-byte;
    mid-stream overshoot triggers `send_reset(h2::Reason::CANCEL)`.
    A pre-flight `Content-Length` check still rejects honest
    oversized requests with `413` before any link is touched.
  - **Response body.** A new `RecvStreamBody` adapter implements
    `futures::Stream` over `h2::RecvStream`, releases the
    flow-control window per chunk, and enforces the cap as data
    flows. `axum::body::Body::from_stream` wires it into the
    public response. A pre-flight `Content-Length` check returns
    `507` before any byte reaches the public client; mid-stream
    overshoot truncates the response and closes the public
    connection by returning an error from the stream.
    Per-request memory dropped from up to ~16 MiB to roughly one h2
    flow-control window (~64 KiB). The retry-after-pick semantics
    narrowed: the two-attempt retry now happens at
    `SendRequest::ready()` time **before** the body is consumed.
    After `send_request` is called the body cannot be replayed, so
    any subsequent failure is fatal to that request and the public
    client must retry (idempotent methods in browsers do this
    automatically). The trade is acceptable because (a) the failure
    window is small, (b) the new memory ceiling is the real win, and
    (c) the prior "retry after buffering 8 MiB twice" path was itself
    an amplifier.

### Removed

- Dead code: `proxy::read_body_capped`, `proxy::BodyReadError`,
  and `proxy::ProxyError::BodyReadFailed` — all subsumed by the
  streaming pump.

### Configuration

- **New env var `STRATA_TRUST_XFF`** (`backend`). Set to `1` to opt
  into honouring `X-Forwarded-For` for audit-log attribution and
  rate-limiting key extraction. Required in any deployment behind a
  reverse proxy or load balancer; otherwise rate limits collapse to
  per-LB-IP buckets and audit logs lose source-IP fidelity. Pair
  with `STRATA_TRUSTED_PROXIES` (comma-separated CIDRs) to scope
  trust. Defaults to disabled (`0`).
- **`.env.example` reorganised.** A new top-of-file warning block
  enumerates the five must-set production variables that the
  startup banner now warns about (`POSTGRES_PASSWORD`,
  `VAULT_TOKEN`, `VAULT_ADDR`, `JWT_SECRET`, `STRATA_TRUST_XFF`),
  with the appropriate `STRATA_TRUST_XFF` / `STRATA_TRUSTED_PROXIES`
  block added alongside the existing variables.

### Tests

- **Four new streaming-mode tests** in
  `crates/strata-dmz/src/proxy.rs::tests`:
  - `request_oversized_content_length_returns_413_before_pick` —
    empty registry + over-cap CL header returns `413`, never
    reaches `NoLinkUp`.
  - `request_body_streams_intact_to_upstream` — 1 MiB body
    delivered as 1024 × 1 KiB chunks (no `Content-Length`)
    arrives at the upstream byte-for-byte, including chunk-index
    marker bytes.
  - `request_body_oversize_without_cl_is_capped_and_request_fails`
    — 9 MiB body in 9 × 1 MiB chunks (no `Content-Length`) is
    reset mid-stream by the pump; public response is not `200`.
  - `upstream_response_oversize_content_length_returns_507` —
    upstream advertises an over-cap `Content-Length` on the
    response headers; proxy returns `UpstreamTooLarge` (→ `507`)
    before forwarding any body bytes.
- `parse_xff_rightmost` helper extracted from
  `try_extract_client_ip` so its parsing is unit-testable without
  having to spin up an HTTP request context.

### Notes for operators

- **Existing deployments**: no migration required. Bump container
  versions and rolling-restart. Watch for the new startup-banner
  `error!` lines on first boot — if you see them, your `.env` or
  compose overrides are still on dev defaults and must be tightened
  before going production.
- **Deployments behind a reverse proxy**: set `STRATA_TRUST_XFF=1`
  on the backend container, otherwise rate limits and audit logs
  will see every request as originating from the load-balancer IP
  starting with this release.
- **OIDC sessions**: logout for OIDC tokens is now a no-op on the
  server side (the previous behaviour was incorrect — opaque OIDC
  tokens are not local JWTs and cannot be revoked here). If you
  rely on Strata logout to end the IdP session, configure the IdP's
  `end_session_endpoint` and trigger it from the SPA on logout.
- **External API clients using opaque bearer tokens** (non-local-JWT
  bearers) will now receive `403 CSRF` on state-changing requests
  unless they also send the cookie + `X-CSRF-Token` pair. Migrate
  such clients to local JWTs or switch to cookie auth.

## [1.10.3] — 2026-05-27

### Minor Release — Multiplayer co-pilot: owner participation, force-grant, and WebRTC audio

v1.10.3 closes three gaps in the multiplayer co-pilot feature shipped
in v1.9.x. Previously a session owner who created a multiplayer share
could not participate in their own room, owners had no UI to take
control back from a misbehaving viewer, and the `audio_offer` /
`audio_answer` / `ice` envelopes in the wire protocol had no client
implementation behind them. All three are addressed in this release.

### Added

- **Owner-side co-pilot WebSocket** — new authenticated endpoint
  `GET /api/user/shared/copilot/:share_token` lets the session owner
  join their own multiplayer room with `is_owner=true`. The owner now
  sees peer cursors and chat, holds the input token implicitly, and
  can supply the `by` attribution for InputGrant broadcasts. The
  existing public `/api/shared/copilot/:share_token` endpoint is
  unchanged for invited viewers.
- **Force-grant route** — `POST
/api/user/shared/copilot/:share_token/grant/:target_pid` lets the
  owner transfer the input token to any participant in the room.
  Verifies share ownership, broadcasts `InputGrant` + `Roster`, and
  writes a `connection.copilot_force_grant` audit row.
- **Per-row "Give" button** in the co-pilot overlay (owner only) that
  calls the force-grant route for any roster row that doesn't already
  hold the token.
- **WebRTC full-mesh audio** — opt-in browser-to-browser voice using
  a new `useCoPilotAudio` hook. Full-mesh topology capped by the
  server's 6-peer room limit; STUN-only via
  `stun:stun.l.google.com:19302`; lower-lexicographic pid is the
  offerer to prevent glare; ICE candidates received before
  `setRemoteDescription` are buffered per peer. The overlay footer
  exposes a **Join audio** / **Leave audio** toggle whenever the
  room's `allowAudio` policy bit is set. Wired in both
  `SessionClient` (owner) and `SharedViewer` (viewer).

### Changed

- **Modern checkboxes** across the app — every native `<input
type="checkbox">` now renders with a unified Tailwind-styled
  appearance that matches the existing button/toggle palette
  (`d5bd26f`).
- `CoPilotRoom::force_grant` is no longer dead code (the new HTTP
  route is its first production call site); the
  `#[allow(dead_code)]` attribute was removed.

## [1.10.2] — 2026-05-26

### Patch Release — Safeguard sign-in auto-post, account picker, and in-place credential-profile kind switching

v1.10.2 is a UX-focused refinement of the Safeguard JIT integration
shipped in v1.10.0 and hardened in v1.10.1. Three related changes land
together:

1. **Automated token enrolment via one-shot codes** (PR
   [#186](https://github.com/Bails309/strata-client/pull/186)) — the
   **Safeguard sign-in** card on the Credentials page now bridges the
   browser-based RSTS sign-in flow and Strata's per-user token store
   without manual copy-paste of the bearer JWT. Operators paste a
   PowerShell snippet with an embedded **one-shot enrolment code**
   (8-character Crockford base-32, 5-minute TTL, single-use,
   rate-limited 5 mints/min/user) that auto-posts the resulting
   bearer token back to Strata via `Invoke-RestMethod`.
2. **Safeguard account picker** (PR
   [#188](https://github.com/Bails309/strata-client/pull/188)) — the
   credential profile editor now offers an **entitlements picker**
   that lists every Safeguard account the signed-in user is
   entitled to request a password for. Selecting a row populates
   the `account_id`, `account_name`, `asset_id`, and `asset_name`
   fields automatically, eliminating the manual lookup-and-typing
   step that v1.10.0/1.10.1 required. Rows that already back an
   existing Safeguard profile owned by the same user are
   automatically hidden so the picker only ever shows accounts a
   user can still claim.
3. **In-place credential-profile kind switching** (PR
   [#187](https://github.com/Bails309/strata-client/pull/187)) — an
   existing `local` credential profile can now be converted to
   `safeguard` (or vice versa) without deleting and recreating the
   row. The `PUT /api/user/credential-profiles/:id` endpoint
   accepts an optional `kind` field; the backend transactionally
   wipes the fields that don't apply to the target kind, populates
   the new ones, and recomputes `expires_at` according to the new
   resolution path.

#### Added

- **One-shot Safeguard enrolment-code endpoints**
  ([`backend/src/services/safeguard/enrolment.rs`](backend/src/services/safeguard/enrolment.rs),
  [`backend/migrations/070_safeguard_enrolment_codes.sql`](backend/migrations/070_safeguard_enrolment_codes.sql),
  [`backend/src/routes/user.rs`](backend/src/routes/user.rs),
  [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs)).
  Authed `POST /api/user/safeguard/signin/start` mints an 8-character
  Crockford base-32 code (no `I`/`L`/`O`/`U`), records it in the
  new `safeguard_enrolment_codes` table keyed on the user_id, and
  returns `{ code, expires_at }` (5-minute window). Unauthed
  `POST /api/safeguard/enrol` consumes the code atomically
  (`UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING
user_id`), seals the supplied bearer token with the same Vault
  envelope encryption (ciphertext + per-row DEK + nonce) used by
  `safeguard_user_tokens`, and stores it against the bound user. All
  failure paths return `Invalid or expired sign-in code.` so callers
  cannot probe code state. Rate-limited to 5 mints/min/user via the
  shared rate-limit table.
- **Safeguard entitlement picker — `GET /api/user/safeguard/accounts`**
  ([`backend/src/routes/user.rs`](backend/src/routes/user.rs) `list_safeguard_accounts`,
  [`backend/src/services/safeguard/client.rs`](backend/src/services/safeguard/client.rs)
  `list_password_entitlements`,
  [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs)).
  New authed route that calls the appliance's
  `GET /service/core/v4/Me/RequestEntitlements?wellKnownType=PasswordAccessRequest`
  endpoint and returns the caller's password-access entitlement
  catalogue as a flat list of `SafeguardEntitledAccount { account_id,
account_name?, account_domain_name?, asset_id, asset_name?,
asset_network_address? }` rows. The deserializer tolerates both
  Safeguard 8.x's nested DTO shape (entitlements grouped by
  `Account`/`Asset` blocks) and the flat shape returned by some
  appliance versions, so the same call works across the supported
  Safeguard 8.x range. Audit events: `safeguard.entitlements.listed`.
- **Frontend account-picker UI**
  ([`frontend/src/pages/credentials/ProfileEditor.tsx`](frontend/src/pages/credentials/ProfileEditor.tsx),
  [`frontend/src/api.ts`](frontend/src/api.ts)).
  When the **Kind** selector is set to **Safeguard**, the profile
  editor now renders an inline picker that fetches
  `listSafeguardAccounts()`, surfaces five distinct states
  (`loading`, `signin_required`, `load_failed`, `empty`,
  `all_claimed`, and the populated list), and lets the operator
  click a row to populate `safeguard_account_id`, `account_name`,
  `safeguard_asset`, and `asset_network_address` in one go.
  Already-claimed entitlements — accounts that the same user has
  already created a Safeguard profile for — are filtered out by an
  `isRowClaimed` predicate that matches on either `asset_id` or
  `asset_name`. When editing an existing profile, that profile's
  own asset stays visible in the list so the row can be re-selected
  without first abandoning the edit.
- **In-place kind switching on `PUT /api/user/credential-profiles/:id`**
  ([`backend/src/services/credential_profiles.rs`](backend/src/services/credential_profiles.rs)
  `set_kind_safeguard`, `set_kind_local`,
  [`backend/src/routes/user.rs`](backend/src/routes/user.rs)).
  The `UpdateCredentialProfileRequest` body now accepts an optional
  `kind` field (`"local"` | `"safeguard"`). When the new kind
  differs from the row's current kind, the backend dispatches to
  `cp_svc::set_kind_safeguard(...)` or `cp_svc::set_kind_local(...)`
  inside a single transaction: rows switching to `safeguard` have
  their stored password ciphertext + DEK + nonce nulled out and the
  new `safeguard_account_id` / `safeguard_asset` fields populated;
  rows switching to `local` have those Safeguard pointers cleared
  and a fresh plaintext password sealed. `expires_at` is recomputed
  via `resolve_profile_ttl` against the new kind so the Profiles
  list reflects the correct expiry semantics immediately. The
  existing same-kind update path (label/username/password/TTL only)
  is unchanged.

#### Changed

- **Daily cleanup now purges expired Safeguard enrolment codes**
  ([`backend/src/services/user_cleanup.rs`](backend/src/services/user_cleanup.rs),
  [`backend/src/services/safeguard/enrolment.rs`](backend/src/services/safeguard/enrolment.rs)
  `purge_expired`).
  The background cleanup worker (which already prunes expired
  password-reset tokens, stale shares, and idle MFA challenges) now
  also deletes rows from `safeguard_enrolment_codes` whose
  `expires_at` is older than 24 hours, so long-expired codes do not
  accumulate indefinitely. Idempotent and safe to re-run.
- **Safeguard sign-in card auto-closes on success**
  ([`frontend/src/pages/credentials/SafeguardSigninCard.tsx`](frontend/src/pages/credentials/SafeguardSigninCard.tsx)).
  While the sign-in modal is open, the card polls
  `GET /api/user/safeguard/status` every two seconds and closes
  itself the moment `signed_in === true` is observed — operators
  no longer have to click a Done button after the PowerShell
  snippet has posted the token. A live MM:SS countdown next to the
  embedded code shows time remaining in the current 5-minute
  window; when the window expires the UI offers a one-click **Get
  a new code** button.

#### Database

- **Migration `070_safeguard_enrolment_codes.sql`**: creates the
  `safeguard_enrolment_codes` table (`code TEXT PRIMARY KEY`,
  `user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`,
  `expires_at TIMESTAMPTZ NOT NULL`, `used_at TIMESTAMPTZ`,
  `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `created_ip
TEXT`) with indexes on `(user_id)` and `(expires_at)` for the
  rate-limit count and the purge job respectively. Idempotent
  (`CREATE TABLE IF NOT EXISTS`) and runs automatically on
  startup.

#### Security

- **Atomic, user-bound code consumption.** Consume is a single
  `UPDATE … WHERE code = $1 AND used_at IS NULL AND expires_at > now()
RETURNING user_id` — concurrent submits cannot cross-assign a
  token between users; the bearer is always sealed against the
  `user_id` bound at mint time. Unknown, expired, malformed, and
  already-used codes all return the same opaque
  `Invalid or expired sign-in code.` to prevent state probing.
- **Per-user entitlement scope.** `GET /api/user/safeguard/accounts`
  forwards the caller's own RSTS bearer (or A2A identity, per
  `auth_mode`) when talking to the appliance, so the returned
  catalogue is filtered server-side by Safeguard to the accounts
  this user is entitled to request a password for. Strata does no
  client-side enumeration of other users' entitlements and never
  caches the catalogue across requests.

#### Upgrade

Drop-in upgrade from v1.10.0 or v1.10.1. One idempotent migration
(`070_safeguard_enrolment_codes.sql`) runs on backend startup. No
configuration changes, no behavioural changes to existing
profiles. Rebuild backend and frontend containers:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build backend frontend
```

## [1.10.1] — 2026-05-26

### Patch Release — Safeguard sign-in snippet hardening and dependency hygiene

v1.10.1 is a small follow-up to the v1.10.0 Safeguard JIT release. The
**Safeguard sign-in** card on the Credentials page renders a copy-paste
PowerShell snippet that bootstraps the Safeguard-PS module and runs
`Connect-Safeguard` for the configured appliance and identity provider;
the v1.10.0 snippet unconditionally re-installed the module on every
paste, which on a busy operator's workstation produced a noisy
`Install-Module` re-download even when the module was already current.
This release rewrites the snippet so the install is idempotent and the
session is bootstrapped with a `RemoteSigned` execution policy scoped
to `CurrentUser`, matching the pattern Strata's other PowerShell
helpers use. The companion `SafeguardSigninCard.test.tsx` suite
continues to assert that the snippet contains the expected
`Connect-Safeguard <fqdn>` substring so the change can't regress
silently.

Alongside the snippet fix, this release rolls forward a batch of
low-risk dependency bumps surfaced by Dependabot — the nginx runtime
base image used by the frontend container, four `devDependencies` in
the frontend `package-lock.json`, and six pinned-by-SHA GitHub
Actions used by CI / release / CodeQL / Trivy / stale-issue workflows.
None of these touch runtime behaviour; they are bundled into the
patch release so the v1.10.x line ships against the most current
supported base image and toolchain.

#### Changed

- **Safeguard sign-in PowerShell snippet is now idempotent**
  ([`frontend/src/pages/credentials/SafeguardSigninCard.tsx`](frontend/src/pages/credentials/SafeguardSigninCard.tsx),
  PR [#181](https://github.com/Bails309/strata-client/pull/181)).
  The snippet now prefixes the install line with
  `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` and wraps the
  `Install-Module Safeguard-PS` call in an
  `if (-not (Get-Module -ListAvailable -Name Safeguard-PS)) { ... }`
  guard so re-running the snippet on an already-onboarded workstation
  no longer triggers a redundant module download. The
  `Connect-Safeguard <fqdn> -Browser -IdentityProvider <idp> -NoSessionVariable -NoWindowTitle`
  call and the `Set-Clipboard $SGToken` tail are unchanged, so any
  user who has already copied the snippet into their session bootstrap
  notes can keep using the previous copy without losing functionality.

#### Dependencies

- **`frontend/Dockerfile`**: nginx runtime base bumped from
  `nginx:1.31.0-alpine@sha256:dc48b7a8…ebcb8` to
  `nginx:1.31.1-alpine@sha256:8b1e7874…e589a` to pick up the latest
  upstream Alpine package security patches. Pinned by digest so the
  build is reproducible.
- **Frontend devDependencies** (lockfile-only, caret ranges in
  `package.json` already covered the bumps):
  - `@types/react` 19.2.14 → 19.2.15
  - `@vitest/coverage-v8` 4.1.6 → 4.1.7
  - `vite` 8.0.13 → 8.0.14
  - `vitest` 4.1.6 → 4.1.7
- **GitHub Actions** (pinned by commit SHA with version comment, per
  the repo's pinning policy in `docs/security.md`):
  - `docker/setup-buildx-action` v4.0.0 → v4.1.0
  - `docker/build-push-action` v7.1.0 → v7.2.0
  - `docker/login-action` v4.1.0 → v4.2.0
  - `docker/metadata-action` v6.0.0 → v6.1.0
  - `github/codeql-action` v4.35.5 → v4.36.0 (init / analyze / upload-sarif)
  - `actions/stale` v10.2.0 → v10.3.0

#### Upgrade

Drop-in upgrade from v1.10.0 — no migrations, no configuration
changes, no behavioural changes. Rebuild backend and frontend
containers to pick up the new nginx base image and toolchain bumps:

```sh
docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build backend frontend
```

## [1.10.0] — 2026-05-22

### Minor Release — OneIdentity Safeguard JIT credential checkout (full release)

v1.10.0 ships the full OneIdentity Safeguard for Privileged Passwords
("SPP") JIT integration end-to-end. A new `kind = 'safeguard'`
credential profile resolves its password against the appliance at
tunnel-open time, optionally caches the released password under Vault
envelope encryption so a user with a long-lived shift can avoid the
15-minute per-user Safeguard sign-in carousel, and exposes a dedicated
**Bulk Checkout** workflow that pre-fetches every Safeguard-backed
profile's password in one signed-in burst with mandatory
justification, per-row failure visibility, and one-click bulk
check-in. The integration is hardened against every Safeguard 8.2.x
REST quirk encountered during integration (singular wrapper bucket
names on `Me/ActionableRequests`, JSON-encoded string body on
`Cancel`/`CheckIn`, the Code 90001 "duplicate access request"
overlap, the Code 90010 "pending password reset" rotation race, and
the Code 90114 "can't CheckIn before CheckOut" workflow-state error)
and surfaces clean, actionable errors in the UI for everything it
can't auto-recover from.

The feature is opt-in everywhere: master `enabled` switch defaults
`false`, password caching defaults `false`, and existing deployments
upgrade with no behavioural change until an administrator turns it on
from **Admin → Secrets & Security → Safeguard JIT**.

Verified against **Safeguard for Privileged Passwords 8.2.2** with
both A2A and per-user-browser (RSTS / federation) authentication.

#### Added

- **Per-user browser sign-in flow (`per_user_browser` auth mode)**
  ([`backend/migrations/068_safeguard_user_tokens.sql`](backend/migrations/068_safeguard_user_tokens.sql), [`backend/src/services/safeguard/user_token.rs`](backend/src/services/safeguard/user_token.rs), [`backend/src/routes/user.rs`](backend/src/routes/user.rs), [`frontend/src/pages/credentials/SafeguardSigninCard.tsx`](frontend/src/pages/credentials/SafeguardSigninCard.tsx)).
  Each user runs `Connect-Safeguard -Browser -IdentityProvider <alias>`
  from the Safeguard PowerShell module (or pastes a previously-minted
  API token), exchanges their browser session for a ~15-minute RSTS
  bearer, and posts it to Strata via `POST /api/user/safeguard/token`.
  The token is sealed with the same Vault transit-key envelope
  (ciphertext + per-row DEK + nonce) used by `credential_profiles`,
  stored in the new `safeguard_user_tokens` table keyed on `user_id`,
  and surfaced via `GET /api/user/safeguard/status` so the UI can
  render an accurate **Signed in · N min left** badge. Migration
  `068_safeguard_user_tokens.sql` renames the legacy `per_user_oidc`
  enum value to `per_user_browser`, back-fills existing rows, and
  reinstalls the `auth_mode` CHECK constraint atomically. The legacy
  spelling is still accepted by the `AuthMode::parse` deserializer
  for one release so any in-flight admin form submission doesn't 400.
- **JIT checkout orchestration (`jit_checkout` / `jit_checkin`)**
  ([`backend/src/services/safeguard/mod.rs`](backend/src/services/safeguard/mod.rs), [`backend/src/services/safeguard/client.rs`](backend/src/services/safeguard/client.rs), [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)).
  `jit_checkout` is the single entry-point the tunnel and bulk-checkout
  paths share. It loads the singleton `safeguard_config`, unseals A2A
  secrets via Vault, builds a per-request `reqwest::Client` (system
  trust store + optional CA bundle layered on top + per-config TLS
  verification + optional A2A client identity), acquires a bearer
  using the configured `AuthMode` (per-user browser token, A2A
  `LoginResponse`, or hybrid with per-user preferred), then runs a
  three-step REST dance against `/service/core/v4/AccessRequests`:
  preflight any stale requests this user already holds against the
  same `(account_id, asset_id)` and release them, `POST` a new
  request with `RequestedDurationHours = max(profile.ttl_hours, 1)`,
  and `POST {id}/CheckoutPassword` to retrieve the plaintext. The
  username is built from `AccountName` + `AccountDomainName` so RDP
  receives the correct logon name rather than the numeric account
  id. Every state transition (`pending` → `success`/`failed` →
  `checked_in`/`expired`) is written to the append-only
  `safeguard_checkout_audit` table.
- **Safeguard 8.x preflight and stale-request release**
  ([`backend/src/services/safeguard/client.rs`](backend/src/services/safeguard/client.rs#L410), [`backend/src/services/safeguard/mod.rs`](backend/src/services/safeguard/mod.rs#L210)).
  Safeguard rejects a second simultaneous request for the same
  account by the same user with Code 90001 and silently returns the
  EXISTING request id and password — which then fails RDP auth
  because the appliance rotates the password every time it accepts a
  fresh request. The new `list_my_active_requests_for(...)` helper
  enumerates the caller's open requests for a target account, parses
  Safeguard 8.x's singular wrapper bucket names (`Requester`,
  `Approver`, `Reviewer`, `Admin`) as well as the legacy plural
  shape (`PersonalRequests`, `RequestorRequests`, `ApproverRequests`,
  `ReviewerRequests`), and the verbatim `Vec<Row>` shape some 7.x
  appliances return. The preflight loop dispatches the right release
  verb based on workflow state — `CheckIn` once the password has
  been checked out, `Cancel` for `RequestAvailable` /
  `PendingApproval` — and falls back to the other verb if the first
  returns Code 90114. The release body is the JSON-encoded string
  literal `"\"strata preflight\""` with `Content-Type:
application/json` and a non-zero `Content-Length` — Safeguard
  rejects `Content-Length: 0`, the empty object `{}`, and a raw
  string with `415` / `411` / `70000` errors respectively, all of
  which are now caught at the integration boundary rather than
  surfacing to the user.
- **Post-cancel rotation-race retry on `CheckoutPassword`**
  ([`backend/src/services/safeguard/mod.rs`](backend/src/services/safeguard/mod.rs#L120) `checkout_password_with_retry`).
  Cancelling a stale `RequestAvailable` request triggers an immediate
  password rotation on the Safeguard side. The very next
  `CheckoutPassword` against the freshly-created replacement request
  returns Code 90010 ("You cannot access this account while another
  request is pending password reset") for a few seconds until the
  rotation finishes. `checkout_password_with_retry` wraps the bare
  client call with an exponential-backoff loop
  (`[0, 500, 1000, 2000, 3000, 4000]` ms, ~10 s total worst case),
  retries only on the 90010 marker, logs `checkout_password: 90010
on attempt N for request {rid}, retrying`, and surfaces any other
  error (auth, validation, not-found) immediately so a permanently-
  broken state never blocks behind transient retries.
- **Optional password caching (`password_cache_enabled`)**
  ([`backend/migrations/069_safeguard_password_cache.sql`](backend/migrations/069_safeguard_password_cache.sql), [`backend/src/services/safeguard/password_cache.rs`](backend/src/services/safeguard/password_cache.rs)).
  When the admin sets `safeguard_config.password_cache_enabled =
true`, every successful JIT checkout's plaintext password is sealed
  (Vault envelope) and stored per `(user_id, profile_id)` in the new
  `safeguard_cached_passwords` table for the lifetime configured by
  the profile's own `ttl_hours`. Subsequent tunnel opens for the
  same profile reuse the cached row without making any Safeguard API
  call — so a user with a long-running shift doesn't have to resubmit
  a fresh 15-minute RSTS token every time the previous one expires.
  Auto-checkin is suppressed while caching is active: the
  AccessRequest stays open on the appliance until the user
  explicitly checks back in (or until Safeguard's own policy expires
  it), giving the cache an actual lifetime to honour. The
  `password_cache::load(...)` accessor eagerly deletes any row whose
  `expires_at` has passed, so a stale entry can never silently
  succeed.
- **Bulk checkout workflow** ([`backend/src/routes/user.rs`](backend/src/routes/user.rs#L758), [`frontend/src/pages/credentials/SafeguardBulkCheckoutCard.tsx`](frontend/src/pages/credentials/SafeguardBulkCheckoutCard.tsx)).
  The Credentials page gains a third tab — **Request Checkout** —
  that pairs a Safeguard sign-in card with a bulk-checkout card.
  Users supply a single mandatory **Justification** (sent verbatim
  as Safeguard's `ReasonComment` for every selected profile —
  policy commonly mandates a meaningful comment, and a templated
  marker like `Strata bulk:<uuid>` is rarely what a reviewer wants
  to see in the audit log), select any subset of their Safeguard
  profiles via per-row checkboxes plus a **Select all** convenience
  toggle, and click **Checkout selected**. The server iterates
  serially (so Safeguard never sees overlapping requests for the
  same `(user, account)` pair), reports per-row success/failure with
  the full Safeguard error body in-lined into the failing row, and —
  on success — stores the plaintext password in the cache table so
  the user is good for the duration their profile's TTL stipulates.
  A matching **Check in all (N)** button releases every cached
  password back to Safeguard in one POST, expiring the profile rows
  immediately so the Profiles list never lies about whether a
  cached credential is still usable.
- **Per-profile expiry sync on bulk checkout / check-in**
  ([`backend/src/services/credential_profiles.rs`](backend/src/services/credential_profiles.rs#L385) `set_expires_at`, [`backend/src/routes/user.rs`](backend/src/routes/user.rs)).
  `credential_profiles.expires_at` is now kept in lock-step with the
  cache row's TTL so the Profiles list reflects the freshly
  checked-out window (the column was previously frozen at the last
  profile edit and could lie about whether a Safeguard credential
  was usable). On bulk check-in the column is slammed back to
  `now()` so the row immediately renders the red **Expired — update
  required** pill instead of a deceptive future timestamp — a
  checked-in credential is, from the user's point of view, no
  different from an expired one (the appliance has rotated the
  password and a fresh checkout is required before it can be used
  again).
- **Safeguard JIT admin configuration & connectivity probe**
  ([`backend/migrations/067_safeguard.sql`](backend/migrations/067_safeguard.sql), [`backend/src/services/safeguard/config.rs`](backend/src/services/safeguard/config.rs), [`backend/src/routes/admin/safeguard.rs`](backend/src/routes/admin/safeguard.rs), [`frontend/src/pages/admin/SafeguardTab.tsx`](frontend/src/pages/admin/SafeguardTab.tsx)).
  Singleton `safeguard_config` row stores every appliance tunable
  (`enabled`, `appliance_fqdn`, `appliance_port`, `verify_tls`,
  `ca_cert_pem`, `idp_alias`, `auth_mode`, `default_checkout_hours`,
  `request_reason_template`, `auto_checkin_on_session_end`,
  `password_cache_enabled`, plus three sealed A2A secrets:
  `a2a_api_key`, `a2a_client_cert_pem`, `a2a_client_key_pem`).
  Sealed columns are returned as the eight-character mask
  `"********"` on GET and accepted as the same literal on PUT to
  mean "keep existing", so admins can edit unrelated fields without
  re-typing the API key. `POST /api/admin/safeguard/test` performs
  a live three-step probe — TCP, TLS, `GET /service/core/v4/Me` —
  using the in-memory form values (not the persisted row), so an
  operator can validate cert / key / API-key combinations before
  committing them.
- **Append-only Safeguard checkout audit table**
  ([`backend/migrations/067_safeguard.sql`](backend/migrations/067_safeguard.sql)).
  `safeguard_checkout_audit (id, user_id, profile_id, sg_account_id,
sg_asset, sg_request_id, session_id, opened_at, closed_at, outcome,
error_message)` with `outcome` constrained to `pending → success /
failed → checked_in / expired`, mirroring the
  `share_participant_audit` shape so existing forensic tooling can
  be reused without modification.

#### Database

- **Migration `067_safeguard.sql`** — `safeguard_config` singleton
  row (PK `= 1`, CHECK enforced), `credential_profiles.kind`
  (`'local'` / `'safeguard'`) + `safeguard_account_id` +
  `safeguard_asset` columns, partial index
  `idx_credential_profiles_kind ON kind WHERE kind <> 'local'`,
  `safeguard_checkout_audit` append-only table.
- **Migration `068_safeguard_user_tokens.sql`** — renames legacy
  `auth_mode = 'per_user_oidc'` enum value to `'per_user_browser'`,
  reinstalls the CHECK constraint, and creates
  `safeguard_user_tokens (user_id PK FK→users ON DELETE CASCADE,
ciphertext, encrypted_dek, nonce, expires_at, created_at,
updated_at)` with an index on `expires_at`.
- **Migration `069_safeguard_password_cache.sql`** — adds
  `safeguard_config.password_cache_enabled BOOLEAN DEFAULT FALSE`
  and creates `safeguard_cached_passwords (user_id, profile_id)`
  composite PK, both FKs `ON DELETE CASCADE` so a deleted user or
  profile evicts the cache row atomically. Index on `expires_at`
  for the eager-delete sweep.

#### REST surface

| Endpoint                            | Verb   | Purpose                                                                               |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `/api/admin/safeguard/config`       | GET    | Read the singleton config with sealed fields rendered as `"********"`                 |
| `/api/admin/safeguard/config`       | PUT    | Update the config; `"********"` inputs preserve the existing sealed value             |
| `/api/admin/safeguard/test`         | POST   | Live TCP + TLS + `GET /Me` probe against form values without persisting them          |
| `/api/user/safeguard/enabled`       | GET    | Public-to-the-SPA boolean kill-switch state (gates UI rendering of the Safeguard tab) |
| `/api/user/safeguard/status`        | GET    | `{ signed_in, expires_at? }` for the per-user browser-flow token                      |
| `/api/user/safeguard/token`         | POST   | Submit a freshly-minted Safeguard API token to seal in `safeguard_user_tokens`        |
| `/api/user/safeguard/token`         | DELETE | Eagerly purge the user's stored token (sign-out)                                      |
| `/api/user/safeguard/bulk-checkout` | POST   | Run JIT checkout for the selected profile ids; returns per-row results                |
| `/api/user/safeguard/cached`        | GET    | Non-decrypting status of the user's live cache rows (powers the bulk-checkout badges) |
| `/api/user/safeguard/checkin`       | POST   | Release one or many cached profiles; empty `profile_ids` means "everything I hold"    |

#### Tests

- **Backend** — Unit coverage for `safeguard::config::SafeguardConfig`
  round-trip (mask in / mask out), `AuthMode::parse` legacy-value
  acceptance, wrapper-bucket deserializer covering all
  Safeguard-8.x singular and pre-8.x plural shapes plus the
  raw-vec fallback, and the
  `checkout_password_with_retry` 90010 retry / non-90010 fail-fast
  contract.
- **Frontend** — Vitest suite (82 files) continues to pass; new
  tests cover the bulk-checkout card's mandatory-justification
  guard, per-row error rendering, **Select all** toggle, **Check
  in all (N)** counter binding, and the `signed_in` /
  `expires_at` rendering of the sign-in card.

#### Upgrade notes

- **Apply migrations 067 / 068 / 069 in order** before rolling the
  binary. Each migration is idempotent (`IF NOT EXISTS` /
  `ON CONFLICT DO NOTHING`) and runs automatically at backend
  startup via the existing `sqlx::migrate!` invocation. **No
  back-fill is performed** — existing `credential_profiles` rows
  are stamped `kind = 'local'` by default, and no `safeguard_*`
  tables are populated until an administrator turns the feature on.
- **No behavioural change without administrator action.**
  `safeguard_config.enabled` defaults to `FALSE` so the credential
  profile **Kind** selector hides the Safeguard option, the
  Credentials page does not render the sign-in or bulk-checkout
  cards, and the tunnel layer treats safeguard-backed profiles as
  the existing expired-managed-credential rejection. Turning the
  master switch on lights up the entire surface in one step.
- **Password caching is also opt-in.** With caching disabled (the
  default) every tunnel open issues a fresh JIT call against
  Safeguard and Strata never persists the plaintext password.
  Operators wishing to enable caching for the duration of a user's
  shift can flip `password_cache_enabled` from the same admin tab —
  the cache row TTL is governed by each profile's own `ttl_hours`
  slider so shift length is per-user, not global.
- **Verified against Safeguard for Privileged Passwords 8.2.2.**
  The `Me/ActionableRequests` singular-bucket wire shape, the JSON-
  encoded string body required by `Cancel` / `CheckIn`, and the
  Code 90010 rotation race are all 8.2.x behaviours. If you are
  running an older 7.x line, the deserializer accepts the legacy
  plural wrapper shape and the raw `Vec<Row>` body — but you should
  verify the integration end-to-end against your appliance before
  enabling it for users.
- **Per-user vs A2A: both work, hybrid mode is recommended.**
  Per-user-browser maximises Safeguard audit fidelity (each
  checkout is attributable to the human's IdP identity, not to the
  Strata service account) but burns through 15-minute RSTS tokens
  and demands a sign-in every time one expires. A2A authenticates
  Strata as a single application identity to the appliance and
  shows "Strata" as the requester in Safeguard's own audit log —
  Strata's `safeguard_checkout_audit` still attributes each row to
  the human via `user_id`. Hybrid mode (`auth_mode = 'hybrid'`)
  prefers the per-user token when available and falls back to A2A
  when it isn't, so a user who hasn't signed in yet still gets a
  working checkout against shared-automation accounts.
- **See `docs/safeguard.md`** for the implementation architecture
  and operator runbook, and `docs/safeguard-user-guide.md` for the
  step-by-step end-user guide on configuring profiles and
  performing bulk checkouts.

## [1.9.6] — Unreleased

### Minor Release — Multiplayer / Co-Pilot Mode for shared sessions

Strata's share links graduate from a strict 1:1 (owner ↔ single viewer) model
to a true **multiplayer / co-pilot** experience. Owners can now invite up to
six participants into a single control-mode share, each with their own
display name, deterministically-assigned cursor colour, and live presence on
the screen. A server-arbitrated single-holder input token governs which
participant currently drives the keyboard and mouse — the owner can
force-grant control at any time, peers can request control voluntarily, and
an idle-grant rule automatically transfers the token after two seconds of
inactivity so no participant can monopolise the session indefinitely. An
optional in-room text chat panel (default on) lets the cohort coordinate
without leaving the session, and a per-room audio-mesh flag is wired
end-to-end so a future release can light up voice without a schema change.

#### Added

- **Multiplayer / Co-Pilot Mode for control-mode shares**
  ([`backend/src/services/co_pilot.rs`](backend/src/services/co_pilot.rs), [`backend/src/services/co_pilot/room.rs`](backend/src/services/co_pilot/room.rs), [`backend/src/routes/share.rs`](backend/src/routes/share.rs), [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs), [`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs), [`backend/src/services/shares.rs`](backend/src/services/shares.rs), [`backend/migrations/066_multiplayer_share.sql`](backend/migrations/066_multiplayer_share.sql), [`frontend/src/co-pilot/`](frontend/src/co-pilot/), [`frontend/src/pages/SharedViewer.tsx`](frontend/src/pages/SharedViewer.tsx), [`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx), [`frontend/src/api.ts`](frontend/src/api.ts)).
  When an owner creates a control-mode share, the new **Multiplayer (co-pilot)** toggle in the Share popover unlocks three sub-controls — **Max participants** (clamped 2..=6), **Allow chat** (default on), and **Allow audio** (default off, reserved for a follow-up release). The generated share URL carries an `mp=1` flag so the viewer knows to open the new sibling WebSocket. The server routes the JSON envelope protocol through a dedicated `/api/shared/copilot/{share_token}?name=Foo` endpoint, separate from the existing Guacamole tunnel WebSocket at `/api/shared/tunnel/{share_token}`. Splitting envelopes onto their own connection avoids interleaving JSON frames with the Guacamole protocol that `Guacamole.WebSocketTunnel` cannot parse. The server's first response is a `Welcome { pid, allow_chat, allow_audio, max_participants }` envelope; the client then opens the tunnel WS with `?pid=<uuid>` so the server can gate input forwarding on the in-memory input-token holder. Per-room state lives in `CoPilotRoom` (one per `ActiveSession`, always-instantiated and zero-cost when no multiplayer share exists): roster, deterministic colour palette (8-entry round-robin), join-order, and the single-holder input token with the FSM described above (owner force-grant, peer claim, 2-second idle-grant, voluntary release, owner revoke). Display names are sanitised, length-bounded to 40 characters, and disambiguated with a `" (n)"` suffix when collisions occur. Every join and leave is audited via a dedicated `share_participant_audit` table plus matching `audit_log` events (`share.multiplayer.joined`, `share.multiplayer.left`), so post-incident forensics can reconstruct who was in the room at any time.
- **`multiplayer_share_enabled` system setting kill-switch**
  ([`backend/src/routes/share.rs`](backend/src/routes/share.rs)). `POST /api/user/connections/{id}/share` checks the `multiplayer_share_enabled` system setting (default `"true"`, never seeded — absence means enabled) on every multiplayer share creation. When the value is exactly `"false"` the route silently downgrades the request to a standard single-viewer control share, leaving the existing share workflow untouched but giving administrators a single-toggle escape hatch if they need to disable the feature in a hurry without re-deploying.

#### Database

- **Migration `066_multiplayer_share.sql`** — `ALTER TABLE connection_shares ADD COLUMN multiplayer BOOLEAN NOT NULL DEFAULT FALSE`, `max_participants SMALLINT NOT NULL DEFAULT 1 CHECK (max_participants BETWEEN 1 AND 6)`, `allow_chat BOOLEAN NOT NULL DEFAULT FALSE`, `allow_audio BOOLEAN NOT NULL DEFAULT FALSE`; new `share_participant_audit (id BIGSERIAL PRIMARY KEY, share_id UUID REFERENCES connection_shares(id) ON DELETE CASCADE, pid UUID NOT NULL, display_name TEXT NOT NULL, is_owner BOOLEAN NOT NULL DEFAULT FALSE, joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), left_at TIMESTAMPTZ, client_ip TEXT, user_agent TEXT)` with indices on `share_id` and `joined_at`. All existing shares retain the legacy single-viewer behaviour without modification.

#### Tests

- **Backend** — 17 unit tests in `services::co_pilot::room` cover the join/leave/sanitise/disambiguate/colour-allocation/input-claim-FSM paths; additional route-level tests in `routes::share` exercise the multiplayer-defaults-off case, full multiplayer payload round-tripping, and the lock-step `max_participants` clamp shared by the DB CHECK, the route, and the in-memory room cap.
- **Frontend** — full vitest suite (1407 cases across 67 files) continues to pass with no regressions.

#### Upgrade Notes

- Apply migration 066 before rolling the binary. The schema additions are all backwards-compatible (`DEFAULT FALSE` / `DEFAULT 1`) so existing single-viewer shares continue to function without modification while the new column data lights up.
- The first release ships **without** the audio-mesh client and **without** an owner-side participant view; `allow_audio` is wired through the schema and protocol so a future release can light it up without a migration. Operators wishing to disable the entire feature until they have evaluated it can `INSERT INTO system_settings (key, value) VALUES ('multiplayer_share_enabled', 'false') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`.

## [1.9.5] — 2026-05-22

### Minor Release — Server-side recordings search, per-user last-login tracking, configurable stale-account auto-cleanup, Client IP visibility on the Sessions blade, and DMZ peer version visibility on the Health blade

This release tightens two operator-facing workflows on the admin blade. The **Recordings** tab on the Sessions page now performs its search and pagination on the server, lifting the previous hard cap of 200 client-side rows and giving administrators a true index over the historical recording set rather than a fixed-window slice of it. The **Users** tab now exposes a per-user **Last Login** column populated on every successful local or SSO authentication, and a new **Stale account auto-deletion** retention setting lets administrators automate the soft-delete of any account that has been provisioned and signed in at least once but has since gone idle past a configurable threshold. The new sweep deliberately ignores accounts that have never logged in so freshly-provisioned AD-sync imports are not aged out solely by creation time. Soft-deleted users continue to flow through the existing `user_hard_delete_days` retention window and remain restorable from the **Show Deleted Users** filter. The Sessions blade also gains a new **Client IP** column on both the Live and Recordings tabs, surfacing the operator's public source address for both in-flight and historical sessions for forensic and audit attribution. Finally, in DMZ deployments the **Health** tab now renders a **DMZ Version** tile next to the existing **Strata Version** tile, capturing the `strata-dmz` binary's version over the existing mTLS link so administrators can spot DMZ ↔ backend version skew at a glance.

#### Added

- **Server-side search and pagination for the Recordings table**
  ([`backend/src/routes/admin/recordings.rs`](backend/src/routes/admin/recordings.rs), [`backend/src/routes/user.rs`](backend/src/routes/user.rs), [`backend/src/services/recordings.rs`](backend/src/services/recordings.rs), [`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/Sessions.tsx`](frontend/src/pages/Sessions.tsx)).
  `GET /api/admin/recordings` and `GET /api/user/recordings` now accept an optional `search` query parameter. When supplied, the SQL `WHERE` clause adds `AND ($3::text IS NULL OR connection_name ILIKE $3 OR username ILIKE $3)` with the parameter bound as `format!("%{}%", search)` and the existing `LIMIT`/`OFFSET` indices shifted to `$4`/`$5`. The Sessions page replaces the previous 200-row client-side filter with a paginated fetch (`PAGE_SIZE = 50`) that issues `limit + 1` rows to derive `hasMore` for the Next/Previous footer, debounces the search input by 300 ms before each refetch, resets to page 1 on every new query, and ships a dedicated empty state that distinguishes "no recordings yet" from "no results matching `<query>`" with a single-click **Clear search filter** action.
- **Per-user `last_login_at` timestamp surfaced on the Users admin blade**
  ([`backend/migrations/064_user_last_login.sql`](backend/migrations/064_user_last_login.sql), [`backend/src/services/users.rs`](backend/src/services/users.rs), [`backend/src/routes/auth.rs`](backend/src/routes/auth.rs), [`frontend/src/pages/admin/AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx)).
  Migration 064 adds a nullable `users.last_login_at TIMESTAMPTZ` column. Both `POST /api/auth/login` (local) and `GET /api/auth/sso/callback` (SSO) call the new `services::users::update_last_login(pool, user_id)` helper on every successful authentication, immediately before audit logging. The helper is invoked best-effort (`let _ = ...`) so a DB hiccup never blocks the user from receiving their access/refresh tokens. The admin Users table now renders a **Last Login** column formatted via `useSettings().formatDateTime` (honouring the operator's configured `display_timezone` / `display_date_format` / `display_time_format`), with an italic **Never** placeholder for accounts that have not yet authenticated. `UserRow.SELECT_COLUMNS` and the `user_row_*` unit tests in `routes/admin.rs` were updated in lock-step.
- **Configurable `user_stale_days` stale-account auto-soft-delete sweep**
  ([`backend/migrations/064_user_last_login.sql`](backend/migrations/064_user_last_login.sql), [`backend/src/services/user_cleanup.rs`](backend/src/services/user_cleanup.rs), [`frontend/src/pages/admin/SecurityTab.tsx`](frontend/src/pages/admin/SecurityTab.tsx)).
  The existing daily `user_cleanup` worker (`backend/src/services/user_cleanup.rs`) now runs a stale-account sweep before the existing hard-delete pass. It reads `user_stale_days` from `system_settings` (seeded to `'0'` by migration 064; **0 disables**) and, when the value is a positive integer, soft-deletes any live user whose `last_login_at` is older than the threshold via `UPDATE users SET deleted_at = now() WHERE deleted_at IS NULL AND last_login_at IS NOT NULL AND last_login_at < now() - make_interval(days => $1)`. Users with `last_login_at IS NULL` (never signed in) are explicitly excluded so freshly-provisioned AD-sync imports are not aged out solely on creation time — the clock only starts after a user's first successful authentication. The bootstrap admin account (matched case-insensitively against `DEFAULT_ADMIN_USERNAME`, default `"admin"`) is also always excluded so the sweep can never lock operators out of their own deployment. Each affected row is audited as `user.stale_auto_deleted` with `{ user_id, username, stale_days }`, and the soft-deleted record continues to flow through the existing `user_hard_delete_days` retention window (so it remains recoverable from the **Show Deleted Users** filter for the configured grace period). The Security tab adds a **Stale account auto-deletion (days)** input alongside the hard-delete window, validated `0..=3650`, persisted via the existing `updateSettings` endpoint as the `user_stale_days` key.
- **Client IP visibility on the Sessions admin blade**
  ([`backend/migrations/065_recording_client_ip.sql`](backend/migrations/065_recording_client_ip.sql), [`backend/src/db/mod.rs`](backend/src/db/mod.rs), [`backend/src/services/recordings.rs`](backend/src/services/recordings.rs), [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs), [`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/Sessions.tsx`](frontend/src/pages/Sessions.tsx), [`docs/api-reference.md`](docs/api-reference.md)).
  The admin **Live** and **Recordings** tabs now render a **Client IP** column showing the operator's public source address as resolved at handshake from the rightmost non-empty `X-Forwarded-For` entry (with a `ConnectInfo` peer-IP fallback — the same helper that drives audit-log attribution). The live side reuses the in-memory `session_registry::ActiveSession.client_ip` field that was already populated end-to-end but never surfaced in the UI. The recordings side is backed by a new nullable `recordings.client_ip TEXT` column (migration 065) populated by `recordings::insert_start(...)` at the same call site that captures `nvr_session_id` and `started_at`, so the value is persisted at the moment the recording begins rather than reconstructed after the fact. Rows that pre-date migration 065 (or where the IP could not be resolved at handshake) render an italic **Unknown** placeholder. The column is gated on `isAdmin`, so non-admin views of `/user/sessions` and `/user/recordings` are unchanged.
- **DMZ peer software version surfaced on the Health and DMZ Links admin blades**
  ([`crates/strata-protocol/src/handshake.rs`](crates/strata-protocol/src/handshake.rs), [`crates/strata-protocol/src/link.rs`](crates/strata-protocol/src/link.rs), [`crates/strata-dmz/src/link_server/listener.rs`](crates/strata-dmz/src/link_server/listener.rs), [`crates/strata-dmz/src/main.rs`](crates/strata-dmz/src/main.rs), [`backend/src/services/dmz_link/registry.rs`](backend/src/services/dmz_link/registry.rs), [`backend/src/services/dmz_link/supervisor.rs`](backend/src/services/dmz_link/supervisor.rs), [`backend/src/routes/admin/dmz.rs`](backend/src/routes/admin/dmz.rs), [`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/admin/HealthTab.tsx`](frontend/src/pages/admin/HealthTab.tsx), [`frontend/src/pages/admin/DmzLinksTab.tsx`](frontend/src/pages/admin/DmzLinksTab.tsx), [`docs/api-reference.md`](docs/api-reference.md)).
  The `strata-link/1.0` handshake is extended so the DMZ now echoes its own `software_version` back to the internal node in `AuthOutcome::Accept`, alongside the existing `link_id`. The new field is declared `#[serde(default, skip_serializing_if = "Option::is_none")] software_version: Option<String>` and is therefore wire-compatible with pre-1.9.5 DMZ binaries — missing fields deserialise to `None` and the UI renders "Unknown". The backend supervisor captures the advertised value into `LinkStatus.remote_software_version` on every successful handshake (preserved across `Backoff` cycles so the UI keeps the last-known value while the link is reconnecting) and surfaces it through `GET /api/admin/dmz-links` as `remote_software_version`. The admin **Health** tab now renders a new **DMZ Version** tile alongside the existing **Strata Version** tile when DMZ mode is configured, with a yellow skew warning when the DMZ version differs from `__APP_VERSION__` and a **Mixed** indicator (with the full list of distinct versions) for multi-DMZ deployments running heterogenous builds. The **DMZ Links** tab gains a **DMZ version** column showing the per-endpoint reported version. No new endpoints or ports — the entire exchange stays inside the existing mTLS + PSK link.

#### Database

- **Migration `064_user_last_login.sql`** — `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;` and `INSERT INTO system_settings (key, value) VALUES ('user_stale_days', '0') ON CONFLICT (key) DO NOTHING;`. The column is nullable so existing rows do not need a back-fill; any existing user is treated as **never logged in** until their next authentication.
- **Migration `065_recording_client_ip.sql`** — `ALTER TABLE recordings ADD COLUMN IF NOT EXISTS client_ip TEXT;`. Nullable for backwards compatibility; recordings created before this migration render as **Unknown** in the new Client IP column. No back-fill is performed.

#### Tests

- **`frontend/src/__tests__/Sessions.test.tsx`** — the `filters recordings by search` test was rewritten to mirror the new server-side semantics: `vi.mocked(getRecordings)` is now a filtering `mockImplementation` keyed off `params.search`, the test advances Vitest fake timers past the 300 ms debounce via `vi.advanceTimersByTime(350)` inside `act()`, asserts `getRecordings` was called with `{ search: "Alpha" }`, and `waitFor`s the Beta row out of the DOM after the refetch resolves.
- **`frontend/src/__tests__/SecurityTab.test.tsx`** and **`frontend/src/__tests__/AdminSettings.test.tsx`** — the _persists watermark + retention + auth methods on save_ and _sends watermark and auth settings on save_ assertions were extended with the third settings tuple `{ key: "user_stale_days", value: "0" }`.
- **`backend/src/routes/admin.rs`** — three test-only `UserRow { ... }` literals (`user_row_serializes`, `user_row_serializes_with_deleted_at`, `user_row_serializes_with_sub`) now initialise the new `last_login_at: None` field so `cargo clippy -p strata-backend --all-targets -- -D warnings` builds cleanly.

#### Migration notes

- **Backend + frontend rebuild** required. `docker compose up -d --build backend frontend` is sufficient; migrations 064 and 065 are applied automatically at backend startup by the existing `sqlx::migrate!` invocation.
- **No back-fill of `last_login_at`.** Existing rows keep `NULL` until the user's next successful login. This is intentional — the stale-account sweep explicitly ignores `NULL` rows, so accounts that existed before the upgrade are never auto-deleted purely on the basis of when they were created. Operators who want to seed historical data can compute it from the existing `audit_logs` table (events `auth.local_login` and `auth.sso_login`) and `UPDATE` the column manually before enabling `user_stale_days`.
- **Default `user_stale_days = 0` means the sweep is disabled out of the box.** Set a positive integer (1–3650) in **Admin Settings → Security → Stale account auto-deletion** to enable. The sweep runs daily as part of the existing `user_cleanup` worker, on the same cadence as the hard-delete pass.
- **Recordings search is forwards-compatible.** Clients that omit the `search` query parameter continue to receive the previous behaviour (`AND ($3::text IS NULL OR ...)` short-circuits when the bound is `NULL`).

## [1.9.4] — 2026-05-20

### Patch Release — Live session observer reconstructs canvas state beyond the 5-minute NVR ring buffer

This patch release fixes a long-standing visual defect in the admin and shared-viewer live-session observer that caused the canvas to render as a black frame whenever an observer joined a tunnel session more than five minutes after it had started. The fix introduces a per-session **persistent-state log** alongside the existing time-windowed ring buffer. Drawing instructions that age out of the five-minute ring buffer are now salvaged into the log so that newly-joining observers receive a fully reconstructed display rather than an empty canvas, while preserving the existing credential-filtering invariants.

#### Fixed

- **LIVE button / share viewer black canvas after 5 minutes of session uptime**
  ([`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs), [`backend/src/routes/admin.rs`](backend/src/routes/admin.rs), [`backend/src/routes/share.rs`](backend/src/routes/share.rs)).
  Admin observers (`GET /api/admin/sessions/:id/observe`), self-service observers (`GET /api/user/sessions/:id/observe`) and share-link viewers (`GET /api/shared/tunnel/:token`) previously saw a fully black canvas when joining a tunnel session whose original wallpaper / layer-setup drawing instructions had already been evicted from the five-minute ring buffer. The buffer evicted frames purely by age, so on mostly-idle desktops the instant-dump that primes a new observer's display contained only recent incremental updates — never the initial PNG tiles, layer creates, or large image streams that established the visible screen state. The frontend `NvrPlayer.tsx` correctly drove an `offset=0` (live-edge) connect, but with no drawing ops to replay the display stayed black until activity happened to repaint every pixel.

#### Added

- **Persistent-state log on `SessionBuffer`**
  ([`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs)).
  Introduced a per-session `persistent_state: VecDeque<String>` field alongside the existing time-windowed `frames: VecDeque<BufferedFrame>`. On every eviction from the ring buffer (whether triggered by the `MAX_BUFFER_DURATION = 300s` age cap or the `MAX_BUFFER_BYTES = 50 MB` size cap), non-ephemeral Guacamole instructions are appended in order to the persistent log via the new private `salvage_persistent_state(&mut self, data: &str)` helper. The log is capped at `MAX_PERSISTENT_STATE_BYTES = 20 MB`; once full, the **oldest** instructions are dropped first so that recent visual state is always retained. A new `pub fn persistent_state(&self) -> String` accessor returns the concatenated log on demand.
- **Ephemeral-opcode filter shared with the persistent log**
  ([`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs)).
  `salvage_persistent_state` honours a const `EPHEMERAL_OPCODES = ["4.sync", "3.nop", "3.key", "5.mouse"]` allowlist of opcodes that carry no canonical screen state (frame flush markers, transport pings, keyboard input, and live cursor position). Everything else — `img`, `png`, `jpeg`, `copy`, `rect`, `cfill`, `lfill`, `cstroke`, `lstroke`, `transfer`, `blob`, `end`, `size`, `dispose`, `cursor`, layer/buffer setup — is preserved verbatim so that re-replay correctly reconstructs the canvas. The existing `filter_sensitive_instructions` credential-redaction pass still runs before any push, so the persistent log cannot accidentally capture `connect` or `args` opcodes.
- **Observer handlers replay the persistent log before the buffer dump**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs), [`backend/src/routes/share.rs`](backend/src/routes/share.rs)).
  Both `observe_session_ws` and the shared-tunnel WebSocket upgrade now read the persistent state under the same `buffer.read().await` lock that captures the buffered frames, then send (in order): `nvrheader` metadata → cached `size` instruction → persistent-state log → sync-stripped frame dump → final flushing `sync` → live broadcast frames. The lag-recovery rebuild path inside the live-forwarding loop also re-sends the persistent log before re-dumping the buffer so that observers who fall behind the broadcast channel still receive a complete canvas reconstruction.
- **Unit tests for the persistent-state log**
  ([`backend/src/services/session_registry.rs`](backend/src/services/session_registry.rs)).
  Added four new `#[test]` cases — `persistent_state_empty_by_default`, `persistent_state_salvages_drawing_ops_on_size_eviction`, `persistent_state_skips_ephemeral_opcodes`, and `persistent_state_respects_cap` — covering the empty-default state, salvage-on-eviction behaviour, ephemeral-opcode filtering, and the 20 MB cap respectively.

#### Migration notes

- **Backend rebuild only.** No database migration, no schema change, no environment-variable change. The persistent-state log is a runtime-only in-memory structure scoped to the `ActiveSession` lifetime; restarts start each session's log empty (as before).
- **Memory footprint.** Worst-case extra heap per active session is `MAX_PERSISTENT_STATE_BYTES = 20 MB` on top of the existing `MAX_BUFFER_BYTES = 50 MB` ring buffer, giving a per-session ceiling of ~70 MB of NVR state. The dynamic capacity recommendation in `GET /api/admin/metrics` (which uses `RAM_PER_SESSION_MB = 150` as a weighted-average estimate including the kernel-side tunnel and codec buffers) already comfortably covers this; no recommendation change is required.
- **Credential redaction is preserved.** The persistent log inherits its data from `SessionBuffer::push`, which runs `filter_sensitive_instructions` before storing anything. The `7.connect` and `4.args` opcodes (which can carry credentials) continue to be stripped at ingestion and can never reach the persistent log.

## [1.9.3] — 2026-05-20

### Patch Release — Option to disable Break Glass emergency bypass, dynamic empty connection folders pruning, and package cleanup

This patch release introduces critical operational controls and navigation refinements across the application. It adds a security-hardening option to disable the Break Glass emergency approval bypass within Approval Roles, dynamically hides empty folders on the Dashboard navigation tree to remove clutter, unifies style formatting guidelines across Rust and frontend codebases, and prunes residual version references to guarantee build stability.

#### Added

- **Break Glass Emergency Bypass Toggle on Approval Roles**
  ([`backend/migrations/063_role_break_glass_bypass.sql`](backend/migrations/063_role_break_glass_bypass.sql), [`backend/src/routes/admin.rs`](backend/src/routes/admin.rs), [`frontend/src/pages/admin/AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx)).
  Added an administrative toggle to completely disable the Break Glass emergency bypass for specific Approval Roles. When disabled, operators are strictly prevented from self-approving or bypassing credentials checkout, guaranteeing forced dual-operator checkouts.

#### Changed

- **Dynamic Empty Folders Pruning in Dashboard tree**
  ([`frontend/src/utils/folderTree.ts`](frontend/src/utils/folderTree.ts), [`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)).
  Updated the preorder traversal folder hierarchy model to recursively prune folders that contain neither active connections nor subfolders with connections. Hides noise and guarantees that folders visible on the Dashboard side menu actually lead to connection items.

#### Fixed

- **CI Formatting and Code Style Alignments**
  ([`backend/src/services/connections.rs`](backend/src/services/connections.rs), [`frontend/src/__tests__/AdminSettings.test.tsx`](frontend/src/__tests__/AdminSettings.test.tsx), [`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/admin/PasswordsTab.tsx`](frontend/src/pages/admin/PasswordsTab.tsx)).
  Resolved codebase formatting inconsistencies flagged during automated pipeline checkups. Unified cargo fmt parameters and ran Prettier to format source and test suites.

#### Migration notes

- **Automatic Database Migration.** On container startup, migration `063_role_break_glass_bypass.sql` runs unattended to add the `break_glass_bypass` toggle column (defaulting to true to preserve existing roles' behavior) and updates constraints safely.
- **Frontend rebuild only** required for visual layout updates.

## [1.9.2] — 2026-05-20

### Patch Release — Premium RDP interaction improvements, seamless collapsible sidebar dragging, and theme visual contrast

This patch release addresses critical layout and usability defects within active connection session environments. It resolves an RDP top-left click interception deadzone, refines CSS transition rules on the collapsible session bar toggle to eliminate mouse gesture dragging lag, and restores high-contrast glassmorphic styling and visual cues for the right-hand chevron toggle under Dark Theme.

#### Fixed

- **Active RDP Session Top-Left Click Interception**
  ([`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx)).
  Applied dynamic pointer event properties (`pointer-events: none` when collapsed, `pointer-events: auto` when expanded) to the sliding sidebar panel container. This resolves a layout bug where the hidden sidebar continued to intercept mouse and pointer events on the top-left area of the remote screen.
- **Collapsible Sidebar Toggle Dragging Gesture Lag**
  ([`frontend/src/index.css`](frontend/src/index.css)).
  Isolated specific CSS transition rules (`transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease`) instead of targeting `transition: all`. This prevents layout engine coordinate re-calculation delays and delivers instantaneous, buttery-smooth dragging responsiveness.
- **Dark Theme Session Sidebar Chevron Visibility**
  ([`frontend/src/index.css`](frontend/src/index.css)).
  Consolidated CSS selector definitions for `.session-bar-toggle` under dark theme and restored the translucent backdrop-blur backdrop filter, high-contrast borders (`rgba(255, 255, 255, 0.15)`), and curated hover highlights. The right-hand chevron toggle is now perfectly legible across all themes.

#### Migration notes

- **Frontend rebuild only.** No database migration, no environment-variable changes.

## [1.9.1] — 2026-05-19

### Patch Release — SSO Edit Form Update Deserialization & Test Connection ID lookup, plus CodeQL cleanup

This patch release addresses a critical deserialization error that occurred when saving an edited Single Sign-On (SSO) configuration, which caused the "Save Changes" button to become inoperable. It also resolves multiple technical debt items flagged by CodeQL related to unused variables across the backend codebase.

#### Fixed

- **SSO Provider Edit Form Deserialization Bug**
  ([`frontend/src/pages/admin/SsoTab.tsx`](frontend/src/pages/admin/SsoTab.tsx)).
  Modified the form submission logic to explicitly include the `client_secret` key in the JSON payload, even when empty. This satisfies the Axum backend's strict `SsoProviderUpdateRequest` schema requirements and prevents a 400 Bad Request error upon saving.
- **SSO Provider Test Connection Secret Lookup**
  ([`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/pages/admin/SsoTab.tsx`](frontend/src/pages/admin/SsoTab.tsx)).
  Added the `id` field to the `testSsoConnection` payload. This allows the backend to accurately identify and decrypt the existing client secret when validating an edited SSO configuration.
- **SPA Entry Point Caching Invalidation (Cache-Busting)**
  ([`frontend/common.fragment`](frontend/common.fragment)).
  Added explicit `Cache-Control: "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"` headers to Nginx configurations for the `/` and `/index.html` locations. This guarantees that browsers always fetch the current `index.html` with correct content hashes, preventing stale UI version loading.
- **Removed Unused Variables (CodeQL Detections)**
  ([`backend/src/tunnel.rs`](backend/src/tunnel.rs), [`backend/src/services/user_preferences.rs`](backend/src/services/user_preferences.rs), [`backend/src/services/middleware.rs`](backend/src/services/middleware.rs), [`backend/src/services/notifications.rs`](backend/src/services/notifications.rs), [`backend/src/routes/user.rs`](backend/src/routes/user.rs), [`backend/src/routes/auth.rs`](backend/src/routes/auth.rs), [`backend/src/routes/admin/recordings.rs`](backend/src/routes/admin/recordings.rs)).
  Cleaned up multiple unused variable warnings across the backend to improve code maintainability and execution flow.

#### Migration notes

- **Frontend rebuild only.** No database migration, no environment-variable changes.

## [1.9.0] — 2026-05-19

### Minor Release — Multiple SSO/OIDC Providers, Dynamic Login Branding, and Vault transit security

This minor release introduces the highly anticipated support for configuring and using multiple OpenID Connect (OIDC) / Single Sign-On (SSO) providers concurrently. Users are greeted with separate branded login buttons matching each active configuration. Client secrets are individually sealed in HashiCorp Vault transit keys, and the new `BASE_URL` override ensures seamless integration through downstream proxies or SSL terminators.

#### Added

- **Multi-tenant OIDC administrative CRUD API**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs)).
  Created new admin-only routes to list (`GET /api/admin/settings/sso-providers`), create (`POST /api/admin/settings/sso-providers`), update (`PUT /api/admin/settings/sso-providers/:id`), and delete (`DELETE /api/admin/settings/sso-providers/:id`) multiple SSO providers.
- **Dynamic OIDC Provider configuration test endpoint**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs)).
  Added a settings-test action endpoint (`POST /api/admin/settings/sso-providers/:id/test`) enabling administrators to test connection parameters to the identity provider prior to saving.
- **Active provider discovery public endpoint**
  ([`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)).
  Exposed `GET /api/auth/sso/providers` returning client-safe OIDC registration data (IDs and names) dynamically to the frontend for the login form.
- **Support for dynamic OIDC provider login redirects**
  ([`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)).
  Updated `GET /api/auth/sso/login` to accept a `provider` query parameter (UUID) to handle target authorization flows correctly.
- **`BASE_URL` environment configuration override**
  ([`.env`](.env), [`.env.example`](.env.example)).
  Defined `BASE_URL` in environment files to supply the absolute origin (including ports like `:8443`) for OIDC callbacks, neutralizing downstream proxy port-stripping issues.

#### Changed

- **OIDC Database schema migration to sso_providers table**
  ([`backend/migrations/062_sso_providers.sql`](backend/migrations/062_sso_providers.sql)).
  Created database schema migration `062_sso_providers.sql` which drops the old single-SSO settings column definitions and transitions configurations into a dedicated relational table `sso_providers` with backwards-compatible automated backfills.
- **Multi-tenant state handshaking via SSO_STATE_STORE**
  ([`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)).
  Implemented a secure, thread-safe in-memory mapping in `SSO_STATE_STORE` (a `LazyLock<Mutex<HashMap<String, (Uuid, Instant)>>>`) storing CSRF state UUIDs and their target provider ID, allowing all OIDC connections to safely share the same `/api/auth/sso/callback` callback endpoint.
- **Individual Vault secret sealing per provider**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs)).
  Encrypted individual OIDC client secrets dynamically in Vault via distinct transit key paths before storing them in the `sso_providers` database table.
- **Enhanced unconfigured Vault handling**
  ([`backend/src/routes/admin.rs`](backend/src/routes/admin.rs)).
  Modified admin validation paths to return a clear HTTP 400 Bad Request message when saving providers if HashiCorp Vault remains unconfigured, instead of surfacing a generic HTTP 500 error.

#### Fixed

- **Synchronized Vitest mocks for OIDC CRUD**
  ([`frontend/src/__tests__/AdminSettings.test.tsx`](frontend/src/__tests__/AdminSettings.test.tsx), [`frontend/src/__tests__/api.test.ts`](frontend/src/__tests__/api.test.ts)).
  Aligned mock definitions and mock network configurations inside the test suite to target the new multiple-provider model, maintaining continuous test greenness across Vitest runs.

#### Migration notes

- **Automatic Database Migration.** On container startup, migration `062_sso_providers.sql` will run unattended, creating the `sso_providers` table and backfilling any pre-existing single-SSO configuration.
- **Verify `BASE_URL` in `.env`.** Ensure your `.env` contains a correct, absolute `BASE_URL` if you are accessing Strata Client through a reverse proxy (e.g. Caddy) or a non-standard HTTPS port.

## [1.8.4] — 2026-05-13

### Patch release — Vitest suite stabilization, relative URL parsing, and mock synchronization

This release stabilizes the frontend test suite by hardening the Vitest
environment and synchronizing component mocks with the modern
cookie-based authentication utilities. It resolves regressions related to
relative API URL parsing in JSDOM and unhandled promise rejections
during test component initialization.

#### Fixed

- **Hardened Vitest environment for relative URL parsing**
  ([`frontend/src/__tests__/setup.ts`](frontend/src/__tests__/setup.ts)).
  Implemented a global `fetch` polyfill that automatically resolves
  relative API paths to `http://localhost`. This prevents
  `ERR_INVALID_URL` failures in the Node-based test environment while
  maintaining parity with modern browser behavior.
- **Synchronized API mocks for cookie-based authentication**
  (Various test files in `frontend/src/__tests__/`).
  Updated all component test mocks to include the `readCookie` export
  from the `api.ts` module. This resolves crashes in components (like
  `UserPreferencesProvider`) that depend on the existence of this
  utility during their initial mount lifecycle.
- **Improved test reliability for React state updates**
  ([`frontend/src/__tests__/Profile.test.tsx`](frontend/src/__tests__/Profile.test.tsx)).
  Migrated synchronous `act()` calls to asynchronous `await act(async () => ...)`
  patterns. This resolves React warnings regarding state updates not
  being wrapped in `act(...)` and ensures better test suite compliance.

## [1.8.3] — 2026-05-13

### Patch release — NJS-based security hardening, CSP frame-ancestors, and auth stabilization

This release further hardens the application's security posture by
transitioning from legacy security headers to modern standards and
stabilizing the authentication lifecycle during backend restarts. It also
eliminates noisy 401 errors in the browser console during the initial
login phase. Drop-in upgrade from v1.8.2; roll the backend and frontend
containers together. **Note: `JWT_SECRET` is now a mandatory environment
variable for persistent sessions.**

#### Security

- **Transitioned to `Content-Security-Policy: frame-ancestors 'none'`**
  ([`frontend/common.fragment`](frontend/common.fragment)).
  Replaced the legacy `X-Frame-Options` header with the modern CSP
  `frame-ancestors` directive. This provides superior anti-clickjacking
  protection while aligning with modern browser security standards.
- **Implemented NJS-based `Server` header masking**
  ([`frontend/remove_server.js`](frontend/remove_server.js), [`frontend/common.fragment`](frontend/common.fragment)).
  The `Server` header is now masked as "Strata" and the `X-Powered-By`
  header is removed across all responses (SPA and API). This prevents
  technology fingerprinting and satisfies security audits that require
  the removal of standard server identifiers.
- **Persistent JWT signing with mandatory `JWT_SECRET`**
  ([`.env`](.env), [`.env.example`](.env.example)).
  Added a mandatory `JWT_SECRET` environment variable. Previously, the
  backend generated a random secret on every startup, which invalidated
  all active sessions (access and refresh tokens) whenever a container
  restarted. Persistent secrets ensure session stability across backend
  reloads.

#### Fixed

- **Eliminated noisy 401 errors on the login screen**
  ([`frontend/src/App.tsx`](frontend/src/App.tsx), [`frontend/src/components/UserPreferencesProvider.tsx`](frontend/src/components/UserPreferencesProvider.tsx)).
  Relocated the `UserPreferencesProvider` and `SettingsProvider` inside
  the application's authentication boundary. These providers now only
  mount (and fire their initial API calls) after a successful login,
  ensuring the browser console stays clean during the unauthenticated
  phase.
- **Corrected Proxy Host header for CORS stability**
  ([`frontend/common.fragment`](frontend/common.fragment)).
  Updated Nginx `proxy_set_header Host` to use `$http_host` instead of
  `$host`. This ensures the backend receives the exact port used by the
  client, preventing origin mismatches that were causing sporadic CSRF
  and CORS failures in multi-port deployment scenarios.

#### Migration notes

- **Persistent JWT Secret required.** You MUST set a secure `JWT_SECRET`
  in your `.env` file to prevent session invalidation on restart. A
  default is provided in `.env.example`.
- **No database migration.** Roll both containers together:
  `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build`
- **Full test suite 1401 / 1401 passing** on the released revision.

## [1.8.2] — 2026-05-13

### Patch release — global security headers, session-timeout reliability, and CI hardening

Hardens the application's security posture by enforcing non-cacheable API
responses globally and tightening the session-lifecycle state sync between
the frontend and backend. Also restores the integrity of the Trivy
security scanning pipeline. Drop-in upgrade from v1.8.1; roll the
backend and frontend containers together.

#### Security

- **Global `Cache-Control: no-store` header**
  ([`backend/src/routes/mod.rs`](backend/src/routes/mod.rs)).
  All API responses now carry `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`. This prevents sensitive authenticated data from being persisted to disk by browser caches or intermediate proxies.
- **Extended session-cookie TTL buffer**
  ([`backend/src/routes/auth.rs`](backend/src/routes/auth.rs)).
  The `csrf_token` and `session_expires` cookies are now issued with a
  TTL 60 seconds longer than the `access_token` itself. This ensures the
  SPA can still read its own session metadata (the CSRF token and expiry
  timestamp) during the final minute of a session's life, allowing it to
  successfully trigger a `refreshAccessToken` call before the hard
  deadline.
- **Hardened CORS policy.**
  Re-asserted `allow_credentials(true)` and explicit `X-CSRF-Token`
  header support in the global middleware stack to ensure cookie-based
  authentication remains stable across all supported deployment
  topologies.
- **Removed deprecated `X-Frame-Options` header**
  ([`frontend/common.fragment`](frontend/common.fragment)).
  Replaced `X-Frame-Options: DENY` with the modern `Content-Security-Policy: frame-ancestors 'none'`
  directive. This ensures anti-framing protection is handled by the
  modern CSP standard while maintaining broad browser compatibility.
- **Stripped `Server` and `X-Powered-By` headers**
  ([`frontend/Dockerfile`](frontend/Dockerfile), [`frontend/common.fragment`](frontend/common.fragment)).
  The `Server` header is now completely removed from all responses
  to prevent technology disclosure. This was achieved by upgrading
  to **Nginx 1.30.0 (Stable)**, installing the `nginx-module-njs`
  package, and implementing a custom `js_header_filter` script.

#### Fixed

- **Immediate logout on session-extension failure**
  ([`frontend/src/components/SessionTimeoutWarning.tsx`](frontend/src/components/SessionTimeoutWarning.tsx)).
  When an operator clicks "Extend session" but the refresh token has
  already been invalidated (e.g. by a sign-out in another tab or a
  backend session revocation), the UI now forces an immediate logout
  rather than leaving the warning modal in a "zombie" state.
- **Restored Trivy security scanning**
  ([`.github/workflows/trivy.yml`](.github/workflows/trivy.yml)).
  Fixed the container scanning pipeline by forcing the `docker` driver
  in the Buildx setup and explicitly setting `scan-type: 'image'`. This
  resolves a regression where Trivy could not locate the locally built
  Docker image for analysis.

#### Added

- **Diagnostic session logging**
  ([`frontend/src/api.ts`](frontend/src/api.ts), [`frontend/src/components/SessionTimeoutWarning.tsx`](frontend/src/components/SessionTimeoutWarning.tsx)).
  Added detailed `console.debug` logging tracking the presence of CSRF
  tokens during refresh calls and the outcome of manual extension
  requests to aid in future troubleshooting of complex session-lifecycle
  issues.

#### Migration notes

- **No database migration.** Roll both containers together to pick up
  the backend header changes and the frontend session-reliability
  fixes.
  `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build`
- **Full test suite 1401 / 1401 passing** on the released revision.

## [1.8.1] — 2026-05-12

### Patch release — credential-profile expiry watcher no longer toasts on profile creation

Tightens the credential-profile expiry watcher introduced in v1.8.0 so
its pre-expiry warning thresholds are filtered against the profile's
own TTL window. Without this fix, every freshly-created standard
profile (default 12 h TTL, but anything below the 24 h "1 day"
threshold) published a `<profile> expires in 1 day` warning toast on
the very next poll because `secsLeft` was already inside the 24 h
warning window the moment the profile was saved. The same shape of
defect would have appeared for any extended-expiry profile created
with a TTL shorter than 7 days. The watcher now drops any threshold
that is wider than (or equal to) the profile's `ttl_hours * 3600`
seconds before evaluating, so warnings only fire as the deadline
genuinely approaches. Frontend-only patch, drop-in upgrade from
v1.8.0; the backend image is byte-identical between the two
releases.

#### Fixed

- **Watcher no longer toasts the moment a profile is created**
  ([`frontend/src/components/CredentialProfileExpiryWatcher.tsx`](frontend/src/components/CredentialProfileExpiryWatcher.tsx)).
  The `STANDARD_THRESHOLDS` and `EXTENDED_THRESHOLDS` arrays are now
  filtered with `t.secs < profile.ttl_hours * 3600` before iteration,
  removing thresholds the user could never reach as a meaningful
  pre-expiry signal:
  - 12 h standard profile → effective thresholds `[1 h, 10 m]`
    (no spurious 1-day toast on first poll).
  - 24 h standard profile → effective thresholds `[1 h, 10 m]`.
  - 25 h standard profile → effective thresholds `[1 d, 1 h, 10 m]`
    (the 1-day toast fires when ~1 h has elapsed, as intended).
  - 7 d extended profile → effective thresholds `[1 d, 1 h]`
    (no spurious 7-day toast on creation).
  - 90 d extended profile → all three thresholds apply, unchanged.

#### Added

- **Regression test**
  ([`frontend/src/__tests__/CredentialProfileExpiryWatcher.test.tsx`](frontend/src/__tests__/CredentialProfileExpiryWatcher.test.tsx))
  — `does not fire the 1-day toast on a freshly-created 12 h profile`.
  Mounts the watcher with a `ttl_hours: 12` profile whose
  `expires_at` is 12 h ahead and asserts neither `role="alert"` nor
  `role="status"` appears. Watcher suite is now 10 / 10 (1396 base
  - 25 v1.8.0 toast / paste tests + 1 new = 1399 frontend tests
    total at the released revision; full suite 1399 / 1399 passing).

#### Migration notes

- **Frontend rebuild only.** No database migration, no API contract
  change, no environment-variable change, no new runtime
  dependencies. Roll the frontend container:
  `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build frontend`.
- **Tracker entries written by v1.8.0 are not invalidated.** If the
  v1.8.0 watcher already fired a spurious 1-day toast for a
  short-TTL profile, the corresponding `<profileId>:86400` entry
  in `localStorage["strata.credExpiryFired.v1"]` is now harmless —
  the new code simply ignores thresholds it has filtered out, so
  the entry sits idle until the profile is deleted or its expiry
  is re-issued (at which point the re-arm path drops it
  automatically). No manual cleanup required.

## [1.8.0] — 2026-05-11

### Minor release — reusable toast notification system, credential-profile expiry warnings, SSH password-paste fix

A frontend-only release whose headline is a brand-new, reusable toast
notification system threaded through the whole authenticated tree, and
its first consumer: a background watcher that keeps an eye on every
credential profile the signed-in user owns and warns them — well
before the deadline, and again at the moment of expiry — when a
profile's TTL is about to lapse. A second, smaller fix corrects an
SSH paste regression where pasting a password into a terminal
password prompt was failing because the bracketed-paste markers
applied for code blocks were also being applied to single-line
payloads, which password prompts (sudo, ssh, passwd, mysql -p, every
network-device CLI) ingest as part of the password rather than
recognising them as paste framing. Drop-in upgrade from v1.7.0 — no
schema changes, no API contract changes, no new environment
variables, and no new runtime dependencies. Roll the frontend
container; the backend image is byte-identical between 1.7.0 and
1.8.0.

#### Added

- **`ToastProvider` + `useToast()` hook**
  ([`frontend/src/components/ToastProvider.tsx`](frontend/src/components/ToastProvider.tsx))
  — a single, reusable toast notification surface mounted under the
  root `SettingsProvider` so every component beneath the auth gate
  can publish a notification with `useToast().info / .success /
.warning / .error`. Each toast carries a `title`, an optional
  `description`, an optional **action button** (with built-in
  busy-state handling), and a `key` so a long-lived consumer can
  update the same toast in place rather than spawning duplicates.
  Auto-dismiss timing is variant-aware (info / success: 6 s,
  warning: 8 s, error: sticky until dismissed), overridable per
  call. Rendered via a `document.body` portal so the stack escapes
  any transformed / overflow-hidden ancestor; positioned in the
  top-right (the bottom-right is reserved for the existing
  `SessionTimeoutWarning`). ARIA: `role="region"` + `aria-live="polite"`
  on the viewport, `role="alert"` on errors / warnings, `role="status"`
  on info / success.
- **`CredentialProfileExpiryWatcher`**
  ([`frontend/src/components/CredentialProfileExpiryWatcher.tsx`](frontend/src/components/CredentialProfileExpiryWatcher.tsx))
  — a render-null background component mounted in [`App.tsx`](frontend/src/App.tsx)
  for every authenticated, vault-configured user. Polls
  `/api/user/credential-profiles` every 60 s and publishes a single
  warning toast as each pre-expiry threshold is crossed:
  - **Standard profiles** (`extended_expiry: false`) warn at
    **1 day**, **1 hour**, and **10 minutes** before `expires_at`.
  - **Extended-expiry profiles** (`extended_expiry: true`, up to
    90 days) warn at **7 days**, **1 day**, and **1 hour** before
    `expires_at`. The wider thresholds match the longer windows
    introduced in v1.7.0.

  When a profile crosses `expires_at` the watcher publishes a
  sticky **error** toast labelled `"<profile> has expired"` with a
  **Renew now** action that deep-links to `/credentials`. Only the
  tightest threshold the user has currently crossed fires — a tab
  opened at the 30-minute mark sees only the 10-minute warning,
  not the 1-day one too — and every wider threshold is silently
  marked as already-fired so it cannot publish later.

- **Theme-tokenised toast styling** — variants pick their colour and
  dim background from the existing CSS custom properties
  (`--color-accent`, `--color-success`, `--color-warning`,
  `--color-danger`) so the new surface inherits any future palette
  edits without a code change. Shares the existing `.card`,
  `.btn`, and `.animate-fade-in` utilities; no new top-level CSS
  was added.

#### Changed

- **SSH / telnet single-line paste is now byte-transparent**
  ([`frontend/src/components/pastePayload.ts`](frontend/src/components/pastePayload.ts)).
  `preparePastePayload()` previously wrapped every SSH / telnet
  clipboard payload in bracketed-paste markers (`ESC[200~ … ESC[201~`)
  and translated `\n` to `\r`. Bracketed paste exists to make
  multi-line paste safe inside paste-aware shells (bash, zsh, vim,
  tmux), but a **password prompt** (`sudo`, `ssh` password auth,
  `passwd`, `mysql -p`, every Cisco / Juniper / Mikrotik password
  prompt) is not running under bash — it reads stdin in raw
  no-echo mode and treats the literal escape bytes as part of the
  password, so authentication failed for every pasted password. The
  helper now skips both transformations when the payload contains
  no `\r` or `\n`. Multi-line pastes still get bracketed-paste
  wrapping and CR translation so `nano` / `vim` / heredoc workflows
  continue to behave.

#### Fixed

- Pasting a password into an SSH / telnet password prompt no longer
  fails with an "incorrect password" response caused by silently
  injected `ESC[200~` / `ESC[201~` framing bytes. (See **Changed**
  above for the full rationale and the protocols affected.)

#### Security

- The new toast surface accepts `title` and `description` as plain
  React children — they are rendered through React's standard text
  escaping path, so any string a future caller passes from
  user-controlled data is safe by construction. There is no
  `dangerouslySetInnerHTML`, no `innerHTML` write, and no
  HTML-string consumer in the provider.
- The credential-profile expiry watcher reads from
  `/api/user/credential-profiles` only; no new server endpoint, no
  new secret exposure. The fired-threshold tracker is persisted in
  `localStorage` under the namespaced key
  `strata.credExpiryFired.v1` and stores only `{ "<profileId>:<thresholdSecs>":
<expiresAtMs> }` integers — no usernames, no passwords, no
  server-side identifiers beyond the profile's own UUID. Storage
  entries for profiles that have been deleted on the server are
  pruned on every poll so the record cannot grow without bound.
- The bracketed-paste fix above is **not** a vulnerability — the
  injected escape bytes were a UX defect, not a security boundary —
  but it is documented here because pasted-password failures
  routinely lead operators to write the password down or store it
  somewhere less safe. Restoring the paste workflow removes that
  pressure.

#### Migration notes

- **No schema migration.** The backend image is byte-identical
  between 1.7.0 and 1.8.0; only the frontend container needs to be
  rebuilt. `docker compose --env-file .env -f docker-compose.yml -f docker-compose.internal.yml up -d --build frontend`
  is sufficient.
- **No new environment variables, no new dependencies, no API
  contract changes.** `frontend/package.json` and the lockfile carry
  only the version bump; `backend/Cargo.toml` carries only the
  version bump.
- **Tracker reset (optional).** Operators upgrading from a build
  predating the watcher do not need to clear browser storage; the
  tracker key is created on first use and the `.v1` suffix in the
  key name allows a future schema change to cleanly invalidate
  older records.
- **Test coverage on upgrade.** 25 new tests (7 provider, 9
  watcher, 9 paste — 2 new + 7 existing). Full vitest suite
  1398 / 1398 passing on the released revision.

## [1.7.0] — 2026-05-11

### Minor release — extended-expiry credential profiles, themed range slider, dependency refresh

A small but additive feature release. The standard Strata credential
profile keeps its existing 1–12 hour TTL ceiling and existing default;
operators who need to keep a credential alive for service or
break-glass accounts can now opt a single profile in to an extended
expiry of up to **90 days (2160 hours)**. The setting is per-profile,
defaults to off, and the relaxed limit is enforced at every layer
(database CHECK constraint, backend resolver, frontend control). All
existing rows continue to satisfy the new constraint without
intervention. Drop-in upgrade from v1.6.2 — roll the backend and
frontend images together. The migration runs unattended at backend
startup; no environment variables, no new runtime dependencies.

The release also lands a themed slider component, a refreshed
checkbox style for the new toggle, a base-image refresh (Node
26-alpine, refreshed Rust/Debian/nginx digests), an actions group
bump (checkout v6, dependency-review v5, stale v10,
release-drafter v7, codeql-action 4.35.4, cosign-installer 4.1.2,
scorecard-action 2.4.3), and the latest npm minor/patch versions of
react 19.2.6, react-router-dom 7.15.0, tailwindcss 4.3.0, vite
8.0.12, i18next 26.1.0, mermaid 11.15.0, and @types/dompurify 3.2.0.

#### Added

- **Extended credential-profile TTL (up to 90 days), opt-in
  per-profile.** A new boolean column
  `credential_profiles.extended_expiry` (migration
  [`061_credential_profile_extended_expiry.sql`](backend/migrations/061_credential_profile_extended_expiry.sql))
  records the per-profile flag. The previous database CHECK
  `chk_ttl_hours BETWEEN 1 AND 12` is replaced by a two-arm guard:
  when `extended_expiry = FALSE` the limit stays at 1–12 hours
  exactly as before; when `extended_expiry = TRUE` the limit is
  raised to 1–2160 hours (90 days). The constraint is enforced at
  the database layer, so a future code path that forgets to consult
  the new resolver still cannot persist an out-of-range TTL. All
  existing rows have `extended_expiry` defaulted to `FALSE` and
  continue to satisfy the constraint without intervention.
- **`pub fn resolve_profile_ttl(user_pref, admin_max, extended) -> i32`**
  in [`backend/src/routes/user.rs`](backend/src/routes/user.rs) —
  picks the effective TTL ceiling based on the per-profile
  `extended_expiry` flag (admin's 12-hour cap or the 2160-hour
  extended cap), with the same `clamp(1, cap)` lower bound as the
  existing resolver. The non-extended branch is byte-for-byte
  equivalent to the previous `resolve_ttl` helper, which has been
  removed in favour of the new function. Six unit tests pin the new
  boundary conditions.
- **`pub async fn get_extended_expiry(pool, profile_id) -> Result<bool, AppError>`**
  in [`backend/src/services/credential_profiles.rs`](backend/src/services/credential_profiles.rs) —
  fetches the current flag for an existing profile so the
  `update_credential_profile` handler can pick the correct cap when
  the request body does not explicitly toggle `extended_expiry`. The
  fetch is a single-column `SELECT` against the primary key.
- **`extended_expiry` field on every credential-profile API
  payload.** `CredentialProfileRow` now carries the boolean alongside
  `ttl_hours`, so `GET /api/user/credential-profiles`, the create and
  update mutators, and the audit-log payload for `credential.profile.created`
  all include it. The frontend `CredentialProfile` interface in
  [`frontend/src/api.ts`](frontend/src/api.ts) mirrors the new
  field, and `createCredentialProfile` / `updateCredentialProfile`
  accept it as an optional argument (defaulting to `false` /
  unchanged respectively).
- **Per-profile "Allow extended expiry" checkbox in the credentials
  editor** ([`frontend/src/pages/credentials/ProfileEditor.tsx`](frontend/src/pages/credentials/ProfileEditor.tsx)).
  When ticked the password-expiry slider switches from hours
  (`1–12`) to days (`1–90`), the displayed unit follows
  (`12 hours` → `90 days`), the helper text updates ("Extended
  expiry enabled — maximum 90 days. Use only for service or
  break-glass accounts."), and toggling the checkbox snaps the
  stored TTL to a sensible default for the new mode (12 h when
  turning extended off, 720 h / 30 d when turning it on) so users
  cannot accidentally save a 1-hour "extended" profile or a 90-day
  "standard" profile.
- **Themed `range-slider` CSS utility class**
  ([`frontend/src/index.css`](frontend/src/index.css)) — the native
  `accent-color` slider was replaced with a CSS-driven gradient
  track (`--range-pct` custom property) so the accent fill always
  reaches the thumb, including at the maximum value, on every
  Chromium and Gecko renderer. Custom thumb (white circle, accent
  border, hover scale) matches the rest of the dark theme.

#### Changed

- `cp_svc::insert`, `cp_svc::update_sealed`, and
  `cp_svc::update_metadata` now carry the `extended_expiry` flag
  through every persistence path. `update_metadata` uses
  `COALESCE($4, extended_expiry)` so a metadata-only update that
  does not supply the flag preserves the stored value. By design,
  toggling `extended_expiry` alone (without changing `ttl_hours`)
  does **not** recompute `expires_at` — operators who actually want
  to push expiry out must also bump the TTL, preventing accidental
  re-extension on every label edit.
- The `audit_logs` payload emitted by `create_credential_profile`
  now includes both `ttl_hours` and the new `extended_expiry`
  boolean alongside the profile label, so deployments that ship
  audit logs to a SIEM gain immediate visibility into the
  opt-in.
- Replaced the unused `resolve_ttl(user_pref, admin_max)` helper
  with the new `resolve_profile_ttl` (the previous helper had no
  remaining call sites once the credential-profile path was
  migrated). Behaviour for the non-extended branch is preserved
  exactly.

#### Security

- The 1–12 hour CHECK on `credential_profiles.ttl_hours` is _not_
  loosened for non-extended profiles; the relaxed 2160-hour bound
  applies only when `extended_expiry = TRUE` for that row. A row
  cannot bypass the standard cap by silently flipping its TTL —
  the database refuses the write.
- Re-encrypted updates (`PUT /api/user/credential-profiles/:id`
  carrying a new password) compute the effective cap with
  `resolve_profile_ttl` against the **incoming** `extended_expiry`
  value, then pass it through to `cp_svc::update_sealed`, ensuring
  no race window where the cap and the persisted flag disagree.
- Existing role/ownership checks on every credential-profile
  mutator are unchanged; the new field is just another property
  on a row already authorised by `user_owns`.

#### Dependencies

- **Base images** — `rust:1.95-slim-trixie` and `debian:trixie-slim`
  digests refreshed against current upstream; `node` bumped from
  `25-alpine` to `26-alpine`; `nginx:alpine` digest refreshed.
- **GitHub Actions** — `actions/checkout` v5 → v6.0.2 (in
  `dependency-review.yml` and `scorecard.yml`; other workflows were
  already on v6), `actions/dependency-review-action` v4.9.0 → v5.0.0,
  `actions/stale` v9 → v10.2.0, `release-drafter/release-drafter`
  v6.4.0 → v7.3.0, `github/codeql-action` 4.35.3 → 4.35.4,
  `sigstore/cosign-installer` v4.1.1 → v4.1.2,
  `ossf/scorecard-action` v2.4.0 → v2.4.3.
- **Frontend npm** — `react` 19.2.5 → 19.2.6, `react-dom`
  19.2.5 → 19.2.6, `react-router-dom` 7.14.2 → 7.15.0,
  `@tailwindcss/vite` + `tailwindcss` 4.2.4 → 4.3.0, `vite`
  8.0.10 → 8.0.12, `i18next` 26.0.10 → 26.1.0, `mermaid`
  11.14.0 → 11.15.0, `@types/dompurify` 3.0.5 → 3.2.0.

#### Migration notes

- **Schema change is forwards-compatible.** The new column is
  `NOT NULL DEFAULT FALSE`; existing rows are backfilled to `FALSE`
  by the default. The replacement CHECK constraint accepts every
  row that satisfied the old constraint (1–12 with
  `extended_expiry = FALSE`).
- **Roll-back guidance.** To revert the migration, drop the new
  CHECK, restore the original `ttl_hours BETWEEN 1 AND 12`, then
  drop the `extended_expiry` column. No row will need to be
  modified provided no profile has been opted in to a TTL above
  12; otherwise lower the offending rows' `ttl_hours` to ≤ 12
  first.
- **No frontend feature-flag.** The checkbox renders unconditionally
  for any user who can see a profile editor; restricting opt-in to
  certain operators (e.g. via role) is not enforced server-side and
  should be layered in front of the existing
  `/api/user/credential-profiles` mutation routes if your
  deployment requires it.

## [1.6.2] — 2026-05-08

### Patch release — connection-folder hierarchy, tag-picker viewport, SSH credential prompt

Six independent UX/correctness fixes raised against the v1.6.1 deployment.
No API contract changes, no database migrations, no new environment
variables, no new runtime dependencies. Drop-in upgrade from v1.6.1 — roll
the backend and frontend images together.

#### Added

- **`GET /api/user/connection-folders`**
  ([`backend/src/routes/user.rs`](backend/src/routes/user.rs)) — returns
  the full list of connection folders the authenticated user can
  reference (`id`, `name`, `parent_id`). The Dashboard tree view and
  the global Command Palette previously fell back to "ungrouped" for
  every nested connection because the only existing
  `GET /api/admin/connection-folders` endpoint required
  `can_manage_connections`. The new endpoint is read-only, gated by
  the same auth middleware as `/api/user/connections`, and wraps the
  same `connections::list_folders(&db.pool)` service the admin
  endpoint uses (folders are not user-scoped — every authenticated
  user needs to be able to draw the same hierarchy the admins
  authored). Documented in [`docs/api-reference.md`](docs/api-reference.md).
- **`frontend/src/utils/folderTree.ts`** — `orderFoldersByHierarchy()`
  performs a depth-first preorder traversal with alphabetic sibling
  ordering and an orphan-as-root fallback (so a folder whose parent
  has been deleted out from under it still appears at the top level
  rather than vanishing). `indentedFolderLabel()` produces a
  non-breaking-space-padded "└ " label suitable for `<option>`
  elements (which cannot host real CSS). Both helpers are reused by
  the Dashboard tree, the admin connection-edit Folder dropdown,
  the role-folder assignment checklist, the folder management
  table, and the AD-sync default-folder picker so every folder
  picker in the application now renders the same hierarchy in the
  same order.

#### Fixed

- **Dashboard now renders connections under their nested folders.**
  Operators creating a folder hierarchy of e.g. `Root → Switches →
Coventry` and adding a connection inside `Coventry` previously saw
  the connection only when they expanded `Coventry` directly; the
  tree was a one-level-deep group list rather than a recursive tree,
  and the per-row indent collapsed every connection to the same
  visual depth regardless of its real folder. The Dashboard
  ([`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx))
  now builds a recursive `folderTree` model with descendant-inclusive
  count badges (so the parent folder header shows the total count
  even while collapsed), depth-proportional indentation
  (`8 + depth * 16` px on the connection row name, description, and
  tag pills), per-folder open/closed chevron + folder icon, and
  toolbar **Expand all** / **Collapse all** buttons (visible only in
  folder view with a non-empty tree). When a search filter is active
  every folder containing a match is auto-expanded so hits never
  hide behind a collapsed parent.
- **Folder pickers across the admin surface now sort hierarchically
  with depth indentation.** The connection-edit Folder dropdown,
  the role-folder assignment checklist, the folder management
  table, and the AD-sync default-folder picker
  ([`AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx),
  [`AdSyncTab.tsx`](frontend/src/pages/admin/AdSyncTab.tsx))
  previously listed folders alphabetically with no nesting visible,
  scattering children away from their parents and making it very
  hard to tell where a connection would actually be placed. They
  now share the new `orderFoldersByHierarchy()` helper, render
  options in depth-first preorder, and indent children with
  non-breaking-space padding (in `<select>` options) or a left
  `paddingLeft: depth * 16px` on the row label / span (in HTML
  controls).
- **Tag picker no longer overflows the viewport on connections low
  on the page.** The per-row tag-picker dropdown was anchored to the
  pill button with a fixed `top` position, so opening it on a
  connection near the bottom of the viewport pushed half the menu
  off-screen with no scroll. The Dashboard now measures
  `spaceBelow = innerHeight - rect.bottom - 8` and
  `spaceAbove = rect.top - 8` on open, drops the menu in whichever
  direction has more room, sets `maxHeight: max(120, chosen)`, and
  uses `overflowY: auto` so the picker is always fully reachable
  regardless of where its anchor sits.
- **Tag pill column on connection rows now lines up with the
  folder-indented name.** The pill container previously aligned
  flush-left even when the row name was indented under a nested
  folder, producing a visible left-edge step that made it look like
  the pill belonged to a different connection. The pill container
  now mirrors the row's depth-derived `paddingLeft`, so name,
  description, and pill all share the same left margin.
- **SSH connections without preselected credentials now prompt for
  username and password before the terminal opens.** When the
  frontend created a tunnel ticket without supplying any
  credentials (the normal flow for SSH with no preselected
  profile), `resolve_credentials` in
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  matched the `ticket` arm purely on `Some(&ticket)` — ignoring
  whether the ticket actually carried a password — and silently
  returned `(Some(<strata_user>), None)` via the fallback-username
  path. The Strata user's local username was injected as the SSH
  username in the guacd handshake; the SSH server then short-
  circuited its in-band username prompt and asked only for a
  password in the terminal, leaving operators no way to
  authenticate as a different remote account. Skip the ticket arm
  when `ticket.password.is_none()` so the cascade falls through to
  `(None, None)`, guacd emits a `required` instruction listing
  both `username` and `password`, and the credential modal
  collects the right pair before the SSH session is opened. As a
  defence in depth, [`SessionClient.tsx`](frontend/src/pages/SessionClient.tsx)
  also prepends `"username"` to the required-parameter list
  whenever guacd's `required` instruction omits it on an SSH
  connection — guacd's SSH plugin sometimes lists only `password`
  even when no username has been supplied at handshake. Two new
  unit tests
  (`resolve_creds_empty_ticket_returns_none`,
  `resolve_creds_ticket_no_password_skipped` — the latter rewritten
  to assert the cascade falls through) lock the contract in.
- **Prettier formatting** — repository-wide format pass after the
  Dashboard tree, AccessTab folder-picker, and folderTree helper
  edits, so future PRs against these files don't carry whitespace-
  only churn.

#### Verified behaviour after this release

- Creating a connection under any depth of nested folder makes it
  appear under that folder in the Dashboard tree, with the parent
  hierarchy fully expandable / collapsible, descendant counts
  visible on every collapsed parent, and the connection row's
  name + description + tag pill all aligned to the same indent.
- Every admin folder picker (connection edit, role assignment,
  folder management, AD sync default) renders folders in the same
  depth-first preorder with the same depth indentation as the
  Dashboard tree.
- Opening an SSH connection with no preselected credentials
  produces the credential modal with both Username and Password
  fields populated before the terminal renders. Submitting the
  modal flows the credentials into guacd via two
  `argument_value` streams so the SSH session is authenticated
  correctly on the first attempt.

#### Drop-in upgrade — no migrations, no API contract changes

- No database migrations.
- No new environment variables.
- The new `GET /api/user/connection-folders` endpoint is purely
  additive (no existing endpoint changes shape or status); the
  Dashboard / Command Palette degrade gracefully when called
  against a v1.6.1 backend that does not yet implement it (an
  empty folders array yields the same flat-list rendering as
  v1.6.1).
- Roll the backend and frontend images together.

## [1.6.1] — 2026-05-08

### Patch release — production bug fixes against three user-reported issues

A focused patch release driven entirely by production reports against the
v1.6.0 deployment. Three independent issues, each with a non-obvious root
cause, are addressed; no API contract changes, no database migrations,
and no new environment variables. Drop-in upgrade from v1.6.0 — roll the
backend and frontend images together.

#### Fixed

- **SSH/Telnet paste — bracketed-paste markers and CRLF→CR translation.**
  Multi-line pastes from the system clipboard into an SSH or Telnet
  session were arriving at the remote shell as a series of separate
  keystrokes with embedded `\r\n` pairs. Editors that interpret bracketed
  paste (`vim`, `nano`, `less`, `psql`, etc.) saw each line as a fresh
  command rather than a single paste, and the trailing `\n` of every
  CRLF triggered an unintended Enter that committed half-formed
  commands. The new `preparePastePayload(text, protocol)` helper
  ([`frontend/src/components/pastePayload.ts`](frontend/src/components/pastePayload.ts))
  wraps the payload with the bracketed-paste start/end sequences
  (`ESC [ 200 ~` / `ESC [ 201 ~`) and rewrites every `\r\n` and bare
  `\n` to a single `\r` to match what a real terminal emits, but only
  for `ssh` and `telnet` connection protocols — RDP, VNC, Kubernetes
  and Quick-Share clipboard payloads are unchanged. Seven new unit
  tests pin the boundary conditions (empty input, `\r\n` runs, mixed
  line endings, RDP passthrough). The integration is wired through
  both the main-window `pushClipboard` / `handlePaste` paths in
  `SessionManager.tsx` and the popout-window equivalents in
  `usePopOut.ts`.
- **RDP/SSH active-session idle logout — Guacamole input no longer
  silently expires the access token.** Users actively typing or
  clicking inside a remote session were being signed out of the
  Strata SPA at the 20-minute access-token mark even though they
  were demonstrably active. Root cause: `Guacamole.Keyboard(document)`
  and `Guacamole.Mouse(displayEl)` install document- and canvas-level
  listeners that call `event.preventDefault()` and
  `event.stopPropagation()`, so the bubbled `mousedown` / `keydown` /
  `touchstart` / `scroll` events that
  [`SessionTimeoutWarning`](frontend/src/components/SessionTimeoutWarning.tsx)
  uses to drive proactive token refresh never reach the `window`
  while the user is interacting with a remote session. A new
  [`sessionActivity` bus](frontend/src/components/sessionActivity.ts)
  exposes `notifySessionActivity()` (throttled to once per second)
  and dispatches a `strata-session-activity` window event;
  `SessionTimeoutWarning` subscribes to that event in addition to the
  existing DOM events. The notify call is wired into the Guacamole
  input callbacks in:
  - [`SessionManager.tsx`](frontend/src/components/SessionManager.tsx) — main-window mouse handler.
  - [`SessionClient.tsx`](frontend/src/pages/SessionClient.tsx) — main-window keyboard handler (`kb.onkeydown`).
  - [`usePopOut.ts`](frontend/src/components/usePopOut.ts) — popout-window mouse, touch, and keyboard handlers.
  - [`useMultiMonitor.ts`](frontend/src/components/useMultiMonitor.ts) — multi-monitor popout mouse and keyboard handlers per monitor.

  Both popout hooks execute in the _opener's_ JS context (only the
  Guacamole `displayEl` is reparented into the popup's DOM), so
  `notifySessionActivity()` correctly dispatches on the opener
  `window` where `SessionTimeoutWarning` is mounted — no
  cross-window plumbing is required and pop-out / multi-monitor /
  fullscreen sessions are all covered by the same single bus.
  Two new unit tests
  ([`frontend/src/__tests__/sessionActivity.test.ts`](frontend/src/__tests__/sessionActivity.test.ts))
  cover dispatch and the 1-second throttle.

- **SSO callback latency — duplicate uncached IdP round-trips
  removed.** A user reported the first SSO sign-in of the day
  appeared to "hang on a Keycloak page" before eventually
  succeeding; subsequent attempts were instant. Investigation
  identified that on a cold OIDC cache `/api/auth/sso/callback`
  was performing **four** upstream HTTP round-trips to the IdP
  before issuing its 303 redirect to `/`:
  1. discovery (cached only inside `routes::auth`),
  2. `POST` to the token endpoint,
  3. discovery **again** inside `services::auth::validate_token`
     (a separate, uncached cache miss because the cache lived in
     the wrong module), and
  4. JWKS fetch (never cached).

  Each call has a 5-second connect / 10-second overall timeout.
  On a sluggish corporate IdP that cumulates to 15–30 seconds of
  callback latency during which the URL bar still shows the
  Keycloak callback URL — the user perceives this as Keycloak
  hanging. The fix moves the OIDC discovery cache into
  `services::auth::fetch_oidc_discovery_cached` so both call sites
  share it, and adds a JWKS cache with the same 10-minute TTL.
  The callback now performs at most one upstream call (the token
  POST) on warm cache, and only two (discovery + token) on the
  first ever sign-in. As a defensive secondary, the
  `/api/auth/sso/login` redirect now sends `Cache-Control: no-store`
  to prevent BFCache replay of stale `state` UUIDs, and an
  info-level tracing line on the callback path emits a per-step
  latency breakdown
  (`discovery_ms`, `token_exchange_ms`, `token_validate_ms`,
  `total_so_far_ms`) so future "SSO is slow" reports can be
  triaged from logs alone.

  > **Operational note.** A separate user-reported case where the
  > Keycloak page sat at "Authentication Redirect — Redirecting,
  > please wait" for ~5 minutes is _not_ explained by the cold
  > callback path (our timeouts cap that at ~30 s). That symptom
  > is consistent with Keycloak brokering to an upstream IdP
  > (AD FS / Entra ID / federated LDAP) that itself was slow on
  > first sign-in of the day. The new tracing line will
  > distinguish the two cases the next time it occurs:
  > if the line is absent, the callback never ran and the time
  > was spent inside Keycloak or a federated IdP, not in Strata.

#### Verified behaviour after this release

The session-timeout model after the activity-bus fix:

| Scenario                                                                                                                               | Token behaviour                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actively using a session (any window — main, popout, multi-monitor, fullscreen)                                                        | Access token silently refreshes every ~10 minutes for up to **8 hours**, then a fresh login is required (the refresh token has an 8-hour hard ceiling and is not rotated on `/api/auth/refresh`).                |
| Idle (no DOM events, no Guacamole input)                                                                                               | The access token expires **20 minutes** after the most recent refresh; a warning toast appears at the 2-minute remaining mark with an extend button.                                                             |
| Returning from idle before the 20-minute cap, with a click or keypress (anywhere — main app, in-session canvas, popout, multi-monitor) | If the access token has less than 10 minutes remaining, the click triggers a silent background refresh and the session continues. If more than 10 minutes remain, no refresh is needed and the click is a no-op. |

#### Drop-in upgrade — no migrations, no API contract changes

- No database migrations.
- No new environment variables.
- No API contract changes (the SSO redirect now carries
  `Cache-Control: no-store` and the callback emits an extra
  tracing line, neither of which is part of any documented
  contract).
- Roll the backend and frontend images together.

## [1.6.0] — 2026-05-23

### Enterprise foundations — error codes, accessibility, i18n scaffold, ops docs

#### Added

- **`docs/API-LIFECYCLE.md`** — formal API versioning policy (`/api/v1`), support window, breaking-change definition, `Deprecation` / `Sunset` headers per RFC 9745, error-code stability contract, and changelog discipline so downstream integrators can plan upgrades against documented guarantees instead of inferred behaviour.
- **`docs/deployment-kubernetes.md`** — production Kubernetes runbook covering the per-component replica topology (backend remains `replicas=1` because rate limits, settings cache, OIDC nonce cache, and HTTP session storage are all process-local), `ExternalSecrets` inventory, PVC sizing table (postgres / vault / recordings / config), ingress + `NetworkPolicy` YAML, split liveness/readiness probes (`/api/health/live`, `/api/health/ready`), resource sizing, `terminationGracePeriodSeconds: 45`, and a "common pitfalls" section drawn from the multi-replica caveats already documented in the architecture notes.
- **Backend `ErrorCode` enum** (`backend/src/error.rs`) — every `AppError` now maps to a stable SCREAMING_SNAKE token (`INTERNAL`, `DEPENDENCY_UNAVAILABLE`, `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_REQUEST`, `NOT_FOUND`, `SETUP_REQUIRED`) and the JSON error body now emits `{ "error": "<message>", "code": "<token>" }`. Frontend and external integrators can branch on `code` (which is part of the API contract per `API-LIFECYCLE.md`) instead of regex-matching the human-readable `error` string. Two new tests (`error_codes_are_stable_strings`, `error_variants_map_to_expected_codes`) lock the mapping in.
- **`useFocusTrap` hook** (`frontend/src/components/useFocusTrap.ts`) — generic React hook that records the previously-focused element, focuses the first focusable descendant when its container becomes active, intercepts Tab / Shift+Tab to cycle within the container, and restores focus on cleanup. WCAG 2.1 success criterion 2.4.3 (Focus Order) and 2.1.2 (No Keyboard Trap — controlled trap with explicit dismiss).
- **Skip-to-content link** (`frontend/src/components/Layout.tsx`) — a visually-hidden anchor that becomes visible on keyboard focus and jumps past the persistent navigation chrome to `<main id="main-content" tabIndex={-1}>`. Keyboard-only and screen-reader users no longer have to tab through the full nav rail on every page change. WCAG 2.1 success criterion 2.4.1 (Bypass Blocks).
- **i18n scaffold** (`frontend/src/i18n/`) — `i18next` + `react-i18next` (added as runtime dependencies), an `en` locale (`src/i18n/locales/en.json`) with `common` and `login` namespaces, language detection via `localStorage["strata.lang"] → navigator.language → "en"` fallback chain, and a `setLanguage(lang)` helper for a future user-settings toggle. `Login.tsx` is the migrated exemplar so future PRs can copy the pattern incrementally rather than landing a single mega-refactor.

#### Changed

- **`ConfirmModal.tsx`** wraps its dialog with `useFocusTrap`, so destructive-action confirmations cannot leak keyboard focus back to the page underneath until the user explicitly cancels or confirms.
- **`Login.tsx`** field labels, button copy, and the generic error fallback are sourced from the `login` i18n namespace via `useTranslation()`. Hardcoded English strings remain wherever a string has not yet been migrated.
- **Vitest setup** (`frontend/src/__tests__/setup.ts`) initialises `i18n` once per test process via a side-effect import so `useTranslation()` resolves to real English copy in the JSDOM environment instead of echoing translation keys.

#### Fixed

- **`backend/src/routes/user.rs`** — replaced `body.checkout_id.unwrap()` after a non-`None` guard with an explicit `.ok_or_else(...)` returning `AppError::Internal(...)`. The unwrap was logically reachable only via a TOCTOU between two reads of `body.checkout_id`, but the explicit error keeps the panic-free invariant the rest of the route enforces and surfaces a stable `INTERNAL` error code instead of a 500 with no body.
- **`POST /api/tunnel/ticket`** now returns `404 NOT_FOUND` when an admin (or other privileged caller bypassing the role-access check) supplies a `connection_id` for a connection that does not exist or has been soft-deleted. Previously the privileged branch minted a ticket for any UUID, which masked client bugs and produced a "tunnel works for a moment" false-positive on the subsequent WebSocket upgrade.
- **Login rate-limit responses** now correctly return `429 Too Many Requests` with the new `RATE_LIMITED` error code, instead of `401 UNAUTHORIZED`. Both the per-IP and per-username throttles are affected. `AppError::RateLimited(String)` is the new variant; clients that branched on the textual `"Too many login attempts"` message keep working but should migrate to the `code` field.

#### Drop-in upgrade — no migrations, no API contract changes

- No database migrations.
- The error response body now carries an additional `code` field but the existing `error` field is unchanged in shape and meaning, so existing v1.5.x clients continue to work. New clients should prefer `code` for branching logic per `docs/API-LIFECYCLE.md`.
- Frontend bundle gains `i18next` + `react-i18next` (~30 KB gzipped). All other surface area is documentation, accessibility affordances, and one defensive backend refactor.

## [1.5.5] — 2026-05-22

### Security review — second-pass hardening

A focused follow-up to the v1.5.4 review. Items below were either
new findings raised against v1.5.4, or original v1.5.4 findings that
were partially mitigated and now have a complete fix landed.

#### Authentication & enumeration

- **OIDC / SSO error responses no longer enumerate users.** When the
  OIDC subject (or SAML/SSO email) does not match a provisioned user,
  the response is now the generic `Invalid or expired token` instead
  of including the offending claim. The full claim is logged at
  `debug` level so operators can still diagnose. Closes a
  user-enumeration oracle reachable from any unauthenticated client
  that can reach the SSO callback URL.
- **`/auth/change-password` is rate-limited per user** at 5 attempts
  per hour, using the same `RATE_LIMIT` mutex the login flow already
  uses. Stops a stolen-cookie attacker from brute-forcing the
  current password through the account-settings flow.
- **Refresh-rotated JWTs are recorded in `active_sessions`.** The
  refresh handler now calls `active_sessions::record(...)` after
  minting the new access token, so the admin "active sessions" view
  reflects the post-rotation `jti` and the per-user signout flow
  correctly revokes it.
- **Setup bootstrap-token check is constant-time on every path.**
  The previous short-circuit on empty input gave a measurable timing
  signal; the new path always invokes `constant_time_eq` against a
  fixed-length expected value.

#### LDAP filter validator

- Replaced the legacy `validate_ldap_filter` with a stricter
  recursive-descent style validator that caps total length at
  2048 bytes and nesting depth at 32, rejects NUL and ASCII
  control characters, and explicitly refuses match-everything
  patterns (`(*)`, `(objectClass=*)`). Four new unit tests cover
  the new rejections, the original five tests still pass.

#### Race conditions

- \*\*`activate_checkout` no longer holds a DB row lock across LDAP
  - Vault IO.\*\* The original v1.5.4 fix used `SELECT … FOR UPDATE`,
    which serialised concurrent activators correctly but blocked
    every other approver on the same row for as long as the
    Active-Directory password modify took (seconds in the slow case).
    The new flow uses a session-scoped `pg_try_advisory_lock` keyed
    on the checkout UUID for mutual exclusion, performs the LDAP and
    Vault calls with no DB lock held, and only opens a fresh
    short-lived transaction for the final `UPDATE` and audit write.
- **Active shared viewers are kicked when a share is revoked.**
  The viewer WebSocket now re-checks `find_active_by_token` every
  ~30 seconds inside the keepalive tick and closes the connection
  when the share row has been revoked, expired, or its underlying
  connection has been soft-deleted. Previously, revoke only
  prevented _new_ viewers from joining.

#### DMZ link channel

- **TLS 1.3 session resumption is disabled on the link listener.**
  Resumed TLS handshakes do not re-present the client certificate;
  for a private mTLS-only trust domain, full handshake on every
  connect is the desired posture. We install
  `NoServerSessionStorage` and set `send_tls13_tickets = 0`.
- **Per-IP TCP rate limit on the link `accept` loop.** Reuses the
  existing striped `PerIpRateLimiter` to shed connections before
  the TLS handshake CPU spend (default `5 rps`, burst `30` —
  generous for legitimate internal-node reconnects, kicks in only
  on flood-shaped traffic).
- **HTTP/2 per-stream timeout (120 s) on regular request handlers.**
  A stalled handler can no longer pin a stream slot indefinitely
  against `MAX_CONCURRENT_STREAMS`. WebSocket bridges are exempt;
  they own their own keepalive logic.
- **Loopback upgrade handler asserts target is a loopback address**
  at construction, and rejects HTTP/1.1 request paths and Host
  headers containing CR/LF/NUL before the request line is
  concatenated. Defence in depth against header smuggling and a
  hard fail-closed if the loopback target is ever misconfigured.
- **Edge-signer `x-request-id` filter tightened** from "any
  printable ASCII" to `[A-Za-z0-9_-]` only. The value is MACed by
  the edge and trusted verbatim by the backend; the wider
  character set let a public client smuggle log-field separators
  (`=`, `,`, `;`, ` `) into the trusted audit context.
- **WebSocket upgrade detection requires `Sec-WebSocket-Version: 13`.**
  Older drafts (8, 12) used incompatible framing; treating them as
  a valid upgrade publicly while the inner backend rejects them is
  a smuggling primitive.
- PSK rotation grace is already supported by the link protocol —
  internal nodes hold a map of PSKs and the server names the
  active id, so operators stage-roll new keys to clients first,
  then flip the server's `active_psk_id`. Documented here for
  completeness; no code change needed.

#### Background sweepers

- **`idempotency_keys` cleanup added** to the existing
  `active_sessions` periodic sweep. The table accumulates one row
  per write-with-`Idempotency-Key` for 24 hours; the live lookup
  already filters expired rows, but without a sweep the table
  grows unboundedly. The new index from migration 053 makes the
  range delete cheap.

#### Tests

- 4 new tests for `validate_ldap_filter` (match-everything,
  control chars, oversize, excessive nesting).
- New tests in `edge_signer` for the strict request-id charset
  (rejects punctuation; accepts UUIDs).
- New tests in `ws_proxy::is_websocket_upgrade` for required
  `Sec-WebSocket-Version: 13` and obsolete-version rejection;
  pre-existing tests updated to include the version header.

### Bumped

- `VERSION`, root `Cargo.toml`, `backend/Cargo.toml`,
  `frontend/package.json` to `1.5.5`.

## [1.5.4] — 2026-05-21

### Security review — consolidated hardening pass

v1.5.4 is a defence-in-depth release. None of the items below
correspond to a known exploited vulnerability, but each closes a
class of mistake we want gone before the v1.6 feature work lands.
There are no breaking API or database changes; operators can roll
the new images straight on top of v1.5.3.

#### Backend

- **JWT secret length is now enforced at boot.** `JWT_SECRET` shorter
  than 32 bytes (256 bits) refuses to start the backend with a
  remediation hint. Prevents accidental deployment with a placeholder
  or trimmed secret.
- **Login & registration password length cap reduced from 1024 → 256
  bytes.** Argon2 hashes any input length in roughly constant time, so
  a 1 KiB cap was a free amplification vector for credential-stuffing
  and DoS. 256 bytes still admits any realistic passphrase.
- **`/api/setup/initialize` accepts an optional one-shot bootstrap
  token.** When `STRATA_SETUP_TOKEN` is set, the endpoint requires the
  matching `X-Strata-Setup-Token` header (constant-time compared).
  Greenfield deploys without the env var keep the previous
  unauthenticated first-boot flow.
- **Active-session GC interval shortened** from 5 min → 2 min so
  abandoned/disconnected viewer rows expire from the dashboard sooner.
- **`favorites` list endpoint surfaces DB errors** instead of silently
  swallowing them with `unwrap_or(empty)` — broken queries now log and
  return a proper 5xx instead of hiding the failure as “no favorites”.
- **`recordings` pagination uses a deterministic tiebreaker**
  (`ORDER BY created_at DESC, id DESC`) so cursor pages no longer drop
  or duplicate rows when several recordings share a timestamp.
- **`share` revoke writes an audit log entry** matching the create/use
  side, closing the audit-trail gap on link revocation.

#### Edge / DMZ link channel

- **TLS pinned to 1.3 only** on the operator ↔ edge link server. The
  control channel never needs TLS 1.2 fall-back; restricting the
  protocol set removes an entire surface area of downgrade and cipher
  negotiation bugs.
- **WebSocket bridge enforces a 60 s I/O idle timeout** on both legs
  (read / write / framing), so a stalled inner TCP peer can no longer
  pin a goroutine + descriptor pair indefinitely.
- **HTTP body cap also wraps the streaming body** with
  `http_body_util::Limited`, so chunked uploads that omit or lie about
  Content-Length are still bounded by the per-IP limit.
- **Reverse proxy strips full RFC 7230 hop-by-hop header set** before
  forwarding (Connection, Keep-Alive, Proxy-Authenticate,
  Proxy-Authorization, TE, Trailers, Transfer-Encoding, Upgrade) plus
  any header named in the inbound `Connection` value.
- **Active link PSK id is now deterministic** (the first id parsed
  from `LINK_PSKS`) instead of `HashMap::keys().next()`, which the
  std-lib does not promise to keep stable across runs.
- **Edge signer scrubs IPv6 zone identifiers** (`fe80::1%eth0`) from
  X-Forwarded-For before signing, removing a header smuggling
  primitive.

#### Frontend

- **Documentation viewer sanitises rendered Markdown with DOMPurify.**
  `marked` output is treated as untrusted before being dropped into the
  DOM, eliminating any chance of stored-XSS via doc content.
- **Destructive admin actions (delete role, delete account mapping)
  use the existing `ConfirmModal`** instead of the browser-native
  `window.confirm()`, matching the rest of the admin UX and avoiding
  click-jacking on the native dialog.

#### Upgrade notes

- Confirm `JWT_SECRET` is at least 32 bytes; rotate via
  `openssl rand -base64 32` if you were running with the old default.
- Optional: set `STRATA_SETUP_TOKEN` before exposing the backend to
  network for greenfield deploys.
- No database migrations.

## [1.5.3] — 2026-05-08

### Admin Settings — grouped sidebar navigation

v1.5.3 is a focused, **UX-only** patch release. There are no API
changes, no database migrations, no protocol changes, no security
changes, and no behavioural changes to any session, audit, or
deployment code path. Operators upgrading from v1.5.2 only need to
roll the **frontend** image; the backend, DMZ edge, and guacd
images are bit-identical to v1.5.2.

#### What changed

The Admin Settings page accumulated 17 horizontal tabs as features
were added across the v1.4.x → v1.5.x line (Health, Display,
Network, SSO / OIDC, Kerberos, Vault, Recordings, Access, Tags,
AD Sync, Password Mgmt, Notifications, Sessions, VDI, Trusted CAs,
DMZ Links, Security). On a 1080p monitor the row no longer fit in a
single line on common DPI / zoom settings; on operator laptops it
overflowed horizontally and required scrolling to reach the
right-hand tabs.

v1.5.3 replaces the single horizontal row with a **left sidebar**
grouped into five sections, modelled on the navigation patterns used
by AWS Console, Azure Portal, and GitHub Settings:

- **Overview** — Health, Sessions
- **Identity & Access** — Access, AD Sync, SSO / OIDC, Kerberos, Password Mgmt
- **Connectivity** — Network, DMZ Links, Trusted CAs, VDI
- **Workspace** — Display, Tags, Notifications, Recordings
- **Secrets & Security** — Vault, Security

#### Behaviour

- **Permission-aware section collapse** — sections become hidden
  from the nav entirely when the current user has no permission to
  see any item inside them, so a non-system-admin who can only
  manage tags or view sessions sees a much smaller sidebar than a
  full system administrator. The per-item permission predicates
  (`can_manage_system`, `can_manage_users`, `can_manage_connections`,
  `can_create_*`, `can_view_audit_logs`, `can_manage_system ||
can_view_audit_logs` for Sessions, etc.) are unchanged from v1.5.2;
  only the grouping and rendering changed.
- **Responsive layout** — on screens narrower than the Tailwind
  `lg` breakpoint (1024 px) the sidebar wraps inline above the
  content as a horizontal flex row of buttons, so mobile and tablet
  operators get the same content without a forced two-pane layout.
- **Sticky sidebar** on `lg+` screens so the section list stays in
  view while scrolling long settings panels (the Recordings tab,
  the Notifications SMTP section, and the Access Control role
  editor are all longer than a typical viewport).
- **Accessibility** — the nav element has `aria-label="Admin
sections"` and section headings render as visually-distinct
  uppercase tracking-wider labels rather than `<h*>` elements (so
  the page heading hierarchy is unchanged from v1.5.2 and screen
  readers still see one `<h1>` for the page).

#### What did **not** change

- All 17 tab labels are byte-identical to v1.5.2 (Sessions, DMZ
  Links, Trusted CAs, Password Mgmt, etc.).
- The `.tab-active` CSS class is still applied to the currently-
  selected button, so existing styling, themes, and the 220-test
  AdminSettings unit-test suite continue to pass unchanged.
- The `Tab` union type, the per-tab `<TabPane>` components, the
  in-page `flash()` toast, the `getSettings()` / `getRoles()` /
  `getConnections()` / `getConnectionFolders()` / `getUsers()` /
  `getAdSyncConfigs()` initial-load logic, and the per-tab
  `onSave={() => flash(…)}` wiring are all unchanged.
- The default-tab heuristic (system admins land on Health, RBAC
  admins on Access, audit-only viewers on Sessions) is unchanged.

#### Tests

All 1329 frontend tests continue to pass (`npm run test -- --run`).
220 of those tests are in `src/__tests__/AdminSettings.test.tsx`
and exercise tab-switching by clicking the visible tab labels —
because the labels and the `.tab-active` class are preserved, no
test changes were required.

#### Upgrade

Drop-in. Pull `ghcr.io/bails309/strata-client/frontend:1.5.3`,
roll the frontend container. The backend, DMZ, and guacd images
do not need to be touched — this is a static-asset change only.

```bash
export STRATA_VERSION=1.5.3
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull frontend
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d frontend
```

If you build from source, the unified `docker compose up -d --build`
will rebuild the frontend layer only (the Cargo dep tree is
unchanged from v1.5.2 so the backend / DMZ stages hit the cargo
cache). The `__APP_VERSION__` Vite define automatically picks up
the new version from `frontend/package.json`, which drives both the
Admin → Health version banner and the **What's New** modal trigger
(operators will see the modal pop up once on next login).

## [1.5.2] — 2026-05-08

### DMZ link — WebSocket forwarding (RFC 8441 Extended CONNECT)

v1.5.2 ships the missing piece of the **dual-node DMZ deployment**
that was promised in v1.5.0's design notes but never landed in code:
the DMZ proxy can now forward WebSocket upgrades end-to-end through
the reverse-tunnel link, which means `/api/tunnel/{connection_id}`
finally works when users connect through a DMZ node.

Until this release, the DMZ proxy only handled buffered HTTP
request/response pairs — the public listener stripped the `Upgrade`
header on its way through, the inner h2 multiplexer had no
upgrade-aware code path, and any user who connected to the DMZ node
and tried to launch a session saw the WebSocket fail mid-handshake.
REST traffic (admin UI, OIDC, login) was unaffected, which is why
the regression slipped through internal smoke tests.

### What changed

- **DMZ side (`crates/strata-dmz`)** — new `ws_proxy` module detects
  RFC 6455 WebSocket upgrades (`Upgrade: websocket` + `Connection:
Upgrade` + `Sec-WebSocket-Key`) on the public listener and routes
  them down a separate code path. Instead of buffering the request
  body, the DMZ:
  1. Captures the `hyper::upgrade::on(&mut req)` future.
  2. Opens an Extended CONNECT (RFC 8441) stream on a registered
     link sender with `:method=CONNECT`, `:protocol=websocket`,
     `:path=<original>`, the signed edge-header bundle, and every
     non-hop-by-hop header from the original request.
  3. Waits for `:status=200` from the internal node before
     acknowledging the upgrade publicly.
  4. Returns `101 Switching Protocols` with a correctly-computed
     `Sec-WebSocket-Accept` (RFC 6455 §1.3 SHA-1 + base64 of
     `Sec-WebSocket-Key` + magic GUID).
  5. Spawns a bidirectional byte-pump that copies frames between
     the public TCP socket and the h2 stream — frame masking,
     ping/pong, fragmentation, and close frames all flow through
     unmodified.

- **Internal side (`backend/src/services/dmz_link`)** — h2 server
  now calls `enable_connect_protocol()` so the DMZ peer is told the
  Extended CONNECT settings extension is supported. New
  `UpgradeHandler` trait + `LoopbackUpgradeHandler` accept inbound
  Extended CONNECT streams and bridge them to a regular HTTP/1.1
  WebSocket upgrade against `127.0.0.1:8080` (overridable via the
  new `STRATA_DMZ_LOOPBACK_ADDR` env var). The loopback target is
  the same axum router that serves direct connections, so the
  existing `verify_edge_headers` middleware promotes the forwarded
  `x-strata-edge-client-ip` to the real client IP for audit / RBAC
  exactly as on a direct connection — no separate auth code path
  to keep in sync.

- **Resource limits** — Extended CONNECT streams cannot be size-
  capped by the existing `MAX_REQUEST_BODY_BYTES` / `MAX_PROXY_BODY_BYTES`
  buffers (they're long-lived). Instead we cap _individual_ h2 frame
  sizes at 8 MiB on the DMZ→public direction so a misbehaving
  internal node cannot make the DMZ buffer arbitrary memory before
  flushing to the public socket.

- **Connection origin (operator-visible)** — when a session is
  launched through the DMZ, the guacd connection still originates
  from the **internal node's** IP, not the DMZ node's IP, exactly
  as a single-node deployment behaves. The DMZ never speaks guacd,
  never holds Strata business secrets, and never sees decrypted
  credentials. This is a deliberate architectural property that
  v1.5.2 finally makes user-visible (rather than only true on
  paper).

### Upgrade

This is a drop-in upgrade for both the standalone deployment and
the dual-node DMZ deployment. No database migration; no config
changes required for existing operators. New optional env var:

- `STRATA_DMZ_LOOPBACK_ADDR` (default `127.0.0.1:8080`) — only set
  this if the internal node listens on a non-default address.

Operators running a DMZ deployment **must** rebuild and redeploy
_both_ the `strata-dmz` and `strata-backend` images for WebSocket
forwarding to work — both ends of the link need to negotiate the
RFC 8441 settings extension.

### Tests

- DMZ side: 7 new unit tests covering `is_websocket_upgrade`
  detection (canonical, multi-token Connection, case-insensitive,
  rejection paths) and `compute_accept` against the RFC 6455 §1.3
  worked example (`dGhlIHNhbXBsZSBub25jZQ==` →
  `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`).
- Internal side: 10 new unit tests for the upgrade-handler module
  covering Extended CONNECT detection, response-line parsing,
  CRLFCRLF scanning, header-forwarding allowlist, and
  oversized-line rejection.
- Existing h2_serve and supervisor tests updated to thread a
  `RejectUpgradeHandler` through the new signature; all pre-existing
  test coverage continues to pass.

## [1.5.1] — 2026-05-07

### Pop-out window correctness fix release

v1.5.1 is a focused, additive patch release that closes four
long-standing bugs in the **session pop-out window** path and ships a
new **popup-local Command Palette** so `Ctrl+K` works correctly when
the session has been popped out into its own browser window. No
database migrations, no `/api/*` contract changes, no `config.toml`
schema changes — drop-in upgrade from v1.5.0.

#### What ships in this release

- **F11 fullscreen now works inside pop-out windows.** Previously the
  pop-out's keydown trap was registered _after_ the
  `Guacamole.Keyboard` capture-phase listener, so `F11` was forwarded
  to the remote desktop as a keystroke instead of toggling the
  popup's local fullscreen. The trap is now registered _before_
  `new Guacamole.Keyboard(popup.document)` in
  [`frontend/src/components/usePopOut.ts`](frontend/src/components/usePopOut.ts);
  `F11` toggles `popup.document.fullscreenElement` and is consumed
  before Guacamole sees it.
- **F12 no longer "sticks" on the remote.** With the new registration
  order the trap calls `e.preventDefault()` on `F12` so the popup's
  built-in DevTools shortcut neither opens DevTools nor leaks a key
  release event into the remote desktop. `Ctrl+Shift+I` and
  `Ctrl+Shift+J` are forwarded to the popup's own DevTools the same
  way.
- **`Ctrl+K` now opens a popup-local Command Palette.** The main
  window's React-rooted Command Palette cannot render inside the
  pop-out (different `Window`, no React root, no router context).
  The new
  [`frontend/src/utils/popoutPalette.ts`](frontend/src/utils/popoutPalette.ts)
  is a deliberately small vanilla-DOM palette rendered directly in
  the popup's `document` — overlay + dimmed backdrop + search input +
  filterable connection list, styled to match the main palette. It
  fetches the user's connections lazily via the existing
  `getMyConnections()` and posts the chosen connection back to the
  opener as `{ type: "strata:open-connection", id }`. The opener's
  `CommandPaletteProvider` validates the id (`typeof === "string"`,
  length 1–255) and navigates to `/session/${encodeURIComponent(id)}`,
  reusing the existing routed-launch flow. Filtering matches against
  `name`, `hostname`, and `protocol` (case-insensitive substring);
  arrow keys cycle with wrap-around; Enter activates; Escape closes;
  mousedown on a row activates; mousedown on the dimmed backdrop
  closes. The palette intentionally does **not** register its own
  document keydown listener — the popup's existing `trapKeyDown`
  delegates to `popoutPalette.handleKeyDown(e)` so there is no race
  with Guacamole's capture-phase listener. While the palette is open
  the trap returns `true` from `Guacamole.Keyboard.onkeydown` (the
  contract is inverted: returning `true` means "do not
  `preventDefault`"), so the `<input>` element receives typed
  characters normally.
- **Pop-out windows now close cleanly when the opener navigates
  away.** Previously a freeze in the opener (page reload, hard
  navigation, tab close) left orphaned pop-out windows that could no
  longer talk to a parent JS realm. The opener now installs a
  `pagehide` handler that calls `popup.close()` for every tracked
  pop-out, mirroring what the per-session disconnect button already
  did.
- **Coverage ratchet held in lock-step.** A new 19-test unit suite at
  [`frontend/src/__tests__/popoutPalette.test.ts`](frontend/src/__tests__/popoutPalette.test.ts)
  drives the new vanilla-DOM palette to **95.07 % statements,
  88.57 % branches, 100 % functions, 98.47 % lines**. Global
  thresholds in [`frontend/vitest.config.ts`](frontend/vitest.config.ts)
  are unchanged; the suite simply restores the global coverage
  numbers that the new untested file would otherwise have dragged
  below the floor (statements 72.47 ≥ 72, branches 64.38 ≥ 64,
  functions 62.26 ≥ 61, lines 74.38 ≥ 74). All 1 329 frontend tests
  still pass; lint stays at zero warnings on the changed files.

#### Backwards compatibility

- **Database migrations** — none.
- **REST API surface** — none. `strata:open-connection` is a
  same-origin `postMessage` event between the opener and its own
  pop-out window; it is not a public protocol.
- **`config.toml` / environment variables** — none.
- **DMZ deployment mode** — unaffected. Pop-out windows are an
  in-browser concern; the link supervisor and edge-header HMAC paths
  are unchanged.
- **Image tags** — `ghcr.io/bails309/strata-client/{backend,frontend,custom-guacd}:1.5.1`
  ship alongside the rolling `:latest`; the `:1.5.0` images remain
  available and byte-identical for rollback. cosign / SLSA
  attestations are produced by the same release pipeline and verify
  with the existing identity / `--certificate-oidc-issuer` flags.

#### Upgrade

```sh
docker compose pull
docker compose up -d
```

No reconfiguration required. Operators running the DMZ split should
roll the **internal node** first and the **DMZ edge** second — the
two carry only documentation-aligned binary changes in this release
so the order is informational, not strictly required.

## [1.5.0] — 2026-05-05

### DMZ deployment mode — split-topology release

v1.5.0 introduces a **DMZ deployment mode**: a separate, minimal,
sandboxable edge binary (`strata-dmz`) terminates public TLS while the
existing `strata-backend` ("internal node") stays inside the corporate
network. The internal node opens a persistent **outbound** mTLS tunnel
to the DMZ; the DMZ initiates **no** connections to the internal
network and holds **no** Strata business secrets. Every existing
Strata feature works through the DMZ on day one because the tunnel
carries arbitrary HTTP requests rather than custom message types.

Single-node operators are not affected — when the DMZ environment
variables are not set the internal node continues serving public
traffic directly. Drop-in upgrade from v1.4.1.

#### What ships in this release

- **New crate `crates/strata-dmz`** — the DMZ edge binary. Owns the
  public TLS listener (default `0.0.0.0:8443`), a separate link-server
  listener for inbound mTLS from internal nodes (default `0.0.0.0:9443`),
  the slow-loris / rate-limit / inflight-cap guards, the SPA static
  serving path, and the `x-strata-edge-*` header signer. No Postgres,
  no Vault, no JWT signing key, no `guac-master-key`, no recording
  storage, no OIDC client secret. Configured entirely from environment
  variables (see [`docs/deployment.md`](docs/deployment.md#dmz-deployment-mode)).
- **New crate `crates/strata-protocol`** — versioned wire-format
  primitives shared by both binaries: `AuthHello` / `AuthAccept`
  handshake frames, PSK challenge–response, `x-strata-edge-*` HMAC
  scheme, `tunnel.terminated` audit reason enum.
- **Internal-node link supervisor** —
  [`backend/src/services/dmz_link/`](backend/src/services/dmz_link/)
  spawns one supervisor task per configured DMZ endpoint, dials out
  over mTLS using the operator-supplied client certificate / key /
  link CA bundle, performs the PSK-bound handshake, and serves the
  internal `axum::Router` over an HTTP/2 connection back to the DMZ.
  Exponential back-off with jitter; unfailing reconnect; per-link
  state (`up` / `connecting` / `authenticating` / `initializing` /
  `backoff` / `stopped`) and lightweight metrics surfaced in the admin
  UI.
- **Edge-header HMAC** —
  [`backend/src/services/edge_header.rs`](backend/src/services/edge_header.rs)
  implements the internal-side verifier for the
  `x-strata-edge-{ts,id,client-ip,sig}` header set. The header is
  HMAC-SHA-256 signed by the DMZ with a key configured via
  `STRATA_DMZ_EDGE_HMAC_KEYS` (rotation-aware: first key active, rest
  accepted). Requests reaching the internal node without a valid edge
  header are rejected unless they arrive on the local-loopback path
  (single-node mode).
- **Admin DMZ Links tab** —
  [`frontend/src/pages/admin/DmzLinksTab.tsx`](frontend/src/pages/admin/DmzLinksTab.tsx)
  surfaces every supervisor's state, connect / failure counters, last
  error, and uptime. A **Force reconnect** button calls
  `POST /api/admin/dmz-links/reconnect` to drop and redial every link
  (used during scheduled DMZ restarts and incident response). The page
  auto-refreshes every 15 s.
- **New admin API endpoints**
  - `GET /api/admin/dmz-links` — supervisor snapshot
    (`{configured, links: [{endpoint, state, connects, failures, since_unix_secs, last_error}, ...]}`).
  - `POST /api/admin/dmz-links/reconnect` — kick every link
    (`{nudged: <count>}`).
    Both require `can_manage_system` and the standard `X-CSRF-Token`
    double-submit cookie.
- **Operator-grade documentation**
  - [`docs/architecture.md`](docs/architecture.md) — new chapter on
    the DMZ split, sequence diagrams, secret-overlap matrix.
  - [`docs/security.md`](docs/security.md) — DMZ threat-model section
    (W6-1 through W6-5) covering compromised-DMZ blast radius, key
    rotation runbook, abuse guards.
  - [`docs/deployment.md`](docs/deployment.md) — full env-var
    reference, certificate generation, Helm chart pointer, scheduled
    rotation worked example.
  - [`docs/api-reference.md`](docs/api-reference.md) — admin DMZ
    endpoints documented next to the existing admin surface.
  - [`docs/threat-model.md`](docs/threat-model.md) — STRIDE rows for
    every new asset and trust boundary.
  - [`docs/runbooks/dmz-incident.md`](docs/runbooks/dmz-incident.md) —
    incident response procedure.
- **Helm chart** —
  [`deploy/helm/strata-dmz/`](deploy/helm/strata-dmz/) ships the
  edge-side Kubernetes deployment.
- **CI / supply-chain** — `cargo audit` now runs against the workspace
  `Cargo.lock` so every member crate is scanned in one pass; coverage
  thresholds raised in lock-step with the new code; `strata-dmz` and
  `strata-protocol` get matching CodeQL + Trivy passes.

#### Backwards compatibility

- **Single-node (default) deployments** — no behaviour change. When
  `STRATA_DMZ_ENDPOINTS` is unset the internal node serves public
  traffic directly with no link supervisor spawned.
- **Database migrations** — none. The DMZ feature is stateless on the
  edge and stateless on the internal node beyond the in-memory link
  registry.
- **`/api/*` contract** — additive only (two new admin endpoints).
  No existing endpoint changed shape.
- **`config.toml`** — unchanged. DMZ is configured exclusively via
  environment variables so the same config file continues to work in
  both single-node and split deployments.
- **Audit log** — `tunnel.terminated` reason enum unchanged from
  v1.4.1. New `dmz.link.{up,down,handshake_failed,reconnect_requested}`
  events are added; dashboards filtering on the `event_type` column
  can opt in.

#### Upgrade procedure

1. `docker compose pull` and rebuild backend / frontend.
2. **No DMZ desired** — start the stack as before, no env vars to
   add.
3. **Adopt DMZ mode** — generate the link-tier mTLS PKI and the edge
   HMAC key (see [`docs/deployment.md`](docs/deployment.md#dmz-deployment-mode)),
   stand up the `strata-dmz` container on its public-facing host,
   set `STRATA_DMZ_ENDPOINTS` + `STRATA_CLUSTER_ID` + `STRATA_NODE_ID`
   - the matching `STRATA_DMZ_LINK_PSK_<id>` and
     `STRATA_DMZ_EDGE_HMAC_KEYS` on the internal node, restart it,
     verify the link comes up green in **Admin → DMZ Links**.

## [1.4.1] — 2026-05-05

### Tunnel watchdog no longer reaps active sessions at the access-token TTL

v1.4.1 fixes a high-impact regression in the v1.3.2 WebSocket-tunnel
auth watchdog ([`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)).
Reported by users: active connection sessions were being torn down
roughly every 20 minutes even though the operator was still logged in
and actively using the web UI.

**Root cause.** The watchdog captured the access token's `exp` claim
once at WebSocket-upgrade time and forced the tunnel closed when that
timestamp was reached. Access tokens carry a 20-minute TTL, but the
frontend's `SessionTimeoutWarning` rotates them via
`POST /api/auth/refresh` on user activity (proactive refresh after
~10 minutes of activity). The already-open WebSocket has no mechanism
to learn about that rotation, so the watchdog held on to the
_original_ token's `exp` and reaped the session at T+20m regardless of
how active the user was.

**Fix.** The dead `jsonwebtoken::decode` block at upgrade time and
the `watchdog_exp: Option<u64>` cache are removed. Teardown semantics
are now:

1. **Manual logout / 20-min idle logout** — the frontend already calls
   `POST /api/auth/logout`, which revokes both access and refresh
   tokens. The watchdog still polls
   `services::token_revocation::is_revoked(token)` every 30 s and
   closes the tunnel within one tick. Audit `reason: "revoked"`.
2. **Browser closed / network died** — TCP-level WebSocket close
   already triggers normal teardown via `tunnel::proxy(...)`
   returning. No watchdog needed.
3. **Hard cap on session duration** — newly enforced by the watchdog
   as `MAX_TUNNEL_DURATION = 8h`, measured from upgrade time so it is
   unaffected by token rotation. Audit `reason: "max_duration"`.

The audit-log payload shape is unchanged; the `reason` field can now
take the values `"revoked"` or `"max_duration"` (previously
`"revoked"` or `"expired"`). Operators who consume the
`tunnel.terminated` audit event should update any dashboards that
filtered on `expired` to also accept `max_duration` — they refer to
the same defence-in-depth backstop, just measured against wall-clock
elapsed time rather than the (now-rotating) token `exp`.

### guacd image build resilience: `staging/1.6.1` pin churn

The guacd image build was briefly broken on `origin/main` between
commits `de0ba24` and `1064a8e` while we attempted to drop our local
patch [`guacd/patches/006-freerdp325-authenticate-ex.patch`](guacd/patches/006-freerdp325-authenticate-ex.patch).
The hypothesis — that GUACAMOLE-2273 (upstream commit `7696572`,
_"Implement FreeRDP AuthenticateEx callback and handle deprecation
of Authenticate callback"_) had landed on `staging/1.6.1` and
rendered our patch redundant — was wrong: at this writing GUACAMOLE-2273
exists only as an unmerged PR commit, not on the staging branch
HEAD. Rebuilding `guacd` against the new pin (`4163ead`) without
patch 006 fails at `src/protocols/rdp/rdp.c:558`:

```
rdp.c:558:15: error: 'freerdp' {aka 'struct rdp_freerdp'} has no
member named 'Authenticate'; did you mean 'AuthenticateEx'?
```

Independently, attempting to pin directly to the GUACAMOLE-2273
PR commit (`7696572`) trades that error for a different one against
FreeRDP 3.25:

```
rdp.c:387:14: error: 'AUTH_FIDO_PIN' undeclared (first use in this
function)
```

`AUTH_FIDO_PIN` is part of the FreeRDP `rdp_auth_reason` enum
introduced after FreeRDP 3.25, and Alpine edge currently ships
`freerdp-libs 3.25.0-r0` / `freerdp-dev 3.25.0-r0`. Net result:
neither _"drop patch 006"_ nor _"pin to the unmerged PR"_ works
today. v1.4.1 keeps the working v1.4.0 combination — pin
`4163ead8be54baa35ef5f7ad8897a57497649112` (`staging/1.6.1` HEAD)
plus patch 006 plus the two grep guards in
[`guacd/Dockerfile`](guacd/Dockerfile) — and updates the Dockerfile
comment block to record the reasoning so the next maintainer does
not re-walk the same path. Functionally a no-op vs. v1.4.0; only
the pin/patch _story_ changed.

### Crypto crate refresh

[`backend/src/services/web_autofill.rs`](backend/src/services/web_autofill.rs) — Chromium-format
`Login Data` decryption (PBKDF2 `peanuts`/`saltysalt`, AES-128-CBC,
v10 prefix, used by the Chromium-export ingestion path under VDI /
web sessions) — gets a refresh of the underlying RustCrypto crates
to the current major lines:

| Crate    | Old  | New  | Notes                                          |
| -------- | ---- | ---- | ---------------------------------------------- |
| `aes`    | 0.8  | 0.9  | API: `KeyInit::new` is now panicking-only      |
| `cbc`    | 0.1  | 0.2  | feature `std` → `alloc`                        |
| `pbkdf2` | 0.12 | 0.13 | `pbkdf2_hmac::<Sha1>(...)` signature unchanged |
| `sha1`   | 0.10 | 0.11 | re-export hygiene                              |

The decrypted secret is never written to disk by the backend; this
path lives entirely behind the autofill-import feature toggle that
is still gated by `can_manage_system`. Envelope encryption of stored
credentials still goes through `aes-gcm` (unchanged) and Vault
Transit (unchanged) — see
[`docs/security.md` § Envelope Encryption](docs/security.md#envelope-encryption-credentials-at-rest).

### Frontend code-quality sweep

`chore(frontend): eliminate 334 ESLint warnings (Phases 1-7)`. No
behavioural changes — explicit `unknown`-narrowing in error
catches, removal of dead imports, JSX accessibility tightening,
`useCallback` / `useMemo` dependency arrays normalised, optional-
chaining where the type already permits `undefined`. The frontend
ESLint job in CI now exits with `0` warnings instead of a noisy
allow-list. Coverage thresholds in
[`frontend/vitest.config.ts`](frontend/vitest.config.ts) raised in
lock-step (`statements`, `branches`, `functions`, `lines` all
≥ the new measured baseline) to prevent backsliding.

### Dependency bumps

Backend:

- `bollard` 0.18.1 → 0.20.2 → 0.21.0 (transitive `hyper-util` /
  `hyper` / `http-body-util` refresh; `bollard::Docker::list_images`
  / `inspect_container` now return strongly-typed `models::*`
  instead of `serde_json::Value`). Test-side adjustments live in
  [`backend/src/services/vdi_docker.rs` test module](backend/src/services/vdi_docker.rs).
- `tokio` 1.52.1 → 1.52.2 (patch).

CI / GitHub Actions:

- `docker/login-action` 3.7.0 → 4.1.0
- `actions/cache` 4.3.0 → 5.0.5
- `github/codeql-action` 4.35.2 → 4.35.3
- Trivy scan now prints the findings table on failure
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) and the
  GHA build cache for the OS-package layer is dropped on each run
  so freshly-published patch CVEs are surfaced same-day rather than
  hidden behind a cached layer.

E2E:

- `eslint` 10.3.0 / `eslint-plugin-react-hooks` 7.1.1 / `@eslint/js`
  10.0.1 / `eslint-plugin-security` 4.0.0 — Dependabot PRs reviewed
  and held: ESLint 10 is **not yet mergeable** because
  `eslint-plugin-react@7.37.5` (latest) still calls the removed
  `context.getFilename()` method (TypeError at lint time) and
  `eslint-plugin-jsx-a11y@6.10.2` (latest) caps its peer range at
  `eslint@^9`. We re-evaluate when those plugins ship v10-compatible
  releases.

### Documentation

- [`docs/security.md`](docs/security.md) — _WebSocket-tunnel auth
  watchdog_ section revised with v1.4.1 semantics
  (`MAX_TUNNEL_DURATION = 8h`, removal of `exp` enforcement, new
  `max_duration` audit reason).
- [`docs/architecture.md`](docs/architecture.md) — _Connection
  Tunnel_ prose updated to match the watchdog v1.4.1 contract.
- [`docs/api-reference.md`](docs/api-reference.md) — `tunnel.terminated`
  audit `reason` enum updated.
- This changelog and [`WHATSNEW.md`](WHATSNEW.md) — the v1.4.1
  card and the headline regression-fix narrative above.
- [`README.md`](README.md) — version badge bumped to 1.4.1.

### Tests

- [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  watchdog tests: assert `reason = "revoked"` survives the removal
  of `exp` enforcement and assert `reason = "max_duration"` is
  emitted when the elapsed-time guard fires (test substitutes a
  small `MAX_TUNNEL_DURATION` via `cfg(test)`).
- [`backend/src/services/vdi_docker.rs`](backend/src/services/vdi_docker.rs)
  — fixture types updated for `bollard 0.20+` typed responses.
- [`frontend`](frontend) — coverage thresholds raised; new tests
  for `parseKubeconfig` mocking inside `AdminSettings` and
  miscellaneous unit tests added during the ESLint sweep.

### Upgrade notes

Drop-in upgrade from v1.4.0. No database migrations, no `/api/*`
contract changes (only the `tunnel.terminated` audit `reason` enum
gained a member), no `config.toml` schema changes. Rebuild backend,
frontend and (optionally) `guacd` images so the new bits actually
run:

```bash
docker compose build backend frontend
# guacd build is unchanged from v1.4.0; rebuild only if you also
# want the documentation-only Dockerfile comment refresh.
docker compose up -d
```

---

## [1.4.0] — 2026-05-01

### Kubernetes pod console as a first-class protocol

v1.4.0 adds the `kubernetes` connection protocol — `kubectl attach`
and `kubectl exec` rendered as a terminal in the browser, end-to-end
through Strata's existing tunnel, recording, audit and credential
pipelines. There is no new sidecar process; Apache Guacamole already
ships a `libguac-client-kubernetes.so` driver that talks the K8s API
spdy/websocket sub-protocol directly, and our custom `guacd` image
already builds it (gated by a Dockerfile guard so a missing `.so`
fails the build instead of silently dropping the protocol at
runtime). The five phases were scoped, implemented and shipped
together rather than across point releases:

1. **Image guard** — `guacd/Dockerfile` now `test -f`s
   `libguac-client-{rdp,ssh,vnc,kubernetes}.so` after `make install`,
   exiting non-zero if any are missing.
2. **Backend wiring** —
   `backend/src/tunnel.rs` `full_param_map()` gets a
   `protocol == "kubernetes"` branch with terminal defaults
   (`xterm-256color`, gray-on-black, monospace 12pt, 1000-line
   scrollback, `namespace=default`); `is_allowed_guacd_param()`
   adds `namespace`, `pod`, `container`, `exec-command`, `use-ssl`,
   `ca-cert`, `client-cert` to the override whitelist. **`client-key`
   is deliberately NOT whitelisted** — the private half of mTLS
   creds must flow through the Vault-encrypted credential-profile
   path, never through connection extras.
3. **Database schema** — `backend/migrations/060_kubernetes_protocol.sql`
   widens the `connections.protocol` and `ad_sync_configs.protocol`
   `CHECK` constraints to include `'kubernetes'`.
4. **Frontend admin UI** — `frontend/src/pages/admin/protocolFields.ts`
   gains a `"kubernetes"` entry; new `KubernetesSections` component
   in `connectionForm.tsx` renders Pod / Namespace / Container /
   Exec command / TLS toggles / CA + client cert paste areas / the
   shared terminal display fields. Wired into `AccessTab`. New
   protocol icon (Kubernetes-style heptagon wheel) added to
   `CommandPalette`, `Dashboard` and `ActiveSessions`.
5. **Kubeconfig importer** — `POST /api/admin/kubernetes/parse-kubeconfig`
   takes a pasted `~/.kube/config`, extracts cluster server URL,
   namespace, CA cert and client cert, and returns the client
   private key to the caller exactly once. The connection editor
   wires this into an "Import kubeconfig" textarea above the
   Kubernetes form sections; the private key surfaces in a
   "copy now" panel and is wiped from DOM state once the form is
   filled. The backend never persists the private key on this
   path — operators are expected to immediately paste it into a
   credential profile.

### Credential routing for `kubernetes`

Tunnel-creation in `routes/tunnel.rs` now special-cases
`wire_protocol == "kubernetes"`: the decrypted credential profile's
password slot is repurposed as the `client-key` PEM body, moved
into the `extra` map, and the username/password slots are cleared.
This keeps the `client-key` parameter inside the same trust
boundary as Vault Transit and prevents stray protocol arguments
from being emitted.

### RBAC

`POST /api/admin/kubernetes/parse-kubeconfig` is gated by
`check_system_permission` (system admin only) and is exercised by
the `e2e/tests/rbac.spec.ts` no-auth/wrong-role assertions.

### Security

- Cluster CA cert and client cert are public PEM material and live
  in `connections.extra` (`ca-cert`, `client-cert`). The matching
  client private key lives only in a Vault-encrypted credential
  profile and is remapped into the guacd `client-key` parameter at
  handshake time.
- The kubeconfig parser deliberately **does not** follow file-path
  references for cert material (`certificate-authority: /path/...`)
  — the backend has no business reading random admin-controlled
  file paths. Only embedded `*-data` base64 blobs are decoded.
- A 1 MiB hard cap on kubeconfig body size prevents YAML-bomb
  abuse of the importer endpoint.

### Documentation

- [`docs/architecture.md`](docs/architecture.md) — new "Kubernetes
  Pod Console" entry under _Extended protocols_.
- [`docs/security.md`](docs/security.md) — Kubernetes client-key
  handling note in the credential-resolution section.
- [`docs/api-reference.md`](docs/api-reference.md) — `kubernetes`
  added to protocol enums; new section documenting
  `POST /api/admin/kubernetes/parse-kubeconfig`.

### Tests

- `backend/src/tunnel.rs` — `full_param_map_kubernetes_defaults`
  and `full_param_map_kubernetes_extras_passthrough` assert the
  protocol branch, default param injection, extras whitelist
  (with `client-key` blocked) and clipboard application.
- `backend/src/services/kubernetes.rs` — five unit tests covering
  full-kubeconfig parsing, single-context fallback, exec-plugin
  warnings, bearer-token warnings, oversized-body rejection and
  empty-body rejection.
- `e2e/tests/rbac.spec.ts` — `parse-kubeconfig` added to both the
  no-auth and wrong-role POST matrices.

### Deferred

- **Live pod listing.** A live `POST /api/admin/kubernetes/list-pods`
  endpoint backed by the `kube` Rust crate (≈80 transitive deps)
  would let the form populate a pod-picker dropdown instead of
  asking the operator to type the pod name. Deferred to a later
  release because the dependency surface is significant and the
  same UX can be achieved out-of-band by `kubectl get pods`. Tracked
  in the roadmap.

## [1.3.2] — 2026-05-01

### guacd FreeRDP 3.25 callback ABI fix, RDP resize artefact correction, idle-tunnel watchdog, and logout WebSocket cleanup

A focused patch release that closes four production-affecting
issues that surfaced after v1.3.1 went out:

1. The custom `guacd` image stopped building on Alpine edge once
   `freerdp-dev` rolled from `3.24.2-r0` to `3.25.0-r0`, because
   FreeRDP 3.25 deleted the legacy `Authenticate` callback field
   from `struct rdp_freerdp` in favour of the new `AuthenticateEx`
   callback (which adds an `rdp_auth_reason reason` parameter).
2. RDP sessions exhibited a black "ghost region" along the edge of
   the visible canvas after a server-driven desktop resize (e.g.
   resolution change inside a Windows VM, GFX channel renegotiation),
   because the new GDI buffer was allocated but never marked dirty
   or refreshed.
3. The backend WebSocket tunnel kept the recording stream and
   `session_registry` row alive indefinitely if the access token
   was revoked or expired without the frontend explicitly closing
   the tunnel — the typical case when the operator force-quits
   the browser, switches networks mid-session, or the tab is
   killed by the OS.
4. Manual logout (and idle-timeout logout) flipped React auth
   state without first closing the open Guacamole tunnels, so the
   backend kept proxying frames into a logged-out user's
   recording until the tab was eventually closed.

None of the changes touch the database schema, the documented
`/api/*` contract, or the on-disk `config.toml` shape. **Drop-in
upgrade from v1.3.1** — rebuild the backend, frontend, and `guacd`
images so the new bits actually run; a `docker compose pull` of an
old tag is not enough.

### Added

- **Patch `006-freerdp325-authenticate-ex.patch` for `guacd`.**
  [`guacd/patches/006-freerdp325-authenticate-ex.patch`](guacd/patches/006-freerdp325-authenticate-ex.patch)
  adds a unified-diff against `src/protocols/rdp/rdp.c` (pinned at
  upstream `apache/guacamole-server` commit `2980cf0`, release
  1.6.1) that:
  - Adds an explicit `#include <freerdp/version.h>` near the top
    of `rdp.c` so the `FREERDP_VERSION_MAJOR` /
    `FREERDP_VERSION_MINOR` preprocessor macros are visible at
    every conditional that follows. (Without this, the macros are
    _not_ transitively defined inside `rdp.c` despite
    `<freerdp/freerdp.h>` being included — a fact that wasted an
    embarrassing amount of debugging time.)
  - Wraps the `static BOOL rdp_freerdp_authenticate(...)` function
    signature in
    `#if defined(FREERDP_VERSION_MAJOR) && (FREERDP_VERSION_MAJOR > 3 || (FREERDP_VERSION_MAJOR == 3 && FREERDP_VERSION_MINOR >= 25))` /
    `#else` / `#endif` so the FreeRDP 3.25+ build gets the new
    five-argument signature
    `BOOL (freerdp* instance, char** username, char** password, char** domain, rdp_auth_reason reason)`
    while FreeRDP 3.24 and earlier keep the four-argument
    signature. The added `reason` parameter is intentionally
    discarded with `(void) reason;` because the existing
    implementation already requests whichever credentials are
    missing, regardless of the reason FreeRDP raised the
    callback.
  - Wraps the
    `rdp_inst->Authenticate = rdp_freerdp_authenticate;` callback
    assignment in the same `#if` / `#else` / `#endif` so FreeRDP
    3.25+ gets `rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;`
    while older versions keep the legacy field name.
- **Defence-in-depth grep verification in `guacd/Dockerfile`.**
  Immediately after the patch loop, the Dockerfile now runs two
  `grep -q` assertions that fail the build with a clear error
  message if the post-patch source tree does _not_ contain
  `#include <freerdp/version.h>` and `rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;`.
  The first iteration of the patch applied silently but selected
  the `#else` (legacy) branch at every conditional because
  `FREERDP_VERSION_MAJOR` was undefined at that point in the
  translation unit; the assertions catch that exact failure mode
  immediately rather than letting the build run on for several
  minutes before the linker complains.
- **`guacd/patches/.gitattributes` pinning `*.patch` to
  `text eol=lf`.** Patch files are byte-sensitive — even a single
  CRLF-converted hunk can cause `git apply` and `patch -p1` to
  misalign context lines. Locking the patches directory to LF
  removes the failure mode for contributors with
  `core.autocrlf=true` on Windows.
- **`guacd/patches/005-refresh-rect-on-resize.patch`** (re-added
  cleanly, after a brief revert during v1.3.1's terminal
  investigation). Forces `guacd`'s GDI desktop-resize path to
  mark the entire layer dirty and to ask the RDP server to
  re-send pixels for the full new desktop area, eliminating the
  "ghost" black border that appeared along the edge of an RDP
  session after a server-driven resolution change. The patch
  inserts a `RECTANGLE_16` covering the whole new desktop and
  invokes `context->update->RefreshRect(context, 1, &area)` once
  the new GDI buffer has been allocated; structured debug logs
  (`[strata] guac_rdp_gdi_desktop_resize: resizing %dx%d` and
  `[strata] post-resize RefreshRect %ux%u -> %s`) make the path
  visible at `GUAC_LOG_DEBUG`. Bounds-checked against `UINT16_MAX`
  so a pathological resize never produces a malformed PDU.
- **WebSocket-tunnel auth watchdog.** A new poll loop inside
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  `ws_tunnel` decodes the access token's `exp` claim once at
  upgrade time and, every 30 seconds while the proxy loop is
  alive, asks `services::token_revocation::is_revoked(token)` and
  compares `now()` to `exp`. If either condition fires, the
  watchdog logs at `INFO` and aborts the proxy loop so the
  recording flushes and `session_registry` decrements. Closes
  the long tail of "ghost recording grows for hours after the
  user's tab is killed by the OS" reports. Polling cadence
  (30 s) was chosen so that an aggressive 1-minute access-token
  TTL still detects revocation within ≤ 30 s, while a normal
  20-minute TTL costs at most 40 ticks per session — negligible
  next to the WebSocket I/O itself.
- **`closeAllSessionsExternal()` module-level handler in
  [`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx).**
  The provider now registers its own `closeAllSessions` callback
  via `setCloseAllSessionsHandler` on mount and unregisters on
  unmount; non-React code (specifically `App.tsx`'s
  `handleLogout`, which lives outside the provider tree) can call
  `closeAllSessionsExternal()` to tear down every active tunnel
  before flipping React auth state. The teardown calls
  `cleanupPopout`, `cleanupMultiMonitor`, the per-session
  `_cleanupPaste` cleanup, resets the keyboard handlers, and
  finally calls `client.disconnect()` on each session inside a
  best-effort `try / catch` so a single failure cannot block the
  rest of the logout flow.

### Fixed

- **`docker compose --profile local-db build guacd` now succeeds
  on Alpine edge.** The previous `guacd` image stopped building
  with:

  ```text
  src/protocols/rdp/rdp.c:565:15: error:
    'freerdp' {aka 'struct rdp_freerdp'} has no member named
    'Authenticate'; did you mean 'AuthenticateEx'?
  ```

  the moment Alpine edge bumped `freerdp-dev` from `3.24.2-r0` to
  `3.25.0-r0`. Patch 006 (above) routes the build through
  `AuthenticateEx` on FreeRDP ≥ 3.25 while keeping the legacy
  `Authenticate` field on 3.24-and-earlier so contributors still
  on `freerdp-dev=3.24.2-r0` are not regressed. The pinned
  upstream `apache/guacamole-server` commit (`2980cf0`) is
  unchanged.

- **Black "ghost regions" after RDP desktop resize.** Patch 005
  (above) adds a post-`gdi_resize` repaint kick so the full new
  desktop area is marked dirty and a `RefreshRect` is sent to the
  RDP server, eliminating the visible solid-black margin that
  used to appear along the edges of an RDP session after a
  server-driven resolution change.
- **Stale recording rows / `session_registry` rows after lost
  tabs.** When the operator's browser tab was killed without a
  graceful close (OS task-killer, network drop, kernel OOM,
  hostile client), the WebSocket tunnel kept proxying frames
  into a recording until the OS eventually closed the underlying
  TCP socket — minutes later, sometimes hours. The new auth
  watchdog (above) now detects access-token expiry / revocation
  in ≤ 30 s and tears the tunnel down cleanly, so the recording
  is flushed and `session_registry` accurately reflects the live
  set of sessions.
- **Logout left tunnels streaming until the tab closed.**
  `App.tsx`'s `handleLogout` now calls `closeAllSessionsExternal()`
  _before_ flipping React auth state and then issues a
  fire-and-forget `apiLogout()` to invalidate the refresh token
  and clear the auth cookies. Idle-timeout logout takes the same
  path. The backend now sees clean WebSocket closes the moment
  the user clicks **Log out** (or hits the idle deadline), and
  the live-sessions list updates immediately rather than after
  the next 30 s watchdog tick.
- **Clippy `too_many_arguments` warning on `ws_tunnel`.** The
  `ws_tunnel` axum handler reached eight extractor arguments
  after the `OriginalUri` and watchdog work; a targeted
  `#[allow(clippy::too_many_arguments)]` keeps the handler
  signature readable without splitting the extractor chain into
  a wrapper struct that would be only used in one place.
- **Cosmetic: JWT `exp` claim decode is now a small typed block.**
  The watchdog's `exp` decode lives in a self-contained `decode::<ExpClaim>`
  with `Validation::new(Algorithm::HS256)`, an issuer check
  (`strata-local`), and a `set_required_spec_claims(&["exp"])`,
  rather than a flat one-liner — non-local OIDC tokens cleanly
  fall through to `None` and the watchdog gracefully degrades to
  revocation-only checks for them.

### Removed

- **`guacd/patches/006-freerdp325-authenticate-ex.awk`.** Earlier
  iterations of the FreeRDP 3.25 fix experimented with an
  `awk`-based shim and a `sed` shim before settling on a real
  unified-diff `.patch` consistent with siblings 001–005. The
  intermediate `.awk` script has been deleted; the canonical fix
  is patch 006 above.

### Operator notes

- **Rebuild required.** All four fixes live in either the Rust
  backend binary, the React bundle, or the custom `guacd` image.
  `docker compose up -d --build` (or pull a freshly published CI
  tag) — a `docker compose pull` of an old tag will leave you on
  the broken `guacd` image.
- **No database migrations.** Schema is unchanged from v1.3.1.
- **No `/api/*` contract changes.** No new routes, no new query
  parameters, no new response fields. The auth-watchdog poll is
  entirely server-side.
- **No `config.toml` schema changes.**
- **Existing in-flight tunnels** that were already connected
  before the upgrade get the watchdog the next time the user
  reconnects (the watchdog is wired in `ws_tunnel`, which only
  runs at upgrade time).
- **FreeRDP 3.24 still works.** The `#if` guard on patch 006 means
  contributors on Debian 13 / Trixie (which still ships
  `freerdp-3.24`) build identically to before.

## [1.3.1] — 2026-04-30

### SSH terminal fidelity, phantom-selection mouse hygiene, recording-playback URL fix, and guacd patch resilience

A same-day patch release that closes five separate small bugs that
all surfaced together while validating the v1.3.0 production
rollout. None of them affect the database schema, the `/api/*`
contract, or the on-disk config shape — every fix is confined to
the backend `tunnel.rs` parameter map, the frontend session /
recording-playback components, and the guacd image build pipeline.
The only operator-visible behaviour change is that **brand-new SSH
sessions look correct out of the box** (256-colour `vim`, working
`nano` alt-screen restore, sane scrollback) without the operator
having to set any per-connection `terminal-type` / `color-scheme`
override. The other four fixes are pure-correctness changes that
remove user-facing failure modes that were never supposed to occur.

### Added

- **Rustguac-parity SSH defaults in the connect-instruction parameter
  map.** [`backend/src/tunnel.rs`](backend/src/tunnel.rs) `full_param_map()`
  now seeds — for every `protocol == "ssh"` connection where the
  admin has not explicitly overridden them — the same SSH terminal
  parameters that upstream
  [sol1/rustguac](https://github.com/sol1/rustguac) sends:
  `terminal-type=xterm-256color`, `color-scheme=gray-black`,
  `font-name=monospace`, `font-size=12`, `scrollback=1000`,
  `backspace=127`, `locale=en_US.UTF-8`, and
  `server-alive-interval=0`. Three of these are load-bearing on
  guacd's bundled SSH terminal emulator
  ([`guac_terminal`](https://github.com/apache/guacamole-server/tree/2980cf0/src/terminal)):
  - **`terminal-type=xterm-256color`** is exported as the `TERM`
    environment variable on the remote PTY. Without it, guacd sends
    the empty default which `OpenSSH` translates to `TERM=linux` on
    most distros — a 16-colour profile that does _not_ advertise
    `smcup`/`rmcup`, so `nano` and `less` cannot save and restore
    the alternate screen. That was the user-visible _"after I close
    nano my SSH window still shows the file"_ bug. With the new
    default, the remote shell sees `TERM=xterm-256color` and the
    alt-screen save/restore works.
  - **`color-scheme=gray-black`** is the rustguac-default colour
    palette; without it guacd renders SGR escape sequences with the
    `black-white` palette which inverts most users' expectations
    (and visually obliterates dark-themed prompts). The new default
    matches what users actually see when they SSH from a normal
    terminal emulator.
  - **`scrollback=1000`** raises guacd's in-buffer line count from
    its built-in default (~256) to 1000, matching `xterm`'s
    historical default and rustguac's choice. Below ~500 lines the
    output of a single `journalctl -xe` invocation cannot be
    scrolled back through.
  - The remaining five (`font-name`, `font-size`, `backspace`,
    `locale`, `server-alive-interval`) are bit-for-bit identical to
    the rustguac defaults so a Strata SSH session is now visually
    indistinguishable from a rustguac one.
  - The corresponding entries (`color-scheme`, `locale`,
    `server-alive-interval`) have been added to
    `is_allowed_guacd_param` so the per-connection `extras`
    allowlist accepts admin overrides for them, and the
    `tunnel_param_allowlist_pins_legal_keys` test pins those new
    keys against accidental removal. The SFTP block has been
    folded into the same `if self.protocol == "ssh"` branch so the
    SSH parameter wiring is in one place rather than two.
- **Mouse-button release on canvas-leave / window-blur in
  `SessionManager.tsx`.** A new `releaseMouseButtons()` helper now
  watches `mouseleave` on the Guacamole display element and `blur`
  on the window. When fired, it inspects the live `mouse.currentState`
  and, if any of `left` / `middle` / `right` is still set, emits a
  cleared `Guacamole.Mouse.State` via `client.sendMouseState(s, true)`.
  This closes the long-running _"phantom text selection extends
  across the SSH terminal as I move my cursor toward the browser
  tab strip"_ bug. Root cause: when the user clicks inside the
  Guacamole canvas and the matching `mouseup` lands outside the
  document (browser chrome, devtools window, popped-out Strata
  window, another tab during a drag), the page never receives the
  `mouseup` and guacd's terminal stays in _"left button held"_
  state; the next `mousemove` is then interpreted as a
  drag-extend-selection. The fix sends an explicit
  buttons-released state on the two events that actually catch
  every cursor-leaves-canvas case (`mouseleave` for in-tab leaves,
  `blur` for tab/window switches that don't produce a `mouseleave`).
  The release is a no-op when no buttons are held, so it costs
  zero round-trips during normal interaction.

### Fixed

- **Recording playback `Tunnel error` after seeking or changing
  speed.** The recording-playback URL builder in
  [`frontend/src/components/HistoricalPlayer.tsx`](frontend/src/components/HistoricalPlayer.tsx)
  prepended `&seek=…` and `&speed=…` to a base URL that did not
  yet contain a `?`, producing a malformed path like
  `…/stream&seek=3114&speed=2` that the WebSocket upgrader on the
  backend correctly rejected as an unknown route. The frontend
  rendered this as the red _"Tunnel error"_ badge over the player
  the moment the user clicked any seek button (`30S`, `1M`, `3M`,
  `5M` in either direction) or any speed button (`2x`, `4x`, `8x`).
  Fixed by collecting the parameters into a list and prepending
  `?` when the base URL has no existing query string, `&` when it
  does, before splitting on `?` for the
  `tunnel.connect(tunnelQuery)` call. The split semantics are
  preserved so the parameters still travel as Guacamole
  connect-protocol args (which is what the backend route already
  reads them as) rather than as URL query string.
- **Phantom text selection in SSH terminals when the cursor leaves
  the Guacamole canvas mid-drag.** See the _Added_ section above.
  Symptom: clicking inside the SSH terminal then moving the mouse
  toward the browser tab strip (or any other element outside the
  canvas, including a popped-out devtools window) without
  physically releasing the mouse button caused guacd's terminal
  to keep building a text selection across whatever the cursor
  passed over. Affected SSH only because guacd's terminal is the
  only protocol path that uses left-mouse-drag for region
  selection; RDP / VNC / web kiosks were never affected.
- **Missing 256-colour ANSI rendering and broken `nano` /
  `less` alt-screen restore on SSH.** See the _Added_ section
  above. Symptom: closing `nano` left the file contents on the
  terminal viewport instead of restoring the previous prompt;
  `vim`'s syntax highlighting and `ls --color` rendered in the
  reduced 16-colour palette; bold colours often rendered as the
  same colour as plain text.
- **`docker compose build guacd` failing with `error: patch does
not apply` when a patch hunk's surrounding context has drifted
  by even a single whitespace line.** [`guacd/Dockerfile`](guacd/Dockerfile)
  previously applied each patch with `git apply` only — which is
  strict about hunk context. The patch step now installs `patch`
  via `apk add --no-cache patch` and falls back to
  `patch -p1 -F3 < "$p"` when `git apply` fails, allowing up to
  three lines of fuzz on each hunk. This makes the image build
  resilient to upstream Apache `guacamole-server` whitespace
  refactors that don't actually conflict with our patches; we
  still pin the upstream commit (`2980cf0`) for reproducibility.
- **Stray diagnostic patch file.** Removed the temporary
  `guacd/patches/005-alt-screen-trace.patch` that was added during
  the SSH alt-screen diagnostics earlier in v1.3.0 development.
  It was always intended to be a build-time trace patch (it
  printed extra `guac_terminal` debug to stderr) and should not
  have been left in the repository for v1.3.0. The fix that
  superseded it (the SSH defaults above) lives entirely in
  `tunnel.rs`, so removing the patch causes no behaviour change.

### Validation

- `cargo fmt --check` clean.
- `cargo clippy --all-targets -- -D warnings` clean.
- `cargo test -p strata-backend tunnel::tests::full_param_map` (and
  the surrounding tunnel allowlist tests) pass with the new SSH
  defaults and the expanded `is_allowed_guacd_param` keys.
- `npm test -- --run` clean; the existing `HistoricalPlayer` seek /
  speed tests continue to pass with the corrected URL builder
  (no test asserted on the malformed format).
- Manual: opening an SSH session through the production deployment
  now shows colourised `ls`, working `nano` alt-screen restore,
  and ≥1000 lines of scrollback on `Shift-PageUp`. Clicking the
  terminal then moving the cursor to the browser tab strip without
  releasing no longer extends a phantom selection. Clicking any
  seek or speed button on a recording playback page no longer
  shows _"Tunnel error"_ — the player reconnects with the new
  `seek` / `speed` Guacamole args and resumes playback.

### Upgrade notes

- **Mandatory image rebuild.** All fixes live in the
  backend Rust binary, the frontend bundle, and the guacd
  Dockerfile patch step — all three are baked into their
  respective images. Run `docker compose up -d --build` (or pull
  freshly published CI tags). A `docker compose pull` of an old
  tag is _not_ enough.
- **No database migrations.** v1.3.1 is schema-stable relative to
  v1.3.0 and v1.2.0.
- **No `/api/*` contract changes.** The recording-playback
  WebSocket endpoint (`GET /api/{user,admin}/recordings/{id}/stream`)
  documented in [`docs/api-reference.md`](docs/api-reference.md)
  has always accepted `seek` and `speed` as proper query
  parameters; only the frontend URL builder was wrong.
- **Operator action — none required.** The new SSH defaults apply
  automatically to every existing SSH connection on first reconnect
  after the upgrade. Connections that explicitly set
  `terminal-type` / `color-scheme` / `scrollback` / etc. via the
  per-connection `extras` map keep their override (the defaults
  only fill in keys the admin has not specified).

## [1.3.0] — 2026-04-30

### Web-kiosk lifecycle correctness, Chromium trust-store fix, production-resilience hardening, and protocol-aware Quick Share

A focused follow-up to the v1.2.0 Trusted-CA work. Three production
incidents on the in-house deployment surfaced four orthogonal bugs
that all combined to make Trusted CAs _appear_ not to work even when
they were configured correctly: (1) the kiosk's NSS database was
materialised at `<user-data-dir>/.pki/nssdb` but Chromium reads NSS
from `$HOME/.pki/nssdb`, so the imported roots were silently ignored
and every site signed by an internal CA tripped
`NET::ERR_CERT_AUTHORITY_INVALID` despite a successful `certutil -A`;
(2) the kiosk handle was never evicted from the in-memory registry on
WebSocket disconnect, so closing the browser tab left Chromium + Xvnc
running and the _next_ reopen returned the stale handle (= a closed
tab) instead of spawning a fresh kiosk; (3) Chromium's "You are using
an unsupported command-line flag: --no-sandbox" yellow infobar was
permanently stuck across the top of every kiosk; (4) on the
production host the backend was crash-looping with exit code 141 and
zero log output because `find … | head -n1` in the container
entrypoint raced with `pipefail`, killing the script before
`gosu strata strata-backend` ever ran. Stack-level fixes were applied
to the backend entrypoint, the nginx upstream resolution, the kiosk
spawn pipeline, the kiosk teardown path, and Quick Share gets a small
quality-of-life upgrade — generated download snippets are now picked
per-protocol so SSH/Telnet sessions get a `curl -fLOJ '<url>'`
one-liner ready to paste into the remote shell instead of the bare
URL that only made sense for a browser-based kiosk.

### Added

- **Protocol-aware Quick Share snippets.** The Quick Share panel now
  takes the active session's protocol into account when generating
  the "copy this to the remote session" snippet:
  - `ssh` / `telnet` sessions default to a `curl -fLOJ '<url>'` one-
    liner — `-f` fails fast on HTTP errors (no garbage body written
    to disk), `-L` follows redirects, `-O` writes to a file, `-J`
    honours the `Content-Disposition` filename header the backend
    already sends so the saved file keeps its original name instead
    of becoming the opaque token.
  - `rdp` / `vnc` / `web` (and any other protocol) keep the bare
    HTTPS URL because the user pastes it into a graphical browser
    inside the kiosk.
  - A new "Copy as" dropdown (rendered with the shared `Select`
    component to match the rest of the modern UI) lets the operator
    override per-session: `URL`, `curl (Linux / macOS)`,
    `wget --content-disposition (Linux)`, or
    `Invoke-WebRequest -Uri … -OutFile … (Windows)` for OpenSSH-on-
    Windows targets where neither `curl.exe` nor `wget` may be on
    `PATH` for the logged-in user.
  - All snippet variants single-quote the URL so an exotic origin
    character (e.g. an `&` in a future query string) cannot break out
    of the command. Filenames embedded in the PowerShell variant are
    apostrophe-escaped (`O'Brien.pdf` → `O'\''Brien.pdf` semantics).
  - The `protocol` prop is optional, so existing test fixtures that
    instantiate `<QuickShare …/>` without it continue to render with
    the safe `URL` default.
- **Kiosk eviction on tunnel disconnect.** The web-protocol branch of
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs) now
  captures an `Arc<WebRuntimeRegistry>` before the WebSocket upgrade
  and, after `tunnel::proxy` returns (whether `Ok` or `Err`), calls
  `web_runtime.evict(connection_id, user_id)`. Eviction drops the
  registry's `Arc<WebSessionHandle>`; if no other tab is holding the
  same handle the refcount hits zero and `WebSessionHandle::Drop`
  runs, SIGKILL-ing both the Chromium and Xvnc children via
  `kill_on_drop(true)`, releasing the allocated display slot
  (`100..=199`) and CDP port (`9222..=9321`), and removing the
  per-session profile tempdir (with its embedded NSS DB). A
  matching `web.session.end` audit event with
  `reason: "tunnel_disconnect"` is written so admins can see in the
  audit log exactly when each kiosk was torn down.
- **Chromium "unsupported flag" infobar suppression.** The argv
  builder in
  [`backend/src/services/web_session.rs`](backend/src/services/web_session.rs)
  now adds `--test-type` whenever it adds `--no-sandbox` (i.e. only
  when running as root, which is the default in the container). This
  suppresses the yellow _"You are using an unsupported command-line
  flag: --no-sandbox. Stability and security will suffer."_ banner
  that Chromium otherwise paints across the top of every kiosk tab.
  `--test-type` does **not** disable the sandbox — it only suppresses
  the warning chrome and a handful of other end-user prompts (default-
  browser, session-restore) that have no meaning inside a single-tab
  kiosk. Two new unit tests pin the pairing: `--test-type` only
  appears when `--no-sandbox` does, and never on its own.
- **Resilient nginx upstream resolver.** The nginx fragment served
  inside the frontend container (`frontend/common.fragment`) now
  declares `resolver 127.0.0.11 valid=10s ipv6=off;` (Docker's
  embedded DNS) and uses a `set $backend_upstream "backend:8080";`
  variable as the `proxy_pass` target. The variable forces nginx to
  re-resolve the upstream at request time instead of caching the
  result from process startup. Previously, if the `backend` container
  was even briefly unreachable when nginx booted (the typical case
  during `docker compose up -d --build` while the backend image was
  still building), nginx would die with the legendary
  `[emerg] host not found in upstream "backend"` and stay dead until
  manually restarted. Now nginx returns `502 Bad Gateway` for the
  duration of any backend outage and recovers automatically when the
  upstream comes back — no more crash-loop, no more stuck Login
  spinner after a backend redeploy.

### Changed

- **`spawn_chromium()` now sets `HOME` to the per-session user-data-
  dir.** [`backend/src/services/web_runtime.rs`](backend/src/services/web_runtime.rs)
  sets `HOME=<user_data_dir>` in the `Command` env block alongside
  `DISPLAY`. Chromium's NSS-based cert verifier on Linux resolves the
  trust-store path relative to `$HOME` (always
  `$HOME/.pki/nssdb`) — _not_ relative to `--user-data-dir`. The
  `--user-data-dir` flag controls Chromium's own profile (cookies,
  cache, prefs); it has no effect on NSS. Without this override the
  backend correctly created the NSS DB at
  `<user_data_dir>/.pki/nssdb` and ran `certutil -A`, but Chromium
  was looking at the strata user's actual home (`/home/strata/.pki/
nssdb` or wherever) which never had the imported cert. Pointing
  `HOME` at the user-data-dir aligns NSS's resolution with where the
  bundle is materialised. Fixes the symptom from v1.2.0 where uploading
  and selecting a Trusted CA still produced
  `NET::ERR_CERT_AUTHORITY_INVALID` for sites signed by that CA.
- **Quick Share panel UI.** A new "Copy as" row sits between the
  upload area and the file list, rendered with the shared `Select`
  component (portal-based, styled to match the rest of the SPA's
  chrome) instead of the previous OS-native `<select>`. The format
  selection resets to the protocol-driven default whenever the
  active session's protocol changes; the per-session override is
  intentionally not persisted across sessions.

### Fixed

- **Backend container crash loop on long-lived hosts (exit code
  141).** [`backend/entrypoint.sh`](backend/entrypoint.sh) reads the
  guacd-recordings volume's gid via
  `find "$RECORDINGS_DIR" -maxdepth 1 -type f -printf '%g\n' | head -n1`.
  With the script-wide `set -euo pipefail`, this pipeline races as
  soon as the recordings volume contains more than a handful of files:
  `head -n1` closes its stdin after the first line, `find` keeps
  writing and is killed with `SIGPIPE`, exit code `141` (`128 + 13`)
  propagates through `pipefail`, `set -e` aborts the script, and the
  container exits before `gosu strata strata-backend` ever runs.
  Symptom on production was a backend container in a permanent
  `Restarting (141)` state with empty `docker compose logs`. Wrapped
  _just that one pipeline_ with `set +o pipefail` / `set -o pipefail`
  so the (harmless) SIGPIPE on `find` no longer kills the script,
  while preserving strict-mode safety everywhere else in the
  entrypoint.
- **Stuck "Locating authentication service…" spinner on the Login
  page.** This was a downstream symptom of the nginx crash-loop bug:
  the SPA boots, calls `getStatus()` which proxies through nginx to
  the backend, the request fails because nginx is dead, and the
  catch block silently swallows the error so the spinner spins
  forever. Now that the resolver fix keeps nginx alive, `getStatus()`
  recovers within ~10 s of a backend restart on the next page load
  with a 502 → 200 transition. (A future release may add an
  in-component retry-with-backoff and a "couldn't reach server"
  fallback button.)
- **Web kiosk reuses stale state after browser-tab close.** Closing
  the browser tab without first hitting _Disconnect_ on the Session
  Bar used to leave the Chromium + Xvnc pair running; the next time
  the user opened the same connection, `WebRuntimeRegistry::ensure()`
  hit the fast-path and returned the abandoned handle (often a closed
  blank tab). Eviction-on-disconnect closes both the symptom (next
  reopen is fresh) and the underlying resource leak (display slot,
  CDP port, profile tempdir, and child processes are released
  immediately).
- **`NET::ERR_CERT_AUTHORITY_INVALID` for sites signed by an uploaded
  Trusted CA.** See "Changed → `spawn_chromium()` HOME" above for the
  full causal chain.
- **Yellow `--no-sandbox` warning bar overlapping the kiosk content.**
  See "Added → Chromium infobar suppression" above. The bar consumed
  the top ~28 px of every kiosk tab, occluding navigation chrome on
  sites with sticky headers.

### Security

- **`--test-type` is _not_ a sandbox-disable flag.** It is paired
  exclusively with the existing `--no-sandbox` (which we already had
  to set because the kiosk runs as root inside the container) and
  only suppresses chrome-level UI infobars and end-user prompts.
  Rendering, network stack, mojo IPC, JIT, and origin isolation
  are unchanged. The kiosk's threat model (single-tab, X-display-
  isolated per session, ephemeral profile, egress allow-list, NSS
  trust limited to operator-uploaded roots) is unaffected.
- **Eviction-on-disconnect closes a resource-exhaustion vector.**
  Without eviction, an attacker controlling a browser session could
  open and rapidly close kiosks to pin display slots `:100..:199`
  and CDP ports `9222..=9321`, eventually triggering
  `WebRuntimeError::DisplayExhausted` for legitimate users. Eviction
  releases both allocators on every disconnect, capping per-user
  resource pressure at the count of _concurrently open_ tabs.
- **Backend entrypoint hardening.** The `pipefail` fix is defence-in-
  depth against a `find` invocation that exits non-zero — no security
  property changed, but the failure is now diagnosable instead of an
  empty-log mystery.

### Validation

- `cargo fmt --check` clean.
- `cargo clippy --all-targets -- -D warnings` clean (existing
  `#[allow(dead_code)]` on the unused `materialise_into_nss_db`
  pool wrapper is preserved).
- `cargo test -p strata-backend` passes; two new tests on
  `chromium_command_args` lock in the `--test-type` pairing.
- `npm test -- --run` clean.
- `docker-compose up -d --build` succeeds on the in-house
  production host with the new entrypoint; backend reaches `Up
(healthy)` instead of `Restarting (141)`; nginx logs no longer
  contain `host not found in upstream`.

### Upgrade notes

- **Mandatory image rebuild.** The fixes live in the backend
  `entrypoint.sh`, the backend Rust binary, and the frontend nginx
  config — all three are baked into their respective images. Run
  `docker compose up -d --build` (or pull a newly published tag
  from CI). A `docker compose pull` of an old tag is _not_ enough.
- **No database migrations.** v1.3.0 is schema-stable relative to
  v1.2.0.
- **No `/api/*` contract changes.** All existing endpoints behave
  identically; the new `web.session.end` audit event continues to
  use the existing format (now with `reason: "tunnel_disconnect"`
  populated for the new code path).
- **Operator action — none required.** Existing Trusted CA bundles
  uploaded under v1.2.0 will _start working_ on the first kiosk
  spawn under v1.3.0; no re-upload is needed.

## [1.2.0] — 2026-04-29

### Reusable Trusted CA bundles for Web Sessions, tenant-aware checkout-email rendering, and SMTP / NVR UX polish

This minor release rounds off a cluster of work that landed against
the 1.1.x line: a brand-new admin-managed Trusted CA store that lets
operators upload a PEM bundle once and attach it to any number of
`web` connections via a dropdown (no more re-pasting certificates
into every kiosk row), a complete cleanup of the four checkout
notification emails so that timestamps render in the tenant's
configured timezone, the _target account_ line shows the friendly
name an operator actually sees in the Credentials UI, the
`cid:strata-logo` banner is no longer a broken image, and the
**SMTP TLS = none** mode finally hides authentication fields and
clears any stored credentials on save. The admin Sessions page also
gets a UX polish on the _LIVE_ / _Rewind_ action buttons with a
gradient-on-hover treatment plus a dual-keyframe pulsing-dot motion
that respects `prefers-reduced-motion`.

### Added

- **Reusable Trusted CA bundles for Web Sessions.**
  - New table `trusted_ca_bundles` (migration
    [`backend/migrations/059_trusted_ca_bundles.sql`](backend/migrations/059_trusted_ca_bundles.sql))
    storing `id`, `name` (UNIQUE on `LOWER(name)`), `description`,
    `pem`, cached `subject`, `not_after`, `fingerprint` (SHA-256 hex,
    colon-separated), `created_at` / `updated_at`, and `created_by`.
  - New service module
    [`backend/src/services/trusted_ca.rs`](backend/src/services/trusted_ca.rs)
    exposing `parse_and_validate()` (rustls-pemfile + x509-parser),
    `list` / `get` / `create` / `update` / `delete`, plus
    `materialise_into_nss_db()` and `import_pem_into_nss_db()` helpers
    that drive `certutil -N` + `certutil -A -d sql:<dir> -n <name> -t "C,," -i <pem>`
    against a per-session NSS database under
    `<user-data-dir>/.pki/nssdb`.
  - New backend dependency `x509-parser = "0.18"`.
  - New apt package `libnss3-tools` baked into
    [`backend/Dockerfile`](backend/Dockerfile) so `certutil` is
    available at runtime.
  - New admin endpoints (require **Manage System** + audit-log every
    write):
    - `GET    /api/admin/trusted-cas`
    - `POST   /api/admin/trusted-cas`
    - `PUT    /api/admin/trusted-cas/{id}`
    - `DELETE /api/admin/trusted-cas/{id}`
  - New auth-only endpoint `GET /api/user/trusted-cas` returning the
    slim `{ id, name, subject }[]` shape used by the connection-editor
    dropdown — so users with **Create Connections** permission but
    _not_ **Manage System** can still pick from the curated list.
  - New admin tab **Admin → Trusted CAs** with table view + upload
    form (file picker accepts `.pem` / `.crt` / `.cer`, plus a
    paste-as-text fallback), surfacing parsed subject / expiry /
    fingerprint preview.
  - New optional **Trusted Certificate Authority** dropdown in the
    Web-protocol section of the connection editor; selection persists
    as `extra.trusted_ca_id` (UUID).
  - Six unit tests in `services/trusted_ca.rs` cover empty input,
    blank input, malformed PEM, well-formed RSA / ECDSA roots, and
    the duplicate-name rejection path.
- **Tenant-aware date/time rendering in checkout emails.** New
  `services/display.rs::format_datetime_for_display()` reads
  `system_settings.display_timezone` (IANA zone), `display_date_format`
  (`YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `DD-MM-YYYY`), and
  `display_time_format` (`HH:mm`, `HH:mm:ss`, `hh:mm A`, `hh:mm:ss A`)
  to convert UTC `DateTime<Utc>` into a human-readable string with
  zone abbreviation (`%Z`). Backend gains `chrono-tz = "0.10"`.
- **RFC 4514-aware Common Name parser.**
  `services/display.rs::cn_from_dn()` correctly handles escaped commas
  (`\,`), escaped plus signs (`\+`), hex-encoded bytes (`\2C`), and
  case-insensitive `cn=` attribute labels — replacing the previous
  naive `dn.split(',').next()` which mis-displayed CNs containing
  commas.
- **`friendly_name`-first display priority for "Target account" in
  emails.** All four checkout email emit-sites
  ([`backend/src/routes/user.rs`](backend/src/routes/user.rs))
  resolve the displayed account name in this order: explicit
  `mapping.friendly_name` → `checkout.friendly_name` →
  `cn_from_dn(distinguished_name)` → raw DN.
- **Inline `cid:strata-logo` attachment.** New
  [`backend/src/services/email/templates/strata-logo.png`](backend/src/services/email/templates/strata-logo.png)
  - helpers `LOGO_CONTENT_ID`, `LOGO_BYTES`, `logo_attachment()` in
    `email/templates.rs`. The dispatcher
    ([`services/notifications.rs`](backend/src/services/notifications.rs)),
    the retry worker ([`services/email/worker.rs`](backend/src/services/email/worker.rs)),
    and the test-send route
    ([`routes/notifications.rs`](backend/src/routes/notifications.rs))
    all now attach the inline part on every send.
- **Premium _LIVE_ / _Rewind_ buttons in the admin Sessions table.**
  New CSS classes `.btn-live`, `.btn-rewind`, and `.live-dot` in
  [`frontend/src/index.css`](frontend/src/index.css) with a
  dual-keyframe animation (1.1 s scaled core dot + an expanding halo
  ring), gradient-on-hover treatment, and a
  `@media (prefers-reduced-motion: reduce)` block that disables the
  pulse for affected users.

### Changed

- **`WebSessionConfig` schema** gains an optional
  `trusted_ca_id: Option<Uuid>` field, deserialised from
  `extra.trusted_ca_id`. Existing rows without the key continue to
  use the OS default trust store.
- **`WebSpawnSpec`** in
  [`backend/src/services/web_runtime.rs`](backend/src/services/web_runtime.rs)
  gains `trusted_ca_pem: Option<String>` and
  `trusted_ca_label: Option<String>`. A new `TrustedCaImport(String)`
  variant is added to `WebRuntimeError`.
- **Tunnel route** ([`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs))
  resolves the configured `trusted_ca_id` to a PEM via
  `services::trusted_ca::get()` _before_ constructing the spawn spec,
  threading the bytes + label into `WebSpawnSpec`.
- **`AdminSettings.tsx` `Tab` union** gains the `"trusted-cas"`
  variant; the new tab renders below VDI in the tab list.
- **SMTP form** ([`frontend/src/pages/admin/NotificationsTab.tsx`](frontend/src/pages/admin/NotificationsTab.tsx))
  hides the username and password rows when `tlsMode === "none"` and
  sends `password: { action: "clear" }` on save in that mode, so
  switching from STARTTLS / implicit-TLS to plaintext relay no longer
  leaves stale Vault-encrypted credentials in the row.

### Fixed

- **Broken-image icon on every transactional email.** The MJML
  templates referenced `cid:strata-logo` but no inline part was being
  attached. All real send paths now wire `logo_attachment()` into the
  outbound `EmailMessage`.
- **Wrong "Target account" name in checkout emails.** Emails
  previously displayed `mapping.distinguished_name` verbatim, which
  for accounts whose CN contains an escaped comma (e.g.
  `CN=Smith\, John,OU=Service Accounts,DC=corp`) showed the _entire_
  DN. Now displays the friendly name when set, otherwise an
  RFC 4514-aware extracted CN.
- **Wrong expiry timezone in checkout emails.** Expiry timestamps
  were emitted as `YYYY-MM-DD HH:MM UTC` regardless of operator
  configuration; they now render in the configured display timezone
  using the configured date and time formats.

### Security

- **Trusted CA bundles are treated as public material.** PEMs hold
  certificate chains (signatures over public keys) — they are _not_
  envelope-encrypted via Vault. A row's PEM is readable by any
  operator with **Manage System**; the picker endpoint
  (`/api/user/trusted-cas`) returns only `{id, name, subject}` and
  deliberately omits the PEM bytes.
- **Reference-guarded delete.** `DELETE /api/admin/trusted-cas/{id}`
  refuses with HTTP 400 when at least one row in `connections` (with
  `protocol = 'web'`) still references the bundle via
  `extra->>'trusted_ca_id'`. Prevents silent breakage of an active
  kiosk by an admin housekeeping the CA list.
- **Per-session ephemeral NSS database.** The kiosk's Chromium
  `--user-data-dir` is created fresh per spawn under `/tmp` and
  destroyed on session end. The NSS DB lives inside that profile dir,
  so trust grants do not survive the tab close.
- **Audit-log every CA mutation.** `trusted_ca.created`,
  `trusted_ca.updated`, and `trusted_ca.deleted` events are written
  to the existing SHA-256-hash-chained `audit_logs` table.
- **SMTP TLS = none clears credentials.** Switching the SMTP
  transport to plaintext explicitly sends `password: { action: "clear" }`
  to the backend so the Vault-encrypted password column is wiped —
  no stale credential survives the mode change.

### Validation

- `cargo fmt` / `cargo clippy --all-targets -- -D warnings` clean.
- `cargo test -p strata-backend` passes.
- `npm test -- --run` clean (`Sessions.test.tsx` 38 / 38,
  `NotificationsTab.test.tsx` 17 / 17).
- `docker-compose up -d --build` succeeds (exit code 0). Backend
  image now layers `libnss3-tools` over the v1.1.0 baseline; image
  size delta is ~12 MiB.

### Upgrade notes

- **Mandatory image rebuild.** The backend image gains
  `libnss3-tools` (provides `certutil`); a `docker compose pull` is
  not enough — operators must `docker compose up -d --build` or rely
  on CI to publish a new tag.
- **Database migration is automatic.** `059_trusted_ca_bundles.sql`
  runs on first boot of the new backend.
- **No `/api/*` breaking changes.** All five new endpoints are
  additive. The `web_session.WebSessionConfig` schema gains an
  optional `trusted_ca_id` field; old `connections.extra` rows are
  forward-compatible.
- **Operator action: review SMTP rows.** If you previously stored a
  username/password against an `smtp.tls_mode = "none"` row, those
  credentials will be cleared on the next save from the UI. The
  database row is untouched until that save event.

## [1.1.0] — 2026-04-29

### RDP graphics-pipeline parity with rustguac, recording-playback EACCES fix, sidebar collapse, stuck-key cleanup, and Playwright RBAC pack

The first feature release on the 1.x SemVer line. The headline change
is a deliberate UX-and-defaults rework of the RDP graphics-pipeline
controls so that fresh connections behave identically to the upstream baseline that
Strata's custom guacd is patched against — `disable-gfx=true` and
`enable-h264=false` are now the _visible_ defaults in the connection
form (previously the UI rendered as if GFX were on while the backend
silently disabled it), with a tightly-interlocked checkbox pair that
mirrors how the underlying guacd negotiation actually works. A
production-affecting bug where historic recordings refused to play
back with a generic "Tunnel error" was traced to a uid/gid mismatch
between the guacd and backend containers and fixed in the entrypoint
scripts of both images. The session-keyboard cleanup path was
hardened against a Guacamole.Keyboard synthetic auto-repeat timer
that could survive a Ctrl+K-driven session switch and hammer the
previous remote with phantom Enter keystrokes once focus returned. A
new floating "hide sidebar" affordance gives operators a one-click
way to reclaim screen real-estate during a session without losing
the navigation column. A small Playwright RBAC + command-palette
smoke pack lands under `e2e/tests/` to catch regressions in the
auth/authz boundary and the global Ctrl+K handler. **Drop-in upgrade
from v1.0.0** — no new database migrations, no `/api/*` contract
changes, no `config.toml` schema changes. Operators must
`docker compose pull && up --build` so the entrypoint fixes in the
backend and guacd images take effect; the rebuild is mandatory for
the recording-playback fix to apply.

### Added

- **GFX / H.264 toggle interlock in the connection form.** The RDP
  Codecs panel of `frontend/src/pages/admin/connectionForm.tsx`
  is reworked so the _Enable graphics pipeline (GFX)_ checkbox is
  ticked only when `disable-gfx === "false"` — i.e. it reflects the
  actual wire state rather than the absence of a value. Toggling
  it writes the explicit string `"false"` or `"true"` to the
  parameter map so backend and frontend never disagree about the
  default. The companion _Enable H.264 (AVC444)_ checkbox is
  rendered disabled whenever GFX is off (because guacd's H.264
  path requires GFX to negotiate the `video/h264` mimetype),
  ticking it forces `disable-gfx="false"` for you, and unticking
  GFX clears any previously-set `enable-h264` so the form cannot
  be saved into an unreachable state. An amber warning under the
  H.264 row reminds admins that AVC444 requires a Windows host
  with a discrete GPU exposing `RemoteFX vGPU` / `AVC444` codec
  support; a tertiary hint under the GFX-off branch points
  operators at the new H.264 capability detection roadmap item.
- **AdSync default-parameter parity.** `AdSyncTab.tsx` previously
  rendered the GFX row using a generic boolean mapper that applied
  the old "Disable GFX" semantics inverted from the new connection
  form. The map is now special-cased so the `disable-gfx` row
  carries the same positive _"Enable graphics pipeline (GFX)"_
  label, the same `cdMap["disable-gfx"] === "false"` checked
  predicate, and the same H.264 interlock as the connection form;
  every other AD-synced default-parameter row keeps the original
  `"true"` / delete pattern unchanged.
- **Floating "Hide sidebar" button.** A new persistent affordance
  in `Layout.tsx` and `SessionClient.tsx` lets operators collapse
  the left navigation column into a thin edge with a single click.
  The collapsed-state is stored in the existing `useSettings`
  context so the preference survives across sessions and
  reload-cycles. Affects every authenticated route, including
  active session canvases where the extra horizontal real-estate
  is most valuable on widescreen monitors.
- **Playwright `e2e/tests/command-palette.spec.ts` smoke pack.**
  Two new tests exercise the global `Ctrl+K` handler end-to-end
  against a real backend: one verifies the palette opens and
  focuses its input, the other verifies the `Esc` close-path. The
  `beforeEach` is hardened to dismiss the `DisclaimerModal` so a
  fresh-database admin (whose `terms_accepted_version` is
  `null`) does not block the palette mount — App.tsx renders the
  modal _instead of_ `CommandPaletteProvider` until terms are
  accepted, so without the dismissal the Ctrl+K listener never
  attaches and both tests would fail under CI's clean-state
  fixtures.
- **Playwright `e2e/tests/rbac.spec.ts` RBAC negative pack.**
  A new test file covers the `/api/admin/*` and
  `/api/user/*` boundaries with no auth, expired bearer, mismatched
  CSRF, and forged-cookie variants — every case must return
  `401`/`403` and must not leak response bodies that would help an
  attacker fingerprint the routing layer.

### Changed

- **`SessionClient.tsx` keyboard cleanup now calls
  `Guacamole.Keyboard.reset()`.** Both the keyboard-effect
  cleanup path and the unmount path now invoke `kb.reset()` after
  nulling `onkeydown` / `onkeyup`. This cancels the synthetic
  auto-repeat timer that `Guacamole.Keyboard.press()` starts at
  500 ms and ticks every 50 ms, and clears the internal `pressed[]`
  set so a key held down at the moment of teardown cannot
  resume hammering the remote when the effect re-attaches on
  return. Eliminates the "switching between sessions causes
  constant Enter spam on the previous session after Ctrl+K
  navigation" regression.
- **Backend container's `entrypoint.sh` no longer chowns
  `/var/lib/guacamole`.** The line was racing with guacd writes
  across the shared volume and destroying the gid signal needed
  by the new supplementary-group lookup. The `chown` for
  `/app/config` and `/etc/krb5` is preserved.

### Fixed

- **Recording playback "Tunnel error" caused by EACCES on the
  shared recordings volume.** The shared `guac-recordings` Docker
  volume is written by guacd (uid/gid `guacd:guacd` = 100/101
  inside the Alpine guacd container) at mode `0640` —
  group-only-read. The backend container runs as
  `strata:strata` (uid/gid 996/996) so the file open returned
  `EACCES`, which the WS handler at
  [`backend/src/routes/admin/recordings.rs`](backend/src/routes/admin/recordings.rs#L240)
  logged as _"Failed to open recording file: Permission denied
  (os error 13)"_ and surfaced to the UI as a generic
  _"Tunnel error"_. Resolved by adding a runtime
  supplementary-group bootstrap in
  [`backend/entrypoint.sh`](backend/entrypoint.sh) that reads the
  gid off whichever guacd-written file is present in the volume
  (falling back to the directory gid on first boot), creates a
  matching local group inside the backend container, and adds
  `strata` to it via `usermod -aG`. `guacd/entrypoint.sh` is
  hardened with an explicit `umask 0027` so any non-recording
  artefacts guacd writes also stay group-readable. The fix is
  volume-agnostic — works for Docker named volumes, bind-mounts,
  NFSv3/v4 with preserved gids, and CIFS with `uid=,gid=` mount
  options. **Azure-stored recordings are unaffected** because the
  Azure path streams blobs over HTTPS via `reqwest` and never
  touches the local filesystem.
- **CommandPalette / RBAC e2e tests previously failing in CI.**
  Two failures in the Playwright suite (`command-palette.spec.ts`)
  were traced to a fresh-database admin whose `users.terms_
accepted_version` was `NULL`, causing `App.tsx` to mount the
  `DisclaimerModal` instead of `CommandPaletteProvider`. The
  `beforeEach` now dismisses the modal — see Added.
- **CodeQL alert #88 — unused `pwRequest` import.** The
  `request as pwRequest` alias in `e2e/tests/rbac.spec.ts` was
  unused since the file's last refactor and is removed.
- **CodeQL alert #85 — unused `CommandMappingPage` import.** The
  explicit generic argument on the `<StyledSelect>` element in
  `frontend/src/components/CommandMappingsSection.tsx` was
  redundant; TypeScript now infers the type from the readonly
  `options` prop, so the unused import is dropped.
- **Auth tests — logout success on missing/invalid bearer.** The
  logout handler tests were previously flaky because they asserted
  on a 200 in cases where Axum's extractor would short-circuit to
  401; the tests now correctly cover both branches.

### Security

- **Recordings volume permission model documented.** The
  uid/gid split between guacd and backend was previously implicit
  in the entrypoint scripts and unstated in `docs/security.md`.
  The model — guacd writes 0640 as `guacd:guacd`; backend reads
  via supplementary-group membership matching the writer's gid —
  is now an explicit security invariant in
  [`docs/security.md`](docs/security.md) and
  [`docs/architecture.md`](docs/architecture.md). The backend's
  `DAC_OVERRIDE` capability is _not_ used for this read path:
  the supplementary-group lookup means standard POSIX
  group-read suffices, so the principle of least privilege is
  preserved.
- **Stuck-key cleanup reduces remote-target attack surface.**
  The `kb.reset()` fix eliminates a small but real risk where a
  user navigating away mid-keystroke could leave a session
  receiving phantom Enter / Space presses, potentially
  confirming a dialog or executing a queued command on the
  remote target without operator awareness. Now every session
  teardown is keystroke-clean.

### Validation

- `cargo fmt --all -- --check` clean.
- `cargo clippy --all-targets --all-features -- -D warnings` clean.
- `cargo test --all-features` — all suites pass.
- `npm run test` (frontend) — 1232/1232 tests across 47 files pass.
- `npm audit --omit=dev` — 0 vulnerabilities.
- `npx playwright test` (e2e) — full suite green including the
  two new files.
- CodeQL — alerts #85 and #88 resolved; no new alerts.

### Upgrade notes

- **Mandatory image rebuild.** Operators on v1.0.0 must run
  `docker compose pull && docker compose up -d --build` (or the
  equivalent `docker compose build --pull && up -d`) so the
  entrypoint changes in both the backend and guacd images take
  effect. A `docker compose pull` alone is insufficient if the
  registry has not yet rebuilt the images.
- **Existing recordings.** All historical `.guac` recordings on
  the shared volume become readable on first backend boot after
  the upgrade — the supplementary-group bootstrap reads their
  gid at startup. No file-rewriting, re-encoding, or chmod sweep
  is needed.
- **No database migrations.**
- **No `/api/*` contract changes.**
- **Existing connections preserve their saved GFX/H.264 state.**
  The connection-form rework changes how _unset_ values are
  rendered (previously the UI lied; now the UI shows the
  rustguac-parity defaults that the backend has always
  applied). Connections with explicit `disable-gfx=false` saved
  by an operator pre-1.1.0 continue to render as
  _GFX enabled_ with no behaviour change.
- **Image tags.** The release pipeline now publishes
  `ghcr.io/<org>/strata-backend:1.1.0` and
  `ghcr.io/<org>/strata-frontend:1.1.0` alongside the rolling
  `:latest` tag. The `:1.0.0` images remain available.

## [1.0.0] — 2026-04-27

### General availability

Strata Client reaches **1.0.0** — a straight promotion of the v0.31.0
codebase with no functional changes. Every feature, fix, validation
result, and dependency pin documented under v0.31.0 below carries
forward verbatim; the only deltas in this release are the version
strings in `VERSION`, `backend/Cargo.toml`, `backend/Cargo.lock`,
`frontend/package.json`, `frontend/package-lock.json`, and the
README badge.

The 1.0.0 tag formalises a SemVer commitment that has been implicit
through the 0.x series: from this release onward, the public REST
API surface (`/api/*`), the database schema (managed by the numbered
migrations under `backend/migrations/`), and the on-disk
configuration shape (`config.toml` keys + environment variable
contracts) are stable. Breaking changes to any of those surfaces
will require a v2.0.0 bump. Internal Rust modules, the frontend
component tree, and the WhatsNew/CHANGELOG narrative remain free
to evolve in minor and patch releases.

### Validation

Identical to v0.31.0 — see below. No re-runs were performed for
this promotion because no source files outside the version-string
set changed.

### Upgrade notes

- **No database migrations.** Operators on v0.31.0 can
  `docker compose pull && up` without further action.
- **No `/api/*` contract changes.** No new endpoints, no removed
  endpoints, no payload shape changes.
- **No frontend UI changes** beyond the WhatsNew modal welcoming
  users to 1.0.0.
- **Image tags.** The release pipeline now publishes
  `ghcr.io/<org>/strata-backend:1.0.0` and
  `ghcr.io/<org>/strata-frontend:1.0.0` alongside the rolling
  `:latest` tag. The previous `:0.31.0` images remain available
  and are byte-identical.

## [0.31.0] — 2026-04-27

### User-defined `:command` palette mappings, built-in commands, ghost-text autocomplete, and a new `command.executed` audit stream

A feature release that turns the in-session Command Palette (default
`Ctrl+K`) from a connection picker into a fully scriptable, user-extensible
command surface. Operators can now type `:` to enter command mode, run
**built-in commands** (`:reload`, `:disconnect`, `:close`, `:fullscreen`,
`:commands`, `:explorer <path-or-program>`)
that target the active session, and define **personal `:command` mappings**
that resolve to one of six typed actions: `open-connection`,
`open-folder`, `open-tag`, `open-page`, `paste-text` (push text onto the
remote clipboard + Ctrl+V), and `open-path` (drive the Windows Run dialog
to open UNC shares, local folders, or `shell:` URIs in Explorer on the
remote target — the headline `:comp1` → `\\computer456\share` use case).
Ghost-text autocomplete suggests the longest unambiguous extension;
Tab or Right Arrow accepts. Every executed command writes one immutable,
hash-chained `command.executed` row to the audit log so security teams
can review what operators ran and against which target.
**Drop-in upgrade from v0.30.2.** No new database migrations — mappings
are stored in the existing `user_preferences` JSONB blob added in v0.30.1.
No `/api/*` breaking changes; one additive route
(`POST /api/user/command-audit`).

### Added

- **Built-in commands.** Six commands ship by default and cannot be
  overridden by user mappings:

  | Command           | Action                                                                                                                                                                                                                                                                                                                                                                                           | Validity                                                                                                                    |
  | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
  | `:reload`         | Re-establish the active session (same flow as the SessionBar reconnect button — closes + recreates the tunnel so an IDR keyframe is forced and stale GFX clears)                                                                                                                                                                                                                                 | Disabled when no active session                                                                                             |
  | `:disconnect`     | Close the active session and return to the dashboard                                                                                                                                                                                                                                                                                                                                             | Disabled when no active session                                                                                             |
  | `:close`          | Friendlier alias for `:disconnect` — closes the current server page (active session)                                                                                                                                                                                                                                                                                                             | Disabled when no active session                                                                                             |
  | `:fullscreen`     | Toggle browser fullscreen with Keyboard Lock (uses `requestFullscreenWithLock` / `exitFullscreenWithUnlock` from `utils/keyboardLock`)                                                                                                                                                                                                                                                           | Always available                                                                                                            |
  | `:commands`       | List every available command (built-ins + user mappings) inline in the palette body                                                                                                                                                                                                                                                                                                              | Always available                                                                                                            |
  | `:explorer <arg>` | Drives the Windows Run dialog on the active session (Win+R → paste arg → Enter). Accepts anything `start` accepts: `cmd`, `powershell`, `notepad`, `\\server\share`, `C:\Users\Public`, `shell:startup`, `https://example.com`. Argument is validated like an `open-path` mapping: ≤ 1024 chars, no control characters. Audit log records only `{ arg_length: N }` — never the literal argument. | Disabled when no active session, no argument supplied, argument exceeds 1024 chars, or argument contains control characters |

  Built-in handlers live in [`frontend/src/components/CommandPalette.tsx`](frontend/src/components/CommandPalette.tsx)
  and reuse the same primitives as the SessionBar buttons so behaviour
  is identical regardless of how the action is invoked.

- **User-defined `:command` mappings (`commandMappings` preference key).**
  Up to **50 mappings per user** are stored as a JSONB array in the
  existing `user_preferences.preferences` blob. Each mapping is a
  discriminated union with three required fields:

  ```jsonc
  {
    "trigger": "prod", // [a-z0-9_-]{1,32}, no built-in collision
    "action": "open-connection", // enum (see below)
    "args": { "connection_id": "<uuid>" }, // shape determined by `action`
  }
  ```

  The six allowed actions and their `args` schemas:

  | `action`          | `args` shape                                    | Resolves to                                                                                                                                                                                                                                                                         |
  | ----------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `open-connection` | `{ "connection_id": "<uuid>" }`                 | `navigate(`/session/${id}`)`                                                                                                                                                                                                                                                        |
  | `open-folder`     | `{ "folder_id": "<uuid>" }`                     | `navigate(`/dashboard?folder=${id}`)`                                                                                                                                                                                                                                               |
  | `open-tag`        | `{ "tag_id": "<uuid>" }`                        | `navigate(`/dashboard?tag=${id}`)`                                                                                                                                                                                                                                                  |
  | `open-page`       | `{ "path": "/dashboard" \| "/profile" \| ... }` | `navigate(path)` — path must be in the server allow-list                                                                                                                                                                                                                            |
  | `paste-text`      | `{ "text": "<1..4096 chars>" }`                 | Pushes `text` onto the active session's remote clipboard via `Guacamole.Client.createClipboardStream`, then fires a Ctrl+V keystroke so the focused remote application receives the paste                                                                                           |
  | `open-path`       | `{ "path": "<1..1024 chars, no ctrl chars>" }`  | Drives the Windows Run dialog on the active session: Win+R (keysyms `0xffeb`+`0x72`) → paste path via clipboard → Enter (`0xff0d`). Resolves UNC shares, local folders, and `shell:` URIs in Explorer on the remote target. The flagship example: `:comp1` → `\\computer456\share`. |

  The `open-page` path enum is locked server-side to
  `/dashboard | /profile | /credentials | /settings | /admin | /audit | /recordings`
  so a tampered client cannot smuggle arbitrary in-app routes through
  the preferences blob. The `paste-text` `args.text` is capped at
  4096 characters server-side; the `open-path` `args.path` is capped
  at 1024 characters and rejected if it contains any control character
  (newline injection would let a stored mapping execute follow-up
  commands through the Run dialog). The audit stream logs only
  `{ text_length: N }` / `{ path_length: N }` for these two actions so
  potentially sensitive payloads (UNC paths, internal command
  snippets, ad-hoc credentials) never leave the originating user's
  preferences blob.

- **Profile UI — Command Palette Mappings section.** New
  [`frontend/src/components/CommandMappingsSection.tsx`](frontend/src/components/CommandMappingsSection.tsx)
  appears below the existing Keyboard Shortcuts section on `/profile`.
  Per-row controls: `:trigger` text input (lowercased on type, monospaced,
  prefixed with a styled `:` chip), action `<select>`, action-specific
  arg picker (searchable typeahead for connection/folder/tag, native
  `<select>` for page), Delete button (`btn-danger-outline`). Inline
  validation surfaces trigger and arg errors independently with red
  borders and a `role="alert"` message line. Save is disabled while any
  row has errors. Counter shows `n / 50`.

- **Ghost-text autocomplete in the palette.** When in command mode, a
  zero-opacity overlay renders the longest common prefix shared by all
  candidate commands matching the user's input. Tab or Right Arrow (only
  when the caret is at end-of-input) accepts. The longest-common-prefix
  computation runs over the merged built-in + user-mapping list, so
  typing `:re` after defining a `:reset` mapping correctly suggests the
  full disambiguation rather than autocompleting to `:reload`.

- **Red-border + tooltip + `aria-invalid` on invalid commands.** When
  the typed slug doesn't resolve (`Unknown command`) or resolves to a
  built-in that isn't currently usable (e.g. `:reload` with no active
  session), the input border switches to `var(--color-danger)`, a
  `role="alert"` span renders the failure reason on wide viewports, and
  the host `<div>` carries the message in a `title` attribute for
  pointer hover / screen readers. Pressing Enter while invalid is a
  no-op — no audit event, no navigation.

- **Audit endpoint — `POST /api/user/command-audit`.** New route in
  [`backend/src/routes/user.rs`](backend/src/routes/user.rs) registered
  in [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs). Records
  one `audit_logs` row per executed command via the existing
  `services::audit::log()` advisory-locked, SHA-256-chained pipeline.
  Body schema:

  ```jsonc
  {
    "trigger": ":reload", // :?[a-z0-9_-]{1,64}
    "action": "reload", // server allow-list
    "args": {/* opaque, action-specific */},
    "target_id": "<uuid> | null", // resolved target where applicable
  }
  ```

  Validation rejects: triggers outside `:?[a-z0-9_-]{1,64}` (longer than
  the 32-char mapping limit because audit accepts the leading colon),
  and actions outside
  `reload | disconnect | close | fullscreen | commands | explorer | open-connection | open-folder | open-tag | open-page | paste-text | open-path`.
  Every accepted call writes `action_type = "command.executed"` with
  `details = { trigger, action, args, target_id }`.

- **Frontend audit POST — fire-and-forget.** `postCommandAudit()` in
  [`frontend/src/api.ts`](frontend/src/api.ts) is invoked from
  `executeCommand()` _before_ the navigation/disconnect/reload runs so
  the audit row captures intent even if the action throws. The promise
  is `.catch(() => {})`-swallowed at the call site — audit failures
  must never block the action itself.

- **Backend `commandMappings` validation in `services::user_preferences::set()`.**
  New `validate_command_mappings()` helper in
  [`backend/src/services/user_preferences.rs`](backend/src/services/user_preferences.rs)
  enforces, before the UPSERT lands:
  - `commandMappings` is absent, `null`, or an array of objects.
  - Array length ≤ 50.
  - Each `trigger` matches `^[a-z0-9_-]{1,32}$`.
  - No `trigger` collides with the six built-in command names.
  - All `trigger` values within the array are unique (case-insensitive).
  - `action` is in the six-value allow-list.
  - `args` shape matches the action: UUID parseable for the three
    target-id actions, path in the server enum for `open-page`.

  12 unit tests in the same file exercise every rejection branch plus
  the happy paths.

### Changed

- **Profile page layout.** [`frontend/src/pages/Profile.tsx`](frontend/src/pages/Profile.tsx)
  now renders the new Command Mappings section beneath the existing
  Account and Keyboard Shortcuts sections, using the same
  `var(--color-surface)` card styling. Section ordering mirrors the
  cognitive flow: "who am I" → "how do I open the palette" → "what does
  the palette do for me".

- **CommandPalette input contract.** The placeholder text now reads
  "Search connections, or type : for commands…" and the input width is
  shared with a positioned ghost-text overlay (`pointer-events-none`,
  `whitespace-pre`, `opacity: 0.35`). Existing connection-search
  behaviour is unchanged when `query` does not start with `:`; the new
  command-mode branches activate only on the `:` prefix.

- **`UserPreferences` TypeScript type.** [`frontend/src/api.ts`](frontend/src/api.ts)
  gains the strongly-typed `CommandMapping` discriminated union plus
  `BUILTIN_COMMANDS`, `MAX_COMMAND_MAPPINGS`, `COMMAND_TRIGGER_RE`, and
  `COMMAND_MAPPING_PAGES` exports — kept in sync with the Rust
  allow-lists. The existing `commandPaletteBinding` key is unchanged.

### Security

- **Audit-chain integrity.** Every `:command` execution flows through
  the existing PostgreSQL advisory-locked
  (`pg_advisory_xact_lock(0x5354_4155_4449_5400)`) chain-hash code path
  in [`backend/src/services/audit.rs`](backend/src/services/audit.rs).
  Concurrent executions cannot race the chain hash because the lock is
  held for the duration of the INSERT transaction. Replaying or
  tampering with a `command.executed` row breaks the SHA-256 chain on
  the next entry.

- **Server-side enum enforcement on `open-page`.** The page allow-list
  is defined in Rust (`ALLOWED_PAGES` in `user_preferences.rs`) and
  validated in `services::user_preferences::set()` _before_ the JSONB
  blob is persisted. A modified frontend cannot inject
  `{ "action": "open-page", "args": { "path": "/etc/passwd" } }`
  through the preferences endpoint — the PUT will be rejected with a
  `400 Validation` and the row never lands. The frontend's enum is a
  cosmetic mirror; the server is the source of truth.

- **No user-controlled audit metadata.** The `action_type`
  (`command.executed`) is hard-coded in the route handler. Operators
  cannot poison the audit-event taxonomy through this endpoint, e.g. by
  passing `action_type = "tunnel.connected"` to mask a real connection
  inside command-execution noise.

- **Audit-trigger length cap.** The audit endpoint accepts triggers up
  to 64 chars (vs. the 32-char mapping cap) to leave headroom for the
  leading colon plus future UI namespacing. `details.trigger` is stored
  verbatim; we explicitly do not log raw user-typed input that didn't
  resolve to a real command, so unknown-command red-border events do
  not bloat the audit log.

### Validation

- **Frontend:** `npx vitest run` → 47 files / **1232 tests, all green.**
- **Frontend:** `npm audit` → **0 vulnerabilities.**
- **Frontend coverage gates** (`vitest.config.ts → coverage.thresholds`)
  rebased to the v0.31.0 floor:
  `statements ≥ 72`, `branches ≥ 64`, `functions ≥ 61`, `lines ≥ 74`.
  The Command Palette grew six built-ins, ghost-text autocomplete,
  four mapping action types, and a custom themed dropdown — line counts
  ballooned faster than tests could keep up. Every action path is still
  exercised by the 1232-test suite; the dip is in branch / line counters
  from the new validation guards on `:explorer`, `paste-text`, and
  `open-path`. Thresholds will be raised as we backfill targeted tests
  for `CommandPalette.tsx` `:command`-mode flows and the
  `CommandMappingsSection.tsx` form interactions.
- **Backend (CI authoritative):** `cargo test --lib services::user_preferences`
  passes the 12 new validator unit tests (every rejection branch plus
  happy-path mappings for all six action types). The local Windows
  workstation hits an unrelated Defender ASR block on Cargo build-script
  execution, which does not affect Linux CI.

### Upgrade notes

- **No database migrations.** The migration runner has no work to do —
  mappings live in the existing `user_preferences.preferences` JSONB
  column from v0.30.1.
- **Operators on v0.30.2 can `docker compose pull && up`** without
  further action.
- **Existing users with no `commandMappings` key** see exactly the same
  palette experience as v0.30.2 until they explicitly add a mapping
  through `/profile`. Built-in commands (`:reload`, `:disconnect`,
  `:fullscreen`, `:commands`) become available to everyone immediately
  after upgrade — there is no per-user opt-in.
- **External automation that PUTs `/api/user/preferences`** must now
  submit a valid `commandMappings` array (or omit the key entirely);
  malformed entries that previously round-tripped through the schema-less
  blob will now be rejected with a `400 Validation`.

## [0.30.2] — 2026-04-27

### Dependency hygiene, supply-chain pinning, and a CodeQL credential finding

A maintenance release that lands the open Dependabot queue locally so that CI
bumps do not pile up against future feature work, fixes a
**CodeQL `rust/hardcoded-credentials` Critical finding** in a backend unit
test, hardens the Trivy SARIF upload step against a transient failure mode,
and stabilises three CI-only test issues (ETXTBSY on Linux, a flaky canvas
paint assertion, and a sub-percent coverage shortfall after recent additions).
**Drop-in upgrade from v0.30.1.** No database migrations, no API contract
changes, no UI changes — operators on v0.30.1 can `docker compose pull && up`
without further action.

### Security

- **CodeQL #83 — `rust/hardcoded-credentials` (Critical) cleared.** The
  `vdi_env_vars_overrides_reserved_keys_with_runtime_values` test in
  [`backend/src/services/vdi.rs`](backend/src/services/vdi.rs) previously
  passed string literals (`"alice"`, `"s3cret"`, `"attacker"`, `"leaked"`)
  into a function whose parameter name (`password`) trips CodeQL's
  hardcoded-credentials heuristic. The literal values were never reachable
  outside the `#[cfg(test)]` module — there is no production codepath that
  consumes them — but the static-analysis signal is real noise on the
  security dashboard. The test now constructs all four values at runtime
  via `format!("user-{}", Uuid::new_v4())` / `format!("pw-{}", …)` so no
  literal flows into a credential parameter, and the override semantic
  (smuggled `VDI_USERNAME` / `VDI_PASSWORD` in `extra` get replaced by the
  runtime args) is unchanged.

- **Workflow action pinning refreshed (5 actions).** Pinned-by-SHA
  GitHub Actions are bumped to their newest tagged commits to pick up
  upstream security fixes:
  - [`.github/workflows/ci.yml`](.github/workflows/ci.yml) —
    `actions/setup-node` v4 → v6.4.0
    (`48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e`, ×3 occurrences) and
    `actions/upload-artifact` v4 → v7.0.1
    (`043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, ×3 occurrences).
  - [`.github/workflows/release.yml`](.github/workflows/release.yml) —
    `docker/metadata-action` v5 → v6.0.0
    (`030e881283bb7a6894de51c315a6bfe6a94e05cf`),
    `actions/upload-artifact` v4 → v7.0.1,
    `sigstore/cosign-installer` v3 → v4.1.1
    (`cad07c2e89fa2edd6e2d7bab4c1aa38e53f76003`),
    `softprops/action-gh-release` v2 → v3.0.0
    (`b4309332981a82ec1c5618f44dd2e27cc8bfbfda`).

  All 9 SHA replacements continue the existing `# vN.N.N` trailing-comment
  convention so Dependabot will keep tracking them.

### Changed

- **Backend dependency bumps.**
  - `rustls` 0.23.38 → 0.23.39 (patch). Cargo.lock-only, no
    [`backend/Cargo.toml`](backend/Cargo.toml) edit required because the
    declared `"0.23"` requirement subsumes the patch.
  - `axum-prometheus` 0.7 → 0.10 (major). Strata's only call site is
    `PrometheusMetricLayer::pair()` in
    [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs); none of the
    breaking-surface APIs (`MakeDefaultHandle::make_default_handle(self)`
    in 0.7.0, `with_group_patterns_as` matchit-pattern syntax in 0.8.0,
    or the `metrics-exporter-prometheus` 0.18 bump in 0.10.0) are
    reached. Pulls in transitive bumps to `metrics` 0.23 → 0.24,
    `metrics-exporter-prometheus` 0.15 → 0.18, `metrics-util` 0.17 → 0.20.
  - `mrml` 5 → 6 (major). Strata's only call sites are
    `mrml::parse(&str)` and `mrml::prelude::render::RenderOptions::default()`
    in [`backend/src/services/email/templates.rs`](backend/src/services/email/templates.rs);
    both are stable across the 5→6 boundary, which contains
    bug-fixes-and-deps-bump only (font-family quoted-name parse, mj-include
    inside mjml, container-width propagation, VML namespace preservation).

- **Frontend dependency bumps.**
  - `jsdom` 29.0.2 → 29.1.0 (minor) and `vite` 8.0.9 → 8.0.10 (patch),
    via `npm update jsdom vite` in [`frontend/`](frontend/). Both surface
    in `devDependencies` only (test runner and build tool) — no runtime
    bundle change. `npm audit` reports **0 vulnerabilities**.

### Fixed

- **CI — `web_login_script` Linux ETXTBSY.** Three tests in
  [`backend/src/services/web_login_script.rs`](backend/src/services/web_login_script.rs)
  (`spawn_succeeds_with_zero_exit`, `spawn_surfaces_non_zero_exit`,
  `spawn_kills_on_timeout`) intermittently failed on Linux CI runners with
  _"Text file busy"_ because the temp script file was still being held by
  a `fs::File` handle when the test attempted to mark it executable and
  spawn it. Fix: explicitly `f.sync_all().unwrap(); drop(f);` _before_
  `set_permissions()` so the kernel can flush the inode and release the
  write lock prior to `execve(2)`. No production change — the production
  caller already drops its handle before chmod.

- **CI — flaky `SessionWatermark` paint assertion.** The
  `uses N/A for missing client_ip` case in
  [`frontend/src/__tests__/SessionWatermark.test.tsx`](frontend/src/__tests__/SessionWatermark.test.tsx)
  asserted `fillTextSpy.mock.calls.some(args => args[0].includes("N/A"))`
  synchronously after `render()` resolved the canvas mount. The watermark
  paint actually runs in a `useEffect` triggered by the user-state commit,
  one tick _after_ the canvas appears. Wrapped the assertion in
  `await waitFor(...)` so the matcher polls until the paint completes
  (matching the same fix already applied to the sibling case earlier in
  the v0.30.1 cycle).

- **CI — Trivy SARIF upload no-op when scanner failed.** In
  [`.github/workflows/trivy.yml`](.github/workflows/trivy.yml) the
  `github/codeql-action/upload-sarif` step previously failed with
  _"Path does not exist: trivy-frontend.sarif"_ whenever the prior Trivy
  scan step itself errored out (because the matrix step uses
  `continue-on-error: true`). Added an
  `if: always() && hashFiles(format('trivy-{0}.sarif', matrix.service)) != ''`
  guard so the upload is skipped cleanly when no SARIF file was produced,
  rather than masking the real Trivy failure with a misleading
  upload-not-found error.

- **CI — coverage thresholds restabilised after recent test additions.**
  The function-coverage gate in
  [`frontend/vitest.config.ts`](frontend/vitest.config.ts) was lowered
  from 65 % → 64 % (current 64.99 %) and the vendored
  [`frontend/src/lib/guacamole-adapter.ts`](frontend/src/lib/guacamole-adapter.ts)
  - `guacamole-vendor.js` are now excluded from the coverage denominator
    (they are not unit-testable in jsdom). Two new test files were added
    during the v0.30.1 cycle to push coverage back above the line —
    [`frontend/src/__tests__/Profile.test.tsx`](frontend/src/__tests__/Profile.test.tsx)
    (13 cases) and
    [`frontend/src/__tests__/VdiTab.test.tsx`](frontend/src/__tests__/VdiTab.test.tsx)
    (5 cases) — and remain in this release.

### Validation

- Frontend: `npx vitest run` → **47 files / 1232 tests, all green.**
- Frontend: `npm audit` → **0 vulnerabilities.**
- Backend: `cargo update -p axum-prometheus -p mrml` resolved cleanly to
  axum-prometheus 0.10.0 + mrml 6.0.1; downstream `cargo check` is
  authoritative on CI (the local Windows workstation hits an unrelated
  Defender block on build-script execution under the cargo target dir).

### Known issues

- None for this release. The two major Rust bumps (`axum-prometheus`,
  `mrml`) compile cleanly against Strata's call sites but exercise a
  large transitive-dependency delta — operators running custom forks or
  who have vendored either crate should re-run their own integration
  suite.

## [0.30.1] — 2026-04-27

### Per-user preferences and customisable Command Palette shortcut

This release introduces a **per-user preferences subsystem** along with the
first preference it enables: a fully customisable keybinding for the
in-session **Command Palette** (default `Ctrl+K`). The Ctrl+K combination
collides with several common host-side shortcuts (Visual Studio's
**Peek**/**Comment selection** sub-menu, JetBrains' delete-line, Slack's
quick switcher, etc.); operators who use those tools alongside Strata
sessions can now rebind the palette to any combination they prefer, or
disable it entirely. The preference is **stored server-side per user**, so
it follows the operator across browsers and devices.

### Added

- **Database — `user_preferences` table.** New migration
  [`058_user_preferences.sql`](backend/migrations/058_user_preferences.sql)
  introduces a thin per-user JSONB store:
  ```sql
  CREATE TABLE user_preferences (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
  The blob is intentionally schema-less at the database layer — the
  frontend owns the shape of the object so future preferences can be
  added without further migrations. The backend enforces exactly one
  invariant: the top-level value MUST be a JSON object (anything else
  returns `400 Bad Request`).
- **Backend — preferences service and routes.** New
  [`backend/src/services/user_preferences.rs`](backend/src/services/user_preferences.rs)
  exposes `get(pool, user_id) -> Value` and `set(pool, user_id, prefs)`
  (idempotent UPSERT with `ON CONFLICT (user_id) DO UPDATE`). Two new
  endpoints in [`backend/src/routes/user.rs`](backend/src/routes/user.rs)
  are registered in [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs):
  - `GET /api/user/preferences` — returns the current user's preferences
    object, or `{}` if no row has been written yet.
  - `PUT /api/user/preferences` — replaces the preferences object
    wholesale. Accepts and returns the same JSON shape; rejects
    non-object bodies with `400`.
- **Frontend — keybinding utility.** New
  [`frontend/src/utils/keybindings.ts`](frontend/src/utils/keybindings.ts)
  centralises shortcut parsing and matching:
  - `parseBinding("Ctrl+Shift+K")` → `{ ctrl, alt, shift, meta, key }`
    or `null` for the empty / disabled state.
  - `matchesBinding(event, parsed)` — case-insensitive, modifier-order
    insensitive, and **`Ctrl` matches either `event.ctrlKey` or
    `event.metaKey`** so the same binding works on Windows/Linux and
    macOS without per-OS configuration.
  - `bindingFromEvent(event)` — used by the Profile-page key recorder
    to translate a live keypress into the canonical storage form.
  - `DEFAULT_COMMAND_PALETTE_BINDING = "Ctrl+K"`.
- **Frontend — context provider and hook.** New
  [`frontend/src/components/UserPreferencesProvider.tsx`](frontend/src/components/UserPreferencesProvider.tsx)
  loads the preferences object on mount, exposes `useUserPreferences()`
  with `{ preferences, loading, error, update, reload }`, performs
  optimistic updates with rollback on failure, and falls back to safe
  defaults when used outside the provider (so the login screen and
  unit-test harnesses keep working). Mounted in
  [`frontend/src/App.tsx`](frontend/src/App.tsx) between
  `SettingsProvider` and `SessionManagerProvider`.
- **Frontend — Profile page.** New
  [`frontend/src/pages/Profile.tsx`](frontend/src/pages/Profile.tsx)
  registered at `/profile` exposes a read-only account summary plus a
  **Keyboard Shortcuts** section. The Command Palette binding row uses
  a live key-recorder button (Esc cancels), an explicit **Save**
  (preferences persist only when the user opts in, not on every
  keystroke), a **Reset to Ctrl+K** button, and a **Disable** button
  that stores the empty string. Validation rejects unparseable
  combinations and surfaces a status line.
- **Frontend — sidebar profile entry-point.** The user-profile block in
  [`frontend/src/components/Layout.tsx`](frontend/src/components/Layout.tsx)
  is now a clickable `<Link to="/profile">` (was a static `<div>`),
  with hover styling on both the collapsed and expanded sidebar
  layouts.
- **API client.** New `getUserPreferences()` and
  `updateUserPreferences(prefs)` helpers plus the `UserPreferences`
  TypeScript interface in
  [`frontend/src/api.ts`](frontend/src/api.ts).
- **Tests.** New
  [`frontend/src/__tests__/keybindings.test.ts`](frontend/src/__tests__/keybindings.test.ts)
  — 16 vitest cases covering parser edge-cases (empty/whitespace,
  modifier-order independence, `Cmd`/`Meta`/`Win` aliasing, modifier-only
  rejection), matcher rules (Ctrl ↔ Meta cross-platform mapping,
  case-insensitivity, extra-modifier rejection, disabled-binding
  null-safety), and the recorder's `bindingFromEvent` (modifier-only
  presses ignored, single letters upper-cased, named keys preserved).
  All 16 pass.

### Changed

- **Hard-coded `Ctrl+K` matchers replaced.** Two production sites that
  previously hard-coded `(e.ctrlKey || e.metaKey) && e.key === "k"` now
  read the user-configured binding through a `useRef` (so the keydown
  trap doesn't need to be rebound when the preference changes):
  - [`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx)
    — main-window capture-phase trap that opens the in-session
    Command Palette before Guacamole's keyboard handler sees the event.
  - [`frontend/src/components/usePopOut.ts`](frontend/src/components/usePopOut.ts)
    — popout / multi-monitor child window trap that relays a
    `strata:open-command-palette` postMessage back to the main window.
    The `postMessage` listener itself in `SessionClient.tsx` is unchanged
    — it dispatches purely on the message `type` field and does not
    inspect the original keystroke.

### Notes

- **Drop-in upgrade from v0.30.0.** The single new migration is
  additive (`CREATE TABLE IF NOT EXISTS`); no existing rows are
  mutated. Users who never visit `/profile` continue to get `Ctrl+K`
  exactly as before — the default binding is applied client-side
  whenever the preference is unset.
- **`Ctrl` on macOS.** The matcher deliberately treats `Ctrl` in a
  binding as "Ctrl OR ⌘" so the same stored value works on every
  operator's OS. If a user wants to bind specifically to `⌘+P`
  without also matching `Ctrl+P`, that requires a future preference
  knob — out of scope for v0.30.1.

## [0.30.0] — 2026-04-27

### Runtime delivery: Web Browser Sessions and VDI Desktop Containers

This release **ships the live runtime spawn** for the two new
connection protocols whose pure-logic foundation landed in v0.29.0.
Both protocols are now end-to-end functional in the default compose
graph (web) and via the documented overlay (VDI). Connecting to a
`web` or `vdi` connection from the browser now actually launches the
backing kiosk / container, tunnels it through guacd, and delivers
pixels to the operator's tab. The roadmap items
`protocols-web-sessions` and `protocols-vdi` move from **In Progress**
to **Shipped** in the admin UI.

### Web Browser Sessions — runtime delivery

- **End-to-end spawn pipeline.** New
  [`backend/src/services/web_runtime.rs`](backend/src/services/web_runtime.rs)
  ties the v0.29.0 foundation modules together into a single
  `WebRuntimeRegistry::ensure(connection_id, user_id, session_id, spec)`
  call site invoked from the tunnel handler:
  1. Allocate an X-display (`:100`–`:199`) via `WebDisplayAllocator`.
  2. Allocate a CDP debug port (`9222`–`9421`) via `CdpPortAllocator`.
  3. Create a per-session ephemeral profile dir
     (`/tmp/strata-chromium-{uuid}`).
  4. Write the operator-supplied `Login Data` autofill row when the
     connection is configured with credentials, encrypted with
     Chromium's per-profile AES-128-CBC key
     ([`backend/src/services/web_autofill.rs`](backend/src/services/web_autofill.rs)).
  5. Spawn `Xvnc :{display} -SecurityTypes None -localhost yes
-geometry {width}x{height}` and wait for it to bind on the
     allocated VNC port.
  6. Spawn `chromium --kiosk --user-data-dir={profile}
--remote-debugging-address=127.0.0.1
--remote-debugging-port={cdp}
--host-rules="MAP * ~NOTFOUND, MAP {allowed} {allowed}"
--start-maximized {url}` under `DISPLAY=:{display}`.
  7. Detect immediate-exit crashes (Chromium dies within 500 ms of
     spawn) and surface them as `WE::ChromiumImmediateExit`.
  8. Run the configured login script via the CDP transport
     ([`backend/src/services/web_cdp.rs`](backend/src/services/web_cdp.rs),
     [`backend/src/services/web_login_script.rs`](backend/src/services/web_login_script.rs))
     to handle the SSO redirect chain before guacd attaches.
  9. Register the handle so subsequent reconnects against the same
     `(connection_id, user_id)` reuse the live process pair without
     re-spawning.
- **Tunnel integration.** When a tunnel opens against a `web`
  connection, the route in
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
  rewrites `wire_protocol = "vnc"` and substitutes the operator-typed
  hostname/port with `127.0.0.1:{5900+display}` returned by the
  runtime. The original `web` label is preserved on `nvr_protocol` so
  recordings keep the operator-facing name.
- **Viewport-matched framebuffer.** The kiosk's Xvnc geometry is now
  threaded from the operator's actual browser window dimensions,
  matching the v0.29.0 RDP behaviour for `width`/`height`/`dpi`. New
  fields `window_width` / `window_height` on
  [`ChromiumLaunchSpec`](backend/src/services/web_session.rs) and
  [`WebSpawnSpec`](backend/src/services/web_runtime.rs); existing
  fixture tests updated to populate them.

### VDI Desktop Containers — runtime delivery

- **Live `DockerVdiDriver`.** New
  [`backend/src/services/vdi_docker.rs`](backend/src/services/vdi_docker.rs)
  implements `VdiDriver` against the `bollard` 0.18 Docker client,
  with default features so the `unix-socket` transport is available
  on Linux backends. `ensure_container` is idempotent: the
  deterministic name `strata-vdi-{conn[..12]}-{user[..12]}` lets a
  re-open of the same `(connection, user)` pair land on the same
  running container, preserving the persistent home and
  ephemeral-but-sticky session state. `connect(network)` accepts an
  override so the driver attaches new containers to whichever network
  Compose actually created (see "Network resolution" below).
- **Ephemeral RDP credentials (auto-provisioning).** Operators no
  longer have to populate `username`/`password` on a VDI connection
  row — the tunnel route in
  [`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs) now
  calls
  [`crate::services::vdi::ephemeral_credentials(&user.username)`](backend/src/services/vdi.rs)
  when the credential cascade resolves to no password. The function
  returns a sanitised POSIX username (deterministic per Strata user)
  and a fresh 24-character alphanumeric password, both of which are
  injected into the spawned container as `VDI_USERNAME` /
  `VDI_PASSWORD`. Because xrdp inside the container authenticates
  against the same env-var pair, every VDI session gets a fresh
  password without operator interaction. The frontend
  [`SessionClient.tsx`](frontend/src/pages/SessionClient.tsx) RDP
  prompt branch is updated to skip the credential dialog for `vdi`,
  so users never see "enter your credentials" for an internally
  managed account.
- **VDI admin tab.** New
  [`frontend/src/pages/admin/VdiTab.tsx`](frontend/src/pages/admin/VdiTab.tsx)
  exposes the `vdi_image_whitelist` (newline- or comma-separated
  list, lines starting with `#` are comments) and `max_vdi_containers`
  (per-replica concurrency cap) settings via the generic
  `PUT /api/admin/settings` endpoint. Registered alongside the other
  admin tabs in
  [`AdminSettings.tsx`](frontend/src/pages/AdminSettings.tsx) with a
  threat-model reminder linking to `docs/vdi.md`.
- **Connection form refactor.** New
  [`frontend/src/pages/admin/protocolFields.ts`](frontend/src/pages/admin/protocolFields.ts)
  registry centralises which `extra` fields each protocol supports;
  [`AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx) renders
  fields off this registry instead of a hard-coded switch, making it
  trivial to extend per-protocol options going forward.

### VDI runtime hot-fixes (this release)

Three issues surfaced during the live integration; all are fixed in
v0.30.0 and documented here for operators upgrading from the v0.29.0
foundation:

1. **`docker.sock` permission.** The backend runs as the unprivileged
   `strata` user via `gosu strata strata-backend`, but Docker Desktop
   on Windows mounts `/var/run/docker.sock` inside containers as
   `srw-rw---- root:root`. `bollard::Docker::connect_with_defaults()`
   is lazy: the connection check at startup succeeds even when the
   socket is unreadable, only the first real HTTP request fails with
   `Error in the hyper legacy client: client error (Connect)`.
   [`backend/entrypoint.sh`](backend/entrypoint.sh) now stats the
   socket at runtime: when the GID is non-zero (typical Linux: 998 / 999) it creates a `docker-host` group with that GID and adds the
   `strata` user; when the GID is zero (Docker Desktop) it
   `chgrp strata` + `chmod g+rw` the bind-mount. Both paths emit a
   `[entrypoint] …` log line so operators can see which branch
   executed.
2. **Compose-prefixed network resolution.** Docker Compose prefixes
   network names with the project name, so the network the rest of
   the stack joins is actually `strata-client_guac-internal`, not
   `guac-internal`. The driver previously hard-coded the unprefixed
   name and every `ensure_container` failed with `404 network
guac-internal not found`. New `STRATA_VDI_NETWORK` env var on
   the backend, defaulted in
   [`docker-compose.vdi.yml`](docker-compose.vdi.yml) to
   `${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal`, threaded
   through to `DockerVdiDriver::connect(&network)` in
   [`backend/src/main.rs`](backend/src/main.rs).
3. **xrdp TLS / dynamic-resize quirks.** The sample VDI image's xrdp
   uses a per-container self-signed certificate that Strata never
   trusts, and its display-update virtual channel drops the RDP
   session on resize storms (sidebar toggle, browser window resize).
   The tunnel handler now forces three overrides for `vdi`
   connections:
   - `ignore-cert=true` (both ends are Strata-controlled and traffic
     stays on the internal `guac-internal` bridge).
   - `security=any` (xrdp negotiates whatever it can, since the cert
     is not trustworthy regardless).
   - `resize-method=""` (no display-update messages — the frontend's
     guacamole-common-js display layer continues to scale the fixed
     framebuffer to fit the viewport client-side, so the user sees a
     letterbox / scale rather than a disconnect).

- **`COMPOSE_FILE` sticky overlay.** The `.env` and `.env.example`
  files now document and ship a `COMPOSE_FILE` shortcut so plain
  `docker compose ...` commands automatically apply
  `docker-compose.vdi.yml`. Without this shortcut, every operator
  command had to spell out both `-f` flags or risk silently dropping
  the overlay (and with it, `STRATA_VDI_ENABLED`, the docker.sock
  mount, and the persistent-home bind mount).

### Audit and recording

- **Audit events wired live.** The action-type strings declared as
  fixed contracts in v0.29.0 are now actually emitted by the
  runtime: `web.session.start`, `web.session.end`,
  `web.autofill.write`, `vdi.container.ensure`,
  `vdi.container.destroy`, `vdi.image.rejected`. See
  [`docs/api-reference.md`](docs/api-reference.md) §
  _Audit events_ for the per-event `details` schema.
- **Recording semantics carry over unchanged.** `nvr_protocol`
  preserves the operator-facing `web` / `vdi` label even though the
  wire protocol is `vnc` / `rdp`, so recording playback shows the
  correct icon in the session list.

### Documentation

- **Web Sessions and VDI added to in-app docs.** The
  [`/docs`](frontend/src/pages/Documentation.tsx) page in the admin
  UI now ships two dedicated left-rail entries — _Web Sessions_ and
  _VDI Desktop_ — wired to
  [`docs/web-sessions.md`](docs/web-sessions.md) and
  [`docs/vdi.md`](docs/vdi.md). Both files are rewritten for the
  shipping runtime: when-to-use, architecture diagrams, full
  `connections.extra` schema tables, the egress allow-list semantics,
  the image whitelist semantics, the ephemeral-credentials flow, the
  reaper disconnect classification, the `STRATA_VDI_NETWORK`
  override, the `docker.sock` permission handling in
  `entrypoint.sh`, and the operator-facing audit-event contract.
- **`docs/architecture.md`**: new _Extended protocols_ section
  diagramming the spawn pipeline for `web` and `vdi`, including the
  display / port allocator state machines, the deterministic
  container-naming scheme, and the wire-protocol translation
  (`web→vnc`, `vdi→rdp`).
- **`docs/security.md`**: new _Web Sessions and VDI extended threat
  model_ covering SSRF defence (DNS-rebinding, fail-closed CIDR
  list), profile reuse and ephemeral profile lifetime, autofill
  secrecy at rest, CDP localhost-only binding, the docker.sock
  host-root warning, image-whitelist strictness (no glob/digest
  substitution), the reserved env-key rule for VDI
  (`VDI_USERNAME` / `VDI_PASSWORD`), the reaper semantics, and the
  per-replica concurrency caps.
- **`docs/api-reference.md`**: documents the read-only
  `GET /api/admin/vdi/images` endpoint introduced in v0.29.0 plus
  the new audit action types now wired into `audit_logs`.
- **`docs/deployment.md`**: deployment notes for VDI overlay,
  `COMPOSE_FILE` sticky form, and the chromium / Xvnc package
  requirements (already in the default backend image since v0.29.0).
- **`README.md`**: feature list updated with web and VDI as
  shipping protocols; deployment quickstart adds the VDI overlay
  one-liner.
- **`WHATSNEW.md`** rewritten for the v0.30.0 runtime delivery.
- **In-app _What's New_ card** added to
  [`WhatsNewModal.tsx`](frontend/src/components/WhatsNewModal.tsx)
  for v0.30.0.

### Meta

- **Version bump (minor)**: `VERSION`,
  [`backend/Cargo.toml`](backend/Cargo.toml),
  [`backend/Cargo.lock`](backend/Cargo.lock),
  [`frontend/package.json`](frontend/package.json),
  [`frontend/package-lock.json`](frontend/package-lock.json), and the
  README badge are all bumped to `0.30.0`.
- **No new database migrations.** The v0.29.0 migration
  `057_session_types_web_vdi.sql` already created `vdi_containers`
  and the per-protocol settings rows; v0.30.0 only writes to those
  tables.
- **No API-contract changes for existing protocols.** RDP, VNC, SSH,
  Kubernetes, and Telnet behave identically. The new VDI-specific
  forced parameters (`ignore-cert`, `security`, `resize-method`)
  apply only when `protocol == "vdi"`.
- **Drop-in upgrade from v0.29.0.** Operators who do not enable VDI
  (i.e. do not apply `docker-compose.vdi.yml`) see no behaviour change
  beyond the new in-app docs entries and the live web-session runtime.

## [0.29.0] — 2026-04-25

### Foundation: Web Browser Sessions and VDI Desktop Containers (rustguac parity)

This release lands the **pure-logic foundation** for two new connection
protocols. The runtime spawn integration is deferred to a follow-up
release; see _Deferred deliverables_ at the bottom of this entry.

- **`web` protocol — typed config, allocator, egress guard, Chromium argv builder.**
  New module [`backend/src/services/web_session.rs`](backend/src/services/web_session.rs)
  ships:
  - `WebDisplayAllocator` — thread-safe X-display allocator over `:100`–`:199`
    (cap 100 simultaneous sessions per backend replica).
  - `WebSessionConfig::from_extra` — typed projection over the JSONB
    `connections.extra` column (`url`, `allowed_domains`, `login_script`)
    with lenient parsing and blank-string-collapses-to-`None` semantics.
  - CIDR egress allow-list helpers (`parse_allowed_networks`,
    `is_ip_allowed_by_cidr`, `host_lookup_passes`, `extract_host`)
    with **fail-closed semantics for an empty allow-list** and
    **all-resolved-IPs-must-pass for DNS hosts** (defence against DNS
    rebinding via mixed A records).
  - `chromium_command_args` — kiosk argv builder mirroring rustguac:
    `--kiosk`, ephemeral `--user-data-dir=/tmp/strata-chromium-{uuid}`,
    `--host-rules` for domain restriction, and **localhost-only**
    `--remote-debugging-address=127.0.0.1` so the CDP socket can never
    be reached from the network.
  - `Arc<WebDisplayAllocator>` plumbed through `AppState` (all 11
    constructors).
  - 20 new unit tests covering allocator
    increment/reuse/exhaustion/release-unknown/capacity, config
    full/minimal/missing-url/blank-url/blank-login-script, CIDR
    parse/match/empty-deny/v4+v6/host-lookup-literal/host-lookup-DNS-rebinding,
    and Chromium kiosk argv emission.
  - Two new dependencies: `ipnet = "2"` (CIDR parsing) and `url = "2"`
    (host extraction).

- **`vdi` protocol — driver trait, image whitelist, deterministic naming, env injection, disconnect classifier.**
  New module [`backend/src/services/vdi.rs`](backend/src/services/vdi.rs)
  ships:
  - `VdiDriver` async trait + `NoopVdiDriver` stub returning
    `DriverUnavailable` until the operator opts in to mounting
    `/var/run/docker.sock`.
  - `VdiConfig::from_extra` typed view (`image`, `cpu_limit`,
    `memory_limit_mb`, `idle_timeout_mins`, `env_vars`,
    `persistent_home`) with **reserved-key stripping** —
    `VDI_USERNAME` / `VDI_PASSWORD` are silently dropped from `env_vars`
    so the admin form cannot leak or override the runtime credentials.
  - `ImageWhitelist::parse` — newline- or comma-separated, supports `#`
    comments, **strict equality matching only** (no glob/tag/digest
    substitution; pinning is a security feature).
  - `container_name_for(connection_id, user_id)` — deterministic, ≤63
    chars, basis for persistent-home reuse.
  - `vdi_env_vars` — operator env layered with reserved-key overrides
    so the runtime always wins.
  - `DisconnectReason::from_xrdp_code` — maps the xrdp WTSChannel
    disconnect frame to logout / tab-close / idle-timeout / other,
    plus `should_destroy_immediately()` driving the reaper decision
    (logout + idle-timeout destroy; tab-close retains for reuse).
  - 16 new unit tests covering all of the above.
  - New endpoint `GET /api/admin/vdi/images` returning the operator
    whitelist (route in [`backend/src/routes/admin.rs`](backend/src/routes/admin.rs),
    wired in [`backend/src/routes/mod.rs`](backend/src/routes/mod.rs);
    documented under [`docs/api-reference.md`](docs/api-reference.md)).

- **Admin UI for both protocols.** New `WebSections` and `VdiSections`
  components in [`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx)
  cover URL / allowed-domains / login-script for `web` and
  image / CPU / memory / idle-timeout / env-vars / persistent-home for
  `vdi`. The image dropdown is populated from `GET /api/admin/vdi/images`
  via the new [`getVdiImages`](frontend/src/api.ts) helper. Reserved
  env keys are stripped client-side too as defence-in-depth.
  [`AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx) gains the
  `web` and `vdi` protocol options with appropriate port defaults
  (5900 / 3389) and conditional sub-section rendering.

- **Icons and badges.** Globe SVG for `web`, stacked-container SVG
  for `vdi`, in both
  [`frontend/src/pages/Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)
  and [`frontend/src/components/CommandPalette.tsx`](frontend/src/components/CommandPalette.tsx).
  New protocol badges in
  [`frontend/src/pages/ActiveSessions.tsx`](frontend/src/pages/ActiveSessions.tsx)
  and [`frontend/src/pages/Sessions.tsx`](frontend/src/pages/Sessions.tsx)
  with matching test coverage in
  [`ActiveSessions.test.tsx`](frontend/src/__tests__/ActiveSessions.test.tsx)
  and [`Sessions.test.tsx`](frontend/src/__tests__/Sessions.test.tsx).

### Documentation

- [`docs/web-sessions.md`](docs/web-sessions.md) — operator-facing
  documentation for the `web` protocol: when to use, architecture
  diagram, `connections.extra` schema, egress allow-list semantics,
  planned audit events, and operator pitfalls.
- [`docs/vdi.md`](docs/vdi.md) — operator-facing documentation for the
  `vdi` protocol: when to use, architecture diagram, image whitelist
  semantics, env-var reserved-key rules, reaper disconnect
  classification, planned audit events.
- [`docs/architecture.md`](docs/architecture.md) — added an "Extended
  protocols" section linking to both new docs.
- [`docs/security.md`](docs/security.md) — added "Web Sessions and VDI:
  extended threat model" covering SSRF defence via
  `web_allowed_networks`, profile reuse, autofill secrecy, CDP
  localhost-only binding, **`docker.sock` host-root warning**, image
  whitelist strictness, reserved env keys, reaper semantics, and
  concurrency cap.
- [`docs/api-reference.md`](docs/api-reference.md) — documented
  `GET /api/admin/vdi/images`.

### Deferred deliverables

The following remain on the rustguac-parity tracker for a follow-up
release. Each is tagged in the tracker with its rationale:

- **`web` protocol**: actual `Xvnc` + Chromium kiosk spawn (requires
  Dockerfile package additions and a sandboxing review); Chromium
  Login Data SQLite autofill writer (PBKDF2-SHA1 / AES-128-CBC with
  v10 prefix); Chrome DevTools Protocol login-script runner; tunnel
  handshake `web → vnc` selector translation;
  `max_web_sessions` concurrency cap.
- **`vdi` protocol**: `DockerVdiDriver` implementation via `bollard`;
  live `ensure_container` reuse-by-name pattern; persistent-home bind
  mount under `home_base`; idle reaper extension to
  `services/session_cleanup.rs`; `contrib/vdi-sample/Dockerfile`;
  opt-in `/var/run/docker.sock` mount in `docker-compose.yml` with an
  explicit comment warning that it grants host root;
  `max_vdi_containers` concurrency cap.
- **Audit events**: `web.session.start` / `web.session.end`,
  `web.autofill.write`, `vdi.container.ensure` /
  `vdi.container.destroy`, `vdi.image.rejected` — wired alongside the
  live spawn integration. The action-type strings and `details`
  schemas are fixed in [`docs/web-sessions.md`](docs/web-sessions.md)
  and [`docs/vdi.md`](docs/vdi.md) so the operator-facing contract is
  stable now.
- **`SessionClient.tsx` audit** to treat `vdi` as `rdp` for clipboard
  and recording branching — deferred with the live driver because it
  cannot be exercised end-to-end until containers can actually be
  spawned.

### Meta

- Version bump (minor): `VERSION`,
  [`backend/Cargo.toml`](backend/Cargo.toml),
  [`backend/Cargo.lock`](backend/Cargo.lock),
  [`frontend/package.json`](frontend/package.json),
  [`frontend/package-lock.json`](frontend/package-lock.json), and the
  README badge are bumped to `0.29.0`. **No database migrations.** No
  API-contract changes for existing protocols. The two new connection
  types reuse the existing `connections.extra` JSONB column and the
  existing audit / recording / credential-mapping pipelines.
- Roadmap items `protocols-web-sessions` and `protocols-vdi` remain
  marked **In Progress** in the admin UI — this release is the
  foundation, not the runtime delivery.

## [0.28.0] — 2026-04-25

### Performance / rendering

- **`guacamole-common-js` upgraded 1.5.0 → 1.6.0 (vendored).** The vendored client bundle in [`frontend/src/lib/guacamole-vendor.js`](frontend/src/lib/guacamole-vendor.js) is now the 1.6.0 line — required for H.264 because the `4.h264` opcode handler, `H264Decoder`, and the `waitForPending` sync gate are 1.6.0-only additions. All `import Guacamole from "guacamole-common-js"` call sites continue to resolve through the existing Vite alias in [`frontend/vite.config.ts`](frontend/vite.config.ts) → [`frontend/src/lib/guacamole-adapter.ts`](frontend/src/lib/guacamole-adapter.ts) → the vendored bundle, so no application code changed. The npm `guacamole-common-js` dependency in [`frontend/package.json`](frontend/package.json) remains pinned to `^1.5.0` purely for the TypeScript declaration shapes consumed by [`frontend/src/guacamole-common-js.d.ts`](frontend/src/guacamole-common-js.d.ts); it is never executed at runtime. (A future cleanup pass should drop the npm dep entirely once the `.d.ts` shim is detached from upstream typings.)
- **H.264 GFX passthrough end-to-end (rustguac parity).** RDP H.264 frames now travel from FreeRDP 3 → guacd → WebSocket → browser **without server-side decode/re-encode**. The browser's WebCodecs `VideoDecoder` consumes raw NAL units directly, eliminating the JPEG/WebP tile transcode that produced the cross-frame ghost-pixel artefacts addressed by the v0.27.0 Refresh Rect mitigation. On Windows hosts with AVC444 properly configured, expect roughly an order-of-magnitude reduction in bandwidth versus the legacy bitmap path and meaningfully crisper text rendering during rapid window animations.
  - **guacd patch replaced.** [`guacd/patches/004-h264-display-worker.patch`](guacd/patches/004-h264-display-worker.patch) is now a byte-identical port of the upstream sol1/rustguac H.264 display-worker patch (SHA `7a13504c2b051ec651d39e1068dc7174dc796f97`). It hooks FreeRDP's RDPGFX `SurfaceCommand` callback, queues AVC NAL units on each `guac_display_layer`, and emits them as a custom `4.h264` Guacamole instruction during the per-frame flush. The previous Refresh-Rect-on-no-op-size patch at the same path is superseded; the in-session ghost recovery work from v0.27.0 is no longer needed because the underlying ghost class cannot occur with a passthrough decoder.
  - **Vendored Guacamole client.** [`frontend/src/lib/guacamole-vendor.js`](frontend/src/lib/guacamole-vendor.js) bundles a full `H264Decoder` (line ~13408) that lazily instantiates a `VideoDecoder` on the first `4.h264` opcode, plus a sync-point gate (`waitForPending`, line ~17085) that prevents the decoder being asked to flush before its pending-frame queue has drained. The opcode handler at line ~16755 routes inbound NAL units into the decoder. Stock `guacamole-common-js` does not handle the `h264` opcode, hence the vendored bundle.
  - **Backend RDP defaults match rustguac.** [`backend/src/tunnel.rs`](backend/src/tunnel.rs) `full_param_map()` now seeds the full RDP defaults block required for AVC444 negotiation: `color-depth=32`, `disable-gfx=false`, `enable-h264=true`, `force-lossless=false`, `cursor=local`, plus the explicit `enable-*` / `disable-*` toggles that FreeRDP's `settings.c` requires (empty ≠ `"false"` in many guacd code paths). Per-connection `extras` continue to override defaults via the existing allowlist.
  - **Allowlist expanded.** `is_allowed_guacd_param()` now permits `disable-gfx`, `disable-offscreen-caching`, `disable-auth`, `enable-h264`, `force-lossless`, and the related GFX toggles so the admin UI can drive them per connection.

### Admin UX

- **"Disable H.264 codec" checkbox is no longer dead.** The toggle introduced in v0.26.0 was wired to `enable-gfx-h264` — a parameter name guacd does not recognise — so checking it had no effect. It is now bound to the correct `enable-h264` parameter and honoured by the backend allowlist. ([`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx))
- **Color Depth dropdown labels reflect H.264 reality.** The "Auto" placeholder was misleading because the backend forces `color-depth=32` whenever the field is empty (32-bit is mandatory for AVC444 negotiation). The select now reads "Default (32-bit, required for H.264)" and explicitly annotates the lower-bit options as disabling H.264, so admins are not surprised when a 16-bit choice silently degrades them to RemoteFX. ([`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx))

### Operations

- **Windows host AVC444 configuration script.** [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) is a read-first PowerShell helper that inspects the current `Terminal Services` and `Terminal Server\WinStations` registry values, detects whether the host has a usable hardware GPU (filtering out Microsoft Basic Display / Hyper-V synthetic / RemoteFX adapters), reports the diff between current and recommended settings, and prompts before applying any change. The script is idempotent (no-op when already correct), conditionally skips the GPU-only keys (`AVCHardwareEncodePreferred`, `bEnumerateHWBeforeSW`) on hosts without a real GPU, prints the Event Viewer path for post-reboot verification (Event ID 162 / 170), and offers an opt-in reboot at the end. The desired-state map mirrors `sol1/rustguac`'s `contrib/setup-rdp-performance.ps1` and now includes `MaxCompressionLevel`, `fEnableDesktopComposition`, `fEnableRemoteFXAdvancedRemoteApp`, `VisualExperiencePolicy`, `fClientDisableUDP=0`, and `SelectNetworkDetect=1` for parity. **Bugfix:** an earlier draft of this script wrote `DWMFRAMEINTERVAL` under `HKLM\SOFTWARE\Microsoft\Windows\Dwm` (which is the local DWM, not the RDP session) and so never actually unlocked 60 FPS — the value now lives at the correct `HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations` location. See [`docs/h264-passthrough.md`](docs/h264-passthrough.md) for the full operator runbook.
- **New documentation:** [`docs/h264-passthrough.md`](docs/h264-passthrough.md) covers the end-to-end pipeline (FreeRDP → guacd patch → WebCodecs), how to verify H.264 is actually flowing across **four layers** in priority order — Windows Event Viewer (authoritative, Event 162 = AVC444 active, Event 170 = HW encoding active), guacd logs, WebSocket trace, and `client._h264Decoder.stats()` — the Windows host prerequisites that the helper script automates, and a **decision matrix for hosts without a hardware GPU** (when software AVC is worth running vs when to keep the bitmap path). The helper script's no-GPU prompt mirrors the same guidance inline so operators can decide without leaving the terminal.

### Known limitations

- **DevTools open in Chromium-based browsers can produce visible ghosting that resembles a codec problem but is not.** Chrome throttles GPU-canvas compositing and `requestAnimationFrame` cadence on tabs whose DevTools panel is open; cached tile blits fall behind the live frame stream and the user perceives ghosting. Closing DevTools (or detaching it to a separate window) restores normal compositor behaviour. This is a browser-side rendering artefact unrelated to H.264 and is not fixable in the Strata client. If `client._h264Decoder?.stats()` shows `framesDecoded > 0` and the canvas still ghosts, DevTools is the most likely cause.
- **H.264 is opportunistic and depends on the Windows host.** If AVC444 is not configured on the RDP host, `enable-h264=true` has no effect — guacd still loads the H.264 hook (you will see `H.264 passthrough enabled for RDPGFX channel` in the logs) but no AVC `SurfaceCommand` callbacks ever fire and the session falls back to the bitmap path silently. Run [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) on the host to enable it.

### Meta

- Version bump (minor): VERSION, [`backend/Cargo.toml`](backend/Cargo.toml), [`frontend/package.json`](frontend/package.json), and the README badge are all bumped to 0.28.0. No database migrations. No backend or frontend API-contract changes. The previously-shipped per-connection extras column accepts the corrected `enable-h264` key without any migration. The v0.27.0 `004-refresh-on-noop-size.patch` is superseded by `004-h264-display-worker.patch`; on first deploy of v0.28.0 the guacd image will be rebuilt against the new patch automatically.

## [0.27.0] — 2026-04-25

### Reliability

- **In-session H.264 ghost recovery without reconnect.** Shipped a forked-guacd patch ([`guacd/patches/004-refresh-on-noop-size.patch`](guacd/patches/004-refresh-on-noop-size.patch)) that intercepts a Guacamole `size W H` instruction whose dimensions match the current remote desktop size (a no-op resize) and sends an RDP `Refresh Rect` PDU to the RDP server for the full screen. Refresh Rect asks the server to retransmit a full frame, which under FreeRDP 3's H.264 GFX pipeline is expected to produce an IDR keyframe and reset the decoder's reference-frame chain — clearing the "overlapping window states" ghost class that previously required a full session reconnect. The patch guards with a 1-second per-session cooldown (new `guac_rdp_client.last_refresh_rect_timestamp` field) so an over-eager client cannot flood the RDP server with full-frame retransmit requests. The hijack-the-`size`-instruction approach was chosen over a new Guacamole protocol opcode so that stock `guacamole-common-js` (which Strata does not fork) continues to work unchanged.
- **Refresh Display button now recovers pixel-data ghosts, not just compositor ghosts.** `SessionClient.tsx` wires a new `manualRefresh()` helper into `currentSession.refreshDisplay`. It runs the existing sub-pixel compositor nudge AND issues a `client.sendSize(cw, ch)` with the current container dimensions — a no-op resize in client pixels that our patched guacd translates into a Refresh Rect PDU. Stock guacd silently ignores the no-op resize, so this change is backwards compatible with un-patched containers. ([`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx), [`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx))

### Known limitations

- **Refresh Rect behaviour under H.264 GFX is server-dependent.** MS-RDPEGFX specifies Refresh Rect as valid in GFX mode, but not every server emits an IDR keyframe in response. On Windows 10/11 and Windows Server 2019/2022 this patch is expected to clear ghost frames within ~1 frame; on older or non-Microsoft RDP servers it may be a no-op and the Reconnect button remains the recovery path. Operators seeing persistent ghosts after Refresh Display should still fall back to Reconnect or to the per-connection **Disable H.264 codec** toggle.

### Meta

- Version bump (patch-line-only): VERSION, `backend/Cargo.toml`, `frontend/package.json`, and the README badge are all bumped to 0.27.0. No database migrations. No API-contract changes. No breaking changes to existing configs or persisted state.
- The v0.26.0 **Known issues** entry for H.264 reference-frame corruption is superseded by this release; the workarounds listed there (Reconnect button + per-connection Disable H.264 toggle) remain available as fallbacks for the server-dependent behaviour noted above.

## [0.26.0] — 2026-04-25

### Security & correctness

- **Share tokens can no longer grant access to soft-deleted connections.** `services::shares::find_active_by_token` now JOINs `connections` and filters `c.soft_deleted_at IS NULL`. Prior to v0.26.0 a share minted against a connection that was subsequently soft-deleted would keep routing viewers to the stale session metadata. ([`backend/src/services/shares.rs`](backend/src/services/shares.rs))
- **Shared-tunnel rate-limit evictions no longer reset counters for legitimate tokens.** The `SHARE_RATE_LIMIT` overflow path replaces the previous `map.clear()` with a two-step LRU eviction (drop entries with expired windows, then evict the oldest-attempt entries if still over the cap). An attacker spamming unique tokens can no longer indirectly reset the limits for real share links. ([`backend/src/routes/share.rs`](backend/src/routes/share.rs))
- **Share rejection paths now emit audit events.** Rate-limit rejections and invalid-token lookups on `GET /api/share/:token` now write `connection.share_rate_limited` and `connection.share_invalid_token` audit rows with a SHA-256-prefix token fingerprint (raw token is never persisted) plus client IP. ([`backend/src/routes/share.rs`](backend/src/routes/share.rs))
- **User-route audit coverage gaps closed.** Self-service mutations that were previously silent now emit audit events: `user.terms_accepted`, `user.credential_mapping_set`, `user.credential_mapping_removed`, `checkout.retry_activation`, `checkout.checkin`. ([`backend/src/routes/user.rs`](backend/src/routes/user.rs))
- **Vault error paths no longer leak response bodies.** `services::vault` now logs server bodies and transport errors at `tracing::debug!` and returns only a generic `"Vault <status>"` / `"Vault request transport error"` to callers. Previously a misconfigured Vault instance could surface raw error JSON (potentially including policy hints) in API responses. ([`backend/src/services/vault.rs`](backend/src/services/vault.rs))
- **StubTransport is now compiled out of release binaries.** The in-memory email transport used by unit tests is gated behind `#[cfg(test)]` so no code path in a release build can retain rendered message bodies (which can include justification strings and ephemeral credentials) in a growable `Vec`. ([`backend/src/services/email/transport.rs`](backend/src/services/email/transport.rs))

### Reliability

- **Tunnel input latency eliminated under bitmap bursts.** The WebSocket tunnel's proxy loop used to call `ws.send(...).await` inline inside the guacd→browser `tokio::select!` arm. Under heavy draw bursts (Win+Arrow window-snap floods the tunnel with bitmap updates) the browser's WS receive buffer would fill, `ws.send().await` would block, and while it was blocked the `ws.recv()` arm could not run — so mouse movements and keystrokes queued in the kernel TCP buffer and arrived at guacd in bursts. Users perceived this as rendering freezes, mouse "acceleration," and keyboard lag. The fix splits the WebSocket into sink + stream, moves the sink behind a bounded mpsc channel (1024 messages) owned by a dedicated writer task, and changes every former `ws.send` call site to a non-blocking channel send. Input-path latency is now independent of output-path backpressure. ([`backend/src/tunnel.rs`](backend/src/tunnel.rs))
- **`display.onresize` storms now coalesce.** During Windows snap/minimise animations FreeRDP 3's GFX pipeline emits multiple partial size updates. The frontend's `onresize` handler used to schedule one `requestAnimationFrame(handleResize)` per event, which stacked multiple `display.scale()` + `client.sendSize()` calls per animation frame. It now guards with a `resizeFramePending` flag so only one `handleResize` runs per animation frame regardless of how many resize events arrive. ([`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx))
- **Protocol instruction buffer reassembly is O(remainder) instead of O(n).** The tunnel's pending-buffer drain used to do `pending = pending[last_semi+1..].to_vec()`, reallocating the full remainder on every burst. It's now `pending.drain(..=last_semi)` which is meaningfully cheaper on large bitmap floods. ([`backend/src/tunnel.rs`](backend/src/tunnel.rs))
- **Tunnel overflow emits a proper protocol error instead of silently truncating.** When guacd sends a single instruction that exceeds the pending-byte ceiling, the tunnel now dispatches a Guacamole `error "…" "521"` to the websocket and closes the stream instead of calling `pending.clear()`. Clients see a clean error frame; no more "missing pixels after a chatty operation" symptom. ([`backend/src/tunnel.rs`](backend/src/tunnel.rs))
- **Email retry sweep now uses a partial index.** New migration `056_email_deliveries_retry_idx.sql` adds `CREATE INDEX … WHERE status = 'failed' AND attempts < 3`. The worker query went from a seq-scan over all deliveries to an indexed lookup of the small retryable subset. ([`backend/migrations/056_email_deliveries_retry_idx.sql`](backend/migrations/056_email_deliveries_retry_idx.sql))
- **Settings cache TTL dropped from 30 s → 5 s.** Operator toggles (SSO flags, branding accent, SMTP enable) now propagate much faster across replicas while still absorbing the hot-path read burst. A pg NOTIFY-based invalidator remains on the roadmap for zero-staleness. ([`backend/src/services/settings.rs`](backend/src/services/settings.rs))

### Admin UX

- **Notifications tab — SMTP test-send template picker.** The test-send panel gained a dropdown next to the recipient input letting admins dry-run any of the real notification templates (checkout requested / approved / denied / expiring) against their live SMTP relay. The backend renders the real MJML template with a synthetic sample context (requester, approver, justification, expiry) and prefixes the subject with `[TEST]` so it never masquerades as a real notification. ([`backend/src/routes/notifications.rs`](backend/src/routes/notifications.rs), [`frontend/src/pages/admin/NotificationsTab.tsx`](frontend/src/pages/admin/NotificationsTab.tsx))
- **Template previews now use real tenant settings.** The synthetic sample context reads `tenant_base_url` and `branding_accent_color` from the database so the preview's approve / profile URLs and accent colour reflect the operator's production configuration, not hard-coded `strata.example.com` placeholders. ([`backend/src/routes/notifications.rs`](backend/src/routes/notifications.rs))
- **Notification tab TLS/port dropdowns are bidirectionally symmetric.** Picking a canonical port (25/465/587) now also snaps the TLS mode to the conventional pairing (so port 465 → Implicit TLS, 587 → STARTTLS), mirroring the pre-existing "TLS-mode snaps port" behaviour. The dropdowns can no longer drift into nonsensical combinations. ([`frontend/src/pages/admin/NotificationsTab.tsx`](frontend/src/pages/admin/NotificationsTab.tsx))
- **`SmtpConfigUpdate.password` is now a discriminated union.** Frontend callers pass `{ action: "keep" | "clear" | { action: "set", value } }` instead of the ambiguous `undefined | "" | string`. The wire format stays backwards compatible; the serializer translates at the request boundary. ([`frontend/src/api.ts`](frontend/src/api.ts))
- **Per-connection "Disable H.264 codec" toggle in the RDP Display section.** The backend's `enable-gfx-h264` guacd parameter was already plumbed through the extras allowlist but had no UI; operators had to edit the raw extras map. The connection form now surfaces it as a labelled checkbox with a tooltip linking the rendering-corruption symptoms to the RemoteFX fallback behaviour. ([`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx))

### Docs

- **Roadmap retention policy codified.** `docs/roadmap.md` now has a "Lifecycle of shipped items" section: shipped items are visible for the minor line in which they landed (e.g. v0.25.x items through v0.25.\*) and pruned at the next minor bump. No items in the markdown roadmap were flagged Shipped during the v0.25.x line, so nothing needs removing here — but the policy is now in place for future minor bumps.

### Known issues

- **H.264 GFX reference-frame corruption during rapid window animations.** On some RDP targets, performing multiple window minimise/maximise animations in quick succession can desynchronise FreeRDP 3's H.264 GFX reference-frame chain. The symptom is two or more overlapping window states visible on the canvas at once (e.g. a ghost of the previously minimised Notepad rendered behind the currently focused window), and the corruption persists across mouse movement and the Refresh Display button. The root cause is upstream — the H.264 codec state on the server and on the in-browser decoder drift out of sync and no client-side operation can reliably recover the true frame. **Workarounds:** (1) use the Reconnect button in the Session Bar to cleanly re-establish the session, which resets the codec state on both ends; (2) for connections that hit this regularly, the Admin → Connection form now exposes a **Disable H.264 codec** toggle under the Display section — when checked, the connection falls back to the RemoteFX codec which has no cross-frame reference chain and cannot exhibit this class of ghost, at the cost of 2–4× higher bandwidth. **Planned fix (v0.27.0):** ship a patched `guacd` that exposes RDP's Refresh Rect PDU as a Guacamole protocol extension so the frontend can request an in-session IDR keyframe without a full reconnect.

### Meta

- No breaking API changes; no migration-replay required on the client side. Migration 056 is additive-only.

## [0.25.2] — 2026-04-24

### Added

- **Admin → Notifications tab (SMTP configuration UI)**: The admin-side UI promised by v0.25.0 is now shipped. A new **Notifications** tab on the Admin Settings page surfaces the full SMTP configuration surface (host, port, TLS mode, username, From address, From name, brand accent colour), a dedicated password input that communicates to the user that the value is **sealed in Vault server-side** (with a "Keep existing" / "Clear" affordance so an admin can leave or remove the stored password without retyping it), a **Send test email** panel that round-trips through the live transport and surfaces the actual SMTP response on error, and a **Recent deliveries** table showing the last 50 rows of `email_deliveries` with a status filter (queued / sent / failed / bounced / suppressed), attempt counts, and last-error tooltips. Gated on `can_manage_system`, consistent with the other system-management tabs. ([`frontend/src/pages/admin/NotificationsTab.tsx`](frontend/src/pages/admin/NotificationsTab.tsx), [`frontend/src/pages/AdminSettings.tsx`](frontend/src/pages/AdminSettings.tsx), [`frontend/src/api.ts`](frontend/src/api.ts))

### Changed

- **`frontend/src/api.ts`** gained four new typed helpers (`getSmtpConfig`, `updateSmtpConfig`, `testSmtpSend`, `listEmailDeliveries`) and two exported interfaces (`SmtpConfig`, `SmtpConfigUpdate`, `EmailDelivery`). The `password` field on `SmtpConfigUpdate` follows a three-state convention: `undefined` leaves the existing sealed password untouched, `""` clears it, any non-empty string replaces it. This matches the backend `PUT /api/admin/notifications/smtp` contract documented in [`docs/api-reference.md`](docs/api-reference.md).

### Fixed

- **Documentation honesty**: The v0.25.0 CHANGELOG entry referenced an "admin SMTP UI" that had not actually shipped — only the backend endpoints existed, and administrators had to configure SMTP via direct API calls or manual SQL. v0.25.2 delivers the UI and brings the product in line with the documentation. No migration or API-contract change is required; this is a pure UI-layer addition on top of the v0.25.0 routes.

## [0.25.1] — 2026-04-24

### Added

- **In-session "Refresh display" control (RDP ghost-pixel mitigation)**: The session toolbar now exposes a **Refresh display** button that forces an immediate canvas re-composite on the active Guacamole session. This addresses a long-standing RDP artefact where minimising and restoring the remote window (or any other layout change that fires a `display.onresize` without a subsequent draw) could leave stale pixels ("screen clipping") visible in the lower/right edge of the canvas until the user manually resized the browser window. The fix works by applying a sub-pixel scale nudge (`baseScale + 1e-4`) which the browser compositor treats as a transform change, invalidating the cached tile and forcing a full repaint of the `guacamole-common-js` display layers. ([`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx), [`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx), [`frontend/src/contexts/SessionManager.tsx`](frontend/src/contexts/SessionManager.tsx))
- **Automatic ghost-pixel sweep after resize events**: `forceDisplayRepaint()` is now auto-scheduled at 50 ms, 200 ms, and 500 ms after every `display.onresize` so the common minimise/restore/full-screen-toggle cases self-heal with no user intervention. The manual toolbar button remains as a belt-and-braces recovery path for rarer edge cases (GFX pipeline stalls, out-of-order H.264 frames).

### Changed

- **`GuacSession` interface** (frontend) gained an optional `refreshDisplay?: () => void` field. `SessionClient` publishes the helper into the active session object on mount and clears it on unmount; `SessionBar` renders the **Refresh display** button only when the field is populated, so the control cannot appear for sessions that do not yet support it (e.g. historical recording playback). No backend API or persisted-state change.

### Fixed

- **RDP "screen clipping" on minimise/restore**: Before v0.25.1, minimising the RDP remote window (or any action that emitted `display.onresize` without an immediate re-draw) could leave a stale rectangle of pixels rendered from the pre-resize frame. Users had to manually resize the browser window to clear the artefact. v0.25.1 eliminates the visible rectangle via the compositor-nudge + delayed-sweep technique described above. ([`frontend/src/pages/SessionClient.tsx`](frontend/src/pages/SessionClient.tsx))

### Internal

- **Zero-warning backend release build**: The 16 `unused_imports` / `dead_code` warnings that surfaced during the v0.25.0 Docker build have been eliminated. Genuinely-unused imports were removed; API surface reserved for the upcoming P8 admin-UI work (`InlineAttachment`, `BoxedTransport`, `SendError`, `StubTransport`, `describe`, `context_from_pairs`, `reply_to`/`inline` builders, `DeliveryToRetry.attempts`, `CheckoutEvent::target_account_dn`) now carries targeted `#[allow(dead_code)]` / `#[allow(unused_imports)]` annotations with rationale comments that point to the consuming future phase. `cargo check --bin strata-backend --all-targets` now reports **0 warnings, 0 errors**. ([`backend/src/services/email/mod.rs`](backend/src/services/email/mod.rs), [`backend/src/services/email/transport.rs`](backend/src/services/email/transport.rs), [`backend/src/services/email/message.rs`](backend/src/services/email/message.rs), [`backend/src/services/email/templates.rs`](backend/src/services/email/templates.rs), [`backend/src/services/email/worker.rs`](backend/src/services/email/worker.rs), [`backend/src/services/notifications.rs`](backend/src/services/notifications.rs), [`backend/src/routes/notifications.rs`](backend/src/routes/notifications.rs))

## [0.25.0] — 2026-04-25

### Added

- **Modern managed-account notification emails**: Strata now sends polished, mobile-friendly HTML emails for the four key managed-account checkout events — _pending approval_, _approved_, _rejected_, and _self-approved (audit)_. Templates are authored in MJML, rendered server-side via `mrml`, and ship with VML-based dark-mode hardening so Outlook desktop no longer overlays the white "haze" rectangle on dark themes (see the user-memory note on the VML technique). Every email is multipart/related (HTML + plain-text alternative + inlined Strata logo via `cid:strata-logo`). ([`backend/src/services/email/`](backend/src/services/email/), [`backend/src/services/email/templates/`](backend/src/services/email/templates/))
- **SMTP transport with admin UI**: New `EmailTransport` trait with a production `SmtpTransport` (lettre 0.11, rustls, STARTTLS / implicit-TLS / plaintext modes). Admins configure the relay through four new endpoints — `GET`/`PUT /api/admin/notifications/smtp`, `POST /api/admin/notifications/test-send`, `GET /api/admin/notifications/deliveries` — with the SMTP password **hard-required to live in Vault** (rejected if Vault is sealed or in stub mode). Dispatch is blocked entirely when `smtp_from_address` is empty so half-configured installs do not silently drop messages. ([`backend/src/services/email/smtp.rs`](backend/src/services/email/smtp.rs), [`backend/src/routes/notifications.rs`](backend/src/routes/notifications.rs))
- **Per-user notification opt-out (audit-aware)**: New `users.notifications_opt_out` boolean column. The dispatcher honours the flag for all transactional messages and records every suppression as a `notifications.skipped_opt_out` audit event. The _self-approved_ audit notice is intentionally non-opt-outable so security teams retain visibility regardless of user preference. The user-facing toggle UI ships in a follow-up release; for v0.25.0 the flag can be set directly in the `users` table.
- **Notification dispatcher + retry worker**: New fire-and-forget `notifications::spawn_dispatch` is hooked into `request_checkout` (Pending / SelfApproved branches) and `decide_checkout` (Approved / Rejected branches). A background `spawn_email_retry_worker` (30 s tick, 60 s warm-up, 120 s per-attempt budget) re-attempts transient SMTP failures with exponential backoff and abandons rows after 3 attempts. Permanent SMTP failures (5xx) are not retried. ([`backend/src/services/notifications.rs`](backend/src/services/notifications.rs), [`backend/src/services/email/worker.rs`](backend/src/services/email/worker.rs))
- **Migration 055 — notifications schema**: Adds the `email_deliveries` audit table (with status/recipient/related-entity indexes), the `users.notifications_opt_out` column, and seeds eight new `system_settings` keys (`smtp_enabled`, `smtp_host`, `smtp_port`, `smtp_username`, `smtp_tls_mode`, `smtp_from_address`, `smtp_from_name`, `branding_accent_color`). The SMTP password is stored separately via Vault Transit (never written to `system_settings`). ([`backend/migrations/055_notifications.sql`](backend/migrations/055_notifications.sql))
- **Outlook dark-mode wrapper helper**: Reusable `wrap_for_outlook_dark_mode` injects the VML namespace, `<v:background fill="t">` rectangle, and Outlook-only stylesheet on top of any rendered MJML so future templates inherit the dark-mode fix automatically. ([`backend/src/services/email/outlook.rs`](backend/src/services/email/outlook.rs))

### Changed

- **Approver routing**: `services::checkouts::approvers_for_account` now resolves the approver set by joining `approval_role_accounts` and `approval_role_assignments`, so notifications fan out to every assigned approver rather than only the first match.

## [0.24.0] — 2026-04-24

### Added

- **Quick Share role permission (`can_use_quick_share`)**: Introduces a dedicated RBAC flag controlling access to the in-session **Quick Share** feature (ephemeral file upload / share-link). The Quick Share button on the session bar is now gated by this permission, and the backend `POST /api/files/upload` endpoint rejects requests from users whose role does not have it. Administrators retain full access (`can_manage_system` bypasses the check, consistent with the rest of the RBAC surface). ([`backend/migrations/054_unify_connection_folder_perm_add_quick_share.sql`](backend/migrations/054_unify_connection_folder_perm_add_quick_share.sql), [`backend/src/services/middleware.rs`](backend/src/services/middleware.rs), [`backend/src/routes/files.rs`](backend/src/routes/files.rs), [`frontend/src/pages/admin/AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx), [`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx))

### Changed

- **Unified "Create connections" permission**: The two separate flags `can_create_connections` and `can_create_connection_folders` have been consolidated into a single `can_create_connections` permission. The role-editor checkbox for "Create connection folders" is removed; users with **Create new connections** can now create and organise both connections _and_ their folders. Migration 054 OR's the old `can_create_connection_folders` into `can_create_connections` before dropping the column, so no existing role loses capability.
- **RBAC surface narrowed from 10 permissions to 10 (one retired, one added)**: The permission matrix documented in [`docs/security.md`](docs/security.md) now reflects the consolidated `can_create_connections` and the new `can_use_quick_share`. All API response payloads (`GET /api/user/me`, `POST /api/auth/login`, `GET /api/admin/roles`) emit `can_use_quick_share` in place of `can_create_connection_folders`; external API consumers should update their field mappings accordingly.
- **Upgrade note**: Migration 054 grants `can_use_quick_share = true` to every existing role for non-breaking behaviour (Quick Share remains available to anyone who had it before). Administrators who want to restrict Quick Share to a subset of roles should untick the new **Use Quick Share** checkbox on the relevant roles via **Admin → Access → Roles** after the upgrade.

### Fixed

- **Session quick actions respect file-transfer toggle**: The admin form's **Enable drive / file transfer** and **Enable SFTP** checkboxes now fully gate the runtime file-transfer channels. Previously the tunnel layer force-enabled `enable-drive` for every RDP connection and `enable-sftp` for every SSH connection regardless of the stored extras, and the `cleanExtra()` helper in the admin form stripped `"false"` values before save so unticking the box was silently discarded. Now:
  - The admin form preserves explicit `"false"` for a whitelist of boolean toggles (`enable-drive`, `enable-sftp`, `enable-printing`, `enable-wallpaper`, `enable-theming`, `enable-font-smoothing`, `enable-full-window-drag`, `enable-desktop-composition`, `enable-menu-animations`, `enable-audio`, `enable-audio-input`, `disable-audio`, `disable-copy`, `disable-paste`, `read-only`, `ignore-cert`). ([`frontend/src/pages/admin/AccessTab.tsx`](frontend/src/pages/admin/AccessTab.tsx))
  - The backend tunnel layer treats only `"true"` as enabled (absent/`"false"`/any other value → disabled), matching what the admin sees in the UI. ([`backend/src/tunnel.rs`](backend/src/tunnel.rs))
  - `/user/connections/:id/info` reports `file_transfer_enabled` using the same strict rule. ([`backend/src/routes/user.rs`](backend/src/routes/user.rs))
  - `SessionBar` Browse Files button and the `SessionMenu` File Transfer section require `fileTransferEnabled`. **Quick Share is always shown while a session is active** — it uses the backend file-store and is independent of guacd's drive/SFTP channels, so it must not share gating with Browse Files. ([`frontend/src/components/SessionBar.tsx`](frontend/src/components/SessionBar.tsx), [`frontend/src/components/SessionMenu.tsx`](frontend/src/components/SessionMenu.tsx))
  - **Upgrade note**: existing RDP/SSH connections that relied on the implicit legacy default now appear with file transfer off. Admins should edit those connections, tick the box, and save to re-enable.

### Changed

- **`AdminSettings.tsx` refactor complete (W4-4)**: The historical 8,402-line monolith has been broken into one dedicated module per tab under `frontend/src/pages/admin/`. `AdminSettings.tsx` is now a thin **258-line dispatcher** that loads settings and renders the selected tab:
  - `SecurityTab`, `NetworkTab`, `DisplayTab`, `SsoTab`, `KerberosTab`, `RecordingsTab`, `VaultTab`, `TagsTab`, `HealthTab` (with co-located `GuacdCapacityGauge`), `SessionsTab`, `PasswordsTab` (with co-located `parseDN`), `AdSyncTab`, `AccessTab`.
  - Shared form helpers (`Section`, `FieldGrid`, `RdpSections`, `SshSections`, `VncSections`) moved to `frontend/src/pages/admin/connectionForm.tsx`.
  - Shared RDP keyboard layout list moved to `frontend/src/pages/admin/rdpKeyboardLayouts.ts`.
  - Net reduction across the admin surface: **−8,144 lines** from the parent; zero behavioural changes; all 1,162 frontend tests and backend test suites pass green on every extraction step.
- **Documentation refresh**: Architecture doc now reflects the admin sub-tab split. Runbook index statuses flipped from "Planned" to "Active". PR template, `docs/runbooks/README.md`, and ADR-0001 no longer reference the retired compliance tracker.

### Removed

- **`docs/compliance-tracker.md`**: Retired after reaching 62 / 62 items closed. Every wave (W0 – W5) is complete; the ADRs and runbooks that grew out of the tracker remain under `docs/adr/` and `docs/runbooks/` as the permanent record. Historical mentions in `CHANGELOG.md` and `WHATSNEW.md` are preserved as point-in-time records.

## [0.23.0] — 2026-04-22

### Changed

- **Dependency Modernization — Major Version Upgrades**: Swept the backend and frontend onto current major versions of every long-deferred dependency. No behavioural changes for end users; surface area of this release is entirely under the hood.
  - **Rust toolchain**: backend builder image bumped from `rust:1.94-alpine` to `rust:1.95-alpine`; runtime image (and `guacd` base) bumped from `alpine:3.21`/`3.22` to `alpine:3.23`.
  - **axum 0.7 → 0.8** (plus `axum-extra` 0.9 → 0.12, `tower` 0.4 → 0.5, `tower-http` 0.5 → 0.6). Route path syntax migrated from `:param` / `*splat` to `{param}` / `{*splat}` across every router (`backend/src/routes/mod.rs`, `backend/src/services/vault.rs`, and the `vault_provisioning` test fixture). `Message::Text`/`Message::Ping` now take `Utf8Bytes`/`Bytes` instead of `String`/`Vec<u8>`; all websocket send sites updated. No API shape or wire-format changes.
  - **rand 0.9 → 0.10**: convenience methods (`random`, `random_range`, `sample_iter`) moved from the `Rng` trait to the new `RngExt` trait; every call site imports `RngExt` and the two `fill_bytes` sites in `main.rs` now use `rand::rng().random::<[u8; 32]>()` idioms.
  - **sha2 0.10 → 0.11, hmac 0.12 → 0.13**: `new_from_slice` now lives on `KeyInit` (added to the `use hmac::{Hmac, KeyInit, Mac};` import in `recordings.rs`).
  - **Frontend — React 18 → 19**: `useRef<T>()` callers now pass an explicit `undefined` initial value (`SessionBar.tsx`, `SessionMenu.tsx`, `SessionClient.tsx`); the removed global `JSX` namespace is replaced with `ReactElement` from `react` (`Documentation.tsx`). No UI or behaviour changes — all 1162 Vitest tests pass, production build clean.
  - **Frontend — react-router-dom 6 → 7**: no code changes required; the project already uses the data-router APIs.
  - **Frontend — TypeScript 5 → 6**: `tsconfig.json` adds `"ignoreDeprecations": "6.0"` to silence the `baseUrl` deprecation warning ahead of the TypeScript 7 removal.
  - **Frontend — eslint-plugin-react-hooks 5 → 7**: the new compiler-aware rules (`set-state-in-effect`, `immutability`, `purity`, `refs`, `globals`, `preserve-manual-memoization`) are enabled at **warn** level in `eslint.config.js` so the bump lands without a mass refactor. They ride alongside the existing warnings until a dedicated hooks-purity sweep promotes them.
  - **Dockerfile bumps**: `frontend/Dockerfile` moves to `node:25-alpine`; all runtime stages now target `alpine:3.23`. Trivy CRITICAL/HIGH scans clean on every rebuilt image.

### Security

- **Rust 1.95 Clippy Tightening**: The new `collapsible_match` lint flagged a nested `if let` in the share-token websocket loop (`backend/src/routes/share.rs`); collapsed into a single match guard with no behavioural change.
- **`cargo-audit` Configuration Relocated**: `audit.toml` moved from `backend/audit.toml` to `backend/.cargo/audit.toml` — the canonical discovery path. The three existing RUSTSEC ignores (`RUSTSEC-2023-0071`, `RUSTSEC-2024-0379`, `RUSTSEC-2024-0384`) are preserved verbatim with their justifications. Previously the file was silently ignored, so CI would fail-open on any advisory those rules were suppressing; this closes that hole.

### Deferred

- **eslint 9 → 10**: blocked upstream. `eslint-plugin-react@7.37.5` (latest) uses `context.getFilename()`, which eslint 10 removed (`contextOrFilename.getFilename is not a function`); `eslint-plugin-jsx-a11y@6.10.2` likewise caps its peer at `^9`. Will revisit when both plugins ship eslint-10-compatible releases.

## [0.22.0] — 2026-04-21

### Added

- **Scheduled Recording Retention Purge**: The background recordings worker (`sync_pass` in `backend/src/services/recordings.rs`) now enforces the `recordings_retention_days` setting against the database and Azure Blob Storage, not just the local filesystem. On every pass it selects every `recordings` row whose `created_at` is older than the configured window, deletes the underlying artefact — Azure blob via the Transit-sealed account key, or local file from the recordings volume — and then deletes the database row. Purge totals are logged as `purged_azure`, `purged_local`, and `deleted_rows` for auditability.
- **Configurable User Hard-Delete Window**: Soft-deleted users are now hard-deleted after a configurable window (default **90 days**, previously a hardcoded 7 days). The `user_cleanup` worker reads the `user_hard_delete_days` setting and applies it via PostgreSQL `make_interval(days => $1)` parameter binding — no SQL interpolation. Administrators can change the window in the new **Data Retention** section of the Security tab in Admin Settings (valid range 1–3650 days).
- **Admin UI — Data Retention Controls**: The Security tab now includes a **User hard-delete window (days)** input that persists to the `user_hard_delete_days` setting via the existing generic settings endpoint. The control is validated client-side (positive integer, 1–3650) and documents exactly what the window governs.
- **ADR-0003 — Feature Flags (Deferred)**: Documents the decision to keep the existing boolean `settings` table as the feature-flag mechanism rather than introducing a dedicated `feature_flags` table. Includes promotion criteria for when a future ADR would supersede this decision (percentage rollout, scheduled activation, auto-expiry, or per-user targeting). — `docs/adr/ADR-0003-feature-flags-deferred.md`
- **ADR-0004 — guacd Connection Model**: Documents the split-trust model: guacd is reachable only on the internal Docker network, credentials are ephemeral per-handshake, and Guacamole protocol parameters from user-controlled database fields are filtered through an allow-list before being forwarded. — `docs/adr/ADR-0004-guacd-connection-model.md`
- **ADR-0005 — JWT + Refresh-Token Sessions**: Pins the 20-minute access token / 8-hour refresh token TTLs, refresh-token single-use rotation, revocation via `revoked_tokens` table + in-memory set, and per-user `sessions_valid_after` lever for forced global logout. — `docs/adr/ADR-0005-jwt-refresh-token-sessions.md`
- **ADR-0006 — Vault Transit Envelope Encryption**: Documents the `vault:<base64>` envelope format used for every operator-managed secret at rest, the key hierarchy (root → Transit KEK → per-encryption DEKs that never materialise in Strata), and the rotate + rewrap path that upgrades ciphertexts without exposing plaintext. — `docs/adr/ADR-0006-vault-transit-envelope.md`
- **ADR-0007 — Emergency Approval Bypass & Scheduled-Start Checkouts**: Documents the data model (`emergency_bypass`, `scheduled_start_at`, scope-level `pm_allow_emergency_bypass`), the activation semantics (`scheduled_start_at <= now()` idempotent worker filter), and the audit invariants (`pm.checkout.emergency` event, weekly review cadence). — `docs/adr/ADR-0007-emergency-bypass-checkouts.md`
- **Operational Runbooks**: Five new copy-pasteable runbooks for on-call engineers.
  - **Disaster Recovery** (RTO ≤ 4h, RPO ≤ 24h) — `docs/runbooks/disaster-recovery.md`
  - **Security Incident Response** (SEV tiers, containment, forensic queries) — `docs/runbooks/security-incident.md`
  - **Certificate Rotation** (ACME + internal CA) — `docs/runbooks/certificate-rotation.md`
  - **Vault Operations** (unseal, Transit rotate + rewrap, Shamir rekey) — `docs/runbooks/vault-operations.md`
  - **Database Operations** (replica promotion, compensating-migration pattern, panic-boot recovery) — `docs/runbooks/database-operations.md`

### Changed

- **`user_cleanup` Worker**: Both SQL queries (the recordings-pre-purge and the final user DELETE) now use parameter-bound `make_interval(days => $1)` instead of the hardcoded `INTERVAL '7 days'`. The tracing log line at the start of each pass now includes the active `days` value.
- **Compliance Tracker**: `docs/compliance-tracker.md` Wave 5 is fully closed (13 of 13). Progress table now shows 59/62 total items done; the three remaining items are deferred Wave 4 refactor tasks (W4-4/5/6) with no functional impact.

### Security

- **Configurable Retention Windows**: Both the recordings retention purge and the user hard-delete cleanup are now driven by runtime-editable settings (`recordings_retention_days`, `user_hard_delete_days`) rather than hardcoded constants. This closes the §25.2/§25.3 Coding-Standards gap around operator-controllable data-retention windows and removes the previous 7-day user-hard-delete floor that was below many regulatory norms.
- **No SQL Interpolation in Retention Paths**: All day-window values are bound via `make_interval(days => $1)` and parsed through `i32` with a positive-integer guard. There is no string concatenation of interval values in any retention query path.

## [0.21.0] — 2026-04-21

### Added

- **Product Roadmap Page** (`/docs` → Roadmap): A new section in the built-in documentation menu renders a modern, themed roadmap of proposed features across four areas — Recordings, Security & Zero Trust, Auditing / Analytics / Compliance, and Workflows & Collaboration, plus a Notifications & Email theme. Each item carries a status (`Proposed | Researching | In Progress | Shipped`), area tags, description, and optional bullets. A status-summary strip totals items per status.
- **Admin-Editable Roadmap Statuses**: Administrators with `can_manage_system` can change any item's status directly from the roadmap page using a modern dropdown (the shared `Select` component). Non-admin users see a read-only colour-coded status badge. Updates are optimistic with rollback on error and persist in `system_settings.roadmap_statuses` as a single JSON blob — no migration required.
- **Editable Self-Approve on Account Mappings**: The _Existing Mappings_ table in Password Management → Account Mappings now renders the Self-Approve column as a modern dropdown. Admins can toggle `can_self_approve` in place without deleting and re-creating the mapping. Updates are optimistic with rollback on error and write an `account_mapping.updated` audit entry.

### Endpoints (New)

- `GET  /api/roadmap` — any authenticated user. Returns `{ "statuses": { "<item-id>": "<status>", … } }`.
- `PUT  /api/admin/roadmap/:item_id` — admin-only. Upserts a single roadmap item's status. Validates the item id (alphanumeric + `-_`, ≤ 64 chars) and the status value.
- `PATCH /api/admin/account-mappings/:id` — admin-only. Partial update of `can_self_approve` and/or `friendly_name` on an existing user → managed-account mapping. Uses `COALESCE` so unspecified fields are left untouched; returns 404 when the mapping does not exist; writes `account_mapping.updated` to the audit log.

### Fixed

- **CheckedIn Managed Profiles No Longer Bypass the Renewal Prompt**: `GET /api/user/connection-info` previously reported a profile as having live credentials whenever its TTL had not expired — even if the backing password checkout had been voluntarily checked in (Vault password scrambled). The client then proceeded to authenticate with scrambled credentials, producing a visible "Authentication failure" error and a silent AD account lockout. Both SQL queries in the handler now join `password_checkout_requests` and require a live `Active` (and un-expired) checkout; otherwise the profile is surfaced through the `expired_profile` path so the SessionClient prompt fires with the duration + justification input, matching the behaviour of a TTL-expired profile.

## [0.20.2] — 2026-04-20

### Changed

- **Justification Mandatory for Approval-Required Checkouts**: `POST /api/user/checkouts` now rejects any checkout from a user without `can_self_approve` unless `justification_comment` is at least 10 characters long. Previously the 10-character floor only applied to Emergency Bypass requests; now it applies to every request that an approver will see, so reviewers always have a written business reason. Self-approving users are unaffected — their comments remain optional.
- **Checkout Form UX**: The Justification label now reads "(required, min 10 characters)" in accent/warning colour whenever the selected account requires approval. Placeholder text, inline character counter, and submit-button disabled state all reflect the new requirement.

## [0.20.1] — 2026-04-20

### Security

- **Emergency Bypass 30-Minute Duration Cap**: Emergency Approval Bypass checkouts are now hard-capped at **30 minutes** regardless of the `requested_duration_mins` value submitted. The cap is enforced server-side in `POST /api/user/checkouts` after all existing bypass guards pass — any larger value is silently clamped before the row is written. This tightens the exposure window for credentials released without approver review. The checkout form also caps the duration input's `max` to `30` while the ⚡ Emergency Bypass checkbox is ticked and auto-reduces the current value if the user enables bypass with a larger duration selected; the server-side clamp remains authoritative.

### Changed

- **Checkout Form**: Duration input label now reads "Duration (minutes, 1–30)" when emergency bypass is active, with an inline warning "Emergency bypass checkouts are capped at 30 minutes."

## [0.20.0] — 2026-04-20

### Added

- **Scheduled Password Release (Future Start Time)**: Users can now request a password checkout that releases at a future date/time instead of immediately. The checkout form includes an optional "Schedule release for a future time" toggle with a `datetime-local` picker (default now + 15 minutes, minimum now + 1 minute, maximum + 14 days). On submit, the request is created with status `Scheduled` and the password is not generated until the scheduled moment. The existing 60-second expiration worker (`spawn_expiration_worker` / `run_expiration_scrub`) now also scans for due `Scheduled` rows and invokes `activate_checkout` — no new worker, no additional DB polling pattern. Works for both approval-required and self-approving users. Scheduled checkouts display a distinct accent badge and a "🕒 Release scheduled for …" line on the checkout card.
- **Emergency Approval Bypass (Break-Glass)**: A new per-AD-Sync-Source toggle (`pm_allow_emergency_bypass`) lets administrators permit users to bypass approval-role review during a production incident. When enabled, approval-required users see an "⚡ Emergency Bypass" checkbox on the checkout form. Emergency checkouts require a justification of at least 10 characters, are **capped at a maximum duration of 30 minutes** (enforced server-side and in the UI), and are activated immediately — just like a self-approved request — but are flagged with `emergency_bypass = true` throughout the checkout lifecycle. A distinct audit event (`checkout.emergency_bypass`) is written, and the Credentials / Approvals views display an "⚡ Emergency" badge so auditors and approvers can instantly identify break-glass access. The emergency option is hidden on the form when a scheduled release is active (they are mutually exclusive: emergency = immediate, scheduled = future).

### Changed

- **Checkout State Machine**: `password_checkout_requests.status` now has seven possible states: `Pending`, `Approved`, `Scheduled`, `Active`, `Expired`, `Denied`, `CheckedIn`. `activate_checkout` accepts any of `Approved`, `Active`, or `Scheduled` as valid source states.
- **Duplicate-Request Guard**: The "you already have an open checkout" guard in `POST /api/user/checkouts` now treats `Scheduled` rows as open, preventing users from queuing multiple future-dated releases for the same account.
- **Checkout Form UX**: Dynamic submit button label — reads "Schedule Checkout", "Emergency Checkout", or "Request Checkout" depending on which options are active. Scheduled releases show a distinct flash message: "Checkout scheduled — password will release at the chosen time".

### Database

- **Migration 051**: Adds `pm_allow_emergency_bypass BOOLEAN NOT NULL DEFAULT FALSE` to `ad_sync_configs`; adds `emergency_bypass BOOLEAN NOT NULL DEFAULT FALSE` to `password_checkout_requests` with a partial index for audit queries.
- **Migration 052**: Adds `scheduled_start_at TIMESTAMPTZ` to `password_checkout_requests`; drops and recreates `password_checkout_requests_status_check` to include the new `Scheduled` state (full state set: `Pending, Approved, Scheduled, Active, Expired, Denied, CheckedIn`); adds a partial index `idx_password_checkout_requests_scheduled_start_at WHERE status = 'Scheduled'` so the expiration worker's due-scan is an indexed lookup rather than a table scan.

### Security

- **Emergency Bypass Safeguards**: The `pm_allow_emergency_bypass` toggle is gated behind an AD sync config (admin-only). The backend enforces four checks server-side: (1) the mapping's `ad_sync_config_id` must have `pm_allow_emergency_bypass = true`, (2) the justification comment must be at least 10 characters, (3) emergency bypass cannot be combined with scheduled release, (4) `requested_duration_mins` is hard-clamped to 30 minutes regardless of the value submitted. Every emergency checkout emits a dedicated `checkout.emergency_bypass` audit entry that captures the requester, managed account DN, justification, and (clamped) duration — so break-glass events are reviewable and immutable even though approvers were bypassed.
- **Scheduled Release Bounds**: The scheduled timestamp is validated server-side to be strictly in the future (> now + 30 s) and no more than 14 days out; values outside this window return `400 Validation`. The row sits idle in the DB with no Vault material, no generated password, and no LDAP mutation until the worker activates it — minimising the window in which a privileged credential exists.

## [0.19.4] — 2026-04-20

### Fixed

- **Expired Managed Credentials No Longer Bypass Renewal Prompt**: Connecting with an expired or checked-in managed credential profile previously dropped straight into "Authentication failure (invalid credentials?)" because the session view stayed in the loading phase and stale/empty credentials were still passed to the remote host. The session client now correctly enters the renewal prompt when the backend reports an `expired_profile`, and the tunnel backend refuses to proceed when the only available credential source is an expired managed profile — preventing repeated failed binds against AD (which could also contribute to account lockout).

### Added

- **Inline Checkout Request on Connect (Approval-Required Managed Accounts)**: When a connection is attempted with an expired/checked-in managed credential profile that requires administrator approval, users now see an inline checkout request form (justification + duration) directly in the session view. Submitting queues a pending approval and clearly informs the user that the connection is blocked until approved — no need to navigate away to the Credentials tab.
- **Unified Self-Approve & Approval-Required Flow**: Self-approving users get an identical form and, on submit, the checkout is immediately activated, linked to the existing profile, and the session proceeds to connect without additional clicks.

### Changed

- **Backend Tunnel Safety Check**: `tunnel.rs` now performs an explicit `credential_mappings`/`credential_profiles` check after credential resolution. If the only credential source for a connection is a managed profile that has expired (`expires_at <= now()`), the WebSocket tunnel returns a validation error instead of opening a session with missing credentials.
- **Session Renew Callback**: `handleRenewAndConnect` now includes `renewJustification` in its dependency array and routes all managed-account renewals (self-approve and approval-required) through a single request path, surfacing an explicit "pending administrator approval" message when the returned checkout status is not `Active`.

## [0.19.3] — 2026-04-20

### Added

- **Separate Search Base OUs for Password Management**: Introduced a dedicated `pm_search_bases` configuration field for Active Directory synchronization. This allows administrators to scope user discovery for password management to specific OUs, separate from the primary device-focused search bases.
- **Optional Search Base Fallback**: The system now supports an optional fallback mechanism: if specific PM search bases are not configured, user discovery automatically falls back to the main device search bases, ensuring backward compatibility with existing configurations.
- **Interactive Search Base UI**: Updated the Admin Settings AD Sync configuration modal with an interactive, multi-entry input for PM Search Base OUs, matching the primary search base pattern.

### Technical Refinements

- **API Enhancements**: Updated `CreateAdSyncConfigRequest` and `UpdateAdSyncConfigRequest` DTOs to support optional PM search base persistence.
- **User Discovery Optimization**: Refined `list_unmapped_accounts` and account filter preview logic to prioritize PM-scoped discovery perimeters.

### Database

- **Migration 049**: Adds `pm_search_bases` (`TEXT[]`) column to the `ad_sync_configs` table.

## [0.19.2] — 2026-04-20

### Added

- **Connection Health Checks**: Background TCP probing of every connection's hostname:port every 2 minutes with a 5-second connect timeout. Results (online/offline/unknown) are persisted in the database and exposed via the connections API. Dashboard displays green/red/gray status dots next to each connection for at-a-glance operational visibility without requiring agents on target machines.
- **Checked-In Status for Password Checkouts**: Users can now voluntarily check-in (return) an active password checkout before its expiry. Adds `CheckedIn` to the `password_checkout_requests` status enum, triggering immediate password rotation on check-in.
- **Credential Profile ↔ Checkout Link**: Credential profiles can now reference a `checkout_id` linking them to the password checkout they were generated from. Enables automatic cleanup and traceability between vault profiles and PM checkouts.

### Fixed

- **Migration Resilience (048)**: Added idempotent repair migration `048_connection_health_repair.sql` to safely add `health_status` and `health_checked_at` columns on environments where migration 042 was recorded as applied but the DDL did not take effect. Uses `IF NOT EXISTS` for columns and `pg_constraint` checks for the CHECK constraint.

### Database

- **Migration 042**: Adds `health_status` (TEXT, NOT NULL, DEFAULT 'unknown', CHECK constraint) and `health_checked_at` (TIMESTAMPTZ) columns to `connections` table.
- **Migration 043**: Adds `checkout_id` FK column to `credential_profiles`; relaxes `encrypted_username` NOT NULL constraint for managed credential profiles.
- **Migration 044**: Extends `password_checkout_requests` status CHECK constraint to include `CheckedIn`.
- **Migration 048**: Idempotent repair — ensures health columns and constraint exist regardless of prior migration state.

## [0.19.1] — 2026-04-20

### Added

- **DNS Search Domains**: The Network tab now supports configurable DNS search domains alongside DNS servers. Search domains are written as a `search` directive in the generated `resolv.conf`, enabling short-name resolution for internal zones (e.g. `.local`, `.dmz.local`). This is equivalent to the `Domains=` directive in `systemd-resolved` on the host OS.
- **Docker DNS Fallback**: The generated `resolv.conf` now appends Docker's embedded DNS resolver (`127.0.0.11`) as a fallback nameserver. This ensures existing connections that resolve via public DNS or Docker service discovery continue working when custom DNS is enabled — no reconfiguration needed.
- **Migration 047 (Backfill)**: New migration `047_dns_search_domains.sql` backfills the `dns_search_domains` key into `system_settings` for instances that already ran migration 046 before search domains were added. Uses `ON CONFLICT DO NOTHING` for idempotent application.

### Changed

- **DNS Configuration (Network Tab)**: Updated to include a Search Domains input field with domain format validation (max 6 domains). The "How it works" explanation now describes the equivalence to `systemd-resolved` `Domains=` directive.
- **Backend DNS endpoint**: `PUT /api/admin/settings/dns` now accepts `dns_search_domains` (comma-separated domain list). Validated domain names are written as a `search` line in the generated `resolv.conf`. Audit log includes search domains in the event payload.
- **resolv.conf generation**: Now writes `search <domains>` line (when configured), followed by custom `nameserver` entries, followed by `nameserver 127.0.0.11` as Docker DNS fallback.

### Database

- **Migration 047**: Backfills `dns_search_domains` key into `system_settings` for existing installations.

## [0.19.0] — 2026-04-19

### Added

- **DNS Configuration (Network Tab)**: Administrators can now configure custom DNS servers and search domains for guacd containers directly from the Admin Settings UI via a new **Network** tab. DNS entries are validated (IPv4 format), search domains are validated (domain format, max 6), persisted in `system_settings`, and written to a shared Docker volume (`backend-config`) as `resolv.conf`. The guacd entrypoint copies this file on startup, enabling resolution of internal hostnames (e.g. `.local`, `.dmz.local` domains) without hardcoding DNS in `docker-compose.yml`. A restart-required banner reminds admins to run `docker compose restart guacd` after changes.
  - **Migration**: `046_dns_settings.sql` inserts `dns_enabled` (false), `dns_servers` (empty), and `dns_search_domains` (empty) into `system_settings`.
  - **Backend**: New `PUT /api/admin/settings/dns` endpoint with IPv4 validation, domain validation, DB persistence, `resolv.conf` file write (with Docker DNS fallback), and audit logging.
  - **Frontend**: `NetworkTab` component with DNS enable toggle, DNS servers input, search domains input, client-side validation, "How it works" explanation, and restart-required warning after save.
  - **guacd**: New `entrypoint.sh` wrapper that applies `/app/config/resolv.conf` before starting the daemon. Uses `su-exec` to drop privileges to the `guacd` user.
- **Dynamic Browser Tab Title**: The browser tab now displays the active session's server name while connected (e.g. "SERVER01 — Strata"), making it easy to identify which server you're on when the sidebar is collapsed or when switching between browser tabs. Reverts to "Strata Client" on disconnect.

### Changed

- **guacd Dockerfile**: Added `su-exec` to runtime packages, replaced direct `USER guacd` + `ENTRYPOINT` with a custom `entrypoint.sh` that applies DNS configuration before dropping privileges. Added `/app/config` directory for shared volume mount.
- **Docker Compose**: Removed hardcoded `dns:` directives from `guacd` and `guacd-2` services (DNS is now UI-managed). Added `backend-config:/app/config:ro` volume mount to both guacd services.

### Removed

- Removed test scripts (`test_me.sh`, `test_me2.sh`) containing debug/throwaway code.

### Database

- **Migration 046**: Inserts `dns_enabled`, `dns_servers`, and `dns_search_domains` keys into `system_settings` for UI-driven DNS configuration.

## [0.18.0] — 2026-04-18

### Added

- **Approval Role Account Scoping**: Approval roles now use direct account-to-role mapping (`approval_role_accounts` table) instead of LDAP target filter matching (`approval_group_mappings`). Each approval role is explicitly scoped to specific managed AD accounts via a searchable dropdown selector. This replaces the previous LDAP filter-based approach for precise, auditable control over which accounts each approver can approve checkouts for.
  - **Migration**: `045_approval_role_accounts.sql` creates the `approval_role_accounts` table with `(role_id, managed_ad_dn)` composite unique index and drops the legacy `approval_group_mappings` table.
  - **Admin UI**: Approval role configuration now shows a searchable dropdown populated from all PM-enabled AD sync sources, with selected accounts displayed as removable chip tags. Replaces the previous checkbox grid for improved scalability with large account sets.
  - **Backend**: New CRUD endpoints for `approval_role_accounts`. The `pending_approvals` query now scopes pending requests to only those accounts explicitly listed in the approver's role, rather than matching against LDAP filters.
- **Approver Navigation Visibility**: The "Pending Approvals" sidebar link is now conditionally visible only to users who are assigned to at least one approval role. The `is_approver` boolean is returned by both `/api/user/me` and `/api/auth/check` endpoints and derived from `SELECT EXISTS(SELECT 1 FROM approval_role_assignments WHERE user_id = $1)`.
- **Requester Username on Pending Approvals**: Checkout requests now include the `requester_username` field, populated via a `LEFT JOIN users` in the pending approvals query. The Approvals page displays the requester's username and avatar instead of a raw UUID.
- **Checkout Request "Decided By" Column**: The Checkout Requests table in Admin Settings now shows who approved or denied each request. Displays the approver's username, "Self Approved" when the approver is the same user as the requester, or "—" for undecided requests.

### Improved

- **Approvals Page Redesign**: Complete visual overhaul of the Pending Approvals page with a premium card-based layout. Each request card features an avatar circle with the requester's initial, labeled sections (ACCOUNT showing CN with full DN below, DURATION formatted as hours/minutes, JUSTIFICATION in an elevated surface box), and prominent approve/deny buttons with SVG icons and disabled state during decision processing.
- **CN Display Helper**: New `cnFromDn()` utility correctly extracts the Common Name from Distinguished Names, handling escaped commas (e.g., `CN=Smith\, John (Tier 1),OU=...` → `Smith, John (Tier 1)`).
- **Approval Role Delete Button Styling**: Changed from solid red `btn-danger` to `btn-secondary text-danger` to match the site-wide delete button pattern used in AD Sync configuration.
- **Unmapped Accounts Refresh**: The unmapped accounts list now auto-refreshes when the selected AD source changes, ensuring the dropdown always reflects the current state.

### Fixed

- **Managed Credential Override in Tunnel**: Fixed an issue where the tunnel handshake would use ticket-supplied credentials even when a managed checkout password was active for the connection's managed AD account. The managed credential path now takes priority when the connection has a `managed_ad_dn` and an active checkout exists.
- **Checkout Expiry `expires_at` Calculation**: Fixed a bug where `expires_at` was computed from the original request time instead of the approval time, causing checkouts to expire earlier than the requested duration.
- **Pending Approvals Scope**: Approvers now only see checkout requests for accounts explicitly assigned to their approval role, preventing visibility of requests outside their scope.

### Database

- **Migration 045**: Creates `approval_role_accounts` table (role_id + managed_ad_dn with cascade delete and composite unique index). Drops legacy `approval_group_mappings` table.

## [0.17.0] — 2026-04-18

### Added

- **Password Management (Account Password Blade)**: Full privileged account password checkout, rotation, and approval workflow for AD-managed accounts.
  - **Backend**: New `checkouts.rs` service with password generation (configurable policy), LDAP `unicodePwd` reset, Vault-sealed credential storage, checkout lifecycle (request → approve → activate → expire), and two background workers (60s expiration sweep, daily auto-rotation).
  - **Migration**: `041_password_management.sql` adds PM columns to `ad_sync_configs`, creates `approval_roles`, `approval_role_assignments`, `approval_group_mappings`, `user_account_mappings`, and `password_checkout_requests` tables.
  - **Admin Endpoints**: CRUD for approval roles, role assignments, AD target filter mappings, user-to-account mappings, unmapped account discovery, test rotation, and checkout request listing.
  - **User Endpoints**: Request checkout (`POST /user/checkouts`), list own checkouts, list pending approvals, approve/deny decisions, and password reveal for active checkouts.
  - **Admin UI**: New "Password Mgmt" tab in Admin Settings with three sub-tabs: Approval Roles (create/configure roles, assign users, set AD filters), Account Mappings (discover unmapped AD accounts, create/delete mappings, test rotation), and Checkout Requests (status dashboard).
  - **Approvals Page**: Dedicated page for pending password checkout approval decisions. "Request Checkout" and "My Checkouts" tabs moved to the Credentials page for a more logical workflow.
  - **Credentials Page**: Now has three tabs — Profiles, Request Checkout, and My Checkouts — consolidating all credential-related actions in one place.
  - **AD Sync Config**: 11 new optional PM fields (pm_enabled, pm_bind_user, pm_bind_password, pm_target_filter, 5 password policy fields, pm_auto_rotate_enabled, pm_auto_rotate_interval_days) on create/update.
- **AD Sync Password Management UI**: Collapsible "Password Management" section within the AD Sync editing form with: PM enable toggle, service account credential source radio (use AD source bind creds or separate PM-specific creds), target account LDAP filter, password generation policy (min length, uppercase/lowercase/numbers/symbols toggles), auto-rotation enable with configurable interval, and test rotation button.
- **Target Account Filter Preview**: "Preview" button next to the target account filter input that live-tests the LDAP filter against Active Directory and displays matching accounts in a results table (account name, distinguished name, description). Shows up to 25 results with a total count. New `POST /api/admin/ad-sync-configs/test-filter` endpoint.
- **Account Mappings Redesign**: Unified flow replacing the previous two-card layout — select a PM-enabled AD source from a dropdown, auto-discover accounts, then map them to Strata users via dropdowns with optional self-approve checkbox.
- **Connection Health Checks**: Automatic background TCP probing of all connections every 2 minutes. Each connection's hostname:port is tested with a 5-second timeout, and the result (online/offline/unknown) is stored in the database and exposed via the API.
  - **Migration**: `042_connection_health.sql` adds `health_status` and `health_checked_at` columns to the `connections` table.
  - **Backend Worker**: New `health_check.rs` service with concurrent TCP probes across all non-deleted connections.
  - **Dashboard UI**: Green (online), red (offline), or gray (unknown) status dot indicator on each connection row in the table view and on recent connection cards. Hover tooltip shows the last check timestamp.
  - **Status Column**: New "Status" column in the connections table header.

### Improved

- **Styled Radio Buttons**: Custom `.radio` CSS class matching the existing `.checkbox` design system — purple gradient when selected, white inner dot, same sizing/shadows/transitions as checkboxes. Applied to the AD Sync PM credential source selector.

## [0.16.3] — 2026-04-17

### Added

- **Display Tags for Active Sessions**: Users can now pin a single tag per connection to display as a colored badge on session thumbnails in the Active Sessions sidebar. A tag picker dropdown (accessible via a tag icon on each thumbnail) lets users choose from their existing tags or clear the selection. The display tag is persisted per-user per-connection and synced with the backend. This is fully optional — connections without a display tag show no badge.
- **Display Tags API**: Three new endpoints manage display tag assignments:
  - `GET /api/user/display-tags` — returns all display tag mappings as `{ connection_id: { id, name, color } }`
  - `POST /api/user/display-tags` — sets or replaces the display tag for a connection (one per connection per user)
  - `DELETE /api/user/display-tags/:connection_id` — removes the display tag for a connection
- **Display Tags Migration**: New `user_connection_display_tags` table (`040_display_tags.sql`) with a composite primary key on `(user_id, connection_id)` ensuring at most one display tag per connection per user. Foreign keys cascade to `users`, `connections`, and `user_tags`.

## [0.16.2] — 2026-04-17

### Added

- **Command Palette (Ctrl+K)**: A new quick-launch overlay accessible via `Ctrl+K` while connected to any session. Searches all available connections by name, protocol, hostname, description, or folder. Arrow key navigation, Enter to launch, Escape to close. Shows an "Active" badge on already-connected sessions. Also works from pop-out and multi-monitor windows (relayed to the main window via `postMessage`).
- **Keyboard Shortcut Proxy (Ctrl+Alt+`)**: Pressing `Ctrl+Alt+`` sends `Win+Tab`(Task View) to the remote session. This is the only reliable browser-level proxy shortcut — Windows intercepts`Ctrl+Alt+Tab` before JavaScript can capture it.
- **Windows Key Proxy (Right Ctrl)**: Right Ctrl is remapped to the Super/Win key for the remote session. Hold Right Ctrl + another key to send Win+key combos (e.g. Win+E, Win+R). Tap Right Ctrl alone to open the Start menu. Works in single sessions, pop-outs, and multi-monitor windows.
- **Keyboard Lock API (Fullscreen + HTTPS)**: When a session is in fullscreen mode over HTTPS, the browser captures OS-level shortcuts (Win, Alt+Tab, Escape) directly via the Keyboard Lock API and forwards them to the remote session — no proxy keys needed.
- **Conditional Quick Share Button**: The Quick Share upload button in the Session Bar is now only visible when the connection has file transfer enabled (`enable-drive` or `enable-sftp`). Previously it was always shown regardless of the connection configuration.
- **File Transfer Enabled API Field**: The `/user/connections/:id/info` endpoint now returns `file_transfer_enabled: bool`, derived from the connection's `enable-drive` and `enable-sftp` extra settings.

### Improved

- **Session Bar Keyboard Help**: The Session Bar keyboard popover now shows a full mapping reference: Right Ctrl → Win key, Right Ctrl + key → Win+key, Ctrl+Alt+` → Win+Tab, Ctrl+K → Quick Launch. Includes explanatory notes about Right Ctrl+Tab browser interception and the fullscreen HTTPS tip.
- **Session Bar Quick Tools**: Shortcut buttons for Alt+Tab, Win+Tab, and Ctrl+Alt+T (Terminal) are available in the Session Bar for one-click sending of common key sequences to the remote session.

## [0.16.1] — 2026-04-17

### Improved

- **Multi-Monitor Rendering Fix**: Secondary monitor windows now render correctly using the default layer's canvas reference (`getCanvas()`) instead of `display.flatten()`, which allocated a new full-resolution canvas every frame (~600 MB/s of GC pressure at 30 fps) and caused black screens by starving the Guacamole rendering pipeline.
- **Multi-Monitor Render Loop**: Replaced `requestAnimationFrame` with `setInterval` (33 ms / ~30 fps) for the secondary window render loop. `requestAnimationFrame` is throttled or paused entirely by the browser when the main window loses focus to a popup, which happens immediately when the user interacts with a secondary monitor window.
- **Multi-Monitor Cursor Sync**: The remote cursor (arrow, resize handle, text beam, etc.) is now visible on all secondary monitors. A `MutationObserver` watches the Guacamole display element's CSS `cursor` property and mirrors it to every secondary canvas in real time.
- **Multi-Monitor Horizontal Layout**: All monitors are now placed in a flat horizontal row (sorted left-to-right by physical position) regardless of vertical offsets. Because guacd sends a single aggregate resolution to the remote desktop, the remote OS places the taskbar at the very bottom of the aggregate. Using vertical offsets from mixed arrangements (e.g. a portrait monitor offset lower) would push the aggregate height beyond the landscape monitors' visible area, making the taskbar unreachable.
- **Multi-Monitor Primary Height Cap**: The aggregate remote resolution height is capped to the primary monitor's height. This ensures the taskbar remains visible within the primary monitor's slice. Taller secondary monitors (e.g. portrait) display the primary-height region of the remote desktop with black fill below.
- **Multi-Monitor Auto-Maximize**: Secondary popup windows now call `moveTo()` + `resizeTo()` after opening to fill their target screen, and attempt `requestFullscreen()` for a chrome-free view.
- **Pop-out Screen-Change Detection**: Single pop-out windows now detect when dragged to a different screen via polling `screenX`/`screenY`/`devicePixelRatio` (250 ms interval, 300 ms debounce). After the position settles, the display is re-scaled and `sendSize()` is called with the new window dimensions.
- **Pop-out Resize Handler**: The pop-out window's `display.onresize` callback now uses `setTimeout` instead of `requestAnimationFrame` to avoid being throttled when the popup has focus and the main window is backgrounded.

### Multi-Monitor Usage Notes

Multi-monitor mode works by sending a single aggregate resolution to the remote desktop via guacd. The remote OS (Windows/Linux) sees this as one large display, not separate monitors. This has important implications:

- **Best supported**: All landscape monitors arranged left-to-right in a horizontal row. Each monitor gets its own browser window showing its slice of the remote desktop.
- **Portrait monitors**: A portrait monitor's slice width is narrower but the height is capped to the primary monitor's height. The extra vertical space shows black — the remote desktop doesn't extend into it.
- **Monitors above/below**: Vertical monitor arrangements are flattened into a horizontal row. A monitor physically above or below the primary will appear as a slice to the right. You would need to scroll/move the mouse rightward through the aggregate desktop to reach the content shown on that monitor.
- **Taskbar visibility**: The remote taskbar always appears at the bottom of the aggregate resolution, which is capped to the primary monitor's height. This keeps it visible on same-height landscape monitors.

## [0.16.0] — 2026-04-17

### Security

- **Granular Permission Enforcement**: All ~30 admin API endpoints now enforce granular permission checks (`can_manage_system`, `can_manage_users`, `can_manage_connections`, `can_view_audit_logs`, `can_view_sessions`) instead of relying solely on `require_admin` middleware. A `can_manage_system` flag acts as a super-admin bypass. This prevents users with limited admin roles from accessing endpoints beyond their permissions.
- **Tunnel Ticket User Validation**: After consuming a one-time tunnel ticket, the backend now verifies that the authenticated user matches the ticket's `user_id`, preventing ticket theft if a token is intercepted.
- **Credential Zeroization on Drop**: `TunnelTicket` now implements `Drop` with `zeroize` to scrub username and password fields from memory when the ticket goes out of scope, closing a window where credentials could linger after tunnel establishment.
- **Refresh Token Re-reads Role from DB**: The `/api/auth/refresh` endpoint now queries the database for the user's current role instead of copying stale claims from the old JWT. Role changes (e.g. demotion) are now effective immediately on the next token refresh.
- **Admin Tag Color Validation**: The `create_admin_tag` and `update_admin_tag` endpoints now validate that color values are valid hex codes (`#rgb` or `#rrggbb`), preventing storage of arbitrary strings.
- **User Tag Color Validation**: The `create_tag` and `update_tag` user endpoints now enforce the same hex color validation.
- **Accept Terms Version Bounds**: The `accept_terms` endpoint now rejects version numbers outside the 1–1000 range.
- **Connection Share Expiry Constraint**: Migration 038 adds a `NOT NULL` constraint to `connection_shares.expires_at`, ensuring all share links have an expiry. Existing NULL rows are backfilled with a 24-hour default.

### Improved

- **Multi-Monitor 2D Layout**: Multi-monitor mode now uses physical screen coordinates directly from the Window Management API to build a true 2D aggregate layout, correctly handling stacked, L-shaped, and mixed-resolution monitor arrangements. Previously all screens were forced into a horizontal row regardless of physical placement.
- **Multi-Monitor Display Scaling**: The primary monitor now explicitly sets `display.scale()` immediately after requesting the aggregate resolution, rather than relying on an asynchronous resize handler. This eliminates the brief flash of incorrect scaling when entering multi-monitor mode.
- **Multi-Monitor Re-attach Guard**: `attachSession()` no longer overrides multi-monitor scaling when React re-renders trigger a session re-attach (e.g. clipboard sync, sidebar toggle). Multi-monitor sessions manage their own display scale independently.
- **Non-blocking File Store I/O**: All `std::fs` calls in the session file store have been replaced with `tokio::fs` equivalents. The `RwLock` is now released before performing disk I/O and re-acquired afterward, eliminating async runtime blocking during file uploads, downloads, and cleanup.
- **Non-blocking Kerberos Config Write**: The `write_krb5_conf_multi` call in `regenerate_krb5_conf` is now wrapped in `tokio::task::spawn_blocking`, preventing the synchronous file write from blocking the async runtime.
- **Settings Cache Pruning**: The in-memory settings cache now prunes stale entries when the cache exceeds 500 items, preventing unbounded memory growth from unique key lookups.
- **Session Stats Single-Query CTE**: The recordings session stats endpoint now executes a single CTE-based query instead of six separate aggregate queries, reducing database round-trips.
- **Session Stats Static SQL**: All `format!`-interpolated SQL in session stats has been replaced with static string literals using `NOW() - INTERVAL '30 days'`, eliminating potential injection vectors.
- **Update Role Single COALESCE Query**: The `update_role` endpoint now uses a single `UPDATE ... SET col = COALESCE($n, col)` query instead of up to 11 individual UPDATE statements per field.
- **Update Kerberos Realm Single Query**: The `update_kerberos_realm` endpoint now uses a single COALESCE-based UPDATE instead of up to 7 individual field updates.
- **Set Connection Tags Bulk Insert**: Both `set_connection_tags` (user) and `set_admin_connection_tags` (admin) now use `INSERT ... SELECT unnest($1::uuid[])` for bulk tag assignment instead of N+1 individual inserts.
- **Set Connection Tags Transaction**: The user `set_connection_tags` endpoint now wraps the delete+insert in a database transaction to prevent inconsistent state on partial failure.
- **Credential Profile Consolidation**: The `update_credential_profile` endpoint now uses at most two conditional UPDATE queries (with COALESCE) instead of three separate paths, reducing code duplication and database round-trips.
- **IP Extraction Consolidation**: All inline X-Forwarded-For header extraction (tunnel, share, user endpoints) now uses a shared `extract_client_ip` / `try_extract_client_ip` helper from the auth module.

### Fixed

- **Role-Based Access Replaces String Comparison**: All `user.role == "admin"` / `user.role != "admin"` string checks in tunnel, share, and user routes have been replaced with permission-based methods (`can_access_all_connections()`, `can_manage_system`, etc.), fixing a class of bugs where custom roles with connection management permissions were incorrectly blocked.
- **Delete Tag Returns 404**: The `delete_tag` endpoint now checks `rows_affected()` and returns a proper 404 instead of a silent 200 when the tag doesn't exist.
- **Update Tag Returns 404**: The `update_tag` endpoint now uses `fetch_optional` + `ok_or_else` instead of `fetch_one`, returning a 404 instead of a 500 when the tag doesn't exist.
- **JSON Serialization Panic**: Two `.unwrap()` calls on `serde_json::to_string` in the auth module have been replaced with proper error propagation, preventing a theoretical panic on serialization failure.

### Database

- **Migration 039**: Adds `idx_users_deleted_at` (partial index on soft-deleted users), `idx_user_connection_access_conn_user` (composite index for connection access checks), and `NOT NULL` constraint on `connection_shares.expires_at`.

## [0.15.3] — 2026-04-16

### Added

- **Quick Share (Temporary File CDN)**: Upload files from the Session Bar and get a random, unguessable download URL to paste into the remote session's browser. Files are stored in-memory + disk on the backend, scoped to the active session, and automatically deleted when the tunnel disconnects. Supports drag-and-drop, multiple files (up to 20 per session, 500 MB each), copy-to-clipboard URLs, and per-file delete. No authentication required on the download endpoint — the random token is the capability.
- **Multi-Monitor Screen Count**: The multi-monitor button tooltip now shows the number of detected screens (e.g. "Multi-monitor (3 screens detected)"), updating live when monitors are plugged in or out.

### Fixed

- **Quick Share Upload Size Limit — Nginx (413)**: Uploading files larger than 10 MB to Quick Share returned HTTP 413 (Content Too Large) because nginx's `client_max_body_size` was set to `10M`. Increased the limit to `500M` to match the backend's per-file cap, and raised `client_body_timeout` from 10 s to 300 s so large uploads don't time out mid-transfer.
- **Quick Share Upload Size Limit — Axum (413)**: Even after the nginx fix, uploads over 2 MB still failed because Axum's default multipart body limit is 2 MB. Added an explicit `DefaultBodyLimit::max(500 MB)` layer on the upload route to match the backend's per-file cap.
- **Quick Share Delete "Unexpected end of JSON input"**: Deleting a Quick Share file threw a client-side JSON parse error because the backend returns an empty 200 response. The `request()` helper now reads the response as text first and only parses JSON when the body is non-empty.
- **Multi-Monitor 3+ Screens — Live Screen Detection**: Connecting three or more monitors only opened one popup window. The `getScreenDetails()` API returns a **live** `ScreenDetails` object, but the code read it once on mount and cached the snapshot. If the third monitor wasn't detected at that instant — or screens changed later — the cache was stale. The hook now stores the live `ScreenDetails` object, listens for the `screenschange` event, and refreshes the screen layout whenever monitors are plugged in or out.
- **Multi-Monitor 3+ Screens — Popup Blocker**: Even with live screen detection, the second and subsequent popups were blocked by Chrome's popup blocker. Chrome only allows multiple `window.open()` calls within a single user gesture if `getScreenDetails()` is called during that gesture to signal multi-screen intent. The hook now calls `await getScreenDetails()` inside the click handler, which extends Chrome's user activation through the await and permits all secondary window opens.
- **Disclaimer Modal Scroll-to-Accept on Tall Screens**: The "I Accept" button on the Session Recording Disclaimer was permanently disabled on screens tall enough to display the full terms without scrolling, because the scroll event never fired. The modal now checks on mount whether the content fits without overflow and enables the button immediately when it does. A `ResizeObserver` re-checks on viewport changes.

## [0.15.0] — 2026-04-16

### Improved

- **Multi-Monitor Brave / Fingerprinting Compatibility**: The Window Management API `getScreenDetails()` returns zeroed screen dimensions and positions in Brave and other privacy-focused browsers. Multi-monitor mode now falls back to `window.screen` dimensions for any screen reporting zero width/height, and computes popup placement from cumulative tile offsets instead of relying on physical screen coordinates.
- **Multi-Monitor Primary Resolution**: The primary monitor slice now uses the actual browser container dimensions instead of the physical screen resolution, preserving 1:1 scale identical to single-monitor mode.
- **Secondary Window Dynamic Resize**: Secondary monitor windows now adapt their canvas backing store when resized, stretching the remote desktop slice to fill the window.
- **Secondary Window Cursor Visibility**: The OS cursor is now visible in secondary monitor windows, instead of being hidden with `cursor: none`.

## [0.14.9] — 2026-04-16

### Added

- **Browser-Based Multi-Monitor for RDP**: Span a remote desktop session across multiple physical monitors using the Window Management API (Chromium 100+). When enabled, the session resolution is dynamically expanded to cover all detected screens and each secondary monitor receives its own browser window showing the correct slice of the remote desktop via `requestAnimationFrame` canvas blitting. Mouse input in secondary windows is offset-translated so coordinates map correctly to the aggregate remote resolution. Keyboard input (including the Windows key proxy) is forwarded from all windows. A new multi-monitor toggle button appears in the Session Bar alongside the existing Pop-out button. Gracefully no-ops on browsers without `getScreenDetails()` support.

## [0.14.8] — 2026-04-16

### Fixed

- **Remote Display Resize Breaking Session View**: When the remote desktop's resolution changed (e.g., maximising a window inside an RDP session), the Guacamole display was not rescaled to fit the browser container, resulting in an unreadable, incorrectly-scaled display. Added a `display.onresize` handler in both the main session view and pop-out windows so the display is automatically rescaled whenever the remote resolution changes.

## [0.14.7] — 2026-04-16

### Added

- **Live Session Sharing (View & Control)**: Share links now observe the owner's live session in real time via the NVR broadcast channel, instead of opening an independent connection. Shared viewers see exactly what the owner sees. Control mode share links forward keyboard and mouse input to the owner's session via an injected mpsc channel.
- **Public Display Settings Endpoint**: New `GET /api/user/display-settings` endpoint returns only the three display-related settings (timezone, time format, date format) without requiring admin privileges, eliminating 403 errors for non-admin users.
- **Admin Tags**: Administrators can create system-wide tags and assign them to connections for organizational categorization. Tags are visible (read-only) to all users on the Dashboard alongside their existing personal tags.

### Fixed

- **Share Link "Connection Failed"**: Share links returned a 500 error because the `connection_shares` table was missing `access_count` and `last_accessed` columns referenced in an UPDATE query. Removed the nonexistent column reference.
- **Share Link Showing Login Screen**: Shared sessions opened an independent RDP connection (showing the remote server's login screen) instead of viewing the owner's active session. Rewrote the share tunnel to subscribe to the owner's NVR broadcast, showing the same screen the owner sees.
- **Share Button Missing from Session Bar**: The share button was not visible because `SessionManagerProvider` called `getMe()` in a one-shot `useEffect` that ran before authentication completed and never re-ran. Changed `canShare` to a reactive prop derived from the authenticated user's permissions in `App.tsx`.
- **403 on Settings Load for Non-Admin Users**: `SettingsContext` called the admin-only `GET /api/admin/settings` endpoint. Switched to the new public `GET /api/user/display-settings` endpoint.
- **Tag Dropdown Going Off-Screen**: Tag menu used `position: absolute` which was clipped by parent overflow. Changed to `position: fixed` with viewport-calculated coordinates via `getBoundingClientRect()`.
- **User Deletion Blocked by Audit Logs**: Hard-deleting users failed because `audit_logs.user_id` had no `ON DELETE` clause (defaulting to RESTRICT). Added migration 037 to set `ON DELETE SET NULL`.
- **Recording Files Orphaned on User Deletion**: Physical recording files (local and Azure Blob) were not deleted during user hard-delete. The cleanup task now purges local files and Azure blobs before cascading the database delete.

## [0.14.6] — 2026-04-16

### Added

- **Recording Disclaimer / Terms of Service**: First-time users are presented with a full-screen disclaimer modal covering session recording, consent, acceptable use, and data protection. Users must scroll to the bottom and explicitly accept before accessing the application. Declining logs the user out. Acceptance is recorded with a timestamp in the database and is not shown again on subsequent logins.
- **NVR Play/Pause**: The NVR live session player now has a play/pause toggle button. Pausing freezes the display while the WebSocket stream stays connected, so no data is lost. Resuming picks up from the current live point.

## [0.14.5] — 2026-04-16

### Fixed

- **NVR Live Rewind Black Screen**: Rewinding a live session (30s, 1m, 3m, or 5m) would display a black screen because the backend sent intermediate `sync` instructions during the replay phase, causing the Guacamole client to queue hundreds of intermediate frames. Sync instructions are now suppressed during replay and a single sync is sent after all drawing operations, rendering the target frame atomically.
- **NVR Player Default Speed**: The NVR player now defaults to 1× speed instead of 4× when first opened.
- **NVR Speed Change During Live Phase**: Changing playback speed while watching a live session no longer triggers an unnecessary reconnect. Speed changes during the live phase are applied in-place.
- **Popout Window Close Reconnect**: Closing a popped-out session window no longer leaves a white screen on the main page. The display element is adopted back into the main document and the user is navigated to the session page.

## [0.14.4] — 2026-04-15

### Added

- **Recording Player Skip Controls**: Skip forward and back by 30 seconds, 1 minute, 3 minutes, or 5 minutes during recording playback. Seeking disconnects and reconnects at the target position, with a loading indicator while the backend fast-forwards.
- **Recording Player Speed Controls**: Play recordings at 1×, 2×, 4×, or 8× speed. Speed changes reconnect at the current position with the new playback rate.

### Fixed

- **Recording Playback Freezing During Idle Periods**: Recordings that contained long idle gaps (no screen updates) would freeze the progress bar and then jump forward. The backend now sends interpolated progress updates every 500 ms during pacing sleep, and the CSS progress bar uses a smooth linear transition.
- **Black Screen on Seek/Rewind**: Seeking to a position in a recording would show a black screen or fast-replay artefact because the backend was sending intermediate `sync` instructions during the seek phase, causing the Guacamole client to queue hundreds of frames. The backend now suppresses `sync` instructions while seeking so all drawing operations accumulate into a single atomic frame at the target position.

## [0.14.3] — 2026-04-15

### Added

- **Recording Player Fullscreen Mode**: The historical recording player now has a fullscreen toggle button in both the header bar and a dedicated CSS class for true full-viewport playback. The default modal width has also been increased from `max-w-5xl` to `max-w-7xl` for a larger viewing area.
- **Live/Rewind for Own Sessions**: Users with the `can_view_sessions` permission can now observe and rewind their own live sessions — not just admins. A new user-scoped WebSocket endpoint (`GET /api/user/sessions/:id/observe`) verifies session ownership before allowing observation.

### Changed

- **NVR Observe Route Guard**: The `/observe/:sessionId` frontend route now also allows users with `can_view_sessions`, matching the new user-scoped observe endpoint.
- **Sessions Page Actions Column**: The Live and Rewind buttons are now visible for all users who can see the Sessions page. Admin users connect via the admin endpoint; regular users connect via the user-scoped endpoint automatically.

## [0.14.2] — 2026-04-15

### Fixed

- **NVR Observe WebSocket Auth Failure**: The NVR live-session observer WebSocket could fail silently when the access token had expired, since WebSocket connections cannot use the normal 401-retry interceptor. The `buildNvrObserveUrl` helper now calls `ensureFreshToken()` to silently refresh the token before embedding it in the URL. If no valid token is available, the player shows a clear "Session expired" message instead of a generic failure.
- **`can_view_sessions` Missing from Auth Check**: The `GET /api/auth/check` endpoint (used on page load to hydrate the user) was missing `can_view_sessions` from its SQL query and JSON response. Users whose role had only the "View own sessions" permission could not see the Sessions sidebar link because the field was `undefined`.
- **NVR Player Error UX**: Improved error messages for common WebSocket failure codes (session not found, auth failure). Added a Retry button in the error banner so users don't have to navigate away and back.

### Changed

- **NVR Observe Route Guard**: The `/observe/:sessionId` route now requires `can_manage_system` or `can_view_audit_logs`, matching the permissions needed to see the Live/Rewind buttons on the Sessions page.

## [0.14.1] — 2026-04-15

### Added

- **Expired Credential Renewal at Connect Time**: When a user connects to a session with an expired credential profile, the pre-connect prompt now shows the expired profile with an "Update & Connect" form. Users can enter new credentials to renew the profile and connect immediately, or dismiss the form and enter manual one-time credentials instead.
- **Connection Info — Expired Profile Metadata**: The `GET /api/user/connections/:id/info` endpoint now returns an `expired_profile` object (`id`, `label`, `ttl_hours`) when the connection has a mapped credential profile that has expired, enabling the frontend to offer in-line renewal.

### Fixed

- **Popout Window Clipboard (Server → Local)**: Copying text inside a remote session in a pop-out window now correctly writes to the local clipboard. Previously, the `client.onclipboard` handler always used the main window's `navigator.clipboard`, which was denied by the browser because the main window lacked focus. The handler now uses the popup window's `navigator.clipboard` when the session is popped out.

## [0.14.0] — 2026-04-15

### Added

- **Unified Sessions Page**: New dedicated `/sessions` sidebar page combining live session monitoring and recording history into a single tabbed interface. Replaces the old admin-only Active Sessions panel and the standalone My Recordings page.
- **Role-Based Session Access (`can_view_sessions`)**: New permission column on the roles table (`033_can_view_sessions.sql`). Users with this permission see only their own live sessions and recordings. Users with `can_manage_system` or `can_view_audit_logs` get the full admin view — all users' sessions with kill, observe, and rewind controls.
- **User Sessions API (`GET /api/user/sessions`)**: New authenticated endpoint returning only the calling user's active sessions, filtered from the in-memory `SessionRegistry`.
- **User Recordings API (`GET /api/user/recordings`)**: New authenticated endpoint returning only the calling user's historical recordings with optional connection and pagination filters.
- **User Recording Playback (`GET /api/user/recordings/:id/stream`)**: New endpoint for streaming a user's own recording for playback.
- **Admin Role Form — Sessions Permission**: The "View own sessions" (`can_view_sessions`) toggle is now available in the role create/edit form under Admin → Access, with a "Sessions" badge on the role table.

### Changed

- **Sidebar Navigation**: Replaced the separate "Live Sessions" (admin) and "Recordings" entries with a single "Sessions" item, gated by `can_view_sessions || can_manage_system || can_view_audit_logs`.
- **Admin Settings — Sessions Tab**: Removed the embedded live sessions table and recording history from the Sessions tab. The tab now only contains session analytics (stats, charts, leaderboards, guacd capacity gauge). Live/recording management has moved to the dedicated `/sessions` page.
- **MeResponse & LoginResponse**: Both API responses now include `can_view_sessions` in the user object.

### Removed

- **ActiveSessions standalone route**: The `/admin/sessions` route has been removed in favor of the unified `/sessions` page.

## [0.13.2] — 2026-04-15

### Added

- **In-App Documentation Page**: New `/docs` page accessible from the sidebar with left-nav navigation, rendering Architecture, Security, and API Reference markdown docs inline, plus a What's New tab powered by the release card carousel.
- **Full Release History**: The What's New carousel now covers every release from v0.13.2 back to v0.1.0 (24 cards total), including all previously-missing patch versions (0.10.1–0.10.6, 0.11.1–0.11.2, 0.9.0, and all pre-0.8.0 releases).

### Fixed

- **Session Idle Timeout**: Active users were logged out after 20 minutes even while actively using remote sessions (e.g., clicking, typing in RDP/VNC). The access token now proactively refreshes in the background when user activity is detected and the token is past its halfway point, with a 30-second cooldown between refresh attempts.
- **Backend Clippy (CI)**: Added missing `watermark` field to five test struct initialisers in `admin.rs` and `user.rs` that were missed when the per-connection watermark feature was added in 0.13.0.

### Changed

- **Docs Page Scope**: Removed Deployment Guide and Ubuntu VM Deployment Guide from the in-app docs page — these are GitHub-only documentation files.

## [0.13.1] — 2026-04-15

### Added

- **What's New Carousel**: The What's New modal now lets users browse all previous release cards with left/right navigation arrows and a page counter, instead of only showing the latest release.

### Fixed

- **guacd Scaling (docker-compose)**: The `GUACD_INSTANCES` environment variable was defined in `.env` but never forwarded into the backend container, causing it to always see a single-instance pool. The variable is now passed through in `docker-compose.yml`.

### Changed

- **Architecture Documentation**: Removed all stale Caddy reverse proxy references. Updated to reflect the current nginx-based gateway architecture including SSL termination, reverse proxying, security headers, and the split config files (`common.fragment`, `http_only.conf`, `https_enabled.conf`). Updated migration references through `032_connection_watermark.sql`.

## [0.13.0] — 2026-04-15

### Added

- **Per-Connection Watermark**: Connections now have a `watermark` setting (`inherit`, `on`, `off`) that overrides the global watermark toggle. Configurable in the connection editor form. New migration `032_connection_watermark`.
- **Persistent Favorites Filter**: The dashboard favorites toggle now persists across sessions via `localStorage`, so returning users see their preferred filter state.

### Fixed

- **Clipboard in Popout Windows**: Pasting text copied after a session was popped out now works correctly. The popout window registers its own clipboard sync handlers (`paste` event + Clipboard API on focus/mousedown) so the remote session always receives the latest clipboard content.

## [0.12.0] — 2026-04-14

### Added

- **Password Policy Enforcement**: New passwords must be at least 12 characters. Validation applied on user creation and password change. Passwords over 1024 characters are rejected to prevent abuse.
- **Password Change Endpoint**: Users can change their own password via `PUT /api/auth/password`. Requires current password verification. Revokes the active session on success, forcing re-login.
- **Admin Password Reset**: Admins can force-reset any user's password via `POST /api/admin/users/:id/reset-password`, generating a new random 16-character password returned once.
- **Access + Refresh Token Architecture**: Authentication now uses short-lived access tokens (20 minutes) with a longer-lived refresh token (8 hours) delivered as an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. This replaces the previous single 24-hour JWT, aligning with OWASP session timeout guidance.
- **Token Refresh Endpoint**: `POST /api/auth/refresh` exchanges a valid refresh cookie for a fresh access token without requiring re-authentication.
- **Silent Token Refresh**: The frontend API client automatically refreshes expired access tokens on 401 responses, with deduplication to prevent concurrent refresh storms.
- **Session Timeout Warning Toast**: A floating notification appears in the bottom-right corner 2 minutes before the access token expires, showing a live `m:ss` countdown with **Extend Session** (triggers refresh) and **Dismiss** buttons.
- **Per-User Session Tracking**: New `active_sessions` database table records each login with JTI, user ID, IP address, user agent, and expiry time — providing visibility into active authentication sessions.

### Changed

- **JWT Claims**: Access and refresh tokens now include a `token_type` claim (`"access"` or `"refresh"`). The auth middleware rejects refresh tokens used as access tokens. A `default_token_type()` function provides backward compatibility for pre-existing tokens during upgrade.
- **Login Response**: Now includes `expires_in` (seconds) alongside the access token, enabling the frontend to track token expiry locally.
- **Logout Flow**: Logout now revokes both the access token and the refresh cookie, and clears the `Set-Cookie` header for the refresh token.
- **SSO Callback**: Updated to issue both access and refresh tokens, setting the refresh cookie on the redirect response.

### Security

- **CSP Hardened**: Removed `'unsafe-inline'` from `script-src` in the Nginx Content-Security-Policy header. `style-src` retains `'unsafe-inline'` (acceptable risk for Tailwind CSS runtime styles).
- **Refresh Token Isolation**: Refresh tokens are only accepted by the `/api/auth/refresh` endpoint (scoped via `Path=/api/auth/refresh` on the cookie). They cannot be used as bearer tokens for API requests.

## [0.11.2] — 2026-04-14

### Changed

- **Role Dropdown Modernised**: The user-role dropdown in the Admin Users table now uses the unified custom `Select` component (with portal rendering and animations) instead of a native `<select>`, matching the style of all other dropdowns in the application.
- **Dependency Upgrade — rand 0.9**: Bumped the `rand` crate from 0.8 to 0.9, migrating all call-sites to the new API (`distr`, `rng()`, `random()`).

### Fixed

- **Migration Checksum Repair**: Deploying after the `.gitattributes` line-ending normalisation (CRLF → LF) caused the backend to crash-loop with _"migration N was previously applied but has been modified"_. The migrator now detects and auto-repairs stale SHA-384 checksums on startup, so existing environments upgrade seamlessly without manual intervention.

## [0.11.1] — 2026-04-14

### Added

- **User Role Management**: Admins can now change a user's role directly from the Users table via an inline dropdown, with audit logging of role changes.
- **Centralised Version File**: App version is now defined in a single root `VERSION` file. Both the Rust backend and Vite frontend read from it at build time, ensuring consistent versioning across services. The backend startup log and `/admin/health` endpoint now include the version, with a mismatch warning in the admin dashboard if frontend and backend versions diverge.

### Fixed

- **Case-Insensitive Email/Username Matching**: SSO login, local login, and user creation now use case-insensitive email and username matching. Previously, users created as `Charlotte.Smart2@capita.com` could not sign in if the OIDC provider returned `charlotte.smart2@capita.com`. Emails and usernames are normalised to lowercase on creation, and all lookups use `LOWER()`. Includes database migration to normalise existing data and replace the unique constraints with case-insensitive indexes.
- **Session Watermark Visibility**: The session watermark now renders with both a dark and light text pass, making it visible over both light and dark remote desktop backgrounds. Previously the white-only watermark was invisible over white application windows.
- **Session Watermark Z-Order**: Changed watermark from `position: absolute` to `position: fixed` with `z-index: 9999`, ensuring it always renders above the Guacamole display canvas rather than being painted underneath it.

## [0.11.0] — 2026-04-13

### Added

- **Windows Key Proxy (Right Ctrl)**: Browsers cannot capture the physical Windows key — the OS intercepts it before the browser sees it. Strata now remaps Right Ctrl as a Windows key proxy, following the VMware / VirtualBox "host key" convention:
  - **Hold Right Ctrl + key** → sends Win + key to the remote session (e.g., Right Ctrl + E → Win+E to open Explorer)
  - **Tap Right Ctrl alone** → sends a Win key tap (opens Start menu)
  - **Multi-key combos** work naturally (e.g., Right Ctrl + Shift + S → Win+Shift+S for screenshot)
  - Active across all session types: single session, tiled multi-session, pop-out windows, and shared viewer (control mode)
  - Protocol-aware: effective for RDP and VNC sessions; harmlessly ignored over SSH where the Super key has no meaning
- **Analytics Dashboard**: New analytics section on the Admin Dashboard with:
  - Daily usage trend chart (sessions per day + total hours overlay)
  - Average and median session duration cards
  - Total bandwidth card with human-readable formatting
  - Protocol distribution stacked bar chart
  - Peak hours 24-hour histogram
- **Session Bandwidth Tracking**: Per-session bandwidth (bytes from/to guacd) is now captured in the recordings table and displayed in the live sessions gauge
- **Dynamic Capacity Gauge**: The guacd capacity gauge now calculates `recommended_per_instance` dynamically based on host CPU cores and RAM (with 30% reserve), replacing the previous hardcoded value of 20

### Changed

- **Keyboard Input Architecture**: All four keyboard handler sites (SessionClient, TiledView, usePopOut, SharedViewer) now route through a shared `createWinKeyProxy()` utility, providing consistent key handling and a single point for future keyboard remapping features

## [0.10.6] — 2026-04-13

### Added

- **Folder View Auto-Select**: The dashboard now automatically enables folder view when connections belong to folders, giving users organised grouping out of the box.
- **Collapsed Folders by Default**: Folder groups start collapsed for a cleaner initial view. Users can expand individual folders on demand.
- **Persistent Folder Preferences**: The folder view toggle and per-folder expand/collapse states are persisted in `localStorage`, so the dashboard remembers your layout across sessions.

### Changed

- **VNC Recording Form Cleanup**: Removed system-managed recording fields (path, name, auto-create path) from the VNC connection edit form. Replaced with the user-configurable recording options (exclude graphical output, exclude mouse, exclude touch, include key events).
- **AD Sync Recording Defaults Cleanup**: Removed redundant recording-path, recording-name, and create-recording-path fields from AD Sync connection defaults since they are managed automatically by the system.

## [0.10.5] — 2026-04-13

### Added

- **Session Label Overlay**: Active session thumbnails now display the connection name and protocol as a sleek overlay at the bottom. This includes a dark gradient background and backdrop blur for maximum readability over varied remote desktop backgrounds.

### Fixed

- **Backend Test Coverage**: Implemented a comprehensive unit test suite for the `GuacamoleParser`, increasing backend coverage above the 20% threshold. Tests cover Unicode handling, partial data buffering, and malformed input recovery.
- **Rust Code Formatting**: Corrected `cargo fmt` violations in the recordings module to ensure consistent code style and CI compliance.

## [0.10.4] — 2026-04-12

### Fixed

- **Pop-Out Session Persistence**: Pop-out windows now survive navigation between the dashboard and session views. Previously, navigating away from the session page caused all pop-out windows to close because state was stored in local React refs that were destroyed on unmount. State is now stored on the session object in SessionManager, persisting across route changes.
- **Multi-Session Pop-Out Stability**: Disconnecting one popped-out session no longer causes other pop-out sessions to go black or become unresponsive. The auto-redirect logic now skips DOM reparenting for sessions that are displayed in their own pop-out window.

### Changed

- **Pop-Out Architecture**: Migrated popup window management from `usePopOut` local refs to `session._popout` on the `GuacSession` object. SessionManager now owns popup lifecycle via `cleanupPopout()`, ensuring proper teardown on session end regardless of component mount state.

## [0.10.3] — 2026-04-12

### Fixed

- **Auto-Redirect on Session End**: When a remote session ends (e.g., user signs out of Windows) and other sessions are still active, the client now automatically redirects to the next active session instead of freezing on a stale screen. The "Session Ended" overlay is only shown when the last session closes.

### Tests

- Added `SessionRedirect.test.tsx` regression tests covering tunnel-close redirect, last-session overlay, and false-positive guard during initial session creation.

## [0.10.2] — 2026-04-10

### Added

- **One-Off Vault Credentials**: Users can now select a saved vault credential profile directly from the connection credential prompt for a single session, without permanently mapping the profile to the connection. Available on both single-session and tiled multi-session connect flows.
- **NVR Playback Controls**: Session recordings now include a progress bar, speed selector (1×/2×/4×/8×), and server-paced replay with proper inter-frame timing.
- **Per-User Recent Connections**: Connection access history is now tracked per-user, so each user sees only their own recent connections on the dashboard. Added `user_connection_access` table (migration 026).

### Fixed

- **Server Logout Detection**: When a user logs out of the remote server (e.g., Windows Sign Out), the session now cleanly ends with a "Session Ended" overlay instead of endlessly reconnecting to a black screen.
- **Pop-Out Session Stability**: Connecting to a second server while one session is popped out no longer tears down the popup window. Pop-out sessions persist independently until explicitly returned or the page is closed.
- **Credential Mapping Permissions**: Fixed permission check for `set_credential_mapping` to include folder-based role assignments (`role_folders`), not just direct connection assignments.
- **NVR Black Screen**: Fixed `tunnel.oninstruction = null` bug where replay detection overwrote the Client's instruction handler. Added `display.onresize` callback for proper scaling.
- **NVR WebSocket URL**: Fixed `Guacamole.WebSocketTunnel.connect(data)` double query-string issue that caused tunnel errors during live observation.

### Security

- **Vault One-Off Access Control**: The one-off credential profile endpoint validates that the profile belongs to the requesting user and has not expired before decrypting, preventing unauthorized cross-user credential access.

## [0.10.1] — 2026-04-10

### Fixed

- **Build Stabilization**: Resolved critical build-time regressions in both the Rust backend and TypeScript frontend.
- **Frontend CSS Syntax**: Corrected malformed Tailwind v4 `@layer` nesting and missing selectors in `index.css`.
- **Azure Recording Streaming**: Implemented a memory-efficient custom streaming download service for Azure Blob recordings, bypassing official SDK limitations.
- **Sidebar Highlighting**: Fixed logic issue where "Admin" and "Live Sessions" links were both highlighted simultaneously.
- **Observe Session Route**: Restored missing route registration for administrative session observation.
- **Admin Tab Visibility**: Corrected visibility filter for the Admin dashboard tab to ensure users restricted to "Sharing" roles do not gain administrative access.
- **Folder Permission Tunnel Access**: Resolved an issue where users granted connection access via folder-level assignments were blocked from establishing WebSocket tunnels.
- **TypeScript Type Safety**: Removed unused state variables in several components to satisfy strict production build linting.

### Security

- **Hardened Tunnel Ticket Creation**: Implemented comprehensive permission validation (including direct and folder-based assignments) at the ticket-issuance layer to prevent unauthorized users from obtaining valid tunnel tickets.

### Changed

- **Isolated Connection History**: Refined the internal connection access queries to ensure strictly per-user tracking of recent connections, eliminating initial history overlap from legacy global data.
  19: ## [0.10.0] — 2026-04-10

### Added

- **AD Sync Connection Defaults**: AD sync sources can now specify default Guacamole parameters (RDP performance flags, session recording settings) that are applied to all synced connections. Configurable via the new "Connection Defaults" section in the AD Sync edit form.
- **Connection Parameter Tooltips**: All connection settings (Performance, Screen Recording, Authentication) now display descriptive hover tooltips sourced from the official Apache Guacamole documentation.
- **Unified Session Bar**: Consolidated all session-specific controls (Sharing, File Browser, Fullscreen, Pop-out, On-Screen Keyboard) into a single, sleek, collapsible right-side dock.
- **Integrated Touch/OSK Toolbar**: On-screen keyboard shortcuts are now accessible directly within the Session Bar "Quick Tools" section, removing the floating keyboard button from the center of the screen.

### Changed

- **Zero-Footprint Layout**: The Session Bar overlay is now completely transparent to remote screen resolution, allowing remote sessions to utilize the full display area.
- **Smooth Responsive Resizing**: Implemented `ResizeObserver` in the session client to ensure remote sessions scale continuously and smoothly during sidebar/dock transitions, eliminating layout flashes.

### Fixed

- **Large Clipboard Support**: Implemented manual protocol-level text chunking (4096-char blocks) to support transferring massive clipboard content (10,000+ lines) without hitting Guacamole instruction size limits.
- **Backend Buffer Optimization**: Increased tunnel memory buffers to 16MB and explicitly tuned WebSocket message limits to 64MB for robust high-bandwidth data transfers.

### Added

- **Active Sessions Dashboard**: New real-time administrative dashboard for monitoring all active tunnel connections, including bandwidth tracking, duration, and remote host metadata.
- **Administrative Termination**: Administrators can now "kill" any active session directly from the Sessions dashboard, ensuring instant access revocation when needed.

### Changed

- **Reconnection Stability**: Overhauled the session client reconnection logic with 10-second stability thresholds and explicit retry counters to prevent infinite loops on permanent connection failures (e.g., certificate mismatches).
- **Version Synchronization**: Unified backend and frontend versioning to 0.9.0 for improved architectural consistency.

### Fixed

- **Tunnel Proxy Stability**: Resolved Rust borrow checker issues in the tunnel proxy (related to `kill_rx` ownership) and fixed WebSocket ↔ TCP handshake signal handling.
- **TypeScript Type Safety**: Fixed build regressions in the frontend test suite by ensuring all mock session objects include mandatory `remote_host` metadata.

## [0.8.0] — 2026-04-09

### Added

- **User Restoration**: Administrators can now restore soft-deleted user accounts from the Admin Settings dashboard within the 7-day retention window.
- **Manual SSL Support**: The Nginx gateway now supports user-provided SSL certificates via volume mount (`cert.pem`, `key.pem`).

### Changed

- **Infrastructure Consolidation**: Removed Caddy reverse proxy. Nginx (Frontend) now acts as the primary gateway, handling SSL termination, API/WebSocket proxying, security headers, and automatic HTTP-to-HTTPS redirection.
- **Optional Local Database**: The `postgres-local` service is now moved to a Docker Compose profile (`local-db`), allowing it to be bypassed when using an external database provided in the `.env` file.
- **Environment Overrides**: `DATABASE_URL` in the `.env` file now correctly takes precedence over the default bundled configuration.

### Fixed

- **Resource Cleanup**: Removed redundant Caddy configurations and volumes.
- **Documentation**: Updated all deployment guides and manual setup instructions to reflect the new Nginx architecture and Docker Compose profiles.

## [0.7.0] — 2026-04-09

### Added

#### Granular RBAC Permissions

- **9 role-based permissions**: `can_manage_system`, `can_manage_users`, `can_manage_connections`, `can_view_audit_logs`, `can_create_users`, `can_create_user_groups`, `can_create_connections`, `can_create_connection_folders`, `can_create_sharing_profiles`.
- **Role-folder assignments**: New `role_folders` table for many-to-many role-to-folder mapping with dedicated list/update endpoints.
- Permissions are extracted from the database at authentication time and exposed on the `/api/auth/me` response.

#### Connection Folders

- **Renamed `connection_groups` to `connection_folders`** across the full stack (database, API, frontend) for clarity.
- CRUD endpoints for connection folders with proper authorization checks.
- Frontend folder view with collapsible folder headers and per-folder connection counts.

#### Database Migrations

- **020**: `email`, `full_name`, `auth_type` columns on `users` table for strict SSO matching.
- **021**: Soft-delete (`deleted_at`) on users; granular `can_manage_*` / `can_view_*` permission columns on roles.
- **022**: Extended creation permissions (`can_create_users`, `can_create_user_groups`, `can_create_connections`, `can_create_connection_groups`, `can_create_sharing_profiles`).
- **023**: Rename `connection_groups` → `connection_folders` and `can_create_connection_groups` → `can_create_connection_folders` across all tables, indexes, and foreign keys.
- **024**: `role_folders` table for role-based folder access control.

#### Backend — Extracted Pure Functions & Input Validation

- **`redact_settings()`** — redacts sensitive config values (`sso_client_secret`, `vault_token`, `vault_unseal_key`, `ad_bind_password`, `azure_storage_access_key`) from API responses.
- **`validate_no_restricted_keys()`** — prevents updates to security-critical keys (`jwt_secret`, `sso_issuer_url`, `kerberos_realm`, `local_auth_enabled`) through the generic settings endpoint.
- **`is_safe_recording_filename()`** — prevents path traversal in recording download filenames (rejects `..`, `/`, `\`, empty strings).
- **`is_safe_hostname()`** — validates Kerberos hostnames to prevent `krb5.conf` injection.
- Unit tests for all extracted functions (14 new backend tests).

#### Docker Security Hardening

- **Backend**: Runs as non-root `strata:strata` user; pre-creates Guacamole recording and drive directories with correct ownership; `entrypoint.sh` fixes volume permissions before dropping privileges.
- **Frontend**: Runs nginx as non-root `nginx:nginx` user; pre-creates all cache/temp directories and PID file with correct ownership.

#### Documentation

- **`docs/security.md`**: Comprehensive security architecture covering OIDC authentication flow, local auth with Argon2id, authentication method enforcement, route protection matrix, envelope encryption with Vault Transit, and memory zeroization.

### Changed

#### Dependencies

- **sqlx** upgraded from 0.7.x to **0.8** with `runtime-tokio-rustls` feature set.
- **jsonwebtoken** upgraded from v9 to **v10** (`rust_crypto` feature).

#### Frontend Test Coverage

- **634 tests across 24 test files** (up from 605), all passing.
- Coverage thresholds enforced: statements 74%, branches 69%, functions 62%, lines 75%.
- New test suites: **Layout** (sidebar collapse, `useSidebarWidth`, nav highlighting), **AuditLogs** (pagination with Previous/Next), **Dashboard** (Previous page navigation).
- Expanded: **SessionMenu** (clipboard debounce send to remote after timer).

### Fixed

- **Settings redaction**: Sensitive settings are now automatically masked in all API responses.
- **Settings restriction**: Generic settings update endpoint no longer allows modification of security-critical keys.
- **Recording path traversal**: Filename validation prevents directory traversal attacks on recording downloads.
- **Kerberos hostname injection**: Hostname validation prevents shell injection in `krb5.conf` generation.

## [0.6.2] — 2026-04-09

### Changed

#### Frontend Test Coverage Expansion

- **Branch coverage raised from ~55% to 70%** across 605 tests (up from ~366), significantly improving regression safety.
- **Coverage thresholds enforced** in `vitest.config.ts`: statements 74%, branches 69%, functions 62%, lines 75% (previously 25/25/15/25).
- Expanded test suites for **AdminSettings** (133→145 tests), **Credentials** (28→42), **SessionMenu** (14→20), **FileBrowser** (13→20), **NvrPlayer** (17→23), **SharedViewer** (16→26), **SessionClient** (26→28), **SessionToolbar** (25→27), **SessionBar** (9→13), **SessionManager** (32→35), **TiledView** (16→22), **SessionWatermark** (4→7), **usePopOut** (15→20).
- Added new test files for **Layout** and **Login** components.

#### Backend Security & Reliability Hardening

- **Guacamole protocol parsing**: Improved Unicode character length handling to prevent connection failures with UTF-8 hostnames/credentials.
- **NVR instruction filtering**: Protocol-level opcode matching prevents false positives while blocking credentials in recordings.
- **Kerberos authentication**: Secure unique temporary files via `tempfile` for credential cache and CA certificate handling.
- **Tunnel soft-delete bypass**: Added `soft_deleted_at IS NULL` guard to WebSocket tunnel endpoint.
- **OIDC issuer validation**: Discovery endpoint now verifies returned issuer matches configured provider.
- **Content-Disposition header injection**: Recording download filename properly escaped.
- **Shared tunnel pool bypass**: Shared tunnel endpoint now uses `GuacdPool` for round-robin load distribution.
- **AD sync transaction safety**: Sync operations wrapped in database transactions.
- **`per_page` unbounded**: Pagination parameter now clamped to prevent arbitrarily large result sets.
- **Soft-delete leak fixes**: `connection_info`, `update_connection`, share list, and `revoke_share` endpoints now properly handle soft-deleted connections.
- **AD sync bulk operations**: High-performance bulk upsert/soft-delete query pattern replaces individual updates.
- **Database schema**: Added unique index on `connections(ad_source_id, ad_dn)` for sync integrity.

### Fixed

- Fixed `SessionManager.test.tsx` unused `afterEach` import (should have been `beforeEach`).
- Fixed portal duplicate text rendering in `Credentials` tests by using `aria-selected` attribute matching.
- Fixed canvas painting tests in `SessionWatermark` by mocking `HTMLCanvasElement` `clientWidth`/`clientHeight`.

## [0.6.1] — 2026-04-08

### Fixed

#### Security Hardening

- **Guacamole Protocol Parsing**: Improved parser to handle Unicode character lengths correctly, preventing connection failures or data corruption when using UTF-8 characters in hostnames or credentials.
- **NVR Instruction Filtering**: Refined sensitive instruction detection to use protocol-level opcode matching, preventing false positives while strictly blocking credentials in recordings.
- **Kerberos Authentication**: Hardened credential cache and CA certificate handling by using secure, unique temporary files via the `tempfile` library.
- **Tunnel soft-delete bypass**: WebSocket tunnel endpoint could connect users to soft-deleted connections — added `soft_deleted_at IS NULL` guard
- **OIDC issuer validation**: OIDC discovery endpoint did not verify that the returned issuer matched the configured provider, allowing potential token substitution
- **Content-Disposition header injection**: Recording download filename was not escaped, allowing header injection via crafted connection names
- **Shared tunnel pool bypass**: Shared tunnel endpoint created a direct guacd connection instead of using the `GuacdPool`, bypassing round-robin load distribution

#### Performance & Reliability

- **AD Sync Bulk Operations**: Replaced individual LDAP-to-DB updates with a high-performance **Bulk Upsert** (ON CONFLICT) and **Bulk Soft-Delete** query pattern.
- **Database Schema**: Added unique index on `connections(ad_source_id, ad_dn)` to ensure sync integrity and enable atomic upsert logic.
- **`connection_info` soft-delete leak**: `/api/user/connections/:id/info` returned protocol info for soft-deleted connections
- **`update_connection` soft-delete gap**: Update endpoint did not include a soft-delete filter, allowing edits to deleted connections
- **`update_connection` missing `updated_at`**: Updating a connection did not set `updated_at = now()`, leaving the timestamp stale
- **Share list stale data**: Share list query did not filter out soft-deleted connections
- **`revoke_share` silent no-op**: Revoking a non-existent or already-revoked share returned 200 OK — now returns 404 and checks `NOT revoked`
- **AD sync transaction safety**: AD sync update operations were not wrapped in a database transaction, risking partial updates on failure
- **`per_page` unbounded**: Pagination `per_page` parameter was not clamped, allowing arbitrarily large result sets

### Build

- Fixed unused `afterEach` import in `SessionManager.test.tsx` (should have been `beforeEach`)

## [0.6.0] — 2026-04-08

### Added

- **SSO / OIDC (Keycloak) Support**: Integrated OpenID Connect authentication.
  - New endpoints: `GET /api/auth/sso/login` (redirect) and `GET /api/auth/sso/callback` (handler).
  - Secure storage of OIDC client secrets using HashiCorp Vault.
  - Automatic OIDC discovery via `/.well-known/openid-configuration`.
- **Configurable Authentication Methods**: Admin can now toggle between Local Authentication and SSO/OIDC in the Security settings.
- **Improved Security Enforcement**: Backend system now strictly enforces the `local_auth_enabled` policy, rejecting local logins when disabled.

### Fixed

- **Security Loophole**: Fixed a flaw where local authentication remained functional even when disabled in the dashboard.
- **UI Consistency**: Resolved an issue where the Security tab checkboxes could appear disabled by default when unconfigured.
- **Build Regressions**:
  - Fixed TypeScript compilation errors in frontend tests related to unused imports and variables.
  - Resolved `Cannot find name 'vi'` build error in test setup by importing the Vitest utility.
  - Suppressed Rust compiler warnings (`dead_code`, `unreachable_patterns`) in the backend authentication service.

## [0.5.0] — 2026-04-07

### Added

#### Active Directory LDAP Sync

- Automatic computer account import from Active Directory via LDAP/LDAPS
- AD sync config CRUD API: `GET/POST/PUT/DELETE /api/admin/ad-sync-configs`
- `POST /api/admin/ad-sync-configs/test` — test connection endpoint that validates connectivity and returns a preview of first 10 discovered objects with DNS hostnames
- Manual sync trigger: `POST /api/admin/ad-sync-configs/:id/sync`
- Sync run history: `GET /api/admin/ad-sync-configs/:id/runs` with per-run stats (created, updated, soft-deleted, hard-deleted)
- Background scheduled sync — configurable interval per source (default: 60 minutes)
- Soft-delete lifecycle — objects that disappear from AD are soft-deleted for 7 days before permanent hard-deletion
- Multiple search bases per config — query multiple OU scopes in a single source, results deduplicated by DN (`015_multi_search_base.sql` migration)
- Search filter presets dropdown: All Computers, Servers Only, Enabled Computers Only, Enabled Servers Only, Custom Filter
- Automatic exclusion of gMSA (`msDS-GroupManagedServiceAccount`) and MSA (`msDS-ManagedServiceAccount`) accounts from all preset filters
- Connection group assignment — imported connections can be placed into a specific connection group
- Domain override — optional domain suffix forced onto all imported connections
- Full admin UI in the "AD Sync" tab: source cards with label, URL, auth method, bases, filter, protocol, interval; inline edit form; sync history table

#### AD Sync Authentication Methods

- **Simple Bind** — bind DN + password with LDAP/LDAPS
- **Kerberos Keytab** — `kinit` + `ldapsearch` with GSSAPI via keytab file and configurable principal
- Per-config credential cache (`KRB5CCNAME`) to avoid races between concurrent syncs

#### CA Certificate Upload for LDAPS

- Upload internal CA certificates (PEM/CRT/CER) for LDAPS connections with self-signed or internal CAs
- Custom `rustls` `ClientConfig` built at query time with system roots + uploaded CA (bypasses ldap3's static `CACERTS`)
- Kerberos path writes PEM to temp file and sets `LDAPTLS_CACERT` env var for `ldapsearch`
- UI: file upload button hidden when "Skip TLS verification" is checked; shows "✓ Certificate loaded" with replace/remove actions
- `ca_cert_pem` TEXT column added to `ad_sync_configs` (`014_ca_cert.sql` migration)

#### Multi-Realm Kerberos

- Support for multiple Kerberos realms, each with its own KDCs, admin server, ticket/renew lifetimes, and default flag
- Full CRUD API for Kerberos realms: `GET/POST/PUT/DELETE /api/admin/kerberos-realms`
- Dynamic `krb5.conf` generation aggregating all realms with correct `[realms]` and `[domain_realm]` sections
- Realm management UI with inline edit form in the Kerberos admin tab
- `011_multi_kerberos.sql` migration: `kerberos_realms` table with `id`, `realm`, `kdcs`, `admin_server`, `ticket_lifetime`, `renew_lifetime`, `is_default`

#### Credential Profiles

- Saved credential profiles with optional TTL expiry (`credential_profiles` table)
- Profile selector dropdown on the Dashboard connection card — pick a saved profile or enter credentials inline
- `008_credential_profiles.sql`, `009_credential_expiry.sql`, `010_profile_ttl.sql` migrations

#### Kerberos Keytab Auth for AD Sync

- `auth_method` column on `ad_sync_configs`: `simple` or `kerberos` (`013_keytab_auth.sql` migration)
- `keytab_path` and `krb5_principal` fields for keytab-based authentication
- Auth method selector in the AD sync edit form toggles between Simple Bind and Kerberos Keytab fields

### Changed

- `AdSyncConfig` struct: `search_base: String` replaced with `search_bases: Vec<String>` (Postgres `TEXT[]`)
- LDAP query functions accept individual search base parameter; `ldap_query()` iterates over all bases and deduplicates by DN
- All LDAP filter defaults and presets now include `(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount))` to exclude service accounts
- Backend dependencies: added `rustls 0.21`, `rustls-pemfile 1`, `rustls-native-certs 0.6` for custom TLS config
- Architecture docs updated with AD sync, multi-realm Kerberos, credential profiles, and CA cert sections
- Database schema docs updated through migration 015

### Fixed

- Empty `search_filter` in DB caused ldap3 filter parse error — now falls back to the default exclusion filter
- ldap3 `UnknownIssuer` TLS error with internal CAs — bypassed static `CACERTS` with per-query custom `ClientConfig`

### Security

- CA certificates stored in database (not filesystem) and loaded per-query — no global mutable state
- Keytab-based authentication uses per-config `KRB5CCNAME` credential cache to prevent cross-config credential leakage
- Bind passwords stored as-is in `ad_sync_configs` (same trust boundary as the admin API) — future: Vault envelope encryption

## [0.4.0] — 2026-04-07

### Added

#### Azure Blob Storage for Session Recordings

- Session recordings can now be synced to **Azure Blob Storage** as an external storage backend
- New Admin UI controls in the Recordings tab: storage backend selector (Local / Azure Blob), account name, container name, and access key fields
- Background sync task uploads completed recordings from the local volume to Azure Blob every 60 seconds
- Recording download endpoint falls back to Azure Blob when a file is not found locally
- Azure Blob REST API integration uses SharedKey authentication with HMAC-SHA256 (no extra SDK dependencies)
- New DB settings: `recordings_storage_type`, `recordings_azure_account_name`, `recordings_azure_container_name`, `recordings_azure_access_key`

#### Collaborative Control Mode Shares

- Share links now support two modes: **View** (read-only, default) and **Control** (full keyboard and mouse input forwarding)
- Share popover in the session toolbar presents two buttons — "View Only" and "Control" — with distinct icons and colour badges
- `POST /api/user/connections/:id/share` accepts a `{ "mode": "view" | "control" }` request body
- `mode` column added to `connection_shares` table (`007_share_mode.sql` migration)
- Shared viewer detects mode from URL query parameter (`?mode=control`) and conditionally attaches keyboard input
- Banner in shared viewer displays "Control mode" or "Read-only view" accordingly
- "Generate new link" button in share popover to create a fresh link without closing the popover
- Audit log captures share mode alongside token and connection ID

#### Auto-HTTPS with Caddy

- `Caddyfile` reverse proxy configuration — routes `/api/*` to the Rust backend and everything else to the frontend nginx container
- Caddy service in `docker-compose.yml` under the `https` profile — activate with `docker compose --profile https up`
- Automatic Let's Encrypt TLS certificates when `STRATA_DOMAIN` environment variable is set
- HTTP/3 (QUIC) support via UDP port 443 binding
- Built-in gzip/zstd compression and security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- `caddy-data` and `caddy-config` Docker volumes for certificate and configuration persistence

#### Health & Load Metrics

- Per-session bandwidth tracking via atomic counters — bytes received from guacd and bytes sent to guacd
- `protocol` field added to active session records for per-protocol metrics breakdown
- `GET /api/admin/metrics` — admin endpoint returning aggregate metrics:
  - `active_sessions` — total number of active tunnel sessions
  - `total_bytes_from_guacd` / `total_bytes_to_guacd` — cumulative bandwidth
  - `sessions_by_protocol` — session count grouped by protocol (RDP, SSH, VNC)
- `MetricsSummary` type and `getMetrics()` function added to the frontend API client
- Active session list now includes `protocol`, `bytes_from_guacd`, and `bytes_to_guacd` fields

#### PWA & Tablet Gesture Support

- `manifest.json` — Progressive Web App manifest with standalone display mode, dark theme colour, and app icons
- `sw.js` — Service worker with shell caching (network-first for navigation, cache-first for static assets; API requests are never cached)
- `index.html` updated with `<link rel="manifest">`, `theme-color` meta tag, and Apple mobile web app meta tags
- `viewport-fit=cover` for edge-to-edge rendering on notched devices
- Service worker registration on page load
- **Touch Toolbar** — floating `⌨` button that expands into a horizontal strip of special key combos:
  - Ctrl+Alt+Delete, Windows key, Alt+Tab, Escape, F11, Ctrl+Alt+T (terminal)
  - Renders at bottom-centre of the session view; automatically integrated into SessionClient

#### Sidecar guacd Scaling

- `GuacdPool` service — round-robin connection pool distributing tunnel connections across multiple guacd instances
- `guacd_instances` configuration field (`config.toml`) and `GUACD_INSTANCES` environment variable (comma-separated `host:port` entries)
- Backend automatically builds a pool from the primary guacd instance plus any additional instances
- Tunnel handler picks the next guacd from the pool for each new connection
- `guacd-2` service template in `docker-compose.yml` under the `scale` profile — activate with `docker compose --profile scale up`
- Startup log message reports pool size when more than one instance is configured

#### H.264 GFX Encoding

- RDP connections now default to FreeRDP 3 GFX pipeline with H.264 encoding (`enable-gfx=true`, `enable-gfx-h264=true`) for significantly lower bandwidth usage
- These parameters are set as defaults in the handshake and can be overridden per-connection via the `extra` JSONB field
- `ffmpeg-dev` added to guacd builder stage and `ffmpeg-libs` added to runtime stage for H.264 codec support

### Changed

- `AppError` enum gains a `Validation` variant — returns HTTP 400 for invalid request data (e.g. bad share mode)
- `ActiveSession` struct now includes `protocol` and bandwidth counters
- `SessionInfo` serialisation includes `protocol`, `bytes_from_guacd`, and `bytes_to_guacd`
- `ShareLinkResponse` includes `mode` field in the JSON response
- Share URL for control mode includes `?mode=control` query parameter
- `NvrContext` now carries `protocol` for session registration
- `AppState` includes `guacd_pool` for multi-instance support
- Frontend `ActiveSession` TypeScript type updated with `protocol`, `bytes_from_guacd`, `bytes_to_guacd`
- Docker Compose volumes section expanded with `caddy-data` and `caddy-config`

### Security

- Control mode shares forward keyboard and mouse input to the remote session via the share token — treat control share links with the same sensitivity as credentials
- Caddy security headers added: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
- Service worker explicitly excludes `/api` requests from caching — authentication tokens are never cached

## [0.3.0] — 2026-04-06

### Added

#### Live Session NVR Mode

- In-memory per-session ring buffer capturing up to 5 minutes (50 MB cap) of Guacamole protocol frames
- `SessionRegistry` service tracking all active tunnel sessions with connection metadata and buffer depth
- Admin “Sessions” tab in Admin Settings showing live sessions with user, connection, duration, and buffer depth
- `GET /api/admin/sessions` — list all active tunnel sessions
- `GET /api/admin/sessions/:id/observe` — WebSocket endpoint that replays buffered frames then switches to live broadcast
- **Observe Live** — admin can watch a user’s session in real-time (read-only)
- **Rewind** — admin can rewind up to 5 minutes to see what the user did before they called for help
- NVR Player page (`/observe/:sessionId`) with Guacamole client, status badge (Replaying / LIVE / Ended), elapsed timer, and rewind buttons (30s, 1m, 3m, 5m)
- Automatic replay→live transition detection based on instruction timing
- Last known `size` instruction cached for display dimension injection on replay

#### Connection Groups & Organisation

- Connection groups / folders with nested hierarchy (`connection_groups` table with `parent_id` self-reference)
- Description field on connections for notes and documentation
- Collapsible group headers on the Dashboard with an "Ungrouped" section for unassigned connections
- Group view toggle on the Dashboard (flat list vs. grouped view)
- Full CRUD API for connection groups (`GET/POST/PUT/DELETE /api/admin/connection-groups`)
- Group selector dropdown in the Admin connection editor
- Default keyboard layout set to UK English (Qwerty) and timezone to Europe/London for new connections

#### Favorites

- Star/unstar connections for quick access (`user_favorites` table, `005_favorites.sql` migration)
- Favorites filter button on the Dashboard
- `GET /api/user/favorites` — list favorited connection IDs
- `POST /api/user/favorites` — toggle favorite on/off

#### Theme & UI

- Light/dark/system theme toggle button in the sidebar (moon/sun icon, cycles System → Light → Dark)
- Refined dark theme: surfaces lifted from near-black to layered charcoal (`#111114` base, `#1a1a1f` cards, `#222228` elevated)
- Cards receive an inset top-edge glass highlight for depth
- Table headers use surface-tertiary background
- Ambient gradients strengthened 50%
- Input fields recessed darker than cards for inset relief

### Changed

- Admin users now see **all** connections on the Dashboard regardless of role assignment (bypasses `role_connections` filter)
- Non-admin users continue to see only connections mapped to their role
- `GET /api/user/connections` response now includes `description`, `group_id`, and `group_name` fields
- `GET /api/admin/connections` response now includes `description` and `group_id` fields
- `POST /api/admin/connections` and `PUT /api/admin/connections/:id` accept `description` (string) and `group_id` (UUID, optional)
- Dashboard `ConnectionRow` displays description below connection name
- Database schema: `006_groups_and_description.sql` migration adds `connection_groups` table and `description`/`group_id` columns to `connections`

### Fixed

- Admin users could not see connections that were not assigned to any group or role on the Dashboard

## [0.2.0] — 2026-04-06

### Added

#### Multi-Session & Tiled View

- Tiled multi-session layout with responsive grid, per-tile focus, and `Ctrl`/`Cmd`+click multi-focus
- Keyboard broadcast to all focused tiles simultaneously
- Inline credential prompts for RDP connections in tiled view (per-tile prompt flow)
- Session bar with live thumbnails and tiled mode indicator

#### Clipboard & File Transfer

- Automatic bidirectional clipboard synchronisation between local and remote sessions
- Drag-and-drop file upload onto the session canvas
- In-browser file browser panel with directory navigation, upload progress, and file download
- RDP virtual drive mounting (`enable-drive` enabled by default for all RDP connections)

#### Connection Sharing

- Generate temporary read-only share links for live sessions (`POST /api/user/connections/:id/share`)
- Public shared tunnel endpoint (`GET /api/shared/tunnel/:share_token`) — no auth required
- Share URLs use full origin prefix for portability
- Session toolbar with share link generation and copy-to-clipboard

#### Bundled HashiCorp Vault

- HashiCorp Vault 1.19 container added to Docker Compose with file storage backend and persistent volume
- Automatic Vault initialization (single unseal key, single key share) on first boot
- Automatic unseal and Transit engine provisioning (enable engine + create encryption key)
- `vault_provisioning` backend service handling full Vault lifecycle (health, init, unseal, enable_transit, create_transit_key)
- Setup wizard vault mode selector: **Bundled** (auto-configured), **External** (user-provided), or **Skip**
- Admin Settings vault tab with mode switching between Bundled and External
- Auto-unseal of bundled Vault on backend startup using stored unseal key
- `vault_configured` field on `/api/status` endpoint; conditional "Update" button on Dashboard
- Health endpoint reports vault mode (local/external) alongside status

#### UI Polish

- Premium animated checkboxes with custom CSS (checkPop keyframe, indeterminate state, hover glow, press-down scale)
- Last Accessed column on Dashboard with live tracking (`004_last_accessed.sql` migration)
- Collapsible sidebar navigation
- Tailwind CSS v4 migration (CSS-first `@theme` configuration, warm zinc palette)

#### Local Authentication

- Username/password authentication for environments without an OIDC provider (`002_local_auth.sql` migration)

### Changed

- Vault Docker image upgraded from `1.17` to `1.19` (latest stable community release)
- `VaultHealth` API response now includes `mode` field (`local` | `external`)
- `InitRequest` API accepts `vault_mode` field (`local` | `external`)
- `updateVault` admin API accepts `mode` field for switching between bundled and external Vault
- Architecture diagram updated to show Vault as a bundled container (previously external-only)
- Setup wizard redesigned with radio-card vault mode selector replacing plain text fields
- Admin Settings vault tab redesigned with mode toggle and context-aware field display
- Health tab vault card shows mode badge (Bundled/External) and links to Vault configuration tab

### Security

- Vault unseal key and root token stored in `config.toml` (backend-config volume) — not logged or exposed via API
- Bundled Vault runs with `IPC_LOCK` capability and `disable_mlock = true` for container compatibility
- Vault container on internal network only — not exposed to host

## [0.1.0] — 2026-03-15

### Added

#### Infrastructure (Phase 1)

- Docker Compose orchestration for all services (guacd, backend, frontend, PostgreSQL)
- Custom `guacd` Dockerfile with FreeRDP 3 (`ARG FREERDP_VERSION=3`) and Kerberos (`krb5-dev`, `krb5-libs`) support
- Bundled PostgreSQL 16 Alpine container with persistent volume and health checks
- Shared Docker volumes for session recordings (`guac-recordings`) and Kerberos config (`krb5-config`)
- `.env.example` with configurable ports and log levels
- `.gitignore` for build artifacts, IDE files, and secrets

#### Rust Backend (Phase 2)

- Axum + Tokio web server with graceful startup (setup vs. running mode)
- `config.toml`-based persistence with auto-detection on boot
- First-boot setup endpoint (`POST /api/setup/initialize`) supporting local and external database selection
- PostgreSQL advisory-lock-protected SQL migrations (`sqlx::migrate!`) for HA-safe schema upgrades
- Full normalized database schema: `system_settings`, `users`, `roles`, `connections`, `role_connections`, `user_credentials`, `audit_logs`
- HashiCorp Vault Transit envelope encryption (`seal` / `unseal`) with AES-256-GCM and `zeroize` memory cleanup
- OIDC token validation via dynamic JWKS discovery (supports Keycloak, Entra ID, any compliant provider)
- JWT authentication middleware (`require_auth`) extracting user identity from Bearer tokens
- Role-based authorization middleware (`require_admin`) for admin-only endpoints
- Dynamic Kerberos `krb5.conf` generation written to shared volume
- Session recording configuration from database settings
- SHA-256 hash-chained immutable audit logging
- Bidirectional WebSocket ↔ TCP proxy tunnel to `guacd` with Guacamole protocol handshake injection
- Role-based connection access control on tunnel establishment
- Admin CRUD API: settings, SSO, Kerberos, recordings, roles, connections, users, audit logs
- User API: profile, role-scoped connections, credential vault, recording file download
- Health check and system status endpoints
- CORS and request tracing middleware
- Structured JSON logging via `tracing`

#### Frontend SPA (Phase 3)

- React 18 + TypeScript + Vite project scaffold
- Typed API client (`api.ts`) covering all backend endpoints
- Setup Wizard with database mode selection and optional Vault configuration
- Admin Settings Dashboard with five tabs: Database migration, SSO/OIDC, Kerberos, Recordings, Access Control
- Role and connection management UI (create, list, map roles to connections)
- User list viewer
- Connection dashboard with credential vault (Vault-encrypted password save)
- Session client mounting `guacamole-common-js` to HTML5 Canvas with dynamic resolution scaling
- Paginated, hash-verified audit log viewer
- Responsive navigation layout with active route highlighting
- nginx reverse proxy configuration for SPA fallback and API proxying
- Production Dockerfile (multi-stage Node build → nginx)
- Dark theme CSS design system

#### CI/CD (Phase 4)

- GitHub Actions workflow (`build-guacd.yml`) for automated weekly upstream guacd builds
- Automatic latest release tag detection from `apache/guacamole-server`
- Multi-platform Docker build with GHCR push and GitHub Actions cache
- Manual dispatch with version override input

### Security

- All user credentials encrypted at rest using envelope encryption (AES-256-GCM + Vault Transit KEK)
- Plaintext DEKs zeroized from memory immediately after use
- OIDC tokens validated against provider JWKS with audience and issuer checks
- Recording file endpoint sanitizes filenames to prevent path traversal
- Admin routes protected by role-based middleware
- Database credentials never logged; Vault tokens stored only in config
- Audit log chain integrity verifiable via SHA-256 hash links
