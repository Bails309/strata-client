# Security

This document describes the security model, encryption architecture, and authentication flows in Strata Client.

---

## Authentication

### OIDC / OpenID Connect

Strata Client supports standard OpenID Connect for user authentication. The identity provider (IdP) is configured dynamic via the Admin UI, with client secrets stored securely in HashiCorp Vault.

**Flow:**

1. Frontend redirects the user to the IdP's authorization endpoint
2. User authenticates with the IdP (e.g., Keycloak, Entra ID)
3. IdP redirects back with an authorization code
4. Frontend exchanges the code for an access token
5. Frontend sends the access token as `Authorization: Bearer <token>` on all API requests
6. Backend validates the token:
   - Fetches the IdP's `/.well-known/openid-configuration`
   - Downloads the JWKS (JSON Web Key Set)
   - Verifies the token signature (RS256) using the matching `kid`
   - Validates `iss` (issuer), `aud` (audience/client_id), and `exp` (expiry)
   - Extracts the `sub` (subject) claim

### Local Authentication

For environments without an OIDC provider, Strata Client supports built-in username/password authentication. Passwords are hashed using Argon2id before storage. Local authentication can be globally disabled via the Admin Settings; when disabled, the backend strictly rejects all local login attempts with a 401.

### Authentication Method Enforcement

Administrators can toggle `local_auth_enabled` and `sso_enabled` independently.
- **Local Auth Disabled**: The `/api/auth/login` endpoint returns `401 Unauthorized` immediately.
- **SSO Disabled**: The `/api/auth/sso/login` and `/api/auth/sso/callback` endpoints are deactivated.
- **Safety Guard**: The system prevents disabling both methods simultaneously to ensure administrative access is maintained.

### User Resolution

After token validation, the backend looks up the user in the local database by OIDC `sub` claim. The user's role is resolved via the `users.role_id → roles` foreign key. If no matching user exists, the request is rejected with a 401.

### Route Protection

| Route Group | Middleware |
|---|---|
| `/api/health`, `/api/status`, `/api/setup/*` | None (public) |
| `/api/shared/tunnel/:token` | None (public, share-token validated; mode determines input forwarding) |
| `/api/admin/*` | `require_auth` + `require_admin` |
| `/api/user/*`, `/api/tunnel/*`, `/api/recordings/*` | `require_auth` |

**Admin connection visibility:** Admin users (`role == "admin"`) see all connections via `GET /api/user/connections` regardless of `role_connections` mapping. Non-admin users see only connections explicitly assigned to their role.

---

## Encryption

### Envelope Encryption (Credentials at Rest)

User credentials (RDP/SSH passwords) are never stored in plaintext. The system uses **envelope encryption** with HashiCorp Vault's Transit Secrets Engine:

```
                        ┌──────────────────┐
                        │   Vault Transit  │
                        │   (KEK: Master   │
                        │    Encryption    │
                        │    Key)          │
                        └────────┬─────────┘
                                 │
              ┌──── wraps/unwraps DEK ────┐
              │                           │
    ┌─────────▼──────────┐     ┌──────────▼──────────┐
    │   Data Encryption  │     │     PostgreSQL       │
    │   Key (DEK)        │     │                      │
    │   AES-256-GCM      │     │ encrypted_password   │
    │   (random, 32B)    │     │ encrypted_dek        │
    │                    │     │ nonce (12B)           │
    └────────────────────┘     └──────────────────────┘
```

**Write path:**
1. Generate a cryptographically random 32-byte DEK (`rand::OsRng`)
2. Encrypt the password with the DEK using AES-256-GCM (produces ciphertext + 12-byte nonce)
3. Send the DEK to Vault `POST /v1/transit/encrypt/<key>` — Vault wraps it with the master key (KEK)
4. Store `(ciphertext, vault_wrapped_dek, nonce)` in PostgreSQL
5. Zeroize the plaintext DEK from Rust memory (`zeroize` crate)

**Read path:**
1. Fetch `(ciphertext, vault_wrapped_dek, nonce)` from PostgreSQL
2. Send the wrapped DEK to Vault `POST /v1/transit/decrypt/<key>` — Vault returns the plaintext DEK
3. Decrypt the password with the DEK using AES-256-GCM
4. Inject the plaintext credential into the guacd handshake
5. Zeroize the DEK and plaintext password from memory

**Key properties:**
- The master key (KEK) **never leaves Vault** — it exists only inside the Transit engine
- Each credential gets a **unique, random DEK** — compromising one DEK cannot decrypt other credentials
- DEKs are only held in memory for the duration of the encrypt/decrypt operation
- Vault access is restricted by token/AppRole with minimal Transit-only permissions

### Memory Zeroization

All sensitive material (DEKs, plaintext passwords) uses the `zeroize` crate to overwrite memory before deallocation, preventing data leaks through memory reuse.

---

## Audit Trail

The `audit_logs` table is designed as an append-only, tamper-evident log:

- **Append-only:** The table should be configured with `GRANT INSERT, SELECT` only (no `UPDATE` or `DELETE`)
- **Hash chain:** Each entry's `current_hash` = `SHA-256(previous_hash || action_type || details)`
- **Integrity verification:** Walk the chain from the first entry; any mismatch in the hash chain indicates tampering

### Logged Events

| Event | Description |
|---|---|
| `settings.updated` | Admin changed system settings |
| `sso.configured` | OIDC provider configured |
| `kerberos.configured` | Kerberos settings updated |
| `recordings.configured` | Session recording toggled |
| `vault.configured` | Vault settings updated or mode changed |
| `role.created` | New role created |
| `connection.created` | New connection target added |
| `connection.updated` | Connection settings changed |
| `connection.deleted` | Connection removed |
| `connection_group.created` | New connection group created |
| `connection_group.deleted` | Connection group removed |
| `role_connections.updated` | Role permission mapping changed |
| `credential.updated` | User saved/updated an encrypted credential |
| `tunnel.connected` | User opened a remote desktop session |
| `share.created` | User generated a session share link |
| `ad_sync.config_created` | AD sync source configuration created |
| `ad_sync.config_updated` | AD sync source configuration updated |
| `ad_sync.config_deleted` | AD sync source configuration deleted |
| `ad_sync.completed` | AD sync run finished (includes created/updated/deleted counts) |
| `kerberos_realm.created` | Kerberos realm added |
| `kerberos_realm.updated` | Kerberos realm settings changed |
| `kerberos_realm.deleted` | Kerberos realm removed |

---

## AD Sync Security

### LDAP Credentials

AD sync bind passwords are encrypted at rest using the same Vault Transit envelope encryption as user credentials. When Vault is configured, bind passwords are sealed via `vault::seal_setting()` before storage and unsealed via `vault::unseal_setting()` at sync time. Passwords are stored in the `vault:{json}` envelope format and are never returned in API responses. Without Vault configured, bind passwords fall back to plaintext storage within the same trust boundary as the admin API.

### TLS / Certificate Handling

- Custom CA certificates are stored in the database (`ca_cert_pem` column) and loaded per-query — no global mutable TLS state
- When a CA cert is provided, the backend builds a per-query `rustls::ClientConfig` with system roots plus the custom CA
- For Kerberos auth, the CA cert is written to a temporary file and set via `LDAPTLS_CACERT`; the file is cleaned up after the query
- The `tls_skip_verify` option disables certificate validation entirely — use only for testing

### Kerberos Credential Isolation

Each AD sync source uses a unique credential cache (`KRB5CCNAME=FILE:/tmp/krb5cc_adsync_{config_id}`) to prevent cross-config credential leakage during concurrent syncs. Cache files are cleaned up after each query.

### Filter Security

All preset LDAP filters exclude gMSA (`msDS-GroupManagedServiceAccount`) and MSA (`msDS-ManagedServiceAccount`) accounts to prevent service accounts from being imported as connectable machines. Custom filters bypass this exclusion — administrators are responsible for ensuring appropriate filtering.

### Connection Defaults & Parameter Whitelist

AD sync `connection_defaults` are applied as the `extra` JSONB on synced connections. The backend enforces a strict whitelist of allowed Guacamole parameters via `is_allowed_guacd_param()`. Only safe, non-credential parameters are permitted — sensitive parameters such as passwords, drive paths, and arbitrary command execution are excluded. Allowed categories include:

- **Display & performance**: color-depth, resize-method, force-lossless, cursor, read-only
- **RDP performance flags**: enable-wallpaper, enable-theming, enable-font-smoothing, enable-full-window-drag, enable-desktop-composition, enable-menu-animations, disable-bitmap-caching, disable-offscreen-caching, disable-glyph-caching, disable-gfx
- **Session recording**: recording-path, recording-name, create-recording-path, recording-include-keys, recording-exclude-output, recording-exclude-mouse, recording-exclude-touch
- **Authentication**: ignore-cert (certificate validation bypass only — no credential parameters)
- **Clipboard, audio, printing, Wake-on-LAN**: various toggle and configuration parameters

---

## Network Security

### Database Connection TLS

When connecting to an external PostgreSQL instance, the backend supports TLS encryption via `DATABASE_SSL_MODE` and `DATABASE_CA_CERT` environment variables:

| Mode | Behaviour |
|---|---|
| `disable` | No TLS — plaintext only |
| `allow` | Try non-TLS first, fall back to TLS |
| `prefer` | Try TLS first, fall back to non-TLS (default for most drivers) |
| `require` | TLS required — reject if the server does not support it. Does **not** verify the server certificate. |
| `verify-ca` | TLS required + verify the server certificate against the CA in `DATABASE_CA_CERT` |
| `verify-full` | Same as `verify-ca` plus hostname verification against the certificate CN/SAN |

For production external databases, use `require` at minimum. Use `verify-full` with a `DATABASE_CA_CERT` for full protection against man-in-the-middle attacks. The bundled local PostgreSQL container communicates over the internal Docker network and does not require TLS.

### Container Isolation

All containers communicate over an internal Docker bridge network (`guac-internal`). Only the Caddy reverse proxy exposes host-mapped ports (`HTTP_PORT` default 8080, `HTTPS_PORT` default 443). The frontend, backend, `guacd`, `postgres-local`, and Vault are **not** exposed to the host network.

### guacd Communication

The backend connects to `guacd` over an internal TCP socket (port 4822). The Guacamole protocol is not encrypted natively — network isolation via Docker networking provides the security boundary.

### Vault Communication

The backend communicates with Vault over HTTP (bundled container on internal Docker network) or HTTPS (recommended for external Vault). The Vault token is stored in `config.toml` inside the `backend-config` Docker volume.

### Bundled Vault Security

The bundled Vault container runs on the internal Docker bridge network and is **not exposed to the host**:

- **Unseal key** — stored in `config.toml` alongside the root token. Back up the `backend-config` volume; loss of the unseal key means Vault data cannot be recovered after a container restart.
- **IPC_LOCK** — the container is granted `IPC_LOCK` capability; `disable_mlock = true` is set for container compatibility.
- **File storage** — Vault data is persisted to the `vault-data` Docker volume. This volume should be backed up alongside database backups.
- **Single key share** — the bundled Vault uses a single unseal key (1 key share, threshold of 1) for simplicity. For production deployments requiring Shamir's Secret Sharing, use an external Vault cluster.
- **UI disabled** — the Vault web UI is disabled in the bundled configuration.

---

## Input Validation & Injection Prevention

- **SQL:** All database queries use parameterized statements via `sqlx` (no string interpolation)
- **Path traversal:** Recording file downloads reject filenames containing `..`, `/`, or `\`
- **JSON parsing:** All request bodies are deserialized with `serde` into strongly-typed structs
- **CORS:** Configured via `tower-http`. Controlled by the `STRATA_ALLOWED_ORIGINS` environment variable in production.

---

## Rate Limiting

The backend applies in-memory rate limiting at multiple layers to prevent abuse:

| Endpoint | Key | Limit | Window |
|---|---|---|---|
| `/api/auth/login` | Username | 5 attempts | 60 s |
| `/api/auth/login` | Client IP | 20 attempts | 300 s |
| `/api/shared/tunnel/:token` | Share token | 10 attempts | 60 s |
| `/api/tunnel/:id` (WebSocket) | User ID | 30 connections | 60 s |

All rate limiters use a sliding window with automatic OOM protection — entries are pruned when the map exceeds 50,000 (10,000 for share tokens), and cleared entirely if pruning is insufficient.

---

## Vault Resilience

Vault Transit API calls (DEK wrap/unwrap) use automatic retry with exponential backoff:

- **Max retries:** 3 (4 total attempts)
- **Backoff:** 200 ms → 400 ms → 800 ms
- **Retry conditions:** Network errors and HTTP 5xx responses
- **Non-retryable:** HTTP 4xx (client errors) return immediately

This prevents transient Vault hiccups (container restarts, brief network partitions) from failing active tunnel connections.

---

## Container Hardening

All services in the Docker Compose stack apply security constraints:

| Measure | Applied to |
|---|---|
| `security_opt: no-new-privileges:true` | All services |
| `cap_drop: ALL` | All services |
| `cap_add` (minimal) | `frontend` / `caddy` (`NET_BIND_SERVICE`), `backend` / `postgres-local` (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`), `vault` (`IPC_LOCK`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`) |
| `read_only: true` + `tmpfs` | `frontend` |
| Resource limits (`cpus`, `memory`) | `guacd`, `backend`, `postgres-local` |

---

## Session Recording & Retention

Session recording captures are managed by a background sync task:

- **Retention policy** — Recordings older than the configured `retention_days` (default: 30) are automatically deleted from local storage by the background sync task
- **Azure Blob sync** — When Azure Blob storage is configured, local recordings are uploaded and then deleted locally to prevent disk growth
- **Write protection** — Files modified within the last 30 seconds are skipped to avoid deleting active recordings
- **Configurable** — Retention period and storage type (local / Azure Blob) are set via the Admin UI

---

## Live Session NVR

The NVR feature maintains an in-memory ring buffer of Guacamole protocol frames for each active tunnel session:

- **Buffer scope** — up to 5 minutes or 50 MB per session, whichever limit is reached first. Oldest frames are evicted automatically.
- **No persistence** — the buffer is held in process memory only. It is discarded when the session ends or the backend restarts. Sensitive content (e.g., screen images of a user's session) is never written to disk by the NVR feature.
- **Admin-only** — the observe endpoint (`/api/admin/sessions/:id/observe`) is protected by `require_auth` + `require_admin` middleware. Non-admin users cannot list or observe sessions.
- **Read-only** — admin observers receive display output only. Keyboard and mouse input from the observer is not forwarded to the target session.

---

## TLS & Reverse Proxy (Caddy)

The optional Caddy reverse proxy (`--profile https`) provides:

- **Automatic HTTPS** — Let's Encrypt certificates obtained and renewed automatically when `STRATA_DOMAIN` is set
- **HTTP/3 (QUIC)** — UDP port 443 for modern browsers
- **Security headers** — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Server` header stripped
- **Compression** — gzip and zstd

Caddy runs on the internal Docker network and proxies to the backend and frontend containers. Certificate private keys are stored in the `caddy-data` Docker volume.

---

## Progressive Web App (PWA)

The frontend is a Progressive Web App:

- **Service worker** (`sw.js`) caches the app shell for offline loading. API requests (`/api/*`) are explicitly excluded from caching — authentication tokens and session data are never stored in the cache.
- **manifest.json** enables installation on mobile/tablet devices with standalone display mode.
- The service worker uses a network-first strategy for navigation requests and cache-first for static assets only.

---

## H.264 GFX Encoding

RDP connections use the FreeRDP 3 GFX pipeline with H.264 encoding by default (`enable-gfx=true`, `enable-gfx-h264=true`). This significantly reduces bandwidth but means the guacd container processes video codec frames. The H.264 decode/encode happens entirely within the guacd container — no video data leaves the Docker network unencrypted.

Per-connection overrides can disable GFX via the `extra` JSONB field: `{"enable-gfx": "false"}`.

---

## Recommendations for Production

1. **TLS everywhere** — use the built-in Caddy profile (`--profile https`) or terminate TLS at an external reverse proxy
2. **External Vault** — for production, use an external Vault cluster with Shamir's Secret Sharing (multiple key shares) and AppRole authentication instead of a single unseal key and root token
3. **Vault AppRole** — use AppRole authentication instead of static tokens; rotate credentials regularly
4. **Restrict CORS** — set `STRATA_ALLOWED_ORIGINS` to your specific frontend domain (e.g., `https://strata.example.com`).
5. **Database roles** — grant `INSERT, SELECT` only on `audit_logs` to enforce append-only at the DB level
6. **Network policies** — in Kubernetes, use NetworkPolicies to restrict inter-pod communication
7. **Secret rotation** — rotate Vault tokens and database credentials periodically
8. **Log forwarding** — forward the backend's structured JSON logs to a SIEM or log aggregation service
9. **Container scanning** — scan the custom guacd and backend images for vulnerabilities in CI
10. **Backup unseal key** — if using the bundled Vault, back up the `backend-config` volume containing the unseal key and root token
