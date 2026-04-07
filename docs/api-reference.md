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
  "database_connected": true,
  "vault_configured": true
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

List all roles.

**Response** `200 OK`
```json
[
  { "id": "uuid", "name": "admin" },
  { "id": "uuid", "name": "user" }
]
```

#### `POST /api/admin/roles`

Create a new role.

**Request Body**
```json
{ "name": "operators" }
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
    "last_accessed": "2026-04-05T14:30:00Z"
  }
]
```

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
| `protocol` | `"rdp"` \| `"ssh"` \| `"vnc"` | Yes | — |
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
| `sessions_by_protocol` | object | Session count grouped by protocol (rdp, ssh, vnc) |

---

## User Endpoints

These endpoints require authentication (any role).

### `GET /api/user/me`

Current authenticated user profile.

**Response** `200 OK`
```json
{
  "id": "uuid",
  "username": "jdoe",
  "role": "user",
  "sub": "keycloak-subject-id"
}
```

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
    "last_accessed": "2026-04-05T10:00:00Z"
  }
]
```

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

### `GET /api/shared/tunnel/:share_token`

Public WebSocket tunnel for shared sessions. No authentication required.

**Path Parameter**: `share_token` (string) — a valid, non-expired, non-revoked share token.

The backend looks up the share token, resolves the parent connection and its mode:
- **View mode** — opens a read-only tunnel to guacd (`read-only=true`). The shared viewer can see the session but keyboard and mouse input are not forwarded.
- **Control mode** — opens a full tunnel to guacd. The shared viewer can send keyboard and mouse input.

Returns `404` if the token is invalid, expired, or revoked.

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

The share link provides access according to the specified mode and expires when the owning user disconnects or the link is explicitly revoked. Control mode share URLs include `?mode=control` for frontend detection.

### `DELETE /api/user/shares/:share_id`

Revoke a previously created share link.

**Path Parameter**: `share_id` (UUID)

**Response** `200 OK`
```json
{ "status": "revoked" }
```

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
| `connection.shared` | User generates a connection share link (includes mode) |
| `share.revoked` | User revokes a connection share link |
