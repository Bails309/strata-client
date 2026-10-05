# Runbook — Sessions refused at capacity

## Purpose

Find out why new remote sessions are being refused, and raise the limit that
is refusing them without dropping the sessions already running.

## When to use

- Users see **Session Limit Reached** with *"The server is at capacity. Try
  again in a few minutes."* or *"You already have N open session(s), the most
  your role allows."*
- **Before v2.3.5:** a new session showed **Reconnecting…** over and over and
  never connected, while existing sessions kept working. The refusal was sent
  as an HTTP `429` on the WebSocket upgrade, which browsers do not expose to
  the page, so the client retried as if the network had dropped.
- The admin **Sessions** tab shows **Native Sessions** at or near
  **Max Recommended**.
- The backend logs `session refused: memory budget exhausted` or
  `tunnel refused`.

## Prerequisites

- A shell on the Docker host (the commands below are for Ubuntu / any Linux
  with Docker Engine and the Compose v2 plugin; run them from the
  `strata-client` checkout).
- For step 2: an admin account with `can_manage_system`, and either the
  admin UI or an API token in `$TOKEN`.
- `jq` for readable JSON (`sudo apt-get install -y jq`).

## Safety checks

1. **Restarting the backend ends every live session.** Every session runs
   inside the `backend` container. Steps marked ⚠ restart it; do them in a
   quiet period or tell users first. Step 5b raises a limit **without** a
   restart.
2. **Do not raise the budget past real memory.** The budget is a guard
   against the container being killed for running out of memory, which would
   drop every session at once. Raise the memory available, not just the
   number.

## How the limit works

Before a session contacts its target it reserves an estimate of its memory in
[`services/admission.rs`](../../backend/src/services/admission.rs):

| Session | Reserved |
| ------- | -------- |
| RDP, VNC | 8 MiB + width × height × 8 bytes (two framebuffers at 4 bytes a pixel). A 1920×1080 session is about 24 MiB; a 1920×969 browser viewport about 22 MiB |
| SSH, Telnet, Kubernetes | 4 MiB |
| Web (Chromium kiosk) | 384 MiB + the framebuffers |

Reservations are counted against a budget:

```
budget = STRATA_SESSION_MEMORY_BUDGET_MB, if set
       = ¾ × available memory − STRATA_NVR_MEMORY_BUDGET_MB (default 1024 MiB), never below 256 MiB
available memory = the backend container's memory limit if it has one, else the host's RAM
```

Since v2.3.5 the budget is **re-read on every session start**, so it follows
a resized host or a `docker update --memory` immediately. A session is also
refused when its user already holds their role's `max_concurrent_sessions`
(or `STRATA_MAX_SESSIONS_PER_USER`).

Worked examples for 1920×969 RDP sessions:

| Backend memory | Budget | Sessions before refusal |
| -------------- | ------ | ----------------------- |
| 2 GiB container limit (the Compose default before v2.3.5) | 2048 × ¾ − 1024 = **512 MiB** | **~23** |
| 4 GiB container limit | 2048 MiB | ~92 |
| No limit, 16 GiB host | ~10.7 GiB | ~490 |

## Procedure

### 1. Confirm it is an admission refusal

```bash
docker compose logs --since 1h backend \
  | grep -E "tunnel refused|memory budget exhausted|the most your role allows"
```

Expected output when the budget is full:

```text
WARN strata_backend::services::admission: session refused: memory budget exhausted reserved_mb=497 limit_mb=512 request_mb=22
WARN strata_backend::routes::tunnel: tunnel refused: The server is at capacity. Try again in a few minutes. status=797
```

- `memory budget exhausted` → the server budget (go to step 2).
- `the most your role allows` → a per-user limit (go to step 5d).
- Neither → not a capacity problem; use the
  [session-disconnects runbook](session-disconnects.md).

### 2. Read the live numbers

In the UI: **Admin → Sessions → Native Engine Capacity** shows sessions,
backend memory, RAM per session and the recommended maximum. From the shell:

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://strata.example.com/api/admin/metrics \
  | jq '{active_sessions, native_ram_per_session_mb, native_recommended,
         backend_memory_mb: (.backend_memory_bytes / 1048576 | floor),
         system_total_memory_mb: (.system_total_memory / 1048576 | floor),
         system_cpu_cores,
         reserved_mb: (.memory.sessions_reserved_bytes / 1048576 | floor),
         limit_mb: (.memory.sessions_limit_bytes / 1048576 | floor),
         refused: .memory.sessions_refused}'
```

`reserved_mb` close to `limit_mb` confirms the budget is full.
`system_total_memory_mb` is the memory the backend can use — the container
limit if one is set.

### 3. Check for a container limit

```bash
BACKEND=$(docker compose ps -q backend)
docker inspect -f 'memory={{.HostConfig.Memory}} nano_cpus={{.HostConfig.NanoCpus}}' "$BACKEND"
docker compose exec backend cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max
```

Expected output with **no** limit:

```text
memory=0 nano_cpus=0
max
max 100000
```

A limit shows bytes instead, e.g. `memory=2147483648` and `2147483648` /
`200000 100000` (2 GiB, 2 CPUs). Also check what is set in `.env`:

```bash
grep -E '^(STRATA_BACKEND_MEMORY|STRATA_BACKEND_CPUS|STRATA_SESSION_MEMORY_BUDGET_MB|STRATA_NVR_MEMORY_BUDGET_MB|STRATA_MAX_SESSIONS_PER_USER)=' .env
```

### 4. Check the host itself

```bash
free -h
nproc
docker stats --no-stream "$BACKEND"
```

Compare the backend's `MEM USAGE` with the reservation total from step 2.
The reservation is an estimate; actual use should be comfortably below the
container limit (or the host's free memory).

### 5. Fix

Pick the row that matches what steps 1–4 found.

| Finding | Fix |
| ------- | --- |
| A container limit (`STRATA_BACKEND_MEMORY`, or a pre-v2.3.5 `docker-compose.yml` with `memory: 2G`) | 5a, or 5b for no restart |
| No container limit, but the host is short of memory | 5c |
| `the most your role allows` | 5d |
| Budget full but `docker stats` shows plenty of headroom | 5e |

#### 5a. Remove or raise the container limit ⚠ restarts the backend

Remove `STRATA_BACKEND_MEMORY` / `STRATA_BACKEND_CPUS` from `.env` to let the
backend use the whole host, or set them higher:

```bash
sed -i '/^STRATA_BACKEND_MEMORY=/d;/^STRATA_BACKEND_CPUS=/d' .env   # or edit to a larger value
docker compose up -d backend
```

On a checkout older than v2.3.5, `docker-compose.yml` itself sets
`memory: 2G` and `cpus: "2"` under the backend's `deploy.resources.limits`;
upgrade, or edit those lines, before running `up`.

#### 5b. Raise the limit live, without a restart

```bash
docker update --memory 8g --memory-swap 8g "$BACKEND"
```

The next session start reads the new limit (v2.3.5 and later; older versions
read it once at startup). This does **not** survive `docker compose up`,
which reapplies the Compose value — make the same change in `.env` (5a) for
the next planned restart.

#### 5c. Give the host more memory

Resize the VM or add RAM. With no container limit the budget follows the
host's total memory, so nothing in Strata needs changing; a VM that needs a
reboot to see new memory restarts the backend with it. To go beyond one
host, add a backend replica behind the load balancer.

#### 5d. A user is at their session limit

Raise **Max concurrent sessions** on the user's role in **Admin → Roles**, or
`STRATA_MAX_SESSIONS_PER_USER` where the role sets none (⚠ the variable needs
a backend restart). Otherwise ask the user to close a session they no longer
need.

#### 5e. The estimate is too cautious for your workload ⚠ restarts the backend

Fix the budget explicitly, leaving headroom below the container limit or host
memory:

```bash
echo 'STRATA_SESSION_MEMORY_BUDGET_MB=6144' >> .env
docker compose up -d backend
```

If the backend is later killed for running out of memory, every session ends
at once; lower the value again.

## Verification

1. Step 2 shows a larger `limit_mb` and `native_recommended`.
2. A user who was refused can open a session.
3. No new refusals are logged:

   ```bash
   docker compose logs --since 10m backend | grep -c "memory budget exhausted"
   ```

   Expected output: `0`.

## Rollback

Restore the previous `.env` values and run `docker compose up -d backend`
(⚠ restarts the backend). A live `docker update` is undone by
`docker compose up -d backend` or by running `docker update` with the old
value.

## Related

- [session-disconnects.md](session-disconnects.md) — every other way a session
  can end, by on-screen heading.
- [login-rate-limiting.md](login-rate-limiting.md) — sign-in limits; § 3.3
  summarises admission.
- [deployment.md § Session capacity planning](../deployment.md#session-capacity-planning)
- [architecture.md § Session admission](../architecture.md#session-admission-perf-04)
- `GET /api/admin/metrics` in [api-reference.md](../api-reference.md)

_Last reviewed: 2026-10-05 (v2.3.5)._
