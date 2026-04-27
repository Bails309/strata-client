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
