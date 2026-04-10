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
| `frontend` | Minimal | 30 MB | Static file serving via nginx |
| `caddy` | Minimal | 30 MB | Reverse proxy + TLS termination |
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

Open `http://127.0.0.1` and complete the setup wizard. The bundled PostgreSQL, Vault, and Caddy containers handle all storage, encryption, and routing — no external dependencies required.

> **Note:** If `localhost` doesn't work, use `127.0.0.1` explicitly. WSL can bind to IPv6 `::1:80` on some systems, intercepting requests before they reach Docker.

## Production Deployment

> [!TIP]
> **New to Strata Client?** For a comprehensive host-level guide, see our [Ubuntu VM Deployment Guide](ubuntu-vm-deployment.md).

### 1. Environment Configuration

Edit `.env` or set environment variables:

```bash
HTTP_PORT=80             # Caddy HTTP listener (host mapping)
HTTPS_PORT=443           # Caddy HTTPS listener (host mapping)
RUST_LOG=info            # Log level: trace, debug, info, warn, error
```

### 2. Build & run

For local evaluation or development:

```bash
docker compose up -d --build
```

For production deployment on an Ubuntu VM, see the detailed [Ubuntu VM Deployment Guide](docs/ubuntu-vm-deployment.md).

### 3. Setup Wizard

All traffic flows through Caddy. No backend or frontend ports are exposed directly — Caddy is the single entry point.

```
Browser → Caddy (:80/:443) → backend:8080 (/api/*)
                            → frontend:80  (everything else)
```

#### HTTP Mode (Default)

With no additional configuration, Caddy serves plain HTTP on port 80:

```bash
docker compose up -d
```

Access the site at `http://your-server-ip` or `http://127.0.0.1`.

No certificates are needed. This is suitable for:
- Local development
- Internal networks behind a corporate firewall
- Environments where TLS is terminated upstream (e.g., a cloud load balancer)

#### HTTPS Mode (Production)

To enable automatic Let's Encrypt HTTPS, set `STRATA_DOMAIN` to your public domain:

**Step 1 — DNS:** Point your domain's A record to your server's public IP.

```bash
STRATA_DOMAIN=strata.example.com
STRATA_ALLOWED_ORIGINS=https://strata.example.com
```

**Step 3 — Start:**

```bash
docker compose up -d
```

Caddy will automatically:
- Obtain a TLS certificate from Let's Encrypt
- Redirect HTTP → HTTPS
- Enable HTTP/2 and HTTP/3 (QUIC)
- Add HSTS headers (`Strict-Transport-Security`)
- Auto-renew the certificate before expiry

**Step 4 — Firewall:** Ensure ports 80 and 443 are open. Caddy needs port 80 for ACME HTTP-01 challenges even when serving HTTPS.

Certificate data is persisted in the `caddy-data` Docker volume.

#### Custom Ports

Override the default port bindings in `.env`:

```bash
HTTP_PORT=8080
HTTPS_PORT=8443
```

> **Note:** Let's Encrypt HTTP-01 challenges require port 80. If `HTTP_PORT` is not 80, use the DNS-01 challenge method instead (requires Caddy DNS plugin — see the [Caddy docs](https://caddyserver.com/docs/automatic-https#dns-challenge)).

#### Configuration Files

| File | Purpose |
|---|---|
| `Caddyfile` | Routing rules, timeouts, compression, security headers |
| `docker-compose.yml` | Caddy service definition, port mappings, volumes |
| `.env` | `STRATA_DOMAIN`, `STRATA_ALLOWED_ORIGINS`, `HTTP_PORT`, `HTTPS_PORT` |

The [Caddyfile](../Caddyfile) uses `{$STRATA_DOMAIN:http://localhost}` as the site address:
- When `STRATA_DOMAIN` is **unset or empty** → defaults to `http://localhost` (plain HTTP)
- When `STRATA_DOMAIN` is a **domain name** → Caddy provisions a certificate and serves HTTPS

Key performance settings in the Caddyfile:
- `read_timeout 3600s` / `write_timeout 3600s` — keeps WebSocket tunnels alive for long RDP/SSH sessions
- `flush_interval -1` — streams tunnel frames immediately with zero buffering
- `encode gzip zstd` — compresses static assets and API responses

#### Using an External Reverse Proxy Instead

If you must use a different reverse proxy (e.g., Traefik, HAProxy, or nginx), you can modify `docker-compose.yml` to expose the backend and frontend ports directly and remove the Caddy service. Key requirements for your proxy:

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

### 7. Active Directory LDAP Sync

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

---

## Upgrading

### Application (Backend + Frontend)

```bash
cd strata-client
git pull
docker compose up -d --build
```

The backend automatically runs any new SQL migrations on startup using advisory locks, so it is safe to scale horizontally. Migrations `001` through `015` are applied in order (initial schema, local auth, session sharing, last-accessed tracking, user favorites, connection groups, share mode, credential profiles, credential expiry, profile TTL, multi-realm Kerberos, AD sync, keytab auth, CA cert, multi search base).

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

For environments with many concurrent sessions, deploy additional guacd sidecar instances:

```bash
# Using the built-in scale profile
GUACD_INSTANCES=guacd-2:4822 docker compose --profile scale up -d
```

Or configure via `config.toml`:

```toml
guacd_instances = ["guacd-2:4822", "guacd-3:4822"]
```

The backend distributes new tunnel connections across all instances using a round-robin `GuacdPool`. Each guacd instance independently connects to target hosts, so they can be placed in different network segments if needed.

To add more instances, duplicate the `guacd-2` service block in `docker-compose.yml` and add the new hostname to `GUACD_INSTANCES`.

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
