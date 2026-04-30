<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="frontend/public/logo-light.png">
    <img alt="Strata Client" src="frontend/public/logo-light.png" width="400">
  </picture>
</p>

<p align="center">
  <strong>A high-performance, modernized client and proxy architecture for <a href="https://guacamole.apache.org/">Apache Guacamole</a>.</strong><br>
  <sub>Rust backend · React SPA · Vault envelope encryption · OIDC SSO · FreeRDP 3 · Kerberos NLA · H.264 streaming</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.3.1-blue?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/rust-1.95-orange?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/react-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/typescript-6-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/postgresql-16-336791?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/vault-1.19-FFEC6E?style=flat-square&logo=vault&logoColor=black" alt="Vault">
  <img src="https://img.shields.io/badge/docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
</p>

<p align="center">
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/api-reference.md">API Reference</a> ·
  <a href="docs/deployment.md">Deployment</a> ·
  <a href="docs/security.md">Security</a>
</p>

---

# Strata Client

## ✨ Features

- **SSH terminal defaults that match rustguac (v1.3.1)** — `backend/src/tunnel.rs` `full_param_map()` now seeds `terminal-type=xterm-256color`, `color-scheme=gray-black`, `scrollback=1000`, `font-name=monospace`, `font-size=12`, `backspace=127`, `locale=en_US.UTF-8`, and `server-alive-interval=0` for every `protocol == "ssh"` connection where the admin has not explicitly overridden them. The first one is load-bearing — without it, guacd's bundled SSH terminal exports `TERM=linux` to the remote PTY, so `nano` and `less` cannot save/restore the alternate screen (the bug where closing `nano` left the file contents stuck on your terminal). Per-connection `extras` overrides via `is_allowed_guacd_param` still win — the defaults only fill in keys you haven't set.
- **Phantom-selection mouse hygiene (v1.3.1)** — `SessionManager.tsx` now wires a `releaseMouseButtons()` handler to `mouseleave` on the Guacamole canvas and `blur` on the window; if any mouse button is still held when the cursor leaves the display or the window loses focus, an explicit buttons-released `Guacamole.Mouse.State` is sent to guacd. Closes the long-running *"phantom text selection extends across the SSH terminal as I move my cursor toward the browser tab strip"* bug, which was caused by the matching `mouseup` landing outside the document (browser chrome, devtools, popped-out windows) and never reaching the page. The release is a no-op when no buttons are held.
- **Recording-playback URL builder fix (v1.3.1)** — `HistoricalPlayer.tsx` previously prepended `&seek=…` and `&speed=…` to a base URL that didn't yet contain a `?`, producing `…/stream&seek=3114&speed=2` and surfacing as a red *"Tunnel error"* badge the moment the operator clicked any seek (`30S`, `1M`, `3M`, `5M`) or speed (`2x`, `4x`, `8x`) button. Fixed by collecting params into a list and prepending `?` or `&` correctly before splitting for `tunnel.connect(tunnelQuery)`. The documented `GET /api/{user,admin}/recordings/:id/stream` query parameters were always correct on the backend; only the frontend was wrong.
- **Fuzz-tolerant guacd patch step (v1.3.1)** — `guacd/Dockerfile` now installs the GNU `patch` utility and falls back to `patch -p1 -F3 < "$p"` when `git apply` rejects a hunk, allowing up to three lines of contextual fuzz so harmless upstream whitespace drift no longer blocks image builds. The pinned upstream `apache/guacamole-server` commit (`2980cf0`) is unchanged, and the patch contents are unchanged. The stray `005-alt-screen-trace.patch` used during the v1.3.1 SSH terminal investigation has been removed (superseded by the SSH defaults above).
- **Web kiosk lifecycle correctness (v1.3.0)** — Closing a web-kiosk browser tab now actually tears down the kiosk. The `web` branch of `routes/tunnel.rs` captures an `Arc<WebRuntimeRegistry>` before the WebSocket upgrade and, once the proxy loop returns (success or error), calls `web_runtime.evict()` so refcount-zero `Drop` SIGKILLs the Chromium and Xvnc child processes via `kill_on_drop(true)`, releases the per-session X-display slot (`100..=199`) and CDP port (`9222..=9321`), and removes the per-session profile tempdir (which contained the NSS database). A matching `web.session.end` audit row is written with `reason: "tunnel_disconnect"` so the lifecycle is visible in the audit log. Reopening the same connection now reliably spawns a fresh kiosk instead of resurrecting a closed-tab handle.
- **Trusted CA bundles actually take effect (v1.3.0)** — Fixed the v1.2.0 regression where uploading and selecting a Trusted CA still produced `NET::ERR_CERT_AUTHORITY_INVALID` for sites signed by that CA. Chromium on Linux reads the trust store from `$HOME/.pki/nssdb`, **not** from `<--user-data-dir>/.pki/nssdb`. The kiosk spawner (`backend/src/services/web_runtime.rs`) now sets `HOME=<user_data_dir>` on the Chromium child process so NSS resolves to exactly the directory the backend just populated with `certutil -A -d sql:<dir> -n <label> -t "C,," -i <pem>`. No re-upload required.
- **Suppressed Chromium "unsupported flag" infobar (v1.3.0)** — The kiosk runs as root inside the backend container, so we have always had to pass `--no-sandbox`; Chromium painted a permanent ~28 px yellow bar reading *"You are using an unsupported command-line flag: --no-sandbox. Stability and security will suffer."* across the top of every kiosk tab. The argv builder in `web_session.rs::chromium_command_args` now adds `--test-type` whenever it adds `--no-sandbox`, suppressing that bar (and a handful of other end-user prompts that have no meaning inside a single-tab kiosk: default-browser, session-restore). `--test-type` does **not** disable the sandbox — rendering, network stack, mojo IPC, JIT, and origin isolation are unchanged. Two new unit tests lock in the pairing.
- **Protocol-aware Quick Share snippets (v1.3.0)** — Quick Share now picks the "copy to remote session" snippet by protocol. SSH / Telnet sessions default to `curl -fLOJ '<url>'` (fail-fast on HTTP errors, follow redirects, save to disk, honour the `Content-Disposition` filename); RDP / VNC / `web` kiosks keep the bare HTTPS URL for paste-into-browser flows. A new "Copy as" dropdown (rendered with the shared portal-based `Select` component to match the rest of the SPA) lets the operator override per-session: `URL`, `curl (Linux/macOS)`, `wget --content-disposition (Linux)`, or `Invoke-WebRequest -Uri … -OutFile … (Windows)` for OpenSSH-on-Windows targets. All variants single-quote the URL so exotic origin characters can't break the command; the PowerShell variant apostrophe-escapes the embedded filename.
- **Production resilience: nginx upstream resolver (v1.3.0)** — `frontend/common.fragment` now declares `resolver 127.0.0.11 valid=10s ipv6=off;` (Docker's embedded DNS) and uses `set $backend_upstream "backend:8080";` as the `proxy_pass` target, forcing per-request resolution. Previously, if the `backend` container was even briefly unreachable when nginx booted (the typical case during `docker compose up -d --build`), nginx would die with `[emerg] host not found in upstream "backend"` and stay dead. Now nginx stays up, returns `502 Bad Gateway` for the duration of any backend outage, and recovers automatically when the upstream comes back. Side-effect: the stuck "Locating authentication service…" Login spinner that this bug caused on prod is gone.
- **Production resilience: backend entrypoint SIGPIPE fix (v1.3.0)** — On hosts with non-trivial recording history, the backend was crash-looping with exit code 141 and zero log output. `backend/entrypoint.sh` reads the recordings-volume gid via `find "$RECORDINGS_DIR" -maxdepth 1 -type f -printf '%g\n' | head -n1` under script-wide `set -euo pipefail`; `head` closes stdin after the first line, `find` is killed with `SIGPIPE` (= 128 + 13 = 141), `pipefail` propagates the exit, `set -e` aborts the script, and the container dies before `gosu strata strata-backend` ever runs. Just that one pipeline is now wrapped with `set +o pipefail` / `set -o pipefail` so the harmless SIGPIPE no longer kills startup, while preserving strict-mode safety everywhere else in the entrypoint.

## ✨ Earlier features (v1.2.0 baseline)

- **Reusable Trusted CA bundles for Web Sessions (v1.2.0)** — A new admin surface (**Admin → Trusted CAs**) lets operators upload PEM bundles once with a friendly label; any `web` connection can then attach the bundle from a dropdown in the connection editor. At kiosk launch the backend writes the PEM into a per-session NSS database under `<user-data-dir>/.pki/nssdb` via `certutil` (from `libnss3-tools`, baked into the backend image), so Chromium trusts the supplied roots without ever resorting to `--ignore-certificate-errors`. PEMs are validated at upload time with `rustls-pemfile` + `x509-parser`; the parsed subject, expiry, and SHA-256 fingerprint are cached on the row so the admin list view never has to re-parse. CAs in active use cannot be deleted — the API returns a clear *"Cannot delete: this CA is still attached to N web connection(s)"* error rather than silently breaking a kiosk. Migration `059_trusted_ca_bundles.sql`; new endpoints `GET/POST /api/admin/trusted-cas`, `PUT/DELETE /api/admin/trusted-cas/{id}`, plus a slim read-only `GET /api/user/trusted-cas` for the connection-editor dropdown so users without **Manage System** can still pick from the curated list.
- **Tenant-aware date/time in checkout emails (v1.2.0)** — Approval / approved / rejected / self-approved emails now render expiry timestamps in the operator's configured display timezone, date format, and clock format (12 / 24 hour) instead of the previous hard-coded `YYYY-MM-DD HH:MM UTC`. The conversion uses `chrono-tz` against the IANA zone stored in `display_timezone`, with `display_date_format` (`YYYY-MM-DD`, `DD/MM/YYYY`, `MM/DD/YYYY`, `DD-MM-YYYY`) and `display_time_format` (`HH:mm`, `HH:mm:ss`, `hh:mm A`, `hh:mm:ss A`) controlling the surface format. The zone abbreviation (`%Z`) is appended so the recipient can disambiguate `BST` from `UTC`.
- **Correct target-account display in checkout emails (v1.2.0)** — The "Target account" line in checkout emails now prefers the admin-set `friendly_name` (matching what the user sees on the Credentials page when checking out), falling back to an RFC 4514-aware Common Name parser that correctly handles escaped commas (`\,`), escaped plus signs (`\+`), hex pairs (`\2C`), and the case-insensitive `cn=` attribute label. Previously the naive `dn.split(',').next()` parser displayed the user's full Distinguished Name on accounts whose CN contained an escaped comma, and ignored the friendly name entirely.
- **Inline logo on every transactional email (v1.2.0)** — The MJML templates already referenced `cid:strata-logo` in the banner image, but no inline part was being attached, so every recipient saw a broken-image icon. The dispatcher now attaches `templates/strata-logo.png` as a `multipart/related` inline part with content-id `strata-logo` at every real send site (initial dispatch and the retry worker), so the white wordmark renders on the accent banner across Outlook, Gmail, Apple Mail, Thunderbird, and K-9.
- **SMTP unauthenticated relay support (v1.2.0)** — Selecting **TLS = none** under **Admin → Notifications → SMTP** (typical for a port-25 internal relay) now hides the username and password fields entirely and clears any stored credentials on save. Trying to type credentials and then switching to plaintext relay can no longer leave stale Vault-encrypted values behind. A short helper sentence under the TLS dropdown documents the unauthenticated-mode contract so operators don't have to read the source.
- **Premium "LIVE" / "Rewind" buttons in the Sessions table (v1.2.0)** — The two NVR action buttons on the admin Sessions page have been reworked into an inverted, gradient-on-hover style with a dual-keyframe pulsing dot (1.1 s scaled core plus an expanding halo ring) so the *broadcast LIVE* affordance reads instantly even on a busy table. Honours `prefers-reduced-motion: reduce`.

## ✨ Features (1.0 baseline + earlier deltas)

- **Custom `guacd` daemon** — Apache Guacamole server compiled with FreeRDP 3 and Kerberos (GSSAPI) support
- **Rust proxy / API** — High-performance middle tier (Tokio + Axum) handling WebSocket tunnelling, OIDC auth, and dynamic configuration
- **Bundled HashiCorp Vault** — Auto-initialized, auto-unsealed Vault 1.19 container with Transit engine for envelope encryption — zero configuration required
- **Envelope encryption** — User credentials encrypted with AES-256-GCM; Data Encryption Keys wrapped via HashiCorp Vault Transit
- **OIDC / SSO** — Full OpenID Connect flow with dynamic JWKS validation (Keycloak, Entra ID, etc.)
- **Local authentication** — Built-in username/password auth for environments without an OIDC provider
- **Password policy** — Minimum 12-character password enforcement on creation and change, with dedicated password change and admin reset endpoints
- **Access + refresh tokens** — Short-lived 20-minute access tokens with 8-hour `HttpOnly` refresh cookies, proactive activity-based silent refresh, and a pre-expiry countdown warning toast — aligned with OWASP session timeout guidance
- **Per-user session tracking** — Active login sessions recorded in the database with JTI, IP, user agent, and expiry for audit visibility
- **Kerberos / NLA** — Dynamic `krb5.conf` generation pushed to the `guacd` container at runtime; multi-realm support with per-realm KDCs and lifetimes
- **Active Directory LDAP sync** — Automatic computer account import from AD via LDAP/LDAPS with scheduled background sync, soft-delete lifecycle, multiple search bases per source, filter presets, gMSA/MSA exclusion, and configurable connection defaults (RDP performance flags, session recording settings). Supports separate Search Base OUs for machine accounts and privileged user accounts, with an automatic fallback mechanism
- **AD auth methods** — Simple bind (DN + password) or Kerberos keytab (`kinit` + GSSAPI) per AD source; custom CA certificate upload for internal LDAPS
- **Connection parameter tooltips** — Hover tooltips on all connection settings sourced from the official [Apache Guacamole documentation](https://guacamole.apache.org/doc/gug/configuring-guacamole.html)
- **Granular RBAC** — Ten-permission role system: administer system (super-admin bypass), manage users, manage connections, audit system, view sessions, create users, create roles, create connections (includes folder management), create sharing profiles, and use Quick Share. All admin API endpoints enforce granular permission checks, so limited-privilege admin roles are restricted to only the endpoints their permissions allow. `can_manage_system` acts as a universal override for all other permissions; `can_use_quick_share` is a user-facing feature flag (not an administrative permission) so it is explicitly **excluded** from `has_any_admin_permission()` — granting a role only Quick Share does not unlock any admin UI
- **Credential profiles** — Saved per-user credential profiles with optional TTL expiry, profile selector on the Dashboard, and in-line renewal when credentials expire at connect time
- **Session recording** — Toggleable Guacamole-native session capture with configurable retention
- **Immutable audit log** — SHA-256 hash-chained, append-only audit trail
- **Tiled multi-session view** — Open multiple connections side-by-side in a responsive grid with per-tile focus control and keyboard broadcast
- **Live session NVR** — TiVo-style admin session observation with a 5-minute rewind buffer; jump into any active session and scrub backwards to see what a user did
- **Live session sharing** — Generate temporary share links (view or control mode) that let external users observe or control your active session in real time via the NVR broadcast channel — no separate RDP connection needed. Links auto-expire after 24 hours and can be revoked instantly
- **Admin tags** — System-wide tags created by administrators for organizational categorization of connections; visible (read-only) to all users on the Dashboard alongside personal tags
- **Recording disclaimer / Terms of Service** — Mandatory first-login acceptance modal covering session recording consent, acceptable use, and data protection under UK GDPR. Acceptance is timestamped in the database; declining logs the user out
- **Privileged Account Password Management** — Full checkout/rotation workflow for AD-managed service accounts. Configurable password generation policy (length, complexity), LDAP `unicodePwd` reset, Vault-sealed credential storage, and automatic zero-knowledge rotation on expiry. Supports **Separate Search Base OUs for user discovery**, allowing administrators to scope PM operations to specific account perimeters independently of machine discovery. Approval roles scope approvers to specific managed accounts via explicit account-to-role mappings. Users request time-limited checkouts with justification; approvers see only requests for accounts in their scope. Active checkouts expose the generated password via a reveal button; expired or checked-in checkouts trigger immediate password rotation. Voluntary early check-in allows users to release credentials before expiry. Self-approval optionally available per account mapping. Dedicated Approvals page with premium card layout showing requester avatar, account CN, duration, and justification. Admin Checkout Requests table shows decided-by with self-approval detection
- **Modern checkout-notification emails (v0.25.0)** — Polished, mobile-friendly MJML emails for the four key managed-account checkout events (pending approval, approved, rejected, self-approved audit notice). Multipart/related (HTML + plain-text + inline `cid:strata-logo`), with VML-based dark-mode hardening so Outlook desktop no longer overlays the white "haze" rectangle on dark themes. Admin-configurable SMTP relay (host/port/STARTTLS/implicit-TLS/plaintext), test-send button, and last-50 deliveries audit view under **Admin → Notifications**. SMTP password is **hard-required to live in Vault** — the `PUT /api/admin/notifications/smtp` endpoint refuses to save credentials when Vault is sealed or running in stub mode. A background retry worker re-attempts transient failures with exponential backoff (max 3 attempts) and abandons rows after that. Per-user `notifications_opt_out` flag suppresses all transactional messages with full audit visibility (`notifications.skipped_opt_out`); the self-approved audit notice intentionally bypasses opt-outs.
- **End-to-end H.264 GFX passthrough (v0.28.0)** — RDP H.264 frames now travel **FreeRDP 3 → guacd → WebSocket → browser's WebCodecs `VideoDecoder`** with no intermediate server-side decode/re-encode step. The legacy bitmap path (PNG/JPEG/WebP tile transcode) is bypassed entirely when the host has AVC444 enabled. On Windows targets configured for AVC444 + hardware encoding, expect roughly an order-of-magnitude bandwidth reduction over the bitmap path and meaningfully crisper text rendering during rapid window animations. Implemented via a byte-identical port of `sol1/rustguac`'s H.264 display-worker patch (`guacd/patches/004-h264-display-worker.patch`), a vendored `guacamole-common-js` 1.6.0 bundle that ships the `H264Decoder` and the `4.h264` opcode handler, and a backend RDP defaults block in `tunnel.rs` that seeds AVC444-compatible parameters. Ships with [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) — a read-first PowerShell helper that audits Windows host registry state, detects whether a hardware GPU is usable, prompts before applying changes, and prints the Event Viewer verification path (Event ID 162 / 170). Full operator runbook at [`docs/h264-passthrough.md`](docs/h264-passthrough.md).
- **Scriptable Command Palette (v0.31.0)** — The in-session Command Palette (default `Ctrl+K`) is now a fully extensible command surface. Type `:` to enter command mode and run one of six built-in commands — `:reload` (reconnect the active session and force an IDR keyframe), `:disconnect` (close the session and return to the dashboard), `:close` (friendlier alias for `:disconnect` — closes the current server page), `:fullscreen` (toggle browser fullscreen with Keyboard Lock), `:commands` (inline list of every command available to you), and `:explorer <arg>` (drives the Run dialog on the active session, so `:explorer cmd` opens a command prompt, `:explorer powershell` opens a PowerShell prompt, `:explorer \\server\share` opens a share, `:explorer notepad` launches Notepad). Each user can also define up to **50 personal `:command` mappings** from **Profile → Command Palette Mappings**, resolving to one of six typed actions: `open-connection`, `open-folder`, `open-tag`, `open-page` (server-side allow-list of `/dashboard | /profile | /credentials | /settings | /admin | /audit | /recordings`), `paste-text` (push free-form text up to 4096 chars onto the active session's remote clipboard + fire a Ctrl+V keystroke), and `open-path` (drive the Windows Run dialog: Win+R → paste path → Enter, opening UNC shares, local folders, or `shell:` URIs in Explorer on the remote target — e.g. `:comp1` → `\\computer456\share`). Triggers are validated server-side against `^[a-z0-9_-]{1,32}$`, must not collide with the six built-in names, and must be unique per user. Ghost-text autocomplete (Tab or Right Arrow to accept) suggests the longest unambiguous extension across the merged built-in + user-mapping list. Invalid slugs render a red border, `role="alert"` reason line, and `aria-invalid` for screen readers — Enter is a hard no-op when the slug doesn't resolve. Every successful command writes one `command.executed` row to the existing append-only, SHA-256-chain-hashed `audit_logs` table via a fire-and-forget `POST /api/user/command-audit` (the handler hard-codes `action_type` server-side so a malicious client cannot poison the audit-event taxonomy; `paste-text`, `open-path`, and `:explorer` audit details deliberately log only `{ text_length }` / `{ path_length }` / `{ arg_length }`, never the literal payload). Mappings live in the existing `user_preferences` JSONB blob from v0.30.1 — **no new database migrations.**
- **Configurable Command Palette binding (v0.30.1)** — Each user can rebind the in-session Command Palette shortcut from a brand-new Profile page (click the avatar in the sidebar). The recorder accepts any Ctrl/Alt/Shift/Meta combination plus a printable or named key. Stored server-side in a new `user_preferences` table (JSONB blob keyed by `user_id`, `GET`/`PUT /api/user/preferences`) so the binding follows you across browsers and devices. `Ctrl` matches both `event.ctrlKey` and `event.metaKey`, so the same stored value works on Windows/Linux and macOS without per-OS configuration. Both keystroke traps (capture-phase in `SessionClient.tsx` and pop-out in `usePopOut.ts`) read the binding through a `useRef` so the listener never has to be rebound mid-session. Defaults preserved: until a user saves something, no preferences row exists and the experience is byte-identical to v0.30.0.
- **Web Browser Sessions and VDI Desktop Containers (v0.30.0)** — Two new `connections.protocol` values are fully wired end-to-end: `web` (kiosk Chromium inside `Xvnc`, tunnelled as VNC) and `vdi` (Strata-managed Docker container running `xrdp`, tunnelled as RDP). The unified backend image (Debian trixie-slim) ships `Xvnc` and `chromium` baked in, so **web sessions work out of the box** with `docker compose up -d`. **VDI** is opted into by adding the `docker-compose.vdi.yml` overlay, which mounts `/var/run/docker.sock` (= host root — read the warning at the top of that file) and switches `STRATA_VDI_ENABLED=true`. Includes the typed `connections.extra` schemas, X-display allocator (`:100..:199`, 100-session cap), CIDR egress allow-list with DNS-rebinding defence, operator-managed VDI image whitelist (strict-equality matching, no glob/digest substitution), deterministic per-(connection, user) container naming for persistent-home reuse, xrdp disconnect-reason classifier, idle reaper, the admin form sections, and the `GET /api/admin/vdi/images` endpoint. See [`docs/web-sessions.md`](docs/web-sessions.md) and [`docs/vdi.md`](docs/vdi.md).
- **In-session H.264 ghost recovery (v0.27.0, superseded by v0.28.0)** — A forked-guacd patch (`004-refresh-on-noop-size.patch`) intercepted a no-op Guacamole `size` instruction and sent an RDP **Refresh Rect** PDU to the server, expected to trigger an IDR keyframe and reset the H.264 reference chain. With the v0.28.0 passthrough decoder, the underlying ghost class cannot occur, so this patch is **superseded** by `004-h264-display-worker.patch` and the Refresh Display button has been retired from the Session Bar.
- **Tunnel input-latency isolation (v0.26.0)** — The WebSocket tunnel's proxy loop no longer calls `ws.send().await` inline inside the guacd→browser select arm. Output now goes through a bounded mpsc channel owned by a dedicated writer task, so bitmap-flood bursts (e.g. Win+Arrow window-snap) can no longer starve the input path. Eliminates the "mouse feels like it has acceleration", keyboard-lag, and rendering-freeze symptom cluster reported against v0.25.x. Paired with a frontend `display.onresize` coalescer that collapses FreeRDP's multi-event resize storms into a single `handleResize` per animation frame.
- **Security & audit hardening (v0.26.0)** — Share-link requests now audit both rate-limit trips (`connection.share_rate_limited`) and invalid-token lookups (`connection.share_invalid_token`) using an 8-char SHA-256 prefix of the token so brute-forcing is visible without persisting the raw secret. `resolve_share_token()` now filters out soft-deleted connections. Backend error responses routed to the UI go through a sanitizer that strips filesystem paths, Vault key names and internal hostnames. The notifications `StubTransport` is gated behind `#[cfg(test)]` so release builds cannot silently drop emails. Admin **Notifications → Send test email** now accepts an optional `template_key` for end-to-end template previews against live SMTP. New audit events: `user.terms_accepted`, `user.credential_mapping_set`, `user.credential_mapping_removed`, `checkout.retry_activation`, `checkout.checkin`.
- **DNS Configuration (Network Tab)** — Admin-configurable DNS servers and search domains for guacd containers via a dedicated Network tab in Admin Settings. Custom DNS entries and search domains are written to a shared Docker volume and applied on guacd startup, enabling resolution of internal hostnames (e.g. `.local` domains) without hardcoding DNS in `docker-compose.yml`. Docker's embedded DNS is preserved as a fallback so existing connections continue working. Requires a `docker compose restart guacd` after changes
- **Connection Health Checks** — Background TCP probing of every connection's hostname:port every 2 minutes with 5-second timeout. Dashboard displays green/red/gray status dots (online/offline/unknown) next to each connection for at-a-glance operational visibility without requiring agents on target machines
- **Dynamic Browser Tab Title** — The browser tab title updates to show the active session's server name (e.g. "SERVER01 — Strata") while connected, making it easy to identify which server you're on when the sidebar is collapsed or when switching between browser tabs
- **Quick Share (Temporary File CDN)** — Upload files from the Session Bar and get a random download URL to paste into the remote session's browser. Files are session-scoped and automatically deleted on disconnect. Supports drag-and-drop, up to 20 files per session (500 MB each), and one-click copy-to-clipboard URLs
- **Browser-based multi-monitor** — Span an RDP session across multiple physical monitors using the Window Management API (Chromium 100+). Secondary screens each get their own browser window showing a slice of the aggregate remote resolution with offset-translated mouse/keyboard input and ~30 fps `setInterval` canvas blitting. **Best supported: all landscape monitors in a left-to-right horizontal row.** All monitors are arranged into a flat horizontal row regardless of physical vertical position — monitors above or below the primary appear as slices to the right (scroll/move the mouse rightward to reach them). Aggregate height is capped to the primary monitor's height so the remote taskbar stays visible on landscape screens. Portrait monitors work but show the primary-height region with black fill below. Cursor is synced to all secondary windows via a `MutationObserver`. Secondary popups auto-maximize via `moveTo`/`resizeTo`/`requestFullscreen`. Compatible with Brave and other privacy-focused browsers via automatic dimension fallback. Pop-out windows detect screen changes and re-scale automatically. Supports any number of monitors with live screen count detection in the toolbar tooltip. Chrome users must allow popups for the site (one-time prompt) when using 3+ screens
- **Unified Sessions Page** — Role-based sessions view combining live session monitoring and recording history; users see their own sessions, admins see all with kill/observe/rewind controls
- **Unified Session Bar** — Consolidated session controls (Sharing, File Browser, Fullscreen, Pop-out, OSK) into a single, sleek, zero-footprint collapsible right-side dock
- **Integrated OSK** — Touch toolbar and on-screen keyboard shortcuts integrated directly into the Session Bar dock; no more floating buttons obscuring the remote screen
- **Smooth Session Resizing** — `ResizeObserver`-driven scaling handles sidebar and dock transitions smoothly without layout artifacts or resolution flashes
- **Large Clipboard Support** — Protocol-level text chunking supports transferring tens of thousands of lines (64MB+ buffer) between local and remote sessions
- **Windows Key Proxy (Right Ctrl)** — Right Ctrl acts as a Windows key proxy for RDP and VNC sessions, following the VMware / VirtualBox "host key" convention. Hold Right Ctrl + key to send Win+key combos (e.g., Win+E, Win+R), or tap Right Ctrl alone to open the Start menu. Works across single sessions, tiled multi-session, pop-out windows, and shared viewer
- **Sidecar guacd scaling** — Round-robin connection pool across multiple guacd instances for horizontal scaling
- **H.264 GFX passthrough** — FreeRDP 3 GFX pipeline with end-to-end H.264 NAL-unit passthrough to the browser's WebCodecs decoder (v0.28.0+); no server-side transcode, dramatically reducing bandwidth and CPU on the proxy
- **Modern SPA** — React + TypeScript + Vite frontend with Tailwind CSS v4, setup wizard, admin dashboard, credential vault, and HTML5 Canvas session client
- **Azure Blob Storage sync** — Automatically sync completed session recordings to Azure Blob Storage for durable, external persistence and memory-efficient streaming playback
- **Zero-config first boot** — Bundled PostgreSQL and Vault containers; upgrade to external services at any time through the UI
- **CI/CD** — GitHub Actions workflow for automated weekly upstream `guacd` rebuilds
- **In-app documentation** — Built-in `/docs` page with Architecture, Security, and API Reference rendered inline, plus a full release history carousel

## 🏗️ Architecture

```
                          ┌──────────┐
               :80/:443   │  Nginx   │
          ◄──────────────►│ Gateway  │
               HTTP(S)    └────┬─────┘
                               │
                  ┌────────────┴────────────┐
                  │ /api/*          /* (SPA) │
           ┌──────▼──────────┐   ┌──────────▼───┐
           │  Rust Backend   │   │   Frontend   │
           │  (Axum + Tokio) │   │   (nginx)    │
           └────────┬────────┘   └──────────────┘
                    │
         TCP 4822   │               ┌────────────┐
                    ├──────────────►│   guacd     │
                    │               │ (FreeRDP3   │
                    │               │  + H.264)   │
                    │               ├─────────────┤
                    │               │  guacd-2…   │
                    │               │  (scale)    │
                    │               └─────────────┘
                    │
       ┌────────────┴────────────┐
       │                         │
 ┌─────▼─────┐           ┌──────▼────────┐
 │ PostgreSQL│           │  Vault 1.19   │
 │ (local or │           │  Transit      │
 │  external)│           │  (bundled or  │
 └───────────┘           │   external)   │
                         └───────────────┘
```

See [docs/architecture.md](docs/architecture.md) for a detailed breakdown.

## 🚀 Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) ≥ 24.0
- [Docker Compose](https://docs.docker.com/compose/) ≥ 2.20

### 1. Clone & configure

```bash
git clone https://github.com/your-org/strata-client.git
cd strata-client
cp .env.example .env        # review and edit as needed
```

### 2. Build & run

```bash
docker compose up -d --build
```

### ⌨️ Windows Key Proxy

Browsers cannot capture the physical Windows key — the OS intercepts it before it reaches the page. Strata remaps **Right Ctrl** as a Windows key proxy (the same convention used by VMware Workstation and VirtualBox):

| Action                          | What the remote session receives |
| ------------------------------- | -------------------------------- |
| **Hold Right Ctrl + E**         | Win+E (open Explorer)            |
| **Hold Right Ctrl + R**         | Win+R (Run dialog)               |
| **Hold Right Ctrl + Shift + S** | Win+Shift+S (screenshot)         |
| **Tap Right Ctrl alone**        | Win tap (Start menu)             |

This works in all session modes — single session, tiled view, pop-out windows, and shared viewer (control mode). The proxy is active for **RDP and VNC** connections; SSH sessions are unaffected.

> [!NOTE]
> If you are using an **external database**, ensure `DATABASE_URL` is set in your `.env` file first. If you want to use the **bundled local database**, use the `local-db` profile:
>
> ```bash
> docker compose --profile local-db up -d
> ```

This starts all services with Nginx as the main gateway:

| Service          | Port         | Purpose                                       |
| ---------------- | ------------ | --------------------------------------------- |
| `frontend`       | `80`, `443`  | React SPA + SSL Gateway + API Proxy           |
| `backend`        | — (internal) | Rust API / WebSocket proxy                    |
| `guacd`          | — (internal) | Guacamole protocol daemon (FreeRDP 3 + H.264) |
| `postgres-local` | — (internal) | Bundled PostgreSQL 16                         |
| `vault`          | — (internal) | Bundled HashiCorp Vault 1.19                  |

### 2.1 SSL / HTTPS Setup

Strata Client uses Nginx to handle HTTPS. To use your own certificates:

1. Create a `certs/` directory in the project root.
2. Place your certificates inside as `cert.pem` and `key.pem`.
3. Restart the stack: `docker compose up -d`.

Nginx is configured to automatically redirect all port 80 (HTTP) traffic to port 443 (HTTPS) once enabled.

For additional guacd instances:

```bash
GUACD_INSTANCES=guacd-2:4822 docker compose --profile scale up -d
```

For a detailed production-ready setup on an Ubuntu server, follow the [Ubuntu VM Deployment Guide](docs/ubuntu-vm-deployment.md).

### 3. First-boot setup

Open `http://127.0.0.1` (or `https://your-domain` if STRATA_DOMAIN is set). On first launch you will be prompted to configure:

1. **Database** — provide an external PostgreSQL connection string in your `.env` (recommended for production) or use the bundled local DB by starting the stack with the `local-db` profile.
2. **Vault** — select a vault mode:
   - **Bundled (recommended)** — auto-initializes, unseals, and configures Transit encryption with zero setup
   - **External** — connect to your own Vault instance with address, token, and transit key
   - **Skip** — use local encryption only, configure Vault later via Admin Settings

### 4. Configure SSO & connections

After setup, log in and navigate to **Admin → SSO / OIDC** to configure your identity provider, then add remote desktop connections under **Admin → Access**.

## 🛠️ Development

### Backend (Rust)

```bash
cd backend
# Requires Rust 1.95
cargo run
```

Environment variables: `DATABASE_URL`, `GUACD_HOST`, `GUACD_PORT`, `RUST_LOG`, `CONFIG_PATH`.

### Frontend (React / TypeScript)

```bash
cd frontend
npm install
npm run dev          # Vite dev server on :5173, proxies /api → :8080
```

### Custom guacd

The `guacd/Dockerfile` builds the Apache Guacamole server with FreeRDP 3 and Kerberos support. To rebuild manually:

```bash
docker build -t custom-guacd:latest ./guacd
```

See [docs/deployment.md](docs/deployment.md) for production deployment and upgrade procedures.

## 📚 Documentation

| Document                                       | Description                                |
| ---------------------------------------------- | ------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)   | System design, container layout, data flow |
| [docs/api-reference.md](docs/api-reference.md) | REST & WebSocket API endpoints             |
| [docs/deployment.md](docs/deployment.md)       | Production deployment, upgrades, HA        |
| [docs/security.md](docs/security.md)           | Threat model, encryption, auth details     |
| [CHANGELOG.md](CHANGELOG.md)                   | Version history                            |
| [CONTRIBUTING.md](CONTRIBUTING.md)             | Contribution guidelines                    |
| [NOTICE](NOTICE)                               | Third-party software notices               |

## 📄 License

This project is licensed under the [Apache License 2.0](LICENSE).

This project incorporates or depends on software from the Apache Guacamole project and other open-source libraries. See the [NOTICE](NOTICE) file for details.
