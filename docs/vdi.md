# VDI Desktop Containers

> **Status:** **Shipped** in v0.30.0 (runtime delivery). Foundation
> landed in v0.29.0; live `DockerVdiDriver`, ephemeral RDP credential
> auto-provisioning, admin tab, and the three runtime hot-fixes
> (docker.sock permission, Compose-prefixed network resolution, xrdp
> TLS / resize handling) shipped in v0.30.0.

Strata Client can launch a Strata-managed Docker container running
`xrdp` and tunnel it to the user as a standard guacd RDP session. The
container provides a full Linux desktop with a persistent home
directory, operator-controlled CPU / memory limits, and ephemeral
auto-provisioned credentials so the user never has to type a password
for an internally managed account.

VDI is opted in via the `docker-compose.vdi.yml` overlay because the
driver requires `/var/run/docker.sock` mounted into the backend
container, which grants the backend host-root on the Docker daemon.
The default compose graph deliberately omits this mount.

---

## Contents

1. [When to use VDI](#when-to-use-vdi)
2. [Architecture](#architecture)
3. [Configuring a VDI connection](#configuring-a-vdi-connection)
4. [Image whitelist](#image-whitelist)
5. [Ephemeral credentials](#ephemeral-credentials)
6. [Deployment](#deployment)
7. [Network resolution](#network-resolution)
8. [Docker socket permissions](#docker-socket-permissions)
9. [Security overrides for VDI](#security-overrides-for-vdi)
10. [Audit events](#audit-events)
11. [Reaper and disconnect classification](#reaper-and-disconnect-classification)
12. [Building a custom VDI image](#building-a-custom-vdi-image)
13. [Troubleshooting](#troubleshooting)

---

## When to use VDI

- Browser-based access to a full Linux desktop (jump-box use cases,
  contractor onboarding, training labs).
- Workflows that need browser-based **and** terminal-based access in
  the same session (CLI-driven SaaS administration, Kubernetes
  cluster admin).
- Disposable but persistent workspaces where the user's `$HOME` should
  outlive a single tab.
- Compliance scenarios where the operator must control the OS image,
  the network egress, and the audit / recording surface.

For pure browser-only access (e.g. an Okta sign-in flow, a vendor
portal), prefer a [Web Session](web-sessions.md). For direct
administration of an existing host, prefer plain RDP or SSH.

---

## Architecture

```
   +------------+    HTTPS     +-------------+    Guac proto   +----------+
   |  Browser   |------------->|  Strata     |---------------->|  guacd   |
   |  (user)    |<-- WSS ------|  backend    |<----------------|  (RDP)   |
   +------------+              +------+------+                 +----+-----+
                                      |                              |
                                      | bollard 0.18                 | RDP
                                      | (unix-socket xport)          |
                                      v                              |
                              +------------------+                   |
                              |  /var/run/       |                   |
                              |   docker.sock    |                   |
                              |  (overlay mount) |                   |
                              +------+-----------+                   |
                                     |                               |
                                     v                               |
                              +------------------+                   |
                              | strata-vdi-...   | (joined to        |
                              |   xrdp:3389      |  guac-internal)   |
                              | + bind-mount     |<------------------+
                              |   $HOME          |
                              | + VDI_USERNAME   |
                              | + VDI_PASSWORD   |
                              +------------------+
```

Key properties:

- **Strict opt-in.** No part of the default compose graph mounts
  `/var/run/docker.sock` or sets `STRATA_VDI_ENABLED=true`. The
  feature is gated behind the
  [`docker-compose.vdi.yml`](../docker-compose.vdi.yml) overlay file
  and a documented `COMPOSE_FILE` sticky form in `.env`.
- **Image whitelist.** Only operator-approved images may be referenced
  by a `vdi` connection. Stored in
  `system_settings.vdi_image_whitelist`, exposed read-only via
  `GET /api/admin/vdi/images`. Strict equality, no glob/digest
  substitution.
- **Deterministic container naming.** `strata-vdi-{conn[..12]}-{user[..12]}`.
  Re-opening the same connection from the same user reuses the same
  container, which is the basis of the persistent-home story.
- **Ephemeral credentials.** Operators do not have to populate
  `username`/`password` on a VDI connection row. The runtime
  auto-provisions a sanitised POSIX username (deterministic per
  Strata user) and a fresh 24-character alphanumeric password per
  session.
- **Reserved env keys.** `VDI_USERNAME` and `VDI_PASSWORD` are
  silently dropped from operator-supplied `env_vars` so the admin
  form cannot leak or override them.
- **Resource limits.** Operator-supplied `cpu_limit` (Docker `--cpus`)
  and `memory_limit_mb` (Docker `--memory`) cap the container.
- **Reaper integration.** Disconnects are classified
  (`Logout` / `TabClose` / `IdleTimeout` / `Other`) so the reaper
  destroys idle / logged-out containers but retains tab-close
  containers within the idle window for fast reconnect.

---

## Configuring a VDI connection

VDI connections live next to RDP/SSH/VNC under
**Admin -> Access -> Connections -> Add Connection** with `VDI Desktop`
selected as the protocol. The form fields land in `connections.extra`
(JSONB):

| Field                  | `extra` key         | Notes                                                                            |
| ---------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Image                  | `image`             | **Required.** Must be in the operator whitelist. Pick from the dropdown.         |
| CPU Limit (cores)      | `cpu_limit`         | Float, blank => unbounded. Mapped to Docker `--cpus`.                            |
| Memory Limit (MB)      | `memory_limit_mb`   | Integer, blank => unbounded. Mapped to Docker `--memory`.                        |
| Idle Timeout (mins)    | `idle_timeout_mins` | Integer, blank => default 30. Reaped after this many minutes of no client.       |
| Persistent Home        | `persistent_home`   | Boolean. When `true`, `$HOME` is bind-mounted under `STRATA_VDI_HOME_BASE`.      |
| Environment Variables  | `env_vars`          | JSON object. `VDI_USERNAME` / `VDI_PASSWORD` keys are reserved and dropped.      |

The connection's `hostname`/`port` are unused on the wire — the
backend overrides both with the network-attached endpoint returned by
`DockerVdiDriver::ensure_container()`.

### Wire-protocol translation

The route in [`backend/src/routes/tunnel.rs`](../backend/src/routes/tunnel.rs)
rewrites `wire_protocol = "rdp"` and replaces hostname/port with the
spawned container's `{name}:3389`. The original `vdi` label is
preserved on `nvr_protocol` so recordings keep the operator-facing
icon.

---

## Image whitelist

Configured under **Admin -> Settings -> VDI** (or directly in
`system_settings.vdi_image_whitelist`). Newline- or comma-separated;
lines starting with `#` are comments. Example:

```text
# Approved Strata VDI images for 2026-Q2
strata/vdi-ubuntu:24.04-2026.04.01
strata/vdi-rocky:9-2026.04.01
# Engineering desktop with extra tooling
strata/vdi-eng:2026.04.01
# Sample image (development only)
strata/vdi-sample:1.0.0
```

The whitelist is **strict equality** — `strata/vdi-ubuntu:latest` is
not a substitute for `strata/vdi-ubuntu:24.04-2026.04.01`, and a
floating tag never satisfies a pinned tag. Pinning is a security
feature: it lets the operator review the exact image at exactly the
digest that the registry resolved at the time the whitelist was
written.

A connection that references an unwhitelisted image is rejected at
spawn time and a `vdi.image.rejected` audit event is written.

---

## Ephemeral credentials

When a VDI tunnel opens, the route does the following before calling
the driver:

```rust
let (final_username, final_password) =
    if protocol == "vdi" && final_password.is_none() {
        let (u, p) = vdi::ephemeral_credentials(&user.username);
        tracing::debug!(
            msg = "Auto-provisioned ephemeral VDI credentials",
            vdi_username = %u,
        );
        (Some(u), Some(p))
    } else {
        (final_username, final_password)
    };
```

`ephemeral_credentials(strata_username)` returns:

- A **deterministic** POSIX username — `sanitise_posix_username()`
  lower-cases the Strata username, strips characters outside
  `[a-z0-9._-]`, truncates to 32, and falls back to `vdi_user` if
  empty. The same Strata user always maps to the same POSIX user, so
  the bind-mounted `$HOME` is consistent across reconnects.
- A **fresh** 24-character alphanumeric password generated from
  `rand::distr::Alphanumeric` per call. Every spawn (or every
  re-spawn) gets a new password.

Both values are injected into the container as `VDI_USERNAME` and
`VDI_PASSWORD`. The container's xrdp+PAM stack must read those env
vars at boot (the sample image's entrypoint does).

The frontend [`SessionClient.tsx`](../frontend/src/pages/SessionClient.tsx)
RDP credentials prompt branch skips `vdi`, so users never see "enter
your credentials" for the internally managed account.

---

## Deployment

VDI is opted in by layering the
[`docker-compose.vdi.yml`](../docker-compose.vdi.yml) overlay on top
of the default compose graph. The overlay adds:

1. The `/var/run/docker.sock` bind mount.
2. A bind mount for persistent home directories (`VDI_HOME_BASE`).
3. `STRATA_VDI_ENABLED=true`.
4. `STRATA_VDI_NETWORK=${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal`.
5. `STRATA_VDI_HOME_BASE=/var/lib/strata/vdi-homes`.

### Per-command form

```bash
docker compose -f docker-compose.yml -f docker-compose.vdi.yml up -d --build
```

### Sticky form (recommended)

Set once in `.env` so every subsequent `docker compose ...` command
picks up the overlay automatically:

```env
# Compose Overlays (sticky)
# Windows uses ; as the separator; Linux/macOS use :
COMPOSE_FILE=docker-compose.yml;docker-compose.vdi.yml
```

With `COMPOSE_FILE` set, plain `docker compose up -d` includes VDI.
To exclude VDI for a specific command, pass `-f docker-compose.yml`
explicitly.

> **Why stickiness matters.** Without `COMPOSE_FILE`, every operator
> command must spell out both `-f` flags. A single
> `docker compose up -d backend` (no overlay) silently drops the
> docker.sock mount and `STRATA_VDI_ENABLED`, and the next VDI tunnel
> attempt returns a 503 "vdi driver unavailable". This was a real
> issue during v0.30.0 rollout — see CHANGELOG for the fix.

---

## Network resolution

`DockerVdiDriver::connect(network)` accepts an explicit network name.
Docker Compose **prefixes network names with the project name**, so
the network the rest of the stack joins is actually
`strata-client_guac-internal`, not `guac-internal`. If the driver
attached new containers to the unprefixed name, every
`ensure_container` would fail with:

```
docker error: Docker responded with status code 404:
  failed to set up container networking: network guac-internal not found
```

The fix in v0.30.0:

- A new `STRATA_VDI_NETWORK` env var (read by
  [`backend/src/main.rs`](../backend/src/main.rs)) selects the network.
- The overlay defaults it to
  `${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal`, so the
  default Compose project name "just works".
- Operators who set a custom `COMPOSE_PROJECT_NAME` get the right
  resolution automatically. Operators who deploy outside Compose
  (Kubernetes, direct `docker run`) override `STRATA_VDI_NETWORK` to
  match their network topology.

---

## Docker socket permissions

`bollard::Docker::connect_with_defaults()` is **lazy**: the connection
check at startup succeeds even when the socket is unreadable, only
the first real HTTP request fails with:

```
Error in the hyper legacy client: client error (Connect)
```

The backend image runs as the unprivileged `strata` user via
`gosu strata strata-backend` in
[`backend/entrypoint.sh`](../backend/entrypoint.sh). Two cases must
be handled at runtime:

1. **Linux distros (Debian, Arch, etc.)** mount the socket inside the
   container as `srw-rw---- root:docker` with the host's `docker`
   group GID (commonly 998 or 999).
2. **Docker Desktop on Windows / macOS** mounts the socket inside
   the container as `srw-rw---- root:root` (GID 0) — no group hop is
   possible without rewriting the bind-mount permissions.

`entrypoint.sh` distinguishes the two before dropping privileges:

```bash
if [ -S /var/run/docker.sock ]; then
    SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
    if [ "$SOCK_GID" != "0" ]; then
        EXISTING_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1 || true)
        if [ -z "$EXISTING_GROUP" ]; then
            groupadd -g "$SOCK_GID" docker-host
            EXISTING_GROUP=docker-host
        fi
        usermod -aG "$EXISTING_GROUP" strata
        echo "[entrypoint] Added strata to ${EXISTING_GROUP} (gid=${SOCK_GID}) for docker.sock access"
    else
        chmod g+rw /var/run/docker.sock 2>/dev/null || true
        chgrp strata /var/run/docker.sock 2>/dev/null || true
        echo "[entrypoint] docker.sock owned by root:root; granted strata group access on the bind-mount"
    fi
fi

exec gosu strata strata-backend "$@"
```

Both branches emit a log line so operators can see in `docker logs`
which path executed.

---

## Security overrides for VDI

The sample VDI image's xrdp uses a **per-container self-signed
certificate** that Strata never trusts. Its display-update virtual
channel also drops the RDP session on resize storms (sidebar toggle,
browser window resize). The tunnel handler forces three overrides for
`vdi` connections only:

| Param           | Forced value | Reason                                                                                       |
| --------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `ignore-cert`   | `true`       | Per-container self-signed cert; both ends Strata-controlled; traffic on internal bridge.     |
| `security`      | `any`        | xrdp negotiates whatever it can — the cert is not trustworthy regardless of TLS mode.        |
| `resize-method` | `""` (empty) | xrdp's display-update channel drops the session on resize; client-side scaling is preferred. |

The frontend's guacamole-common-js display layer continues to scale
the fixed framebuffer to fit the operator's viewport client-side, so
the user sees a letterbox / scale rather than a disconnect when the
sidebar is toggled.

These overrides apply **only** when `protocol == "vdi"`. RDP
connections to operator-managed Windows hosts are unaffected and
continue to honour the per-connection `ignore-cert` / `security` /
`resize-method` columns.

---

## Audit events

| Action                  | Emitted when                                                              | Details schema                                  |
| ----------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| `vdi.container.ensure`  | `ensure_container()` succeeds (spawn or reuse)                            | `{ connection_id, container_name, image }`     |
| `vdi.container.destroy` | Reaper destroys a container (idle, logout, or explicit removal)           | `{ connection_id, container_name, reason }`    |
| `vdi.image.rejected`    | A VDI tunnel attempt referenced an image not in the whitelist             | `{ connection_id, image }`                      |

Action-type strings are stable from v0.29.0; the `details` JSONB
schema is fixed and additive (operators can rely on existing keys, new
keys may be added in future minor releases).

---

## Reaper and disconnect classification

`DisconnectReason::from_xrdp_code` maps the xrdp WTSChannel disconnect
frame:

| Code  | Reason          | Reaper action                              |
| ----- | --------------- | ------------------------------------------ |
| `0`   | `Logout`        | Destroy container immediately.             |
| `1`   | `TabClose`      | Retain container until idle-timeout fires. |
| `2`   | `IdleTimeout`   | Destroy container (server-initiated).      |
| other | `Other`         | Destroy container (defensive).             |

`should_destroy_immediately()` returns `true` for everything except
`TabClose`, which is the only case where a fast tab-close-and-reopen
should reuse the live container.

---

## Building a custom VDI image

Before any operator can attach a VDI connection to an image, that
image must be **built**, **pushed to a registry the backend host can
reach**, and **explicitly added to the whitelist**. Strata never
pulls an image automatically; the operator decides exactly which tag
runs and audits each addition.

### 1. Start from the reference image

A working reference image lives at
[`contrib/vdi-sample/`](../contrib/vdi-sample/) and contains
everything needed to satisfy the runtime contract:

```
contrib/vdi-sample/
├── Dockerfile        # Ubuntu 24.04 + xfce + xrdp + locale baseline
├── entrypoint.sh     # Reads VDI_USERNAME / VDI_PASSWORD and starts xrdp
└── README.md         # Operator-facing notes for the sample
```

Treat this as a **starting point**, not a production target. Fork it
and bake in your own apps, fonts, language packs, corporate CA
bundle, MDM agents, etc., before publishing.

### 2. Build the image

From the repository root:

```powershell
# Windows / PowerShell
docker build -t strata/vdi-sample:1.0.0 .\contrib\vdi-sample
```

```bash
# Linux / macOS
docker build -t strata/vdi-sample:1.0.0 ./contrib/vdi-sample
```

Build options worth knowing:

- **Tag with an immutable version**, never `:latest`. The whitelist
  requires strict equality, so floating tags will be rejected at
  spawn time.
- **`--platform linux/amd64`** is recommended on Apple-Silicon hosts;
  the backend runs on the same architecture as the Docker daemon and
  xrdp behaves better on amd64.
- **`--build-arg`** the sample exposes nothing today, but a fork can
  parameterise the base image, locale, or pre-installed app set.
- **`--no-cache`** when rebuilding for a security refresh — otherwise
  Docker layer cache may keep stale apt mirrors / certs.

### 3. Push the image to a reachable registry

The backend `DockerVdiDriver` runs `docker pull` (via bollard) on
the host's Docker daemon, so the image must exist in a registry the
backend host can reach. Local-only `docker build` images work for
**single-host development** because the daemon already has the layer
cache, but production deployments need a real registry:

```bash
docker tag  strata/vdi-sample:1.0.0  registry.example.com/strata/vdi-sample:1.0.0
docker push registry.example.com/strata/vdi-sample:1.0.0
```

If the registry requires authentication, log the **backend host's
Docker daemon** in (not your laptop):

```bash
ssh backend-host
sudo docker login registry.example.com
```

### 4. Add the exact tag to the whitelist

Open **Admin -> Settings -> VDI** and append the fully qualified tag,
one per line (or comma-separated). Lines starting with `#` are
comments:

```text
# 2026-Q2 baseline
registry.example.com/strata/vdi-sample:1.0.0
```

Save the settings page. The change takes effect on the next tunnel
attempt — no backend restart required.

### 5. Reference the image from a connection

In **Admin -> Access -> Connections -> Add Connection**, choose
`VDI Desktop` as the protocol. The **Image** dropdown is populated
from `GET /api/admin/vdi/images` (the parsed whitelist), so the new
tag should appear immediately. Select it, save the connection, and
the next time a user opens the connection the backend pulls the
image (if needed) and spawns a container.

### Runtime contract — required behaviour of any custom image

Any forked or from-scratch image must preserve the following so
Strata's runtime can manage its lifecycle:

1. **Read `VDI_USERNAME` and `VDI_PASSWORD` from the environment** at
   container boot. Both are injected by Strata at container creation
   and rotated per session (see
   [Ephemeral credentials](#ephemeral-credentials)).
2. **Provision the POSIX user** named in `VDI_USERNAME` (or update
   the password if the user already exists) **before xrdp starts**.
   The sample image's [`entrypoint.sh`](../contrib/vdi-sample/entrypoint.sh)
   shows the canonical pattern: `useradd` if missing, then
   `chpasswd` with the supplied password, then `exec xrdp`.
3. **Run xrdp on TCP `:3389` listening on `0.0.0.0`** (not just
   `127.0.0.1`). The backend connects to the container over the
   `STRATA_VDI_NETWORK` Docker network and needs the listener bound
   on the network-facing interface.
4. **Honour Docker resource flags** applied by the driver:
   `--cpus`, `--memory`, `--shm-size`. Don't override them inside the
   image (no `docker run` wrappers in the entrypoint).
5. **Persist `$HOME` correctly.** When `persistent_home=true` Strata
   bind-mounts `<home_base>/<container_name>` to `/home/$VDI_USERNAME`
   inside the container. The image's `useradd` step must place the
   home there (the default `useradd -m -d /home/$VDI_USERNAME` is
   correct).
6. **Do not bake credentials into the image.** Anything in the image
   layers is visible to anyone with `docker pull` access; Strata's
   ephemeral-credentials story only works if the image is generic.

### Updating an image (rolling a version)

Strict-equality whitelist matching is deliberate, so a refresh is a
two-step operator action — not a silent `:latest` resolve:

1. Build and push the new tag (e.g. `:1.1.0`).
2. Edit the whitelist in **Admin -> Settings -> VDI** to **add the
   new tag**. Leave the old tag in place if existing connections
   reference it; otherwise update the connection rows to point at
   the new tag and remove the old one once no connection references
   it.
3. Existing **running containers** continue on the old tag. They are
   re-pulled on the next reaper-driven destroy + spawn cycle, so a
   forced rotation is `docker rm -f <container>` (which the next
   tunnel attempt rebuilds against the current whitelist entry).

---

## Troubleshooting

### "vdi driver unavailable: docker connect failed"

The docker.sock is not mounted, or `STRATA_VDI_ENABLED` is not
`true`. Verify with:

```powershell
docker exec strata-client-backend-1 sh -c "ls -la /var/run/docker.sock; env | grep STRATA_VDI"
```

If the socket is missing, the backend was started without the VDI
overlay. Set the sticky `COMPOSE_FILE` in `.env` and recreate the
backend.

### "Error in the hyper legacy client: client error (Connect)"

The socket is mounted but the `strata` user cannot access it. Check
the entrypoint log:

```powershell
docker logs strata-client-backend-1 --tail 20 | Select-String "entrypoint|VDI driver"
```

You should see one of the two `[entrypoint]` lines documented under
[Docker socket permissions](#docker-socket-permissions). If neither
appears, the entrypoint is the old version — rebuild the backend
image.

### "failed to set up container networking: network guac-internal not found"

The network name does not include the Compose project prefix. Verify
the env var:

```powershell
docker exec strata-client-backend-1 sh -c "env | grep STRATA_VDI_NETWORK"
docker network ls
```

Set `STRATA_VDI_NETWORK` to a network that actually exists.

### "Connection Error: SSL/TLS connection failed"

Pre-v0.30.0. Upgrade to v0.30.0 or later — the tunnel handler now
forces `ignore-cert=true` and `security=any` for VDI.

### Sidebar toggle disconnects the VDI session

Pre-v0.30.0. Upgrade to v0.30.0 or later — the tunnel handler now
forces `resize-method=""` for VDI so xrdp does not receive
display-update messages.

### Container exists but state is `Created` (never started)

`ensure_container` builds the create payload but the start call failed
— most often because the network attach failed. See "network not
found" above. Remove the orphan with:

```powershell
docker rm -f $(docker ps -aq --filter "label=strata.connection_id")
```

---

## Related documentation

- [Web Browser Sessions](web-sessions.md) — pure browser-only counterpart.
- [Architecture](architecture.md) — Extended protocols section diagrams the spawn pipeline.
- [Security](security.md) — Web Sessions and VDI extended threat model.
- [API reference](api-reference.md) — `/api/admin/vdi/images` and audit-event schemas.
- [Deployment](deployment.md) — production hardening notes, including running the backend behind a privileged sidecar instead of the docker.sock mount.
