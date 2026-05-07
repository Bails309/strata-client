# Deployment Guide

## Prerequisites

- Docker ≥ 24.0 and Docker Compose ≥ 2.20
- (Optional) A HashiCorp Vault instance with Transit Secrets Engine enabled
- (Optional) A Keycloak or other OIDC provider for SSO
- (Optional) An external PostgreSQL 14+ instance

## System Requirements

### Minimum (up to 5 concurrent sessions)

| Resource | Spec |
|---|---|
| CPU | 2 vCPUs |
| RAM | 4 GB |
| Disk | 20 GB (OS + Docker images + database) |
| Network | 10 Mbps per concurrent RDP session |
| OS | Any Docker-supported Linux, Windows, or macOS |

### Recommended (10–25 concurrent sessions)

| Resource | Spec |
|---|---|
| CPU | 4 vCPUs |
| RAM | 8 GB |
| Disk | 50 GB SSD (faster database queries and guacd I/O) |
| Network | 100 Mbps+ |
| OS | Linux (Debian/Ubuntu or Alpine-based) for best Docker performance |

### Large Scale (25+ concurrent sessions)

| Resource | Spec |
|---|---|
| CPU | 8+ vCPUs |
| RAM | 16+ GB |
| Disk | 100+ GB SSD |
| Network | 1 Gbps |

For large deployments, consider:
- **guacd scaling** — add sidecar instances via `GUACD_INSTANCES` (each guacd instance handles ~10–15 concurrent RDP sessions with H.264)
- **External PostgreSQL** — managed database with connection pooling
- **Session recordings** — allocate additional disk proportional to session count and retention period (~50–200 MB/hour per session depending on activity)

### Resource Breakdown by Container

| Container | CPU | RAM | Notes |
|---|---|---|---|
| `guacd` | High | 200–500 MB | Heaviest consumer — FreeRDP + H.264 encoding per session |
| `backend` | Low | 100–200 MB | Async Rust — very efficient; NVR buffers add ~50 MB per active session |
| `frontend` | Minimal | 30 MB | Static file serving + reverse proxy via nginx |
| `postgres-local` | Low–Medium | 200–500 MB | Depends on audit log volume |
| `vault` | Minimal | 50 MB | Transit encrypt/decrypt only |

> **Note:** guacd is the primary bottleneck. Each concurrent RDP session with H.264 GFX uses approximately 1 CPU core at peak. SSH and VNC sessions are significantly lighter.

## Quick Start (Development / Evaluation)

```bash
git clone https://github.com/your-org/strata-client.git
cd strata-client
cp .env.example .env
docker compose up -d --build
```

Open `http://127.0.0.1` and complete the setup wizard. The bundled PostgreSQL and Vault containers handle all storage and encryption — no external dependencies required.

> **Note:** If `localhost` doesn't work, use `127.0.0.1` explicitly. WSL can bind to IPv6 `::1:80` on some systems, intercepting requests before they reach Docker.

## Production Deployment

> [!TIP]
> **New to Strata Client?** For a comprehensive host-level guide, see our [Ubuntu VM Deployment Guide](ubuntu-vm-deployment.md).

### Supply-chain verification (required before every rollout)

Every image built by the [release workflow](../.github/workflows/release.yml)
is signed keyless with Cosign, carries a CycloneDX SBOM attestation, and
ships SLSA Level 3 build provenance. Any deployment pipeline — manual or
automated — **must** verify the image digest it is about to pull before
rolling it out. The repository ships [`scripts/verify-image.sh`](../scripts/verify-image.sh)
for exactly this purpose:

```bash
# Backend
./scripts/verify-image.sh \
  ghcr.io/your-org/strata-client/backend@sha256:<digest>

# Frontend
./scripts/verify-image.sh \
  ghcr.io/your-org/strata-client/frontend@sha256:<digest>
```

The script runs:

1. `cosign verify` — confirms the digest was signed by the expected GitHub
   Actions release workflow identity via Sigstore Fulcio + Rekor.
2. `cosign verify-attestation --type cyclonedx` — confirms the CycloneDX
   SBOM attestation is present and signed by the same identity.
3. `slsa-verifier verify-image` — confirms SLSA L3 build provenance and
   that the image was built from this repository.

Requirements: `cosign >= 2.2` and `slsa-verifier >= 2.5` in `PATH`.

**Rollout MUST abort** if this script exits non-zero.

### 1. Environment Configuration

Edit `.env` or set environment variables:

```bash
HTTP_PORT=80             # Nginx HTTP listener (host mapping)
HTTPS_PORT=443           # Nginx HTTPS listener (host mapping)
RUST_LOG=info            # Log level: trace, debug, info, warn, error
```

### 2. Build & run

For local evaluation or development:

```bash
docker compose up -d --build
```

For production deployment on an Ubuntu VM, see the detailed [Ubuntu VM Deployment Guide](docs/ubuntu-vm-deployment.md).

### 3. TLS / Reverse Proxy

All traffic flows through the nginx reverse proxy built into the `frontend` container. No backend ports are exposed directly — nginx is the single entry point.

```
Browser → nginx (:80/:443) → backend:8080 (/api/*)
                            → static files   (everything else)
```

#### HTTP Mode (Default)

With no additional configuration, nginx serves plain HTTP on port 80:

```bash
docker compose up -d
```

Access the site at `http://your-server-ip` or `http://127.0.0.1`.

No certificates are needed. This is suitable for:
- Local development
- Internal networks behind a corporate firewall
- Environments where TLS is terminated upstream (e.g., a cloud load balancer)

#### HTTPS Mode (Production)

To enable HTTPS, place your TLS certificate and key in the `certs/` directory:

```bash
certs/
├── cert.pem      # TLS certificate (or fullchain)
└── key.pem       # Private key
```

The `frontend` container's entrypoint (`ssl-init.sh`) automatically detects these files on startup:
- **Certificates found** → nginx activates the HTTPS configuration (`https_enabled.conf`): TLS on port 443, HTTP→HTTPS redirect on port 80, HTTP/2, Mozilla Intermediate cipher suite, HSTS headers
- **Certificates missing** → nginx falls back to HTTP-only (`http_only.conf`)

No environment variable or manual config change is needed — just mount the certs and restart:

```bash
docker compose up -d --build frontend
```

**Using Let's Encrypt / Certbot:**

```bash
# Obtain certificates (run on the host)
certbot certonly --standalone -d strata.example.com

# Symlink or copy into the certs/ directory
cp /etc/letsencrypt/live/strata.example.com/fullchain.pem ./certs/cert.pem
cp /etc/letsencrypt/live/strata.example.com/privkey.pem ./certs/key.pem

# Restart frontend to pick up the certs
docker compose restart frontend
```

Set up a cron job or systemd timer to auto-renew and restart the frontend container.

#### Custom Ports

Override the default port bindings in `.env`:

```bash
HTTP_PORT=8080
HTTPS_PORT=8443
```

#### Nginx Configuration Files

| File | Purpose |
|---|---|
| `frontend/common.fragment` | Shared routing rules, timeouts, compression, security headers |
| `frontend/http_only.conf` | HTTP-only server block (port 80) |
| `frontend/https_enabled.conf` | HTTPS server block (port 443) + HTTP→HTTPS redirect |
| `frontend/ssl-init.sh` | Entrypoint script that auto-selects HTTP or HTTPS based on cert presence |
| `docker-compose.yml` | Frontend service definition, port mappings, cert volume |

Key performance settings in `common.fragment`:
- `proxy_read_timeout 3600s` / `proxy_send_timeout 3600s` — keeps WebSocket tunnels alive for long RDP/SSH sessions
- `proxy_buffering off` — streams tunnel frames immediately with zero buffering
- `gzip on` — compresses static assets and API responses

### Web sessions and VDI desktops

Strata Client ships two protocol drivers that run on the backend host
rather than against an external server: `web` (kiosk Chromium inside
`Xvnc`, tunnelled as VNC) and `vdi` (Strata-managed Docker container
running `xrdp`, tunnelled as RDP). Both share the same backend image
— there is **one** Docker image and **one** binary, with runtime
feature flags controlling which protocols are active. See
[`web-sessions.md`](web-sessions.md) and [`vdi.md`](vdi.md) for the
protocol-specific operator guides.

**Web sessions are part of the default deployment.** The unified
backend image (Debian trixie-slim) ships `Xvnc` and `chromium` baked
in, and `STRATA_WEB_ENABLED=true` is the default. No overlay or
profile is required:

```bash
docker compose up -d --build
```

**VDI is gated behind an explicit overlay.** Mounting
`/var/run/docker.sock` into the backend container effectively grants
the backend host-root on the Docker daemon, so it is **not** in the
default compose graph. Operators who want VDI must consciously layer
[`docker-compose.vdi.yml`](../docker-compose.vdi.yml):

```bash
docker compose -f docker-compose.yml -f docker-compose.vdi.yml up -d --build
```

To make this the default for every `docker compose ...` invocation,
set `COMPOSE_FILE` in `.env`:

```env
# Linux / macOS — colon separator
COMPOSE_FILE=docker-compose.yml:docker-compose.vdi.yml
# Windows — semicolon separator
COMPOSE_FILE=docker-compose.yml;docker-compose.vdi.yml
```

> **Why stickiness matters.** Without `COMPOSE_FILE`, every operator
> command must spell out both `-f` flags. A single
> `docker compose up -d backend` (no overlay) silently drops the
> docker.sock mount and the `STRATA_VDI_ENABLED` flag, and the next
> VDI tunnel attempt returns a 503 "vdi driver unavailable".

#### VDI runtime requirements (v0.30.0)

Three operational details became apparent during the v0.30.0
runtime delivery and are documented here for production deployments:

1. **`docker.sock` permission.** The backend image runs as the
   unprivileged `strata` user via `gosu strata strata-backend`. The
   entrypoint script ([`backend/entrypoint.sh`](../backend/entrypoint.sh))
   distinguishes Linux distros (where the socket is owned by a
   non-zero `docker` group GID) from Docker Desktop on Windows / macOS
   (where the socket is owned by `root:root` GID 0). On Linux it
   creates a `docker-host` group at the socket's GID and adds
   `strata` to it; on Docker Desktop it `chgrp strata` +
   `chmod g+rw` the bind-mount in place. Both branches log the chosen
   path so operators can audit it. **No operator action required**;
   the entrypoint runs automatically on every container start.
2. **Docker network resolution.** Docker Compose prefixes network
   names with the project name, so the network the rest of the stack
   joins is `<project>_guac-internal`, not `guac-internal`. The
   overlay sets `STRATA_VDI_NETWORK` to
   `${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal` so the
   default Compose project name "just works". Operators who set a
   custom `COMPOSE_PROJECT_NAME` get the right resolution
   automatically; operators who deploy outside Compose (Kubernetes,
   direct `docker run`) must override `STRATA_VDI_NETWORK` to a
   network that exists.
3. **Host resource budget.** Each VDI container is a full Linux
   desktop. Set `system_settings.max_vdi_containers` (Admin →
   Settings → VDI) to bound concurrency on a single backend replica;
   pair this with operator-supplied `cpu_limit` and `memory_limit_mb`
   on the connection row to cap per-container resource usage.

**Decision matrix:**

| Goal | Command |
|---|---|
| RDP / SSH / VNC + web (default) | `docker compose up -d --build` |
| Add bundled PostgreSQL | `docker compose --profile local-db up -d --build` |
| Add VDI | `docker compose -f docker-compose.yml -f docker-compose.vdi.yml up -d --build` |
| Everything | `docker compose -f docker-compose.yml -f docker-compose.vdi.yml --profile local-db up -d --build` |

`-f` flags select which compose files to merge (structural — for
VDI's host-root mount). `--profile` flags select which optional
services to start (local postgres, extra guacd). The two are
independent. TLS is terminated by the frontend nginx gateway using
the certificates mounted from `./certs/` — there is no separate
reverse-proxy service.

#### Using an External Reverse Proxy Instead

If you must use a different reverse proxy (e.g., Traefik, HAProxy, Caddy, or a cloud load balancer), you can modify `docker-compose.yml` to expose the backend and frontend ports directly. Key requirements for your proxy:

- Route `/api/*` to `backend:8080` with WebSocket upgrade support
- Route everything else to `frontend:80`
- Set `proxy_read_timeout` / `proxy_send_timeout` to at least 3600s for tunnel connections
- Forward `X-Forwarded-For`, `X-Forwarded-Proto`, and `Host` headers

### 3. External Database

After initial setup with the bundled database, migrate to an external PostgreSQL instance:

1. Navigate to **Admin → Database** in the web UI
2. Enter the external PostgreSQL connection string
3. Click **Migrate Database**

The backend will:
- Test the connection
- Run all migrations on the new database
- Update `config.toml`
- Switch all queries to the new database

Alternatively, configure the external database during the first-boot setup wizard.

#### Database SSL / TLS

To encrypt the connection between the backend and an external PostgreSQL server, set the following environment variables in `.env`:

| Variable | Description |
|---|---|
| `DATABASE_SSL_MODE` | SSL mode for the connection. Overrides any `sslmode` query parameter in `DATABASE_URL`. Valid values: `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`. |
| `DATABASE_CA_CERT` | Absolute path (inside the backend container) to a PEM-encoded CA certificate file. Required when `DATABASE_SSL_MODE` is `verify-ca` or `verify-full`. |

**Example — require encrypted connection without CA verification:**

```bash
DATABASE_URL=postgresql://user:password@db.example.com:5432/strata
DATABASE_SSL_MODE=require
```

**Example — full server certificate verification:**

```bash
DATABASE_URL=postgresql://user:password@db.example.com:5432/strata
DATABASE_SSL_MODE=verify-full
DATABASE_CA_CERT=/app/config/db-ca.pem
```

To make the CA certificate available inside the container, mount it via `docker-compose.yml`:

```yaml
services:
  backend:
    volumes:
      - ./certs/db-ca.pem:/app/config/db-ca.pem:ro
```

> **Note:** The `sslmode` query parameter in `DATABASE_URL` (e.g., `?sslmode=require`) also works but `DATABASE_SSL_MODE` takes precedence when set.

### 4. HashiCorp Vault

#### Bundled Mode (Recommended)

The Docker Compose stack includes a HashiCorp Vault 1.19 container that is fully auto-configured:

1. Select **Bundled** in the setup wizard vault mode selector
2. The backend automatically:
   - Initializes Vault with a single unseal key
   - Unseals the Vault
   - Enables the Transit Secrets Engine
   - Creates the encryption key (default: `guac-master-key`)
   - Stores the root token and unseal key in `config.toml`
3. On subsequent restarts, the backend auto-unseals using the stored key

No manual Vault configuration is required. The bundled Vault uses file storage with a persistent Docker volume (`vault-data`).

#### External Mode

To use your own Vault instance instead of the bundled container:

1. Enable the Transit Secrets Engine:
   ```bash
   vault secrets enable transit
   ```

2. Create an encryption key:
   ```bash
   vault write -f transit/keys/guac-master-key
   ```

3. Create a policy for the backend:
   ```hcl
   path "transit/encrypt/guac-master-key" {
     capabilities = ["update"]
   }
   path "transit/decrypt/guac-master-key" {
     capabilities = ["update"]
   }
   ```

4. Select **External** in the setup wizard and provide the Vault address, token, and transit key name.

#### Switching Modes

You can switch between Bundled and External vault modes at any time via **Admin → Vault**. The mode toggle allows reconfiguring without data loss — existing encrypted credentials remain valid as long as the Transit key is accessible.

### 5. OIDC / SSO (Keycloak)

1. Create a Keycloak realm and client for Strata
2. Set the client access type to **Confidential**
3. Add `http://strata.example.com/*` to the redirect URIs
4. Navigate to **Admin → SSO / OIDC** and enter:
   - Issuer URL: `https://keycloak.example.com/realms/strata`
   - Client ID: from Keycloak
   - Client Secret: from Keycloak

### 6. Kerberos

If your target RDP hosts require Kerberos/NLA authentication:

1. Navigate to **Admin → Kerberos**
2. Add one or more Kerberos realms with KDCs, admin server, and ticket lifetime settings
3. Mark one realm as the default
4. Save — the backend generates `krb5.conf` aggregating all realms and writes it to the shared volume

The `guacd` container reads `KRB5_CONFIG=/etc/krb5/krb5.conf` at runtime. Multiple realms are supported for cross-forest or multi-domain environments.

### 7. DNS Configuration

If your target RDP/SSH hosts use internal DNS names (e.g. `.local`, `.dmz.local`, `.internal`) that Docker's default DNS resolver cannot resolve:

1. Navigate to **Admin → Network**
2. Enable **Custom DNS**
3. Enter one or more DNS server IP addresses (comma-separated), e.g. `10.0.0.1, 10.0.0.2`
4. Enter your DNS search domains (comma-separated), e.g. `example.local, corp.example.com`
5. Click **Save**
6. Restart guacd containers to apply:
   ```bash
   docker compose restart guacd
   # If using sidecar scaling:
   docker compose restart guacd guacd-2
   ```

**How it works:** The backend validates the DNS IPs and search domains, saves them to the database, and writes a `resolv.conf` file to the shared `backend-config` Docker volume. Docker's embedded DNS resolver (`127.0.0.11`) is always appended as a fallback nameserver, so existing connections that resolve via public DNS or Docker service discovery continue working without reconfiguration. On startup, each guacd container's entrypoint copies this file to `/etc/resolv.conf`, enabling hostname resolution for internal domains.

> [!IMPORTANT]
> **Search domains are required for `.local` zones.** The `.local` TLD is special — without a `search` directive in `resolv.conf`, many systems won't resolve bare hostnames against `.local` domains. The search domain field is equivalent to the `Domains=` directive in `systemd-resolved` on your host OS. For example, with `example.local` as a search domain, a connection targeting `server01` will resolve as `server01.example.local`.

> [!NOTE]
> DNS changes require a guacd container restart to take effect. Active sessions on the restarted containers will be disconnected.

### 8. Active Directory LDAP Sync

To automatically import computer accounts from Active Directory:

1. Navigate to **Admin → AD Sync**
2. Click **+ Add Source**
3. Configure the source:
   - **Label** — display name for this source
   - **LDAP URL** — e.g. `ldaps://dc1.contoso.com:636`
   - **Authentication** — Simple Bind (DN + password) or Kerberos Keytab
   - **Search Bases** — one or more OU scopes (click "+ Add Search Base" for multiple)
   - **Search Filter** — choose a preset (All Computers, Servers Only, Enabled Only, etc.) or enter a custom LDAP filter
   - **Protocol / Port** — default protocol and port for imported connections (e.g. RDP/3389)
   - **Group** — optional connection group for imported connections
   - **CA Certificate** — upload an internal CA cert (PEM) if using LDAPS with self-signed certificates
   - **Connection Defaults** (RDP only) — configure Guacamole parameters applied to all synced connections:
     - *Display & Performance*: ignore server certificate, enable wallpaper/font smoothing/desktop composition/theming/full-window drag/menu animations, disable bitmap/glyph/offscreen caching, disable GFX pipeline
     - *Session Recording*: recording path, recording name (supports `${GUAC_DATE}`, `${GUAC_TIME}`, `${GUAC_USERNAME}` tokens), auto-create recording path, include key events, exclude mouse/touch/graphical output
4. Click **⚡ Test Connection** to validate connectivity and preview discovered objects
5. Click **Save** to create the source
6. Click **⟳ Sync Now** to trigger the initial import, or wait for the scheduled sync interval

**Sync lifecycle:**
- New objects discovered in AD are created as connections
- Objects that change hostname or name are updated
- Objects that disappear from AD are soft-deleted (hidden from users) for 7 days
- After 7 days, soft-deleted objects are permanently removed
- gMSA and MSA service accounts are excluded from all preset filters

**Authentication methods:**
- **Simple Bind** — provide a bind DN and password with appropriate LDAP read permissions
- **Kerberos Keytab** — provide a keytab file path (mounted into the backend container) and principal; the backend uses `kinit` + `ldapsearch` with GSSAPI

### 9. Notification Email (SMTP)

Strata Client sends transactional email for managed-account checkout events (pending approval, approved, rejected, and self-approved audit notice). All four templates are MJML-rendered, multipart/related (HTML + plain-text alternative + inline `cid:strata-logo`), and pre-hardened against Outlook desktop's dark-mode "haze" via a VML wrapper.

**Prerequisites:**

- A reachable SMTP relay (your tenant relay, AWS SES, SendGrid, Postfix on the docker host, etc.)
- A verified `From:` address with SPF/DMARC/DKIM aligned for the domain you intend to send from. Most relays will reject (5xx) if SPF or DMARC fails — those rejections are classified as **permanent** and not retried.
- **Vault must be unsealed and operational.** The `PUT /api/admin/notifications/smtp` endpoint refuses to save the SMTP password when the configured Vault backend is sealed or running in stub mode. This is an intentional hard-fail to prevent plaintext credential storage.

**Configuration steps:**

1. Navigate to **Admin → Notifications**
2. Fill in the SMTP form:
   - **Host / Port** — your relay (e.g. `smtp.contoso.com:587`)
   - **Username / Password** — relay credentials. The password is sealed in Vault before being written to `system_settings`.
   - **TLS Mode** — `STARTTLS` (port 587, recommended), `Implicit TLS` (port 465), or `None` (plaintext, internal relays only)
   - **From Address** — must be a verified sender for your domain. **Empty value blocks the dispatcher entirely** (audit event `notifications.misconfigured`).
   - **From Name** — display name in the `From:` header (default `Strata Client`)
   - **Branding Accent Color** — used by future templates and surfaced in the SMTP test-send body
3. Click **Save**
4. Click **Send Test Email** and provide a recipient. The actual SMTP response (or error) is surfaced verbatim in the UI for debugging.
5. Toggle **Enabled** to **On** to begin dispatch on real checkout events.

**Per-user opt-out (v0.25.0):**

For v0.25.0 the user-facing toggle UI ships in a follow-up release. Administrators can manually opt a user out via SQL:

```sql
UPDATE users SET notifications_opt_out = true WHERE email = 'user@contoso.com';
```

The dispatcher honours the flag for every transactional message **except** the self-approved audit notice (which exists for security visibility and intentionally bypasses the opt-out). Each suppression is logged as `notifications.skipped_opt_out` in the append-only audit log and reflected in `email_deliveries` with `status = 'suppressed'`.

**Monitoring deliveries:**

The **Admin → Notifications → Recent Deliveries** view shows the last 50 attempts with status, attempt count, and last-error text. The same data is available via `GET /api/admin/notifications/deliveries?status=failed&limit=200` for external monitoring scrapers. The retry worker re-attempts `failed` rows where `attempts < 3` with exponential backoff and abandons rows after the third attempt (audit event `notifications.abandoned`).

When notifications stop arriving, follow [docs/runbooks/smtp-troubleshooting.md](runbooks/smtp-troubleshooting.md).

---

## Upgrading

### Version-specific upgrade notes

#### v1.4.0 → v1.4.1 (drop-in image rebuild — backend + frontend)

v1.4.1 is a patch release on top of v1.4.0. The headline fix is the
WebSocket-tunnel auth watchdog regression: tunnels were being torn
down at the access-token TTL (every 20 minutes) regardless of how
active the operator was, because the watchdog cached the token's
`exp` claim once at upgrade time and could not learn about
proactive token rotation. v1.4.1 removes the `exp` enforcement and
replaces it with an 8-hour wall-clock hard cap that is unaffected
by token rotation. See
[`docs/security.md` § WebSocket-tunnel auth watchdog](security.md#websocket-tunnel-auth-watchdog-v132-revised-v141)
for full prose.

No database migrations. No `/api/*` contract changes (only the
`tunnel.terminated` audit `reason` enum gained `"max_duration"`
and lost `"expired"`). No `config.toml` schema changes.

```bash
cd strata-client
git pull
docker compose pull               # refresh base images
docker compose build backend frontend
# guacd image is unchanged from v1.4.0; rebuild only if you want
# the documentation-only Dockerfile comment refresh.
docker compose up -d
```

Verify post-upgrade:

```bash
# 1. Active session survives 20-minute access-token rollover
#    Open a connection, leave it idle for 25 minutes, confirm the
#    tunnel is still up. (Pre-1.4.1 the watchdog would have reaped
#    it at T+20m.)

# 2. Audit log shows the new reason values
docker compose exec postgres-local psql -U strata -d strata -c \
  "SELECT action_type, details->>'reason'
   FROM audit_logs
   WHERE action_type = 'tunnel.terminated'
   ORDER BY created_at DESC LIMIT 20;"
# Expected reasons: 'revoked' or 'max_duration'.
# 'expired' should no longer appear for new closures.

# 3. Manual logout still closes any open tunnels within ~30 s
docker compose logs --tail=200 backend | grep tunnel.terminated
```

If you scrape the audit log, dashboards that filtered on
`reason = 'expired'` should add `'max_duration'` to the filter.

#### v1.3.x → v1.4.0 (drop-in image rebuild — backend + frontend; one new migration)

v1.4.0 introduces the Kubernetes pod console as a first-class
connection protocol. The image rebuild is mandatory, but the
upgrade is otherwise drop-in.

- **Migration `060_kubernetes_protocol.sql`** widens the `connections.protocol`
  and `ad_sync_configs.protocol` `CHECK` constraints to include
  `'kubernetes'`. The migration runs automatically on backend boot.
- **`guacd` image** was not changed for v1.4.0 itself, but the
  Dockerfile guard `test -f /build/usr/local/lib/libguac-client-kubernetes.so`
  was added in v1.3.x to fail the image build if the
  `kubernetes` protocol driver ever silently regresses; if you are
  pulling images from a registry, no guacd rebuild is required.
- **No `config.toml` changes.** All Kubernetes form fields and
  endpoints are admin-gated at runtime.

```bash
cd strata-client
git pull
docker compose pull
docker compose build backend frontend
docker compose up -d
docker compose logs --tail=50 backend | grep "060_kubernetes_protocol"
```

Verify post-upgrade:

```bash
# 1. Migration applied
docker compose exec postgres-local psql -U strata -d strata -c \
  "SELECT pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conname = 'connections_protocol_check';"
# Expected: contains 'kubernetes'

# 2. Admin can paste a kubeconfig and POST it to /parse-kubeconfig
#    (see docs/api-reference.md for the full request/response shape)

# 3. New connection picker shows 'Kubernetes Pod' as a protocol
```

Rollback: drop the new migration and revert the backend image. The
connection editor will refuse to render `kubernetes`-protocol rows
on a backend that does not know the protocol, but other connection
types are unaffected.

#### v1.2.0 → v1.3.0 (mandatory image rebuild — backend *and* frontend)

v1.3.0 is a focused production-hardening release. It fixes four
bugs surfaced on the in-house deployment (see
[CHANGELOG](../CHANGELOG.md) for the full causal chain on each):

1. Backend container crash-loop with exit code 141 and empty logs
   (`find … | head -n1` racing under `pipefail` in
   [`backend/entrypoint.sh`](../backend/entrypoint.sh)).
2. Frontend nginx dying on boot with `[emerg] host not found in
   upstream "backend"` if the backend was even briefly unreachable
   during `docker compose up -d --build`. Fixed via a runtime
   `resolver 127.0.0.11` declaration in `frontend/common.fragment`
   and a variable-target `proxy_pass`.
3. `NET::ERR_CERT_AUTHORITY_INVALID` for sites signed by an
   uploaded Trusted CA. Fixed by pointing `HOME` at the per-session
   `--user-data-dir` so Chromium's NSS-based cert verifier resolves
   to the directory the backend just populated.
4. Web kiosk handle leaking past browser-tab close. Fixed by adding
   `web_runtime.evict()` in the WebSocket-tunnel route after the
   proxy loop returns.

Plus a Quick Share UX upgrade: protocol-aware download snippets
(`curl` for SSH/Telnet, bare URL for kiosks, `wget` and PowerShell
overrides) rendered through the shared `Select` dropdown.

All four backend fixes live in either `entrypoint.sh` or the Rust
binary — both baked into the backend image. The nginx resolver fix
lives in the frontend image. **Both must be rebuilt:**

```bash
cd strata-client
git pull
docker compose pull               # refresh base images
docker compose build --pull       # rebuild backend + frontend
docker compose up -d
```

A `docker compose pull` of an unchanged registry tag is **not**
sufficient.

No database migrations. No `/api/*` contract changes. No
configuration-file changes required. Existing Trusted CA bundles
uploaded under v1.2.0 *start working* on the first kiosk spawn
under v1.3.0 — no re-upload needed.

Verify post-upgrade:

```bash
# 1. Backend stays Up (healthy), no longer Restarting (141)
docker compose ps backend

# 2. nginx survives a backend bounce without manual restart
docker compose restart backend
sleep 15
docker compose logs --tail=20 frontend | grep -v "host not found"
# Expected: no "host not found in upstream" emerg lines

# 3. New audit event emits when a kiosk tab closes
docker compose logs backend | grep web.session.end | grep tunnel_disconnect
```

#### v1.1.0 → v1.2.0 (mandatory image rebuild)

v1.2.0 introduces reusable Trusted CA bundles for the `web`
protocol (see [`web-sessions.md`](web-sessions.md) and
[`security.md`](security.md)) and a small cluster of email and UX
fixes. The backend image gains a new apt package — `libnss3-tools`,
which provides the `certutil` binary used at kiosk launch to import
the per-connection PEM into a per-session NSS database — so a
`docker compose pull` alone is **not** sufficient unless your
registry has already published the new image tag:

```bash
cd strata-client
git pull
docker compose pull
docker compose build --pull       # picks up libnss3-tools
docker compose up -d
```

One new database migration runs automatically on first boot:
`059_trusted_ca_bundles.sql`. No existing rows are touched. No
`/api/*` breaking changes are introduced; the five new endpoints
(`/api/admin/trusted-cas` × 4 plus `/api/user/trusted-cas`) are
purely additive. The `WebSessionConfig` schema gains an optional
`trusted_ca_id` field; old `connections.extra` rows without the key
continue to use the OS default trust store unchanged.

Operator action — review SMTP rows: if you previously stored a
username and password against an `smtp.tls_mode = "none"` row, the
new UI clears those credentials on the next save. The database row
is untouched until that save event.

#### v1.0.0 → v1.1.0 (mandatory image rebuild)

v1.1.0 ships a runtime fix for historic-recording playback that
lives in the `entrypoint.sh` layer of both the `backend` and
`guacd` images, *not* in the Rust binary or the frontend bundle.
Operators must therefore rebuild both images, not just pull new
tags:

```bash
cd strata-client
git pull
docker compose pull              # refresh base images (vault, postgres, etc.)
docker compose build --pull      # rebuild backend + guacd with new entrypoints
docker compose up -d
```

A `docker compose pull` alone is **not** sufficient if your
registry has not yet rebuilt the images. The fix establishes a
runtime supplementary-group bootstrap inside the backend
container (see [security.md — Recordings Volume](security.md))
that grants the unprivileged `strata` user POSIX group-read on
`.guac` files written by guacd as `guacd:guacd`.

After the upgrade, all existing recordings on the shared
`guac-recordings` volume become readable on first backend boot
with no file-rewriting, re-encoding, or `chmod` sweep required.
Verify with:

```bash
docker compose logs backend | grep "for recording playback access"
# Expected: [entrypoint] Added strata to <group> (gid=<n>) for recording playback access
```

If the line is absent on first boot of a brand-new deployment
(empty recordings volume), it will appear automatically the
first time the backend restarts after guacd has captured a
recording. Operators on a clean install can also force the
bootstrap deterministically by capturing one short test
recording and restarting the backend container.

No database migrations land in v1.1.0; no `/api/*` contract
changes; no `config.toml` schema changes.

#### General upgrade procedure

### Application (Backend + Frontend)

```bash
cd strata-client
git pull
docker compose up -d --build
```

The backend automatically runs any new SQL migrations on startup using advisory locks, so it is safe to scale horizontally. Migrations `001` through `048` are applied in order. If a previously-applied migration's checksum has changed (e.g. due to line-ending normalisation), the backend auto-repairs the stored checksum before proceeding, so no manual database intervention is required.

### Custom guacd

> **Warning:** Restarting guacd drops all active user sessions. Schedule upgrades during a maintenance window.

#### Automated (CI/CD)

The GitHub Actions workflow at `.github/workflows/build-guacd.yml` runs weekly and pushes to GHCR. To use the pre-built image:

1. Update `docker-compose.yml` to pull from your registry:
   ```yaml
   guacd:
     image: ghcr.io/your-org/custom-guacd:latest
   ```

2. Pull and restart:
   ```bash
   docker compose pull guacd
   docker compose up -d guacd
   ```

#### Manual

```bash
# Clone the latest release
git clone --depth 1 --branch <version> https://github.com/apache/guacamole-server.git /tmp/guac-src

# Build with the custom Dockerfile (already configured)
docker build -t custom-guacd:latest ./guacd

# Recreate the container
docker compose up -d guacd
```

---

## High Availability

### Backend Scaling

The Rust backend is stateless (session state lives in the WebSocket connection and guacd). To run multiple instances:

1. Point all instances at the same external PostgreSQL database
2. Place behind a load balancer with sticky sessions (or WebSocket-aware routing)
3. The advisory-lock migration system ensures only one instance applies schema changes

### Database

Use a managed PostgreSQL service (e.g., AWS RDS, Azure Database for PostgreSQL, Cloud SQL) with:
- Automated backups
- Read replicas (for audit log queries)
- Connection pooling (PgBouncer)

### guacd Scaling

For environments with many concurrent sessions, deploy additional guacd sidecar instances. Each guacd instance handles approximately 10–15 concurrent RDP sessions with H.264 encoding.

#### Adding a Second guacd Instance

The default `docker-compose.yml` includes a pre-configured `guacd-2` service behind the `scale` profile:

```bash
# Enable the scale profile and set the sidecar address
GUACD_INSTANCES=guacd-2:4822 docker compose --profile scale up -d
```

The backend discovers `guacd-2` via the `GUACD_INSTANCES` environment variable and distributes new connections across both `guacd` (the default) and `guacd-2` using a round-robin `GuacdPool`.

#### Adding 3 or More guacd Instances

To scale beyond 2 instances, duplicate the `guacd-2` service block in `docker-compose.yml` for each additional sidecar:

```yaml
  # ── Additional guacd sidecar (copy this block for guacd-4, guacd-5, etc.)
  guacd-3:
    build:
      context: ./guacd
      dockerfile: Dockerfile
    image: strata/custom-guacd:latest
    restart: unless-stopped
    profiles:
      - scale
    networks:
      - guac-internal
    volumes:
      - guac-recordings:/var/lib/guacamole/recordings
      - guac-drive:/var/lib/guacamole/drive
      - krb5-config:/etc/krb5
      - backend-config:/app/config:ro
    environment:
      - KRB5_CONFIG=/etc/krb5/krb5.conf
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - SETGID
      - SETUID
    healthcheck:
      test: ["CMD-SHELL", "nc -z localhost 4822 || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3
```

Then list all sidecar hostnames in `GUACD_INSTANCES` (comma-separated):

```bash
# .env
GUACD_INSTANCES=guacd-2:4822,guacd-3:4822
```

Or configure via `config.toml`:

```toml
guacd_instances = ["guacd-2:4822", "guacd-3:4822"]
```

Start everything:

```bash
docker compose --profile scale up -d
```

#### Capacity Planning

| Concurrent sessions | guacd instances | Estimated CPU cores |
|---|---|---|
| Up to 15 | 1 (default) | 2 |
| 15–30 | 2 | 4 |
| 30–45 | 3 | 6 |
| 45–60 | 4 | 8 |

> **Note:** Each concurrent RDP session with H.264 GFX uses approximately 1 CPU core at peak. SSH and VNC sessions are significantly lighter (~0.1 cores each). Adjust instance count based on your protocol mix.

#### How It Works

- The primary `guacd` service (always running) handles connections by default
- Sidecar instances listed in `GUACD_INSTANCES` are added to the round-robin pool
- New tunnel connections are distributed evenly across all healthy instances
- Each guacd instance independently connects to target hosts, so they can be placed in different network segments if needed
- All instances share the same `guac-recordings`, `guac-drive`, and `krb5-config` volumes
- If a sidecar is unreachable, the backend skips it and routes to the next available instance

### Vault

For the bundled Vault, HA is not applicable — it runs as a single-node file-storage instance. For production HA, use an external Vault cluster:

- Use Vault's built-in HA mode with Raft integrated storage (available in the free Community Edition)
- Or use a managed Vault service (HCP Vault)
- The backend only needs network access to the Transit encrypt/decrypt endpoints
- Select **External** mode in Admin Settings and point to your HA Vault cluster

---

## DMZ deployment mode

> Reference: [ADR-0009](adr/ADR-0009-dmz-deployment-mode.md), [DMZ implementation plan](dmz-implementation-plan.md), [DMZ incident runbook](runbooks/dmz-incident.md).

> Also known as the **DMZ split topology**. Optional — single-node
> deployments are unchanged when `STRATA_DMZ_ENDPOINTS` is unset.

For deployments that require the public-facing surface to be a
separate, minimally-trusted host (no Vault, no DB, no AD, no
Kerberos), Strata supports a split deployment with two binaries:
`strata-dmz` (public) and `strata-backend` (internal). The internal
node dials out to the DMZ over an mTLS-wrapped HTTP/2 tunnel; no
inbound rule from the public network to the internal network is
required.

### Topology

```mermaid
flowchart LR
    Internet([Internet])
    Internet -->|HTTPS| DMZ
    subgraph DMZHost["DMZ host (public)"]
        DMZ["strata-dmz<br/><sub>terminates TLS · signs edge headers<br/>rate-limits + body-caps · no business secrets</sub>"]
    end
    subgraph InternalHost["Internal host (private)"]
        Backend["strata-backend"]
        Backend --> Vault["Vault"]
        Backend --> Postgres["PostgreSQL"]
        Backend --> AD["Active Directory"]
        Backend --> Guacd["guacd"]
    end
    Backend -.->|mTLS h2 link<br/>:8444 outbound| DMZ
```

The polarity is reversed from a normal proxy: **the internal node
dials out** to the DMZ on port 8444 and holds a long-lived authenticated
tunnel open. The DMZ multiplexes inbound HTTP/WebSocket requests onto
that tunnel. Consequence: the firewall between DMZ and internal can
deny **all** inbound traffic to the internal host. A full RCE on the
DMZ yields no path to Vault, the database, or AD.

### Prerequisites

- Two hosts (or two K8s namespaces) on different network segments,
  with a one-way firewall path that permits **only** `internal-host →
  dmz-host:8444/tcp`. Everything else from `dmz-host` toward the
  internal network MUST be denied.
- DNS: a public hostname pointing at `dmz-host` (e.g. `strata.example.com`)
  and a name the internal host can resolve to `dmz-host` over the link
  network (can be the same name or a private one).
- A publicly-trusted TLS certificate for the public hostname.
- An operator-controlled CA for the link mTLS — distinct from the
  public CA so a public CA compromise cannot mint link client certs.
- `openssl` and `docker` on the DMZ host; `kubectl` + `helm` 3.x for
  the Kubernetes path.

### The three shared secrets

The DMZ and internal halves are bound together by three independent
secrets — generate each on a trusted machine, then distribute. The
link PSK and edge HMAC key are decoded as **base64** by both halves;
the operator token is opaque (any sufficiently long random string is
fine, base64 is shown for consistency).

```bash
openssl rand -base64 32  # → STRATA_DMZ_OPERATOR_TOKEN     (DMZ only, opaque)
openssl rand -base64 32  # → STRATA_DMZ_LINK_PSKS current  (BOTH halves, base64)
openssl rand -base64 32  # → STRATA_DMZ_EDGE_HMAC_KEY      (BOTH halves, base64)
```

| Secret | Purpose | Lives on |
|---|---|---|
| `STRATA_DMZ_OPERATOR_TOKEN` | Bearer for the management API on `127.0.0.1:9444` (status, link kick) | DMZ only |
| `STRATA_DMZ_LINK_PSKS` (`current:BASE64[,previous:BASE64]`) | Internal proves identity to DMZ. The `previous:` slot exists for rotation. | DMZ |
| `STRATA_DMZ_LINK_PSK_CURRENT` | Same base64 as DMZ's `current:` value (one env var per id) | Internal |
| `STRATA_DMZ_EDGE_HMAC_KEY` | DMZ signs `x-strata-edge-*` request-attribution headers | DMZ |
| `STRATA_DMZ_EDGE_HMAC_KEYS` | Internal verifies them; comma-separated multi-key list during rotation | Internal |

Generate each independently — never derive one from another and never
store all three in the same file.

### Choosing a topology

Strata ships **four** docker-compose overlays that cover every
supported DMZ deployment shape. Pick one before you start; mixing
overlays on the same host is unsupported.

| Walkthrough | Overlay file | Hosts | Public ports | What's exposed publicly | Best for |
|---|---|---|---|---|---|
| [**A**](#walkthrough-a--docker-compose-single-host-evaluation) | [docker-compose.dmz.yml](../docker-compose.dmz.yml) | 1 | `${DMZ_PUBLIC_PORT}` (default 8443), 8444 | Relay only — no SPA | Local eval / smoke-testing the link |
| [**A.5**](#walkthrough-a5--two-host-bare-metal-api-only-public-exposure) | [docker-compose.dmz-only.yml](../docker-compose.dmz-only.yml) (DMZ host) + [docker-compose.internal.yml](../docker-compose.internal.yml) (internal) | 2 | 8443, 8444 on DMZ host | Relay only — clients must already speak Strata's API | SPA hosted on a CDN / mobile app / API-only consumers |
| [**A.6**](#walkthrough-a6--two-host-bare-metal-with-public-spa-recommended) ⭐ | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) (DMZ host) + [docker-compose.internal.yml](../docker-compose.internal.yml) (internal) | 2 | 80/443 on DMZ host | **Full Strata SPA** + API + WS | Standard production — most operators want this |
| [**A.7**](#walkthrough-a7--split-brain-corporate-lan--public-dmz) | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) (DMZ host) + [docker-compose.yml](../docker-compose.yml) + [docker-compose.internal.yml](../docker-compose.internal.yml) (internal, full stack) | 2 | 80/443 on DMZ host **and** 80/443 on internal host | **Full SPA on both hosts** — corp LAN users hit the internal one, public users hit the DMZ one | Enterprises that want zero-DMZ-hop latency for staff while still publishing externally |

> **Picking the right overlay matters.** If you choose A.5 when you
> meant A.6, end-users won't get a UI when they navigate to your
> public hostname; they'll see a JSON `401`. If you choose A when you
> meant A.5/A.6, the backend's database, Vault, and AD sit on the
> public host alongside the relay — the whole point of the split
> topology is lost. A.7 is A.6 plus a second front door on the
> internal host: pick it only if internal-LAN performance for staff
> is a hard requirement; otherwise A.6 with corporate users dialling
> the public hostname is simpler and sufficient.

---

## Walkthrough A — Docker Compose (single-host evaluation)

This walkthrough takes you from a clean checkout to a live
split-topology deployment running on **one host** (everything in
Docker on the same machine). It is the fastest way to evaluate the
DMZ mode end-to-end. For a true two-host production deployment, see
[Walkthrough A.6 — Two-host bare-metal with public SPA](#walkthrough-a6--two-host-bare-metal-with-public-spa-recommended)
or [Walkthrough B — Kubernetes](#walkthrough-b--kubernetes-helm-chart).

> **Choose your topology.** Three patterns are supported:
> - **A. Single-host eval** — everything in one docker compose. Tests the link, **does not** put a public UI in front of it.
> - **A.5. Two-host, API-only public exposure** — DMZ host serves only `/api/*` over the relay. SPA hosted elsewhere (CDN, internal-only browser).
> - **A.6. Two-host with public SPA (recommended)** — the DMZ host runs both `strata-dmz` and an nginx that serves the SPA *and* reverse-proxies `/api/*` over the relay. Public users get the full UI on `https://dmz.example.com/`. Backend remains unreachable from the internet.

> **What the overlay does for you.** The compose overlay
> [docker-compose.dmz.yml](../docker-compose.dmz.yml) brings up
> *both* halves on the same docker network: a `strata-dmz` service
> on the public side, and the existing `backend` service
> reconfigured into link-client mode. There is **no separate
> internal host** to configure manually — the overlay injects the
> right `STRATA_DMZ_*` env vars into the backend container directly
> from `.env.dmz`. Steps A.1–A.3 below are everything you need.
>
> **What this overlay does NOT include.** A user-facing SPA on the
> DMZ port. `strata-dmz` is a reverse proxy for the backend, not a
> static-asset server. Hitting `https://localhost:${DMZ_PUBLIC_PORT}/`
> in a browser returns the backend's JSON `401`/`405` responses,
> which is correct (it proves the link works) but not a UI. The
> existing nginx frontend at `https://localhost:8443` continues to
> serve the SPA against the backend directly. To put the SPA behind
> the DMZ in production, use [Walkthrough A.6](#walkthrough-a6--two-host-bare-metal-with-public-spa-recommended).

### A.1  Issue mTLS material

For evaluation, the repo ships a test-cert generator:

```bash
git clone <repo-url> strata-client
cd strata-client
./scripts/dmz/gen-test-certs.sh    # writes ./certs/dmz/{ca,server,client,public}.{crt,key}
```

> **Container UIDs and key permissions.** The two containers that read
> `certs/dmz/` run as different non-root users:
>
> | Host | Container | User | UID |
> |------|-----------|------|-----|
> | DMZ host | `strata-dmz` | distroless `nonroot` | `65532` |
> | Internal host | `backend` | `strata` (created in the image) | `999` (typical) |
>
> The test-cert generator writes keys mode `0644` (world-readable)
> precisely so the same `certs/dmz/` directory works on both hosts.
> For **production**, when you replace the test material with your
> own operator-CA-issued certs, set ownership and mode appropriate
> to whichever container will read them on that host:
>
> ```bash
> # On the DMZ host
> sudo chown -R 65532:65532 ./certs/dmz
> sudo chmod 640 ./certs/dmz/*.key
>
> # On the internal host
> sudo chown -R 999:999 ./certs/dmz
> sudo chmod 640 ./certs/dmz/*.key
> ```
>
> If you skip this step the affected container crash-loops with
> `Permission denied (os error 13)` while reading `server.key` (DMZ
> host) or `client.key` (internal host).

For **production**, replace those files with material from your
operator-controlled CA. The link server cert MUST have a SAN matching
the DNS name the internal host will dial; the link client cert MUST
have `extendedKeyUsage = clientAuth`. The public cert (`public.crt`/
`public.key`) MUST chain to a CA browsers already trust.

> The compose overlay [docker-compose.dmz.yml](../docker-compose.dmz.yml)
> mounts `./certs/dmz` into both containers at `/certs`, so the
> directory name matters. Keep the files under `certs/dmz/` (not
> `certs/`); the top-level `certs/` directory is reserved for the
> frontend's nginx TLS material.

```
./certs/dmz/
├── ca.crt           # link-CA root (operator-issued, PRIVATE)
├── server.crt       # link server cert (presented by DMZ to internal)
├── server.key
├── client.crt       # link client cert (presented by internal to DMZ)
├── client.key
├── public.crt       # public TLS cert (browser-facing)
└── public.key
```

### A.2  Populate `.env.dmz`

```bash
cp scripts/dmz/sample.env.dmz .env.dmz
```

Edit `.env.dmz` and replace each `REPLACE_ME_*` placeholder with the
base64 value from the corresponding `openssl rand -base64 32`
invocation above. The full file at minimum must contain:

```env
STRATA_DMZ_OPERATOR_TOKEN=<base64>
STRATA_DMZ_LINK_PSKS=current:<base64>
STRATA_DMZ_LINK_PSK_CURRENT=<same base64>
STRATA_DMZ_EDGE_HMAC_KEY=<base64>
STRATA_DMZ_CLUSTER_ID=strata-cluster-prod
STRATA_DMZ_NODE_ID=dmz-1
DMZ_PUBLIC_PORT=8443
DMZ_LINK_PORT=8444
DMZ_OPERATOR_PORT=9444
```

Lock down the file: `chmod 600 .env.dmz`.

> **Important on this single-host setup:** the overlay relies on
> `STRATA_DMZ_LINK_PSK_CURRENT` (and the matching `current:` entry
> inside `STRATA_DMZ_LINK_PSKS`) being byte-identical — the DMZ side
> reads the comma-separated map, the backend side reads the
> per-id env var. They must hold the same base64 value.

> **Single-host dev only:** in production the DMZ runs on its own
> host, so `DMZ_PUBLIC_PORT=8443` is fine. If you bring the DMZ
> overlay up on the **same** host that already runs the regular
> Strata stack, the frontend's nginx (`HTTPS_PORT`, default `8443`)
> will already own that port. Set `DMZ_PUBLIC_PORT=7443` (or any
> free port) in `.env.dmz` to avoid the bind collision; the link and
> operator ports are unaffected.

### A.3  Bring up the DMZ stack

```bash
docker compose --env-file .env.dmz \
    -f docker-compose.yml \
    -f docker-compose.dmz.yml \
    up -d --build --force-recreate strata-dmz backend

docker compose ps strata-dmz backend
docker compose logs -f strata-dmz   # confirm "public listener up", "link listener up"
docker compose logs -f backend  | grep -iE 'link|dmz'
#    expect: "DMZ link authenticated", "h2 serve ready"
```

The DMZ container exposes three ports:

| Port  | Purpose | Reachability |
|-------|---------|--------------|
| 8443  | Public HTTPS (mapped to `${DMZ_PUBLIC_PORT}` on the host) | Internet (or CDN edge) |
| 8444  | Link listener (the internal node dials in here) | **Internal network only** |
| 9444  | Operator API (status, links, disconnect) | **Loopback or management VLAN only** |

Sanity-check that the link listener answers and the operator API
demands a token:

```bash
openssl s_client -connect localhost:8444 -showcerts </dev/null 2>/dev/null | head -3
curl -ks https://127.0.0.1:9444/status                                      # → 401
curl -ks https://127.0.0.1:9444/status -H "Authorization: Bearer $TOKEN"    # → 200, links_up:1
```

### A.4  Verify end-to-end

Replace `$TOKEN` with the value of `STRATA_DMZ_OPERATOR_TOKEN`:

```bash
curl -ks https://127.0.0.1:9444/status -H "Authorization: Bearer $TOKEN" | jq
# → {"links_up": 1, "links_total": 1, "node_id": "dmz-1", ...}
```

And hit the public surface (substituting `${DMZ_PUBLIC_PORT}` for `7443`/`8443`):

```bash
curl -ks https://localhost:${DMZ_PUBLIC_PORT}/api/health
# → 200 OK, served via the link tunnel
```

For a fully scripted dry-run on a single host, the repo ships:

```bash
./scripts/dmz/e2e-roundtrip.sh
```

which generates ephemeral certs, brings the stack up, polls
`links_up` until it reaches 1, asserts the public path responds 200,
and confirms the management API rejects unauthenticated requests.

---

## Walkthrough A.5 — Two-host bare-metal, API-only public exposure

> **For most production deployments, prefer
> [Walkthrough A.6](#walkthrough-a6--two-host-bare-metal-with-public-spa-recommended)
> instead.** A.5 is the right choice only if the SPA is hosted
> elsewhere (CDN, internal-only browser bookmarks, mobile app
> consuming the API, …). It exposes `/api/*` and `/ws` on the DMZ
> host but does not serve the SPA.

For a real production deployment, the DMZ runs on a separate host
from the backend, with a one-way firewall rule between them. The
single-host overlay is **not** suitable here because it expects both
services on the same docker network. Use this walkthrough instead.

### A.5.1  On `dmz-host` — issue mTLS material

Identical to [A.1](#a1--issue-mtls-material). Place files under
`./certs/dmz/`:

```
./certs/dmz/
├── ca.crt           # link-CA root (operator-issued, distribute to internal host)
├── server.crt       # link server cert (presented by DMZ to internal)
├── server.key
├── client.crt       # link client cert (distribute to internal host)
├── client.key
├── public.crt       # PUBLIC-CA-signed cert for the API hostname
└── public.key
```

`public.crt` MUST chain to a CA that the API consumers trust
(browsers, mobile apps, downstream services). The `gen-test-certs.sh`
helper produces a self-signed `public.crt` suitable only for local
testing — replace it with a real cert before production.

### A.5.2  On `dmz-host` — bring up the DMZ-only stack

The repo ships [docker-compose.dmz-only.yml](../docker-compose.dmz-only.yml),
a thin overlay that runs **only** `strata-dmz` (no backend, no
frontend) on the DMZ host. Populate `.env.dmz` exactly as in
[A.2](#a2--populate-envdmz), then:

```bash
docker compose --env-file .env.dmz -f docker-compose.dmz-only.yml \
    up -d --build

docker compose -f docker-compose.dmz-only.yml ps
docker compose -f docker-compose.dmz-only.yml logs -f strata-dmz
# expect: "public listener up scheme=https", "DMZ link server listening"
```

The DMZ host now exposes:

| Port | Origin | Reachability |
|------|--------|--------------|
| `${DMZ_PUBLIC_PORT}` (default 8443) | strata-dmz public listener (public TLS cert) | **Internet** — API / WebSocket clients land here |
| 8444 | strata-dmz link listener | **Internal network only** — firewall: allow only `internal-host → dmz-host:8444/tcp` |
| 9444 | strata-dmz operator API | **Loopback only** by default |

### A.5.3  Distribute the link material to `internal-host`

Copy from `dmz-host` to `internal-host` over a secure channel
(e.g. `scp` over SSH between admin workstations, or a secret manager
that supports file payloads):

```
ca.crt          # link-CA root (the same file used by DMZ)
client.crt      # link client cert
client.key      # link client key
```

The link **PSK** and **edge HMAC key** are NEVER copied via the same
channel as the certs. Inject them into the internal host's secret
manager out-of-band so a single channel compromise cannot leak both
the cert chain and the PSK.

On the internal host, place the certs at `./certs/dmz/` (the path
[docker-compose.internal.yml](../docker-compose.internal.yml) mounts
into the backend container).

### A.5.4  On `internal-host` — wire the backend env

The backend auto-detects link-client mode whenever
`STRATA_DMZ_ENDPOINTS` is non-empty — there is no separate `_MODE`
switch. PSK and HMAC values are **base64**, matching what the DMZ
side reads from `STRATA_DMZ_LINK_PSKS` and `STRATA_DMZ_EDGE_HMAC_KEY`.

The stock [docker-compose.yml](../docker-compose.yml) does **not**
forward `STRATA_DMZ_*` env vars to the backend container. The repo
ships a ready-to-use site-local overlay,
[docker-compose.internal.yml](../docker-compose.internal.yml), that
appends the link env block and mounts the mTLS material. The overlay
keeps cert paths and node/cluster IDs at sensible defaults, so the
only values you need to set live in `.env`:

```env
STRATA_DMZ_ENDPOINTS=dmz-host.example.com:8444
STRATA_DMZ_LINK_PSK_CURRENT=<same base64 as DMZ's current: value>
STRATA_DMZ_EDGE_HMAC_KEYS=<same base64 as STRATA_DMZ_EDGE_HMAC_KEY>
# Must match the DMZ's STRATA_DMZ_CLUSTER_ID exactly:
STRATA_CLUSTER_ID=strata-cluster-prod
# Optional per-host override (defaults to "internal-1"):
# STRATA_NODE_ID=internal-1
```

All link/HMAC values are marked `?required` in the overlay, so
compose fails fast if any is missing.

> **Cluster ID must match.** If the DMZ runs with
> `STRATA_DMZ_CLUSTER_ID=strata-cluster-test` (the value baked into
> `sample.env.dmz`) but the backend dials with
> `STRATA_CLUSTER_ID=strata-cluster-prod` (the overlay default), the
> link handshake succeeds but the DMZ immediately drops the
> connection with `internal node advertised cluster_id "X", expected
> "Y"`. Set both to the same string before bringing up either side.

Restart the backend with both compose files applied:

```bash
docker compose -f docker-compose.yml -f docker-compose.internal.yml \
    up -d --force-recreate backend
docker compose logs -f backend | grep -iE 'link|dmz'
# expect: "DMZ link authenticated", "h2 serve ready"
```

> **Outbound firewall.** The internal host needs egress to
> `dmz-host:8444/tcp` only. No inbound rules are required from the
> DMZ network — that's the whole point of the split topology.

### A.5.5  Verify end-to-end

From `dmz-host`:

```bash
curl -ks https://127.0.0.1:9444/status -H "Authorization: Bearer $TOKEN" | jq
# → {"links_up": 1, "links_total": 1, "node_id": "dmz-1", ...}
```

From an external machine (substitute `${DMZ_PUBLIC_PORT}`, default `8443`):

```bash
curl -k https://strata.example.com:${DMZ_PUBLIC_PORT}/api/health
# → 200 OK, served via the link tunnel
```

---

## Walkthrough A.6 — Two-host bare-metal with public SPA (recommended)

This is the production pattern most operators want: the DMZ host
serves the **full Strata UI** to the public internet, transparently
proxying API and websocket traffic over the mTLS+PSK relay to a
backend on a private network. The backend never opens an inbound
public port.

```mermaid
flowchart TB
    Internet([Internet])
    Internet -->|"HTTPS :443"| Frontend
    subgraph DMZHost["DMZ host"]
        Frontend["frontend (nginx)<br/><sub>/      → SPA assets<br/>/api/* → proxy<br/>/ws    → proxy</sub>"]
        DMZ["strata-dmz<br/><sub>:8443 (private, proxy)<br/>:8444 (mTLS link listener)</sub>"]
        Frontend -->|"/api/* + /ws<br/>HTTPS over docker net"| DMZ
    end
    subgraph InternalHost["Internal host (no public IP)"]
        Backend["backend"]
        Backend --- Postgres["postgres"]
        Backend --- Guacd["guacd"]
        Backend --- Vault["vault"]
    end
    Backend -.->|"mTLS link<br/>:8444 (outbound only)"| DMZ
```

The DMZ host runs the standalone overlay
[docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml). The
internal host runs the regular [docker-compose.yml](../docker-compose.yml)
plus [docker-compose.internal.yml](../docker-compose.internal.yml)
(see [§A.6.5](#a65--on-internal-host--distribute-link-material-and-wire-the-backend) below).

### A.6.1  On `dmz-host` — issue mTLS material

Identical to [A.1](#a1--issue-mtls-material). Place files under
`./certs/dmz/`:

```
./certs/dmz/
├── ca.crt           # link-CA root
├── server.crt       # link cert (SAN: strata-dmz)
├── server.key
├── client.crt       # bundled here for distribution to internal host
├── client.key
└── (public.crt + public.key are unused in this topology — see below)
```

> **Why `public.crt` is unused here.** In topologies A and A.5 the
> strata-dmz public listener is the public face, so `public.crt`
> is a real public-CA-signed cert. In A.6 the public face is the
> frontend nginx (which gets its own LetsEncrypt-style cert under
> `./certs/public/`). The strata-dmz public listener is reached only
> over the docker-internal network by the frontend, so it can reuse
> `server.crt` (already SAN-valid for `strata-dmz` and signed by the
> DMZ CA the frontend trusts). The overlay sets this automatically.

### A.6.2  On `dmz-host` — provision the public TLS cert

Get a real public-CA-signed cert for the public hostname (e.g.
`strata.example.com`) and place the chain + key at:

```
./certs/public/
├── cert.pem    # full chain (leaf + intermediates)
└── key.pem     # private key
```

This is what users see in their browser.

### A.6.3  On `dmz-host` — populate `.env.dmz`

Same as [A.2](#a2--populate-envdmz). Generate `STRATA_DMZ_OPERATOR_TOKEN`,
`STRATA_DMZ_LINK_PSKS`, `STRATA_DMZ_EDGE_HMAC_KEY` (all base64) and
record them in `.env.dmz`.

### A.6.4  On `dmz-host` — bring up the edge stack

```bash
docker compose --env-file .env.dmz \
    -f docker-compose.dmz-edge.yml \
    up -d --build

docker compose -f docker-compose.dmz-edge.yml ps
docker compose -f docker-compose.dmz-edge.yml logs -f strata-dmz frontend
```

Expected:

- `strata-dmz`: `link listener up`, `public listener up`.
- `frontend`: nginx boots cleanly. The `ssl-init` step logs
  `Templating /api/ upstream: https://strata-dmz:8443` and
  `Wrote /etc/nginx/conf.d/api-proxy-ssl.conf`.

The DMZ host now exposes:

| Port | Origin | Reachability |
|------|--------|--------------|
| 443  | frontend (nginx, public TLS cert) | **Internet** — users land here |
| 8444 | strata-dmz link listener | **Internal network only** (firewall: allow `internal-host` → :8444) |
| 9444 | strata-dmz operator API | **Loopback only** (default) |

### A.6.5  On `internal-host` — distribute link material and wire the backend

Copy from `dmz-host` to `internal-host` over a secure channel:

```
ca.crt          # link-CA root
client.crt      # link client cert
client.key      # link client key
```

Place them at `./certs/dmz/` on the internal host. The link **PSK**
and **edge HMAC key** travel separately (secret manager, sealed
envelope, etc.) — never via the same channel as the certs.

The backend auto-detects link-client mode whenever
`STRATA_DMZ_ENDPOINTS` is non-empty — there is no separate `_MODE`
switch. PSK and HMAC values are **base64**, matching what the DMZ
side reads.

The repo ships [docker-compose.internal.yml](../docker-compose.internal.yml),
a thin overlay that appends the link env block and mounts the mTLS
material onto the existing `backend` service. The required values
in the internal host's `.env`:

```env
STRATA_DMZ_ENDPOINTS=dmz-host.example.com:8444
STRATA_DMZ_LINK_PSK_CURRENT=<same base64 as DMZ's current: value>
STRATA_DMZ_EDGE_HMAC_KEYS=<same base64 as STRATA_DMZ_EDGE_HMAC_KEY>
# Must match the DMZ's STRATA_DMZ_CLUSTER_ID exactly:
STRATA_CLUSTER_ID=strata-cluster-prod
# Optional per-host override (defaults to "internal-1"):
# STRATA_NODE_ID=internal-1
```

All link/HMAC values are marked `?required` in the overlay, so
compose fails fast if any is missing.

> **Cluster ID must match.** If the DMZ runs with
> `STRATA_DMZ_CLUSTER_ID=strata-cluster-test` but the backend dials
> with `STRATA_CLUSTER_ID=strata-cluster-prod`, the link handshake
> succeeds but the DMZ immediately drops the connection with
> `internal node advertised cluster_id "X", expected "Y"`.

Bring up the internal stack (note: **no** `frontend` container on
this host — the public-facing nginx lives on the DMZ host):

```bash
docker compose -f docker-compose.yml -f docker-compose.internal.yml \
    up -d --build

docker compose logs -f backend | grep -iE 'link|dmz'
# expect: "DMZ link authenticated", "h2 serve ready"
```

> **Outbound firewall.** The internal host needs egress to
> `dmz-host:8444/tcp` only. No inbound rules are required from the
> DMZ network — that's the whole point of the split topology.

### A.6.6  Verify end-to-end

From any browser on the public internet:

```
https://strata.example.com/
```

You should see the full Strata login UI. Authenticate, then exercise
RDP/SSH/VNC — every request flows public → frontend → strata-dmz →
link → backend. Confirm with:

```bash
# On dmz-host
docker compose -f docker-compose.dmz-edge.yml logs strata-dmz | grep -i 'authenticated'
# → "DMZ link authenticated peer=… node_id=internal-1"

curl -ks https://127.0.0.1:9444/status -H "Authorization: Bearer $TOKEN" | jq
# → {"links_up": 1, ...}
```

If `links_up` is `0`, the backend hasn't dialed in — check the
internal host's firewall rule (must allow outbound to
`dmz-host:8444`) and the internal host's backend logs for
`DMZ link authenticated`.

---

## Walkthrough A.7 — Split-brain (corporate LAN + public DMZ)

This walkthrough composes A.6 with a **second, independent front
door** running on the internal host. The same backend serves both
populations:

- **Corporate users** on the internal LAN reach a frontend nginx
  *also* running on the internal host. The request goes
  `corp-user → internal-frontend → backend:8080` — entirely on the
  corporate network, no DMZ hop.
- **Public users** off-LAN reach the DMZ host exactly as in A.6:
  `internet → dmz-frontend → strata-dmz → mTLS link → backend`.

Both paths terminate in the same axum router. The backend's
[`verify_edge_headers`](../backend/src/services/edge_header.rs)
middleware enforces the trust boundary cryptographically:

- Requests arriving over the **link** carry HMAC-stamped
  `x-strata-edge-*` headers; the middleware verifies them and
  attaches a `TrustedEdgeContext` so audit rows are tagged with
  the originating DMZ `link_id` and the real public client IP.
- Requests arriving on the **public listener** (port 8080) have no
  signed edge headers; if a malicious client tries to forge them
  the middleware strips them and the request runs as a normal
  direct connection. There's no way for a corp-LAN client to
  impersonate a DMZ-relayed request.

```mermaid
flowchart LR
    Corp([Corp user<br/>on LAN])
    Net([Internet user])

    subgraph InternalHost["Internal host (no public IP)"]
        IFE["frontend (nginx)<br/><sub>:443 — SPA assets<br/>/api/* + /ws → backend:8080</sub>"]
        BE["backend<br/><sub>:8080 (LAN-only listener)<br/>+ outbound mTLS link to DMZ</sub>"]
        PG[("postgres")]
        VA["vault"]
        GD["guacd"]
        IFE -->|"HTTP/HTTPS<br/>over docker net"| BE
        BE --- PG
        BE --- VA
        BE --- GD
    end

    subgraph DMZHost["DMZ host"]
        DFE["frontend (nginx)<br/><sub>:443 public — SPA assets<br/>/api/* + /ws → strata-dmz</sub>"]
        SDMZ["strata-dmz<br/><sub>:8443 internal proxy<br/>:8444 mTLS link listener</sub>"]
        DFE -->|"HTTPS / WS reverse-proxy<br/>(docker net)"| SDMZ
    end

    Corp -->|"corp DNS:<br/>strata.corp.example.com<br/>→ internal-host LAN IP"| IFE
    Net -->|"public DNS:<br/>strata.example.com<br/>→ dmz-host public IP"| DFE
    BE -.->|"outbound mTLS / WSS link<br/>(internal initiates,<br/>internal → DMZ:8444)"| SDMZ
```

> **Trust model invariant.** The two ingress paths land in the same
> axum router and share the **same** auth/CSRF/session/RBAC
> enforcement, the same database, the same Vault, the same guacd
> pool. There is exactly ONE enforcement point — the backend's
> middleware stack — regardless of which ingress a request arrived
> on. The `x-strata-edge-*` headers only **enrich** trusted
> requests with the public client IP and link provenance; they
> never grant additional privilege.

> **Pre-requisite.** A.7 layers on top of A.6, so you should be
> familiar with the cert/PSK/HMAC distribution from
> [§A.6.1](#a61--on-dmz-host--issue-mtls-material) before
> continuing. The internal host runs the **full** Strata stack
> (`docker-compose.yml`) plus the link overlay
> (`docker-compose.internal.yml`); the DMZ host runs the edge
> stack (`docker-compose.dmz-edge.yml`) exactly as in A.6.

### A.7.1  On `dmz-host` — bring up the edge stack

Follow [§A.6.1](#a61--on-dmz-host--issue-mtls-material) through
[§A.6.4](#a64--on-dmz-host--bring-up-the-edge-stack) verbatim. The
DMZ host's configuration is **identical** to A.6 — it doesn't know
or care that there will be a second frontend on the internal host.

By the end of A.6.4 you should have:

- `dmz-host:443` serving the SPA to the public internet
- `dmz-host:8444` listening for the mTLS link (closed to the public)
- `dmz-host:9444` operator API on loopback only

### A.7.2  On `internal-host` — distribute link material

Follow [§A.6.5](#a65--on-internal-host--distribute-link-material-and-wire-the-backend)
to copy `ca.crt`, `client.crt`, `client.key` into
`./certs/dmz/`, and to populate `.env` with:

```env
# Same values as A.6:
STRATA_DMZ_ENDPOINTS=dmz-host.example.com:8444
STRATA_DMZ_LINK_PSK_CURRENT=<same base64 as DMZ's current: value>
STRATA_DMZ_EDGE_HMAC_KEYS=<same base64 as STRATA_DMZ_EDGE_HMAC_KEY>
STRATA_CLUSTER_ID=strata-cluster-prod   # MUST match DMZ's STRATA_DMZ_CLUSTER_ID

# A.7-specific: both hostnames must be on STRATA_ALLOWED_ORIGINS so
# the backend's CSRF/CORS layer accepts SPA fetch requests from
# either origin.
STRATA_ALLOWED_ORIGINS=https://strata.example.com,https://strata.corp.example.com
```

Then drop the **internal-side** TLS material into `./certs/`
(separate from `./certs/dmz/`, which is the link mTLS bundle):

```text
./certs/
├── cert.pem        ← TLS cert for strata.corp.example.com (corp CA OK,
├── key.pem         ←  public CA not required — corp users never traverse
│                       the internet to reach this listener)
└── dmz/
    ├── ca.crt      ← link mTLS material from §A.6.5
    ├── client.crt
    └── client.key
```

The frontend nginx baked into [docker-compose.yml](../docker-compose.yml)
picks up `cert.pem` / `key.pem` automatically via the
`./certs:/etc/nginx/ssl:ro` mount.

### A.7.3  On `internal-host` — bring up the full stack

```bash
# Note: NO --env-file .env.dmz here. The internal host doesn't run
# strata-dmz, so the DMZ-only secrets (operator token, link PSKs as
# the *server* side) aren't needed. Only the link-CLIENT side is.

docker compose --env-file .env \
  -f docker-compose.yml \
  -f docker-compose.internal.yml \
  up -d --build
```

This brings up the **full** internal stack:

- `frontend` — nginx serving the SPA on `:443` to the corp LAN
- `backend` — axum router, public listener on `:8080` AND outbound
  mTLS link to the DMZ
- `postgres-local`, `vault`, `guacd` — unchanged from a
  non-DMZ deployment

> **What about [docker-compose.internal.yml](../docker-compose.internal.yml)?**
> That overlay only adds the `STRATA_DMZ_ENDPOINTS` block + cert
> mounts to the backend; it does NOT remove the public listener.
> When the link supervisor is enabled the backend runs **both**
> ingress paths concurrently — the public listener for the corp
> frontend and the link supervisor for DMZ-relayed traffic.

#### Custom host ports (both edges)

The two frontends are completely independent listeners with their
own port variables, so you can pin either or both to a non-default
port. They are usually only different when port 80/443 is already
in use on the host (a load balancer, another container, IIS, etc.)
or when the operator wants to deliberately publish on a non-well-
known port.

| Side | Variable | Default | Set in | Used by |
|------|----------|---------|--------|---------|
| Internal-host frontend (HTTPS) | `HTTPS_PORT` | `443` | `.env` | [docker-compose.yml](../docker-compose.yml) |
| Internal-host frontend (HTTP redirect) | `HTTP_PORT` | `80` | `.env` | [docker-compose.yml](../docker-compose.yml) |
| DMZ-host frontend (HTTPS) | `DMZ_EDGE_HTTPS_PORT` | `443` | `.env.dmz` | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) |
| DMZ-host frontend (HTTP redirect) | `DMZ_EDGE_HTTP_PORT` | `80` | `.env.dmz` | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) |
| DMZ-host link listener | `DMZ_LINK_PORT` | `8444` | `.env.dmz` | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) |
| DMZ-host operator API (loopback) | `DMZ_OPERATOR_PORT` | `9444` | `.env.dmz` | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) |

Example — internal frontend on `:8443`, public DMZ frontend on `:7443`:

```dotenv
# .env (internal host)
HTTPS_PORT=8443
HTTP_PORT=8080

# .env.dmz (DMZ host)
DMZ_EDGE_HTTPS_PORT=7443
DMZ_EDGE_HTTP_PORT=7080
DMZ_LINK_PORT=8444   # do NOT change unless you also update STRATA_DMZ_ENDPOINTS
```

If you change `DMZ_LINK_PORT` you must also update
`STRATA_DMZ_ENDPOINTS` on the internal host to match
(`dmz-host.example.com:<new port>`), otherwise the link supervisor
will keep dialing the old port and back off.

After changing any port, recreate the affected container(s):

```bash
# Internal host
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.internal.yml \
  up -d --force-recreate frontend

# DMZ host
docker compose --env-file .env.dmz \
  -f docker-compose.dmz-edge.yml \
  up -d --force-recreate frontend
```

Remember to update your firewall rules (see
[Firewall posture](#firewall-posture)) to match the new port
numbers. The `Internet → dmz-host:443` ALLOW rule becomes
`Internet → dmz-host:<DMZ_EDGE_HTTPS_PORT>` and so on.

### A.7.4  Configure split-horizon DNS (or two distinct hostnames)

Two equivalent options — pick one:

**Option A (recommended): two distinct hostnames.** Simpler to
reason about, simpler TLS cert management.

| Hostname | DNS view | Resolves to | TLS cert |
|---|---|---|---|
| `strata.corp.example.com` | corporate DNS only | `internal-host` LAN IP | corporate CA |
| `strata.example.com` | public DNS only | `dmz-host` public IP | public CA (Let's Encrypt etc.) |

**Option B: split-horizon DNS, one hostname.** A single
`strata.example.com` resolves differently depending on the
resolver. Requires the same cert chain to validate from both
networks (or different certs served by SNI on the matching IP).

| DNS view | `strata.example.com` resolves to |
|---|---|
| Corporate | `internal-host` LAN IP |
| Public internet | `dmz-host` public IP |

If your enterprise already runs split-horizon DNS for other
services, this is friction-free. If not, Option A is less work.

### A.7.5  Verify both ingress paths

**From a corp-LAN workstation:**

```
https://strata.corp.example.com/
```

You should see the SPA. After login, run any session — it should
work with sub-millisecond LAN latency. Confirm in the audit log
that the row has **no** `link_id` (it's a direct request):

```sql
SELECT actor, action, link_id, source_ip, created_at
FROM audit_logs
ORDER BY created_at DESC
LIMIT 5;
```

The `link_id` column should be `NULL` for the corp-LAN request,
and `source_ip` should be the corp workstation's LAN address.

**From a public workstation (or your phone on cellular):**

```
https://strata.example.com/
```

You should see the same SPA. After login, the audit log row will
have:

- `link_id` = the DMZ's link UUID (visible in `Admin → DMZ Links`)
- `source_ip` = the public client's real IP (extracted from the
  HMAC-stamped edge header, not the docker network's NAT address)

This is the proof that the trust model is working: corp traffic
runs as a normal direct request; public traffic is enriched with
verified provenance from the DMZ.

### A.7.6  Firewall posture

A.7 is the strictest of the four topologies because there are now
two front doors:

| Source | Destination | Port | Action | Why |
|---|---|---|---|---|
| Corp LAN | `internal-host:443` | 443/tcp | ALLOW | Corp users reach the internal SPA |
| Internet | `internal-host:*` | * | **DENY** | Internal host MUST NOT be reachable from the internet |
| Internet | `dmz-host:443` | 443/tcp | ALLOW | Public users reach the DMZ SPA |
| Internet | `dmz-host:8444` | 8444/tcp | **DENY** | Link listener is for the internal host only |
| Internet | `dmz-host:9444` | 9444/tcp | **DENY** | Operator API is loopback-only |
| `internal-host` | `dmz-host:8444` | 8444/tcp | ALLOW | Backend dials out to establish the link |
| `dmz-host` | corp LAN | * | **DENY** | DMZ MUST NOT initiate connections into corp |

The two critical rules are `Internet → internal-host: DENY` (which
keeps the corp frontend off the public internet) and
`dmz-host → corp: DENY` (which preserves the security guarantee
that a compromised DMZ cannot reach Vault / DB / AD).

### A.7.7  When NOT to use A.7

A.7 doubles the operational surface (two nginxes, two TLS certs,
two firewall rule sets, two ingress paths to monitor). Don't pick
it unless you actually need:

- **Latency-sensitive corp use** — e.g. interactive RDP/SSH
  sessions where the extra ~5–20 ms of the corp → DMZ → backend
  hop is disruptive. For typical web-app traffic A.6 is fine.
- **Corp-only emergency access** — if your public DNS is broken,
  your CDN is down, or your DMZ host is rebooting, corp staff
  retain access via the internal frontend. (A.6 has a single
  point of failure at the DMZ host.)
- **Tight IDS/firewall on outbound corp traffic** — if your
  corporate egress filter blocks staff from reaching the
  *public* hostname (because it leaves and re-enters the
  perimeter), an internal hostname avoids the loop.

If none of those apply, run A.6 and have corp users hit
`strata.example.com` like everyone else. The operational
simplicity is worth it.

---

## Walkthrough B — Kubernetes (Helm chart)

This walkthrough provisions the DMZ side of the split using the
reference chart at [`deploy/helm/strata-dmz/`](../deploy/helm/strata-dmz/).
The internal `strata-backend` release uses the existing chart
unchanged plus the `STRATA_DMZ_*` env vars from §B.7.

### B.1  Pre-flight

```bash
kubectl create namespace strata-dmz
kubectl create namespace strata-internal     # only if not already present

helm version          # 3.x required
kubectl get nodes     # confirm cluster reachable
```

If you intend to use a Prometheus-Operator `ServiceMonitor`, confirm
the CRD is installed:

```bash
kubectl get crd servicemonitors.monitoring.coreos.com
```

### B.2  Load the three shared secrets into Kubernetes

For evaluation, an inline `Secret`. For production prefer
[external-secrets](https://external-secrets.io/),
[sealed-secrets](https://github.com/bitnami-labs/sealed-secrets),
or a `vault-injector` annotation flow.

```bash
kubectl -n strata-dmz create secret generic strata-dmz-secrets \
    --from-literal=operatorToken="$(openssl rand -base64 32)" \
    --from-literal=linkPsks="current:$(openssl rand -base64 32)" \
    --from-literal=edgeHmacKey="$(openssl rand -base64 32)"
```

Capture the values for the internal release. Note that
`linkPsks` is a comma-separated `id:base64` map; the internal side
needs the bare base64 portion (without the `current:` prefix), and
the edge HMAC key passes through unchanged:

```bash
PSK=$(kubectl -n strata-dmz get secret strata-dmz-secrets \
        -o jsonpath='{.data.linkPsks}' | base64 -d | sed 's/^current://')
HMAC=$(kubectl -n strata-dmz get secret strata-dmz-secrets \
        -o jsonpath='{.data.edgeHmacKey}' | base64 -d)

kubectl -n strata-internal create secret generic strata-link-secrets \
    --from-literal=psk="$PSK" \
    --from-literal=edgeHmacKeys="$HMAC"
```

### B.3  Load the link mTLS material

Issue `server.crt`/`server.key`/`ca.crt` from your operator CA (SAN =
the in-cluster Service DNS or the external link DNS — whichever the
internal-cluster client will use).

```bash
kubectl -n strata-dmz create secret generic strata-dmz-link-tls \
    --from-file=server.crt --from-file=server.key --from-file=ca.crt
```

The internal release needs the matching client material:

```bash
kubectl -n strata-internal create secret generic strata-link-mtls \
    --from-file=ca.crt --from-file=client.crt --from-file=client.key
```

### B.4  Load the public TLS certificate

Cert-manager (recommended):

```yaml
# cert-manager-issued; the chart picks up the resulting Secret by name
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: strata-dmz-public-tls
  namespace: strata-dmz
spec:
  secretName: strata-dmz-public-tls
  dnsNames: [strata.example.com]
  issuerRef: { name: letsencrypt-prod, kind: ClusterIssuer }
```

Or a manual TLS Secret:

```bash
kubectl -n strata-dmz create secret tls strata-dmz-public-tls \
    --cert=public.crt --key=public.key
```

### B.5  Tune `values.yaml` for your cluster

Two settings you almost always need to override:

```yaml
# values-prod.yaml
config:
  nodeId: dmz-1
  clusterId: strata-cluster-prod
  # If your ingress controller sits in front and you trust its XFF:
  trustForwardedFrom:
    - 10.0.0.0/8

ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: HTTPS
  hosts:
    - host: strata.example.com
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - hosts: [strata.example.com]
      secretName: strata-dmz-public-tls

networkPolicy:
  enabled: true
  ingressControllerNamespace: ingress-nginx
  ingressControllerSelector:
    matchLabels:
      app.kubernetes.io/name: ingress-nginx
  internalBackendSelector:
    matchLabels:
      # MUST match the labels on your strata-backend pods.
      app.kubernetes.io/name: strata-backend
      app.kubernetes.io/instance: strata
  operatorClientSelector:
    matchLabels:
      strata.io/dmz-operator: "true"
```

> **Critical:** the default `internalBackendSelector` will not match
> if your backend release prefixes pod labels. Run `kubectl get pods
> -n strata-internal --show-labels` and copy the labels verbatim — if
> the NetworkPolicy doesn't match, the internal node cannot dial the
> link.

### B.6  Install the chart

```bash
helm install strata-dmz ./deploy/helm/strata-dmz \
    -n strata-dmz \
    -f values-prod.yaml \
    --set image.tag=1.4.1
```

Watch the rollout:

```bash
kubectl -n strata-dmz rollout status deploy/strata-dmz
kubectl -n strata-dmz logs -l app.kubernetes.io/name=strata-dmz -f
```

Confirm the operator API is locked down:

```bash
kubectl -n strata-dmz port-forward svc/strata-dmz-operator 9444:9444 &
TOKEN=$(kubectl -n strata-dmz get secret strata-dmz-secrets \
            -o jsonpath='{.data.operatorToken}' | base64 -d)
curl -ks https://127.0.0.1:9444/status                                       # → 401
curl -ks https://127.0.0.1:9444/status -H "Authorization: Bearer $TOKEN"     # → 200, links_up:0
```

### B.7  Wire the internal release to the DMZ

In your existing `strata-backend` Helm release, add to its values.
The backend auto-detects link-client mode whenever
`STRATA_DMZ_ENDPOINTS` is non-empty — there is no separate `_MODE`
switch. PSK and HMAC values are **base64** and must match the DMZ
side byte-for-byte.

```yaml
extraEnv:
  - name: STRATA_DMZ_ENDPOINTS
    value: strata-dmz.strata-dmz.svc.cluster.local:8444   # if same cluster
    # …or the externally-resolvable DMZ DNS if cross-cluster
  - name: STRATA_DMZ_LINK_CA
    value: /link/ca.crt
  - name: STRATA_DMZ_LINK_TLS_CLIENT_CERT
    value: /link/client.crt
  - name: STRATA_DMZ_LINK_TLS_CLIENT_KEY
    value: /link/client.key
  # One env var per PSK id advertised by the DMZ side. To accept
  # the DMZ's `current:` PSK, set STRATA_DMZ_LINK_PSK_CURRENT.
  # During rotation, also set STRATA_DMZ_LINK_PSK_PREVIOUS, etc.
  - name: STRATA_DMZ_LINK_PSK_CURRENT
    valueFrom:
      secretKeyRef: { name: strata-link-secrets, key: psk }
  - name: STRATA_DMZ_EDGE_HMAC_KEYS
    valueFrom:
      secretKeyRef: { name: strata-link-secrets, key: edgeHmacKeys }
  - name: STRATA_NODE_ID
    value: internal-1
  - name: STRATA_CLUSTER_ID
    value: strata-cluster-prod

extraVolumes:
  - name: link-mtls
    secret: { secretName: strata-link-mtls }
extraVolumeMounts:
  - { name: link-mtls, mountPath: /link, readOnly: true }
```

Apply the upgrade:

```bash
helm upgrade strata strata-backend -n strata-internal -f values-internal.yaml
kubectl -n strata-internal rollout status deploy/strata
kubectl -n strata-internal logs -l app.kubernetes.io/name=strata-backend -f \
    | grep -i "link\|dmz"
# expect: "DMZ link authenticated", per-endpoint "h2 serve ready"
```

### B.8  Verify end-to-end

```bash
# Re-fetch /status — links_up should now be 1 (or N for HA).
curl -ks https://127.0.0.1:9444/status -H "Authorization: Bearer $TOKEN" | jq

# Public health-check via the ingress.
curl https://strata.example.com/api/health   # → 200 OK
```

Import the dashboard at
[`docs/grafana/strata-dmz-dashboard.json`](grafana/strata-dmz-dashboard.json)
into Grafana to track `strata_dmz_links_up`, request rate, p95
latency, and reconnect counts.

### B.9  Upgrades & rollbacks

The DMZ is stateless and replicated; `helm upgrade` performs a rolling
restart honouring the `PodDisruptionBudget` (default `minAvailable: 1`).
Open links migrate to surviving replicas within the supervisor backoff
window (≤ 30 s with default settings). To roll back:

```bash
helm history strata-dmz -n strata-dmz
helm rollback strata-dmz <REV> -n strata-dmz
```

### B.10  Uninstall

```bash
helm uninstall strata-dmz -n strata-dmz
# Secrets are intentionally NOT removed by uninstall:
kubectl -n strata-dmz delete secret strata-dmz-secrets strata-dmz-link-tls strata-dmz-public-tls
```

---

## Firewall posture

The DMZ split is only as strong as the firewall rules that enforce it.
Recommended (rule set varies slightly by topology — the table below
covers all four):

| Source | Destination | Port | Action | A | A.5 | A.6 | A.7 |
|--------|-------------|------|--------|---|-----|-----|-----|
| Internet | `dmz-host:443` | 443/tcp | ALLOW | — | — | ✅ | ✅ |
| Internet | `dmz-host:${DMZ_PUBLIC_PORT}` (default 8443) | 8443/tcp | ALLOW | ✅ (eval) | ✅ | — | — |
| Corp LAN | `internal-host:443` | 443/tcp | ALLOW | — | — | — | ✅ |
| Internet | `internal-host:*` | * | **DENY** | — | ✅ | ✅ | ✅ |
| `internal-host` | `dmz-host:8444` | 8444/tcp | ALLOW | — | ✅ | ✅ | ✅ |
| `dmz-host` | anywhere on the internal network | * | **DENY** | — | ✅ | ✅ | ✅ |
| Internet | `dmz-host:8444` | 8444/tcp | **DENY** | ✅ | ✅ | ✅ | ✅ |
| Internet | `dmz-host:9444` | 9444/tcp | **DENY** | ✅ | ✅ | ✅ | ✅ |

The `dmz-host → internal *` deny rule is the heart of the design — it
is what makes a full RCE on the DMZ unable to reach Vault / DB / AD.
It does not apply to single-host eval (Walkthrough A) because there
is only one host. A.7 additionally requires
`Internet → internal-host: DENY` so the corporate frontend cannot be
reached directly from the public internet.

## Production checklist

- [ ] Three secrets generated independently with `openssl rand -base64 32`
      (operator token, link PSK, edge HMAC key) — none reused, none
      stored in the same file.
- [ ] mTLS material issued by your operator-controlled CA (not the
      test-cert script). Server cert SAN includes the DMZ DNS name;
      client cert has `extendedKeyUsage=clientAuth`.
- [ ] Public TLS cert is issued by a publicly-trusted CA (Let's
      Encrypt, your enterprise CA — whatever browsers will trust).
- [ ] Firewall rules above are in place AND tested with `nc -vz` from
      the wrong source.
- [ ] Operator API (`9444`) bound to loopback or a private management
      VLAN — never to a public interface.
- [ ] Grafana dashboard imported from
      [`docs/grafana/strata-dmz-dashboard.json`](grafana/strata-dmz-dashboard.json)
      and pointed at your Prometheus.
- [ ] Runbook reviewed by on-call:
      [`docs/runbooks/dmz-incident.md`](runbooks/dmz-incident.md).
- [ ] Cert expiry monitored (see the certificate-rotation runbook).

---

## Backup & Restore

### Database

```bash
# Backup (bundled container)
docker compose exec postgres-local pg_dump -U strata strata > backup.sql

# Restore
docker compose exec -i postgres-local psql -U strata strata < backup.sql
```

### Session Recordings

Recordings are stored in the `guac-recordings` Docker volume by default. You can optionally sync them to **Azure Blob Storage** for durable external storage.

#### Local Storage (default)

```bash
# Backup
docker run --rm -v strata-client_guac-recordings:/data -v $(pwd):/backup \
  alpine tar czf /backup/recordings.tar.gz -C /data .
```

#### Azure Blob Storage

Configure via **Admin → Recordings** in the web UI:

| Setting | Description |
|---|---|
| **Storage Backend** | Select "Azure Blob Storage" |
| **Account Name** | Your Azure Storage account name |
| **Container Name** | Blob container for recordings (default: `recordings`) |
| **Access Key** | Base64-encoded storage account access key |

Once configured, a background task syncs completed recording files to Azure Blob every 60 seconds. Recordings are always written locally first (guacd requirement), then uploaded. The download endpoint checks local storage first and falls back to Azure Blob, so recordings remain accessible even after local cleanup.

> **Note:** The backend container must have outbound HTTPS access to `<account>.blob.core.windows.net`. Ensure your Docker network or firewall allows this.

### Configuration

The `config.toml` file is stored in the `backend-config` Docker volume. Back it up alongside database backups.

---

## Health Monitoring

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Returns `{"status":"ok"}` if the backend is running |
| `GET /api/status` | Returns boot phase, database connectivity, and vault configuration status |
| `GET /api/admin/health` | Returns detailed health for database, guacd, and vault (including mode) |

Docker health checks are configured for `guacd` (TCP 4822), `postgres-local` (`pg_isready`), and `vault` (sys/health endpoint).

---

## Browser Requirements

Strata Client works in any modern browser (Chrome, Edge, Firefox, Safari). Some features require specific browser capabilities:

### Multi-Monitor

| Requirement | Details |
|---|---|
| **Browser** | Chromium 100+ (Chrome, Edge, Brave, Opera). Firefox and Safari do not support the Window Management API. |
| **Permission** | The browser prompts for "Window Management" permission on first use. Grant it to allow screen detection. |
| **Popups** | When using **3 or more screens**, Chrome's popup blocker may block the additional windows on the first attempt. Click the blocked-popup icon in the address bar and select "Always allow pop-ups from this site", then retry. This is a one-time setting per origin. |
| **Brave / Privacy browsers** | Supported — screen dimensions automatically fall back to `window.screen` values when the Window Management API returns zeroed coordinates. |
| **Screen detection** | The multi-monitor button tooltip shows the number of detected screens in real time (e.g. "Multi-monitor (3 screens detected)"). Plugging in or removing a monitor updates the count automatically via the `screenschange` event. |

### Quick Share

| Requirement | Details |
|---|---|
| **File size** | Up to 500 MB per file, 20 files per session. Both the nginx reverse proxy and Axum backend enforce this limit. |
| **Upload timeout** | Large uploads have up to 300 seconds (5 minutes) before the nginx proxy times out the request body transfer. |

### Clipboard

Clipboard synchronisation requires the [Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API), supported in all modern browsers. HTTPS (or localhost) is required for clipboard read access in most browsers.

---

## User Guide

### Connecting to a Single Session

1. From the **Dashboard**, find the connection you want to open
2. Click **Connect** on the connection row
3. If Vault-stored credentials exist, the session opens immediately
4. If no credentials are stored (RDP), a credential prompt appears — enter the username and password for the remote host, then click **Connect**
5. For SSH connections without stored credentials, the session connects and `guacd` may issue an interactive credential prompt inside the session

### Tiled Multi-Session View

The tiled view lets you open multiple connections side-by-side in a responsive grid layout.

#### Opening a Tiled View

1. From the **Dashboard**, use the checkboxes in the leftmost column to select two or more connections
2. The **Open Tiled (N)** button appears in the toolbar — click it
3. If any selected RDP connections lack Vault-stored credentials, a credential dialog appears:
   - Enter the username and password for each connection that requires them
   - Click **Connect All** to open all sessions at once
4. Connections with Vault-stored credentials connect automatically without prompting

#### Working in Tiled View

- **Focus a tile** — Click on a tile to focus it (highlighted with an accent border). Keyboard input is sent only to focused tiles.
- **Multi-focus** — Hold `Ctrl` (or `Cmd` on macOS) and click additional tiles to focus multiple sessions at once. Keyboard input is broadcast to all focused tiles simultaneously.
- **Close a tile** — Click the `×` button in the tile's title bar to disconnect that session.
- **Exit tiled view** — Close all tiles or click the exit button in the session bar at the bottom of the screen to return to the Dashboard.

#### Keyboard Behavior

When one or more tiles are focused, keyboard input is captured and forwarded to the remote sessions. Developer tools shortcuts (`F12`, `Ctrl+Shift+I/J`) are always passed through to the browser.

### Credential Vault

Each user can store encrypted credentials per connection for automatic authentication:

1. From the **Dashboard**, click **Update** on a connection row
2. Enter the password and click **Save (Vault Encrypted)**
3. Future connections to this host will authenticate automatically using the stored credential

Stored credentials use envelope encryption (AES-256-GCM + Vault Transit). See [security.md](security.md) for details.

### Session Bar

The session bar at the bottom of the screen shows thumbnails of all active sessions. Click a thumbnail to switch to that session. In tiled mode, the bar shows a **Tiled (N)** indicator.

### Clipboard

Clipboard synchronisation between your local machine and the remote session is automatic:

- **Copy from remote → local** — Text copied inside the remote desktop is automatically available in your local clipboard when you hover over or focus the session view.
- **Copy from local → remote** — Text on your local clipboard is pushed to the remote session when the session view gains focus (click into the session or mouse over it).

No manual action is required. Clipboard sync works with both RDP and SSH sessions.

### File Transfer

There are three ways to transfer files to and from a remote session:

#### Drag and Drop

Drag files from your desktop directly onto the session view to upload them to the remote filesystem. Dropped files are written to the root of the default virtual drive.

#### File Browser

When a session has a virtual filesystem available (RDP drive or SFTP), a **folder icon** button appears in a floating toolbar at the top-right corner of the session view.

1. Click the **folder icon** to open the file browser panel on the right side of the session
2. Navigate directories by double-clicking folder entries
3. Use the breadcrumb trail to navigate back up
4. **Download** — Double-click a file entry to download it
5. Click **Upload Files** to select files from your local machine
6. Upload progress is displayed inline
7. Close the file browser by clicking the **×** button in the panel header

#### RDP Virtual Drive

RDP connections automatically mount a shared virtual drive on the remote host. Inside the remote desktop session, the drive appears as a mapped network drive (typically named **Guacamole**). You can copy files to and from it using the remote file explorer just like any network share.

> **Note:** Virtual drive support requires the `enable-drive` parameter to be active on the connection. This is enabled by default for all RDP connections.

### Connection Sharing

You can share a live session with another user by generating a temporary read-only share link:

1. While connected to a session, locate the floating toolbar at the **top-right** corner of the session view
2. Click the **share icon** (three connected dots)
3. A share link is generated and displayed in a popover
4. Click the **copy** button to copy the link to your clipboard
5. Send the link to the person you want to share with — they do not need to be logged in

**Important notes:**

- Share links provide **read-only** access — the viewer can see your session but cannot interact with it
- The share link **expires automatically** when you disconnect from the session
- Each click of the share button generates a new share link
- Viewers see a banner at the top of the screen indicating that they are in read-only mode

### Command Palette (Quick Launch)

Press **Ctrl+K** while connected to any session to open the command palette — an instant search overlay for finding and launching connections without leaving the current session.

| Feature | Details |
|---|---|
| **Open** | `Ctrl+K` (also works from pop-out and multi-monitor windows) |
| **Search** | Filters connections by name, protocol, hostname, description, or folder |
| **Navigate** | `↑` / `↓` arrow keys to move, `Enter` to launch, `Esc` to close |
| **Active badge** | Connections you're already connected to show a green "Active" badge |
| **Mouse** | Click any result to launch it directly |

The command palette fetches your available connections from the server each time it opens, so newly added connections appear immediately.

### Keyboard Shortcuts

When connected to a remote session, the following keyboard shortcuts are available:

| Shortcut | Action | Notes |
|---|---|---|
| `Right Ctrl` (tap) | Send Win key (open Start menu) | Right Ctrl is remapped to Super/Win for the remote session |
| `Right Ctrl + key` | Send Win+key combo | e.g. `Right Ctrl + E` → Win+E (File Explorer) |
| `Ctrl+Alt+\`` | Send Win+Tab (Task View) | The only reliable browser-level proxy — Windows intercepts `Ctrl+Alt+Tab` |
| `Ctrl+K` | Open Command Palette | Search and launch connections from keyboard |
| `F12` | Browser DevTools | Passed through to the browser (not sent to remote) |
| `Ctrl+Shift+I/J` | Browser DevTools | Passed through to the browser (not sent to remote) |

#### Keyboard Lock (Fullscreen + HTTPS)

When a session is in **fullscreen mode** and accessed over **HTTPS**, the browser captures OS-level shortcuts directly via the [Keyboard Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock):

- **Win key** — captured and sent to the remote session
- **Alt+Tab** — captured and sent to the remote session
- **Escape** — captured and sent to the remote session

This eliminates the need for proxy shortcuts like Right Ctrl or Ctrl+Alt+\`. Keyboard Lock requires a secure context (HTTPS or localhost) and is supported in Chromium-based browsers.

> **Note:** Keyboard Lock does not work over HTTP. In that case, use the Right Ctrl and Ctrl+Alt+\` proxy shortcuts described above.

### Display Tags

Users can optionally pin a single tag per connection to show as a colored badge on session thumbnails in the Active Sessions sidebar.

| Feature | Details |
|---|---|
| **Assign** | Click the tag icon (top-left of any session thumbnail) to open the tag picker |
| **Choose** | Select from your existing user tags — each shown with its color swatch |
| **Clear** | Select "None" to remove the display tag from that connection |
| **Per-user** | Each user's display tag choices are independent — your assignments don't affect other users |
| **Persistent** | Display tags are stored on the server and persist across sessions and devices |

Display tags use your existing user tags (created from the Dashboard tag manager). If you haven't created any tags yet, the picker will show "No tags created yet."

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Setup wizard keeps appearing | `config.toml` not persisted | Check `backend-config` volume is mounted |
| 503 on all API calls | Backend in setup mode | Complete the first-boot wizard |
| 401 on authenticated routes | SSO not configured | Configure OIDC in Admin → SSO |
| Vault errors on credential save | Vault unreachable or key missing | Verify Vault URL, token, and transit key |
| Sessions drop on guacd restart | Expected — guacd is stateful | Schedule restarts during maintenance |
| Database migration race | Multiple backends starting | Advisory locks handle this automatically |
