# Frequently Asked Questions

For deeper coverage see [docs/architecture.md](architecture.md),
[docs/security.md](security.md), [docs/deployment.md](deployment.md), and
[docs/api-reference.md](api-reference.md).

---

## Project & positioning

### How is Strata Client different from the Apache Guacamole reference web app?

The reference webapp is a Tomcat-hosted JDBC-or-LDAP authentication shell over `guacd`. Strata replaces that shell entirely with a Rust backend, a React 19 SPA, and a Docker-native deployment, then adds the operations surface a Guacamole deployment usually has to bolt on:

- OIDC SSO with dynamic JWKS validation and proactive refresh-token rotation
- 10-permission RBAC enforced at every admin endpoint
- HashiCorp Vault Transit envelope encryption (bundled and auto-unsealed by default)
- Append-only, SHA-256 hash-chained audit log
- NVR-style live session observation with a 5-minute rewind buffer
- Privileged-account checkout / approval / rotation workflow with LDAP `unicodePwd` reset
- First-class Web kiosk, VDI desktop container, and Kubernetes pod-console connection types
- End-to-end H.264 GFX passthrough to the browser's WebCodecs decoder (no proxy-side transcode)

`guacd` itself is the only piece carried over; we maintain a small set of patches against pinned upstream and rebuild weekly. See [the comparison table in the README](../README.md#vs-vanilla-apache-guacamole) for a side-by-side.

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
export STRATA_VERSION=1.4.1
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
```

That pulls signed, SBOM-attached, SLSA-provenance images from GHCR and starts the full stack with bundled PostgreSQL and Vault. Open `http://127.0.0.1` and the setup wizard takes you the rest of the way.

### Should I use the bundled PostgreSQL or an external one?

For evaluation: bundled is fine. For production: external. The bundled Postgres exists so the project has a true zero-config first-boot experience; it's a single-node container with no managed backups, no read replicas, no PITR. Once you've decided to keep Strata, point `DATABASE_URL` at a managed Postgres and drop the `local-db` profile.

### Should I use bundled Vault or an external one?

The bundled Vault is auto-initialised, auto-unsealed, and runs the Transit engine in a single container — fine for evaluation and for small single-tenant deployments. For production with multi-tenancy, an HA cluster, or compliance requirements, run an external Vault and re-point Strata at it through the admin UI. **The KEKs themselves never leave Vault** in either mode, so the security posture is the same.

### How do I scale guacd?

`docker compose --profile scale up -d` brings up a `guacd-2` sidecar; the backend round-robins across the pool. Add more by duplicating the `guacd-2` block in [docker-compose.yml](../docker-compose.yml) and listing each in `GUACD_INSTANCES`.

### Can I run Strata behind an existing reverse proxy?

Yes. Strata's own `frontend` container is just nginx; if you already have one, you can either:
- Remove the `frontend` service and proxy `/api/*` and `/*` directly at the backend + a static asset server, or
- Keep the `frontend` container and proxy your edge to it on port 80/443.

The WebSocket upgrade path (`/api/tunnel/...`) must be passed through cleanly. Sticky sessions are not required.

### How do I configure HTTPS?

Drop a `cert.pem` and `key.pem` into the `certs/` directory at the repo root and restart. The bundled nginx config redirects port 80 → 443 once certs are present. For Let's Encrypt + auto-renewal use a sidecar like `certbot` or terminate TLS at your edge proxy.

### What's the upgrade path?

Per-version upgrade notes live in [docs/deployment.md § Version-specific upgrade notes](deployment.md#version-specific-upgrade-notes). The headline rule: rebuild backend + frontend on every release; guacd only when an upgrade note explicitly says so.

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

- **Web** spawns a single-tab Chromium kiosk inside `Xvnc` *inside the backend container* and tunnels it as VNC. It's a constrained browser pointed at one URL with optional Playwright/Puppeteer login automation, suitable for SaaS apps that don't have native SSO or need IP-pinning. Works out of the box with `docker compose up -d`.
- **VDI** spawns a Strata-managed Docker container running `xrdp` and tunnels it as RDP — a real Linux desktop in a sandbox. **Disabled by default** because it requires mounting `/var/run/docker.sock` (= host root); opt in via the `docker-compose.vdi.yml` overlay. Read the warning at the top of that file.

See [docs/web-sessions.md](web-sessions.md) and [docs/vdi.md](vdi.md).

### Does Kerberos / NLA actually work?

Yes. We push a dynamically-generated `krb5.conf` to the `guacd` container at runtime, with multi-realm support and per-realm KDCs and lifetimes. AD source can authenticate via simple bind (DN + password) or Kerberos keytab (`kinit` + GSSAPI); custom CA cert upload is supported for internal LDAPS.

### Can users span an RDP session across multiple monitors?

Yes — via the Window Management API (Chromium 100+). Best supported with all-landscape-monitors-in-a-left-to-right-row; portrait works but with letterboxing. See [the README features list](../README.md#protocols--display) for the full caveats.

### Why is RDP H.264 important?

On Windows hosts with AVC444 + hardware encoding enabled, RDP H.264 is roughly an order of magnitude lower bandwidth than the legacy bitmap path, and renders crisp text during rapid window animations. Strata passes H.264 NAL units end-to-end (FreeRDP 3 → guacd → WebSocket → browser WebCodecs `VideoDecoder`) with no proxy-side transcode. See [docs/h264-passthrough.md](h264-passthrough.md) and the [`docs/Configure-RdpAvc444.ps1`](Configure-RdpAvc444.ps1) helper.

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

---

## Security

### How do I report a vulnerability?

Use [GitHub's Private Vulnerability Reporting](https://github.com/Bails309/strata-client/security/advisories/new). See [SECURITY.md](../SECURITY.md) for the full policy, supported-versions matrix, and 90-day disclosure timeline.

### Are container images signed?

Yes. Every tagged release pushes Cosign-signed (keyless, OIDC) images to GHCR with attached SBOMs (CycloneDX) and SLSA Level-3 build provenance. README Quick Start includes the verification commands.

### Is the bundled Vault really safe to use?

The bundled Vault auto-initialises and auto-unseals using a key kept in a Docker volume. That's fine for evaluation and for single-tenant deployments where the host root is already in scope. **It is not appropriate** for multi-tenant or regulated deployments — flip to an external Vault through the admin UI.

### Does Strata phone home?

No. There is no telemetry, no analytics, no auto-update beacon. All outbound traffic is initiated by your operators or end users.

---

## Development & contribution

### How do I set up a local dev environment?

See [CONTRIBUTING.md](../CONTRIBUTING.md). Backend needs Rust 1.95; frontend needs Node 24+ (the Dockerfile uses Node 25).

### Do you accept feature PRs from outside contributors?

Yes — please open an issue or a Discussion *first* for anything non-trivial so we can shape the design before code is written. The PR template ([.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md)) lists exactly what we'll check at review.

### Why are some upstream guacd patches still applied if you pin to a release commit?

Because upstream's release commit predates fixes that we either contributed or that we need before they land in a tagged release. Each patch in [`guacd/patches/`](../guacd/patches/) has a one-line justification at the top and is enumerated in [docs/architecture.md](architecture.md) with the version each was added/removed.

### Where does the project keep architectural decisions?

In [docs/adr/](adr/) (Michael Nygard format). Significant changes get an ADR before code; smaller decisions are captured in PR descriptions and surface in CHANGELOG.md.
