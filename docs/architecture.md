# Architecture

## Overview

Strata Client is a microservices system that replaces the legacy Java/Tomcat + AngularJS Apache Guacamole stack with a Rust proxy and React SPA. The core stack runs four containers (frontend/nginx, backend, guacd, Vault); optional profiles add a bundled PostgreSQL instance and additional guacd sidecar instances for horizontal scaling.

```
                          ┌─────────────────────────────────────────────┐
                          │           Docker Compose Network            │
                          │           (guac-internal bridge)            │
                          │                                             │
  Browser ────HTTPS/WSS──►│  ┌───────────┐        ┌──────────────────┐  │
                          │  │  frontend  │──/api─►│     backend      │  │
                          │  │  (nginx)   │        │  (Rust / Axum)   │  │
                          │  │  :80/:443  │        │   :8080          │  │
                          │  └───────────┘        └────────┬─────────┘  │
                          │                           │         │        │
                          │                     TCP 4822    SQL / HTTP   │
                          │                           │         │        │
                          │                    ┌──────▼───┐  ┌──▼─────┐  │
                          │                    │  guacd   │  │Postgres│  │
                          │                    │(FreeRDP3 │  │  :5432 │  │
                          │                    │ +H.264) │  └────────┘  │
                          │                    ├──────────┤              │
                          │                    │ guacd-2… │ (opt)        │
                          │                    └──────────┘              │
                          │                                             │
                          │                    ┌──────────┐              │
                          │                    │  Vault   │              │
                          │                    │  1.19    │              │
                          │                    │ (Transit)│              │
                          │                    └──────────┘              │
                          │                                             │
                          └─────────────────────────────────────────────┘
```

## Containers

### 1. Custom guacd

| Item | Value |
|---|---|
| Base image | Alpine 3.19 (multi-stage) |
| Source | `guacd/Dockerfile` |
| Network | `guac-internal` (internal only) |
| Port | 4822 (not exposed externally) |

The official Apache Guacamole server daemon, custom-compiled with:
- **FreeRDP 3** (`ARG FREERDP_VERSION=3`) for modern RDP support
- **Kerberos** (`krb5-dev` at build, `krb5` + `krb5-libs` at runtime) for GSSAPI/NLA authentication
- **H.264 GFX** — `ffmpeg-dev` / `ffmpeg-libs` for FreeRDP 3 GFX pipeline with H.264 encoding, dramatically lowering bandwidth for RDP sessions

Multiple guacd instances can be deployed using the `--profile scale` Docker Compose profile (e.g. `guacd-2`). The backend distributes connections across instances using a round-robin `GuacdPool`.

Volumes:
- `guac-recordings` → `/var/lib/guacamole/recordings` — session recording storage
- `krb5-config` → `/etc/krb5` — dynamically generated `krb5.conf`
- `backend-config` → `/app/config` (read-only) — custom `resolv.conf` written by the backend for DNS configuration

**Custom DNS resolution:** The guacd container uses a custom `entrypoint.sh` wrapper that checks for `/app/config/resolv.conf` on startup. If present, it copies the file to `/etc/resolv.conf`, enabling the container to resolve internal hostnames (e.g. `.local`, `.dmz.local` domains). The entrypoint then drops privileges to the `guacd` user via `su-exec` before launching the daemon. DNS servers and search domains are configured via the Admin Settings Network tab and written to the shared `backend-config` volume by the backend. Docker's embedded DNS (`127.0.0.11`) is always appended as a fallback nameserver so existing connections that resolve via public DNS continue working.

### 2. Rust Backend

| Item | Value |
|---|---|
| Language | Rust (2021 edition) |
| Framework | Axum 0.7 + Tokio |
| Source | `backend/` |
| Port | 8080 |

The central orchestrator. Responsibilities:

- **Bootstrap & config** — detects `config.toml` on startup; enters setup mode if missing
- **Database** — connects to local or external PostgreSQL; runs advisory-lock-protected migrations
- **Auth** — multi-method authentication system:
  - **SSO/OIDC** — dynamic IdP discovery via JWKS, secure client secret storage in Vault, and automatic session establishment.
  - **Local Auth** — built-in credentials (Argon2id) with global enable/disable toggle, minimum 12-character password policy, and dedicated password change / admin reset endpoints.
  - **Session tokens** — short-lived access tokens (20 min) with `HttpOnly` refresh cookies (8 hr), proactive activity-based silent refresh, per-user session tracking (`active_sessions` table), and a pre-expiry countdown warning toast.
  - **Enforcement** — strict backend policy check on every login attempt ensures disabled methods cannot be accessed.
- **Vault** — envelope encryption for stored credentials via Vault Transit
- **Tunnel** — bidirectional WebSocket ↔ TCP proxy to guacd with protocol handshake injection; supports H.264 GFX pipeline parameters for RDP
- **guacd pool** — round-robin connection distribution across multiple guacd instances (`GuacdPool`)
- **Metrics** — per-session bandwidth tracking (bytes in/out) with aggregate metrics endpoint
- **Config push** — generates `krb5.conf` (multi-realm), toggles recordings, manages SSO settings
- **AD sync** — scheduled LDAP/LDAPS queries against Active Directory to discover and import computer accounts; supports simple bind and Kerberos keytab auth, custom CA certificates, multiple search bases per source, gMSA/MSA exclusion filters, and configurable connection defaults (RDP performance flags, session recording parameters)
- **Password management** — privileged account password checkout and rotation for AD-managed service accounts; configurable password generation policy, LDAP `unicodePwd` reset, Vault-sealed credential storage, approval workflows with explicit account-to-role scoping (each approval role is mapped to specific managed AD accounts), dedicated "Search Base OUs" for user discovery (allowing separate scoping from device discovery), **scheduled future-dated checkouts** (requests between now + 30 s and now + 14 days sit idle with no credential material until the scheduled moment, at which point the existing 60-second expiration worker activates them), **emergency approval bypass (break-glass)** per AD sync config — gated by `pm_allow_emergency_bypass`, requires ≥ 10-character justification, **hard-capped at 30 minutes** server-side, writes a dedicated `checkout.emergency_bypass` audit event, surfaces an ⚡ Emergency badge across Credentials and Approvals views, background workers for checkout expiration and zero-knowledge auto-rotation, requester username resolution for approver visibility, and decided-by tracking with self-approval detection
- **Connection health checks** — background TCP probing of every connection's hostname:port every 2 minutes; results (online/offline/unknown) persisted and exposed via API for dashboard status indicators
- **DNS configuration** — admin-configurable DNS servers and search domains written to a shared Docker volume as `resolv.conf`; guacd containers apply this on startup for internal hostname resolution; Docker's embedded DNS is preserved as fallback
- **Quick Share (file store)** — session-scoped temporary file CDN; files uploaded via multipart POST are stored on disk, each keyed by a random unguessable token. Download endpoint is unauthenticated (the token is the capability). Files are automatically cleaned up when the tunnel disconnects. Limits: 20 files per session, 500 MB each
- **Audit** — SHA-256 hash-chained append-only log

### 3. Frontend SPA

| Item | Value |
|---|---|
| Language | TypeScript |
| Framework | React 18 + Vite |
| Styling | Tailwind CSS v4 |
| Runtime | nginx (production) |
| Source | `frontend/` |
| Ports | 80 (HTTP), 443 (HTTPS when certs mounted) |

The frontend nginx container serves as the primary gateway for all external traffic. It handles:
- **Reverse proxying** — routes `/api/*` to the Rust backend (including WebSocket upgrades for tunnel connections)
- **SSL termination** — when TLS certificates are mounted at `/etc/nginx/ssl/`, nginx serves HTTPS on port 443 with Mozilla Intermediate cipher configuration, HSTS, and automatic HTTP→HTTPS redirection
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`, and `Permissions-Policy` on every response
- **Compression** — gzip for text, CSS, JS, JSON, and SVG assets
- **SPA fallback** — `try_files` to `index.html` for client-side routing

Pages:
- **Setup Wizard** — first-boot database and Vault configuration with bundled/external/skip vault mode selector
- **Dashboard** — user's connections with connect/credential vault, multi-select for tiled view, last-accessed tracking, favorites filter, group view toggle (flat list or collapsible group headers), and connection health status indicators (green/red/gray dots showing online/offline/unknown from background TCP probes)
- **Session Client** — HTML5 Canvas via `guacamole-common-js` with clipboard sync (including pop-out windows), file transfer, a unified **Session Bar** dock consolidating all tools (Sharing, Quick Share, Keyboard, etc.) into a sleek right-side overlay, **Command Palette** (`Ctrl+K`) for instant connection search and launch from any session, **keyboard shortcut proxy** (Right Ctrl → Win key, `Ctrl+Alt+\`` → Win+Tab), **Keyboard Lock API** for capturing OS-level shortcuts in fullscreen over HTTPS, **display tags** (optional per-connection colored badge on session thumbnails, user-assignable via a tag picker dropdown), **dynamic browser tab title** (shows the active session's server name, e.g. "SERVER01 — Strata"), pop-out windows that persist across navigation with automatic screen-change detection and re-scaling, browser-based multi-monitor support via canvas slicing (Chromium Window Management API) with ~30 fps `setInterval` render loop (avoids `requestAnimationFrame` throttling when popups have focus), `MutationObserver`-based cursor sync across all secondary windows, horizontal-only layout (all monitors arranged left-to-right regardless of physical vertical position — best supported configuration is all landscape monitors side by side; monitors above or below appear as slices to the right), aggregate height capped to primary monitor height for taskbar visibility, `moveTo`/`resizeTo`/`requestFullscreen` auto-maximize on secondary popups, live `screenschange` detection for hot-plugged monitors, screen count detection shown in the toolbar tooltip, Chrome popup-blocker bypass via in-gesture `getScreenDetails()` for 3+ monitors, and Brave/privacy-browser compatibility, Quick Share panel (conditional on file transfer enabled) with drag-and-drop upload and one-click copy-to-clipboard download URLs, expired credential renewal at connect time, and automatic redirect to the next active session when one ends.
- **Tiled View** — multi-connection grid layout with per-tile focus, keyboard broadcast, and inline credential prompts
- **NVR Player** — admin-only read-only session observer with 5-minute rewind buffer, replay→live transition, and timeline controls
- **Sessions** — unified role-based page with Live Sessions and Recording History tabs; users see their own sessions, admins see all with kill/observe/rewind controls
- **Login** — unified login portal supporting local credentials and OIDC Single Sign-On; dynamically adjusts based on enabled authentication methods
- **Admin Settings** — tabbed UI for health, SSO, auth method toggles, Kerberos (multi-realm), vault, recordings, network (DNS configuration), access control, connection group management, AD sync sources (with inline password management configuration: enable toggle, credential source, target filter with preview, password policy, auto-rotation), password management (approval roles with explicit account scoping via searchable dropdown and chip tags, account mappings, checkout requests with decided-by column and self-approval detection), session analytics and metrics
- **Approvals** — dedicated page for pending password checkout approval decisions, visible only to users assigned to approval roles. Premium card layout with requester avatar, CN-from-DN display, labeled duration and justification sections, and approve/deny action buttons
- **Audit Logs** — paginated, hash-chained log viewer
- **Theme Toggle** — sidebar button cycling System → Light → Dark themes with localStorage persistence
- **PWA** — installable Progressive Web App with offline shell caching via service worker; standalone display mode on mobile and tablet

### 4. PostgreSQL

| Item | Value |
|---|---|
| Image | `postgres:16-alpine` |
| Port | 5432 (internal only) |
| Volume | `postgres-data` |

Bundled for zero-configuration first boot. Can be replaced with an external database at any time through the Admin UI.

### 5. HashiCorp Vault

| Item | Value |
|---|---|
| Image | `hashicorp/vault:1.19` |
| Storage | File backend (`/vault/data`) |
| Port | 8200 (internal only) |
| Volume | `vault-data` |
| Mode | Bundled (auto-provisioned) or External (user-provided) |

Bundled in Docker Compose for zero-configuration credential encryption. On first boot, the backend automatically:
1. Initializes the Vault (single unseal key, single key share)
2. Unseals the Vault
3. Enables the Transit Secrets Engine
4. Creates the encryption key (`guac-master-key` by default)
5. Stores the root token and unseal key in `config.toml`

On subsequent startups, the backend auto-unseals using the stored unseal key.

Alternatively, users can connect to an **external Vault instance** by selecting "External" mode during setup or in Admin Settings, providing their own address, token, and transit key name.

## Data Flow

### Connection Tunnel

```
Browser                    Backend                   guacd              Target
  │                          │                         │                  │
  │──── WS upgrade ─────────►│                         │                  │
  │                          │── TCP connect ──────────►│                  │
  │                          │── Guac handshake ───────►│                  │
  │                          │   (select + connect     │── RDP/SSH/VNC ──►│
  │                          │    with injected         │                  │
  │                          │    credentials)          │                  │
  │◄─── binary frames ──────►│◄── binary frames ──────►│◄────────────────►│
  │     (bidirectional)      │    (bidirectional)       │                  │
```

### Envelope Encryption (Credential Save)

```
1. Rust generates random 32-byte DEK
2. Rust encrypts password with DEK (AES-256-GCM) → ciphertext + nonce
3. Rust sends plaintext DEK to Vault POST /transit/encrypt/guac-master-key
4. Vault returns wrapped DEK (vault:v1:base64...)
5. Rust stores (ciphertext, wrapped_dek, nonce) in PostgreSQL
6. Rust zeroizes plaintext DEK from memory
```

### Envelope Decryption (Tunnel Handshake)

```
1. Rust fetches (ciphertext, wrapped_dek, nonce) from PostgreSQL
2. Rust sends wrapped DEK to Vault POST /transit/decrypt/guac-master-key
3. Vault returns plaintext DEK
4. Rust decrypts password with DEK (AES-256-GCM)
5. Rust injects plaintext password into guacd handshake
6. Rust zeroizes DEK and password from memory
```

## Database Schema

```
system_settings ──── key/value config store
users ──────────────── OIDC subject, username, role FK
roles ──────────────── granular permissions (can_manage_system, can_manage_users, can_manage_connections, can_view_audit_logs, can_view_sessions, etc.)
connections ──────── target host, protocol, port, domain, description, group FK, ad_source FK, health_status, health_checked_at
connection_groups ── folder hierarchy with parent_id self-reference
role_connections ──── many-to-many role ↔ connection
user_credentials ──── encrypted password + DEK + nonce per user/connection
credential_profiles ─ saved credential profiles with optional TTL expiry and optional checkout_id link to password management
user_favorites ────── user ↔ connection favorites (composite PK)
connection_shares ── temporary share links with mode (view/control); viewers observe via NVR broadcast
kerberos_realms ──── multi-realm Kerberos config (realm, KDCs, admin server, lifetimes)
ad_sync_configs ──── AD LDAP source configs (URL, auth, search bases, PM search bases, filter, schedule, CA cert, connection_defaults)
ad_sync_runs ─────── per-config sync run history with stats
recordings ─────── session recording metadata with bandwidth metrics
active_sessions ── per-user login session tracking (JTI, IP, user agent, expiry)
approval_roles ──── named approval roles for password management
approval_role_assignments ── many-to-many user ↔ approval role
approval_role_accounts ──── explicit scope: approval role ↔ managed AD account DN
user_account_mappings ───── user ↔ managed AD account (with self-approve flag)
password_checkout_requests ─ checkout lifecycle tracking (Pending/Approved/Active/Expired/Denied/CheckedIn, timestamps, Vault-sealed password)
```

See `backend/migrations/001_initial_schema.sql` through `049_pm_search_bases.sql` for the full DDL.

## Directory Structure

```
strata-client/
├── .github/workflows/     CI/CD pipelines
│   └── build-guacd.yml    Automated guacd image build
├── backend/               Rust backend
│   ├── Cargo.toml
│   ├── Dockerfile
│   ├── migrations/        SQL migration scripts
│   └── src/
│       ├── main.rs        Entry point, bootstrap
│       ├── config.rs      config.toml model
│       ├── error.rs       Unified error type
│       ├── tunnel.rs      Guacamole protocol + WS↔TCP proxy
│       ├── db/            Database pool, migrations
│       ├── routes/        HTTP & WebSocket handlers
│       │   ├── admin.rs   Admin CRUD endpoints
│       │   ├── health.rs  Health & status
│       │   ├── setup.rs   First-boot initialisation
│       │   ├── tunnel.rs  WebSocket tunnel upgrade
│       │   ├── share.rs    Connection sharing (view/control modes)
│       │   ├── files.rs   Quick Share temp file CDN (upload/download/list/delete)
│       │   ├── tunnel.rs  WebSocket tunnel upgrade
│       │   └── user.rs    User-facing endpoints
│       └── services/      Business logic
│           ├── app_state.rs   Shared state + boot phase
│           ├── ad_sync.rs     AD LDAP sync engine (multi-base, multi-auth)
│           ├── audit.rs       Hash-chained audit logging
│           ├── auth.rs        OIDC token validation
│           ├── checkouts.rs   Password checkout lifecycle + rotation workers
│           ├── guacd_pool.rs  Round-robin guacd pool
│           ├── health_check.rs  Background TCP health probes for connections
│           ├── kerberos.rs    Multi-realm krb5.conf generation
│           ├── middleware.rs   JWT auth + admin middleware
│           ├── recordings.rs  Recording config + scheduled retention purge (DB rows, Azure blobs, local files)
│           ├── session_cleanup.rs  Periodic active_sessions expiry sweep
│           ├── session_registry.rs  NVR ring buffer + live session tracking
│           ├── settings.rs    system_settings CRUD
│           ├── user_cleanup.rs  Hard-delete soft-deleted users after configurable window (default 90 days)
│           ├── file_store.rs  Session-scoped temporary file storage
│           ├── vault.rs       Envelope encryption
│           └── vault_provisioning.rs  Bundled Vault lifecycle
├── frontend/              React SPA + nginx gateway
│   ├── Dockerfile
│   ├── common.fragment    Shared nginx config (proxy rules, security headers, compression)
│   ├── http_only.conf     HTTP-only server block
│   ├── https_enabled.conf HTTPS server block (SSL termination + HSTS)
│   ├── connection-upgrade.conf  WebSocket upgrade header mapping
│   ├── ssl-init.sh        Entrypoint: selects HTTP or HTTPS config based on cert presence
│   ├── package.json
│   └── src/
│       ├── api.ts         Typed API client
│       ├── App.tsx        Router + boot detection
│       ├── components/    Shared components (Layout, Select, SessionBar, SessionManager, QuickShare, SessionTimeoutWarning, ThemeProvider, WhatsNewModal)
│       └── pages/         Page components (Dashboard, Documentation, SessionClient, AdminSettings, AuditLogs, Approvals, Login, SetupWizard, SharedViewer)
├── guacd/                 Custom guacd build
│   ├── Dockerfile
│   └── entrypoint.sh     DNS config + privilege drop wrapper
├── certs/                 TLS certificates (mount for HTTPS)
├── docker-compose.yml     Full stack orchestration
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE                Apache 2.0
├── NOTICE                 Third-party attributions
└── README.md
```

## Architecture Decision Records

Design decisions whose rationale outlives any single commit live as
numbered ADRs under [adr/](adr/):

| ADR | Topic |
|---|---|
| [ADR-0001](adr/ADR-0001-rate-limit-single-instance.md) | Rate-limit state: single-instance constraint with promotion criteria |
| [ADR-0002](adr/ADR-0002-csrf-samesite-strict.md) | CSRF strategy: `SameSite=Strict` as the compensating control |
| [ADR-0003](adr/ADR-0003-feature-flags-deferred.md) | Feature flags: boolean `settings` keys instead of a dedicated table |
| [ADR-0004](adr/ADR-0004-guacd-connection-model.md) | guacd connection model, protocol-parameter allow-list, and trust boundaries |
| [ADR-0005](adr/ADR-0005-jwt-refresh-token-sessions.md) | JWT + refresh-token TTLs, single-use rotation, forced-logout lever |
| [ADR-0006](adr/ADR-0006-vault-transit-envelope.md) | Vault Transit envelope (`vault:<base64>`), rotate + rewrap path |
| [ADR-0007](adr/ADR-0007-emergency-bypass-checkouts.md) | Emergency approval bypass and scheduled-start checkouts |

## Operational Runbooks

Step-by-step procedures for on-call engineers live under
[runbooks/](runbooks/):

| Runbook | When to use |
|---|---|
| [disaster-recovery.md](runbooks/disaster-recovery.md) | Host loss or corrupted volumes (RTO ≤ 4h, RPO ≤ 24h) |
| [security-incident.md](runbooks/security-incident.md) | Credential exposure, token replay, unauthorised config change |
| [certificate-rotation.md](runbooks/certificate-rotation.md) | Scheduled rotation or expiry alert (ACME + internal CA) |
| [vault-operations.md](runbooks/vault-operations.md) | Vault unseal, Transit key rotate + rewrap, Shamir rekey |
| [database-operations.md](runbooks/database-operations.md) | Replica promotion, migration rollback, panic-boot recovery |
