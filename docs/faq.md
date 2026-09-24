# Frequently Asked Questions

For deeper coverage see [docs/architecture.md](architecture.md),
[docs/security.md](security.md), [docs/deployment.md](deployment.md), and
[docs/api-reference.md](api-reference.md).

---

## Project & positioning

### How is Strata Client different from the Apache Guacamole reference web app?

The reference webapp is a Tomcat-hosted JDBC-or-LDAP authentication shell over `guacd`. Strata replaces **both** — the shell, with a Rust backend, a React 19 SPA and a Docker-native deployment; and, since v2.0.0, the proxy daemon itself with an in-process Rust session engine. On top of that it adds the operations surface a Guacamole deployment usually has to bolt on:

- OIDC SSO with dynamic JWKS validation and proactive refresh-token rotation
- 10-permission RBAC enforced at every admin endpoint
- HashiCorp Vault Transit envelope encryption (bundled and auto-unsealed by default)
- Append-only, SHA-256 hash-chained audit log
- NVR-style live session observation with a 5-minute rewind buffer
- Privileged-account checkout / approval / rotation workflow with LDAP `unicodePwd` reset
- First-class Web kiosk, VDI desktop container, and Kubernetes pod-console connection types
- End-to-end H.264 GFX passthrough to the browser's WebCodecs decoder (no proxy-side transcode)

As of v2.0.0, **nothing** is carried over. `guacd` was the last shared component and it has been replaced by a session engine written in Rust and compiled into the backend. The browser-facing wire protocol is still Guacamole-style instructions — that part was worth keeping, and it means existing client code is unaffected — but there is no C daemon, no vendored patch set, and no weekly image rebuild. See [the comparison table in the README](../README.md#vs-vanilla-apache-guacamole) for a side-by-side.

### What licence is this released under?

[Apache 2.0](../LICENSE). Third-party software notices are in [NOTICE](../NOTICE).

### Is there commercial support?

Not from the maintainers. The project is community-supported on GitHub Discussions and Issues. If that changes, [SUPPORT.md](../SUPPORT.md) will be updated.

### Why Rust + React instead of [other stack]?

The previous Java/Tomcat + AngularJS stack is a maintenance burden and the SPA has been EoL for years. Rust gives us a single statically-linked backend image with predictable memory + CPU under load (the WebSocket tunnel is the hot path); Axum + Tokio match the workload shape; sqlx gives us compile-time-checked SQL. React 19 + TypeScript 6 + Vite is the most boring, productive frontend stack in 2026.

---

## Deployment

### What's the fastest way to get this running?

```bash
git clone https://github.com/Bails309/strata-client.git
cd strata-client
cp .env.example .env
docker compose up -d --build
```

That builds the `backend` and `frontend` images locally and starts the full stack with bundled PostgreSQL and Vault. Open `http://127.0.0.1` and the setup wizard takes you the rest of the way. Strata publishes no pre-built images; for multi-host deployments, push the images you build to your own private registry (see the [README Quick Start](../README.md#2-run)).

### Should I use the bundled PostgreSQL or an external one?

For evaluation: bundled is fine. For production: external. The bundled Postgres exists so the project has a true zero-config first-boot experience; it's a single-node container with no managed backups, no read replicas, no PITR. Once you've decided to keep Strata, point `DATABASE_URL` at a managed Postgres and drop the `local-db` profile.

### Should I use bundled Vault or an external one?

The bundled Vault is auto-initialised, auto-unsealed, and runs the Transit engine in a single container — fine for evaluation and for small single-tenant deployments. For production with multi-tenancy, an HA cluster, or compliance requirements, run an external Vault and re-point Strata at it through the admin UI. **The KEKs themselves never leave Vault** in either mode, so the security posture is the same.

### How do I scale the session engine?

You scale the **backend**, because as of v2.0.0 the engine is part of it. The `scale` compose profile, the `guacd-2` sidecar and `GUACD_INSTANCES` no longer exist.

Sessions are memory-cheap and CPU-hungry, which is the opposite of the shape people usually assume. Measured at roughly **24 MB of RSS per active session**, so RAM is rarely the limit; frame encoding is, and that is CPU-bound. Size on cores, not gigabytes, and see [deployment.md § High Availability](deployment.md#high-availability) for the host table.

One consequence worth planning for: the engine is stateful in the same way `guacd` was, so **restarting the backend drops active sessions**. Previously you could restart the backend without touching sessions because they lived in a separate container. That is no longer true — schedule backend upgrades in a maintenance window.

### Can I run Strata behind an existing reverse proxy?

Yes. Strata's own `frontend` container is just nginx; if you already have one, you can either:

- Remove the `frontend` service and proxy `/api/*` and `/*` directly at the backend + a static asset server, or
- Keep the `frontend` container and proxy your edge to it on port 80/443.

The WebSocket upgrade path (`/api/tunnel/...`) must be passed through cleanly. Sticky sessions are not required.

### How do I configure HTTPS?

Drop a `cert.pem` and `key.pem` into the `certs/` directory at the repo root and restart. The bundled nginx config redirects port 80 → 443 once certs are present. For Let's Encrypt + auto-renewal use a sidecar like `certbot` or terminate TLS at your edge proxy.

### What's the upgrade path?

Per-version upgrade notes live in [docs/deployment.md § Version-specific upgrade notes](deployment.md#version-specific-upgrade-notes). The headline rule since v2.0.0 is simpler than it used to be: **rebuild backend + frontend on every release.** There is no longer a third image whose rebuild is conditional on an upgrade note, which was a recurring source of half-upgraded deployments.

---

## Authentication & RBAC

### Which OIDC providers work?

Anything that publishes a JWKS endpoint and supports the Authorization Code + PKCE flow. Confirmed working: Keycloak, Microsoft Entra ID, Okta. Configure under **Admin → SSO / OIDC**; the JWKS is fetched and cached at runtime, so rotating signing keys at the IdP doesn't require a Strata restart.

### Can I use local users instead of OIDC?

Yes. Local username/password is built in for environments without an OIDC provider. The 12-character minimum password policy is enforced on creation and change; admin password reset is a dedicated endpoint.

### How does RBAC work?

Strata has a 10-permission role model (`can_manage_system`, `can_manage_users`, `can_manage_connections`, `can_audit_system`, `can_view_sessions`, `can_create_users`, `can_create_roles`, `can_create_connections`, `can_create_sharing_profiles`, `can_use_quick_share`). Every admin API endpoint is gated by the appropriate `check_*_permission` helper. `can_manage_system` is a universal override; `can_use_quick_share` is a feature flag, not an admin permission, so granting only that does not unlock any admin UI.

### How long do sessions last?

Access tokens are 20 minutes. Refresh cookies are 8 hours, `HttpOnly`, `Secure`, `SameSite=Lax`. The SPA proactively rotates the access token after ~10 minutes of UI activity. The WebSocket-tunnel auth watchdog (v1.4.1) is independent of access-token TTL: a tunnel stays open until you log out, until your token is revoked, or until the 8-hour `MAX_TUNNEL_DURATION` hard cap. See [docs/security.md § WebSocket-tunnel auth watchdog](security.md#websocket-tunnel-auth-watchdog-v132-revised-v141).

---

## Connections & protocols

### Which protocols are supported?

RDP, VNC, SSH, Telnet, Kubernetes pod console, Web (kiosk Chromium-in-Xvnc), VDI (Strata-managed Docker container running `xrdp`). Every protocol uses the same WebSocket tunnel, recording, and audit pipeline — there is no per-protocol bypass.

### What's the difference between a Web Session and a VDI Session?

- **Web** spawns a single-tab Chromium kiosk inside `Xvnc` _inside the backend container_ and tunnels it as VNC. It's a constrained browser pointed at one URL with optional Playwright/Puppeteer login automation, suitable for SaaS apps that don't have native SSO or need IP-pinning. Works out of the box with `docker compose up -d`.
- **VDI** spawns a Strata-managed Docker container running `xrdp` and tunnels it as RDP — a real Linux desktop in a sandbox. **Disabled by default** because it requires mounting `/var/run/docker.sock` (= host root); opt in via the `docker-compose.vdi.yml` overlay. Read the warning at the top of that file.

See [docs/web-sessions.md](web-sessions.md) and [docs/vdi.md](vdi.md).

### Does Kerberos / NLA actually work?

Yes. The engine generates Kerberos configuration in-process at connect time, with multi-realm support and per-realm KDCs and lifetimes — before v2.0.0 this was a `krb5.conf` pushed into the `guacd` container at runtime. AD source can authenticate via simple bind (DN + password) or Kerberos keytab (`kinit` + GSSAPI); custom CA cert upload is supported for internal LDAPS.

> Note that the SPN is built from the connection's **hostname**, not from the address the engine dials. That distinction matters now that target hostnames are resolved against your configured nameservers rather than the container's resolver — Kerberos keeps working across that change precisely because the hostname is preserved.

### Can users span an RDP session across multiple monitors?

Yes — via the Window Management API (Chromium 100+). Best supported with all-landscape-monitors-in-a-left-to-right-row; portrait works but with letterboxing. See [the README features list](../README.md#protocols--display) for the full caveats.

### Why is RDP H.264 important?

On Windows hosts with AVC444 and hardware encoding enabled, RDP H.264 costs far less bandwidth than the bitmap path during motion — video, scrolling, dragging windows. Since v2.1.0 the native engine forwards the host's MS-RDPEGFX H.264 frames straight to the browser's WebCodecs `VideoDecoder`, with no decode or re-encode on the server. It is **off by default** and enabled per connection with **Enable graphics pipeline (GFX)**, because it is a genuine trade: enabling it stops the host sending lossless bitmap updates, and H.264 is lossy, so the bitmap path is still the better choice for reading text. (Up to v1.14.6 the same passthrough ran through FreeRDP and `guacd`; v2.0.0 shipped without it.) See [docs/h264-passthrough.md](h264-passthrough.md) and the [`docs/Configure-RdpAvc444.ps1`](Configure-RdpAvc444.ps1) host-preparation script.

### What do the messages mean when a session ends?

Since v2.1.1 the heading tells you what kind of end it was, and the sentence underneath says what happened:

| Heading | What it means | What to do |
| ------- | ------------- | ---------- |
| **Session Ended** | You signed out, disconnected from the Start menu, the remote program exited, or a time limit was reached. | **Reconnect** starts a new session. After a Start-menu *Disconnect* the Windows session is still running, so reconnecting resumes it. |
| **Session Timed Out** | The remote computer's idle-session limit disconnected you. | Reconnect. The limit is set on the remote computer, not in Strata. |
| **Session Disconnected** | Someone else ended it: the same Windows session was opened from another window or device, or an administrator on the remote computer disconnected or signed it out. | Check you do not have the session open elsewhere before reconnecting, or the two will keep taking it from each other. |
| **Session Terminated** | A Strata administrator ended the session. | Reconnect is not offered. Contact your administrator. |
| **Connection Lost** | The network path between Strata and the remote computer failed, or the remote computer closed the connection without saying why (typically a restart). | Reconnect once the remote computer is reachable. |
| **Connection Refused** | The remote computer refused the session — including Remote Desktop licensing and connection-broker problems. | Usually needs the remote computer's administrator. |
| **Access Denied** | The remote computer does not let this account in over Remote Desktop, or rejected the credentials. | Check the account's Remote Desktop rights and the credential profile. |
| **Connection Error** | Something failed unexpectedly. | Reconnect; if it recurs, report it with the time and connection name. |

A separate **Reconnecting…** overlay means the connection between *your browser* and Strata dropped; that one retries automatically. Operators can trace any of these to a log line with the [session-disconnects runbook](runbooks/session-disconnects.md).

### There is no sound in my RDP session.

RDP audio works from v2.1.1. Before that, every session told Windows not to send audio, and Windows additionally sends none unless a device-redirection channel is offered beside the audio one. If audio is still silent:

1. **Click or press a key inside the session.** Browsers keep web audio paused until the page has had a user gesture.
2. Check the connection does not have `disable-audio` set.
3. Check the remote computer has audio redirection allowed (Group Policy *Allow audio and video playback redirection*).
4. Look for `opening audio stream` in the backend log. If it is present, the remote computer is sending audio and the problem is in the browser; if it is absent, the remote computer never sent any.

### The wrong characters appear when I type in an RDP session on a non-US keyboard.

Fixed in v2.1.1. Your browser applies your local keyboard layout, and the engine used to send the result as a US key position that Windows then re-interpreted through *its* layout — so on a UK keyboard `\` arrived as `#` and `@` and `"` were swapped. Typed characters are now sent as characters, which works for every layout. Shortcuts (anything held with Ctrl, Alt or the Windows key) are still sent as key positions so they keep working; AltGr is treated as a character key, not a shortcut. The **Failsafe (Unicode events)** keyboard-layout option no longer changes anything, because every layout now behaves that way.

### My RDP session looks zoomed in, or everything looks smaller than it used to.

Both are about Windows display scaling. Before v2.1.1, a monitor scaled to 125% asked for a desktop 20% too small **and** told Windows to draw everything 25% larger, so sessions looked zoomed in and slightly soft. The desktop now matches your monitor's real pixels and the remote screen is drawn at 100%, so it looks the same on every computer. If you preferred remote text at your local size, open **Display Settings** in the session bar and tick **Match my display scale** — it applies immediately, is remembered per browser, and needs no reconnect.

### Copy/paste has stopped working in an RDP session. What now?

First establish which of the two failure modes you have, because the recovery differs:

- **Only copying _from_ the remote is broken, and reconnecting fixes it.** This is a stalled clipboard transfer — RDP's CLIPRDR channel opened a transfer and never closed it, usually because the copying application renders its clipboard data lazily (Chrome, Edge, VS Code, terminals) and a second copy interrupted the first. Since v1.14.1 Strata flushes whatever arrived rather than silently leaving stale text on your clipboard, so this should now degrade to a partial copy rather than a dead one.
- **A large copy produces _nothing at all_ — a long script or PEM bundle simply never reaches the local clipboard, while short snippets work.** **Fixed in v2.0.0, and it should not recur.** This was the `clipboard-buffer-size` ceiling: `guacd` converted the incoming clipboard into a fixed-size buffer and, when it overran, **discarded the copy outright** rather than truncating — no error, no partial text, nothing. Worse, the 8 MiB Strata requested was silently ignored on RDP for several releases, leaving it at `guacd`'s 256 KiB default. The engine now applies a flat 8 MiB per direction, **truncates rather than discards**, and logs when it does. If you see this on v2.0.0 or later, it is a bug — please report it with a `strataClipboard.print()` dump.
- **Large copies arrive truncated — a long script pastes back as its first few hundred lines.** Different failure from the one above: here the text _does_ arrive, just incomplete. Look for `stream-paused` followed by `stream-stalled` in the receive trace. Builds before the asymmetric-watchdog fix abandoned the stream at the first 2-second gap, and because the odds of hitting one gap grow with payload size, only large copies were affected.
- **Both copy _and_ paste are broken, and reconnecting does _not_ fix it.** The Windows-side clipboard service (`rdpclip.exe`) is wedged. Because reconnecting reattaches to the same still-logged-on Windows session, the tunnel is not what needs resetting — **log off the Windows session** (not just disconnect) and log back in. Prior to v1.14.4, overlapping clipboard transfers from a single click could cause this; v1.14.4 serialises clipboard pushes so it should no longer occur, but a session already stuck before the upgrade still needs the one-time log off.

To capture evidence for a bug report, run `strataClipboard.print()` in the session tab's devtools console — a 500-entry diagnostic buffer is always recording, so you do not need to reproduce the fault with logging switched on. Operators can additionally set `STRATA_CLIPBOARD_TRACE=1` on the backend. Neither records clipboard **contents**, only opcodes, sizes and timings, so the output is safe to attach to a ticket. See [docs/deployment.md](deployment.md#diagnosing-clipboard-problems-v1144).

If clipboard access is denied outright (nothing transfers in either direction), check that Strata is served over **HTTPS** — browsers refuse Clipboard API reads on insecure origins — and that the connection does not have `disable-copy` / `disable-paste` set in its guacd parameters.

---

## Recording & audit

### Where are recordings stored?

By default in the `guac-recordings` Docker volume on the host. Optionally synced to Azure Blob Storage on session end for durable, memory-efficient streaming playback (configure under **Admin → Storage**).

### Can I delete a recording to comply with a data-subject request?

Yes — Admin → Recordings supports per-recording delete. The deletion itself writes one `recording.deleted` audit row; the recording bytes are removed from disk + Blob; the underlying audit row chain remains intact (the recording metadata row is soft-deleted, not chain-mutated, so the SHA-256 hash chain is preserved).

### What does "hash-chained audit log" actually mean?

Every row in the `audit_logs` table includes a `hash` column. Each row's hash is computed over `(prev_hash, action_type, user_id, timestamp, details_json)`. Tampering with any historical row changes its hash and breaks the chain at that point — easily detected by a verifier reading the table top-to-bottom. The chain root is published in the admin UI for periodic external attestation.

### Can users observe each other's sessions?

Only with the `can_view_sessions` permission. The Live Session NVR shows admin-side observers a 5-minute rewind buffer plus the live broadcast channel; share links (24-hour expiry, instant revoke, view or control mode) let session owners hand limited access to specific external collaborators. Both paths are audit-logged.

### Can multiple people drive the same share at once? (v1.9.6+)

Yes — that's the new **co-pilot mode**. When the owner creates a control share with **Multiplayer** enabled (1.9.6+, max 6 participants), every joiner gets a coloured cursor, an optional chat panel, and shares one input token. Only the participant holding the token can type or click; the owner can force-grant or revoke at any time, and the token auto-transfers after two seconds of input idle. Join / leave events are written to the `share_participant_audit` table and the global audit log. The whole feature can be disabled cluster-wide by flipping the `multiplayer_share_enabled` system setting to `"false"`. See [`docs/architecture.md`](architecture.md#multiplayer--co-pilot-mode-v196) for the design.

---

## Security

### How do I report a vulnerability?

Use [GitHub's Private Vulnerability Reporting](https://github.com/Bails309/strata-client/security/advisories/new). See [SECURITY.md](../SECURITY.md) for the full policy, supported-versions matrix, and 90-day disclosure timeline.

### Are container images signed?

Strata no longer publishes images at all. Up to v2.1.0, every tagged release pushed Cosign-signed images with CycloneDX SBOMs and SLSA Level-3 provenance to GitHub Container Registry; since v2.1.1 you build the images from this repository and keep them in your own private registry. Signing is then a control of that registry — see [deployment.md § Image provenance](deployment.md#image-provenance-private-registry).

### Is the bundled Vault really safe to use?

The bundled Vault auto-initialises and auto-unseals using a key kept in a Docker volume. That's fine for evaluation and for single-tenant deployments where the host root is already in scope. **It is not appropriate** for multi-tenant or regulated deployments — flip to an external Vault through the admin UI.

### Does Strata phone home?

No. There is no telemetry, no analytics, no auto-update beacon. All outbound traffic is initiated by your operators or end users.

### Does Strata scan uploaded files for malware? (v1.12.0+)

Yes — opt-in. v1.12.0 added a pluggable AV scanner that runs on both Quick Share upload paths (inbound _to_ the remote session and outbound approval-gated _from_ the remote session). The default backend is `off` so v1.11.x deployments upgrade with no behaviour change; flip to `clamav` (with the bundled sidecar via the `av` compose profile) or `command` (Microsoft Defender, Sophos, ESET, any scanner with the `0=clean, 1=infected` exit-code contract) to enable scanning. See [av-scanning.md](av-scanning.md) for the full operator guide and [ADR-0011](adr/ADR-0011-av-scanning.md) for the design rationale.

### What happens if the AV scanner is down?

Fail-closed by default. `STRATA_AV_FAIL_MODE=block` (the shipped default) treats every scanner error — TCP refused, daemon timeout, command not found, `clamd` panic — as a block, with the audit row recording the error message verbatim. Operators who prefer degraded-open behaviour set `STRATA_AV_FAIL_MODE=allow`; even then, **infected** verdicts are still rejected unconditionally (the fail-mode knob only controls **error** verdicts, never **infected** verdicts).

### Can I use Microsoft Defender / Sophos / ESET instead of ClamAV?

Yes — that's what the `command` backend is for. Set `STRATA_AV_BACKEND=command` and point `STRATA_AV_CMD` at your scanner with the `{path}` placeholder where the file path goes. Any scanner that returns exit code `0` on clean and `1` on infected works. Examples in [av-scanning.md](av-scanning.md) cover Defender for Endpoint, Sophos SAVScan, and ESET ODScan; for anything fancier wrap the invocation in a small bash script and point `STRATA_AV_CMD` at the script.

### Where do I see blocked / infected files?

Three places: (1) the `file.av_blocked` audit-log row for inbound rejections (carries `signature`, `filename`, `byte_len`, `session_id`, `av_backend`), (2) the new `av_*` columns on `outbound_shares` for outbound rejections (queryable directly or via the admin outbound-share endpoints), and (3) the partial index `idx_outbound_shares_av_attention` keeps the operator dashboard query "show me every outbound row that needs eyeballing" cheap as the table grows.

### How big is the ClamAV signature DB?

About 250 MB on first download and 1.4 GB resident in memory once `clamd` loads it. The bundled sidecar caps memory at 3 GB. Plan for ~5 minutes of `start_period` on first boot while `freshclam` pulls signatures from clamav.net; subsequent boots reuse the persisted `clamav-db` volume and converge in seconds.

---

## Development & contribution

### How do I set up a local dev environment?

See [CONTRIBUTING.md](../CONTRIBUTING.md). Backend needs Rust 1.95; frontend needs Node 26+ (the Dockerfile uses Node 26).

### Do you accept feature PRs from outside contributors?

Yes — please open an issue or a Discussion _first_ for anything non-trivial so we can shape the design before code is written. The PR template ([.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md)) lists exactly what we'll check at review.

### Why are some upstream guacd patches still applied if you pin to a release commit?

**No longer applicable as of v2.0.0.** There is no `guacd` and no `guacd/patches/`. The question is kept because the answer explains a maintenance cost that motivated the rewrite: upstream's release commit predated fixes we either contributed or needed before they landed in a tagged release, so every bump meant re-validating a patch set against a moving C codebase, and getting it wrong meant a memory-safety bug reachable from a target. The historical patch list remains enumerated in [docs/architecture.md](architecture.md) with the version each was added and removed.

### Where does the project keep architectural decisions?

In [docs/adr/](adr/) (Michael Nygard format). Significant changes get an ADR before code; smaller decisions are captured in PR descriptions and surface in CHANGELOG.md.
