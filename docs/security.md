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
| `/api/files/upload` (POST), `/api/files/session/*` (GET), `/api/files/:token` (DELETE) | `require_auth` + `can_use_quick_share` (POST only; `can_manage_system` bypass); delete = owner-only |
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
| `can_create_users` | Provisioning new user accounts |
| `can_create_user_groups` | Role (user-group) create / update / delete |
| `can_create_connections` | Create and manage connections **and** their folder hierarchy (unified as of v0.24.0) |
| `can_create_sharing_profiles` | Generate live session share links |

**User-facing permissions** (non-administrative, explicitly excluded from `has_any_admin_permission()`):

| Permission | Runtime Effect |
|---|---|
| `can_use_quick_share` | Permits `POST /api/files/upload` (ephemeral in-session file CDN). Gate enforced by `services::middleware::check_quick_share_permission()`. `can_manage_system` bypasses this check. |

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
3. **Expired profile renewal** — When a mapped profile has expired, the connection info endpoint returns its metadata. The pre-connect prompt offers an "Update & Connect" form so the user can renew the credentials (via `PUT /api/user/credential-profiles/:id`) and connect in a single step, without leaving the session flow. For **managed (password-management) profiles**, the prompt instead offers an inline checkout request (justification + duration): self-approving users get a one-click "Self-Approve & Connect" flow, while approval-required users submit a pending request and are clearly informed the connection is blocked until approved.
4. **Ticket credentials** — Username/password supplied in the one-time tunnel ticket (from the credential prompt form).
5. **Query string fallback** — Legacy credential parameters on the WebSocket URL (kept for backward compatibility).

**Expired managed credential safeguard** — The tunnel refuses to open a session when the only credential source available for a connection is an expired managed credential profile (`credential_profiles.expires_at <= now()` with a non-null `checkout_id`). This prevents stale credentials from being sent to Active Directory, which would otherwise cause repeated failed binds and could contribute to account lockout. Users are redirected to the renewal/checkout request flow instead.

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
| `connection.share_rate_limited` | A share-tunnel request was rejected by the per-token rate limit. Payload includes a SHA-256 8-char prefix of the token (the raw token is never persisted) and the client IP. Useful for spotting share-link brute-forcing (v0.26.0+) |
| `connection.share_invalid_token` | A share-tunnel request was for a token that does not resolve to an active share (deleted, expired, never existed, or belonging to a soft-deleted connection). Payload includes token-prefix + client IP (v0.26.0+) |
| `user.terms_accepted` | User accepted the Terms of Service / recording-consent modal (v0.26.0+) |
| `user.credential_mapping_set` | User mapped a credential profile to a connection (v0.26.0+) |
| `user.credential_mapping_removed` | User cleared a credential-profile mapping (v0.26.0+) |
| `checkout.retry_activation` | User re-triggered activation on an `Approved` checkout after an initial activation failure (v0.26.0+) |
| `checkout.checkin` | User voluntarily checked a live checkout in before its natural expiry (v0.26.0+) |
| `ad_sync.config_created` | AD sync source configuration created |
| `ad_sync.config_updated` | AD sync source configuration updated |
| `ad_sync.config_deleted` | AD sync source configuration deleted |
| `ad_sync.completed` | AD sync run finished (includes created/updated/deleted counts) |
| `checkout.requested` | User requested a password checkout for an AD-managed account |
| `checkout.approved` | Approver approved a password checkout request |
| `checkout.denied` | Approver denied a password checkout request |
| `checkout.activated` | Password checkout activated — password generated, LDAP reset, sealed in Vault |
| `checkout.expired` | Password checkout expired (automatic or manual) |
| `checkout.scheduled` | User created a future-dated checkout (no credential material exists yet) |
| `notifications.skipped_opt_out` | Transactional email suppressed because the recipient has `users.notifications_opt_out = true` (audit-only events bypass the flag) |
| `notifications.misconfigured` | Dispatcher refused to send because `smtp_from_address` is empty or `smtp_enabled` is false |
| `notifications.abandoned` | Retry worker gave up on a delivery row after 3 failed attempts |
| `checkout.emergency_bypass` | User invoked break-glass bypass; checkout activated without approver review |
| `rotation.completed` | Automatic service account password rotation completed |
| `kerberos_realm.created` | Kerberos realm added |
| `kerberos_realm.updated` | Kerberos realm settings changed |
| `kerberos_realm.deleted` | Kerberos realm removed |
| `dns.updated` | Admin updated DNS configuration (Network tab) |
| `command.executed` | (v0.31.0) User invoked a Command Palette command (built-in or user-defined `:command` mapping). Payload: `{ trigger, action, args, target_id }`. The endpoint hard-codes `action_type` server-side so a malicious client cannot poison the audit-event taxonomy. Validation rejects `action` values outside the twelve-value allow-list (`reload \| disconnect \| close \| fullscreen \| commands \| explorer \| open-connection \| open-folder \| open-tag \| open-page \| paste-text \| open-path`) and `trigger` values outside `^:?[a-z0-9_-]{1,64}$`. Mappings themselves are validated by `services::user_preferences::validate_command_mappings` before persistence — array length ≤ 50, trigger regex `^[a-z0-9_-]{1,32}$`, no built-in collision, unique-within-list, UUID-parseable target IDs, `open-page` paths in the seven-value page allow-list, `paste-text` `args.text` non-empty and ≤ 4096 chars, `open-path` `args.path` non-empty, ≤ 1024 chars, and free of control characters (newline injection would let a stored mapping execute follow-up commands through the Run dialog). **`paste-text` and `open-path` audit details deliberately omit the literal payload** — only `{ text_length: N }` or `{ path_length: N }` is logged. The mapping content is recoverable by an admin from `user_preferences` if needed, but the audit stream itself never persists potentially sensitive payloads (UNC paths, internal command snippets, etc.). |

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
- **H.264 GFX passthrough (v0.28.0+)**: `enable-h264`, `force-lossless`, plus the underlying `disable-gfx` / `disable-offscreen-caching` toggles. The H.264 stream is treated as **untrusted opaque data** by the backend — guacd forwards NAL units verbatim without parsing or re-encoding them. Decoding occurs entirely in the browser's WebCodecs `VideoDecoder`, which runs inside the same web origin sandbox as the rest of the page. No additional credentials, paths, or shell-executable parameters are exposed by these flags
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
2. **Scheduled (optional)** — if the request specifies `scheduled_start_at` (between now + 30 s and now + 14 days), the row is created with `status = 'Scheduled'`. No password is generated, no LDAP mutation is performed, and no Vault material is written. The row sits idle until the worker's next tick after the scheduled moment
3. **Approval** — an authorized approver reviews and approves/denies the request. Approvers can only see and act on requests for managed accounts explicitly assigned to their approval role via the `approval_role_accounts` table. The approver's user ID is recorded as `approved_by_user_id` on the request, and the `requester_username` is resolved via JOIN for display. **Every approval-required request must carry a `justification_comment` of at least 10 characters** — the backend rejects approval-required submissions with a shorter or empty comment so approvers always have a written business reason on file
4. **Emergency Bypass (optional)** — if the AD sync config has `pm_allow_emergency_bypass = true`, users can set `emergency_bypass = true` on the request along with a justification of at least 10 characters. The approver chain is skipped and the checkout activates immediately. `emergency_bypass` is persisted on the row and a dedicated `checkout.emergency_bypass` audit event is written so break-glass access is reviewable after the fact. Emergency bypass cannot be combined with a scheduled release
5. **Activation** — on approval, self-approval, emergency bypass, or scheduled-time arrival, a new password is generated, the AD account password is reset via LDAP `unicodePwd` modify, and the new password is sealed in Vault
6. **Expiry** — a background worker sweeps every 60 seconds and expires checkouts past their TTL (computed from activation time). The same worker also activates due `Scheduled` rows (indexed by a partial index on `scheduled_start_at`). On expiry, the password is rotated again so the checked-out password is no longer valid
7. **Check-In** — users can voluntarily return an active checkout before expiry via a "Check In" action. Check-in immediately sets the status to `CheckedIn` and triggers password rotation, invalidating the previously issued credentials

### Emergency Approval Bypass (Break-Glass)

The `pm_allow_emergency_bypass` toggle on each AD sync config allows administrators to permit users to bypass approver review during an incident. The backend enforces four safeguards server-side, in this order:

1. The mapping's `ad_sync_config_id` must resolve to an `ad_sync_configs` row with `pm_allow_emergency_bypass = true`. If it does not, the request returns `403 Forbidden` and no row is written.
2. The `justification_comment` must be at least 10 characters. Shorter justifications return `400 Validation`.
3. `emergency_bypass` cannot be combined with `scheduled_start_at` — break-glass is inherently an "immediate" action and the two are treated as mutually exclusive.
4. **`requested_duration_mins` is hard-clamped to a maximum of 30 minutes** when emergency bypass is effective. Any larger value submitted by the client is silently reduced to 30 before the row is written. This bounds the exposure window for a credential released without approver review. The UI also caps the duration input to 30 when the emergency checkbox is ticked, but the server-side clamp is authoritative.

Every emergency checkout writes a dedicated `checkout.emergency_bypass` audit entry capturing the requester, managed account DN, justification, and requested duration. The `emergency_bypass` flag is persisted on the checkout row for the entire lifecycle and surfaced as an **⚡ Emergency** badge across the Credentials and Approvals views, so both operators reviewing live activity and auditors reviewing history can identify break-glass use.

### Scheduled Future-Dated Checkouts

Scheduled releases let a user request a password that will not be generated until a chosen moment in the future (between now + 30 s and now + 14 days). Until the scheduled moment arrives, the checkout row exists only as metadata — no password is generated, no LDAP call is made, no Vault material is written. This minimises the window during which a privileged credential is materialised.

The 60-second expiration worker (`spawn_expiration_worker` / `run_expiration_scrub`) also performs an indexed scan for `status = 'Scheduled' AND scheduled_start_at <= now()` and invokes `activate_checkout` for each due row. This reuses the existing approval-time activation code path, so scheduled activations benefit from the same Vault sealing, LDAP reset and audit logging as any other activation.

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

function Delegate-StrataPM($Path, $IsOU = $true) {
    Write-Host "Delegating permissions on: $Path" -ForegroundColor Cyan
    $Inherit = if ($IsOU) { "/I:S" } else { "" }
    $Target = if ($IsOU) { ";user" } else { "" }

    # 1. Reset Password (Extended Right)
    dsacls $Path $Inherit /G "$($ServiceAccount):CA;Reset Password$Target"
    # 2. Read/Write account restrictions (Property Set)
    dsacls $Path $Inherit /G "$($ServiceAccount):RPWP;account restrictions$Target"
    # 3. Read/Write lockoutTime (Individual Property)
    dsacls $Path $Inherit /G "$($ServiceAccount):RPWP;lockoutTime$Target"
}

# 1. Apply to Standard OU
Delegate-StrataPM $TargetOU -IsOU $true

# 2. Apply to AdminSDHolder (for Protected Accounts)
if ($ApplyToProtectedAccounts) {
    $DomainDN = ([ADSI]"").distinguishedName
    $AdminSDHolderPath = "CN=AdminSDHolder,CN=System,$DomainDN"
    Write-Host "`nProtected accounts detected ($ApplyToProtectedAccounts). Applying to AdminSDHolder..." -ForegroundColor Yellow
    Delegate-StrataPM $AdminSDHolderPath -IsOU $false
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

> [!IMPORTANT]
> **Active Directory Timing Quirk**: After delegating permissions to the `AdminSDHolder` container—either via the script above or manually—**you must wait up to 60 minutes** before attempting to manage checkouts. Active Directory uses a background process called **SDProp** that runs hourly to forcefully propagate these permissions down onto actual users (like Domain Admins). If you need it done instantly, you can trigger SDProp manually by setting `RunProtectAdminGroupsTask` in ADSI Edit.

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

## Recordings Volume — Cross-Container POSIX Permissions Model

**Status:** invariant from v1.1.0 onwards. Documented after the
v1.1.0 EACCES playback regression (see `CHANGELOG.md` 1.1.0
*"Recording playback Tunnel error caused by EACCES on the shared
recordings volume"*).

Session `.guac` recordings are stored on the shared `guac-recordings`
Docker volume, mounted into both the `guacd` and `backend`
containers at `/var/lib/guacamole/recordings`. The two containers run
as different POSIX users (Alpine guacd vs Debian backend), so a
defined permissions contract is required to keep playback working
without elevating either side's privileges.

**Writer side (guacd):**

- File ownership: `guacd:guacd` (uid/gid `100:101` inside the
  Alpine-based `strata/custom-guacd` image).
- File mode: `0640` — owner read/write, group read, no world access.
  This is hard-coded by upstream `guacamole-server`'s
  `recording.c` `open()` call and is not affected by the
  in-container `umask`.
- Directory mode: `0750` (set at image build by `chmod 0750
  /var/lib/guacamole/recordings`).
- The guacd entrypoint sets `umask 0027` defensively so any
  non-recording artefacts (e.g. sidecar metadata) also stay
  group-readable.

**Reader side (backend):**

- The backend runs `strata-backend` as the unprivileged `strata`
  user (`gosu strata` in `backend/entrypoint.sh`). The user's
  primary gid does not match the writer's gid by construction.
- On every container start, `backend/entrypoint.sh` reads the
  numeric gid off whichever guacd-written file is present in
  `/var/lib/guacamole/recordings`, falling back to the directory
  gid on first boot when the volume is empty.
- If the discovered gid does not already exist inside the backend
  container's `/etc/group`, a local group named `guac-recordings`
  is created with that gid. Either way, the `strata` user is added
  to the group via `usermod -aG`, becoming a supplementary-group
  member.
- After the supplementary-group bootstrap, standard POSIX
  group-read on the `0640` recording files is sufficient — no
  capabilities required at read time.

**What we deliberately do *not* do:**

- We do not use `DAC_OVERRIDE`. The backend's Linux capability
  set keeps `DAC_OVERRIDE` for the directory-management ops
  needed by ephemeral web-session storage (`/var/lib/strata`),
  but the recording-read path resolves through standard POSIX
  group-read. If `DAC_OVERRIDE` is dropped from the backend's
  capability set in a future hardening pass, recording playback
  continues to work.
- We do not `chown -R strata:strata /var/lib/guacamole` in the
  backend entrypoint (that line was previously present and was
  removed in v1.1.0). It races with in-flight guacd writes and
  destroys the gid signal the supplementary-group lookup needs.
- We do not chmod recordings to world-readable (`0644`). On a
  multi-tenant Linux host where the volume is bind-mounted from
  a shared directory, world-read would expose recording byte
  streams to any unrelated process under any unrelated UID on
  the host.

**Volume-driver compatibility:**

- Docker named volumes — works. The kernel preserves uid/gid
  natively across the overlay.
- Bind-mounts from the host — works as long as the host
  filesystem preserves uid/gid.
- NFSv3 / NFSv4 — works as long as the export preserves
  numeric ownership (default behaviour; broken only by
  `all_squash` or aggressive uid-mapping).
- CIFS / SMB — works only when the mount line uses
  `uid=,gid=` to pin file ownership; without it CIFS reports
  every file as the mount-time user and the gid bootstrap will
  short-circuit.

**Azure Blob Storage path is unaffected.** Recordings stored in
Azure (`recording.storage_type == "azure"`) stream over HTTPS
via `reqwest` and never touch the local filesystem; the
permissions model above is irrelevant for that storage backend.
Authentication for Azure-stored recordings is via the connection
string / managed identity sealed in Vault, not POSIX uid/gid.

---

## Session Keyboard Cleanup

**Status:** invariant from v1.1.0 onwards.

When an operator navigates away from an active session — whether
by clicking a sidebar entry, using the Command Palette, or
closing the session manager tab — the `SessionClient.tsx`
keyboard-effect cleanup path performs three operations *in this
order*:

1. Set `kb.onkeydown = null` and `kb.onkeyup = null` so any
   in-flight DOM keyboard event no longer reaches the tunnel.
2. Call `kb.reset()` on the `Guacamole.Keyboard` instance. This
   cancels the synthetic auto-repeat timer that
   `Guacamole.Keyboard.press()` starts at 500 ms and ticks every
   50 ms, and clears the internal `pressed[]` set.
3. Call `kb.disconnect()` to detach the listener from the
   container.

**Why step 2 matters from a security perspective.** Without the
explicit `kb.reset()`, a key held down at the moment of teardown
(e.g. an operator pressing Enter to confirm a Command Palette
selection that closes their current session) would leave a
synthetic-repeat `setInterval` running with stale references. If
the same effect re-attached on return — or if an attacker could
keep the page alive with stale callbacks reattached — the
remote target could continue receiving phantom keystrokes
without operator awareness, potentially confirming a dialog or
dispatching a queued shell command. The `kb.reset()` call
guarantees keystroke-clean teardowns and is exercised by both
the unit and Playwright suites.

---



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

## Notification Pipeline (Transactional Email)

Strata Client sends transactional email for managed-account checkout events. The pipeline is designed around three security objectives:

1. **No SMTP password ever sits in plaintext on disk.**
2. **No PII (justification text, passwords) leaks into the delivery audit table.**
3. **Opt-out suppression is itself audit-visible** so compliance teams can prove which messages were withheld and why.

### SMTP Credential Storage

The SMTP password is **hard-required to live in Vault**. The `PUT /api/admin/notifications/smtp` endpoint refuses to save credentials when the configured Vault backend is sealed or running in stub mode — a half-configured install fails loudly instead of silently writing the password to `system_settings` in plaintext. The seal/unseal path uses the same `crate::services::vault::seal_setting` helper as `recordings_azure_access_key`, so the credential rests under the same Transit envelope as every other sealed setting (rotated by `vault operator rotate`, rewrappable via the established Transit rotate + rewrap path documented in [ADR-0006](adr/ADR-0006-vault-transit-envelope.md)).

The plaintext SMTP username is stored in `system_settings.smtp_username` because most relays treat it as a non-secret routing identifier, but the design treats `(host, port, username, password)` as a single sensitive bundle when surfacing the configuration over the API: `GET /api/admin/notifications/smtp` returns `password_set: bool` instead of the password itself.

### Dispatch Block on Misconfiguration

If `smtp_from_address` is empty, the dispatcher refuses to send and emits a `notifications.misconfigured` audit event. This prevents:

- An admin enabling the master switch before configuring `From:` and discovering after the fact that hundreds of deliveries hit the SMTP relay with an invalid envelope sender (which most relays reject as 5xx, marking otherwise-recoverable rows as permanently failed).
- A stack restart silently re-enabling dispatch when settings have been partially cleared.

The same audit event fires when `smtp_enabled` is false at dispatch time, so on-call engineers can correlate a missing notification with the precise reason it was withheld.

### Per-User Opt-Out (Audit-Aware)

`users.notifications_opt_out` is a single boolean column. When `true`, the dispatcher suppresses **all** transactional messages for that recipient and writes:

1. An `email_deliveries` row with `status='suppressed'`, `attempts=0`, `last_error=NULL`.
2. A `notifications.skipped_opt_out` entry to the append-only audit log, including the template key and the related entity ID (typically the checkout request UUID).

The **self-approved audit notice** explicitly bypasses the flag (the dispatcher branches on `ignores_opt_out`). This is intentional: that template exists to give security teams a record of self-approvals, not to inform the requester. Allowing users to opt out of an audit event would defeat its purpose.

### PII Boundary in `email_deliveries`

The rendered email body is **not** stored in `email_deliveries`. The table retains only:

- `template_key` (e.g. `checkout_pending`)
- `recipient_user_id` (or `NULL` for external audit recipients)
- `recipient_email`
- `subject`
- `related_entity_type` / `related_entity_id` (typically `checkout_request` / UUID)
- `status`, `attempts`, `last_error`, `created_at`, `sent_at`

Justification text — the most sensitive field in a checkout flow — therefore lives in exactly one place (`password_checkout_requests.justification`) and is reachable through one access path (the existing checkout-detail endpoint, which already enforces `can_manage_system` or approver-scope membership). An attacker who compromises the `email_deliveries` table cannot reconstruct the message content; they can only learn that someone received an email about a particular checkout.

### Template Rendering Hardening

- **Custom `xml_escape`.** All Tera context values are escaped through a hand-rolled 5-character helper (`& < > " '`). `ammonia::clean_text` was evaluated and rejected — it over-escapes (encodes spaces as `&#32;`), which breaks layout and bloats payload size. The custom helper is intentionally minimal and reviewed in-tree.
- **Standalone templates.** mrml's XML parser does not tolerate Tera's `{% include %}` mechanism; whitespace from the include directive breaks parsing. Templates are self-contained, which also makes review easier (one file = one email).
- **No `<script>` / `<style>` injection surface.** MJML is a structural DSL, not a templating language for arbitrary HTML. Tera substitutions land inside `<mj-text>` or `<mj-button>` content, which mrml renders as table-cell `<td>` text — there is no JavaScript surface to compromise even if an upstream value escapes `xml_escape`.

### Retry Worker Safety

The background retry worker (`services::email::worker`) operates under three safeguards:

1. **Per-attempt timeout** of 120 seconds caps the blast radius of a single hung connection.
2. **Permanent failures (5xx) are not retried** — the classifier in `SmtpTransport::send` distinguishes 4xx (transient) from 5xx (permanent) before incrementing `attempts`. A 5xx-rejected recipient cannot turn into thousands of redundant attempts.
3. **Hard cap of 3 attempts** with exponential backoff. After the third failure the row transitions to a terminal state (audit event `notifications.abandoned`) and is not selected by the worker again.

### Audit Events

| Event | Trigger |
|---|---|
| `notifications.skipped_opt_out` | Recipient has `users.notifications_opt_out = true` and the template honours the flag |
| `notifications.misconfigured` | Dispatcher refused to send because `smtp_from_address` is empty or `smtp_enabled = false` |
| `notifications.abandoned` | Retry worker gave up on a delivery row after 3 failed attempts |

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
- **Per-user preferences blob (`/api/user/preferences`):** the database column is a free-form `JSONB`, but the route handler enforces that the top-level value MUST be a JSON object. Arrays, scalars, and `null` are rejected with `400`. The blob is **never executed** server-side — it is opaque to the backend; only the frontend interprets known keys. Keys the frontend doesn't recognise are preserved on round-trip but otherwise inert. This means a compromised end-user account cannot escalate by writing arbitrary code into the blob; the worst case is denial-of-service against that user's own UI by storing nonsense values for known keys, which the user can self-recover from by hitting **Reset to default** in the Profile page.

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

### Share-link hardening (v0.26.0)

The share-tunnel path receives additional hardening on top of the raw rate limit:

- **Soft-delete filter.** `resolve_share_token()` joins against `connections` with `WHERE connections.deleted_at IS NULL`, so share links for soft-deleted connections are treated as invalid rather than silently proxying to a ghost target.
- **Token-prefix logging.** Neither the raw share token nor a full hash is written to the audit log. Instead, the first 8 characters of `sha256(token)` are recorded on `connection.share_rate_limited` and `connection.share_invalid_token` events. This preserves the ability to correlate a burst of failed requests to a single token (brute-force detection) without creating a rainbow-table target.
- **Invalid-token audit event.** Rejected lookups now emit `connection.share_invalid_token` with the token prefix + client IP. Previously these returned 404 silently.
- **Rate-limit audit event.** Over-the-limit requests emit `connection.share_rate_limited` so operators can see which tokens are being hammered without scraping access logs.

---

## Backend error-message sanitization

As of v0.26.0, every code path that surfaces an `AppError::Vault` or other transport-level failure to an HTTP response goes through a sanitizer that strips:

- Absolute filesystem paths (e.g. `/var/lib/strata/…` in the Vault unseal-key error path)
- Vault Transit key names and key-ring versions
- Internal URL components (protocol, host, port) for the embedded Vault
- Stack frames from nested `anyhow` chains

The sanitized message is always safe to render in the UI; the full chain is still written to the backend log at `error!` level for operators. This closes a class of information-disclosure bugs where a misconfigured Vault would leak paths or internal network topology to the browser.

---

## Test-only transport isolation

The notifications subsystem's `StubTransport` (used by unit tests to assert that emails would have been sent without actually connecting to an SMTP server) is now gated behind `#[cfg(test)]`. In release builds the stub type does not exist and cannot be selected by any configuration path, eliminating the risk of a misconfigured production deployment silently dropping every transactional email into `/dev/null`.

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
| `cap_add` (minimal) | `frontend` (`NET_BIND_SERVICE`), `backend` / `postgres-local` (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`), `vault` (`IPC_LOCK`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`) |
| `read_only: true` + `tmpfs` | `frontend` |
| Resource limits (`cpus`, `memory`) | `guacd`, `backend`, `postgres-local` |

---

## Session Recording & Retention

Session recording captures are managed by a background sync task:

- **Retention policy** — Recordings older than the configured `recordings_retention_days` (default: 30) are automatically deleted on every sync pass. Starting in v0.22.0, retention is enforced **end-to-end**: each pass selects every `recordings` row older than the window, deletes the backing artefact (Azure blob via the Transit-sealed storage account key, or local file from the recordings volume), and then deletes the database row. Totals are logged as `purged_azure`, `purged_local`, and `deleted_rows` for auditability.
- **Azure Blob sync** — When Azure Blob storage is configured, local recordings are uploaded and then deleted locally to prevent disk growth. Retention (above) also removes the remote blob once the row ages out.
- **Write protection** — Files modified within the last 30 seconds are skipped to avoid deleting active recordings.
- **Configurable** — Retention period and storage type (local / Azure Blob) are set via the Admin UI.

---

## User Lifecycle Retention

Soft-deleted users (admin UI → Users → Delete) are recoverable for a configurable window before the background cleanup worker removes their record and any associated recordings:

- **Setting** — `user_hard_delete_days` (default **90 days**, valid range 1–3650). Editable in Admin Settings → Security → Data Retention.
- **Worker** — `backend/src/services/user_cleanup.rs` runs every 24 h. It reads the current setting, pre-purges the user's recordings (Azure + local), then executes `DELETE FROM users WHERE deleted_at < now() - make_interval(days => $1)`.
- **SQL safety** — The day window is parameter-bound via `make_interval(days => $1)` after an `i32` parse + positive-integer guard. No string interpolation is used on any retention query.
- **Effect of shortening the window** — Shortening does not retroactively delete users; the next worker pass simply applies the new window and removes any row whose `deleted_at` is already older than the new threshold.

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

## TLS & Reverse Proxy

TLS is terminated by the frontend **nginx** container, which also
acts as the gateway for `/api/*` (proxied to the backend) and the
guacamole tunnel WebSocket. The split config files
(`common.fragment`, `http_only.conf`, `https_enabled.conf`) are
selected at startup by `ssl-init.sh` based on whether PEM material
is present in `/etc/nginx/ssl`.

When TLS is enabled the gateway provides:

- **HTTPS** — operator-supplied certificates mounted read-only from
  `./certs/` into `/etc/nginx/ssl`. Bring your own Let's Encrypt /
  ACME client, or terminate TLS at an upstream load balancer and
  point the backend at HTTP only.
- **Automatic HTTP-to-HTTPS redirect** — enabled when certs are
  present.
- **Security headers** — `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and the
  `Server` header stripped.
- **Compression** — gzip on static assets and API responses.

The nginx container runs unprivileged with `cap_drop: ALL` and
adds back only `NET_BIND_SERVICE` so it can bind to ports 80/443.

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

1. **TLS everywhere** — supply certificates to the frontend nginx gateway via `./certs/`, or terminate TLS at an external reverse proxy / load balancer
2. **External Vault** — for production, use an external Vault cluster with Shamir's Secret Sharing (multiple key shares) and AppRole authentication instead of a single unseal key and root token
3. **Vault AppRole** — use AppRole authentication instead of static tokens; rotate credentials regularly
4. **Restrict CORS** — set `STRATA_ALLOWED_ORIGINS` to your specific frontend domain (e.g., `https://strata.example.com`).
5. **Database roles** — grant `INSERT, SELECT` only on `audit_logs` to enforce append-only at the DB level
6. **Network policies** — in Kubernetes, use NetworkPolicies to restrict inter-pod communication
7. **Secret rotation** — rotate Vault tokens and database credentials periodically
8. **Log forwarding** — forward the backend's structured JSON logs to a SIEM or log aggregation service
9. **Container scanning** — scan the custom guacd and backend images for vulnerabilities in CI
10. **Backup unseal key** — if using the bundled Vault, back up the `backend-config` volume containing the unseal key and root token

---

## Web Sessions and VDI: extended threat model

Strata's `web` and `vdi` connection types extend the attack surface
because the backend takes on the role of a workload supervisor — see
[`web-sessions.md`](web-sessions.md) and [`vdi.md`](vdi.md) for the
operator-facing documentation.

### Web Sessions (`web` protocol)

- **SSRF.** A `web` connection asks the backend to dial an arbitrary
  URL. The backend resolves the host and refuses unless **every**
  resolved IP falls inside the operator's CIDR allow-list
  (`system_settings.web_allowed_networks`). The allow-list is
  fail-closed: an empty list denies all outbound traffic. This
  defeats DNS rebinding via mixed A records.
- **Profile reuse.** Each Chromium kiosk launches with a fresh
  `--user-data-dir=/tmp/strata-chromium-{uuid}`. The directory is
  destroyed at session end. Bookmarks, cookies, and history do not
  survive the tab close.
- **Autofill secrecy.** Where the optional Login Data SQLite writer
  is used, the AES-128-CBC encryption key is derived per-session via
  PBKDF2-SHA1 and the SQLite file lives only in the ephemeral profile
  directory. The DB is destroyed with the profile.
- **CDP exposure.** The Chrome DevTools Protocol port binds to
  `127.0.0.1` only — never the Docker bridge. Login automation runs
  inside the backend's network namespace.
- **Domain restriction.** Chromium's `--host-rules` rewrites every
  non-allowed host to `~NOTFOUND`. This is in addition to the egress
  CIDR allow-list, not a replacement for it.
- **Trusted CA bundles (v1.2.0; v1.3.0 trust-store fix).** Operators
  can attach a reusable PEM bundle to a `web` connection via the
  **Trusted Certificate Authority** dropdown in the connection editor.
  At spawn time the backend writes the PEM into a per-session NSS
  database under `<user-data-dir>/.pki/nssdb` via
  `certutil -N --empty-password` + `certutil -A -d sql:<dir> -n <label>
  -t "C,," -i <pem>` (provided by the `libnss3-tools` apt package,
  baked into the backend image). **As of v1.3.0** the kiosk spawner
  also sets `HOME=<user_data_dir>` on the Chromium child process
  because Chromium on Linux resolves the NSS trust-store path relative
  to `$HOME` (always `$HOME/.pki/nssdb`), **not** relative to
  `--user-data-dir`. Without this override (the v1.2.0 behaviour),
  Chromium consulted the strata user's actual home — which never
  contained the imported root — and every internally-signed site
  tripped `NET::ERR_CERT_AUTHORITY_INVALID` despite a successful
  `certutil -A`. Trust grants do not survive the tab close — the NSS
  DB lives inside the ephemeral profile dir and is destroyed with it
  by the eviction-on-disconnect path (see "Kiosk lifecycle" below).
  The PEM holds certificate chains (signatures over public keys), so
  it is treated as **public material** and is *not* envelope-encrypted
  via Vault — read access to the PEM column requires
  `can_manage_system`. The dropdown for non-admin users
  (`GET /api/user/trusted-cas`) returns only `{id, name, subject}`
  and deliberately omits the PEM bytes. Deletion is reference-guarded:
  `DELETE /api/admin/trusted-cas/{id}` refuses with HTTP 400 when at
  least one row in `connections` (with `protocol = 'web'`) still
  references the bundle via `extra->>'trusted_ca_id'`. CRUD events
  emit `trusted_ca.created`, `trusted_ca.updated`, and
  `trusted_ca.deleted` audit rows.
- **Sandbox semantics — `--no-sandbox` + `--test-type` (v1.3.0).**
  The kiosk runs as root inside the backend container, so the
  spawner has always had to pass `--no-sandbox`; v1.3.0 also passes
  `--test-type` to suppress the resulting *"You are using an
  unsupported command-line flag…"* yellow infobar (and a handful of
  other end-user prompts that have no meaning inside a single-tab
  kiosk). **`--test-type` does not disable the sandbox.** Rendering,
  network stack, mojo IPC, JIT, and origin isolation are unchanged.
  The flag is paired exclusively with `--no-sandbox` in the argv
  builder; two unit tests pin the pairing so a future refactor can't
  silently emit `--test-type` on its own. The kiosk's threat model
  (single-tab, X-display-isolated per session, ephemeral profile,
  egress allow-list, NSS trust limited to operator-uploaded roots)
  is unaffected.
- **Kiosk lifecycle — eviction-on-disconnect (v1.3.0).** The
  WebSocket-tunnel route now calls `web_runtime.evict()` after the
  proxy loop returns, dropping the registry's `Arc<WebSessionHandle>`.
  Refcount-zero `Drop` SIGKILLs both child processes, releases the
  X-display slot and CDP port, and removes the per-session profile
  tempdir (with its NSS DB inside). This closes a resource-exhaustion
  vector that existed in v1.2.0 — without eviction, an attacker
  controlling a browser session could open and rapidly close kiosks
  to pin display slots `:100..:199` and CDP ports `9222..9321`,
  eventually triggering `WebRuntimeError::DisplayExhausted` for
  legitimate users. It also guarantees that NSS trust grants made for
  one session cannot leak into the next session; closing the tab
  destroys the per-session NSS DB along with the rest of the profile.

### VDI Desktop Containers (`vdi` protocol)

- **`docker.sock` is host root.** Mounting `/var/run/docker.sock` into
  the backend container is effectively granting the backend the
  ability to spawn containers — including privileged ones — on the
  host. Operators must opt in explicitly via the
  [`docker-compose.vdi.yml`](../docker-compose.vdi.yml) overlay file
  (the default compose graph deliberately omits the mount). A
  sidecar driver running in a separate, more locked-down namespace
  is recommended for production deployments.
- **Image whitelist.** Only operator-approved images may be
  referenced as the `image` field of a `vdi` connection. Matching is
  strict equality — there is no glob, tag, or digest substitution
  because that would let a connection silently pin to a different
  artifact than the operator approved. Whitelist failures emit a
  `vdi.image.rejected` audit event.
- **Reserved env keys.** `VDI_USERNAME` and `VDI_PASSWORD` are
  always supplied at runtime by the backend. Even if these keys are
  smuggled into the connection's `env_vars`, they are stripped at
  parse time and overwritten at injection time.
- **Ephemeral credentials (v0.30.0).** Operators do not have to
  populate `username`/`password` on a VDI connection row. When the
  credential cascade resolves to no password, the runtime auto-
  provisions a sanitised POSIX username (deterministic per Strata
  user) and a fresh 24-character alphanumeric password per spawn.
  The password is never written to disk on the backend; it lives in
  the spawned container's environment block and is invalidated when
  the container is destroyed.
- **Persistent home isolation.** Persistent homes are bind-mounted
  per `(connection_id, user_id)` pair, never shared. A user with
  access to two VDI connections gets two homes; sharing one
  connection across users does not share the home.
- **TLS overrides are scoped (v0.30.0).** `ignore-cert=true` and
  `security=any` are forced for `vdi` connections only — RDP
  connections to operator-managed Windows hosts continue to honour
  per-connection TLS settings. The forced overrides are safe for VDI
  because both ends of the RDP hop are Strata-controlled and the
  traffic stays on the internal `guac-internal` Compose bridge.
- **Reaper semantics.** The xrdp WTSChannel disconnect frame
  classifies tab-close vs logout vs idle-timeout. Logouts and
  idle-timeouts destroy the container immediately; tab-closes retain
  for reuse within the idle window. Each destroy emits a
  `vdi.container.destroy` audit event with the classified reason.
- **Concurrency.** `system_settings.max_vdi_containers` bounds the
  number of simultaneous containers per backend replica (admin UI:
  Admin → Settings → VDI). Operators should set this to match the
  host's CPU / RAM budget; the default is unbounded.
- **Network resolution (v0.30.0).** The `STRATA_VDI_NETWORK` env var
  selects which Docker network the spawned containers join. Default
  in the overlay is the Compose-prefixed `guac-internal`. Operators
  who deploy outside Compose must override this to a network that
  exists on their Docker daemon.
- **Socket permission handling (v0.30.0).** The backend runs as the
  unprivileged `strata` user. `entrypoint.sh` either creates a
  `docker-host` group at the socket's GID (Linux distros) or
  `chgrp` + `chmod g+rw` the bind-mount in place (Docker Desktop GID
  0). The socket access decision is logged at startup so operators
  can audit which path the entrypoint took.
