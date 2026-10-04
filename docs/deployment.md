# Deployment Guide

## Prerequisites

- Docker ≥ 24.0 and Docker Compose ≥ 2.20
- (Optional) A HashiCorp Vault instance with Transit Secrets Engine enabled
- (Optional) A Keycloak or other OIDC provider for SSO
- (Optional) An external PostgreSQL 14+ instance

## System Requirements

### Minimum (up to 5 concurrent sessions)

| Resource | Spec                                          |
| -------- | --------------------------------------------- |
| CPU      | 2 vCPUs                                       |
| RAM      | 4 GB                                          |
| Disk     | 20 GB (OS + Docker images + database)         |
| Network  | 10 Mbps per concurrent RDP session            |
| OS       | Any Docker-supported Linux, Windows, or macOS |

### Recommended (10–25 concurrent sessions)

| Resource | Spec                                                              |
| -------- | ----------------------------------------------------------------- |
| CPU      | 4 vCPUs                                                           |
| RAM      | 8 GB                                                              |
| Disk     | 50 GB SSD (faster database queries and recording I/O)             |
| Network  | 100 Mbps+                                                         |
| OS       | Linux (Debian/Ubuntu or Alpine-based) for best Docker performance |

### Large Scale (25+ concurrent sessions)

| Resource | Spec        |
| -------- | ----------- |
| CPU      | 8+ vCPUs    |
| RAM      | 16+ GB      |
| Disk     | 100+ GB SSD |
| Network  | 1 Gbps      |

For large deployments, consider:

- **Horizontal scaling** — run additional backend instances behind the gateway. Since v2.0.0 sessions are served in-process, so scaling the backend scales the session tier; there is no separate daemon pool to size. See [High Availability](#high-availability).
- **External PostgreSQL** — managed database with connection pooling
- **Session recordings** — allocate additional disk proportional to session count and retention period (~50–200 MB/hour per session depending on activity)

### Resource Breakdown by Container

| Container        | CPU        | RAM        | Notes                                                                  |
| ---------------- | ---------- | ---------- | ---------------------------------------------------------------------- |
| `backend`        | Medium     | See below  | Serves every session in-process; NVR buffers add ~50 MB per active session |
| `frontend`       | Minimal    | 30 MB      | Static file serving + reverse proxy via nginx                          |
| `postgres-local` | Low–Medium | 200–500 MB | Depends on audit log volume                                            |
| `vault`          | Minimal    | 50 MB      | Transit encrypt/decrypt only                                           |

> **Sizing a session (v2.0.0+).** A session costs **two 1920×1080 framebuffers
> at 4 bytes per pixel plus about 8 MB of channel and encoder state — roughly
> 24 MB** — rather than a process carrying FreeRDP, cairo surfaces and a worker
> thread per core. This figure is measured from what the engine allocates, not
> estimated, and the admin **Sessions** tab reports the host's capacity from it
> directly. SSH, VNC and Kubernetes sessions are lighter still: a terminal
> session holds a character grid, not a framebuffer.

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

### Image provenance (private registry)

> **Changed in v2.1.1.** Up to v2.1.0 a tag-triggered release workflow
> pushed the `backend` and `frontend` images to GitHub Container Registry,
> signed them keyless with Cosign, attached a CycloneDX SBOM attestation and
> SLSA Level 3 provenance, and `scripts/verify-image.sh` checked all three
> before rollout. The workflow, the script and the
> `docker-compose.ghcr.yml` overlay were removed in v2.1.1: images are now
> built from this repository and stored in a **private registry** only. No
> Strata image is published publicly.

Because nothing upstream signs the images any more, the integrity of what a
host runs rests on your own build and registry controls. At minimum:

1. **Build from a tagged commit** (`git checkout vX.Y.Z`) on a trusted build
   host or CI runner, and record the resulting digests:

   ```bash
   docker compose build backend frontend
   docker image inspect --format '{{index .RepoDigests 0}}' \
     registry.example.com/strata/backend:2.1.1
   ```

2. **Push to a registry that requires authentication** for both push and
   pull, with push rights limited to the build identity.
3. **Deploy by digest** (`image: registry.example.com/strata/backend@sha256:<digest>`)
   so a re-pushed tag cannot change what a host runs.
4. If your registry supports it, **sign on push** (Cosign with your own key
   or KMS, Notation, or the registry's native signing) and enforce
   verification at pull time. Strata does not ship keys or a verification
   script for this; use your registry's tooling.

The image-level CVE gate is unaffected: Trivy still scans the images CI
builds on every push (see
[security.md § Dependency & supply-chain security](security.md#dependency--supply-chain-security)).

### 1. Environment Configuration

Edit `.env` or set environment variables:

````bash
HTTP_PORT=80             # Nginx HTTP listener (host mapping)
HTTPS_PORT=443           # Nginx HTTPS listener (host mapping)
RUST_LOG=info            # Log level: trace, debug, info, warn, error

#### Mandatory JWT Secret (v1.8.3)

Since v1.8.3, you **must** provide a persistent `JWT_SECRET` in your `.env` file to ensure session stability across container restarts.

```bash
JWT_SECRET=your-random-32-character-secret-string
````

- **Why?** Without a persistent secret, the backend generates a random one on every startup. This invalidates all active user sessions (access and refresh tokens) whenever the backend container restarts, forcing all users to log in again.
- **Security:** Use a cryptographically strong random string. You can generate one using `openssl rand -base64 32`.
- **Note:** If you change this secret in the future, all existing sessions will be invalidated.

````

### 2. Build & run

For local evaluation or development:

```bash
docker compose up -d --build
````

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

| File                          | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `frontend/common.fragment`    | Shared routing rules, timeouts, compression, security headers            |
| `frontend/http_only.conf`     | HTTP-only server block (port 80)                                         |
| `frontend/https_enabled.conf` | HTTPS server block (port 443) + HTTP→HTTPS redirect                      |
| `frontend/ssl-init.sh`        | Entrypoint script that auto-selects HTTP or HTTPS based on cert presence |
| `docker-compose.yml`          | Frontend service definition, port mappings, cert volume                  |

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

| Goal                            | Command                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| RDP / SSH / VNC + web (default) | `docker compose up -d --build`                                                                    |
| Add bundled PostgreSQL          | `docker compose --profile local-db up -d --build`                                                 |
| Add antivirus scanning          | `docker compose --profile av up -d --build`                                                       |
| Add VDI                         | `docker compose -f docker-compose.yml -f docker-compose.vdi.yml up -d --build`                    |
| Everything                      | `docker compose -f docker-compose.yml -f docker-compose.vdi.yml --profile local-db up -d --build` |

`-f` flags select which compose files to merge (structural — for
VDI's host-root mount). `--profile` flags select which optional
services to start (local postgres, antivirus). The two are
independent.

> **Set `COMPOSE_PROFILES` in `.env` if you run any optional service.**
> A profile that is not active is invisible to Compose: its services are
> not started, not rebuilt, and not shown by `docker compose ps`. Crucially,
> `docker compose up -d --build` does **not** stop services outside the
> active set — so a profiled container carries on running its **old image**
> while everything else is upgraded, with no error and nothing in the diff
> to notice. On the `av` profile that means `clamav` carries on running an
> old image while the backend is upgraded, so a signature or fail-mode
> change appears not to have taken — a genuinely difficult thing to
> diagnose after the fact.
>
> Putting the profiles in `.env` removes the footgun permanently, because
> every later `ps`, `logs`, `down` and `up` sees the same set:
>
> ```bash
> COMPOSE_PROFILES=scale,av
> ```
>
> A bare `docker compose up -d --build` then rebuilds and recreates
> everything you actually run. Verify the full set resolves as expected
> with `docker compose config --services`, and list every profile the
> project defines with `docker compose config --profiles`.

TLS is terminated by the frontend nginx gateway using
the certificates mounted from `./certs/` — there is no separate
reverse-proxy service.

#### Using an External Reverse Proxy Instead

If you must use a different reverse proxy (e.g., Traefik, HAProxy, Caddy, or a cloud load balancer), you can modify `docker-compose.yml` to expose the backend and frontend ports directly. Key requirements for your proxy:

- Route `/api/*` to `backend:8080` with WebSocket upgrade support
- Route everything else to `frontend:80`
- Set `proxy_read_timeout` / `proxy_send_timeout` to at least 3600s for tunnel connections
- Forward `X-Forwarded-For`, `X-Forwarded-Proto`, and `Host` headers
- **Set `STRATA_TRUST_XFF=1` on the backend container** (v1.10.6+)
  **and list the proxy in `STRATA_TRUSTED_PROXIES`** (comma-separated
  CIDRs or IPs). `X-Forwarded-For` is honoured only when the socket peer
  is in that list; otherwise audit-log attribution and per-IP rate-limit
  buckets see every request as originating from the load-balancer IP.
  An invalid entry stops the backend from starting.

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

| Variable            | Description                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_SSL_MODE` | SSL mode for the connection. Overrides any `sslmode` query parameter in `DATABASE_URL`. Valid values: `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`. |
| `DATABASE_CA_CERT`  | Absolute path (inside the backend container) to a PEM-encoded CA certificate file. Required when `DATABASE_SSL_MODE` is `verify-ca` or `verify-full`.                      |

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
   - Issues a Transit-only runtime token, stores it and the unseal key in `vault-secrets.json`, and revokes the root token
3. On subsequent restarts, the backend auto-unseals using the stored key and renews its runtime token. For tasks that need root, see [Vault operations](runbooks/vault-operations.md#root-token-for-the-bundled-vault).

No manual Vault configuration is required. The bundled Vault uses file storage with a persistent Docker volume (`vault-data`).

The backend reaches it at `https://vault:8200`. The `vault-tls-init` service issues Vault's certificate from a private CA on first start and exits; Vault waits for it. The CA certificate is shared with the backend through the read-only `vault-ca` volume (`VAULT_CACERT=/etc/strata/vault-ca/ca.crt`). Existing installs move from `http://` to `https://` on the next `docker compose up`: the `VAULT_ADDR` the compose file sets replaces the address saved at setup. To issue a new CA, stop the stack and remove the `vault-tls` and `vault-ca` volumes; Vault's data is untouched.

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
4. **Add `https://strata.example.com/login` to _Valid Post Logout Redirect URIs_** (Keycloak ≥ 25.0; required for the RP-Initiated Logout flow introduced in v1.12.6 — without this entry, **Log out** ends the user's IdP session correctly but the post-logout redirect lands them on a Keycloak error page instead of the Strata Login screen). Auth0, Okta, and Entra ID have equivalent fields under different names (Auth0: **Allowed Logout URLs**; Okta: **Sign-out redirect URIs**; Entra ID: register the URL under **Redirect URIs** so `post_logout_redirect_uri` validation succeeds).
5. Navigate to **Admin → SSO / OIDC** and enter:
   - Issuer URL: `https://keycloak.example.com/realms/strata`
   - Client ID: from Keycloak
   - Client Secret: from Keycloak

### 6. Kerberos

If your target RDP hosts require Kerberos/NLA authentication:

1. Navigate to **Admin → Kerberos**
2. Add one or more Kerberos realms with KDCs, admin server, and ticket lifetime settings
3. Mark one realm as the default
4. Save — the backend generates `krb5.conf` aggregating all realms and writes it to the shared volume

The backend writes `krb5.conf` to the shared volume and reads it via `KRB5_CONFIG` at runtime. Multiple realms are supported for cross-forest or multi-domain environments.

### 7. DNS Configuration

If your target RDP/SSH hosts use internal DNS names (e.g. `.local`, `.dmz.local`, `.internal`) that the container's default resolver cannot resolve:

1. Navigate to **Admin → Network**
2. Enable **Custom DNS**
3. Enter one or more DNS server IP addresses (comma-separated), e.g. `10.0.0.1, 10.0.0.2`
4. Enter your DNS search domains (comma-separated), e.g. `example.local, corp.example.com`
5. Click **Save** — this takes effect on the **next session**. No restart.

**How it works (v2.0.0+).** The session engine resolves *target* hostnames
itself against the nameservers you configure, applying the search suffix to
short names. Strata's own infrastructure lookups — `postgres-local`, `vault`,
`clamav` — continue to use the container's resolver.

Only the network socket uses the resolved address. The **hostname** is still
what reaches TLS certificate verification and the Kerberos SPN, so
pre-resolving does not turn a name-based handshake into an address-based one;
NLA against Active Directory is unaffected.

A lookup that fails logs a warning and falls back to the system resolver rather
than refusing the session, so a mistyped nameserver degrades one hop instead of
taking every connection down.

> [!IMPORTANT]
> **Search domains are required for `.local` zones.** The `.local` TLD is special — without a search suffix, a bare hostname will not resolve against a `.local` domain. The search domain field is equivalent to the `Domains=` directive in `systemd-resolved` on your host OS. For example, with `example.local` as a search domain, a connection targeting `server01` resolves as `server01.example.local`.

> [!NOTE]
> **Changed in v2.0.0.** Before v2.0.0 these settings were written to a
> `resolv.conf` in a shared volume, which the `guacd` containers copied over
> their own at startup — so a change required restarting `guacd` and dropping
> every session on it. `guacd` is gone, and the backend cannot use the same
> trick: it reaches postgres, vault and clamav through Docker's embedded
> resolver at `127.0.0.11`, so replacing its `resolv.conf` would lose them, and
> *appending* your servers after `127.0.0.11` does not work either because glibc
> only advances to the next nameserver on timeout or SERVFAIL, never on the
> NXDOMAIN Docker returns for a name it does not know. Resolving in-process is
> what makes the setting both correct and restart-free.

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
   - **Connection Defaults** (RDP only) — connection parameters applied to all synced connections:
     - _Display & Performance_: ignore server certificate, enable wallpaper/font smoothing/desktop composition/theming/full-window drag/menu animations, disable bitmap/glyph/offscreen caching, disable GFX pipeline
     - _Session Recording_: recording path, recording name (supports `${GUAC_DATE}`, `${GUAC_TIME}`, `${GUAC_USERNAME}` tokens), auto-create recording path, include key events, exclude mouse/touch/graphical output
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

#### v2.3.3 → v2.3.4 (shared bind-account rotation, failing-sync banner, RDP resize)

Rebuild the backend and frontend images. **No migration, no `.env` change.**

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

| Change | Who notices |
| ------ | ----------- |
| Rotating an AD sync bind account updates every source that binds as it | Admins with two sources for one domain (e.g. RDP and SSH) and auto-rotation on one |
| Failing AD syncs flagged on **Fleet Manager** and **AD Sync** | Admins with `can_manage_system` |
| RDP sessions no longer drop while the window is resized | Everyone using RDP |

**Recovery for a source already broken by a rotation.** If one source fails
every sync with `invalid credentials` since auto-rotation ran on another
source for the same account, **Edit** the rotating source after upgrading and
click **Test Rotation & Capabilities** once. The account is rotated again and
the new password is stored on both sources; the banner clears at the next
successful sync.

**Verify post-upgrade:** the **What's New** modal shows the v2.3.4 card, and
**Admin → AD Sync** shows no failing-sync banner (or names the sources that
genuinely fail).

#### v2.3.2 → v2.3.3 (Rust 1.99, russh 0.64, dependency hygiene)

Rebuild the backend and frontend images, and the **DMZ edge** for DMZ
topologies so it is built with the same compiler. **No migration, no `.env`
change, no behaviour change.**

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

| Change | Who notices |
| ------ | ----------- |
| Builder images move to Rust 1.99 (`rust:1.99-slim-trixie`, `rust:1.99-bookworm`, pinned by digest) | Anyone building outside Docker needs Rust 1.99 |
| `russh` 0.64.0 in the SSH engine | Nobody directly; long SSH/SFTP sessions now rekey on the protocol's read and time limits |
| `lint-staged` 17 in the root workspace | Contributors: Node.js 22.22.1+ and a root `npm install` for the pre-commit hook |

**Verify post-upgrade:** the **What's New** modal shows the v2.3.3 card, and
an SSH and an SFTP session connect as before.

#### v2.3.1 → v2.3.2 (AD sync keeps approved host keys)

Rebuild the backend and frontend images. **No migration, no `.env`
change, no DMZ edge rebuild.**

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

| Change | What operators notice |
| ------ | --------------------- |
| AD sync keeps per-host trust pins | An SSH key approved through **Verify Host Keys**, an RDP certificate pin or an SFTP host key on a synced connection is no longer removed by the next sync; the **Unpinned** badge and *Security alerts* count stay down |
| Fewer rewrites | Synced connections that differ from the source's defaults only by a pin are no longer updated on every run, so the sync's *updated* count drops |

**Operator action:** connections a sync stripped before this upgrade keep
nothing to preserve. Run **Admin → Connections → Verify Host Keys**, approve
the keys again, and re-enter any RDP certificate pins, then run the sync once
to confirm they stay.

**Verify post-upgrade:**

1. The in-app **What's New** modal shows the v2.3.2 card.
2. Approve a host key on an AD-synced SSH connection, click **Sync AD /
   LDAP**, and confirm the connection does **not** return to **Unpinned**.

#### v2.3.0 → v2.3.1 (keyboard on Server Core, numeric keypad, paste shortcuts)

Rebuild the backend and frontend images. **No migration, no `.env`
change, no DMZ edge rebuild.**

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

**Behaviour that changes for users — tell them before you upgrade:**

| Change | What users notice | If it is unwanted |
| ------ | ----------------- | ----------------- |
| RDP characters are typed as key presses on the connection's keyboard layout | Typing works at PowerShell and other console prompts on Server Core. On a connection whose layout does not match the remote user's, symbols land on the wrong keys (`\` as `#`, `@` and `"` swapped) | Set the connection's **Keyboard layout** to the remote user's layout |
| A blank keyboard layout means **UK English** | Connections that never set one now type on the UK table (before: US positions plus Unicode) | Set the layout explicitly; AD sync sources have the same setting under connection defaults |
| *Failsafe (Unicode events)* unchanged | Still types every character as Unicode, which console prompts on Server 2019/2022 ignore | Choose the remote user's layout instead |
| Numeric keypad types in RDP and SSH | Keypad digits and decimal point work; the remote side is kept at Num Lock on | — (the old behaviour was a bug) |
| Caps Lock / Num Lock keys are not sent to RDP | The browser applies them; the remote lock-key indicators stay at Num Lock on, Caps Lock off | — |
| Ctrl+V and Shift+Insert wait for the clipboard | The keystroke reaches the session after the local clipboard has been sent, up to 1 s later | — |

**Operator actions:**

1. Review the keyboard layout on RDP connections and AD sync connection
   defaults whose remote users do not type on a UK layout.
2. Move connections used for console work off **Failsafe (Unicode events)**.
3. Recordings on a guacd-era volume: nothing to do. The entrypoint now owns
   the recordings directory; if the backend logs
   `[entrypoint] ERROR: /var/lib/guacamole/recordings is not writable by strata`,
   the volume is read-only or squashes ownership.
4. A database that previously failed to start with
   `relation "revoked_tokens" does not exist` starts normally after this
   upgrade.

**Verify post-upgrade:**

1. The in-app **What's New** modal shows the v2.3.1 card.
2. On a Server Core host, the PowerShell prompt accepts typed text.
3. Keypad digits type in an RDP and an SSH session.
4. Copy text locally, Alt+Tab to the browser and press Ctrl+V in a session
   without moving the mouse: the new text is pasted.
5. **Admin → Sessions** shows **native** in the Engine column for a session
   still in progress.

If typing misbehaves, follow
[runbooks/keyboard-input.md](runbooks/keyboard-input.md).

#### v2.2.0 → v2.3.0 (external security and performance review closed)

Rebuild both images, and the **DMZ edge** for DMZ topologies (the link now
streams bodies; both nodes must run v2.3.0). **Eleven migrations; one new
Compose service and three new volumes; no `.env` change is required for the
bundled stack**, but several operator actions below are.

```bash
cd strata-client
git pull
# Take a database backup first (see Backup & Restore).
docker compose build backend frontend
docker compose up -d
```

On the first start `vault-tls-init` issues the bundled Vault's private CA
and server certificate, Vault restarts on TLS, and the backend moves to
`https://vault:8200` and replaces its stored root token with a
Transit-only token. Nothing needs re-entering.

| Migration | Effect | Rollback impact |
| --------- | ------ | --------------- |
| `093_users_sso_issuer.sql` | Adds `users.sso_issuer`, binding a linked SSO subject to its issuer; existing links are bound on their next SSO sign-in | Additive |
| `094_users_sessions_valid_after.sql` | Adds `users.sessions_valid_after`; tokens issued earlier are refused | Additive; an older backend ignores it |
| `095_checkout_activation_lease.sql` | Adds a per-checkout activation lease; its column is dropped again by 097 | None after 097 |
| `096_refresh_token_families.sql` | Creates `refresh_tokens` for rotation and reuse detection | Additive; an older backend does not rotate |
| `097_managed_account_locks.sql` | `managed_account_locks` (one password operation per managed AD account) and sealed `pending_*` columns on `password_checkout_requests`; replaces 095's lease | Drops `activation_lease_until` |
| `098_audit_chain_v2.sql` | `audit_append()`, `audit_hash_v2()`, `hash_version`, append-only triggers, `audit_checkpoints`, search indexes; drops the `audit_logs.user_id` foreign key so attribution outlives the account | Rolling upgrades are safe (the chain lock key is unchanged), but a row an **older** backend writes after the first v2 row is a `hash_version = 1` row, which the verifier reports as a break. Upgrade every replica; do not roll back past 2.3.0 |
| `099_recording_status.sql` | Adds `recordings.status` and `failure`; recordings never finalised before the migration are marked `incomplete` | Additive |
| `100_outbound_share_blob_format.sql` | Records each staged file's encryption format (chunked format 2) | Format-2 files are unreadable by an older backend |
| `101_role_session_limit.sql` | Adds `roles.max_concurrent_sessions` | Additive |
| `102_auth_attempts.sql` | `auth_attempts` and `auth_attempt_reserve()` for shared sign-in limits | Additive |
| `103_worker_leases.sql` | `worker_leases` so one replica runs each periodic pass | Additive |

**Operator actions:**

1. **Web sessions** — set *Admin → Network → Web Browser Sessions →
   Allowed Networks*. The list is now enforced, and an empty list refuses
   every web session (SEC-02).
2. **Custom compose files, Kubernetes, other orchestrators** — carry over
   the backend's `security_opt: seccomp=./backend/seccomp-chromium.json`,
   the `vault-tls-init` service, the `vault-tls`, `vault-ca` and
   `audit-anchor` volumes, and the backend's `VAULT_ADDR`,
   `VAULT_CACERT` and `STRATA_AUDIT_ANCHOR_PATH` values from
   `docker-compose.yml`. Without the profile Chromium's sandbox cannot start
   and every web session fails (SEC-03); `STRATA_WEB_CHROMIUM_SANDBOX=disabled`
   is a temporary escape hatch only.
3. **Reverse proxies** — `X-Forwarded-For` is honoured only when
   `STRATA_TRUST_XFF=1` **and** the socket peer is in
   `STRATA_TRUSTED_PROXIES` (comma-separated CIDRs or addresses; an invalid
   entry stops startup). The Compose defaults are `1` and
   `172.16.0.0/12,192.168.0.0/16`, which cover the bundled `frontend`
   container; add any proxy outside those ranges (SEC-20). Without it every
   user shares the proxy's address and its sign-in limit.
4. **Database owner** — the `DATABASE_URL` user needs `CREATEROLE` so the
   least-privilege `<owner>_runtime` role can be created (SEC-25). The
   bundled PostgreSQL user already has it; for an external database run
   `ALTER ROLE <owner> CREATEROLE;`. Without it the backend keeps serving
   as the owner and logs a warning.
5. **Audit anchors** — ship the anchor file (`audit-anchor` volume) to
   write-once storage if you need tamper evidence that survives a host
   compromise (SEC-17). Set `STRATA_AUDIT_CHECKPOINT_KEY` if the checkpoint
   key should not be derived from `JWT_SECRET`.
6. **Edited migrations** — if startup refuses because an applied migration
   changed, check the schema, take a backup, and only then set
   `STRATA_MIGRATION_REPAIR_VERSIONS` (SEC-22). See
   [security.md § Migration integrity](security.md#migration-integrity-sec-22).
7. **Recording** — turn on *Require recording* where a session must not run
   unrecorded (SEC-16).
8. **SSO** — accounts with a local password are no longer linked on a first
   SSO sign-in, and nor is an identity whose provider says
   `email_verified: false` (SEC-06). Affected users sign in with their
   password, or an administrator removes the local password.

**New environment variables** (all optional; defaults in brackets):

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `VAULT_CACERT` | `/etc/strata/vault-ca/ca.crt` in Compose | CA the backend trusts for Vault |
| `STRATA_AUDIT_ANCHOR_PATH` | `/app/audit-anchor/checkpoints.jsonl` in Compose; unset = no anchor file | Where signed audit checkpoints are appended |
| `STRATA_AUDIT_CHECKPOINT_KEY` | Derived from `JWT_SECRET` | HMAC key for audit checkpoints |
| `STRATA_DB_RUNTIME_ROLE` | on | `off` serves requests as the database owner |
| `STRATA_MIGRATION_REPAIR_VERSIONS` | unset | Applied migrations whose changed checksum to accept, e.g. `29,46` |
| `STRATA_LOGIN_ATTEMPTS_PER_MINUTE` | 600 | Sign-in attempts per minute for the whole deployment |
| `STRATA_PASSWORD_HASH_CONCURRENCY` | One per CPU, up to 4 | Argon2 hashes at once |
| `STRATA_FILE_CRYPTO_CONCURRENCY` | One per CPU, up to 4 | Files encrypted or verified at once |
| `STRATA_SESSION_MEMORY_BUDGET_MB` | ¾ of container memory less the replay budget | Session admission budget |
| `STRATA_MAX_SESSIONS_PER_USER` | unset (no limit) | Per-user session limit where the role sets none |
| `STRATA_NVR_MEMORY_BUDGET_MB` | 1024 | Replay history for observers, across all sessions |
| `STRATA_WEB_CHROMIUM_SANDBOX` | on | `disabled` runs Chromium without its sandbox (warns on every launch) |

**Removed:** `STRATA_WEB_VNC_HOST` (kiosk Xvnc listens on loopback only).
**Changed default:** `STRATA_AV_MAX_SCAN_SIZE` is 524288000 in Compose
(was 100 MiB), and a file over it is refused in `block` mode.
**DMZ:** `STRATA_DMZ_PUBLIC_BODY_LIMIT_BYTES` defaults to 512 MiB (was
8 MiB); see [dmz.md](dmz.md#streaming-through-the-internal-node-perf-02).

**What changes for users:**

| Change | Who notices |
| ------ | ----------- |
| A sign-in lasts at most 12 hours however often it is refreshed; anyone signed in longer is asked to sign in again after the upgrade | Everyone |
| A password change or reset signs the account out everywhere | Local users |
| `429` with a wait time after repeated failed sign-ins, now shared by every replica | Local users |
| Sessions may be refused with "at capacity" or "session limit" instead of degrading the server | Everyone, under load |
| SFTP browser uploads are scanned and downloads go through outbound approval | SFTP users |
| Recordings show a status; seeking long recordings is fast | Recording viewers |

Users stay signed in across the upgrade: an existing refresh token is
accepted once and then joins a family (SEC-07).

**Verify post-upgrade:**

1. The in-app **What's New** modal shows the v2.3.0 card.
2. `docker compose logs backend | grep -i "least-privilege"` shows
   *Serving requests with the least-privilege database role*.
3. `docker compose exec backend sh -c 'echo $VAULT_ADDR'` prints
   `https://vault:8200`, and **Admin → Health** shows Vault healthy.
4. `GET /api/admin/audit-status` (as an auditor) shows `"problems": []`
   after the first verifier pass, and `last_anchor` once one is written.
5. A web session opens (Allowed Networks set, seccomp profile present).

#### v2.1.1 → v2.2.0 (admin console rebuild; role descriptions; unified notifications)

Rebuild both images. **Two migrations, no `.env` change.** The DMZ edge
carries no changed code and does not need rebuilding.

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

| Migration | Effect | Rollback impact |
| --------- | ------ | --------------- |
| `090_role_description.sql` | Adds `roles.description TEXT NOT NULL DEFAULT ''` | Additive; an older backend ignores the column |
| `092_prune_shipped_roadmap_statuses.sql` | Removes the `workflows-quick-share-outbound` and `protocols-ironrdp-upgrade` keys from `system_settings.roadmap_statuses`; leaves a missing or non-JSON value untouched | Data-only; the removed keys referred to items no longer in the roadmap |

**API additions:** `POST /api/admin/connections/{id}/probe` and a
`description` field on the role endpoints. Nothing was removed or renamed,
and no permission check moved. Audit payloads for `connection.deleted`,
`connection_folder.created` and `connection_folder.deleted` gained fields,
and `connection_folder.updated` is new — update any SIEM parser that
matches those events strictly.

**What changes for users:**

| Change | Who notices |
| ------ | ----------- |
| New cyan / navy design, redesigned sign-in page, breadcrumbs, admin mega-menu | Everyone |
| Approval requests and credential-expiry warnings are toasts at the top right; simultaneous expiries arrive as one grouped toast; a lease pill appears in the header when Vault is configured | Approvers; users with credential profiles |
| **Admin → Connections** is a fleet manager with filters, policy badges, on-demand probes and bulk actions; folders are a tree | Connection administrators |
| The role editor shows *Manage users* and *Manage all connections*, which the old dialog hid | Role administrators |

**Operator action — review custom roles.** Open each custom role in
**Admin → Access → Roles** once after upgrading:

1. Check **Manage users** and **Manage all connections**. Both are Critical:
   the first can change any user's role, including the holder's own; the
   second opens every connection. The old dialog could not show either.
2. On **Asset assignments**, look for subfolders marked **Not covered by
   parent folder**. A folder grant covers only connections filed directly in
   that folder; this has always been the enforced behaviour, but the old
   dialog did not show it.
3. If a role relies on **Create new users**, **Create new roles** or **Create
   new connections** alone, grant the permission the server actually checks
   (*Manage users*, *Administer system* or *Manage all connections*), or
   remove the flag.

**Verify post-upgrade:**

1. The in-app **What's New** modal shows the v2.2.0 card.
2. `docker compose exec postgres-local psql -U strata -d strata -c "\d roles"` lists
   a `description` column.
3. **Admin → Connections** → **Probe** on a reachable connection shows
   *Reachable* with a latency in milliseconds.
4. Rename a folder, then open **Audit Logs**: the entry reads
   *Updated folder …*.

#### v2.1.0 → v2.1.1 (accurate session-end messages; RDP audio, keyboard and display-scale fixes)

A drop-in rebuild of both images. **No migration, no `.env` change, no API
change.** The DMZ edge carries no changed code and does not need rebuilding.

> **No image is published for this release.** If you deployed from GitHub
> Container Registry with `docker-compose.ghcr.yml`, that overlay is gone and
> `ghcr.io/bails309/strata-client/*:2.1.1` does not exist. Build the images and
> push them to your private registry as described in the
> [README Quick Start](../README.md#2-run) and
> [Image provenance](#image-provenance-private-registry). The `strata-dmz` Helm
> chart (0.2.0) now **requires** `image.repository`.

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

**Behaviour that changes for users — tell them before you upgrade:**

| Change | What users notice | If it is unwanted |
| ------ | ----------------- | ----------------- |
| RDP audio plays | Sessions that were always silent now have sound, after the first click or keypress | Set `disable-audio` on the connection |
| Remote UI pinned to 100% on scaled displays | On a monitor scaled above 100%, the remote desktop is sharper and shows more, with smaller text than before | The user ticks **Display Settings → Match my display scale** (per browser) |
| Printable keys sent as Unicode | Non-US layouts type the characters shown on the keys; shortcuts unchanged | — (the old behaviour was a bug) |
| Session-end overlay | Accurate titles and sentences instead of *Connection Error* / *"You may have logged out"* | — |

**Verify post-upgrade:**

1. The in-app **What's New** modal shows the v2.1.1 card.
2. On an RDP session, sign out from the Start menu. The overlay reads
   **Session Ended** — *"You signed out of the remote session."*
3. Play a sound on the remote desktop, and confirm the backend logged the
   audio stream:

   ```bash
   docker compose logs backend | grep "opening audio stream"
   ```

4. Optional: end an RDP session by blocking the target at a firewall. After
   the TCP timeout the overlay reads **Connection Lost**, and the backend log
   carries a `WARN` `engine failure` line with the underlying error.

Diagnosing unexpected session ends is covered by the
[session-disconnects runbook](runbooks/session-disconnects.md).

**Rollback** is a plain image rollback to v2.1.0; there is no state to
reverse.

#### v2.0.0 → v2.1.0 (RDP H.264 GFX passthrough)

*Backfilled in v2.1.1.* A drop-in rebuild of both images with no migration
and no configuration change. H.264 is **off by default**; to use it, tick
**Enable graphics pipeline (GFX)** under Performance on an RDP connection,
prepare the host with [`Configure-RdpAvc444.ps1`](Configure-RdpAvc444.ps1),
and confirm negotiation from the backend log rather than Event Viewer:

```bash
docker compose logs backend | grep "graphics pipeline"
```

See [h264-passthrough.md](h264-passthrough.md).

#### v1.14.6 → v2.0.0 (guacd removed; native Rust session engine)

**This is a major release.** Sessions are now served in-process by native Rust
engines and the `guacd` containers are gone. Read this before upgrading.

```bash
cd strata-client
git pull
docker compose up -d --build --remove-orphans
```

`--remove-orphans` matters if you previously ran the `scale` profile: the
`guacd` and `guacd-2` services no longer exist in the compose file, and without
it Docker leaves the old containers running and idle.

**What happens automatically**

- The `guacd` containers are stopped and removed.
- Migrations `081`–`089` apply at backend start. `089` renames
  `recordings.bytes_from_guacd` / `bytes_to_guacd` to `bytes_down` / `bytes_up`,
  **carrying the values across** — historical per-recording bandwidth survives.
  `082`–`088` clear connection parameters that no longer do anything.
- Existing `.guac` recordings keep playing. The browser is unchanged; no client
  update, no forced re-login.
- Recordings written before the upgrade are still owned by the old
  `guacd:guacd` group. The backend entrypoint keeps its supplementary-group
  handling for exactly this reason, so playback and the retention sweeper
  continue to work on them.

**What you must check afterwards**

1. **Admin → Health → Session Engine.** `Serving` should list every protocol you
   use. Anything under `Withheld` is being **refused**, not routed elsewhere —
   the cause is `STRATA_SESSION_NATIVE_PROTOCOLS`. `Terminal font` must read
   *Found*, or SSH and Kubernetes sessions will be refused.
2. **SSH connections need a host key.** There is no trust-on-first-use path.
   The connection editor can read a target's keys so you can approve one.
3. **RDP targets must support NLA.** A target that will not do CredSSP is now
   refused rather than downgraded — see the CHANGELOG for why that downgrade
   was unsafe.

**Configuration that is now ignored** (harmless if left in place):
`STRATA_SESSION_ENGINE`, `STRATA_SESSION_NATIVE_PERCENT`,
`STRATA_SESSION_NATIVE_HOSTS`, `GUACD_HOST`, `GUACD_PORT`, `GUACD_INSTANCES`,
`STRATA_CLIPBOARD_BUFFER_BYTES`, `STRATA_CLIPBOARD_TRACE`. The `guacd_*` keys in
`config.toml` are ignored on load rather than rejected, so an existing config
file needs no edit.

**API consumers**: `GET /api/admin/health` no longer returns `guacd`, and
`GET /api/admin/metrics` drops the per-engine split and renames the bandwidth
counters. See [api-reference.md](api-reference.md) and the
[CHANGELOG](../CHANGELOG.md#200--2026-09-09).

**Custom DNS** needs no action — the settings you already saved are now read
directly by the engine, and no longer need a restart to apply.

**Rollback.** There is no configuration switch back to `guacd`; it is not in the
image. Rolling back means deploying the previous tag. Migration `089` is a column
rename, so a v1.14.6 backend against a v2.0.0 database will not find
`bytes_from_guacd` — restore the database alongside the image if you roll back.

#### v1.14.4 → v1.14.5 (Dependency security: `h2` HTTP/2 DoS, `nanoid` infinite loop)

v1.14.5 is a **dependency-only** release — no application source file changed, so there is no behavioural difference to verify. It exists to take two upstream security patches.

- **`h2` 0.4.14 → 0.4.16 (RUSTSEC-2026-0258 / GHSA-q83h-524g-xf6h).** Earlier versions accept and queue empty HTTP/2 `DATA` frames without limit, so a peer that floods a stream nobody drains can exhaust memory on the receiving side, or trigger an overflow panic. The frame accounting runs **before** any Strata authorisation, so no permission setting mitigates it.
- **`nanoid` 3.3.16 → 3.3.18 (GHSA-2v37-7h3g-55p8 / CVE-2026-67213).** Build-toolchain dependency only; no runtime exposure. Included so the dependency-audit gate stays green.

**Rebuild requirements:**

- **Backend rebuild mandatory** — picks up `h2 0.4.16` for the HTTP/2 server side of the DMZ link and for `hyper`/`axum`.
- **Frontend rebuild mandatory** — re-resolves the build toolchain to `nanoid 3.3.18`.
- **DMZ edge rebuild mandatory for split topologies, and this is the priority component.** `strata-dmz`'s public TLS listener advertises `h2` in its ALPN list, so it terminates HTTP/2 for **anonymous internet clients** before any credential is presented. Patching the internal node while leaving an unpatched edge in place leaves the exposed half unfixed.
- **No database migrations, no `.env` changes, no API changes.**

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d

# Split (DMZ) topology — the edge must be rebuilt too
docker compose -f docker-compose.dmz.yml build dmz
docker compose -f docker-compose.dmz.yml up -d dmz
```

Verify post-upgrade:

1. `docker compose exec backend /app/strata-backend --version` (or the image label) reports `1.14.5`.
2. The in-app **What's New** modal shows the v1.14.5 card on first load after the upgrade.
3. For DMZ deployments, the link status in Admin → DMZ returns to `connected` and public sessions reconnect normally — the HTTP/2 settings, window sizes, ping watchdog, and Extended CONNECT negotiation are all unchanged by this patch.

Rollback is a plain image rollback; there is no schema or state change to reverse.

#### v1.9.1 → v1.9.2 (Premium RDP interaction improvements, seamless collapsible sidebar dragging, and theme visual contrast)

v1.9.2 resolves layout and user experience issues in active RDP/VNC sessions, including a top-left click deadzone, dragging lag on the collapsible sidebar toggle, and visibility contrast of the right-hand chevron button in dark theme.

- **Frontend rebuild mandatory**: The `frontend` image must be rebuilt to apply the CSS transition, contrast, and pointer-event fixes.
- **Backend rebuild recommended**: The backend version has been bumped to v1.9.2 for consistency with the workspace.
- **No database migrations**.

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

Verify post-upgrade:

1. Dragging the collapsible session sidebar handle should feel instantaneous and responsive with no lag.
2. The session bar toggle should remain clearly visible and high-contrast in both light and dark themes.
3. Active RDP/VNC sessions should be 100% interactive across the entire viewport (no top-left click deadzone).

#### v1.9.0 → v1.9.1 (SSO Edit Form Update Deserialization & Test Connection ID lookup, plus CodeQL cleanup)

v1.9.1 addresses a critical deserialization error that occurred when saving an edited Single Sign-On (SSO) configuration, which caused the "Save Changes" button to become inoperable. It also resolves multiple technical debt items flagged by CodeQL related to unused variables across the backend codebase.

- **Frontend rebuild mandatory**: The `frontend` image must be rebuilt to include the updated test connection payloads and corrected SSO form submissions.
- **Backend rebuild recommended**: The backend image must be rebuilt to pick up the CodeQL technical debt cleanup fixes.
- **No database migrations**.

```bash
cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

Verify post-upgrade:

1. Saving changes to an existing SSO provider should succeed.
2. Testing the connection of an existing SSO provider with a hidden client secret should succeed.

#### v1.8.4 → v1.9.0 (Multiple SSO/OIDC Connections & Dynamic Login Branding)

v1.9.0 introduces multi-tenant OIDC/SSO capabilities, allowing operators to run multiple identity provider configurations side-by-side.

- **Rebuild mandatory**: Both `backend` and `frontend` images must be rebuilt to include multi-provider routes, database models, individual Vault encryption pathways, and dynamic login page branded buttons.
- **New `.env` configuration**: If you are using reverse proxies or non-standard ports, you must add `BASE_URL=https://<your-host>:<port>` to your `.env` file to prevent downstreams from stripping ports from redirect URIs.
- **Automatic database migration**: Migration `062_sso_providers.sql` runs automatically on backend boot, migrating old single-SSO configuration columns in `system_settings` to a separate relational table (`sso_providers`) with a backward-compatible auto-backfill.

```bash
cd strata-client
git pull

# Verify/add BASE_URL in .env (example setup)
# BASE_URL=https://127.0.0.1:8443

docker compose build backend frontend
docker compose up -d
```

Verify post-upgrade:

1. Verify the migration: Check that the table `sso_providers` is created and populated with any pre-existing configuration.
2. Verify the login page: If you have active SSO configurations, confirm separate login buttons are dynamically displayed with their corresponding branded labels.

#### v1.8.3 → v1.8.4 (Frontend test suite stabilization)

v1.8.4 is a maintenance release focused on the reliability of the frontend testing environment. It resolves widespread regressions in the Vitest suite caused by relative API path usage and missing authentication mocks.

- **Frontend rebuild mandatory**: The `frontend` image must be rebuilt to include the updated test setup and component mocks.
- **Backend rebuild recommended**: The backend version has been bumped to v1.8.4 for consistency with the workspace.
- **No database migrations**.

```bash
cd strata-client
git pull
docker compose pull
docker compose build backend frontend
docker compose up -d
```

Verify post-upgrade:

1. Run frontend tests: `cd frontend && npm run test`. All tests should pass without `ERR_INVALID_URL` errors.

#### v1.8.2 → v1.8.3 (Security Hardening & Session Stability)

v1.8.3 introduces mandatory `JWT_SECRET` and NJS-based security hardening.

- **`JWT_SECRET` is now mandatory**: You must add a `JWT_SECRET` to your `.env` file to ensure session persistence across restarts.
- **NJS Header Masking**: The `frontend` image now requires the `njs` module (included in the default build).
- **Backend changes**: Updated auth middleware to require `JWT_SECRET`.

```bash
# Add JWT_SECRET to .env if not present
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env

cd strata-client
git pull
docker compose build backend frontend
docker compose up -d
```

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

#### v1.2.0 → v1.3.0 (mandatory image rebuild — backend _and_ frontend)

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
uploaded under v1.2.0 _start working_ on the first kiosk spawn
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
`guacd` images, _not_ in the Rust binary or the frontend bundle.
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

### Session engine upgrades

> **Changed in v2.0.0.** This section previously covered rebuilding the custom
> `guacd` image, either from `.github/workflows/build-guacd.yml` weekly or by
> hand from `./guacd`. Neither exists. The session engine is compiled into the
> backend binary, so **upgrading it is upgrading the backend**:
>
> ```bash
> docker compose up -d --build backend
> ```
>
> The old warning still applies for the same reason it always did, now for the
> backend rather than a sidecar: **restarting drops active sessions.** Schedule
> upgrades during a maintenance window. The engine hands the process shutdown
> signal to the session loop so the browser is told the gateway restarted
> rather than that the *target* hung up — the latter suppresses the client's
> automatic reconnect, which is what made a restart look like a target fault
> before this was wired up.

---

## High Availability

### Backend Scaling

The Rust backend holds session state in-process (v2.0.0+): a session is a
Tokio task inside the backend that owns the socket to the target. It is
therefore **not** stateless with respect to live sessions — a backend restart
ends the sessions it was serving, and a load balancer must keep a session's
WebSocket on the instance that opened it.

To run multiple instances:

1. Point all instances at the same external PostgreSQL database
2. Place behind a load balancer with **sticky sessions** or WebSocket-aware
   routing. This is required, not merely recommended — a WebSocket that
   lands on a different instance mid-session has no session to attach to
3. The advisory-lock migration system ensures only one instance applies
   schema changes

Scaling the backend is now how you scale the session tier. There is no
separate daemon pool.

### Database

Use a managed PostgreSQL service (e.g., AWS RDS, Azure Database for PostgreSQL, Cloud SQL) with:

- Automated backups
- Read replicas (for audit log queries)
- Connection pooling (PgBouncer)

### Session capacity planning

A session's cost is **measured rather than estimated** since v2.0.0, because
the engine's allocations are known: two 1920×1080 framebuffers at four bytes
per pixel — the live one and the previous frame used to narrow the target's
damage rectangles — plus roughly 8 MB of channel and encoder state. About
**24 MB per RDP session**. Terminal protocols hold a character grid rather
than a framebuffer and are much lighter.

The admin **Sessions** tab computes the host's recommended maximum from this
figure and the host's actual CPU and memory, reserving 30% headroom, so
prefer that number over a table. As a rule of thumb:

| Host | Approx. concurrent RDP sessions |
| ---- | ------------------------------- |
| 2 vCPU / 4 GB   | ~9 (CPU-bound)  |
| 4 vCPU / 8 GB   | ~18 (CPU-bound) |
| 8 vCPU / 16 GB  | ~37 (CPU-bound) |
| 16 vCPU / 32 GB | ~74 (CPU-bound) |

CPU is the binding constraint at these ratios, not memory. Add hosts behind
the load balancer to go further.

> **Changed in v2.0.0.** This section previously documented adding `guacd`
> sidecars via `GUACD_INSTANCES` and the `scale` compose profile, sized at
> ~10–15 concurrent RDP sessions per instance. The daemon, the pool, the
> environment variable and the profile have all been removed — see the
> [v2.0.0 upgrade notes](#v1146--v200-guacd-removed-native-rust-session-engine).

### Vault

For the bundled Vault, HA is not applicable — it runs as a single-node file-storage instance. For production HA, use an external Vault cluster:

- Use Vault's built-in HA mode with Raft integrated storage (available in the free Community Edition)
- Or use a managed Vault service (HCP Vault)
- The backend only needs network access to the Transit encrypt/decrypt endpoints
- Select **External** mode in Admin Settings and point to your HA Vault cluster

---

## Antivirus scanning (v1.12.0+)

> Reference: [ADR-0011](adr/ADR-0011-av-scanning.md), [av-scanning.md](av-scanning.md), [av-operations runbook](runbooks/av-operations.md).

> Optional — `STRATA_AV_BACKEND=off` (the default) preserves
> v1.11.x upload behaviour bit-for-bit. Opting in adds a malware
> check on every Quick Share upload path.

Three deployment shapes:

### Shape 1 — Bundled ClamAV sidecar (recommended)

The new `clamav` service in `docker-compose.yml` lives behind the
opt-in `av` compose profile. Internal-only network exposure (no
host port mapping). First boot pulls ~250 MB of signatures from
clamav.net into the persisted `clamav-db` volume; subsequent boots
converge in seconds.

```bash
# 1. Opt in via .env
cat >> .env <<'EOF'
STRATA_AV_BACKEND=clamav
STRATA_AV_FAIL_MODE=block         # default; reject on scanner error
STRATA_AV_MAX_SCAN_SIZE=524288000 # 500 MiB - keep >= upload cap; larger files are refused
STRATA_AV_TIMEOUT_MS=120000       # 2 min
STRATA_AV_CLAMD_HOST=clamav
STRATA_AV_CLAMD_PORT=3310
EOF

# 2. Start the AV profile alongside the existing stack
docker compose --profile av up -d

# 3. Wait for signature download to complete (first boot only)
docker compose logs -f clamav | grep -i 'database loaded'
# Expected: "main.cvd database loaded ... daily.cvd database loaded ..."

# 4. Verify with EICAR test string
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.com
curl -sS -X POST https://strata.example.com/api/files/upload \
  -H "Cookie: access_token=$TOKEN" \
  -F session_id=$SESSION \
  -F file=@/tmp/eicar.com
# Expected: 400 {"error":"validation","message":"File rejected by malware scan: Win.Test.EICAR_HDB-1"}
rm /tmp/eicar.com
```

**Resource sizing:** clamd's resident set scales with the signature
DB; budget 1.4 GB RSS once loaded. The compose service caps at
3 GB / 2 CPUs which is comfortable for typical privileged-access
workloads (Quick Share is a low-QPS code path — typically << 1
upload per second per backend node).

**Signature freshness:** the container runs `freshclam` on startup
and once per day. Operators in air-gapped environments mirror
`https://database.clamav.net/main.cvd` etc. into a private repo
and override `freshclam.conf` via a bind mount — see
[av-operations runbook](runbooks/av-operations.md).

### Shape 2 — External `clamd` daemon

If you already operate ClamAV on a dedicated VM or container
shared across the estate:

```env
STRATA_AV_BACKEND=clamav
STRATA_AV_CLAMD_HOST=clamav.internal.example.com
STRATA_AV_CLAMD_PORT=3310
```

The backend speaks plain TCP — wrap it in mTLS via a sidecar
proxy (envoy / stunnel) if the path traverses an untrusted
network. Strata does not currently offer in-process TLS to clamd.

### Shape 3 — Command-driven (Microsoft Defender, Sophos, ESET, …)

For environments standardised on a commercial scanner:

```env
STRATA_AV_BACKEND=command
STRATA_AV_FAIL_MODE=block

# Microsoft Defender for Endpoint on Linux
STRATA_AV_CMD=/opt/microsoft/mdatp/sbin/mdatp scan custom --path {path}

# Sophos
# STRATA_AV_CMD=/opt/sophos-av/bin/savscan -ss -nb {path}

# ESET
# STRATA_AV_CMD=/opt/eset/efs/sbin/odscan --readonly {path}

# Wrapper script for anything fancier (cuckoo, custom MIME gating, etc.)
# STRATA_AV_CMD=/usr/local/bin/strata-scan.sh {path}
```

Contract: exit code `0 = clean`, `1 = infected`, anything else
treated as `error`. Signature is parsed from the last non-empty
stdout line (then stderr), stripping `Threat: ` / `Found: `
prefixes. The command must be reachable inside the backend
container — mount the scanner binary + its data dir, or
re-base the backend image with the scanner installed.

### Verification post-enable

```bash
# 1. Backend reports the scanner came up
docker compose logs backend | grep 'av scanner ready'
# Expected: "av scanner ready: backend=clamav fail_mode=block max_scan_size=524288000"

# 2. EICAR upload is blocked
curl -sS -X POST .../api/files/upload -F file=@eicar.com -F session_id=...
# Expected: 400 with signature in body

# 3. Audit log captured the rejection
docker compose exec postgres-local \
  psql -U guacuser -d guacclient -c \
  "SELECT action, details->>'signature', details->>'av_backend'
   FROM audit_logs WHERE action='file.av_blocked' ORDER BY created_at DESC LIMIT 5;"
```

### Switching off

```bash
echo 'STRATA_AV_BACKEND=off' >> .env
docker compose --profile av down
docker compose up -d
```

The four `outbound_shares.av_*` columns remain populated from prior
scans; new submissions land with `av_scan_status=skipped`,
`av_scanner_backend=off`.

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

| Secret                                                      | Purpose                                                                    | Lives on |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| `STRATA_DMZ_OPERATOR_TOKEN`                                 | Bearer for the management API on `127.0.0.1:9444` (status, link kick)      | DMZ only |
| `STRATA_DMZ_LINK_PSKS` (`current:BASE64[,previous:BASE64]`) | Internal proves identity to DMZ. The `previous:` slot exists for rotation. | DMZ      |
| `STRATA_DMZ_LINK_PSK_CURRENT`                               | Same base64 as DMZ's `current:` value (one env var per id)                 | Internal |
| `STRATA_DMZ_EDGE_HMAC_KEY`                                  | DMZ signs `x-strata-edge-*` request-attribution headers                    | DMZ      |
| `STRATA_DMZ_EDGE_HMAC_KEYS`                                 | Internal verifies them; comma-separated multi-key list during rotation     | Internal |

**Optional** — the following env vars have safe defaults but may be
overridden for non-standard deployments:

| Var                        | Default          | Purpose                                                                                                                                                                                             | Lives on |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `STRATA_DMZ_LOOPBACK_ADDR` | `127.0.0.1:8080` | Where `LoopbackUpgradeHandler` (v1.5.2+) bridges inbound RFC 8441 Extended CONNECT WebSocket streams to the local axum router. Override only if the internal node listens on a non-default address. | Internal |

Generate each independently — never derive one from another and never
store all three in the same file.

### Choosing a topology

Strata ships **four** docker-compose overlays that cover every
supported DMZ deployment shape. Pick one before you start; mixing
overlays on the same host is unsupported.

| Walkthrough                                                                    | Overlay file                                                                                                                                                                                                  | Hosts | Public ports                                       | What's exposed publicly                                                                        | Best for                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [**A**](#walkthrough-a--docker-compose-single-host-evaluation)                 | [docker-compose.dmz.yml](../docker-compose.dmz.yml)                                                                                                                                                           | 1     | `${DMZ_PUBLIC_PORT}` (default 8443), 8444          | Relay only — no SPA                                                                            | Local eval / smoke-testing the link                                                    |
| [**A.5**](#walkthrough-a5--two-host-bare-metal-api-only-public-exposure)       | [docker-compose.dmz-only.yml](../docker-compose.dmz-only.yml) (DMZ host) + [docker-compose.internal.yml](../docker-compose.internal.yml) (internal)                                                           | 2     | 8443, 8444 on DMZ host                             | Relay only — clients must already speak Strata's API                                           | SPA hosted on a CDN / mobile app / API-only consumers                                  |
| [**A.6**](#walkthrough-a6--two-host-bare-metal-with-public-spa-recommended) ⭐ | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) (DMZ host) + [docker-compose.internal.yml](../docker-compose.internal.yml) (internal)                                                           | 2     | 80/443 on DMZ host                                 | **Full Strata SPA** + API + WS                                                                 | Standard production — most operators want this                                         |
| [**A.7**](#walkthrough-a7--split-brain-corporate-lan--public-dmz)              | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) (DMZ host) + [docker-compose.yml](../docker-compose.yml) + [docker-compose.internal.yml](../docker-compose.internal.yml) (internal, full stack) | 2     | 80/443 on DMZ host **and** 80/443 on internal host | **Full SPA on both hosts** — corp LAN users hit the internal one, public users hit the DMZ one | Enterprises that want zero-DMZ-hop latency for staff while still publishing externally |

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
>
> - **A. Single-host eval** — everything in one docker compose. Tests the link, **does not** put a public UI in front of it.
> - **A.5. Two-host, API-only public exposure** — DMZ host serves only `/api/*` over the relay. SPA hosted elsewhere (CDN, internal-only browser).
> - **A.6. Two-host with public SPA (recommended)** — the DMZ host runs both `strata-dmz` and an nginx that serves the SPA _and_ reverse-proxies `/api/*` over the relay. Public users get the full UI on `https://dmz.example.com/`. Backend remains unreachable from the internet.

> **What the overlay does for you.** The compose overlay
> [docker-compose.dmz.yml](../docker-compose.dmz.yml) brings up
> _both_ halves on the same docker network: a `strata-dmz` service
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

### A.1 Issue mTLS material

For evaluation, the repo ships a test-cert generator:

```bash
git clone <repo-url> strata-client
cd strata-client

# For single-host A.1–A.6 walkthroughs (defaults are enough):
./scripts/dmz/gen-test-certs.sh

# For A.7 two-host deployments, add the public hostname the internal
# node will dial so it appears in the link cert's SAN:
EXTRA_SERVER_SANS=strata-edge.example.com ./scripts/dmz/gen-test-certs.sh
```

The script writes `./certs/dmz/{ca,server,client,public}.{crt,key}`.

> **Container UIDs and key permissions.** The two containers that read
> `certs/dmz/` run as different non-root users:
>
> | Host          | Container    | User                            | UID             |
> | ------------- | ------------ | ------------------------------- | --------------- |
> | DMZ host      | `strata-dmz` | distroless `nonroot`            | `65532`         |
> | Internal host | `backend`    | `strata` (created in the image) | `999` (typical) |
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
>
> **Link cert SAN must match `STRATA_DMZ_ENDPOINTS`.** The internal
> node uses the hostname from `STRATA_DMZ_ENDPOINTS` as the TLS SNI,
> and rustls rejects the connection with
> `certificate not valid for name "<host>"` if that hostname isn't
> in `server.crt`'s SAN. The test-cert generator's defaults cover
> the docker service name; for a two-host A.7 deployment add your
> public DMZ hostname via `EXTRA_SERVER_SANS=...` (see snippet
> above) or supply your own operator-CA-issued cert with the right
> SANs baked in.

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

### A.2 Populate `.env.dmz`

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

### A.3 Bring up the DMZ stack

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

| Port | Purpose                                                   | Reachability                         |
| ---- | --------------------------------------------------------- | ------------------------------------ |
| 8443 | Public HTTPS (mapped to `${DMZ_PUBLIC_PORT}` on the host) | Internet (or CDN edge)               |
| 8444 | Link listener (the internal node dials in here)           | **Internal network only**            |
| 9444 | Operator API (status, links, disconnect)                  | **Loopback or management VLAN only** |

Sanity-check that the link listener answers and the operator API
demands a token:

```bash
openssl s_client -connect localhost:8444 -showcerts </dev/null 2>/dev/null | head -3
curl -ks https://127.0.0.1:9444/status                                      # → 401
curl -ks https://127.0.0.1:9444/status -H "Authorization: Bearer $TOKEN"    # → 200, links_up:1
```

### A.4 Verify end-to-end

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

### A.5.1 On `dmz-host` — issue mTLS material

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

### A.5.2 On `dmz-host` — bring up the DMZ-only stack

The repo ships [docker-compose.dmz-only.yml](../docker-compose.dmz-only.yml),
a thin overlay that runs **only** `strata-dmz` (no backend, no
frontend) on the DMZ host. Populate `.env.dmz` exactly as in
[A.2](#a2--populate-envdmz), then:

```bash
docker compose --env-file .env.dmz -f docker-compose.dmz-only.yml \
    up -d --build

docker compose --env-file .env.dmz -f docker-compose.dmz-only.yml ps
docker compose --env-file .env.dmz -f docker-compose.dmz-only.yml logs -f strata-dmz
# expect: "public listener up scheme=https", "DMZ link server listening"
```

The DMZ host now exposes:

| Port                                | Origin                                       | Reachability                                                                         |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `${DMZ_PUBLIC_PORT}` (default 8443) | strata-dmz public listener (public TLS cert) | **Internet** — API / WebSocket clients land here                                     |
| 8444                                | strata-dmz link listener                     | **Internal network only** — firewall: allow only `internal-host → dmz-host:8444/tcp` |
| 9444                                | strata-dmz operator API                      | **Loopback only** by default                                                         |

### A.5.3 Distribute the link material to `internal-host`

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

### A.5.4 On `internal-host` — wire the backend env

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
"Y"`. Set both to the same string before bringing up either side.

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

### A.5.5 Verify end-to-end

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
        Backend --- Vault["vault"]
    end
    Backend -.->|"mTLS link<br/>:8444 (outbound only)"| DMZ
```

The DMZ host runs the standalone overlay
[docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml). The
internal host runs the regular [docker-compose.yml](../docker-compose.yml)
plus [docker-compose.internal.yml](../docker-compose.internal.yml)
(see [§A.6.5](#a65--on-internal-host--distribute-link-material-and-wire-the-backend) below).

### A.6.1 On `dmz-host` — issue mTLS material

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

### A.6.2 On `dmz-host` — provision the public TLS cert

Get a real public-CA-signed cert for the public hostname (e.g.
`strata.example.com`) and place the chain + key at:

```
./certs/public/
├── cert.pem    # full chain (leaf + intermediates)
└── key.pem     # private key
```

This is what users see in their browser.

### A.6.3 On `dmz-host` — populate `.env.dmz`

Same as [A.2](#a2--populate-envdmz). Generate `STRATA_DMZ_OPERATOR_TOKEN`,
`STRATA_DMZ_LINK_PSKS`, `STRATA_DMZ_EDGE_HMAC_KEY` (all base64) and
record them in `.env.dmz`.

### A.6.4 On `dmz-host` — bring up the edge stack

```bash
docker compose --env-file .env.dmz \
    -f docker-compose.dmz-edge.yml \
    up -d --build

docker compose --env-file .env.dmz -f docker-compose.dmz-edge.yml ps
docker compose --env-file .env.dmz -f docker-compose.dmz-edge.yml logs -f strata-dmz frontend
```

> **Always pass `--env-file .env.dmz`.** Compose v2 evaluates the
> `${VAR:?required}` interpolation guards in this overlay at YAML
> parse time for **every** subcommand — not just `up`. Running
> `docker compose -f docker-compose.dmz-edge.yml ps` (or `logs`,
> `config`, `down`, etc.) without `--env-file .env.dmz` will fail
> with `required variable STRATA_DMZ_OPERATOR_TOKEN is missing a
value`, even when the containers are running fine. Either repeat
> `--env-file .env.dmz` on every invocation, or `export
COMPOSE_ENV_FILES=.env.dmz` once in your shell.

Expected:

- `strata-dmz`: `link listener up`, `public listener up`.
- `frontend`: nginx boots cleanly. The `ssl-init` step logs
  `Templating /api/ upstream: https://strata-dmz:8443` and
  `Wrote /etc/nginx/conf.d/api-proxy-ssl.conf`.

The DMZ host now exposes:

| Port | Origin                            | Reachability                                                        |
| ---- | --------------------------------- | ------------------------------------------------------------------- |
| 443  | frontend (nginx, public TLS cert) | **Internet** — users land here                                      |
| 8444 | strata-dmz link listener          | **Internal network only** (firewall: allow `internal-host` → :8444) |
| 9444 | strata-dmz operator API           | **Loopback only** (default)                                         |

### A.6.5 On `internal-host` — distribute link material and wire the backend

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

### A.6.6 Verify end-to-end

From any browser on the public internet:

```
https://strata.example.com/
```

You should see the full Strata login UI. Authenticate, then exercise
RDP/SSH/VNC — every request flows public → frontend → strata-dmz →
link → backend. Confirm with:

```bash
# On dmz-host
docker compose --env-file .env.dmz -f docker-compose.dmz-edge.yml logs strata-dmz | grep -i 'authenticated'
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
  _also_ running on the internal host. The request goes
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
        IFE -->|"HTTP/HTTPS<br/>over docker net"| BE
        BE --- PG
        BE --- VA
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
> enforcement, the same database, the same Vault, the same session
> engine. There is exactly ONE enforcement point — the backend's
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

### A.7.1 On `dmz-host` — bring up the edge stack

Follow [§A.6.1](#a61--on-dmz-host--issue-mtls-material) through
[§A.6.4](#a64--on-dmz-host--bring-up-the-edge-stack) verbatim. The
DMZ host's configuration is **identical** to A.6 — it doesn't know
or care that there will be a second frontend on the internal host.

By the end of A.6.4 you should have:

- `dmz-host:443` serving the SPA to the public internet
- `dmz-host:8444` listening for the mTLS link (closed to the public)
- `dmz-host:9444` operator API on loopback only

### A.7.2 On `internal-host` — distribute link material

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

### A.7.3 On `internal-host` — bring up the full stack

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
- `postgres-local`, `vault` — unchanged from a
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

| Side                                   | Variable              | Default | Set in     | Used by                                                       |
| -------------------------------------- | --------------------- | ------- | ---------- | ------------------------------------------------------------- |
| Internal-host frontend (HTTPS)         | `HTTPS_PORT`          | `443`   | `.env`     | [docker-compose.yml](../docker-compose.yml)                   |
| Internal-host frontend (HTTP redirect) | `HTTP_PORT`           | `80`    | `.env`     | [docker-compose.yml](../docker-compose.yml)                   |
| DMZ-host frontend (HTTPS)              | `DMZ_EDGE_HTTPS_PORT` | `443`   | `.env.dmz` | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) |
| DMZ-host frontend (HTTP redirect)      | `DMZ_EDGE_HTTP_PORT`  | `80`    | `.env.dmz` | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) |
| DMZ-host link listener                 | `DMZ_LINK_PORT`       | `8444`  | `.env.dmz` | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) |
| DMZ-host operator API (loopback)       | `DMZ_OPERATOR_PORT`   | `9444`  | `.env.dmz` | [docker-compose.dmz-edge.yml](../docker-compose.dmz-edge.yml) |

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

### A.7.4 Configure split-horizon DNS (or two distinct hostnames)

Two equivalent options — pick one:

**Option A (recommended): two distinct hostnames.** Simpler to
reason about, simpler TLS cert management.

| Hostname                  | DNS view           | Resolves to            | TLS cert                       |
| ------------------------- | ------------------ | ---------------------- | ------------------------------ |
| `strata.corp.example.com` | corporate DNS only | `internal-host` LAN IP | corporate CA                   |
| `strata.example.com`      | public DNS only    | `dmz-host` public IP   | public CA (Let's Encrypt etc.) |

**Option B: split-horizon DNS, one hostname.** A single
`strata.example.com` resolves differently depending on the
resolver. Requires the same cert chain to validate from both
networks (or different certs served by SNI on the matching IP).

| DNS view        | `strata.example.com` resolves to |
| --------------- | -------------------------------- |
| Corporate       | `internal-host` LAN IP           |
| Public internet | `dmz-host` public IP             |

If your enterprise already runs split-horizon DNS for other
services, this is friction-free. If not, Option A is less work.

### A.7.5 Verify both ingress paths

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

### A.7.6 Firewall posture

A.7 is the strictest of the four topologies because there are now
two front doors:

| Source          | Destination         | Port     | Action   | Why                                                   |
| --------------- | ------------------- | -------- | -------- | ----------------------------------------------------- |
| Corp LAN        | `internal-host:443` | 443/tcp  | ALLOW    | Corp users reach the internal SPA                     |
| Internet        | `internal-host:*`   | \*       | **DENY** | Internal host MUST NOT be reachable from the internet |
| Internet        | `dmz-host:443`      | 443/tcp  | ALLOW    | Public users reach the DMZ SPA                        |
| Internet        | `dmz-host:8444`     | 8444/tcp | **DENY** | Link listener is for the internal host only           |
| Internet        | `dmz-host:9444`     | 9444/tcp | **DENY** | Operator API is loopback-only                         |
| `internal-host` | `dmz-host:8444`     | 8444/tcp | ALLOW    | Backend dials out to establish the link               |
| `dmz-host`      | corp LAN            | \*       | **DENY** | DMZ MUST NOT initiate connections into corp           |

The two critical rules are `Internet → internal-host: DENY` (which
keeps the corp frontend off the public internet) and
`dmz-host → corp: DENY` (which preserves the security guarantee
that a compromised DMZ cannot reach Vault / DB / AD).

### A.7.7 When NOT to use A.7

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
  _public_ hostname (because it leaves and re-enters the
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

### B.1 Pre-flight

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

### B.2 Load the three shared secrets into Kubernetes

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

### B.3 Load the link mTLS material

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

### B.4 Load the public TLS certificate

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

### B.5 Tune `values.yaml` for your cluster

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
-n strata-internal --show-labels` and copy the labels verbatim — if
> the NetworkPolicy doesn't match, the internal node cannot dial the
> link.

### B.6 Install the chart

```bash
helm install strata-dmz ./deploy/helm/strata-dmz \
    -n strata-dmz \
    -f values-prod.yaml \
    --set image.repository=registry.example.com/strata/strata-dmz \
    --set image.tag=2.1.1 \
    --set imagePullSecrets[0].name=private-registry
```

`image.repository` is **required** since chart 0.2.0 (v2.1.1): no public
`strata-dmz` image is published, so build it from `crates/strata-dmz` and
push it to your registry first. Create the pull secret in the namespace with
`kubectl -n strata-dmz create secret docker-registry private-registry
--docker-server=registry.example.com --docker-username=… --docker-password=…`.

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

### B.7 Wire the internal release to the DMZ

In your existing `strata-backend` Helm release, add to its values.
The backend auto-detects link-client mode whenever
`STRATA_DMZ_ENDPOINTS` is non-empty — there is no separate `_MODE`
switch. PSK and HMAC values are **base64** and must match the DMZ
side byte-for-byte.

```yaml
extraEnv:
  - name: STRATA_DMZ_ENDPOINTS
    value: strata-dmz.strata-dmz.svc.cluster.local:8444 # if same cluster
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

### B.8 Verify end-to-end

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

### B.9 Upgrades & rollbacks

The DMZ is stateless and replicated; `helm upgrade` performs a rolling
restart honouring the `PodDisruptionBudget` (default `minAvailable: 1`).
Open links migrate to surviving replicas within the supervisor backoff
window (≤ 30 s with default settings). To roll back:

```bash
helm history strata-dmz -n strata-dmz
helm rollback strata-dmz <REV> -n strata-dmz
```

### B.10 Uninstall

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

| Source          | Destination                                  | Port     | Action   | A         | A.5 | A.6 | A.7 |
| --------------- | -------------------------------------------- | -------- | -------- | --------- | --- | --- | --- |
| Internet        | `dmz-host:443`                               | 443/tcp  | ALLOW    | —         | —   | ✅  | ✅  |
| Internet        | `dmz-host:${DMZ_PUBLIC_PORT}` (default 8443) | 8443/tcp | ALLOW    | ✅ (eval) | ✅  | —   | —   |
| Corp LAN        | `internal-host:443`                          | 443/tcp  | ALLOW    | —         | —   | —   | ✅  |
| Internet        | `internal-host:*`                            | \*       | **DENY** | —         | ✅  | ✅  | ✅  |
| `internal-host` | `dmz-host:8444`                              | 8444/tcp | ALLOW    | —         | ✅  | ✅  | ✅  |
| `dmz-host`      | anywhere on the internal network             | \*       | **DENY** | —         | ✅  | ✅  | ✅  |
| Internet        | `dmz-host:8444`                              | 8444/tcp | **DENY** | ✅        | ✅  | ✅  | ✅  |
| Internet        | `dmz-host:9444`                              | 9444/tcp | **DENY** | ✅        | ✅  | ✅  | ✅  |

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

> **Every recording `failed` with *Permission denied* (fixed in v2.3.1).**
> On a volume created before v2.0.0 the recordings directory is owned by
> guacd. Since v2.3.1 the backend entrypoint takes ownership of the
> directory (not its files) on every start and joins a group for every gid
> older recordings carry, so they stay playable. If a recording still fails
> to open, check the backend's first log lines for
> `[entrypoint] ERROR: /var/lib/guacamole/recordings is not writable by strata`;
> it means the volume is mounted read-only or the storage squashes
> ownership (NFS `all_squash`, CIFS without `uid=`/`gid=`). See
> [security.md § Recordings Volume](security.md#recordings-volume--cross-container-posix-permissions-model).

#### Azure Blob Storage

Configure via **Admin → Recordings** in the web UI:

| Setting             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| **Storage Backend** | Select "Azure Blob Storage"                           |
| **Account Name**    | Your Azure Storage account name                       |
| **Container Name**  | Blob container for recordings (default: `recordings`) |
| **Access Key**      | Base64-encoded storage account access key             |

Once configured, a background task syncs completed recording files to Azure Blob every 60 seconds. Recordings are always written locally first (guacd requirement), then uploaded. The download endpoint checks local storage first and falls back to Azure Blob, so recordings remain accessible even after local cleanup.

> **Note:** The backend container must have outbound HTTPS access to `<account>.blob.core.windows.net`. Ensure your Docker network or firewall allows this.

### Configuration

The `config.toml` file is stored in the `backend-config` Docker volume. Back it up alongside database backups.

### Vault, TLS and audit anchors (v2.3.0)

| Volume | Holds | Back up? |
| ------ | ----- | -------- |
| `vault-data` | Vault storage, including the Transit keys that wrap every stored credential | **Yes**, with the database: one without the other cannot decrypt credentials |
| `backend-config` | `config.toml`, `vault-secrets.json` (unseal key and runtime token) and `system-secrets.json` | **Yes** |
| `vault-tls` | The bundled Vault's private CA key and server certificate | Optional: if lost, `vault-tls-init` issues a new CA on the next start and the backend trusts it, since `vault-ca` is refreshed too |
| `vault-ca` | The CA certificate only | No; recreated from `vault-tls` |
| `audit-anchor` | Signed audit checkpoints (`checkpoints.jsonl`) | **Yes, to separate write-once storage** — it is the evidence that the audit log has not been rewritten |

```bash
# Back up the anchor file
docker run --rm -v strata-client_audit-anchor:/data -v $(pwd):/backup \
  alpine cp /data/checkpoints.jsonl /backup/checkpoints-$(date +%F).jsonl
```

Restoring a database older than the newest anchor makes the verifier report
that the anchored checkpoint no longer matches the chain
(`audit.integrity_failed`).
That is expected after a restore; record the restore in your incident log
and keep the old anchor file with it.

---

## Health Monitoring

| Endpoint                | Purpose                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `GET /api/health`       | Returns `{"status":"ok"}` if the backend is running                       |
| `GET /api/status`       | Returns boot phase, database connectivity, and vault configuration status |
| `GET /api/admin/health` | Returns detailed health for the database, the session engine, and vault (including mode) |

Docker health checks are configured for `postgres-local` (`pg_isready`) and `vault` (sys/health endpoint). There is no longer a `guacd` container to health-check on TCP 4822; the session engine's readiness is reported inside `/api/admin/health` as `engine.protocols` (what it can serve) and `engine.withheld` (what was compiled out), which is strictly more informative than a socket probe — a reachable daemon told you nothing about which protocols it had been built with.

---

## Browser Requirements

Strata Client works in any modern browser (Chrome, Edge, Firefox, Safari). Some features require specific browser capabilities:

### Multi-Monitor

| Requirement                  | Details                                                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser**                  | Chromium 100+ (Chrome, Edge, Brave, Opera). Firefox and Safari do not support the Window Management API.                                                                                                                                                             |
| **Permission**               | The browser prompts for "Window Management" permission on first use. Grant it to allow screen detection.                                                                                                                                                             |
| **Popups**                   | When using **3 or more screens**, Chrome's popup blocker may block the additional windows on the first attempt. Click the blocked-popup icon in the address bar and select "Always allow pop-ups from this site", then retry. This is a one-time setting per origin. |
| **Brave / Privacy browsers** | Supported — screen dimensions automatically fall back to `window.screen` values when the Window Management API returns zeroed coordinates.                                                                                                                           |
| **Screen detection**         | The multi-monitor button tooltip shows the number of detected screens in real time (e.g. "Multi-monitor (3 screens detected)"). Plugging in or removing a monitor updates the count automatically via the `screenschange` event.                                     |

### Quick Share

| Requirement        | Details                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| **File size**      | Up to 500 MB per file, 20 files per session. Both the nginx reverse proxy and Axum backend enforce this limit. |
| **Upload timeout** | Large uploads have up to 300 seconds (5 minutes) before the nginx proxy times out the request body transfer.   |

### Clipboard

Clipboard synchronisation requires the [Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API), supported in all modern browsers. HTTPS (or localhost) is required for clipboard read access in most browsers.

#### Diagnosing clipboard problems (v1.14.4+)

Clipboard failures are silent by construction — the clipboard stream has no
error instruction for a transfer the remote simply never
completes — so the browser carries opt-in instrumentation. It does not record
clipboard **contents**: only opcodes, stream indices, payload sizes,
timings, and a non-reversible digest used to correlate entries. Traces
are safe to attach to a support ticket.

**Browser side.** A 500-entry ring buffer is **always recording**, so a
user can be asked for a dump _after_ they hit the problem rather than
being asked to reproduce it with logging switched on. In the session
tab's devtools console:

| Call                        | Effect                                                   |
| --------------------------- | -------------------------------------------------------- |
| `strataClipboard.print()`   | `console.table` of the buffer — the one to ask users for |
| `strataClipboard.enable()`  | Also echo events live; persisted across reloads          |
| `strataClipboard.disable()` | Stop echoing                                             |
| `strataClipboard.dump()`    | Structured entries, oldest first                         |
| `strataClipboard.clear()`   | Reset the buffer                                         |

**Backend side.** Removed in v2.0.0. `STRATA_CLIPBOARD_TRACE` and the
`docker-compose.clipboard-debug.yml` overlay traced the clipboard streams
crossing the socket to `guacd`; there is no such socket now, and the tracer
went with the daemon. The browser-side `strataClipboard` buffer above is
unchanged and is the primary diagnostic.

The failure modes that tracer existed to catch were properties of `guacd`'s
single shared RDP clipboard buffer — overlapping transfers splicing their
payloads, and an oversize copy being discarded rather than truncated. Neither
can occur now: the engine gives each direction its own 8 MiB ceiling and logs
a truncation rather than dropping the transfer. A transfer the remote
abandons is still possible, and remains visible in the browser buffer as a
stream that opens and never ends.

---

## User Guide

### Connecting to a Single Session

1. From the **Dashboard**, find the connection you want to open
2. Click **Connect** on the connection row
3. If Vault-stored credentials exist, the session opens immediately
4. If no credentials are stored (RDP), a credential prompt appears — enter the username and password for the remote host, then click **Connect**
5. For SSH connections without stored credentials, the session connects and the remote host may issue an interactive credential prompt inside the session

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
- **Copy from local → remote** — Text on your local clipboard is pushed to the remote session when the session view gains focus (click into the session or mouse over it), and — since v2.3.1 — whenever you press **Ctrl+V** or **Shift+Insert** in the session. The paste keystroke waits until your clipboard has been sent (at most one second), so pasting straight after Alt+Tab from another application pastes what you just copied rather than what the remote held before.

No manual action is required. Clipboard sync works with both RDP and SSH sessions.

> **Resilience (v1.14.1+).** The remote → local direction is delivered as a streamed sequence of chunks that the browser only commits to your local clipboard once the stream is closed. On RDP, the Windows clipboard channel (CLIPRDR) can occasionally open a transfer and then never close it — most often when the copying application renders its clipboard data lazily (Chrome, Edge, VS Code, terminals) and a second copy interrupts the first, or when the remote desktop's clipboard channel gets stuck after many transfers. Previously this left your local clipboard silently holding its previous contents until you disconnected and reconnected. Strata now runs a 2-second per-transfer watchdog: if a transfer stalls without closing, whatever text arrived is flushed to your local clipboard anyway, and a diagnostic is written to the browser console. A transfer that produced **no** data never overwrites what you already had copied. If you still see a clipboard transfer fail to complete, reconnecting the session resets the remote clipboard channel.

> **Reliability (v1.14.4+).** The local → remote direction is now sent one transfer at a time. Previously a single click could start several transfers at once — the session view reacts to mouse-enter, mouse-down and focus, and a popped-out session adds its own set of handlers on the same view — and because Windows' RDP clipboard is a single shared buffer that cannot keep overlapping transfers apart, their contents could splice together. In the worst case that left the Windows-side clipboard service (`rdpclip.exe`) stuck, and **both** copy and paste stayed broken for the rest of that Windows session. This is the case where reconnecting did _not_ help, because reconnecting reattaches to the same still-logged-on Windows session; only logging off Windows and back on recovered it. Strata now serialises clipboard pushes so overlapping transfers cannot happen, re-primes the clipboard channel whenever a session (re)connects, and no longer suppresses a repeat paste of text whose earlier send silently failed.
>
> If you are on a host that was already stuck before this release, log off the Windows session once (not just disconnect) to restart `rdpclip.exe`.

> **Size limits (rewritten in v2.0.0).** The ceiling is **8 MiB per
> direction**, applied symmetrically, and it is a constant in the engine
> (`MAX_CLIPBOARD_BYTES`) rather than something negotiated over a socket.
> Exceeding it **truncates and logs** — in both directions.
>
> That is the behaviour change worth knowing about. Under `guacd`, overrunning
> the buffer when copying _from_ the remote lost the copy **entirely**: the
> conversion into its fixed buffer failed, the delivery was skipped, and
> nothing was logged at default verbosity, so it presented purely as "the
> clipboard didn't update". Pasting _into_ the remote truncated at roughly
> half the buffer, because that direction converted to UTF-16. Neither
> asymmetry survives.
>
> `STRATA_CLIPBOARD_BUFFER_BYTES` no longer exists and is ignored if set. It
> was a request sent in the handshake, and there is no longer a peer to
> request it from. The whitelisted per-connection `clipboard-buffer-size`
> extra parameter is likewise inert.
>
> If you are diagnosing a clipboard problem that used to be attributed to the
> buffer, the truncation is now stated plainly in the backend log:
>
> ```sh
> docker compose logs backend | grep -i "clipboard"
> ```

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

| Feature          | Details                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| **Open**         | `Ctrl+K` (also works from pop-out and multi-monitor windows)            |
| **Search**       | Filters connections by name, protocol, hostname, description, or folder |
| **Navigate**     | `↑` / `↓` arrow keys to move, `Enter` to launch, `Esc` to close         |
| **Active badge** | Connections you're already connected to show a green "Active" badge     |
| **Mouse**        | Click any result to launch it directly                                  |

The command palette fetches your available connections from the server each time it opens, so newly added connections appear immediately.

### Keyboard Shortcuts

When connected to a remote session, the following keyboard shortcuts are available:

| Shortcut           | Action                         | Notes                                                                     |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------- |
| `Right Ctrl` (tap) | Send Win key (open Start menu) | Right Ctrl is remapped to Super/Win for the remote session                |
| `Right Ctrl + key` | Send Win+key combo             | e.g. `Right Ctrl + E` → Win+E (File Explorer)                             |
| `Ctrl+Alt+\``      | Send Win+Tab (Task View)       | The only reliable browser-level proxy — Windows intercepts `Ctrl+Alt+Tab` |
| `Ctrl+K`           | Open Command Palette           | Search and launch connections from keyboard                               |
| `F12`              | Browser DevTools               | Passed through to the browser (not sent to remote)                        |
| `Ctrl+Shift+I/J`   | Browser DevTools               | Passed through to the browser (not sent to remote)                        |
| `Ctrl+V` / `Shift+Insert` | Paste into the remote session | Sends your local clipboard first and waits for it (up to 1 s) before the keystroke reaches the remote (v2.3.1) |

#### Typing, keyboard layout and the numeric keypad (v2.3.1)

- **Characters are typed on the remote user's keyboard layout**, which is
  the connection's **Keyboard layout** setting (blank means UK English). Your
  own keyboard decides *which* character you typed; Strata presses the keys
  that produce it on the remote layout. If symbols such as `\`, `@`, `"` or
  `£` come out wrong, the connection's layout does not match the remote
  user's — ask an administrator to set it.
- **Console prompts work**, including PowerShell on Windows Server Core.
  Connections set to *Failsafe (Unicode events)* still send every
  character as Unicode, which those prompts ignore.
- **Caps Lock and Num Lock stay on your side.** Your browser applies them;
  the remote session is kept at Num Lock on and Caps Lock off, so its lock
  indicators may not match your keyboard's lights.
- **The numeric keypad** types digits and the decimal point as keypad keys
  in RDP and SSH sessions, so Alt plus a keypad number code works on
  Windows, and the keypad decimal key gives the remote layout's separator.

#### Keyboard Lock (Fullscreen + HTTPS)

When a session is in **fullscreen mode** and accessed over **HTTPS**, the browser captures OS-level shortcuts directly via the [Keyboard Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock):

- **Win key** — captured and sent to the remote session
- **Alt+Tab** — captured and sent to the remote session
- **Escape** — captured and sent to the remote session

This eliminates the need for proxy shortcuts like Right Ctrl or Ctrl+Alt+\`. Keyboard Lock requires a secure context (HTTPS or localhost) and is supported in Chromium-based browsers.

> **Note:** Keyboard Lock does not work over HTTP. In that case, use the Right Ctrl and Ctrl+Alt+\` proxy shortcuts described above.

### Display Tags

Users can optionally pin a single tag per connection to show as a colored badge on session thumbnails in the Active Sessions sidebar.

| Feature        | Details                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------- |
| **Assign**     | Click the tag icon (top-left of any session thumbnail) to open the tag picker               |
| **Choose**     | Select from your existing user tags — each shown with its color swatch                      |
| **Clear**      | Select "None" to remove the display tag from that connection                                |
| **Per-user**   | Each user's display tag choices are independent — your assignments don't affect other users |
| **Persistent** | Display tags are stored on the server and persist across sessions and devices               |

Display tags use your existing user tags (created from the Dashboard tag manager). If you haven't created any tags yet, the picker will show "No tags created yet."

---

## Troubleshooting

| Symptom                         | Cause                            | Fix                                      |
| ------------------------------- | -------------------------------- | ---------------------------------------- |
| Setup wizard keeps appearing    | `config.toml` not persisted      | Check `backend-config` volume is mounted |
| 503 on all API calls            | Backend in setup mode            | Complete the first-boot wizard           |
| 401 on authenticated routes     | SSO not configured               | Configure OIDC in Admin → SSO            |
| Vault errors on credential save | Vault unreachable or key missing | Verify Vault URL, token, and transit key |
| Sessions drop on backend restart | Expected — the engine is in-process | Schedule restarts during maintenance     |
| Database migration race         | Multiple backends starting       | Advisory locks handle this automatically |
