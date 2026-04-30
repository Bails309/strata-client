# Architecture

## Overview

Strata Client is a microservices system that replaces the legacy Java/Tomcat + AngularJS Apache Guacamole stack with a Rust proxy and React SPA. The core stack runs four containers (frontend/nginx, backend, guacd, Vault); optional profiles add a bundled PostgreSQL instance and additional guacd sidecar instances for horizontal scaling. The backend image (Debian trixie-slim) additionally ships `Xvnc` and `chromium` baked in to support the `web` protocol out of the box; the `vdi` protocol is gated behind the [`docker-compose.vdi.yml`](../docker-compose.vdi.yml) overlay because it requires mounting `/var/run/docker.sock` (= host root).

```
                          ┌─────────────────────────────────────────────┐
                          │           Docker Compose Network            │
                          │           (guac-internal bridge)            │
                          │                                             │
  Browser ────HTTPS/WSS──►│  ┌───────────┐        ┌──────────────────┐  │
                          │  │  frontend  │──/api─►│     backend      │  │
                          │  │  (nginx)   │        │  (Rust / Axum)   │  │
                          │  │  :80/:443  │        │   :8080          │  │
                          │  └───────────┘        └────────┬─────────┘  │
                          │                           │         │        │
                          │                     TCP 4822    SQL / HTTP   │
                          │                           │         │        │
                          │                    ┌──────▼───┐  ┌──▼─────┐  │
                          │                    │  guacd   │  │Postgres│  │
                          │                    │(FreeRDP3 │  │  :5432 │  │
                          │                    │ +H.264) │  └────────┘  │
                          │                    ├──────────┤              │
                          │                    │ guacd-2… │ (opt)        │
                          │                    └──────────┘              │
                          │                                             │
                          │                    ┌──────────┐              │
                          │                    │  Vault   │              │
                          │                    │  1.19    │              │
                          │                    │ (Transit)│              │
                          │                    └──────────┘              │
                          │                                             │
                          └─────────────────────────────────────────────┘
```

## Containers

### 1. Custom guacd

| Item | Value |
|---|---|
| Base image | Alpine 3.19 (multi-stage) |
| Source | `guacd/Dockerfile` |
| Network | `guac-internal` (internal only) |
| Port | 4822 (not exposed externally) |

The official Apache Guacamole server daemon, custom-compiled with:
- **FreeRDP 3** (`ARG FREERDP_VERSION=3`) for modern RDP support
- **Kerberos** (`krb5-dev` at build, `krb5` + `krb5-libs` at runtime) for GSSAPI/NLA authentication
- **H.264 GFX** — `ffmpeg-dev` / `ffmpeg-libs` for FreeRDP 3 GFX pipeline with H.264 encoding, dramatically lowering bandwidth for RDP sessions

Multiple guacd instances can be deployed using the `--profile scale` Docker Compose profile (e.g. `guacd-2`). The backend distributes connections across instances using a round-robin `GuacdPool`.

Volumes:
- `guac-recordings` → `/var/lib/guacamole/recordings` — session recording storage
- `krb5-config` → `/etc/krb5` — dynamically generated `krb5.conf`
- `backend-config` → `/app/config` (read-only) — custom `resolv.conf` written by the backend for DNS configuration

**Custom DNS resolution:** The guacd container uses a custom `entrypoint.sh` wrapper that checks for `/app/config/resolv.conf` on startup. If present, it copies the file to `/etc/resolv.conf`, enabling the container to resolve internal hostnames (e.g. `.local`, `.dmz.local` domains). The entrypoint then drops privileges to the `guacd` user via `su-exec` before launching the daemon. DNS servers and search domains are configured via the Admin Settings Network tab and written to the shared `backend-config` volume by the backend. Docker's embedded DNS (`127.0.0.11`) is always appended as a fallback nameserver so existing connections that resolve via public DNS continue working.

**Recording write semantics (v1.1.0+):** guacd writes session recordings into the shared `guac-recordings` volume as `guacd:guacd` (uid/gid 100/101 inside the Alpine guacd container) at mode `0640` — group-only-read. The upstream `guacamole-server` `recording.c` `open()` hard-codes mode `0640`, so this is independent of the in-container `umask`. This gid is the integration point with the backend: the backend's `entrypoint.sh` reads the gid off the volume at startup and adds the `strata` user to a matching local group via `usermod -aG`, so historic playback works under standard POSIX group-read without requiring `DAC_OVERRIDE`. The fix is volume-agnostic — Docker named volumes, bind-mounts, NFSv3/v4 with preserved gids, and CIFS with `uid=,gid=` mount options all work transparently.

### 2. Rust Backend

| Item | Value |
|---|---|
| Language | Rust (2021 edition) |
| Framework | Axum 0.8 + Tokio |
| Source | `backend/` |
| Port | 8080 |

The central orchestrator. Responsibilities:

- **Bootstrap & config** — detects `config.toml` on startup; enters setup mode if missing
- **Database** — connects to local or external PostgreSQL; runs advisory-lock-protected migrations
- **Auth** — multi-method authentication system:
  - **SSO/OIDC** — dynamic IdP discovery via JWKS, secure client secret storage in Vault, and automatic session establishment.
  - **Local Auth** — built-in credentials (Argon2id) with global enable/disable toggle, minimum 12-character password policy, and dedicated password change / admin reset endpoints.
  - **Session tokens** — short-lived access tokens (20 min) with `HttpOnly` refresh cookies (8 hr), proactive activity-based silent refresh, per-user session tracking (`active_sessions` table), and a pre-expiry countdown warning toast.
  - **Enforcement** — strict backend policy check on every login attempt ensures disabled methods cannot be accessed.
- **Vault** — envelope encryption for stored credentials via Vault Transit
- **Tunnel** — bidirectional WebSocket ↔ TCP proxy to guacd with protocol handshake injection; supports H.264 GFX pipeline parameters for RDP
- **guacd pool** — round-robin connection distribution across multiple guacd instances (`GuacdPool`)
- **Metrics** — per-session bandwidth tracking (bytes in/out) with aggregate metrics endpoint
- **Config push** — generates `krb5.conf` (multi-realm), toggles recordings, manages SSO settings
- **AD sync** — scheduled LDAP/LDAPS queries against Active Directory to discover and import computer accounts; supports simple bind and Kerberos keytab auth, custom CA certificates, multiple search bases per source, gMSA/MSA exclusion filters, and configurable connection defaults (RDP performance flags, session recording parameters)
- **Password management** — privileged account password checkout and rotation for AD-managed service accounts; configurable password generation policy, LDAP `unicodePwd` reset, Vault-sealed credential storage, approval workflows with explicit account-to-role scoping (each approval role is mapped to specific managed AD accounts), dedicated "Search Base OUs" for user discovery (allowing separate scoping from device discovery), **scheduled future-dated checkouts** (requests between now + 30 s and now + 14 days sit idle with no credential material until the scheduled moment, at which point the existing 60-second expiration worker activates them), **emergency approval bypass (break-glass)** per AD sync config — gated by `pm_allow_emergency_bypass`, requires ≥ 10-character justification, **hard-capped at 30 minutes** server-side, writes a dedicated `checkout.emergency_bypass` audit event, surfaces an ⚡ Emergency badge across Credentials and Approvals views, background workers for checkout expiration and zero-knowledge auto-rotation, requester username resolution for approver visibility, and decided-by tracking with self-approval detection
- **Connection health checks** — background TCP probing of every connection's hostname:port every 2 minutes; results (online/offline/unknown) persisted and exposed via API for dashboard status indicators
- **DNS configuration** — admin-configurable DNS servers and search domains written to a shared Docker volume as `resolv.conf`; guacd containers apply this on startup for internal hostname resolution; Docker's embedded DNS is preserved as fallback
- **Quick Share (file store)** — session-scoped temporary file CDN; files uploaded via multipart POST are stored on disk, each keyed by a random unguessable token. Download endpoint is unauthenticated (the token is the capability). Files are automatically cleaned up when the tunnel disconnects. Limits: 20 files per session, 500 MB each. The frontend Quick Share panel is **protocol-aware (v1.3.0+)**: SSH / Telnet sessions render the copy-snippet as `curl -fLOJ '<url>'` (paste-into-shell friendly); RDP / VNC / web kiosks render the bare HTTPS URL. A "Copy as" `Select` dropdown lets the operator override per-session: `URL`, `curl`, `wget --content-disposition`, or `Invoke-WebRequest -Uri … -OutFile … (Windows)`
- **Audit** — SHA-256 hash-chained append-only log

### 3. Frontend SPA

| Item | Value |
|---|---|
| Language | TypeScript |
| Framework | React 19 + Vite |
| Styling | Tailwind CSS v4 |
| Runtime | nginx (production) |
| Source | `frontend/` |
| Ports | 80 (HTTP), 443 (HTTPS when certs mounted) |

The frontend nginx container serves as the primary gateway for all external traffic. It handles:
- **Reverse proxying** — routes `/api/*` to the Rust backend (including WebSocket upgrades for tunnel connections). The shared `common.fragment` declares `resolver 127.0.0.11 valid=10s ipv6=off;` (Docker's embedded DNS) and uses a `set $backend_upstream "backend:8080";` variable as the `proxy_pass` target so the upstream is re-resolved per request rather than cached at process start. **(v1.3.0+)** This avoids the historical `[emerg] host not found in upstream "backend"` boot failure when the backend container was briefly unreachable during `docker compose up -d --build`; nginx now stays up and returns `502 Bad Gateway` for the duration of any backend outage, recovering automatically when the upstream comes back
- **SSL termination** — when TLS certificates are mounted at `/etc/nginx/ssl/`, nginx serves HTTPS on port 443 with Mozilla Intermediate cipher configuration, HSTS, and automatic HTTP→HTTPS redirection
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy`, and `Permissions-Policy` on every response
- **Compression** — gzip for text, CSS, JS, JSON, and SVG assets
- **SPA fallback** — `try_files` to `index.html` for client-side routing

Pages:
- **Setup Wizard** — first-boot database and Vault configuration with bundled/external/skip vault mode selector
- **Dashboard** — user's connections with connect/credential vault, multi-select for tiled view, last-accessed tracking, favorites filter, group view toggle (flat list or collapsible group headers), and connection health status indicators (green/red/gray dots showing online/offline/unknown from background TCP probes)
- **Session Client** — HTML5 Canvas via `guacamole-common-js` (vendored 1.6.0 bundle with H.264 GFX passthrough; v0.28.0+) with clipboard sync (including pop-out windows), file transfer, a unified **Session Bar** dock consolidating all tools (Sharing, Quick Share, Keyboard, etc.) into a sleek right-side overlay, **Command Palette** (`Ctrl+K`) for instant connection search and launch from any session, **keyboard shortcut proxy** (Right Ctrl → Win key, `Ctrl+Alt+\`` → Win+Tab), **Keyboard Lock API** for capturing OS-level shortcuts in fullscreen over HTTPS, **display tags** (optional per-connection colored badge on session thumbnails, user-assignable via a tag picker dropdown), **dynamic browser tab title** (shows the active session's server name, e.g. "SERVER01 — Strata"), pop-out windows that persist across navigation with automatic screen-change detection and re-scaling, browser-based multi-monitor support via canvas slicing (Chromium Window Management API) with ~30 fps `setInterval` render loop (avoids `requestAnimationFrame` throttling when popups have focus), `MutationObserver`-based cursor sync across all secondary windows, horizontal-only layout (all monitors arranged left-to-right regardless of physical vertical position — best supported configuration is all landscape monitors side by side; monitors above or below appear as slices to the right), aggregate height capped to primary monitor height for taskbar visibility, `moveTo`/`resizeTo`/`requestFullscreen` auto-maximize on secondary popups, live `screenschange` detection for hot-plugged monitors, screen count detection shown in the toolbar tooltip, Chrome popup-blocker bypass via in-gesture `getScreenDetails()` for 3+ monitors, and Brave/privacy-browser compatibility, Quick Share panel (conditional on file transfer enabled) with drag-and-drop upload and one-click copy-to-clipboard download URLs, expired credential renewal at connect time, and automatic redirect to the next active session when one ends. (The legacy `forceDisplayRepaint()` ghost-pixel mitigation and the manual **Refresh display** button from v0.25.1–v0.27.x have been retired — H.264 passthrough eliminates the underlying ghost class.)
- **Tiled View** — multi-connection grid layout with per-tile focus, keyboard broadcast, and inline credential prompts
- **NVR Player** — admin-only read-only session observer with 5-minute rewind buffer, replay→live transition, and timeline controls
- **Sessions** — unified role-based page with Live Sessions and Recording History tabs; users see their own sessions, admins see all with kill/observe/rewind controls
- **Login** — unified login portal supporting local credentials and OIDC Single Sign-On; dynamically adjusts based on enabled authentication methods
- **Admin Settings** — tabbed UI for health, SSO, auth method toggles, Kerberos (multi-realm), vault, recordings, network (DNS configuration), access control, connection group management, AD sync sources (with inline password management configuration: enable toggle, credential source, target filter with preview, password policy, auto-rotation), password management (approval roles with explicit account scoping via searchable dropdown and chip tags, account mappings, checkout requests with decided-by column and self-approval detection), session analytics and metrics
- **Approvals** — dedicated page for pending password checkout approval decisions, visible only to users assigned to approval roles. Premium card layout with requester avatar, CN-from-DN display, labeled duration and justification sections, and approve/deny action buttons
- **Audit Logs** — paginated, hash-chained log viewer
- **Theme Toggle** — sidebar button cycling System → Light → Dark themes with localStorage persistence
- **PWA** — installable Progressive Web App with offline shell caching via service worker; standalone display mode on mobile and tablet

### 4. PostgreSQL

| Item | Value |
|---|---|
| Image | `postgres:16-alpine` |
| Port | 5432 (internal only) |
| Volume | `postgres-data` |

Bundled for zero-configuration first boot. Can be replaced with an external database at any time through the Admin UI.

### 5. HashiCorp Vault

| Item | Value |
|---|---|
| Image | `hashicorp/vault:1.19` |
| Storage | File backend (`/vault/data`) |
| Port | 8200 (internal only) |
| Volume | `vault-data` |
| Mode | Bundled (auto-provisioned) or External (user-provided) |

Bundled in Docker Compose for zero-configuration credential encryption. On first boot, the backend automatically:
1. Initializes the Vault (single unseal key, single key share)
2. Unseals the Vault
3. Enables the Transit Secrets Engine
4. Creates the encryption key (`guac-master-key` by default)
5. Stores the root token and unseal key in `config.toml`

On subsequent startups, the backend auto-unseals using the stored unseal key.

Alternatively, users can connect to an **external Vault instance** by selecting "External" mode during setup or in Admin Settings, providing their own address, token, and transit key name.

## Data Flow

### Connection Tunnel

```
Browser                    Backend                   guacd              Target
  │                          │                         │                  │
  │──── WS upgrade ─────────►│                         │                  │
  │                          │── TCP connect ──────────►│                  │
  │                          │── Guac handshake ───────►│                  │
  │                          │   (select + connect     │── RDP/SSH/VNC ──►│
  │                          │    with injected         │                  │
  │                          │    credentials)          │                  │
  │◄─── binary frames ──────►│◄── binary frames ──────►│◄────────────────►│
  │     (bidirectional)      │    (bidirectional)       │                  │
```

#### Proxy loop: decoupled sink + bounded channel

The tunnel proxy in [`backend/src/tunnel.rs`](../backend/src/tunnel.rs)
does not drive the `axum::WebSocket` directly from the main
`tokio::select!` loop. Doing so would couple output-path backpressure
to the input path: when guacd floods bitmap updates (e.g. the Windows
Win+Arrow window-snap animation, which emits a burst of draw
instructions in ~200 ms), the browser's WebSocket receive buffer
fills, `ws.send().await` inside the `tcp_read` arm blocks, and *while
it is blocked* the `ws.recv()` arm cannot run. Mouse/keyboard events
from the browser then queue up in the kernel TCP buffer and arrive at
guacd in bursts — users perceive this as rendering freezes, mouse
"acceleration," and keyboard lag.

The actual architecture decouples the sink from the select loop:

```
           ┌────────────────────────────────────────────────────┐
           │                  proxy_session()                   │
           │                                                    │
           │   ws ── .split() ──► ws_sink   ws_stream           │
           │                        │           │                │
           │                        ▼           │                │
           │                 ┌──────────────┐   │                │
           │                 │ writer_task  │   │                │
           │                 │ (tokio::spawn)│  │                │
           │                 └──────▲───────┘   │                │
           │                        │           │                │
           │           mpsc::<Message>(1024)    │                │
           │                        │           │                │
           │                        │           ▼                │
           │   ┌────────────────────┴───────────────────────┐   │
           │   │           tokio::select! loop               │   │
           │   │                                              │   │
           │   │  tcp_read ─► text assembly ─► ws_tx.send   │   │
           │   │  ws_stream.next() ────────► tcp_write       │   │
           │   │  kill_rx ───────────────► ws_tx.send(err)   │   │
           │   │  shared_input_rx ─────────► tcp_write       │   │
           │   │  ping_interval ───────────► ws_tx.send(ping)│   │
           │   │  writer_task join ─────► loop exit          │   │
           │   └─────────────────────────────────────────────┘   │
           └────────────────────────────────────────────────────┘
```

- **`ws.split()`** separates the WebSocket into `ws_sink` (owned
  permanently by the writer task) and `ws_stream` (polled by the
  select loop's input arm).
- **`tokio::sync::mpsc::channel::<Message>(1024)`** is the handoff
  point. 1024 messages is generous runway for any sustained draw
  rate; only a pathologically slow browser can back it up, and even
  then `ws_tx.send().await` yields (the future-returning send gives
  back control to the executor so the select can continue polling
  `ws_stream`/`shared_input_rx`).
- **Writer task** runs a trivial `while let Some(msg) = ws_rx.recv()`
  → `ws_sink.send(msg).await` loop. All I/O latency on the output
  path lives inside this task; the main select loop never awaits
  `ws_sink` directly.
- **Shutdown path** drops `ws_tx`, which causes `ws_rx.recv()` to
  return `None` and the writer task to flush + close the sink. A
  2 s `tokio::time::timeout` + `writer_task.abort()` fallback covers
  the case where the sink is wedged.

Additional tunnel details:

- **Web-protocol kiosk eviction (v1.3.0+).** When `protocol == "web"`,
  the tunnel route in [`backend/src/routes/tunnel.rs`](../backend/src/routes/tunnel.rs)
  captures an `Arc<WebRuntimeRegistry>` and the requesting `user_id`
  before the WebSocket upgrade. After `tunnel::proxy` returns
  (success or error), the route calls
  `web_runtime.evict(connection_id, user_id)` to drop the registry's
  reference to the kiosk's `Arc<WebSessionHandle>`. If no other tab is
  holding the same handle, refcount-zero `Drop` SIGKILLs the Chromium
  and Xvnc children (`kill_on_drop(true)`), releases the X-display
  slot (`100..=199`) and CDP port (`9222..=9321`), and removes the
  per-session profile tempdir (with its NSS DB inside). A
  `web.session.end` audit row with `reason: "tunnel_disconnect"` is
  written so the lifecycle event is visible. Before v1.3.0 only the
  idle reaper and process-death paths ran in production, so closing a
  browser tab without first hitting *Disconnect* leaked the kiosk
  until the reaper caught up.

- Guacamole instructions are delimited by `;` and can be split across
  TCP reads. The proxy maintains a `pending: Vec<u8>` that is drained
  up to the last `;` on each read (via `Vec::drain`, which is O(n) on
  the remainder — meaningfully cheaper than the previous `to_vec()`
  reallocation on large bitmap floods).
- The pending buffer is hard-capped at 16 MiB. Exceeding the cap emits
  a Guacamole `error "Protocol error: instruction exceeds pending
  buffer" "521"` instruction to the browser and closes the tunnel.
  The old behaviour of silently calling `pending.clear()` is unsafe
  because the stream would resume mid-token.
- The tunnel ingests non-ASCII WS frames via `str::from_utf8` before
  forwarding; invalid bytes are logged and dropped.
- Keepalives: `Ping` every 15 s, disconnect if no `Pong` within 30 s.
- Per-session bandwidth counters (`bytes_from_guacd`, `bytes_to_guacd`)
  are updated atomically on every read/write for the session-metrics
  endpoint.

#### H.264 GFX passthrough (v0.28.0+)

As of v0.28.0, RDP H.264 frames travel **end-to-end without a server-side
transcode step**. The path is:

```
Windows RDP host (AVC444 enabled)
    │  (RDPGFX H.264 stream)
    ▼
FreeRDP 3 inside guacd
    │  SurfaceCommand callback (patched)
    ▼
guacd display worker
    │  queues NAL units on guac_display_layer
    │  emits "4.h264,…" Guacamole instruction on per-frame flush
    ▼
WebSocket tunnel (passthrough — backend never decodes)
    ▼
Vendored guacamole-common-js 1.6.0 in browser
    │  4.h264 opcode handler routes NAL units to H264Decoder
    ▼
WebCodecs VideoDecoder (hardware-accelerated where available)
    ▼
Display canvas
```

The four cooperating components:

1. **`guacd/patches/004-h264-display-worker.patch`** — a byte-identical
   port of upstream `sol1/rustguac`'s H.264 display-worker patch
   (SHA `7a13504c2b051ec651d39e1068dc7174dc796f97`). Hooks FreeRDP's
   RDPGFX `SurfaceCommand` callback, queues AVC NAL units on each
   `guac_display_layer`, and emits them as a custom `4.h264` Guacamole
   instruction during the per-frame flush. **Supersedes** the v0.27.0
   `004-refresh-on-noop-size.patch` at the same path.
2. **Vendored `guacamole-common-js` 1.6.0**
   ([`frontend/src/lib/guacamole-vendor.js`](../frontend/src/lib/guacamole-vendor.js)) —
   bundles `H264Decoder` (line ~13408), the `4.h264` opcode handler
   (line ~16755), and a sync-point gate `waitForPending` (line ~17085)
   that prevents the decoder being asked to flush before its pending-
   frame queue has drained. **Stock `guacamole-common-js` does not handle
   the `h264` opcode**; the vendored bundle is required.
3. **Backend RDP defaults** ([`backend/src/tunnel.rs`](../backend/src/tunnel.rs)) —
   `full_param_map()` seeds `color-depth=32`, `disable-gfx=true`,
   `enable-h264=false`, `force-lossless=false`, `cursor=local`, plus
   the explicit `enable-*` / `disable-*` toggles that FreeRDP's
   `settings.c` requires (empty ≠ `"false"` in many guacd code paths).
   These defaults match the upstream
   [sol1/rustguac](https://github.com/sol1/rustguac) baseline that
   Strata's custom guacd is patched against, so a brand-new
   connection with no admin overrides behaves identically to a
   stock rustguac deployment. The per-connection `extras` allowlist
   permits `disable-gfx`, `disable-offscreen-caching`, `disable-auth`,
   `enable-h264`, `force-lossless`, and the related GFX toggles so
   the admin UI can override defaults per connection. The handshake
   driver gates `video/h264` mimetype advertisement on the resolved
   `enable-h264` value, so leaving GFX disabled or H.264 disabled
   will silently fall back to the bitmap path even on AVC444-capable
   hosts.
4. **Connection-form GFX/H.264 interlock (v1.1.0+)** — the RDP
   Codecs panel of `frontend/src/pages/admin/connectionForm.tsx`
   renders the *Enable graphics pipeline (GFX)* checkbox as ticked
   only when `disable-gfx === "false"` (i.e. it reflects what the
   backend will actually negotiate, not the absence of a value).
   The companion *Enable H.264 (AVC444)* checkbox is rendered
   disabled whenever GFX is off — the `video/h264` mimetype cannot
   be negotiated without GFX. Ticking H.264 forces
   `disable-gfx="false"` for you, and unticking GFX clears any
   previously-set `enable-h264`, so the form cannot be saved into
   an unreachable state. The `AdSyncTab.tsx` default-parameter
   editor mirrors this interlock so AD-synced connections inherit
   the same UX. See `CHANGELOG.md` 1.1.0 for the full UX
   rationale.
5. **Windows host AVC444 configuration** — the helper script
   [`docs/Configure-RdpAvc444.ps1`](Configure-RdpAvc444.ps1) audits
   the host registry, detects whether a hardware GPU is usable, and
   prompts before applying the recommended values. The full operator
   runbook is [`docs/h264-passthrough.md`](h264-passthrough.md).

The passthrough path **eliminates** the cross-frame ghost class that
v0.27.0's Refresh Rect mitigation (below) targeted: there is no
intermediate transcode step that can lose state across frames. The
v0.27.0 Refresh Display button has been retired from the Session Bar.

Verification flows in priority order:

1. **Authoritative** — Windows Event Viewer →
   `Applications and Services Logs > Microsoft > Windows >
   RemoteDesktopServices-RdpCoreTS > Operational`:
   - Event ID **162** = AVC444 mode active
   - Event ID **170** = hardware encoding active
2. guacd logs include `H.264 passthrough enabled for RDPGFX channel`
3. WebSocket trace shows `4.h264,…` instructions in DevTools Network
4. `client._h264Decoder?.stats()` shows `framesDecoded > 0`

If the host is not configured for AVC444, `enable-h264=true` is a
no-op: guacd loads the H.264 hook (visible in logs) but no
`SurfaceCommand` callbacks fire and the session falls back silently to
the bitmap path.

**Known limitation — DevTools-induced ghosting**: Chromium-based
browsers throttle GPU-canvas compositing and `requestAnimationFrame`
cadence on tabs whose DevTools panel is open. Cached tile blits fall
behind the live frame stream and the user perceives ghosting that
resembles a codec problem but is not. Closing DevTools (or detaching
to a separate window) restores normal compositor behaviour. This is
not fixable in the Strata client.

#### H.264 GFX reference-frame corruption (recovery path in v0.27.0)

> **Status — superseded by v0.28.0.** Retained for historical context.
> The cross-frame ghost class described below cannot occur with the
> v0.28.0 passthrough decoder, because there is no intermediate
> server-side transcode step to lose state across frames. The Refresh
> Display button has been retired from the Session Bar.

With `enable-gfx-h264=true` (the default for RDP connections), FreeRDP
hands decoded H.264 NAL units to guacamole-common-js's `VideoPlayer`
which renders them to the display canvas. H.264 is a delta-compressed
codec: every P-frame references one or more prior frames. If the
reference chain desynchronises between the server-side encoder and the
in-browser decoder — for example, a packet reordering window during a
rapid series of window minimise/maximise animations that briefly
exceeds the GFX cache ceiling — the browser continues to decode
subsequent deltas against a now-wrong reference. Visually, this appears
as multiple overlapping window states composited on one canvas.

v0.27.0 ships an in-session recovery path: the forked guacd
([`guacd/patches/004-refresh-on-noop-size.patch`](../guacd/patches/004-refresh-on-noop-size.patch))
intercepts a Guacamole `size W H` instruction whose dimensions match
the current remote desktop size (a no-op resize) and sends an RDP
`Refresh Rect` PDU to the RDP server via
`context->update->RefreshRect()`. Refresh Rect asks the server to
retransmit the specified region; on Windows servers this is expected
to be emitted as an H.264 IDR keyframe that resets the decoder's
reference-frame chain. A 1-second per-session cooldown guards against
accidental flooding. The Refresh Display button in `SessionBar` wires
a compositor nudge AND a no-op `client.sendSize(cw, ch)` through
`manualRefresh()` in `SessionClient.tsx` to drive this path.

Server-dependent behaviour: MS-RDPEGFX specifies Refresh Rect as valid
in GFX mode but does not mandate that servers emit an IDR keyframe in
response. On Windows 10/11 and Windows Server 2019/2022 the ghost is
expected to clear within one frame; on non-Microsoft or legacy RDP
targets this may be a no-op. Two fallback workarounds remain:

- **User-driven**: the Reconnect button in `SessionBar` performs a full
  `client.disconnect()` + re-establish, which cleanly re-initialises the
  codec state on both ends.
- **Operator-driven**: the Admin → Connection form's **Disable H.264
  codec** toggle (which writes `enable-gfx-h264=false` into the extras
  map) falls back to the RemoteFX codec, which has no cross-frame
  reference chain and cannot exhibit this class of ghost at the cost of
  2–4× higher bandwidth.

Approach note: the no-op-size-hijack was chosen over defining a new
Guacamole protocol opcode (e.g. a `refresh` instruction) so that stock
`guacamole-common-js` — which Strata does not fork — continues to work
unchanged. Stock guacd silently ignores a no-op resize, so the
frontend change is also safe to run against an un-patched guacd (the
compositor nudge still fires, the sendSize is a harmless no-op). The
extension is invisible at the wire-protocol layer.

### Envelope Encryption (Credential Save)

```
1. Rust generates random 32-byte DEK
2. Rust encrypts password with DEK (AES-256-GCM) → ciphertext + nonce
3. Rust sends plaintext DEK to Vault POST /transit/encrypt/guac-master-key
4. Vault returns wrapped DEK (vault:v1:base64...)
5. Rust stores (ciphertext, wrapped_dek, nonce) in PostgreSQL
6. Rust zeroizes plaintext DEK from memory
```

### Envelope Decryption (Tunnel Handshake)

```
1. Rust fetches (ciphertext, wrapped_dek, nonce) from PostgreSQL
2. Rust sends wrapped DEK to Vault POST /transit/decrypt/guac-master-key
3. Vault returns plaintext DEK
4. Rust decrypts password with DEK (AES-256-GCM)
5. Rust injects plaintext password into guacd handshake
6. Rust zeroizes DEK and password from memory
```

### Transactional-Email Pipeline

```
                                                ┌──────────────────────────────┐
checkout state-change                           │  email subsystem             │
(routes/user.rs)                                │  services/email/             │
       │                                        │                              │
       │  notifications::spawn_dispatch(event)  │  ┌────────────────────────┐  │
       ├───────────────────────────────────────►│  │ TemplateKey::from(evt) │  │
       │                                        │  └─────────┬──────────────┘  │
       ▼                                        │            │                 │
┌────────────────┐                              │  ┌─────────▼──────────────┐  │
│ recipients =   │                              │  │ Tera render (.mjml +   │  │
│ approvers ∪    │                              │  │  .txt.tera) with       │  │
│ requester ∪    │                              │  │  per-event context    │  │
│ audit list     │                              │  └─────────┬──────────────┘  │
└──────┬─────────┘                              │            │                 │
       │                                        │  ┌─────────▼──────────────┐  │
       │ filter users.notifications_opt_out     │  │ mrml MJML → HTML       │  │
       │ (audit-event templates bypass)         │  └─────────┬──────────────┘  │
       │                                        │            │                 │
       │  audit: notifications.skipped_opt_out  │  ┌─────────▼──────────────┐  │
       │                                        │  │ wrap_for_outlook_      │  │
       ▼                                        │  │  dark_mode (VML)       │  │
┌─────────────────────┐                         │  └─────────┬──────────────┘  │
│ INSERT email_       │                         │            │                 │
│  deliveries (queued)│                         │  ┌─────────▼──────────────┐  │
│   per recipient     │                         │  │ EmailMessage::builder  │  │
└──────────┬──────────┘                         │  │  + cid:strata-logo     │  │
           │                                    │  │  inline attachment     │  │
           ▼                                    │  └─────────┬──────────────┘  │
   ┌───────────────┐                            │            │                 │
   │ SmtpTransport │◄───────────────────────────┘            │                 │
   │  (lettre 0.11)│                                         │                 │
   └───────┬───────┘                                         │                 │
           │ multipart/related (HTML + text + inline image)  │                 │
           ▼                                                 │                 │
      ┌─────────┐                                            │                 │
      │  SMTP   │                                            │                 │
      │  relay  │                                            │                 │
      └────┬────┘                                            │                 │
           │                                                 │                 │
   ┌───────▼─────────────────┐                               │                 │
   │ permanent failure (5xx) │ ─► UPDATE status='failed' (no retry)            │
   │ transient failure       │ ─► UPDATE status='failed', attempts++           │
   │ success                 │ ─► UPDATE status='sent', sent_at=now()          │
   └─────────────────────────┘                                                  │
                                                                                │
   ┌────────────────────────────────────────────────────────────────────────┐  │
   │ services/email/worker.rs (background, 30s tick, 60s warm-up)           │  │
   │   SELECT * FROM email_deliveries                                       │  │
   │     WHERE status='failed' AND attempts < 3 AND retry_after < now()     │  │
   │   → re-render → resend → on 3rd failure mark abandoned                 │  │
   └────────────────────────────────────────────────────────────────────────┘
```

**Why MJML?** MJML compiles to table-based HTML that survives every major
client (Gmail, Outlook desktop/web/mobile, Apple Mail, Thunderbird, K-9).
Hand-rolling that markup is fragile; generating it from MJML lets the
templates focus on layout intent rather than client quirks. The renderer
runs server-side via the [`mrml`](https://github.com/jdrouet/mrml) Rust
port — no Node.js round-trip is required at boot or at send time.

**Outlook dark-mode wrapper.** `wrap_for_outlook_dark_mode` adds a VML
namespace on `<html>`, a full-bleed `<v:background fill="t">` rectangle
inside an `<!--[if gte mso 9]>` conditional, and an Outlook-only
stylesheet. VML backgrounds are immune to Outlook desktop's dark-mode
inversion engine, so the result is a clean dark-themed email even on
Outlook for Windows in dark mode. Future templates inherit the fix
automatically.

**Standalone templates only.** mrml's XML parser does not tolerate
Tera's `{% include %}` mechanism (whitespace from the include directive
breaks parsing at the section/column boundary). Each of the four
templates is therefore self-contained: no `_header.mjml` /
`_footer.mjml` partials, no `<mj-attributes>` block, font-family set
per-element. Context values are escaped through a custom `xml_escape`
helper (only the five XML-significant characters: `& < > " '`) — using
`ammonia::clean_text` over-escapes (it encodes spaces as `&#32;`) and
breaks rendering.

**Vault-sealed SMTP password.** The SMTP password is never stored in
`system_settings`. It is sealed via the existing
`crate::services::vault::seal_setting` helper and unsealed at send time.
The `PUT /api/admin/notifications/smtp` endpoint refuses to save
credentials when Vault is sealed or running in stub mode — a
half-configured install should fail loudly rather than silently leak the
password to disk in plaintext.

**Dispatcher hooks.** Four call sites in `routes/user.rs` invoke
`notifications::spawn_dispatch`:

| Call site | Event |
|---|---|
| `request_checkout` (Pending branch) | `CheckoutEvent::Pending` → all approvers for the target account |
| `request_checkout` (SelfApproved branch) | `CheckoutEvent::SelfApproved` → audit recipients (bypasses opt-out) |
| `decide_checkout` (Approved branch) | `CheckoutEvent::Approved` → original requester |
| `decide_checkout` (Rejected branch) | `CheckoutEvent::Rejected` → original requester |

`spawn_dispatch` is fire-and-forget — it returns immediately so the
user-facing checkout request is never blocked by mail delivery. All
errors are logged via `tracing` and visible in `email_deliveries`.

## Command Palette (v0.31.0)

The in-session Command Palette (default `Ctrl+K`, user-rebindable per
v0.30.1) exposes both **connection search** (typed text without a
leading colon) and a **scriptable command surface** (typed text with a
leading colon). The command surface is composed of two registries:

1. **Built-in commands** — hard-coded in
   [`frontend/src/components/CommandPalette.tsx`](../frontend/src/components/CommandPalette.tsx).
   Names: `reload`, `disconnect`, `close`, `fullscreen`, `commands`,
   `explorer`. Built-in
   handlers reuse the same primitives as the SessionBar (e.g.
   `requestFullscreenWithLock`) so behaviour is identical regardless of
   how the action is invoked. Built-in names are reserved — user
   mappings cannot collide with them.
2. **User mappings** — sourced from `user_preferences.preferences ->
   commandMappings` (JSONB array, max 50 entries per user). Each
   mapping is a discriminated union with `trigger`, `action`, and
   `args`. The six allowed actions are `open-connection`, `open-folder`,
   `open-tag`, `open-page`, `paste-text`, and `open-path`; the
   `open-page` `args.path` is locked to the seven-value enum
   `/dashboard | /profile | /credentials | /settings | /admin | /audit | /recordings`,
   `paste-text` `args.text` is capped at 4096 characters, and
   `open-path` `args.path` is capped at 1024 characters and rejected
   if it contains any control characters. The `paste-text` action
   writes `args.text` to the active session's remote clipboard via
   `Guacamole.Client.createClipboardStream`, then fires a Ctrl+V
   keystroke (keysyms `0xffe3` + `0x76`) so the focused remote
   application actually receives the paste. The `open-path` action
   drives the Windows Run dialog on the remote target: it sends Win+R
   (keysyms `0xffeb` + `0x72`), pastes the path the same way, then
   sends Enter (`0xff0d`) — which makes Explorer (or whichever app is
   registered for that URI scheme) open the path. The audit stream
   logs only `{ text_length }` / `{ path_length }` for these two
   actions so potentially sensitive payloads never leave the
   originating user's preferences blob.

Validation is enforced server-side inside
[`backend/src/services/user_preferences.rs`](../backend/src/services/user_preferences.rs)
(`validate_command_mappings`), so a frontend that bypasses client-side
checks still cannot poison the database.

### Resolver and ghost-text autocomplete

When the input starts with `:`, the palette merges the built-in registry
with the user's mappings into a single sorted candidate list. Two
quantities are derived from that list and the current query:

- `matchingCommands` — every candidate whose name starts with the
  query slug. Drives the inline `:commands` listing and the empty
  state.
- `ghostSuffix` — the longest common prefix shared by every member of
  `matchingCommands` minus the already-typed slug. Rendered in a
  zero-position-offset, `pointer-events-none`, `opacity: 0.35`
  overlay. **Tab** or **Right Arrow** (when the caret is at end-of-
  input) commits the suggestion.

### Audit flow

Every successful command execution writes one immutable, hash-chained
`command.executed` row to the `audit_logs` table via the new
fire-and-forget endpoint:

```
frontend executeCommand()
  ├── await postCommandAudit({ trigger, action, args, target_id })   // best-effort, .catch swallowed
  └── run the action (navigate / disconnect / reload / fullscreen)
```

The audit POST is intentionally invoked _before_ the action runs so
the audit row captures intent even if the action throws. The endpoint
([`POST /api/user/command-audit`](api-reference.md#post-apiusercommand-audit))
hard-codes `action_type = "command.executed"` server-side; client-side
poisoning of the audit-event taxonomy is impossible. The chain-hash
integrity guarantees described in
[security.md → Audit Trail](security.md#audit-trail) apply uniformly to
this stream.

## Database Schema

```
system_settings ──── key/value config store
users ──────────────── OIDC subject, username, role FK
roles ────────────── granular permissions (can_manage_system, can_manage_users, can_manage_connections,
                       can_view_audit_logs, can_view_sessions, can_create_users, can_create_user_groups,
                       can_create_connections [unified with folders], can_create_sharing_profiles,
                       can_use_quick_share — user-facing, excluded from admin-surface checks)
connections ──────── target host, protocol, port, domain, description, group FK, ad_source FK, health_status, health_checked_at
connection_groups ── folder hierarchy with parent_id self-reference
role_connections ──── many-to-many role ↔ connection
user_credentials ──── encrypted password + DEK + nonce per user/connection
credential_profiles ─ saved credential profiles with optional TTL expiry and optional checkout_id link to password management
user_favorites ────── user ↔ connection favorites (composite PK)
connection_shares ── temporary share links with mode (view/control); viewers observe via NVR broadcast
kerberos_realms ──── multi-realm Kerberos config (realm, KDCs, admin server, lifetimes)
ad_sync_configs ──── AD LDAP source configs (URL, auth, search bases, PM search bases, filter, schedule, CA cert, connection_defaults)
ad_sync_runs ─────── per-config sync run history with stats
recordings ─────── session recording metadata with bandwidth metrics
active_sessions ── per-user login session tracking (JTI, IP, user agent, expiry)
approval_roles ──── named approval roles for password management
approval_role_assignments ── many-to-many user ↔ approval role
approval_role_accounts ──── explicit scope: approval role ↔ managed AD account DN
user_account_mappings ───── user ↔ managed AD account (with self-approve flag)
password_checkout_requests ─ checkout lifecycle tracking (Pending/Approved/Active/Expired/Denied/CheckedIn, timestamps, Vault-sealed password)
email_deliveries ──── transactional-email audit trail (template_key, recipient, subject, status, attempts, last_error, related_entity_type/id) — status ∈ {queued,sent,failed,bounced,suppressed}
users.notifications_opt_out ─ boolean column; honoured by every transactional message except the self-approved audit notice
user_preferences ──── per-user UI preferences blob (JSONB, schema owned by the frontend, validated server-side); keys: `commandPaletteBinding` (default `"Ctrl+K"`, added v0.30.1), `commandMappings` (default `[]`, added v0.31.0 — array of typed `:command` palette mappings, max 50 entries, validated by `services::user_preferences::validate_command_mappings`)
```

See `backend/migrations/001_initial_schema.sql` through `058_user_preferences.sql` for the full DDL.

## Directory Structure

```
strata-client/
├── .github/workflows/     CI/CD pipelines
│   └── build-guacd.yml    Automated guacd image build
├── backend/               Rust backend
│   ├── Cargo.toml
│   ├── Dockerfile
│   ├── migrations/        SQL migration scripts
│   └── src/
│       ├── main.rs        Entry point, bootstrap
│       ├── config.rs      config.toml model
│       ├── error.rs       Unified error type
│       ├── tunnel.rs      Guacamole protocol + WS↔TCP proxy
│       ├── db/            Database pool, migrations
│       ├── routes/        HTTP & WebSocket handlers
│       │   ├── admin.rs   Admin CRUD endpoints
│       │   ├── health.rs  Health & status
│       │   ├── setup.rs   First-boot initialisation
│       │   ├── tunnel.rs  WebSocket tunnel upgrade
│       │   ├── share.rs    Connection sharing (view/control modes)
│       │   ├── files.rs   Quick Share temp file CDN (upload/download/list/delete)
│       │   ├── tunnel.rs  WebSocket tunnel upgrade
│       │   └── user.rs    User-facing endpoints
│       └── services/      Business logic
│           ├── app_state.rs   Shared state + boot phase
│           ├── ad_sync.rs     AD LDAP sync engine (multi-base, multi-auth)
│           ├── audit.rs       Hash-chained audit logging
│           ├── auth.rs        OIDC token validation
│           ├── checkouts.rs   Password checkout lifecycle + rotation workers
│           ├── guacd_pool.rs  Round-robin guacd pool
│           ├── health_check.rs  Background TCP health probes for connections
│           ├── kerberos.rs    Multi-realm krb5.conf generation
│           ├── middleware.rs   JWT auth + admin middleware
│           ├── recordings.rs  Recording config + scheduled retention purge (DB rows, Azure blobs, local files)
│           ├── session_cleanup.rs  Periodic active_sessions expiry sweep
│           ├── session_registry.rs  NVR ring buffer + live session tracking
│           ├── settings.rs    system_settings CRUD
│           ├── trusted_ca.rs  Trusted CA bundle CRUD + per-session NSS DB import via `certutil` (v1.2.0)
│           ├── user_cleanup.rs  Hard-delete soft-deleted users after configurable window (default 90 days)
│           ├── file_store.rs  Session-scoped temporary file storage
│           ├── vault.rs       Envelope encryption
│           ├── notifications.rs  Dispatcher: maps CheckoutEvent → recipients → EmailMessage; honours opt-outs; writes email_deliveries rows
│           ├── email/         Transactional email subsystem
│           │   ├── mod.rs         Re-exports + EmailTransport trait
│           │   ├── message.rs     EmailMessage + builder + InlineAttachment
│           │   ├── transport.rs   EmailTransport trait + StubTransport (for tests)
│           │   ├── smtp.rs        SmtpTransport (lettre 0.11, rustls, STARTTLS/implicit/none) + permanent vs transient classifier
│           │   ├── outlook.rs     wrap_for_outlook_dark_mode (VML namespace + <v:background> + Outlook-only stylesheet)
│           │   ├── templates.rs   Tera + mrml renderer; standalone MJML templates; custom xml_escape
│           │   ├── templates/     4 MJML + 4 plaintext templates per checkout event
│           │   └── worker.rs      Background retry worker (30s tick, exp backoff, 3 attempts max)
│           └── vault_provisioning.rs  Bundled Vault lifecycle
├── frontend/              React SPA + nginx gateway
│   ├── Dockerfile
│   ├── common.fragment    Shared nginx config (proxy rules, security headers, compression)
│   ├── http_only.conf     HTTP-only server block
│   ├── https_enabled.conf HTTPS server block (SSL termination + HSTS)
│   ├── connection-upgrade.conf  WebSocket upgrade header mapping
│   ├── ssl-init.sh        Entrypoint: selects HTTP or HTTPS config based on cert presence
│   ├── package.json
│   └── src/
│       ├── api.ts         Typed API client
│       ├── App.tsx        Router + boot detection
│       ├── components/    Shared components (Layout, Select, SessionBar, SessionManager, QuickShare, SessionTimeoutWarning, ThemeProvider, WhatsNewModal)
│       └── pages/         Page components (Dashboard, Documentation, SessionClient, AdminSettings, AuditLogs, Approvals, Login, SetupWizard, SharedViewer)
│           ├── admin/     One module per Admin Settings tab (Security, Network, Display, SSO, Kerberos, Recordings, Vault, Tags, Health, Sessions, Passwords, AdSync, Access) plus the shared connection-form helpers
│           └── credentials/  Credentials page child components (RequestCheckoutForm, ProfileEditor)
├── guacd/                 Custom guacd build
│   ├── Dockerfile
│   └── entrypoint.sh     DNS config + privilege drop wrapper
├── certs/                 TLS certificates (mount for HTTPS)
├── docker-compose.yml     Full stack orchestration
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE                Apache 2.0
├── NOTICE                 Third-party attributions
└── README.md
```

## Architecture Decision Records

Design decisions whose rationale outlives any single commit live as
numbered ADRs under [adr/](adr/):

| ADR | Topic |
|---|---|
| [ADR-0001](adr/ADR-0001-rate-limit-single-instance.md) | Rate-limit state: single-instance constraint with promotion criteria |
| [ADR-0002](adr/ADR-0002-csrf-samesite-strict.md) | CSRF strategy: `SameSite=Strict` as the compensating control |
| [ADR-0003](adr/ADR-0003-feature-flags-deferred.md) | Feature flags: boolean `settings` keys instead of a dedicated table |
| [ADR-0004](adr/ADR-0004-guacd-connection-model.md) | guacd connection model, protocol-parameter allow-list, and trust boundaries |
| [ADR-0005](adr/ADR-0005-jwt-refresh-token-sessions.md) | JWT + refresh-token TTLs, single-use rotation, forced-logout lever |
| [ADR-0006](adr/ADR-0006-vault-transit-envelope.md) | Vault Transit envelope (`vault:<base64>`), rotate + rewrap path |
| [ADR-0007](adr/ADR-0007-emergency-bypass-checkouts.md) | Emergency approval bypass and scheduled-start checkouts |
| [ADR-0008](adr/ADR-0008-notification-pipeline.md) | Transactional-email subsystem: MJML/mrml renderer, Vault-sealed SMTP password, opt-out semantics, retry worker |

## Operational Runbooks

Step-by-step procedures for on-call engineers live under
[runbooks/](runbooks/):

| Runbook | When to use |
|---|---|
| [disaster-recovery.md](runbooks/disaster-recovery.md) | Host loss or corrupted volumes (RTO ≤ 4h, RPO ≤ 24h) |
| [security-incident.md](runbooks/security-incident.md) | Credential exposure, token replay, unauthorised config change |
| [certificate-rotation.md](runbooks/certificate-rotation.md) | Scheduled rotation or expiry alert (ACME + internal CA) |
| [vault-operations.md](runbooks/vault-operations.md) | Vault unseal, Transit key rotate + rewrap, Shamir rekey |
| [database-operations.md](runbooks/database-operations.md) | Replica promotion, migration rollback, panic-boot recovery |
| [smtp-troubleshooting.md](runbooks/smtp-troubleshooting.md) | Notification emails not arriving, SMTP failures, retry-worker stalls, Vault sealing during config |

## Extended protocols

In addition to the classic RDP / SSH / VNC connections, Strata
supports two driver-backed connection types where the backend
supervises a workload on the user's behalf:

- **Web Sessions** (`web` protocol) — ephemeral kiosk Chromium inside
  Xvnc, tunnelled as VNC. See [`web-sessions.md`](web-sessions.md).
- **VDI Desktop Containers** (`vdi` protocol) — Strata-managed
  Docker container running xrdp, tunnelled as RDP. See
  [`vdi.md`](vdi.md).

Both extensions land their per-connection configuration in
`connections.extra` (JSONB) and inherit the existing recording, audit,
and credential-mapping pipelines unchanged.

### Web Sessions runtime (shipped v0.30.0)

```
   ┌────────────────────┐  tunnel.rs    ┌────────────────────────────┐
   │ Tunnel (web)       │──────────────▶│ WebRuntimeRegistry::ensure │
   └────────────────────┘               └─────────────┬──────────────┘
                                                      │
        ┌─────────────────────────────────────────────┴───────────┐
        │                                                          │
        ▼                                                          ▼
 ┌─────────────────┐  alloc :100..:199  ┌────────────┐    write   ┌──────────────┐
 │ WebDisplay      │───────────────────▶│ /tmp/      │───────────▶│ Login Data   │
 │ Allocator       │                    │ strata-    │  autofill  │ (AES-128-CBC)│
 └─────────────────┘                    │ chromium-… │            └──────────────┘
                                        │ (profile)  │
                                        └────────────┘
        │                                       │
        ▼                                       ▼
 ┌──────────────────┐                 ┌────────────────────────┐
 │ Xvnc :{display}  │◀── DISPLAY ─────│ chromium --kiosk       │
 │ -SecurityTypes   │                 │   --user-data-dir=…    │
 │  None            │                 │   --remote-debugging-  │
 │ -localhost yes   │                 │     address=127.0.0.1  │
 │ -geometry WxH    │                 │   --remote-debugging-  │
 └────────┬─────────┘                 │     port={cdp}         │
          │                           │   --host-rules="…"     │
          │                           │   {url}                │
          ▼                           └──────────┬─────────────┘
   guacd attaches                               │
   to vnc://127.0.0.1:                          ▼
   {5900+display}                  ┌──────────────────────────┐
                                   │ Login script runner      │
                                   │ over CDP (localhost-only)│
                                   └──────────────────────────┘
```

Allocator state machine: `WebDisplayAllocator` keeps a `BTreeSet<u8>`
of free displays; `acquire()` removes the first; `release(display)`
re-inserts. The cap of 100 simultaneous sessions is the size of the
range `:100..:199`. `CdpPortAllocator` mirrors the structure for
`9222..9421`. Both are `Arc<…>` so the runtime can share them across
spawn workers.

Reuse semantics: `WebRuntimeRegistry::ensure(connection_id, user_id,
session_id, spec)` returns the existing handle for a `(connection_id,
user_id)` pair if one is registered and still alive, so a tab refresh
doesn't pay the spawn cost twice. When the tunnel closes the registry
keeps the handle for a short grace window; an idle reaper destroys it
afterwards.

#### Trusted CA bundles for Web Sessions (v1.2.0)

A new admin-managed table `trusted_ca_bundles` stores PEMs once with
a friendly name; any `web` connection can attach a bundle via
`extra.trusted_ca_id`. The runtime path is:

1. `routes/tunnel.rs` resolves `cfg.trusted_ca_id` to the PEM bytes
   via `services::trusted_ca::get(&pool, id)` *before* constructing
   the `WebSpawnSpec`.
2. `WebSpawnSpec.trusted_ca_pem` and `trusted_ca_label` flow into the
   spawn worker.
3. The worker calls `services::trusted_ca::import_pem_into_nss_db(
   &pem, profile_dir, label)` which executes
   `certutil -N --empty-password -d sql:<profile>/.pki/nssdb` followed
   by `certutil -A -d sql:<profile>/.pki/nssdb -n <label> -t "C,," -i <tmp.pem>`.
4. Chromium reads the NSS DB at startup and trusts the supplied roots
   without any `--ignore-certificate-errors` flag.
5. The NSS DB lives inside the per-session profile directory and is
   destroyed with it on session end.

`certutil` is provided by the `libnss3-tools` apt package, baked into
the backend image since v1.2.0. PEMs are validated at upload time
with `rustls-pemfile::certs` + `x509_parser::parse_x509_certificate`
and the parsed `subject` / `not_after` / `fingerprint` (SHA-256 hex,
colon-separated) are cached on the row so list views never re-parse.
The PEM column is treated as **public material** (signatures over
public keys) and is *not* envelope-encrypted via Vault — see the
[Security](security.md) document for the rationale.

### VDI runtime (shipped v0.30.0)

```
   ┌────────────────────┐  tunnel.rs       ┌────────────────────────┐
   │ Tunnel (vdi)       │─────────────────▶│ VdiDriver::            │
   │  → wire = "rdp"    │                  │   ensure_container     │
   │  → host = name     │                  │ (DockerVdiDriver)      │
   │  → port = 3389     │                  └────────────┬───────────┘
   └────────────────────┘                               │
                                                        │ bollard 0.18
                                  ┌─────────────────────┘
                                  │
                                  ▼
                        ┌───────────────────────┐
                        │ /var/run/docker.sock  │ (overlay-only)
                        └───────────┬───────────┘
                                    │
                  ┌─────────────────┴────────────────┐
                  │ create + start + attach network  │
                  ▼                                  ▼
        ┌──────────────────────┐         ┌──────────────────────┐
        │ image whitelisted?   │   no    │ vdi.image.rejected   │
        │  (strict equality)   │────────▶│  audit event + 503   │
        └──────────┬───────────┘         └──────────────────────┘
                   │ yes
                   ▼
        ┌──────────────────────────────────────────────┐
        │ Container: strata-vdi-{conn[..12]}-          │
        │             {user[..12]}                     │
        │   • labels: strata.managed=true,             │
        │             strata.connection_id=…,          │
        │             strata.user_id=…,                │
        │             strata.image=…                   │
        │   • env: VDI_USERNAME, VDI_PASSWORD          │
        │   • host config: --cpus, --memory            │
        │   • restart policy: no                       │
        │   • network: STRATA_VDI_NETWORK              │
        │   • bind: HOME (when persistent_home=true)   │
        └────────────────┬─────────────────────────────┘
                         │
                         ▼
                  vdi_containers row upsert
                  (connection_id, user_id, container_name,
                   image, state='running', last_seen_at)
```

Deterministic naming: `container_name_for(connection_id, user_id)`
takes the first 12 hex chars of each UUID, separated by `-`, with the
prefix `strata-vdi-`. The same `(connection, user)` pair always
resolves to the same name, so `ensure_container` short-circuits to a
reuse path when the container already exists.

Ephemeral credentials: when the credential cascade resolves to no
password, `ephemeral_credentials(strata_username)` returns a
`(sanitised_posix_username, fresh_24char_password)` pair. The
sanitised username is a pure function of the Strata username so the
bind-mounted `$HOME` is consistent across reconnects; the password is
fresh per call so the live xrdp instance always sees a new value.

Wire-protocol translation: `tunnel.rs` rewrites
`wire_protocol = "rdp"` and replaces hostname/port with the
network-attached endpoint. The original `vdi` label is preserved on
`nvr_protocol` so recordings keep the operator-facing icon.

Network resolution: `STRATA_VDI_NETWORK` (env var, threaded through
`main.rs`) defaults to
`${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal` in the overlay
file so containers join the same Compose-prefixed network as the rest
of the stack.

Socket permission handling: `entrypoint.sh` either creates a
`docker-host` group at the socket's GID (Linux distros) or `chgrp` +
`chmod g+rw` the bind-mount in place (Docker Desktop GID 0). See
[`vdi.md`](vdi.md) § *Docker socket permissions* for the exact
script.

VDI-specific tunnel parameter overrides:

| Param           | Forced for VDI   | Reason                                                |
| --------------- | ---------------- | ----------------------------------------------------- |
| `ignore-cert`   | `true`           | Per-container self-signed cert; both ends Strata-controlled. |
| `security`      | `any`            | xrdp negotiates whatever it can.                     |
| `resize-method` | `""`             | xrdp's display-update channel drops on resize storms. |

