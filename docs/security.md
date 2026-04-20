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

**Password Policy:**
- Minimum 12 characters enforced on user creation and password change
- Maximum 1024 characters to prevent abuse
- Argon2id hashing with cryptographically random salts
- Users can change their own password via `PUT /api/auth/password` (requires current password verification)
- Admins can force-reset any user's password via `POST /api/admin/users/:id/reset-password`

### Session Management

Authentication uses a **dual-token architecture** aligned with OWASP session timeout recommendations:

| Token | TTL | Storage | Purpose |
|---|---|---|---|
| Access token | 20 minutes | `localStorage` (Bearer header) | API authentication |
| Refresh token | 8 hours | `HttpOnly`, `Secure`, `SameSite=Strict` cookie | Silent access token renewal |

**Flow:**
1. On login, the backend issues both an access token (in the JSON response) and a refresh token (as an `HttpOnly` cookie scoped to `/api/auth/refresh`)
2. The frontend uses the access token for all API requests via `Authorization: Bearer`
3. When the access token expires (401 response), the frontend silently calls `POST /api/auth/refresh` with the cookie
4. If refresh succeeds, a new access token is issued and the original request is retried transparently
5. If refresh fails (cookie expired or revoked), the user is redirected to the login page
6. A **session timeout warning** toast appears 2 minutes before access token expiry, offering an "Extend Session" button

**Token claims:** Both tokens include a `token_type` claim (`"access"` or `"refresh"`). The auth middleware rejects refresh tokens used as access tokens. A `default_token_type()` provides backward compatibility for pre-existing tokens during upgrade.

**Refresh token isolation:** The refresh cookie is scoped to `Path=/api/auth/refresh` and uses `SameSite=Strict`, preventing it from being sent to any other endpoint or in cross-site requests.

**Per-user session tracking:** Each login records an entry in the `active_sessions` table with the token's JTI (UUID), user ID, IP address, user agent, and expiry time. This provides visibility into how many active sessions a user has.

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
| `/api/auth/login`, `/api/auth/sso/*` | None (public, rate-limited) |
| `/api/auth/refresh` | None (public, validates `HttpOnly` refresh cookie) |
| `/api/shared/tunnel/:token` | None (public, share-token validated; observes owner's live session via NVR broadcast; mode determines input forwarding) |
| `/api/files/:token` (GET) | None (public, capability-based — the random UUID token is the authorization) |
| `/api/auth/password` | `require_auth` |
| `/api/admin/*` | `require_auth` + `require_admin` + granular permission checks |
| `/api/admin/users/:id/reset-password` | `require_auth` + `require_admin` + `can_manage_users` |
| `/api/user/*`, `/api/tunnel/*`, `/api/recordings/*` | `require_auth` |
| `/api/files/upload` (POST), `/api/files/session/*` (GET), `/api/files/:token` (DELETE) | `require_auth` (delete = owner-only) |
| `/api/user/sessions` | `require_auth` (filtered to own sessions) |
| `/api/user/recordings` | `require_auth` (filtered to own recordings) |

**Permission validation:** Both `/api/tunnel/:connection_id` (WebSocket upgrade) and `/api/tunnel/ticket` (ticket issuance) strictly validate that the authenticated user matches the ticket's `user_id` and that their role grants access to the target connection, including mappings via connection folders (`role_folders`).

**Admin connection visibility:** Users with `can_manage_system` or `can_manage_connections` permissions see all connections via `GET /api/user/connections`. Other users see only connections explicitly assigned to their role.

### Granular Admin Permissions

All admin API endpoints enforce fine-grained permission checks beyond the `require_admin` middleware:

| Permission | Endpoints Protected |
|---|---|
| `can_manage_system` | System settings, Vault config, SSO/OIDC config, global toggles. Also acts as super-admin bypass for all other permissions. |
| `can_manage_users` | User CRUD, role assignment, password resets, user tags |
| `can_manage_connections` | Connection CRUD, connection folders, sharing profiles, admin tags, AD sync config, Kerberos realms |
| `can_view_audit_logs` | Audit log listing and export |
| `can_view_sessions` | Active session listing, session observation (NVR), session kill, recording stats |

Endpoints that do not match a specific permission category (e.g. role CRUD) require `can_manage_system`.

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

### Credential Resolution Priority

When establishing a tunnel, the backend resolves credentials in the following priority order:

1. **One-off vault profile** — A `credential_profile_id` supplied on the tunnel ticket. The profile is decrypted directly from the user's `credential_profiles` table (no permanent `credential_mappings` entry required). The profile must belong to the requesting user and must not be expired.
2. **Permanently mapped vault profile** — A credential profile linked to the connection via the `credential_mappings` table.
3. **Expired profile renewal** — When a mapped profile has expired, the connection info endpoint returns its metadata. The pre-connect prompt offers an "Update & Connect" form so the user can renew the credentials (via `PUT /api/user/credential-profiles/:id`) and connect in a single step, without leaving the session flow.
3. **Ticket credentials** — Username/password supplied in the one-time tunnel ticket (from the credential prompt form).
4. **Query string fallback** — Legacy credential parameters on the WebSocket URL (kept for backward compatibility).

This design allows users to use vault-stored credentials for ad-hoc connections without creating permanent mappings, while maintaining the security guarantee that only the profile owner can decrypt their credentials.

### Memory Zeroization

All sensitive material (DEKs, plaintext passwords, tunnel ticket credentials) uses the `zeroize` crate to overwrite memory before deallocation, preventing data leaks through memory reuse. The `TunnelTicket` struct implements `Drop` with `zeroize` to automatically scrub username and password fields when the ticket goes out of scope.

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
| `checkout.requested` | User requested a password checkout for an AD-managed account |
| `checkout.approved` | Approver approved a password checkout request |
| `checkout.denied` | Approver denied a password checkout request |
| `checkout.activated` | Password checkout activated — password generated, LDAP reset, sealed in Vault |
| `checkout.expired` | Password checkout expired (automatic or manual) |
| `rotation.completed` | Automatic service account password rotation completed |
| `kerberos_realm.created` | Kerberos realm added |
| `kerberos_realm.updated` | Kerberos realm settings changed |
| `kerberos_realm.deleted` | Kerberos realm removed |
| `dns.updated` | Admin updated DNS configuration (Network tab) |

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

## Password Management Security

### Credential Isolation

Password management supports separate bind credentials for PM operations (`pm_bind_user` / `pm_bind_password`) and **separate Search Base OUs for discovery** (`pm_search_bases`). This decoupling allows administrators to:
1. Use a dedicated service account with password-reset permissions on a specific user subtree.
2. Restrict the "discovery perimeter" for privileged accounts to only the necessary Organizational Units, preventing the system from identifying or interacting with accounts in other areas of the directory (e.g., standard users or system accounts).

PM bind passwords are encrypted at rest using the same Vault Transit envelope encryption as all other credentials.

### Password Generation

Generated passwords use a cryptographically secure random number generator (`rand::OsRng`) and comply with configurable policy rules (minimum length, uppercase, lowercase, numbers, symbols). The default minimum length is 16 characters. Passwords are generated server-side and sealed in Vault immediately — they are only revealed to the user during an active checkout window.

### Checkout Lifecycle

Password checkouts follow a strict lifecycle:
1. **Request** — user requests a checkout; the request is recorded in `password_checkout_requests` with `status = 'pending'`
2. **Approval** — an authorized approver reviews and approves/denies the request. Approvers can only see and act on requests for managed accounts explicitly assigned to their approval role via the `approval_role_accounts` table. The approver's user ID is recorded as `approved_by_user_id` on the request, and the `requester_username` is resolved via JOIN for display
3. **Activation** — on approval, a new password is generated, the AD account password is reset via LDAP `unicodePwd` modify, and the new password is sealed in Vault
4. **Expiry** — a background worker sweeps every 60 seconds and expires checkouts past their TTL (computed from approval time). On expiry, the password is rotated again so the checked-out password is no longer valid
5. **Check-In** — users can voluntarily return an active checkout before expiry via a "Check In" action. Check-in immediately sets the status to `CheckedIn` and triggers password rotation, invalidating the previously issued credentials

### Approval Role Account Scoping

Approval roles use explicit account-to-role mapping via the `approval_role_accounts` table rather than LDAP filter matching. Each approval role is scoped to specific managed AD account DNs. When an approver queries pending approvals, the backend returns only requests where the `managed_ad_dn` exists in their role's account list:

```sql
SELECT pcr.*, u.username AS requester_username
FROM password_checkout_requests pcr
LEFT JOIN users u ON u.id = pcr.requester_user_id
WHERE pcr.status = 'Pending'
  AND EXISTS (
    SELECT 1 FROM approval_role_accounts ara
    WHERE ara.role_id = ANY($1)
      AND ara.managed_ad_dn = pcr.managed_ad_dn
  )
```

This ensures approvers cannot see or act on checkout requests outside their explicitly assigned scope. The `is_approver` flag (derived from `approval_role_assignments`) is included in both `/api/user/me` and `/api/auth/check` responses to control frontend navigation visibility.

### Zero-Knowledge Auto-Rotation

When enabled, the service account's own password is automatically rotated on a configurable schedule (default: 90 days). The new password is generated, set via LDAP, and sealed in Vault — no human ever sees the password. The `pm_last_rotated_at` timestamp is recorded for audit purposes.

### Target Filter Preview

The `POST /api/admin/ad-sync-configs/test-filter` endpoint allows administrators to preview which accounts a target filter would match before saving the configuration. This endpoint requires `can_manage_system` permission and uses the same bind credential resolution as production queries (including Vault unsealing and PM-specific credential fallback).

### Active Directory Service Account Permissions

The Password Management service account (either the AD Sync bind account or the dedicated PM bind account) requires specific delegated permissions in Active Directory to discover, manage, and rotate passwords on target accounts. These are the **minimum required permissions** — do not grant Domain Admin or other broad privileges.

#### Required Permissions

| Permission | Type | Purpose |
|---|---|---|
| **Reset Password** | General | Reset the `unicodePwd` attribute on managed accounts |
| **Read Account Restrictions** | Property-specific | Read `userAccountControl`, password policy flags |
| **Write Account Restrictions** | Property-specific | Update account restrictions after password reset |
| **Read lockoutTime** | Property-specific | Detect locked-out accounts before attempting reset |
| **Write lockoutTime** | Property-specific | Unlock accounts if needed during password rotation |

#### Delegating Permissions for Standard & Protected Accounts

##### Option 1: Automated Delegation (PowerShell)

The following script automates the delegation of minimum required permissions. It includes a toggle to also apply these permissions to the **AdminSDHolder** container, which is necessary for managing "Protected Accounts" (e.g., Domain Admins).

```powershell
# --- Configuration ---
$ServiceAccount = "YOURDOMAIN\strata-pm-svc"      # The Strata PM service account
$TargetOU = "OU=ManagedAccounts,DC=corp,DC=com"   # The OU containing standard accounts
$ApplyToProtectedAccounts = $true                 # Set to $true to also delegate for Domain Admins/Protected groups
# ---------------------

function Delegate-StrataPM($Path) {
    Write-Host "Delegating permissions on: $Path" -ForegroundColor Cyan
    # 1. Reset Password (Extended Right)
    dsacls $Path /I:S /G "$($ServiceAccount):CA;Reset Password;user"
    # 2. Read/Write account restrictions (Property Set)
    dsacls $Path /I:S /G "$($ServiceAccount):RPWP;account restrictions;user"
    # 3. Read/Write lockoutTime (Individual Property)
    dsacls $Path /I:S /G "$($ServiceAccount):RPWP;lockoutTime;user"
}

# 1. Apply to Standard OU
Delegate-StrataPM $TargetOU

# 2. Apply to AdminSDHolder (for Protected Accounts)
if ($ApplyToProtectedAccounts) {
    $DomainDN = ([ADSI]"").distinguishedName
    $AdminSDHolderPath = "CN=AdminSDHolder,CN=System,$DomainDN"
    Write-Host "`nProtected accounts detected ($ApplyToProtectedAccounts). Applying to AdminSDHolder..." -ForegroundColor Yellow
    Delegate-StrataPM $AdminSDHolderPath
    Write-Host "Note: Permission propagation for protected accounts (SDProp) may take up to 60 minutes." -ForegroundColor Gray
}

Write-Host "`nDelegation complete." -ForegroundColor Green
```

##### Option 2: Manual Delegation (GUI)

Use the Active Directory Delegation of Control Wizard:

1. Open **Active Directory Users & Computers** (ADUC)
2. Right-click the OU (or domain root) containing the managed accounts → **Delegate Control** → Next
3. **Add** the Strata PM service account (e.g. `YOURDOMAIN\strata-pm-svc`) → Next
4. Select **"Create a custom task to delegate"** → Next
5. Select **"Only the following objects in the folder"** → tick **User objects** → Next
6. Tick **General** and **Property-specific**, then select:
   - ☑ Reset Password
   - ☑ Read and write account restrictions
   - ☑ Read lockoutTime
   - ☑ Write lockoutTime
7. Click **Next** → **Finish**

#### Delegating Permissions for Protected Accounts

Active Directory Protected Accounts (members of Domain Admins, Enterprise Admins, Administrators, etc.) have their ACLs reset every 60 minutes by the `SDProp` process. Standard delegation is overwritten. To manage passwords on protected accounts, set permissions on the `AdminSDHolder` container instead:

```powershell
# Replace YOURDOMAIN and strata-pm-svc with your actual domain and service account
dsacls "CN=AdminSDHolder,CN=System,DC=YOURDOMAIN,DC=COM" /G "YOURDOMAIN\strata-pm-svc:CA;Reset Password"
dsacls "CN=AdminSDHolder,CN=System,DC=YOURDOMAIN,DC=COM" /G "YOURDOMAIN\strata-pm-svc:WP;Account Restrictions"
dsacls "CN=AdminSDHolder,CN=System,DC=YOURDOMAIN,DC=COM" /G "YOURDOMAIN\strata-pm-svc:RP;LockoutTime"
dsacls "CN=AdminSDHolder,CN=System,DC=YOURDOMAIN,DC=COM" /G "YOURDOMAIN\strata-pm-svc:WP;LockoutTime"
```

After running these commands, wait for the `SDProp` process to propagate the permissions (runs every 60 minutes by default, or trigger it manually via `runProtectAdminGroupsTask` in ADSI Edit).

> **Security note:** Only delegate permissions on the `AdminSDHolder` if you specifically need to manage passwords on protected accounts. For most deployments, the standard delegation on the target OU is sufficient and carries less risk.

#### Validating Permissions

To verify the service account has the correct effective permissions on a managed user:

1. Open **ADUC** → **View** → enable **Advanced Features**
2. Right-click a managed user → **Properties** → **Security** tab → **Advanced**
3. Select the **Effective Access** tab
4. Click **Select a user** → choose the PM service account
5. Click **View effective access** and confirm the following are ticked:
   - ☑ Reset Password
   - ☑ Read account restrictions
   - ☑ Write account restrictions
   - ☑ Read lockoutTime
   - ☑ Write lockoutTime

If any permission is missing, the service account will receive an LDAP error when attempting password resets, and the checkout activation or auto-rotation will fail with a descriptive error message in the audit log.

#### Principle of Least Privilege

- Create a **dedicated service account** for PM operations rather than reusing the AD Sync bind account. Use the "Use separate credentials for password management" option in the AD Sync configuration.
- Delegate permissions **only on the specific OUs** containing accounts that will be managed, not the entire domain.
- Do **not** add the PM service account to Domain Admins, Account Operators, or any other built-in privileged group.
- Use a strong, unique password for the PM service account. Enable auto-rotation in Strata to rotate the service account's own password on a schedule (zero-knowledge — sealed in Vault).

---

## Connection Health Checks

The backend runs a background worker that TCP-probes every non-deleted connection's `hostname:port` every 2 minutes. Each probe uses a 5-second connect timeout. Results are stored as `health_status` (online/offline/unknown) and `health_checked_at` in the connections table. Health checks run concurrently across all connections using `tokio::spawn` tasks. This feature provides operational visibility without requiring agents on target machines.

---

## Connection Health Checks

The backend runs a background worker that TCP-probes every non-deleted connection's `hostname:port` every 2 minutes. Each probe uses a 5-second connect timeout. Results are stored as `health_status` (online/offline/unknown) and `health_checked_at` in the connections table. Health checks run concurrently across all connections using `tokio::spawn` tasks. This feature provides operational visibility without requiring agents on target machines.

**Security properties:**
- Health checks use TCP connect only — no authentication data is transmitted during probes
- Results are exposed only to authenticated users who already have access to the connection via their role mapping
- The background worker runs within the backend process and cannot be triggered externally
- Probe intervals and timeouts are fixed (2 minutes / 5 seconds) and not user-configurable, preventing abuse

---

## DNS Configuration Security

### Input Validation

The `PUT /api/admin/settings/dns` endpoint validates all DNS entries before writing:
- Each DNS server entry must be a valid IPv4 address (four octets, 0–255, no leading zeros)
- Each search domain must be a valid DNS domain name (alphanumeric labels, hyphens allowed, no leading/trailing hyphens, max 253 characters total, max 6 domains)
- Empty or whitespace-only entries are rejected
- The validated entries are written to `/app/config/resolv.conf` as `search <domains>` and `nameserver <ip>` lines, with Docker's embedded DNS (`127.0.0.11`) appended as a fallback

### File System Isolation

The `resolv.conf` file is written to the `backend-config` Docker volume, which is mounted read-only (`ro`) into guacd containers. The guacd `entrypoint.sh` copies the file to `/etc/resolv.conf` before dropping privileges via `su-exec`. This ensures:
- The backend controls DNS configuration via the shared volume
- guacd cannot modify the source file (read-only mount)
- The entrypoint runs as root only long enough to copy the file, then drops to the `guacd` user
- Docker's embedded DNS is always preserved as a fallback to prevent breaking existing connections

### Audit Trail

DNS configuration changes are logged as `dns.updated` in the append-only audit log, recording which admin made the change, the new DNS server list, and the configured search domains.

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

All containers communicate over an internal Docker bridge network (`guac-internal`). Only the nginx reverse proxy (frontend container) exposes host-mapped ports (`HTTP_PORT` default 80, `HTTPS_PORT` default 443). The backend, `guacd`, `postgres-local`, and Vault are **not** exposed to the host network.

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
| `/api/tunnel/ticket` | User ID | 30 tickets | 60 s |

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

## Recording Disclaimer & Terms of Service

All users must accept a recording disclaimer before accessing the application:

- **First-login gate** — On first login (or when `terms_accepted_at` is `NULL`), a full-screen modal is shown that blocks access to the application until the user accepts
- **Scroll-to-accept** — The user must scroll to the bottom of the disclaimer before the "I Accept" button is enabled, ensuring the full terms are read
- **Decline** — Declining logs the user out immediately
- **Timestamped acceptance** — Acceptance is recorded as a `terms_accepted_at` timestamp on the user record (`034_terms_acceptance.sql` migration). Subsequent logins skip the modal
- **Content** — The disclaimer covers session recording (screen, keyboard, mouse), explicit consent, acceptable use policy, and data protection under UK GDPR and the Data Protection Act 2018

---

## Live Session NVR

The NVR feature maintains an in-memory ring buffer of Guacamole protocol frames for each active tunnel session:

- **Buffer scope** — up to 5 minutes or 50 MB per session, whichever limit is reached first. Oldest frames are evicted automatically.
- **No persistence** — the buffer is held in process memory only. It is discarded when the session ends or the backend restarts. Sensitive content (e.g., screen images of a user's session) is never written to disk by the NVR feature.
- **Admin-only** — the observe endpoint (`/api/admin/sessions/:id/observe`) is protected by `require_auth` + `require_admin` middleware. Non-admin users cannot list or observe sessions.
- **Read-only** — admin observers receive display output only. Keyboard and mouse input from the observer is not forwarded to the target session.

---

## Quick Share (Temporary File CDN)

Quick Share provides session-scoped temporary file hosting so users can transfer files into a remote desktop via a download URL.

- **Capability-based access** — each uploaded file receives a cryptographically random UUID token. The download endpoint (`GET /api/files/:token`) is intentionally **unauthenticated**; the unguessable token is the sole authorization credential. This allows the remote desktop (which has no Strata session) to download the file.
- **Session-scoped lifecycle** — files are bound to the active tunnel session. When the tunnel disconnects, all files for that session are automatically deleted from disk and memory. There is no persistent file storage.
- **Upload authentication** — the upload (`POST /api/files/upload`), list (`GET /api/files/session/:session_id`), and delete (`DELETE /api/files/:token`) endpoints require a valid `Authorization: Bearer` token.
- **Owner-only deletion** — only the user who uploaded a file can delete it. The backend compares `user.id` against the stored `user_id` on the file metadata.
- **Size limits** — 500 MB per file, 20 files per session. The nginx reverse proxy `client_max_body_size` is set to `500M` to match.
- **No directory traversal** — filenames are stored as metadata only; files are written to disk under their UUID token, preventing any path traversal attack.
- **In-memory index** — file metadata is held in an `Arc<RwLock<HashMap>>` keyed by token. No database tables are involved, limiting the blast radius of any exploit to the current process lifetime.

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

## Keyboard Input — Windows Key Proxy

Browsers cannot capture the physical Windows key — the operating system intercepts it at the window-manager level before any `keydown` event reaches the page. This means users cannot natively send Win+E, Win+R, or the Start menu keystroke to a remote desktop session.

### Solution: Right Ctrl as a Host Key

Strata remaps **Right Ctrl** (keysym `0xFFE4`) as a Windows key proxy, following the same "host key" convention used by VMware Workstation and VirtualBox:

| User action | Keysyms sent to guacd |
|---|---|
| Hold Right Ctrl + another key | `Super_L` down → key down … key up → `Super_L` up |
| Tap Right Ctrl alone | `Super_L` down → `Super_L` up |
| Multi-key combo (e.g., Right Ctrl + Shift + S) | `Super_L` down → `Shift` down → `S` down … releases |

**Key properties:**

- **Right Ctrl is swallowed** — it is never forwarded to the remote session. Users who need a Right Ctrl keystroke on the remote side can use the Session Bar's virtual keyboard combos.
- **Stateless reset on focus loss** — if the browser tab or container loses focus while Right Ctrl is held, the proxy resets its internal state to prevent stuck Super keys.
- **Protocol-aware applicability** — the proxy is effective for **RDP** (guacd translates `Super_L` to the Windows key scancode) and **VNC** (keysym passes through to the X server). For **SSH** sessions, the Super keysym is silently ignored by guacd's SSH plugin; Right Ctrl is still intercepted, which is harmless since terminal emulators have no Super modifier.
- **Consistent across session modes** — the proxy is active in all four keyboard handler locations: single session view, tiled multi-session, pop-out windows, and shared viewer (control mode).
- **Single utility, no duplication** — all handler sites use the shared `createWinKeyProxy()` function, ensuring consistent behavior and a single point for future keyboard remapping features.

### Security Considerations

The proxy operates entirely in the browser (client-side JavaScript). No keysym remapping or key injection occurs on the backend. The proxy cannot introduce keys that the user did not physically press — it only translates Right Ctrl into Super_L in the keysym stream before forwarding to `client.sendKeyEvent()`.

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
