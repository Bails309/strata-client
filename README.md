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
  <img src="https://img.shields.io/badge/version-0.26.0-blue?style=flat-square" alt="Version">
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
- **Display refresh control (v0.25.1)** — New **Refresh display** button on the Session Bar and an automatic post-resize canvas sweep (50 ms / 200 ms / 500 ms) eliminate the RDP "screen clipping" artefact previously seen after minimising and restoring a remote window. Uses a sub-pixel compositor nudge (`baseScale + 1e-4`) to invalidate the browser's cached tile and force a full repaint of the `guacamole-common-js` display layers, so common minimise/restore/full-screen-toggle cases self-heal with no user action.
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
- **H.264 GFX encoding** — FreeRDP 3 GFX pipeline with H.264 enabled by default for RDP connections, dramatically reducing bandwidth
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

| Action | What the remote session receives |
|---|---|
| **Hold Right Ctrl + E** | Win+E (open Explorer) |
| **Hold Right Ctrl + R** | Win+R (Run dialog) |
| **Hold Right Ctrl + Shift + S** | Win+Shift+S (screenshot) |
| **Tap Right Ctrl alone** | Win tap (Start menu) |

This works in all session modes — single session, tiled view, pop-out windows, and shared viewer (control mode). The proxy is active for **RDP and VNC** connections; SSH sessions are unaffected.

> [!NOTE]
> If you are using an **external database**, ensure `DATABASE_URL` is set in your `.env` file first. If you want to use the **bundled local database**, use the `local-db` profile:
> ```bash
> docker compose --profile local-db up -d
> ```

This starts all services with Nginx as the main gateway:

| Service | Port | Purpose |
|---|---|---|
| `frontend` | `80`, `443` | React SPA + SSL Gateway + API Proxy |
| `backend` | — (internal) | Rust API / WebSocket proxy |
| `guacd` | — (internal) | Guacamole protocol daemon (FreeRDP 3 + H.264) |
| `postgres-local` | — (internal) | Bundled PostgreSQL 16 |
| `vault` | — (internal) | Bundled HashiCorp Vault 1.19 |

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

| Document | Description |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, container layout, data flow |
| [docs/api-reference.md](docs/api-reference.md) | REST & WebSocket API endpoints |
| [docs/deployment.md](docs/deployment.md) | Production deployment, upgrades, HA |
| [docs/security.md](docs/security.md) | Threat model, encryption, auth details |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines |
| [NOTICE](NOTICE) | Third-party software notices |

## 📄 License

This project is licensed under the [Apache License 2.0](LICENSE).

This project incorporates or depends on software from the Apache Guacamole project and other open-source libraries. See the [NOTICE](NOTICE) file for details.
