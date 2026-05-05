# API Reference

Base URL: `http://localhost:8080/api` (or via nginx at `http://localhost:3000/api`)

All authenticated endpoints require an `Authorization: Bearer <token>` header with a valid OIDC access token.

---

## Public Endpoints

These endpoints require no authentication.

### `GET /api/health`

Health check.

**Response** `200 OK`
```json
{ "status": "ok" }
```

### `GET /api/status`

System boot phase and database connectivity.

**Response** `200 OK`
```json
{
  "phase": "running",
  "sso_enabled": true,
  "local_auth_enabled": true
}
```

`phase` is either `"setup"` (first boot, no config) or `"running"`.
`vault_configured` indicates whether a Vault backend (bundled or external) is active.

### `POST /api/setup/initialize`

First-boot initialization. Only available when `phase == "setup"`.

**Request Body**
```json
{
  "database_mode": "local",
  "database_url": null,
  "vault_mode": "local",
  "vault_address": null,
  "vault_token": null,
  "vault_transit_key": "guac-master-key"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `database_mode` | `"local"` \| `"external"` | Yes | Use bundled DB or provide a URL |
| `database_url` | string | If external | PostgreSQL connection string |
| `vault_mode` | `"local"` \| `"external"` | No | `"local"` uses the bundled Vault; `"external"` connects to a user-provided instance; omit to skip |
| `vault_address` | string | If external | Vault server URL |
| `vault_token` | string | If external | Vault authentication token |
| `vault_transit_key` | string | No | Transit engine key name (default: `guac-master-key`) |

**Response** `200 OK`
```json
{ "status": "initialized" }
```

---

## Authentication Endpoints

### `POST /api/auth/login`

Standard local username/password login. Only available if `local_auth_enabled` is true. Returns an access token in the response body and sets a refresh token as an `HttpOnly` cookie.

**Request Body**
```json
{
  "username": "admin",
  "password": "password"
}
```

**Response** `200 OK`
```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 1200,
  "user": {
    "id": "uuid",
    "username": "admin",
    "role": "admin",
    "can_manage_system": true
  }
}
```

**Set-Cookie**: `refresh_token=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age=28800`

### `GET /api/auth/sso/login`

Initiates the OIDC Single Sign-On flow. Redirects the user to the configured OIDC issuer's authorization endpoint. Only available if `sso_enabled` is true and properly configured.

**Success**: `303 See Other` redirect to the issuer.

### `GET /api/auth/sso/callback`

The handle for the OIDC provider's callback. Exchange the authorization code for an ID token and establishes a session.

**Query Parameters**
- `code`: The authorization code from the issuer.
- `state`: The CSRF state token.

**Success**: `303 See Other` redirect back to the frontend dashboard.

### `POST /api/auth/refresh`

Exchange a valid refresh cookie for a new access token. The refresh token is sent automatically as an `HttpOnly` cookie.

**Request**: No body required. The refresh token cookie is sent automatically by the browser.

**Response** `200 OK`
```json
{
  "access_token": "eyJ...",
  "expires_in": 1200
}
```

**Error** `401 Unauthorized` — refresh cookie missing, expired, or revoked.

### `PUT /api/auth/password`

Change the authenticated user's password. Requires a valid access token. Revokes the current session on success (user must re-login).

**Request Body**
```json
{
  "current_password": "old-password",
  "new_password": "new-secure-password"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `current_password` | string | Yes | The user's current password |
| `new_password` | string | Yes | New password (minimum 12 characters, maximum 1024) |

**Response** `200 OK`
```json
{ "status": "password_changed" }
```

**Errors:**
- `400` — new password does not meet policy requirements
- `401` — current password incorrect
- `404` — user not found or not a local auth user

### `POST /api/auth/logout`

Invalidates the current access token and refresh cookie. The access token JTI is added to the server-side revocation list.

**Headers**: `Authorization: Bearer <token>`

**Response** `200 OK`
```json
{ "status": "logged_out" }
```

### `GET /api/auth/check`

Hydrate the current user's session state. Always returns 200 — unauthenticated requests return `user: null`. This is the primary endpoint the frontend uses on page load to populate user state (not `/api/user/me`).

**Response** `200 OK`
```json
{
  "user": {
    "id": "uuid",
    "username": "jdoe",
    "role": "user",
    "can_manage_system": false,
    "can_manage_users": false,
    "can_manage_connections": false,
    "can_view_audit_logs": false,
    "can_view_sessions": true,
    "vault_configured": true,
    "is_approver": true
  }
}
```

`is_approver` is `true` when the user has at least one entry in `approval_role_assignments`. The frontend uses this to conditionally show the "Pending Approvals" sidebar link.

---

## Admin Endpoints

All admin endpoints require authentication **and** the `admin` role.

### Settings

#### `GET /api/admin/settings`

Returns all system settings as key-value pairs.

**Response** `200 OK`
```json
{
  "sso_enabled": "true",
  "sso_issuer_url": "https://keycloak.example.com/realms/strata",
  "sso_client_id": "strata",
  "sso_client_secret": "",
  "kerberos_enabled": "false",
  "kerberos_realm": "",
  "kerberos_kdc": "",
  "kerberos_admin_server": "",
  "recordings_enabled": "false",
  "recordings_retention_days": "30"
}
```

#### `PUT /api/admin/settings`

Bulk update settings.

**Request Body**
```json
{
  "settings": [
    { "key": "recordings_retention_days", "value": "60" }
  ]
}
```

#### `PUT /api/admin/settings/database`

Migrate to an external database.

**Request Body**
```json
{ "database_url": "postgresql://user:pass@db.example.com:5432/strata" }
```

#### `PUT /api/admin/settings/sso`

Configure OIDC / SSO.

**Request Body**
```json
{
  "issuer_url": "https://keycloak.example.com/realms/strata",
  "client_id": "strata-client",
  "client_secret": "secret"
}
```

#### `PUT /api/admin/settings/auth-methods`

Configure which authentication methods are globally enabled.

**Request Body**
```json
{
  "sso_enabled": true,
  "local_auth_enabled": true
}
```

> [!IMPORTANT]
> At least one authentication method must remain enabled at all times.

#### `PUT /api/admin/settings/kerberos`

Configure Kerberos. Writes `krb5.conf` to the shared volume.

**Request Body**
```json
{
  "realm": "EXAMPLE.COM",
  "kdc": "10.0.0.5",
  "admin_server": "10.0.0.5"
}
```

#### `PUT /api/admin/settings/recordings`

Toggle session recording.

**Request Body**
```json
{
  "enabled": true,
  "retention_days": 30
}
```

#### `PUT /api/admin/settings/vault`

Configure or switch Vault mode.

**Request Body (Bundled)**
```json
{
  "mode": "local",
  "transit_key": "guac-master-key"
}
```

**Request Body (External)**
```json
{
  "mode": "external",
  "address": "http://vault:8200",
  "token": "s.xxxxxxxxx",
  "transit_key": "guac-master-key"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `mode` | `"local"` \| `"external"` | Yes | Bundled or external Vault |
| `address` | string | If external | Vault server URL |
| `token` | string | If external | Vault authentication token |
| `transit_key` | string | No | Transit key name (default: `guac-master-key`) |

#### `PUT /api/admin/settings/dns`

Configure custom DNS servers and search domains for guacd containers. Validated entries are saved to the database and written to a shared Docker volume as `resolv.conf`. Requires a `docker compose restart guacd` to take effect.

**Request Body**
```json
{
  "dns_enabled": true,
  "dns_servers": "10.0.0.1, 10.0.0.2",
  "dns_search_domains": "example.local, corp.example.com"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `dns_enabled` | boolean | Yes | Enable or disable custom DNS configuration |
| `dns_servers` | string | Yes | Comma-separated list of IPv4 DNS server addresses |
| `dns_search_domains` | string | No | Comma-separated list of DNS search domains (max 6). Required for `.local` zones. Equivalent to `Domains=` in `systemd-resolved` or `search` in `resolv.conf` |

**Response** `200 OK`
```json
{
  "status": "ok",
  "restart_required": true,
  "message": "DNS configuration saved. Restart guacd containers to apply changes."
}
```

**Errors:**
- `400 Bad Request` — invalid IPv4 address or invalid domain name
- `500 Internal Server Error` — failed to write `resolv.conf` to the shared volume

### Health

#### `GET /api/admin/health`

Detailed service health status.

**Response** `200 OK`
```json
{
  "database": {
    "connected": true,
    "mode": "local",
    "host": "postgres-local:5432"
  },
  "guacd": {
    "reachable": true,
    "host": "guacd",
    "port": 4822
  },
  "vault": {
    "configured": true,
    "mode": "local",
    "address": "http://vault:8200"
  }
}
```

### Roles

#### `GET /api/admin/roles`

List all roles with their full permission matrix.

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "name": "admin",
    "can_manage_system": true,
    "can_manage_users": true,
    "can_manage_connections": true,
    "can_view_audit_logs": true,
    "can_create_users": true,
    "can_create_user_groups": true,
    "can_create_connections": true,
    "can_use_quick_share": true,
    "can_create_sharing_profiles": true,
    "can_view_sessions": true
  }
]
```

| Field | Type | Description |
|---|---|---|
| `can_manage_system` | boolean | Super-admin: system settings, Vault, SSO, bypass for all other checks |
| `can_manage_users` | boolean | User CRUD, role assignment, password resets |
| `can_manage_connections` | boolean | Connection CRUD, folders, sharing profiles, AD sync, Kerberos |
| `can_view_audit_logs` | boolean | Audit log listing and export |
| `can_create_users` | boolean | Provision new user accounts |
| `can_create_user_groups` | boolean | Role CRUD |
| `can_create_connections` | boolean | Create and manage connections **and** connection folders (unified as of v0.24.0) |
| `can_use_quick_share` | boolean | Upload files via the in-session Quick Share endpoint (user-facing permission, not admin) |
| `can_create_sharing_profiles` | boolean | Generate live session share links |
| `can_view_sessions` | boolean | NVR observation, active session listing, kill session |

#### `POST /api/admin/roles`

Create a new role. All permission fields are optional and default to `false`.

**Request Body**
```json
{
  "name": "operators",
  "can_view_sessions": true,
  "can_use_quick_share": true
}
```

### Connections

#### `GET /api/admin/connections`

List all remote connections.

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "name": "Production Server",
    "protocol": "rdp",
    "hostname": "10.0.1.50",
    "port": 3389,
    "domain": "CORP",
    "description": "Primary production RDP host",
    "group_id": "uuid",
    "last_accessed": "2026-04-05T14:30:00Z",
    "health_status": "online",
    "health_checked_at": "2026-04-20T10:02:00Z"
  }
]
```

`health_status` is one of `"online"`, `"offline"`, or `"unknown"` (not yet checked). Updated automatically every 2 minutes by the background health check worker.

#### `POST /api/admin/connections`

Create a new connection.

**Request Body**
```json
{
  "name": "Production Server",
  "protocol": "rdp",
  "hostname": "10.0.1.50",
  "port": 3389,
  "domain": "CORP",
  "description": "Primary production RDP host",
  "group_id": "uuid-of-group"
}
```

| Field | Type | Required | Default |
|---|---|---|---|
| `name` | string | Yes | — |
| `protocol` | `"rdp"` \| `"ssh"` \| `"vnc"` \| `"web"` \| `"vdi"` \| `"kubernetes"` | Yes | — |
| `hostname` | string | Yes | — |
| `port` | integer | No | 3389 |
| `domain` | string | No | null |
| `description` | string | No | `""` |
| `group_id` | UUID | No | null |

#### `PUT /api/admin/role-connections`

Map a role to a set of connections (replaces existing mappings).

**Request Body**
```json
{
  "role_id": "uuid",
  "connection_ids": ["uuid1", "uuid2"]
}
```

### Connection Groups

#### `GET /api/admin/connection-groups`

List all connection groups.

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "name": "Production Servers",
    "parent_id": null
  },
  {
    "id": "uuid",
    "name": "EU Region",
    "parent_id": "uuid-of-parent"
  }
]
```

#### `POST /api/admin/connection-groups`

Create a new connection group.

**Request Body**
```json
{
  "name": "Production Servers",
  "parent_id": null
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Group display name |
| `parent_id` | UUID | No | Parent group for nesting (null = top-level) |

#### `PUT /api/admin/connection-groups/:id`

Update a connection group.

**Request Body**
```json
{
  "name": "Updated Name",
  "parent_id": "uuid-of-parent"
}
```

#### `DELETE /api/admin/connection-groups/:id`

Delete a connection group. Connections in the group are moved to ungrouped.

**Response** `200 OK`
```json
{ "status": "deleted" }
```

### Users

#### `GET /api/admin/users`

List all users.

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "username": "jdoe",
    "sub": "keycloak-subject-id",
    "role_name": "admin"
  }
]
```

#### `POST /api/admin/users/:id/reset-password`

Force-reset a user's password. Generates a new random 16-character password and returns it once.

**Response** `200 OK`
```json
{
  "password": "aB3xK9mR2pQ7wZ1v"
}
```

**Errors:**
- `404` — user not found or not a local auth user

### Audit Logs

#### `GET /api/admin/audit-logs`

Paginated audit log entries (newest first).

**Query Parameters**

| Param | Type | Default | Max |
|---|---|---|---|
| `page` | integer | 1 | — |
| `per_page` | integer | 50 | 200 |

**Response** `200 OK`
```json
[
  {
    "id": 42,
    "created_at": "2026-04-04T12:00:00Z",
    "user_id": "uuid",
    "action_type": "credential.updated",
    "details": { "connection_id": "uuid" },
    "current_hash": "a1b2c3..."
  }
]
```

### Active Sessions (NVR)

#### `GET /api/admin/sessions`

List all currently active tunnel sessions. Each entry includes the session's ring buffer depth and bandwidth counters.

**Response** `200 OK`
```json
[
  {
    "session_id": "uuid-1681234567890",
    "connection_id": "uuid",
    "connection_name": "Production Server",
    "protocol": "rdp",
    "user_id": "uuid",
    "username": "jdoe",
    "started_at": "2026-04-06T10:30:00Z",
    "buffer_depth_secs": 287,
    "bytes_from_guacd": 52428800,
    "bytes_to_guacd": 1048576
  }
]
```

#### `GET /api/admin/sessions/:session_id/observe`

Upgrades to a WebSocket connection that replays buffered Guacamole instructions and then forwards live frames in real-time. The admin observer is read-only — input is not forwarded to the target session.

**Path Parameter**: `session_id` (string)

**Query Parameters**:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `token` | string | — | JWT access token (WebSocket auth) |
| `offset` | integer | 300 | Seconds of buffer to replay (0 = live only, 300 = full 5-minute buffer) |

**Flow**:
1. Backend injects the last known `size` instruction so the observer's display initialises at the correct dimensions
2. Replays buffered frames from the requested offset at maximum speed
3. Switches to real-time broadcast of live frames from the tunnel
4. Returns `404` if the session ID is invalid or the session has ended

### Metrics

#### `GET /api/admin/metrics`

Aggregate metrics across all active tunnel sessions.

**Response** `200 OK`
```json
{
  "active_sessions": 12,
  "total_bytes_from_guacd": 629145600,
  "total_bytes_to_guacd": 12582912,
  "sessions_by_protocol": {
    "rdp": 8,
    "ssh": 3,
    "vnc": 1
  }
}
```

| Field | Type | Description |
|---|---|---|
| `active_sessions` | integer | Total number of active tunnel sessions |
| `total_bytes_from_guacd` | integer | Cumulative bytes received from guacd across all sessions |
| `total_bytes_to_guacd` | integer | Cumulative bytes sent to guacd across all sessions |
| `sessions_by_protocol` | object | Session count grouped by protocol (rdp, ssh, vnc, web, vdi, kubernetes) |

---

### Kubernetes

#### `POST /api/admin/kubernetes/parse-kubeconfig`

Parses a pasted kubeconfig YAML and extracts the fields needed by the
connection editor for the `kubernetes` protocol. The endpoint is
**stateless** — it does not persist anything; in particular it
returns the user's client private key to the caller exactly once
and the caller is expected to immediately stash it in a credential
profile (see [security.md](security.md)).

**Request body**
```json
{
  "kubeconfig": "apiVersion: v1\nkind: Config\n...",
  "context": "prod-east"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `kubeconfig` | string | Yes | YAML body of the kubeconfig (1 MiB max) |
| `context`    | string | No  | Override `current-context`. If absent, falls back to `current-context`, then to the only context if exactly one is present |

**Response** `200 OK`
```json
{
  "server": "https://10.0.0.1:6443",
  "namespace": "my-ns",
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "client_cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "client_key_pem": "-----BEGIN PRIVATE KEY-----\n...",
  "current_context": "prod-east",
  "warnings": []
}
```

Every field is optional because real-world kubeconfigs are
heterogeneous — exec-plugin and bearer-token auth result in
warnings rather than errors, and file-path references for cert
material (`certificate-authority: /path/to/ca.crt`) are deliberately
**not** followed (the backend has no business reading random admin-
controlled file paths).

---

## User Endpoints

These endpoints require authentication (any role).

### `GET /api/user/me`

Current authenticated user profile, including all role permissions.

**Response** `200 OK`
```json
{
  "id": "uuid",
  "username": "jdoe",
  "role": "user",
  "terms_accepted_at": "2026-04-16T09:00:00Z",
  "can_manage_system": false,
  "can_manage_users": false,
  "can_manage_connections": false,
  "can_view_audit_logs": false,
  "can_create_users": false,
  "can_create_user_groups": false,
  "can_create_connections": false,
  "can_use_quick_share": false,
  "can_create_sharing_profiles": false,
  "can_view_sessions": true,
  "is_approver": true
}
```

### `POST /api/user/accept-terms`

Accept the recording disclaimer / terms of service. Sets `terms_accepted_at` to the current timestamp for the authenticated user. Must be called before the frontend will allow access to the application.

**Response** `200 OK`
```json
{ "ok": true }
```

### `GET /api/user/preferences`

Return the current authenticated user's UI preferences blob. The shape is
intentionally schema-less at the database layer — the frontend owns the
schema. Returns `{}` when no row has been written yet (i.e. the user has
never visited the Profile page).

Known keys today:

| Key                       | Type     | Default   | Description                                                                                                                                                                  |
| ------------------------- | -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commandPaletteBinding`   | `string` | `"Ctrl+K"` | (v0.30.1) Keybinding for the in-session Command Palette. Empty string disables the shortcut. Format: `"Ctrl+Shift+P"`, `"Alt+Space"`.                                       |
| `commandMappings`         | `array`  | `[]`       | (v0.31.0) User-defined `:command` palette mappings. See **`commandMappings` shape** below. Validated server-side; max 50 entries; triggers cannot collide with built-ins.   |

`Ctrl` in a binding matches either `event.ctrlKey` or `event.metaKey` so
the same stored value works on Windows/Linux and macOS without per-OS
configuration. Modifier-order is insensitive. `Cmd`, `Meta`, `Win`, and
`Super` are accepted aliases for the same modifier.

**Response** `200 OK`
```json
{
  "commandPaletteBinding": "Ctrl+K"
}
```

### `PUT /api/user/preferences`

Replace the current authenticated user's UI preferences blob wholesale
(idempotent UPSERT). Accepts and returns the same JSON shape. The body
**MUST** be a JSON object — arrays, strings, numbers, and `null` are
rejected with `400 Bad Request: validation error: preferences must be a
JSON object`.

Operators normally call this through the in-app Profile page; the
endpoint is documented for completeness and for downstream automation
that may want to provision a default keybinding for managed accounts.

**Request**
```json
{
  "commandPaletteBinding": "Ctrl+Shift+P"
}
```

**Response** `200 OK` — echoes the stored object.

#### `commandMappings` shape (v0.31.0)

Each element is a discriminated union with three required fields:

```jsonc
{
  "trigger": "prod",                          // ^[a-z0-9_-]{1,32}$, no built-in collision, unique within the array
  "action":  "open-connection",               // enum: open-connection | open-folder | open-tag | open-page
  "args":    { "connection_id": "<uuid>" }    // shape determined by `action`
}
```

| `action`           | `args` shape                                                                                                                                | Resolves to                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `open-connection`  | `{ "connection_id": "<uuid>" }`                                                                                                              | `/session/<id>`                                                                          |
| `open-folder`      | `{ "folder_id": "<uuid>" }`                                                                                                                  | `/dashboard?folder=<id>`                                                                  |
| `open-tag`         | `{ "tag_id": "<uuid>" }`                                                                                                                     | `/dashboard?tag=<id>`                                                                     |
| `open-page`        | `{ "path": "/dashboard" \| "/profile" \| "/credentials" \| "/settings" \| "/admin" \| "/audit" \| "/recordings" }`                            | `<path>`                                                                                 |
| `paste-text`       | `{ "text": "<freeform string, 1..4096 chars>" }`                                                                                              | Pushes `text` onto the active session's remote clipboard, then sends Ctrl+V keystrokes  |
| `open-path`        | `{ "path": "<freeform string, 1..1024 chars, no control chars>" }`                                                                            | Drives the Windows Run dialog: Win+R → paste path via clipboard → Enter. Useful for UNC shares (`\\server\share`), local folders (`C:\Users\…`), and `shell:` URIs (`shell:startup`). |

The four reserved built-in command names (`reload`, `disconnect`,
`fullscreen`, `commands`) cannot be used as a trigger. Validation is
enforced inside `services::user_preferences::set()`; a malformed
`commandMappings` entry causes the entire `PUT` to be rejected with
`400 Validation`.

### `POST /api/user/command-audit`

(v0.31.0) Record a `command.executed` audit row when the in-session
Command Palette executes a command. Called fire-and-forget by the
frontend before the action runs so the audit row captures intent even
if the action throws.

The handler hard-codes `action_type = "command.executed"` server-side —
operators cannot poison the audit-event taxonomy by passing a fake
`action_type` through the request body.

**Request**
```json
{
  "trigger":   ":reload",
  "action":    "reload",
  "args":      {},
  "target_id": null
}
```

**Validation**

| Field       | Rule                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`   | Matches `^:?[a-z0-9_-]{1,64}$` (the leading colon is accepted; the cap is 64 to leave headroom for future UI namespacing)                     |
| `action`    | One of `reload \| disconnect \| close \| fullscreen \| commands \| explorer \| open-connection \| open-folder \| open-tag \| open-page \| paste-text \| open-path` |
| `args`      | Opaque JSON value; persisted verbatim under `details.args`                                                                                   |
| `target_id` | Optional UUID string; persisted verbatim under `details.target_id` for cross-reference with the resolved target                              |

**Response** `200 OK`
```json
{ "ok": true }
```

The resulting `audit_logs` row uses
`details = { trigger, action, args, target_id }`. Chain-hash integrity
is enforced by the existing advisory-locked
`services::audit::log()` pipeline — see
[security.md → Audit Trail](security.md#audit-trail) for the chain
guarantees.

### `GET /api/roadmap`

Return all admin-set roadmap item status overrides. Available to any
authenticated user and used by the `/docs → Roadmap` page to overlay
persisted statuses on top of the frontend's built-in item definitions. Items
without a stored override fall back to the default status shipped in the
client bundle.

**Response** `200 OK`
```json
{
  "statuses": {
    "recording-screenshots": "In Progress",
    "notifications-managed-account-emails": "Shipped"
  }
}
```

### `GET /api/user/display-settings`

Returns the three display-related settings (timezone, time format, date format) without requiring admin privileges. Used by the frontend `SettingsContext` to format timestamps for all users.

**Response** `200 OK`
```json
{
  "display_timezone": "Europe/London",
  "display_time_format": "24h",
  "display_date_format": "DD/MM/YYYY"
}
```

### `GET /api/user/sessions`

List the calling user's own active tunnel sessions. Returns only sessions where `user_id` matches the authenticated user.

**Response** `200 OK`
```json
[
  {
    "session_id": "uuid-1681234567890",
    "connection_id": "uuid",
    "connection_name": "Dev Server",
    "protocol": "rdp",
    "user_id": "uuid",
    "username": "jdoe",
    "started_at": "2026-04-15T10:30:00Z",
    "buffer_depth_secs": 120,
    "bytes_from_guacd": 5242880,
    "bytes_to_guacd": 104857
  }
]
```

### `GET /api/user/recordings`

List the calling user's own historical recordings. Supports optional filtering and pagination.

**Query Parameters**:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `connection_id` | uuid | — | Filter by connection |
| `limit` | integer | 50 | Maximum results |
| `offset` | integer | 0 | Pagination offset |

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "session_id": "uuid",
    "connection_id": "uuid",
    "connection_name": "Dev Server",
    "user_id": "uuid",
    "username": "jdoe",
    "started_at": "2026-04-15T10:00:00Z",
    "duration_secs": 3600,
    "storage_path": "08c6776c-7fc1-4869-864e-c1a823864ad4-1776293653790.guac",
    "storage_type": "local"
  }
]
```

### `GET /api/user/recordings/:id/stream`

Stream a recording for playback. Only accessible for recordings owned by the authenticated user. Admin equivalent: `GET /api/admin/recordings/:id/stream` (no ownership filter).

**Path Parameter**: `id` (uuid) — recording ID

**Query Parameters**:

| Name    | Type    | Default | Description                                                                                                  |
| ------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `seek`  | integer | `0`     | Position in milliseconds to start playback from. `0` plays from the beginning.                                |
| `speed` | number  | `1.0`   | Playback rate clamped server-side to `[0.25, 16.0]`. Frontend players currently surface `1×`, `2×`, `4×`, `8×`. |

**Response**: `101 Switching Protocols` with WebSocket subprotocol `guacamole`. The server emits a Guacamole-style instruction stream paced to wall-clock time. Custom NVR opcodes used by the frontend players (`HistoricalPlayer.tsx`, `NvrPlayer.tsx`):

| Opcode        | Payload                              | Direction          | Meaning                                                                          |
| ------------- | ------------------------------------ | ------------------ | -------------------------------------------------------------------------------- |
| `nvrheader`   | `[total_ms]`                         | server → client    | Total duration of the recording in milliseconds, sent as the first instruction.  |
| `nvrprogress` | `[current_ms]`                       | server → client    | Wall-clock progress within the recording.                                        |
| `nvrseeked`   | `[position_ms]`                      | server → client    | Acknowledges a `seek` query parameter or in-stream seek request.                 |
| `nvrend`      | `[]`                                 | server → client    | Sent when playback reaches the end of the recording.                             |
| `nvrpause`    | `[]`                                 | client → server    | Pause playback timing without closing the WebSocket.                             |
| `nvrresume`   | `[]`                                 | client → server    | Resume from `nvrpause`.                                                          |
| `nvrspeed`    | `[multiplier]`                       | client → server    | Change playback rate without reconnecting.                                       |

**Storage backends**:

- `storage_type = "local"` — file is read from the shared `guac-recordings` Docker volume at `/var/lib/guacamole/recordings/<storage_path>`. Cross-container POSIX permissions are documented in [security.md — Recordings Volume](./security.md). EACCES on the file open closes the WebSocket immediately and the frontend renders a *"Tunnel error"* badge; check backend logs for *"Failed to open recording file"* to disambiguate from network-level failures.
- `storage_type = "azure"` — file is streamed from the configured Azure Storage container over HTTPS via `reqwest`. Auth is via the connection string / managed identity sealed in Vault; POSIX permissions are not involved in this path.

### `GET /api/user/connections`

Connections accessible to the authenticated user. Admin users see **all** connections; non-admin users see only connections mapped to their role via `role_connections`.

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "name": "Dev Server",
    "protocol": "rdp",
    "hostname": "10.0.1.10",
    "port": 3389,
    "description": "Development environment",
    "group_id": "uuid",
    "group_name": "Dev Servers",
    "last_accessed": "2026-04-05T10:00:00Z",
    "watermark": "none",
    "health_status": "online",
    "health_checked_at": "2026-04-18T10:02:00Z"
  }
]
```

`health_status` is one of `"online"`, `"offline"`, or `"unknown"` (not yet checked). `health_checked_at` is the timestamp of the last TCP probe (null if never checked).

### `GET /api/user/connections/:id/info`

Pre-connect information for a specific connection. Used by the session client to determine whether to show the credential prompt, and to provide expired profile metadata for in-line renewal.

**Path Parameter**: `id` (UUID) — connection ID

**Response** `200 OK`
```json
{
  "protocol": "rdp",
  "has_credentials": false,
  "ignore_cert": true,
  "watermark": "inherit",
  "file_transfer_enabled": true,
  "file_transfer_enabled": true,
  "expired_profile": {
    "id": "uuid",
    "label": "sa1_prochnickit ICS",
    "ttl_hours": 12,
    "managed_ad_dn": "CN=sa1_prochnickit,OU=Service Accounts,DC=example,DC=local",
    "ad_sync_config_id": "uuid",
    "can_self_approve": true
  }
}
```

| Field | Type | Description |
|---|---|---|
| `protocol` | string | `rdp`, `vnc`, `ssh`, `web`, `vdi`, or `kubernetes` |
| `has_credentials` | boolean | `true` if a non-expired vault credential profile is mapped to this user + connection |
| `ignore_cert` | boolean | Whether the connection's RDP certificate validation is disabled |
| `file_transfer_enabled` | boolean | `true` if the connection has `enable-drive` or `enable-sftp` enabled in its extra settings |
| `watermark` | string | Per-connection watermark setting (`inherit`, `enabled`, `disabled`) |
| `file_transfer_enabled` | boolean | `true` if the connection has `enable-drive` or `enable-sftp` enabled in its extra settings |
| `expired_profile` | object \| null | Present only when `has_credentials` is `false` and an expired or checked-in profile is mapped. Contains `id`, `label`, `ttl_hours`, and — for managed profiles — the linked `managed_ad_dn`, `ad_sync_config_id`, and `can_self_approve` flag so the UI can render the correct renewal/checkout request form. |

> **Tunnel safety**: Even if a client attempts to bypass the pre-connect prompt, the `/api/ws/tunnel/:id` endpoint will reject the connection with a validation error when the only credential source available is an expired managed credential profile. This prevents stale credentials from being sent to Active Directory (which could contribute to account lockout).

### Favorites

#### `GET /api/user/favorites`

List IDs of connections the user has favorited.

**Response** `200 OK`
```json
["uuid1", "uuid2"]
```

#### `POST /api/user/favorites`

Toggle a connection as a favorite (add if absent, remove if present).

**Request Body**
```json
{ "connection_id": "uuid" }
```

**Response** `200 OK`
```json
{ "favorited": true }
```

### `PUT /api/user/credentials`

Store or update an encrypted credential for a connection.

**Request Body**
```json
{
  "connection_id": "uuid",
  "password": "plaintext-password"
}
```

The password is envelope-encrypted via Vault Transit before storage. The plaintext is never persisted.

**Response** `200 OK`
```json
{ "status": "credential_saved" }
```

### `GET /api/recordings/:filename`

Download a session recording file.

The filename is sanitized to prevent path traversal. Returns `application/octet-stream`.

---

## WebSocket Tunnel

### `GET /api/tunnel/:connection_id`

Upgrades to a WebSocket connection that proxies bidirectional binary frames between the browser and `guacd`.

**Path Parameter**: `connection_id` (UUID) — must be a connection the user has access to via their role.

**Query Parameters** (all optional):

| Parameter | Type | Description |
|---|---|---|
| `token` | string | JWT access token (used for WebSocket auth since browsers cannot set headers on WS upgrades) |
| `username` | string | Override username for this connection (falls back to the JWT username) |
| `password` | string | Password for the remote connection (used if no Vault-stored credential exists) |
| `width` | integer | Requested display width in pixels (default: 1920) |
| `height` | integer | Requested display height in pixels (default: 1080) |
| `dpi` | integer | Requested display DPI (default: 96) |

**Credential Resolution Order**:
1. **Vault-stored** — if the user has an encrypted credential saved for this connection (via `PUT /api/user/connections/:id/credential`), it is decrypted and used
2. **Query parameters** — if `password` is supplied in the query string, it is used (with `username` falling back to the JWT username)
3. **None** — if neither source provides credentials, the connection is attempted without authentication (SSH connections may trigger an interactive `onrequired` prompt via the Guacamole protocol; RDP connections will fail)

**Flow**:
1. Backend verifies the user's role grants access to the connection
2. Backend opens a TCP connection to `guacd:4822`
3. Backend sends Guacamole protocol `select` and `connect` instructions with:
   - Connection parameters from the database
   - Decrypted credentials from Vault (if stored), or query-string credentials
   - Recording path (if enabled)
   - Username from the JWT
4. Binary frames are proxied bidirectionally until either side closes

### `POST /api/tunnel/ticket`

Obtain a one-time tunnel ticket for a specific connection. This ticket is then used to authenticate the WebSocket upgrade.

**Request Body**
```json
{
  "connection_id": "uuid",
  "width": 1920,
  "height": 1080,
  "dpi": 96,
  "credential_profile_id": "uuid (optional)"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `connection_id` | UUID | Yes | — | Target connection ID |
| `username` | string | No | — | One-time username for this session |
| `password` | string | No | — | One-time password for this session |
| `credential_profile_id` | UUID | No | — | Vault credential profile to use for this session (one-off, no permanent mapping required) |
| `width` | integer | No | 1920 | Display width |
| `height` | integer | No | 1080 | Display height |
| `dpi` | integer | No | 96 | Display DPI |
| `ignore_cert` | boolean | No | false | Override the connection's ignore-cert setting |

When `credential_profile_id` is provided, the backend decrypts the vault profile directly for this session. The credential resolution priority is: **one-off vault profile > permanently mapped vault profile > ticket credentials > query string fallback**.

**Response** `200 OK`
```json
{
  "ticket": "uuid-ticket-string"
}
```

**Security**: This endpoint validates that the user has access to the connection (directly or via folder) before issuing the ticket.

### `GET /api/shared/tunnel/:share_token`

Public WebSocket tunnel for shared sessions. No authentication required.

**Path Parameter**: `share_token` (string) — a valid, non-expired, non-revoked share token.

The backend looks up the share token, finds the owner's **active session** in the in-memory session registry, and subscribes the shared viewer to the owner's NVR broadcast channel:
- **View mode** — the shared viewer receives the owner's live display frames (read-only). Mouse and keyboard input from the viewer is discarded.
- **Control mode** — the shared viewer receives live display frames and can send keyboard and mouse input, which is injected into the owner's guacd TCP stream via an mpsc channel.

The shared viewer first receives a replay of the session's 5-minute ring buffer (with sync-stripping for atomic display rebuild), then transitions to live frame streaming.

Returns `404` if the token is invalid, expired, revoked, or if the owner is not currently connected.

---

## Connection Sharing

### `POST /api/user/connections/:connection_id/share`

Generate a temporary share link for a connection the user has access to.

**Path Parameter**: `connection_id` (UUID)

**Request Body**
```json
{
  "mode": "view"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `mode` | `"view"` \| `"control"` | No | `"view"` | `"view"` = read-only, `"control"` = full keyboard & mouse input |

**Response** `200 OK`
```json
{
  "share_token": "abc123def456",
  "share_url": "/shared/abc123def456",
  "mode": "view"
}
```

The share link provides access according to the specified mode. The owner must be actively connected for the link to work — shared viewers observe the owner's live session via the NVR broadcast, not an independent connection. Links expire after 24 hours or when explicitly revoked. Control mode share URLs include `?mode=control` for frontend detection.

### `DELETE /api/user/shares/:share_id`

Revoke a previously created share link.

**Path Parameter**: `share_id` (UUID)

**Response** `200 OK`
```json
{ "status": "revoked" }
```

---

## Quick Share (Temporary File CDN)

Session-scoped temporary file hosting. Upload a file and get a random, unguessable download URL to paste into the remote session's browser. Files are automatically deleted when the tunnel disconnects.

**Limits:** 20 files per session, 500 MB per file.

### `POST /api/files/upload`

Upload a file via multipart form data. Requires authentication **and** the `can_use_quick_share` role permission (or `can_manage_system` as a super-admin bypass). Users whose role lacks Quick Share will receive `403 Forbidden`.

**Content-Type**: `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `session_id` | text | Yes | Active session ID to associate the file with |
| `file` | file | Yes | Binary file payload |

**Response** `200 OK`
```json
{
  "token": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "filename": "report.pdf",
  "size": 1048576,
  "content_type": "application/pdf",
  "download_url": "/api/files/a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

### `GET /api/files/:token`

Download a file. **This endpoint is intentionally unauthenticated** — the random UUID token serves as a capability. This allows the remote desktop (which has no Strata auth) to fetch the file.

**Path Parameter**: `token` (UUID)

**Response** `200 OK` — binary file with `Content-Disposition: attachment` header.

**Response** `404 Not Found` — file not found or expired.

### `GET /api/files/session/:session_id`

List all files for a session. Requires authentication.

**Path Parameter**: `session_id` (string)

**Response** `200 OK`
```json
[
  {
    "token": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "filename": "report.pdf",
    "size": 1048576,
    "content_type": "application/pdf",
    "download_url": "/api/files/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "created_at": "2026-04-16T12:00:00Z"
  }
]
```

### `DELETE /api/files/:token`

Delete a file. Requires authentication and ownership (only the uploader can delete).

**Path Parameter**: `token` (UUID)

**Response** `200 OK`

**Response** `403 Forbidden` — not the file owner.

**Response** `404 Not Found` — file not found.

---

## Error Responses

All errors follow this format:

```json
{ "error": "Human-readable error message" }
```

| Status | Meaning |
|---|---|
| 400 | Invalid request body |
| 401 | Missing/invalid token or SSO not configured |
| 403 | Insufficient role permissions |
| 404 | Resource not found |
| 500 | Internal server error |
| 502 | Vault communication failure |
| 503 | System not initialized (setup required) |

---

## Notification Endpoints (Admin)

All four endpoints require `can_manage_system` and reject requests during the **Setup** boot phase.

### `GET /api/admin/notifications/smtp`

Return the current SMTP configuration. The password itself is **never** returned; the `password_set` boolean indicates whether a sealed value exists in Vault so the UI can render a `•••• (set)` placeholder.

**Response** `200 OK`
```json
{
  "enabled": true,
  "host": "smtp.contoso.com",
  "port": 587,
  "username": "strata-mailer@contoso.com",
  "tls_mode": "starttls",
  "from_address": "strata-no-reply@contoso.com",
  "from_name": "Strata Client",
  "password_set": true,
  "branding_accent_color": "#2563eb"
}
```

### `PUT /api/admin/notifications/smtp`

Upsert the SMTP configuration. The password is sealed via Vault Transit (`crate::services::vault::seal_setting`) before being written to `system_settings.smtp_encrypted_password`. The endpoint **rejects the request with `400 Bad Request`** when:

- `password` is `Some(non-empty)` but Vault is sealed or running in stub mode (Vault is hard-required for SMTP password storage)
- `tls_mode` is not one of `starttls`, `implicit`, `none`
- `port` is `0`

**Request Body**
```json
{
  "enabled": true,
  "host": "smtp.contoso.com",
  "port": 587,
  "username": "strata-mailer@contoso.com",
  "password": "•••• new password ••••",
  "tls_mode": "starttls",
  "from_address": "strata-no-reply@contoso.com",
  "from_name": "Strata Client",
  "branding_accent_color": "#2563eb"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | bool | Yes | Master switch; `false` causes the dispatcher to short-circuit |
| `host` / `port` | string / u16 | Yes | SMTP relay endpoint |
| `username` | string | No | Plaintext SMTP username (stored in `system_settings`) |
| `password` | string | No | `null` = leave existing sealed value; `""` = clear; non-empty = seal as new value |
| `tls_mode` | enum | Yes | `starttls` (port 587), `implicit` (port 465), `none` (internal-only relays) |
| `from_address` | string | Yes | Empty value blocks dispatch entirely (audit `notifications.misconfigured`) |
| `from_name` | string | No | Display name in the `From` header |
| `branding_accent_color` | hex string | No | Used by future templates; currently surfaced in test-send body |

**Response** `200 OK`
```json
{ "status": "saved" }
```

### `POST /api/admin/notifications/test-send`

Render a small probe message and dispatch it through the live `SmtpTransport`. The actual SMTP response (or error) is surfaced verbatim so administrators can debug auth/TLS failures without grepping container logs.

**Request Body**
```json
{
  "recipient": "ops@contoso.com",
  "template_key": "checkout_pending"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `recipient` | string | Yes | Destination address (must contain `@`) |
| `template_key` | string | No | When omitted, a generic "SMTP probe" body is sent. When set, the endpoint renders the named template with fixture data so the operator can preview exactly what a real `checkout_pending` (etc.) email looks like end-to-end — including the sealed `branding_accent_color` and `From` name. Unknown keys return `400 Bad Request`. Added in v0.26.0. |

**Response** `200 OK`
```json
{ "status": "sent", "message_id": "<uuid@strata-client>" }
```

**Errors**
- `400` — recipient is empty or lacks `@`
- `400` — SMTP settings invalid (returned as `Validation` error from `SmtpTransport::from_settings`)
- `502` — SMTP relay rejected the message (the rejection text is included in the error body)

### `GET /api/admin/notifications/deliveries`

Return rows from `email_deliveries`, newest first. Use the `status` query parameter to filter to a single status; `limit` is clamped to `[1, 200]` (default 50).

**Query parameters**
- `status` — optional; one of `queued`, `sent`, `failed`, `bounced`, `suppressed`
- `limit` — optional integer, default 50, max 200

**Response** `200 OK`
```json
[
  {
    "id": "5f5b1c0a-…",
    "template_key": "checkout_pending",
    "recipient_email": "approver@contoso.com",
    "subject": "Strata Client — Checkout request awaiting your approval",
    "status": "sent",
    "attempts": 1,
    "last_error": null,
    "created_at": "2026-04-25T14:02:11Z",
    "sent_at": "2026-04-25T14:02:12Z"
  }
]
```

> [!NOTE]
> The rendered email **body** is deliberately not stored in `email_deliveries`. Only metadata (template key, recipient, subject, related entity) is retained, which keeps sensitive justification text confined to the source `password_checkout_requests` row and limits PII sprawl across the database.

---

## Trusted CA Bundles (v1.2.0)

Reusable PEM bundles used by the `web` protocol's Chromium kiosk so
operators can attach an internal-PKI root to many connections without
re-pasting it. PEMs are validated at upload time with `rustls-pemfile`
+ `x509-parser`; the parsed subject, expiry, and SHA-256 fingerprint
are cached on the row so the admin list view never has to re-parse.

The PEM is treated as **public material** and is not envelope-encrypted
via Vault. Read access to the PEM column requires `can_manage_system`.
The picker endpoint (`GET /api/user/trusted-cas`) is auth-only and
returns only `{id, name, subject}` — never the PEM bytes.

### `GET /api/admin/trusted-cas`

Required permission: `can_manage_system`.

**Response** `200 OK`
```json
[
  {
    "id": "f1e2d3c4-...",
    "name": "Corporate Root 2024",
    "description": "Internal PKI root for *.corp.example",
    "subject": "CN=Corp Root CA, O=Example, C=GB",
    "not_after": "2034-04-29T00:00:00Z",
    "fingerprint": "AB:CD:EF:01:02:03:...",
    "created_at": "2026-04-29T10:00:00Z",
    "updated_at": "2026-04-29T10:00:00Z"
  }
]
```

### `POST /api/admin/trusted-cas`

Upload a new bundle.

Required permission: `can_manage_system`.

**Request Body**
```json
{
  "name": "Corporate Root 2024",
  "description": "Internal PKI root for *.corp.example",
  "pem": "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----\n"
}
```

**Response** `200 OK` returns the parsed summary as above.

**Errors**
- `400 Bad Request` — `name` empty, blank PEM, malformed PEM, or no certificate found in the input.
- `400 Bad Request` — `name` collides (case-insensitive UNIQUE on `LOWER(name)`).

Writes a `trusted_ca.created` audit event.

### `PUT /api/admin/trusted-cas/{id}`

Update a bundle. All fields are optional; sending a blank `pem` keeps
the existing PEM untouched.

Required permission: `can_manage_system`.

**Request Body**
```json
{
  "name": "Corporate Root 2024 (rotated)",
  "description": "Refreshed root after CA rotation",
  "pem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
}
```

**Response** `200 OK` returns the updated summary.

Writes a `trusted_ca.updated` audit event.

### `DELETE /api/admin/trusted-cas/{id}`

Required permission: `can_manage_system`.

**Response** `200 OK`
```json
{ "status": "deleted" }
```

**Errors**
- `400 Bad Request` — at least one row in `connections` (with
  `protocol = 'web'`) still references this bundle via
  `extra->>'trusted_ca_id'`. Detach the bundle from those connections
  first.
- `404 Not Found` — no such bundle.

Writes a `trusted_ca.deleted` audit event.

### `GET /api/user/trusted-cas`

Authenticated read-only picker used by the connection editor's
**Trusted Certificate Authority** dropdown. No special permission is
required, but the response intentionally omits the PEM bytes.

**Response** `200 OK`
```json
[
  { "id": "f1e2d3c4-...", "name": "Corporate Root 2024", "subject": "CN=Corp Root CA, O=Example, C=GB" }
]
```

---

## Audit Event Types

| Action Type | Trigger |
|---|---|
| `settings.updated` | Admin updates system settings |
| `sso.configured` | SSO settings saved |
| `kerberos.configured` | Kerberos settings saved |
| `recordings.configured` | Recording settings toggled |
| `vault.configured` | Vault settings updated or mode changed |
| `role.created` | New role created |
| `connection.created` | New connection created |
| `connection.updated` | Connection settings changed |
| `connection.deleted` | Connection removed |
| `connection_group.created` | New connection group created |
| `connection_group.deleted` | Connection group removed |
| `role_connections.updated` | Role-connection mapping changed |
| `credential.updated` | User saves encrypted credential |
| `tunnel.connected` | User opens a remote session |
| `tunnel.terminated` | WebSocket tunnel closed by the in-band auth watchdog. `details`: `{ connection_id, reason }`. The `reason` field takes one of: `revoked` (the access token used at upgrade time appeared in the in-memory revocation set after a `/api/auth/logout` call), `max_duration` (`MAX_TUNNEL_DURATION = 8h` wall-clock cap exceeded — added in v1.4.1, replaces the v1.3.2 `expired` reason). Added in v1.3.2; revised in v1.4.1.
| `connection.shared` | User generates a connection share link (includes mode) |
| `notifications.skipped_opt_out` | Recipient opted out via `users.notifications_opt_out`; suppression recorded in `email_deliveries` (`status='suppressed'`) |
| `notifications.misconfigured` | Dispatcher refused to send (empty `smtp_from_address` or `smtp_enabled = false`) |
| `notifications.abandoned` | Retry worker abandoned a delivery row after 3 failed attempts |
| `connection.share_accessed` | External viewer opens a share link (includes client IP) |
| `connection.share_rate_limited` | Share-tunnel request rejected by per-token rate limit (payload: 8-char SHA-256 prefix + client IP). Added in v0.26.0 |
| `connection.share_invalid_token` | Share-tunnel request for an unknown, revoked, or soft-deleted share. Added in v0.26.0 |
| `share.revoked` | User revokes a connection share link |
| `user.terms_accepted` | User accepted the Terms / recording-consent modal. Added in v0.26.0 |
| `user.credential_mapping_set` | User mapped a credential profile to a connection. Added in v0.26.0 |
| `user.credential_mapping_removed` | User cleared a credential-profile mapping. Added in v0.26.0 |
| `checkout.retry_activation` | User re-triggered activation on an `Approved` checkout after a first activation failure. Added in v0.26.0 |
| `checkout.checkin` | User voluntarily checked a live checkout in before expiry. Added in v0.26.0 |
| `ad_sync.config_created` | AD sync source config created |
| `ad_sync.config_updated` | AD sync source config updated |
| `ad_sync.config_deleted` | AD sync source config deleted |
| `ad_sync.completed` | AD sync run finished (includes created/updated/deleted counts) |
| `checkout.requested` | User requested a password checkout for an AD-managed account |
| `checkout.approved` | Approver approved a password checkout request |
| `checkout.denied` | Approver denied a password checkout request |
| `checkout.activated` | Password checkout activated — password generated, LDAP reset, sealed in Vault |
| `checkout.expired` | Password checkout expired (automatic or manual) |
| `checkout.checked_in` | User voluntarily checked-in (returned) an active checkout early |
| `checkout.scheduled` | User created a password checkout with a future `scheduled_start_at`; no credential material exists yet |
| `checkout.emergency_bypass` | User invoked break-glass approval bypass; checkout activated immediately without approver review (requires `pm_allow_emergency_bypass`) |
| `rotation.completed` | Automatic service account password rotation completed |
| `web.session.start` | Chromium kiosk has been spawned, Xvnc is reachable, and guacd is about to attach. `details`: `{ connection_id, display, cdp_port }`. Added in v0.30.0 |
| `web.session.end` | Web Session closed for any reason. `details`: `{ connection_id, display, reason }`. Added in v0.30.0. **(v1.3.0+)** The WebSocket-tunnel route now writes this with `reason: "tunnel_disconnect"` after the proxy loop returns, so closing a browser tab is now visibly audited as a session-end event. |
| `web.autofill.write` | Login Data SQLite was provisioned for the session. `details`: `{ connection_id, credential_id }`. Added in v0.30.0 |
| `vdi.container.ensure` | `DockerVdiDriver::ensure_container()` succeeded (spawn or reuse). `details`: `{ connection_id, container_name, image }`. Added in v0.30.0 |
| `vdi.container.destroy` | Reaper destroyed a VDI container. `details`: `{ connection_id, container_name, reason }` where `reason` is one of `Logout`, `IdleTimeout`, or `Other`. Added in v0.30.0 |
| `vdi.image.rejected` | A VDI tunnel attempt referenced an image not present in the operator whitelist. `details`: `{ connection_id, image }`. Added in v0.30.0 |
| `trusted_ca.created` | Admin uploaded a new Trusted CA bundle. `details`: `{ id, name, fingerprint }`. Added in v1.2.0 |
| `trusted_ca.updated` | Admin edited a Trusted CA bundle. `details`: `{ id, name, fingerprint }`. Added in v1.2.0 |
| `trusted_ca.deleted` | Admin deleted a Trusted CA bundle. `details`: `{ id, name }`. Added in v1.2.0 |

---

## AD Sync Endpoints

All AD sync endpoints require authentication and the `admin` role.

### `GET /api/admin/ad-sync-configs`

List all AD sync source configurations.

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "label": "Production AD",
    "ldap_url": "ldaps://dc1.contoso.com:636",
    "bind_dn": "CN=svc-strata,OU=Service Accounts,DC=contoso,DC=com",
    "search_bases": ["OU=Servers,DC=contoso,DC=com", "OU=Workstations,DC=contoso,DC=com"],
    "search_filter": "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
    "search_scope": "subtree",
    "protocol": "rdp",
    "default_port": 3389,
    "auth_method": "simple",
    "tls_skip_verify": false,
    "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n...",
    "connection_defaults": {
      "ignore-cert": "true",
      "enable-wallpaper": "true",
      "recording-path": "/recordings",
      "create-recording-path": "true"
    },
    "sync_interval_minutes": 60,
    "pm_auto_rotate_enabled": false,
    "pm_auto_rotate_interval_days": 30,
    "pm_search_bases": ["OU=Admin Users,DC=contoso,DC=com"],
    "created_at": "2026-04-07T10:00:00Z",
    "updated_at": "2026-04-07T10:00:00Z"
  }
]
```

### `POST /api/admin/ad-sync-configs`

Create a new AD sync source.

**Request Body**
```json
{
  "label": "Production AD",
  "ldap_url": "ldaps://dc1.contoso.com:636",
  "bind_dn": "CN=svc-strata,OU=Service Accounts,DC=contoso,DC=com",
  "bind_password": "secret",
  "search_bases": ["OU=Servers,DC=contoso,DC=com"],
  "search_filter": "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
  "auth_method": "simple",
  "protocol": "rdp",
  "default_port": 3389,
  "sync_interval_minutes": 60,
  "enabled": true,
  "group_id": "uuid-or-null",
  "tls_skip_verify": false,
  "ca_cert_pem": "-----BEGIN CERTIFICATE-----\n...",
  "connection_defaults": {
    "ignore-cert": "true",
    "enable-wallpaper": "true",
    "enable-font-smoothing": "true"
  }
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `label` | string | Yes | — | Display name for this source |
| `ldap_url` | string | Yes | — | LDAP/LDAPS URL (e.g. `ldaps://dc1:636`) |
| `bind_dn` | string | No | `""` | Bind DN for simple auth |
| `bind_password` | string | No | `""` | Bind password for simple auth |
| `search_bases` | string[] | Yes | — | OU scopes to search (multiple supported) |
| `search_filter` | string | No | All computers (excluding gMSA/MSA) | LDAP search filter |
| `search_scope` | `"subtree"` \| `"onelevel"` \| `"base"` | No | `"subtree"` | LDAP search scope |
| `protocol` | `"rdp"` \| `"ssh"` \| `"vnc"` | No | `"rdp"` | Protocol for imported connections |
| `default_port` | integer | No | 3389 | Default port for imported connections |
| `auth_method` | `"simple"` \| `"kerberos"` | No | `"simple"` | LDAP authentication method |
| `keytab_path` | string | No | — | Path to keytab file (kerberos auth) |
| `krb5_principal` | string | No | — | Kerberos principal (kerberos auth) |
| `group_id` | UUID | No | null | Connection group for imported connections |
| `domain_override` | string | No | null | Force domain on imported connections |
| `tls_skip_verify` | boolean | No | false | Skip TLS certificate verification |
| `ca_cert_pem` | string | No | null | Custom CA certificate in PEM format |
| `connection_defaults` | object | No | `{}` | Guacamole connection parameters applied to all synced connections (see below) |
| `sync_interval_minutes` | integer | No | 60 | Background sync interval (minimum 5) |
| `enabled` | boolean | No | true | Enable/disable this source |
| `pm_search_bases` | string[] | No | `[]` | OU scopes specifically for user discovery. If empty, falls back to `search_bases`. |
| `pm_allow_emergency_bypass` | boolean | No | false | Enable the break-glass "⚡ Emergency Bypass" option on checkout requests for accounts governed by this config. When true, users can self-activate a checkout with a ≥ 10-character justification, skipping approver review. Each event is audit-logged as `checkout.emergency_bypass`. |

#### Connection Defaults

The `connection_defaults` field accepts a JSON object of Guacamole parameter key-value pairs that are applied as the `extra` JSONB on every connection created or updated by this sync source. Supported RDP parameters include:

| Parameter | Description |
|---|---|
| `ignore-cert` | Skip RDP server certificate validation |
| `enable-wallpaper` | Render desktop wallpaper |
| `enable-font-smoothing` | Enable ClearType font smoothing |
| `enable-desktop-composition` | Allow Aero/transparent window effects |
| `enable-theming` | Enable window theming |
| `enable-full-window-drag` | Show window contents while dragging |
| `enable-menu-animations` | Allow menu open/close animations |
| `disable-bitmap-caching` | Disable RDP bitmap cache |
| `disable-glyph-caching` | Disable glyph (font symbol) cache |
| `disable-offscreen-caching` | Disable off-screen region cache |
| `disable-gfx` | Disable the Graphics Pipeline Extension (GFX) |
| `enable-h264` | Enable H.264 GFX passthrough (v0.28.0+). Requires `disable-gfx=false`, `color-depth=32`, and AVC444 configured on the RDP host. When `false`, the session falls back to the bitmap path. The legacy parameter name `enable-gfx-h264` is **not** recognised by guacd and was a documented bug prior to v0.28.0 |
| `force-lossless` | Force lossless encoding (disables H.264; falls back to RemoteFX). Use only for screens where colour fidelity is critical (e.g. medical imaging) |
| `color-depth` | Colour depth in bits per pixel. **Must be `32` for H.264 GFX**; lower values silently disable H.264 and fall back to RemoteFX. The backend defaults this to `32` when empty (v0.28.0+) |
| `recording-path` | Directory for screen recording files |
| `recording-name` | Filename for recordings (supports `${GUAC_DATE}`, `${GUAC_TIME}`, `${GUAC_USERNAME}` tokens) |
| `create-recording-path` | Auto-create the recording directory |
| `recording-include-keys` | Include key events in recordings |
| `recording-exclude-mouse` | Exclude mouse events from recordings |
| `recording-exclude-touch` | Exclude touch events from recordings |
| `recording-exclude-output` | Exclude graphical output from recordings |

### `PUT /api/admin/ad-sync-configs/:id`

Partial update of an AD sync source. Only provided fields are updated.

### `DELETE /api/admin/ad-sync-configs/:id`

Delete an AD sync source. Imported connections remain but will no longer sync.

### `POST /api/admin/ad-sync-configs/test`

Test an AD sync connection without persisting. Validates connectivity, bind, and search — returns a count and preview of the first 10 discovered objects.

**Request Body**: Same as the create endpoint.

**Response** `200 OK`
```json
{
  "status": "success",
  "message": "Connection successful — found 42 object(s)",
  "count": 42,
  "sample": [
    "SRV-WEB01 (srv-web01.contoso.com)",
    "SRV-DB01 (srv-db01.contoso.com)"
  ]
}
```

### `POST /api/admin/ad-sync-configs/test-filter`

Test the PM target account filter against Active Directory without persisting. Uses the form's current bind credentials (PM-specific or fallback to main bind) to execute the LDAP filter and returns matching accounts.

**Request Body**: Same as the create endpoint (uses `pm_target_filter`, `pm_bind_user`, `pm_bind_password` fields).

**Response** `200 OK`
```json
{
  "status": "success",
  "message": "Filter matched 156 account(s)",
  "count": 156,
  "sample": [
    { "dn": "CN=John Smith,OU=Users,DC=contoso,DC=com", "name": "jsmith", "description": "IT Department" },
    { "dn": "CN=Jane Doe,OU=Users,DC=contoso,DC=com", "name": "jdoe", "description": null }
  ]
}
```

`sample` contains up to 25 accounts. Each entry includes `dn`, `name` (sAMAccountName or CN), and optional `description`.

### `POST /api/admin/ad-sync-configs/:id/sync`

Trigger an immediate sync for a specific source.

**Response** `200 OK`
```json
{ "run_id": "uuid", "status": "started" }
```

### `GET /api/admin/ad-sync-configs/:id/runs`

List sync run history for a source (newest first, limit 50).

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "config_id": "uuid",
    "started_at": "2026-04-07T12:00:00Z",
    "finished_at": "2026-04-07T12:00:05Z",
    "status": "success",
    "created": 5,
    "updated": 2,
    "soft_deleted": 1,
    "hard_deleted": 0,
    "error_message": null
  }
]
```

### Kerberos Realms

#### `GET /api/admin/kerberos-realms`

List all Kerberos realm configurations.

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "realm": "CONTOSO.COM",
    "kdcs": ["dc1.contoso.com", "dc2.contoso.com"],
    "admin_server": "dc1.contoso.com",
    "ticket_lifetime": "10h",
    "renew_lifetime": "7d",
    "is_default": true
  }
]
```

#### `POST /api/admin/kerberos-realms`

Create a Kerberos realm. Triggers `krb5.conf` regeneration.

**Request Body**
```json
{
  "realm": "CONTOSO.COM",
  "kdcs": ["dc1.contoso.com"],
  "admin_server": "dc1.contoso.com",
  "ticket_lifetime": "10h",
  "renew_lifetime": "7d",
  "is_default": true
}
```

#### `PUT /api/admin/kerberos-realms/:id`

Update a Kerberos realm. Triggers `krb5.conf` regeneration.

#### `DELETE /api/admin/kerberos-realms/:id`

Delete a Kerberos realm. Triggers `krb5.conf` regeneration.

---

### Display Tags

Users can pin a single tag per connection to display on session thumbnails in the Active Sessions sidebar.

#### `GET /api/user/display-tags`

Returns all display tag assignments for the current user.

**Response**
```json
{
  "conn-uuid-1": { "id": "tag-uuid", "name": "Production", "color": "#ef4444" },
  "conn-uuid-2": { "id": "tag-uuid", "name": "Staging", "color": "#3b82f6" }
}
```

Each key is a connection ID. The value contains the pinned tag's `id`, `name`, and `color`. Connections without a display tag are omitted.

#### `POST /api/user/display-tags`

Set or replace the display tag for a connection. Only one tag can be pinned per connection per user.

**Request Body**
```json
{
  "connection_id": "uuid",
  "tag_id": "uuid"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `connection_id` | string (UUID) | The connection to assign the display tag to |
| `tag_id` | string (UUID) | The user tag to pin. Must belong to the current user |

**Response**
```json
{ "ok": true }
```

Returns `404` if the tag does not exist or does not belong to the user.

#### `DELETE /api/user/display-tags/:connection_id`

Remove the display tag for a connection.

**Response**
```json
{ "ok": true }
```

Returns success even if no display tag was set (idempotent).

---

## Password Management Endpoints

### Admin Endpoints (require `can_manage_system`)

#### `GET /api/admin/approval-roles`

List all approval roles.

#### `POST /api/admin/approval-roles`

Create an approval role.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Role name (1-255 characters) |
| `description` | string | No | Role description |

#### `PUT /api/admin/approval-roles/:id`

Update an approval role.

#### `DELETE /api/admin/approval-roles/:id`

Delete an approval role and all related assignments and account scopes.

#### `GET /api/admin/approval-roles/:id/assignments`

List users assigned to a role.

#### `PUT /api/admin/approval-roles/:id/assignments`

Replace role assignments. Body: `{ "user_ids": ["uuid", ...] }`

#### `GET /api/admin/approval-roles/:id/accounts`

List managed AD accounts scoped to this approval role. Each entry maps the role to a specific managed account DN.

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "role_id": "uuid",
    "managed_ad_dn": "CN=John Smith,OU=T1-Accounts,DC=contoso,DC=com",
    "created_at": "2026-04-18T10:00:00Z"
  }
]
```

#### `POST /api/admin/approval-roles/:id/accounts`

Add a managed AD account to this approval role's scope. Body: `{ "managed_ad_dn": "CN=..." }`

#### `DELETE /api/admin/approval-role-accounts/:id`

Remove a managed account from an approval role's scope.

#### `GET /api/admin/account-mappings`

List all user-to-managed-account mappings.

#### `POST /api/admin/account-mappings`

Create a user-to-managed-account mapping.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user_id` | string (UUID) | Yes | Strata user |
| `managed_ad_dn` | string | Yes | AD distinguished name of managed account |
| `can_self_approve` | boolean | No | Allow user to self-approve checkouts (default false) |
| `ad_sync_config_id` | string (UUID) | No | Link to AD sync config for password policy |

#### `DELETE /api/admin/account-mappings/:id`

Delete an account mapping.

Delete an account mapping.

#### `PATCH /api/admin/account-mappings/:id`

Partially update an existing user → managed-account mapping. Any field omitted
from the request body is left unchanged (`COALESCE`-semantics). Requires
`can_manage_system`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `can_self_approve` | boolean | No | Toggle whether the user can self-approve checkouts against this mapping. |
| `friendly_name` | string | No | Human-readable label for the managed account. |

Returns `404` if the mapping id does not exist. Writes an
`account_mapping.updated` audit log entry with the requested changes.

#### `GET /api/admin/ad-sync-configs/:id/unmapped-accounts`

Discover AD accounts matching the PM target filter that are not yet mapped to any user.

#### `POST /api/admin/pm/test-rotation`

Test service account password rotation for a config. Body: `{ "config_id": "uuid" }`

#### `GET /api/admin/checkout-requests`

List all checkout requests (up to 200, most recent first).

#### `GET /api/admin/vdi/images`

Return the operator-managed VDI image whitelist (rustguac parity
Phase 3). Backed by the `vdi_image_whitelist` row in
`system_settings`. Newline- or comma-separated; lines starting with
`#` are treated as comments.

**Response** `200 OK`
```json
{
  "images": ["strata/vdi-ubuntu:24.04-2026.04.01", "strata/vdi-rocky:9-2026.04.01"],
  "count": 2
}
```

#### `PUT /api/admin/roadmap/:item_id`

Upsert the status of a single roadmap item. Requires `can_manage_system`.
Item id must be non-empty, ≤ 64 chars, and contain only alphanumerics,
`-`, or `_`. The status must be one of `Proposed`, `Researching`,
`In Progress`, or `Shipped`.

Overrides are stored as a single JSON blob under the
`roadmap_statuses` key of `system_settings`.

**Body**
```json
{ "status": "In Progress" }
```

**Response** `200 OK`
```json
{ "ok": true, "item_id": "recording-screenshots", "status": "In Progress" }
```

### User Endpoints (authenticated)

#### `GET /api/user/managed-accounts`

List managed AD accounts assigned to the current user.

#### `POST /api/user/checkouts`

Request a password checkout.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `managed_ad_dn` | string | Yes | DN of the managed account |
| `ad_sync_config_id` | string (UUID) | No | AD sync config |
| `requested_duration_mins` | number | No | Duration in minutes (1-720, default 60). **Hard-clamped to 30 when `emergency_bypass = true`** — any larger value is silently reduced server-side. |
| `justification_comment` | string | Conditional | **Required (≥ 10 characters)** whenever the caller does not have self-approval on the mapping — i.e. for any approval-required checkout, including Emergency Bypass. Optional for self-approving users. |
| `emergency_bypass` | boolean | No | Break-glass flag. Only accepted when the account's AD sync config has `pm_allow_emergency_bypass = true`. Activates the checkout immediately without approver review, caps `requested_duration_mins` at 30, and writes a `checkout.emergency_bypass` audit event. Cannot be combined with `scheduled_start_at`. |
| `scheduled_start_at` | string (ISO 8601, UTC) | No | Schedules the release for a future moment. Must be strictly in the future (> now + 30 s) and ≤ 14 days from now. The checkout is created with status `Scheduled` — no password is generated, no LDAP mutation occurs, and no Vault material is written until the scheduled moment. A 60-second background worker activates due rows. |

**Response** `200 OK`
```json
{ "id": "uuid", "status": "Pending", "scheduled_start_at": null }
```

`status` is one of `Pending`, `Approved`, `Scheduled`, or `Active`. Self-approving users (or emergency-bypass callers) receive `Approved` and the checkout is activated synchronously; scheduled requests return `Scheduled` with the echo of `scheduled_start_at`; approval-required requests return `Pending`.

**Errors:**
- `400 Validation` — `scheduled_start_at` is in the past / too close / more than 14 days out, or `emergency_bypass` was combined with `scheduled_start_at`
- `400 Validation` — `emergency_bypass = true` but `justification_comment` is shorter than 10 characters
- `403 Forbidden` — `emergency_bypass = true` but the AD sync config does not have `pm_allow_emergency_bypass` enabled
- `409 Conflict` — user already has an open (`Pending`, `Approved`, `Scheduled`, or `Active`) checkout for this account

#### `GET /api/user/checkouts`

List the current user's checkout requests (up to 100, most recent first).

#### `GET /api/user/pending-approvals`

List pending checkout requests that the current user can approve. Returns only requests for managed accounts explicitly assigned to the user's approval roles via `approval_role_accounts`. Includes the requester's username (resolved via LEFT JOIN).

**Response** `200 OK`
```json
[
  {
    "id": "uuid",
    "requester_user_id": "uuid",
    "requester_username": "jdoe",
    "managed_ad_dn": "CN=John Smith,OU=T1-Accounts,DC=contoso,DC=com",
    "status": "Pending",
    "requested_duration_mins": 60,
    "justification_comment": "Emergency production fix",
    "created_at": "2026-04-18T10:00:00Z"
  }
]
```

#### `POST /api/user/checkouts/:id/decide`

Approve or deny a pending checkout. The approver must have the managed account in their approval role scope. Body: `{ "approved": true }`. Records `approved_by_user_id` on the request.

#### `GET /api/user/checkouts/:id/reveal`

Reveal the active checkout password. Only the requester can call this.

**Response** `200 OK`
```json
{ "password": "...", "expires_at": "2025-01-01T12:00:00Z" }
```

#### `POST /api/user/checkouts/:id/checkin`

Voluntarily check-in (return) an active checkout before its expiry. Only the requester can call this. Immediately triggers password rotation so the previously issued credentials are invalidated.

**Path Parameter**: `id` (UUID) — checkout request ID

**Response** `200 OK`
```json
{ "status": "checked_in" }
```

**Errors:**
- `403` — not the requester
- `404` — checkout not found
- `409` — checkout is not in `Active` state (already expired, denied, or checked in)
