# Deployment Guide

## Prerequisites

- Docker ≥ 24.0 and Docker Compose ≥ 2.20
- (Optional) A HashiCorp Vault instance with Transit Secrets Engine enabled
- (Optional) A Keycloak or other OIDC provider for SSO
- (Optional) An external PostgreSQL 14+ instance

## Quick Start (Development / Evaluation)

```bash
git clone https://github.com/your-org/strata-client.git
cd strata-client
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:3000` and complete the setup wizard. The bundled PostgreSQL and Vault containers handle all storage and encryption — no external dependencies required.

## Production Deployment

### 1. Environment Configuration

Edit `.env` or set environment variables:

```bash
BACKEND_PORT=8080        # Rust API port (host mapping)
FRONTEND_PORT=443        # Frontend port (host mapping)
RUST_LOG=info            # Log level: trace, debug, info, warn, error
```

### 2. TLS Termination

#### Option A: Built-in Caddy (Recommended)

Strata Client includes a Caddy reverse proxy that provides automatic HTTPS via Let's Encrypt:

```bash
# Set your public domain
export STRATA_DOMAIN=strata.example.com

# Start with the HTTPS profile
docker compose --profile https up -d
```

Caddy will:
- Obtain and auto-renew TLS certificates from Let's Encrypt
- Terminate HTTPS on ports 80 and 443
- Support HTTP/3 (QUIC) via UDP port 443
- Proxy `/api/*` to the Rust backend and serve the SPA for all other routes
- Add security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- Apply gzip/zstd compression

Certificate data is persisted in the `caddy-data` Docker volume.

When using Caddy, the frontend nginx container still runs (Caddy proxies to it) but its port 3000 mapping can be removed from `.env` to avoid exposing the unencrypted port.

#### Option B: External Reverse Proxy

The frontend nginx container listens on port 80 (HTTP). Place a reverse proxy (e.g., Traefik, HAProxy, or a separate nginx instance) in front that handles TLS termination and proxies to the frontend container.

Or modify `frontend/nginx.conf` to include TLS certificates directly.

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
2. Enter the realm, KDC server, and admin server
3. Save — the backend generates `krb5.conf` and writes it to the shared volume

The `guacd` container reads `KRB5_CONFIG=/etc/krb5/krb5.conf` at runtime.

---

## Upgrading

### Application (Backend + Frontend)

```bash
cd strata-client
git pull
docker compose up -d --build
```

The backend automatically runs any new SQL migrations on startup using advisory locks, so it is safe to scale horizontally. Migrations `001` through `007` are applied in order (initial schema, local auth, session sharing, last-accessed tracking, user favorites, connection groups and description, share mode).

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

Recordings are stored in the `guac-recordings` Docker volume:

```bash
# Backup
docker run --rm -v strata-client_guac-recordings:/data -v $(pwd):/backup \
  alpine tar czf /backup/recordings.tar.gz -C /data .
```

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
