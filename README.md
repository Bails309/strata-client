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
  <img src="https://img.shields.io/badge/version-0.11.0-blue?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/license-Apache%202.0-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/rust-1.94-orange?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/react-18-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/typescript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
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
- **Kerberos / NLA** — Dynamic `krb5.conf` generation pushed to the `guacd` container at runtime; multi-realm support with per-realm KDCs and lifetimes
- **Active Directory LDAP sync** — Automatic computer account import from AD via LDAP/LDAPS with scheduled background sync, soft-delete lifecycle, multiple search bases per source, filter presets, gMSA/MSA exclusion, and configurable connection defaults (RDP performance flags, session recording settings)
- **AD auth methods** — Simple bind (DN + password) or Kerberos keytab (`kinit` + GSSAPI) per AD source; custom CA certificate upload for internal LDAPS
- **Connection parameter tooltips** — Hover tooltips on all connection settings sourced from the official [Apache Guacamole documentation](https://guacamole.apache.org/doc/gug/configuring-guacamole.html)
- **Granular RBAC** — 9-permission role system: administer system, audit logs, create users, create roles, create connections, create connection folders, and sharing connections — with `can_manage_system` as a super-admin override
- **Credential profiles** — Saved per-user credential profiles with optional TTL expiry and profile selector on the Dashboard
- **Session recording** — Toggleable Guacamole-native session capture with configurable retention
- **Immutable audit log** — SHA-256 hash-chained, append-only audit trail
- **Tiled multi-session view** — Open multiple connections side-by-side in a responsive grid with per-tile focus control and keyboard broadcast
- **Live session NVR** — TiVo-style admin session observation with a 5-minute rewind buffer; jump into any active session and scrub backwards to see what a user did
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
# Requires Rust 1.94
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
