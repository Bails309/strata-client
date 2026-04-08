<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="frontend/public/logo-light.png">
    <img alt="Strata Client" src="frontend/public/logo-light.png" width="400">
  </picture>
</p>

# Strata Client

A high-performance, modernized client and proxy architecture for [Apache Guacamole](https://guacamole.apache.org/). Built with a Rust backend and a modern TypeScript SPA, featuring enterprise-grade security via HashiCorp Vault envelope encryption, OIDC SSO, and native FreeRDP 3 / Kerberos support.

> **Version:** 0.6.0 — see the [CHANGELOG](CHANGELOG.md) for current progress.

---

## Features

- **Custom `guacd` daemon** — Apache Guacamole server compiled with FreeRDP 3 and Kerberos (GSSAPI) support
- **Rust proxy / API** — High-performance middle tier (Tokio + Axum) handling WebSocket tunnelling, OIDC auth, and dynamic configuration
- **Bundled HashiCorp Vault** — Auto-initialized, auto-unsealed Vault 1.19 container with Transit engine for envelope encryption — zero configuration required
- **Envelope encryption** — User credentials encrypted with AES-256-GCM; Data Encryption Keys wrapped via HashiCorp Vault Transit
- **OIDC / SSO** — Full OpenID Connect flow with dynamic JWKS validation (Keycloak, Entra ID, etc.)
- **Local authentication** — Built-in username/password auth for environments without an OIDC provider
- **Kerberos / NLA** — Dynamic `krb5.conf` generation pushed to the `guacd` container at runtime; multi-realm support with per-realm KDCs and lifetimes
- **Active Directory LDAP sync** — Automatic computer account import from AD via LDAP/LDAPS with scheduled background sync, soft-delete lifecycle, multiple search bases per source, filter presets, and gMSA/MSA exclusion
- **AD auth methods** — Simple bind (DN + password) or Kerberos keytab (`kinit` + GSSAPI) per AD source; custom CA certificate upload for internal LDAPS
- **Credential profiles** — Saved per-user credential profiles with optional TTL expiry and profile selector on the Dashboard
- **Session recording** — Toggleable Guacamole-native session capture with configurable retention
- **Immutable audit log** — SHA-256 hash-chained, append-only audit trail
- **Tiled multi-session view** — Open multiple connections side-by-side in a responsive grid with per-tile focus control and keyboard broadcast
- **Live session NVR** — TiVo-style admin session observation with a 5-minute rewind buffer; jump into any active session and scrub backwards to see what a user did
- **Clipboard sync** — Automatic bidirectional clipboard sharing between local and remote sessions
- **File transfer** — Drag-and-drop upload, in-browser file browser, and RDP virtual drive for seamless file access
- **Connection sharing** — Generate temporary share links in **view** (read-only) or **control** (full keyboard & mouse) mode; guests can provide remote assistance without credentials
- **Connection groups & folders** — Organise connections into nested groups with collapsible group headers and an optional description field
- **Favorites** — Star connections for quick access with a dedicated favorites filter on the Dashboard
- **Light / dark theme toggle** — Cycle between System, Light, and Dark themes from the sidebar; refined layered-charcoal dark palette
- **Auto-HTTPS** — Optional Caddy reverse proxy with automatic Let's Encrypt certificates; activate with `docker compose --profile https up`
- **Health & load metrics** — Real-time bandwidth tracking and `GET /api/admin/metrics` endpoint with session counts by protocol
- **PWA & tablet support** — Installable Progressive Web App with offline shell, touch toolbar for special key combos (Ctrl+Alt+Del, Win key, Alt+Tab, etc.)
- **Sidecar guacd scaling** — Round-robin connection pool across multiple guacd instances for horizontal scaling
- **H.264 GFX encoding** — FreeRDP 3 GFX pipeline with H.264 enabled by default for RDP connections, dramatically reducing bandwidth
- **Modern SPA** — React + TypeScript + Vite frontend with Tailwind CSS v4, setup wizard, admin dashboard, credential vault, and HTML5 Canvas session client
- **Zero-config first boot** — Bundled PostgreSQL and Vault containers; upgrade to external services at any time through the UI
- **CI/CD** — GitHub Actions workflow for automated weekly upstream `guacd` rebuilds

## Architecture

```
                          ┌──────────┐
              :80/:443    │  Caddy   │
         ◄───────────────►│ Gateway  │
              HTTP(S)     └────┬─────┘
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

## Quick Start

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

This starts all services behind Caddy:

| Service | Port | Purpose |
|---|---|---|
| `caddy` | `80`, `443` | Reverse proxy — single entry point for all traffic |
| `frontend` | — (internal) | React SPA (nginx) |
| `backend` | — (internal) | Rust API / WebSocket proxy |
| `guacd` | — (internal) | Guacamole protocol daemon (FreeRDP 3 + H.264) |
| `postgres-local` | — (internal) | Bundled PostgreSQL 16 |
| `vault` | — (internal) | Bundled HashiCorp Vault 1.19 |

For HTTPS, set your domain in `.env`:

```bash
STRATA_DOMAIN=strata.example.com
docker compose up -d
```

For additional guacd instances:

```bash
GUACD_INSTANCES=guacd-2:4822 docker compose --profile scale up -d
```

For a detailed production-ready setup on an Ubuntu server, follow the [Ubuntu VM Deployment Guide](docs/ubuntu-vm-deployment.md).

### 3. First-boot setup

Open `http://127.0.0.1` (or `https://your-domain` if STRATA_DOMAIN is set). On first launch you will be prompted to configure:

1. **Database** — choose the bundled local DB or provide an external PostgreSQL connection string
2. **Vault** — select a vault mode:
   - **Bundled (recommended)** — auto-initializes, unseals, and configures Transit encryption with zero setup
   - **External** — connect to your own Vault instance with address, token, and transit key
   - **Skip** — use local encryption only, configure Vault later via Admin Settings

### 4. Configure SSO & connections

After setup, log in and navigate to **Admin → SSO / OIDC** to configure your identity provider, then add remote desktop connections under **Admin → Access**.

## Development

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

## Documentation

| Document | Description |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, container layout, data flow |
| [docs/api-reference.md](docs/api-reference.md) | REST & WebSocket API endpoints |
| [docs/deployment.md](docs/deployment.md) | Production deployment, upgrades, HA |
| [docs/security.md](docs/security.md) | Threat model, encryption, auth details |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines |
| [NOTICE](NOTICE) | Third-party software notices |

## License

This project is licensed under the [Apache License 2.0](LICENSE).

This project incorporates or depends on software from the Apache Guacamole project and other open-source libraries. See the [NOTICE](NOTICE) file for details.
