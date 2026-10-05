# Runbook — Sign-in limits and capacity refusals (`429`)

**Purpose:** Find out why users get `429 Too Many Requests` when signing
in, changing a password or opening a session, and clear it safely.

_Applies to v2.3.0 and later._

---

## 1. When to use

- Users report **"Too many login attempts. Please try again later."** on
  the sign-in page, or **"The server is busy. Please try again."**
- A password change returns `429`.
- Opening a session fails with **"The server is at capacity. Try again in
  a few minutes."** or **"You already have N open session(s), the most
  your role allows."**
- A burst of `429` responses to `/api/auth/login` in the proxy or backend
  logs.

## 2. Prerequisites

- Shell access to the Docker host (or `kubectl` access to the namespace).
- `psql` access to the Strata database **as the owner role** from
  `DATABASE_URL` (the `<owner>_runtime` role is enough to read and delete
  `auth_attempts` rows, but use the owner for operator work).
- An admin account with `can_manage_system` for `GET /api/admin/metrics`.

## 3. What the limits are

### 3.1 Sign-in and password change (kept in PostgreSQL)

Every attempt is admitted, and counted, in the `auth_attempts` table
(migration 102) **before** any password hashing starts. All backend
replicas share the same counts. Each limit is a sliding window; none is
permanent.

| Limit | Bucket in `auth_attempts.bucket` | Max | Window |
| ----- | -------------------------------- | --- | ------ |
| One username from one address | `login_account_ip:<username>\|<ip>` | 5 | 60 s |
| One username from any address | `login_account:<username>` | 30 | 900 s |
| One address, any username | `login_ip:<ip>` | 20 | 300 s |
| Whole deployment | `login_all:all` | `STRATA_LOGIN_ATTEMPTS_PER_MINUTE` (600) | 60 s |
| Password change by one user | `password_change:<user-uuid>` | 5 | 3600 s |

Usernames are lower-cased. The first full limit refuses the request with
`429` and a `Retry-After` header (seconds until the oldest counted attempt
leaves that window), and the attempts already admitted for the other
limits are given back. A **successful** sign-in is not counted and clears
the username + address bucket.

### 3.2 Password hashing slots

At most `STRATA_PASSWORD_HASH_CONCURRENCY` Argon2 hashes run at once
(default: one per CPU, up to 4). A request that waits more than 10 seconds
for a slot gets `429` **without** `Retry-After` and the message "The
server is busy". This protects the async runtime from a burst of sign-ins;
it is not a security limit.

### 3.3 Session admission

Before a session contacts its target it reserves an estimate of its
memory (by protocol and display size; a web session counts its browser)
against a process-wide budget, and counts against the user's
concurrent-session limit:

- **Budget:** `STRATA_SESSION_MEMORY_BUDGET_MB`, else three quarters of the
  container (cgroup) memory limit, or of host memory without one, less
  the replay budget (`STRATA_NVR_MEMORY_BUDGET_MB`, default 1024). It is
  re-read on every session start, so adding memory takes effect at once.
- **Per user:** the role's `max_concurrent_sessions` (migration 101), else
  `STRATA_MAX_SESSIONS_PER_USER`; unset or `0` means no limit.
- **Web kiosks:** `max_web_sessions` in system settings.

A refused session is told why before any credential is checked out or
container or browser started. The refusal is delivered over the WebSocket
as a Guacamole `error` (status `0x031D`), not as an HTTP 429: browsers hide
an upgrade's HTTP status, so a 429 looked like a dropped connection and the
client retried for minutes. Users now see **Session Limit Reached** with the
reason, and the backend logs `tunnel refused`.

## 4. Safety checks

1. **Is this an attack?** Before clearing anything, look at who is being
   limited:

   ```sql
   SELECT bucket, count(*), min(attempted_at), max(attempted_at)
   FROM auth_attempts
   WHERE attempted_at > now() - interval '15 minutes'
   GROUP BY bucket
   ORDER BY count(*) DESC
   LIMIT 20;
   ```

   Many `login_account:<name>` rows for one name from many addresses, or
   `login_ip:<ip>` rows for many names, look like guessing. Do **not**
   clear those; follow [security-incident.md](security-incident.md).

2. **Is every user coming from one address?** If `login_ip:<ip>` is hot
   and `<ip>` is your reverse proxy, load balancer or NAT gateway, Strata
   is not seeing real client addresses (section 5.2).

## 5. Procedure

### 5.1 One user locked out by their own mistakes

Wait for the window: the `Retry-After` value is the longest anyone has to
wait, at most 15 minutes for the per-username limit. If that is not
acceptable, clear that user's buckets:

```sql
-- ⚠ Removes the attempt history for one username only.
DELETE FROM auth_attempts
WHERE bucket = 'login_account:alice'
   OR bucket LIKE 'login_account_ip:alice|%';
```

Expected output: `DELETE <n>`. The user can sign in at once.

### 5.2 Everyone limited from the same address

The backend resolves the client address in one place
(`services/client_ip.rs`), in this order:

1. A verified DMZ edge header (`x-strata-edge-client-ip`, HMAC-checked).
2. `X-Forwarded-For`, only when `STRATA_TRUST_XFF=1` **and** the socket
   peer is in `STRATA_TRUSTED_PROXIES`, walked right to left skipping
   trusted hops.
3. The socket peer.

If your users reach Strata through a proxy that is not trusted, they all
share that proxy's address and its 20-per-5-minutes limit. The Compose
defaults (`STRATA_TRUST_XFF=1`,
`STRATA_TRUSTED_PROXIES=172.16.0.0/12,192.168.0.0/16`) trust only the
Docker networks, which covers the bundled `frontend` container but not a
load balancer in front of it with an address elsewhere. Set both
variables on the backend for the real proxy chain (comma-separated CIDRs
or addresses; an invalid entry stops startup), then restart it:

```env
STRATA_TRUST_XFF=1
STRATA_TRUSTED_PROXIES=172.16.0.0/12,192.168.0.0/16,10.0.0.10/32
```

Then clear the stale address bucket:

```sql
DELETE FROM auth_attempts WHERE bucket = 'login_ip:10.0.0.10';
```

Do **not** trust a proxy that clients can bypass: anyone reaching the
backend directly could then choose their own address.

### 5.3 The whole deployment is limited

If `login_all:all` is at its maximum during a legitimate peak (a shift
change, every user signing in after a restart), raise
`STRATA_LOGIN_ATTEMPTS_PER_MINUTE` on the backend and restart it. The
default of 600 a minute is shared by every replica.

### 5.4 "The server is busy"

Hashing slots were full for 10 seconds. Check CPU on the backend
container. Raise `STRATA_PASSWORD_HASH_CONCURRENCY` only if the backend
has spare cores; each hash uses one CPU for roughly its Argon2 cost.

### 5.5 Sessions refused at capacity

Follow [session-capacity.md](session-capacity.md), which covers finding the
limit (container, host, budget override or role) and raising it with or
without a restart. The quick check is:
```bash
curl -s -H "Authorization: Bearer $TOKEN" https://strata.example.com/api/admin/metrics | jq .memory
```

Expected output (example):

```json
{
  "sessions_reserved_bytes": 201326592,
  "sessions_limit_bytes": 11274289152,
  "sessions_refused": 3,
  "replay_used_bytes": 52428800,
  "replay_limit_bytes": 1073741824,
  "clipboard_bytes": 0
}
```

- `sessions_reserved_bytes` near `sessions_limit_bytes`: the backend is
  full. Check for a container limit first
  (`docker inspect -f '{{.HostConfig.Memory}}' $(docker compose ps -q backend)`,
  `0` = none); unset `STRATA_BACKEND_MEMORY` or raise it, add memory to
  the host, add a replica, or set `STRATA_SESSION_MEMORY_BUDGET_MB` if the
  default estimate is too cautious for your workload.
- Budget not full but users refused: their role's
  `max_concurrent_sessions` (or `STRATA_MAX_SESSIONS_PER_USER`) is
  reached. Raise it in the role editor, or ask the user to close a
  session.

The backend logs a warning `session refused: memory budget exhausted`
with `reserved_mb`, `limit_mb` and `request_mb` for each budget refusal.

## 6. Verification

- The affected user signs in, or opens a session, without `429`.
- The bucket query in section 4 shows no bucket at its maximum.
- For 5.5, `sessions_refused` stops increasing.

## 7. Rollback

- Environment changes: revert the variable and restart the backend.
- Deleted `auth_attempts` rows need no rollback; they only grant extra
  attempts until the window refills.

## 8. Related

- [security.md § Rate Limiting](../security.md#rate-limiting)
- [security.md § Session streams and capacity](../security.md#session-streams-and-capacity-sec-15-perf-04)
- [api-reference.md § `POST /api/auth/login`](../api-reference.md#post-apiauthlogin)
- [security-incident.md](security-incident.md)
- [session-disconnects.md](session-disconnects.md)

_Last reviewed: 2026-10-02 (v2.3.0)._
