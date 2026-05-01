# What's New in v1.4.0

> **Minor release.** Apache Guacamole's `kubernetes` protocol
> arrives in Strata as a first-class connection type alongside
> `rdp` / `ssh` / `vnc` / `web` / `vdi`. `kubectl attach` and
> `kubectl exec` now render as a terminal in the browser, with
> the same recording, audit, credential-profile and tunnel
> infrastructure as every other Strata session. Includes a
> kubeconfig importer that breaks a pasted `~/.kube/config`
> into the right form fields and shows the client private key
> exactly once for the operator to stash in a credential
> profile. **Backwards compatible with v1.3.x** — one new
> migration (`060_kubernetes_protocol.sql`, widens the
> `connections.protocol` `CHECK`); no breaking `/api/*` or
> `config.toml` changes.

---

## 🚢 Kubernetes pod console

Add a new connection, pick **Kubernetes Pod** as the protocol,
fill in the API server hostname/port, paste your kubeconfig into
the **Import kubeconfig** textarea above the form sections, and
click *Parse and fill form*. Strata extracts the cluster server,
namespace, CA cert and client cert into the right fields; the
client *private key* surfaces in a "copy now" panel that goes
away as soon as you stash it into a credential profile (it's
never persisted on this path).

The protocol surfaces in:

- **Admin → Access** form (new `KubernetesSections` block).
- **Command palette** session list (Kubernetes-style heptagon
  wheel icon).
- **Dashboard** connection cards (same icon, larger).
- **Active Sessions** badge (`k8s` chip).
- **Audit logs** and **session recordings** — automatic, both
  are protocol-agnostic.

### What ships in 1.4.0

- `guacd/Dockerfile` build guard that fails the image build if
  `libguac-client-kubernetes.so` is missing after `make install`.
- `backend/src/tunnel.rs` `kubernetes` branch in `full_param_map()`
  with terminal defaults; whitelist additions for `namespace`,
  `pod`, `container`, `exec-command`, `use-ssl`, `ca-cert` and
  `client-cert` extras (note: `client-key` is *not* whitelisted —
  the private half flows through the Vault-encrypted credential-
  profile path, never connection extras).
- `backend/src/routes/tunnel.rs` credential remap that takes the
  decrypted profile password slot, drops it into the `extra` map
  as `client-key`, and clears username/password.
- Migration `060_kubernetes_protocol.sql`.
- `backend/src/services/kubernetes.rs` kubeconfig YAML parser
  (with five unit tests).
- New admin endpoint `POST /api/admin/kubernetes/parse-kubeconfig`,
  gated by `check_system_permission` and exercised by the
  `e2e/tests/rbac.spec.ts` no-auth/wrong-role matrices.
- Frontend additions: `protocolFields.ts` registry entry,
  `KubernetesSections` form component, `KubeconfigImporter`
  importer panel, protocol icons in CommandPalette / Dashboard /
  ActiveSessions, `parseKubeconfig` API client.

### Deferred to a later release

A live `POST /api/admin/kubernetes/list-pods` endpoint that talks
directly to the K8s API and feeds a pod-picker dropdown would be
nice but pulls in the `kube` Rust crate's ≈80-deep transitive
dependency tree. Operators can use `kubectl get pods` out-of-band
to find the pod name today.

---

# What's New in v1.3.2

> **Patch release on top of v1.3.1.** Four orthogonal fixes that
> closed real production-affecting issues: the custom `guacd`
> image stopped building once Alpine edge bumped FreeRDP from
> 3.24 to 3.25 (the `Authenticate` callback field was renamed to
> `AuthenticateEx` and grew an extra parameter); RDP sessions
> rendered a black "ghost region" along the edge of the canvas
> after a server-driven desktop resize; the WebSocket tunnel kept
> a recording stream and `session_registry` row alive
> indefinitely if the operator's tab was killed without a
> graceful close; and clicking **Log out** flipped React auth
> state without first closing any open Guacamole tunnels, so the
> backend kept proxying frames into a logged-out user's
> recording until the tab eventually closed itself. **Drop-in
> upgrade from v1.3.1** — no database migrations, no `/api/*`
> contract changes, no `config.toml` schema changes; rebuild the
> backend, frontend, and `guacd` images so the new bits
> actually run.

---

## 🛠️ guacd image builds again on Alpine edge (FreeRDP 3.25)

[`apache/guacamole-server@2980cf0`](https://github.com/apache/guacamole-server/tree/2980cf0/src/protocols/rdp)
(release 1.6.1) was written against FreeRDP 3 and uses the legacy
`Authenticate` callback field on `struct rdp_freerdp` to register
its credential-prompt hook. **FreeRDP 3.25 deleted that field**
in favour of a new `AuthenticateEx` callback that takes one
extra argument:

```c
typedef BOOL (*pAuthenticate)(freerdp* instance, char** username,
        char** password, char** domain);
typedef BOOL (*pAuthenticateEx)(freerdp* instance, char** username,
        char** password, char** domain, rdp_auth_reason reason);
```

The moment Alpine edge rolled `freerdp-dev` from `3.24.2-r0` to
`3.25.0-r0`, the build broke at compile time:

```text
src/protocols/rdp/rdp.c:565:15: error:
    'freerdp' {aka 'struct rdp_freerdp'} has no member named
    'Authenticate'; did you mean 'AuthenticateEx'?
```

[`guacd/patches/006-freerdp325-authenticate-ex.patch`](guacd/patches/006-freerdp325-authenticate-ex.patch)
adds three small unified-diff hunks against `rdp.c`:

1. **Adds `#include <freerdp/version.h>`** near the existing
   `<freerdp/...>` includes so the `FREERDP_VERSION_MAJOR` /
   `FREERDP_VERSION_MINOR` preprocessor macros are visible at
   every conditional that follows. Without this, the macros
   are *not* transitively defined inside `rdp.c` despite
   `<freerdp/freerdp.h>` being included — a fact that wasted
   an embarrassing amount of debugging time during the first
   patch attempt.
2. **Wraps the function signature** in
   `#if defined(FREERDP_VERSION_MAJOR) && (FREERDP_VERSION_MAJOR > 3 || (FREERDP_VERSION_MAJOR == 3 && FREERDP_VERSION_MINOR >= 25))`
   / `#else` / `#endif` so the FreeRDP 3.25+ build gets the
   five-argument signature with `rdp_auth_reason reason`,
   while FreeRDP 3.24 and earlier keep the four-argument
   signature. The added `reason` parameter is intentionally
   discarded with `(void) reason;` because the existing
   implementation already requests whichever credentials are
   missing, regardless of the reason FreeRDP raised the
   callback.
3. **Wraps the callback assignment** in the same `#if` /
   `#else` / `#endif` so FreeRDP 3.25+ gets
   `rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;`
   while older versions keep the legacy `Authenticate` field
   name.

### Defence-in-depth: Dockerfile grep guard

The first attempt at this patch *applied successfully* —
`patch -p1` returned exit 0 for every hunk — but selected the
`#else` (legacy) branch at every conditional because
`FREERDP_VERSION_MAJOR` was undefined at that point in the
translation unit. The build then failed at compile time with
the *same* error as before, just with the line number shifted
down by 11 (the size of the inserted `#if` blocks). It cost
several iterations to realise the patch was applying but
silently no-op'ing.

[`guacd/Dockerfile`](guacd/Dockerfile) now runs two `grep -q`
assertions immediately after the patch loop that fail the build
with a clear error message if the post-patch source tree does
not contain `#include <freerdp/version.h>` *and*
`rdp_inst->AuthenticateEx = rdp_freerdp_authenticate;`. Future
silent semantic regressions get caught in seconds rather than
minutes.

### LF line endings on patch files

[`guacd/patches/.gitattributes`](guacd/patches/.gitattributes)
pins `*.patch` to `text eol=lf` so contributors with
`core.autocrlf=true` on Windows cannot accidentally introduce
CRLF that misaligns hunk context lines. Patch files are byte-
sensitive — a single CRLF-converted hunk header can fail
`git apply` and `patch -p1` for non-obvious reasons.

> **Forward compatibility.** The `#if` guard on patch 006 means
> contributors on Debian 13 / Trixie (which still ships
> `freerdp-3.24`) build identically to before; the new hunks
> are only active on FreeRDP 3.25+. The pinned upstream
> `apache/guacamole-server` commit (`2980cf0`) is unchanged.

---

## 🖥️ Black "ghost regions" after RDP desktop resize are gone

When a Windows RDP server changed resolution mid-session
(resolution change inside a VM, GFX channel renegotiation,
multi-monitor reconfiguration), the Strata canvas would render a
solid-black margin along the edge of the new desktop area until
the user moved a window across the affected region to force a
repaint. The visual was confusing — operators routinely thought
their session had crashed.

**Root cause:** `guac_rdp_gdi_desktop_resize` in
`src/protocols/rdp/gdi.c` allocates a new GDI buffer via
`gdi_resize` and updates `gdi->width` / `gdi->height`, but never
asks the RDP server to retransmit pixels for the new desktop
area, and never marks the layer dirty. Whatever was previously
in the layer (often zero — solid black) stays there until a
subsequent paint covers it.

[`guacd/patches/005-refresh-rect-on-resize.patch`](guacd/patches/005-refresh-rect-on-resize.patch)
adds a small repaint kick at the end of
`guac_rdp_gdi_desktop_resize`:

```c
guac_rect_init(&current_context->dirty, 0, 0, gdi->width, gdi->height);

if (context->update != NULL && context->update->RefreshRect != NULL
        && gdi->width > 0 && gdi->height > 0
        && gdi->width <= UINT16_MAX && gdi->height <= UINT16_MAX) {
    RECTANGLE_16 area = { 0, 0, (UINT16) gdi->width, (UINT16) gdi->height };
    BOOL ok = context->update->RefreshRect(context, 1, &area);
    /* logged at GUAC_LOG_DEBUG */
}
```

Bounds-checked against `UINT16_MAX` so a pathological resize
cannot produce a malformed PDU. Two new structured debug logs
(`[strata] guac_rdp_gdi_desktop_resize: resizing %dx%d` and
`[strata] post-resize RefreshRect %ux%u -> %s`) make the path
observable at `GUAC_LOG_DEBUG` for future regressions.

---

## ⏱️ Lost-tab tunnels close themselves now (auth watchdog)

If the operator's browser tab was killed without a graceful close
— OS task-killer, kernel OOM, network cable yanked, hostile
client, alt-tab into a focus-stealing app that never gave focus
back — the WebSocket tunnel kept proxying frames into a recording
for as long as the OS held the underlying TCP socket open.
Effects:

- The recording grew indefinitely (sometimes for **hours**) and
  consumed disk on the recordings volume.
- The `session_registry` row stayed live, so the live-sessions
  admin page lied about who was actually connected.
- Per-user concurrent-session limits (where configured) wedged
  the user out of opening a fresh tunnel until the half-dead
  one timed out.

[`backend/src/routes/tunnel.rs`](backend/src/routes/tunnel.rs)
`ws_tunnel` now:

1. Captures the access token used to authenticate the upgrade
   from the same priority list as `require_auth` (Bearer
   header, then `access_token` cookie, then query string),
   storing a copy as `watchdog_token`.
2. Decodes the token's `exp` claim **once** at upgrade time
   into a `u64`, with a fully-validated
   `Validation::new(Algorithm::HS256)` — issuer
   (`strata-local`) and required `exp` claim. Non-local OIDC
   tokens cleanly fall through to `None` and the watchdog
   gracefully degrades to revocation-only checks for them.
3. Spawns a 30-second `tokio::time::interval` tick loop
   alongside `tunnel::proxy(...)`. On every tick:
   - asks `services::token_revocation::is_revoked(token)`;
   - compares `chrono::Utc::now().timestamp() as u64` to the
     cached `exp`.
   Either condition logs at `INFO` and aborts the proxy loop,
   so the recording flushes and `session_registry`
   decrements within at most one tick.

> **Cadence rationale.** 30 s detects revocation in ≤ 30 s
> even on aggressive 1-minute access-token TTLs, while a
> normal 20-minute TTL costs at most 40 ticks per session —
> negligible next to the WebSocket I/O itself. Polling is a
> deliberate choice over a notification channel because the
> revocation list is already a per-process `RwLock<HashSet>`
> with O(1) lookups, and `exp` comparison is a single
> integer compare; both are far cheaper than waking up a
> dedicated subscriber per tunnel.

The `ws_tunnel` extractor list grew to eight arguments after
the `OriginalUri` and watchdog work, which trips
`clippy::too_many_arguments`. A targeted
`#[allow(clippy::too_many_arguments)]` keeps the handler
signature readable; splitting the extractor chain into a
wrapper struct that would only be used in this one place felt
worse than the lint.

---

## 🚪 Clicking Log out closes your tunnels immediately

`App.tsx`'s `handleLogout` previously flipped React auth state
(`setAuthenticated(false)`, `setUser(null)`) and navigated to
`/login` *without* closing any open Guacamole tunnels first. The
`SessionManagerProvider` stayed mounted across the logout
because it lives above the route tree, so its in-memory
sessions kept streaming until the browser eventually closed the
tab. The backend then saw the tunnels close minutes later (or
not at all, until the new auth watchdog kicked in).

[`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx)
now exposes a **module-level handler**:

```ts
let _closeAllSessionsHandler: (() => void) | null = null;

function setCloseAllSessionsHandler(h: (() => void) | null): void {
  _closeAllSessionsHandler = h;
}

export function closeAllSessionsExternal(): void {
  _closeAllSessionsHandler?.();
}
```

The provider registers its own `closeAllSessions` callback via
`setCloseAllSessionsHandler` on mount and unregisters on
unmount. `closeAllSessions` iterates `sessionsRef.current` and
runs the *same* cleanup path used by the per-session disconnect
button:

- `cleanupPopout(session)`,
- `cleanupMultiMonitor(session)`,
- `session._cleanupPaste?.()`,
- clears `keyboard.onkeydown` / `keyboard.onkeyup`, calls
  `keyboard.reset()`,
- calls `session.client.disconnect()`.

Each step is wrapped in a best-effort `try / catch` so a single
failure (already-closed client, race against React unmount)
cannot block the rest of the logout. Finally `setSessions([])`
empties the live-sessions list in one render.

`App.tsx`'s `handleLogout` now calls `closeAllSessionsExternal()`
**before** flipping auth state, then issues a fire-and-forget
`apiLogout()` to invalidate the refresh token and clear the
auth cookies. Idle-timeout logout takes the same path.

> **Defence in depth.** This change pairs with the auth watchdog
> above — the watchdog catches the case where the frontend
> never gets a chance to call `closeAllSessionsExternal` (tab
> killed, OS OOM, network drop), while the explicit logout
> path catches the common case where the user clicks **Log
> out** and we want the live-sessions list to update
> immediately rather than after the next 30 s tick.

---

## 🆙 Drop-in upgrade — rebuild required

All four fixes live in either the Rust backend binary, the
React bundle, or the custom `guacd` image. Run:

```bash
docker compose up -d --build
```

(or pull a freshly published CI tag) — a `docker compose pull`
of an old tag will leave you on the broken `guacd` image.

- **No database migrations.** Schema is unchanged from v1.3.1.
- **No `/api/*` contract changes.** No new routes, no new
  query parameters, no new response fields. The auth watchdog
  is entirely server-side.
- **No `config.toml` schema changes.**
- **Existing in-flight tunnels** that were already connected
  before the upgrade get the watchdog the next time the user
  reconnects (the watchdog is wired in `ws_tunnel`, which only
  runs at upgrade time).

---

# What's New in v1.3.1

> **Same-day patch release on top of v1.3.0.** Five small,
> orthogonal fixes that all surfaced while validating the v1.3.0
> production rollout: SSH terminal defaults so `nano`, `less`,
> `vim`, and `ls --color` actually look right; a mouse-leave /
> window-blur button-release that kills the long-standing
> *"phantom text selection extends across the SSH terminal as I
> move my cursor to the browser tab strip"* bug; a recording
> playback URL fix so seek and speed buttons no longer surface
> *"Tunnel error"*; a fuzz-tolerant guacd patch step so image
> builds survive harmless upstream context drift; and the
> deletion of a stray diagnostic patch that was superseded by the
> SSH defaults work. **Drop-in upgrade from v1.3.0** — no
> database migrations, no `/api/*` contract changes, no
> `config.toml` schema changes; rebuild the backend, frontend,
> and guacd images so the new bits actually run.

---

## 🖥️ SSH terminals that look right out of the box

The connect-instruction parameter map in
[`backend/src/tunnel.rs`](backend/src/tunnel.rs) `full_param_map()`
now seeds the same SSH terminal defaults that upstream
[sol1/rustguac](https://github.com/sol1/rustguac) sends — for
every `protocol == "ssh"` connection where the admin has not
explicitly overridden them:

| Parameter               | Default                | Why it matters                                                                                       |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `terminal-type`         | `xterm-256color`       | Exported as `TERM` on the remote PTY. Without it, OpenSSH sees the empty string and most distros fall back to `TERM=linux` — a 16-colour profile that does *not* advertise `smcup`/`rmcup`, so `nano` and `less` cannot save and restore the alternate screen. **This is what made closing `nano` leave the file stuck on your viewport.** |
| `color-scheme`          | `gray-black`           | Rustguac-default colour palette. Without it, guacd renders SGR escape sequences in the `black-white` palette, inverting most users' expectations and visually obliterating dark prompts. |
| `scrollback`            | `1000`                 | Lifts guacd's in-buffer line count from its built-in default (~256) to 1000, matching `xterm`'s historical default. Below ~500 lines, a single `journalctl -xe` doesn't fit. |
| `font-name`             | `monospace`            | The browser-side default already happened to be monospace; we now make the wire value explicit. |
| `font-size`             | `12`                   | Rustguac parity.                                                                                     |
| `backspace`             | `127`                  | DEL — what every Linux distro ships as the SSH default. Stops `^?` characters appearing in the terminal when you press Backspace on certain remote shells. |
| `locale`                | `en_US.UTF-8`          | Exported as `LC_*`. Required for UTF-8 box-drawing characters in `htop`, `mc`, `tmux` status bars, etc. |
| `server-alive-interval` | `0`                    | Disables guacd-side keepalives — the WebSocket tunnel already provides liveness via Guacamole's own keep-alive instructions. |

Three of these (`color-scheme`, `locale`, `server-alive-interval`)
have also been added to the `is_allowed_guacd_param` allowlist so
admin overrides via the per-connection `extras` map can set them
explicitly. The `tunnel_param_allowlist_pins_legal_keys` test
pins those new keys against accidental removal in future
refactors. The SFTP block has been folded into the same
`if self.protocol == "ssh"` branch so the SSH parameter wiring
now lives in one place rather than two.

**No operator action.** Existing SSH connections start using the
new defaults on the first reconnect after the upgrade. Anything
the admin has explicitly set in the per-connection `extras` map
keeps winning — the defaults only fill in keys you haven't set.

---

## 🖱️ No more phantom text selection across the SSH terminal

Long-running annoyance: click inside the SSH terminal, then move
the cursor up to the browser tab strip — or anywhere else outside
the canvas, including a popped-out devtools window — without
physically releasing the mouse button, and guacd's terminal would
keep extending a text selection across whatever the cursor passed
over. The selection would then survive coming back into the
terminal, leaving the operator with a giant highlight they
hadn't asked for and couldn't easily clear short of clicking
fresh inside the terminal.

**Root cause:** when the user clicks inside the Guacamole canvas
and the matching `mouseup` event lands outside the page's
document (on browser chrome, on a popped-out devtools window, on
another tab during a drag, on the OS desktop after an
alt-tab-out), the page never receives the `mouseup` and
`mouse.currentState.left` stays `true`. The next `mousemove`
guacd receives is then interpreted as a drag-extend-selection,
because as far as guacd's terminal is concerned the user is
still holding the button.

**Fix:** [`frontend/src/components/SessionManager.tsx`](frontend/src/components/SessionManager.tsx)
now wires a `releaseMouseButtons()` helper to two events:

- `mouseleave` on the Guacamole display element — catches every
  in-tab leave (cursor moves to the tab strip, the address bar,
  any other DOM element outside the canvas).
- `blur` on the `window` — catches every tab-switch / focus-loss
  case where `mouseleave` doesn't fire (e.g. Alt-Tab to another
  application, or the user opens a popped-out devtools window
  that takes focus without the cursor crossing the canvas
  boundary).

When fired, the helper inspects the live `mouse.currentState`;
if any of `left` / `middle` / `right` is still set, it builds a
cleared `Guacamole.Mouse.State` and sends it via
`client.sendMouseState(s, true)`. The release is a **no-op when
no buttons are held**, so it costs zero round-trips during normal
interaction.

> **Why not handle this in `Guacamole.Mouse` itself?** Upstream
> `guacamole-common-js` doesn't wire any leave/blur reset
> either, and rustguac's `static/client.html` likewise has the
> same bare `mouse.onEach(['mousedown','mousemove','mouseup'])`
> pattern with no leave handler. We're choosing to fix this on
> the Strata side rather than try to upstream a vendored-bundle
> patch that would deviate from rustguac for everyone.

---

## ⏯️ Seek and speed buttons on the recording player work again

Symptom: opening a recording playback page (Sessions → LIVE/Rewind
button → Recorded Session) and clicking **any** of the seek
buttons (`30S`, `1M`, `3M`, `5M` in either direction) or speed
buttons (`2x`, `4x`, `8x`) at the bottom of the player would
render a red *"Tunnel error"* badge over the player and stop
playback. Pressing **Retry** would just reproduce the same
error.

**Root cause:** the recording-playback URL builder in
[`frontend/src/components/HistoricalPlayer.tsx`](frontend/src/components/HistoricalPlayer.tsx)
was prepending `&seek=…` and `&speed=…` to a base URL that did
not yet contain a `?`. The base URL is built by
`buildRecordingStreamUrl()` and ends in `…/stream` with no query
string, so the resulting URL became
`wss://strata.example.com/api/admin/recordings/<uuid>/stream&seek=3114&speed=2`
— a malformed path that the WebSocket upgrader on the backend
correctly rejected as an unknown route, surfacing as the
*"Tunnel error"* the user saw.

**Fix:** collect the parameters into a list, then prepend `?`
when the base URL has no existing query string and `&` when it
does, before splitting on `?` for the
`tunnel.connect(tunnelQuery)` call. The split semantics are
preserved, so the `seek` and `speed` values continue to travel
as Guacamole connect-protocol args (which is what the backend
recording-stream route already reads them as) rather than as
URL query string. The
[`GET /api/{user,admin}/recordings/:id/stream`](docs/api-reference.md#get-apiuserrecordingsidstream)
endpoint and its documented `seek` and `speed` query parameters
were always correct — only the frontend was wrong.

---

## 🐳 guacd image build resilient to harmless context drift

`docker compose build guacd` previously failed with
`error: patch does not apply` if any patch hunk's surrounding
context had drifted by even a single whitespace line — the
`git apply` invocation in [`guacd/Dockerfile`](guacd/Dockerfile)
is strict by design. We pin the upstream
`apache/guacamole-server` commit to `2980cf0` for
reproducibility, but a future commit-pin bump (or a local
maintenance branch with whitespace cleanup) could trip this even
when our patches don't actually conflict.

The patch step now installs the GNU `patch` utility via
`apk add --no-cache patch` and falls back to
`patch -p1 -F3 < "$p"` when `git apply` rejects a hunk, allowing
up to three lines of fuzz on each hunk. Hard rejects still fail
the build (we exit on patch failure) — only the contextual
fuzz is relaxed.

A stray diagnostic patch
(`guacd/patches/005-alt-screen-trace.patch`) that was used
during the SSH terminal investigation earlier in the v1.3.x
cycle has been removed; the fix that superseded it (the SSH
defaults above) lives entirely in `backend/src/tunnel.rs`, so
removing the patch causes no behaviour change.

---

## 🚢 Upgrading from v1.3.0

```bash
git pull
docker compose up -d --build
```

- **Mandatory image rebuild.** All fixes live in the backend
  Rust binary, the frontend bundle, and the guacd Dockerfile
  patch step — all three are baked into their respective
  images. A `docker compose pull` of an old tag is *not*
  enough.
- **No database migrations.** v1.3.1 is schema-stable relative
  to v1.3.0 and v1.2.0.
- **No `/api/*` contract changes.** All existing endpoints
  behave identically; the documented query parameters on the
  recording-stream WebSocket endpoint were always correct.
- **No `config.toml` / env-var changes.** Nothing for an
  operator to update.
- **First reconnect picks up the SSH defaults automatically.**
  No need to re-save existing SSH connections; the defaults
  only fill in `extras` keys the admin hasn't explicitly set,
  so any per-connection terminal overrides keep winning.

---

# What's New in v1.0.0

> **General availability.** Strata Client reaches **1.0.0** — a
> straight promotion of the v0.31.0 codebase with **no functional
> changes**. The headline of this release is the **formal SemVer
> commitment** that lands with the tag: from 1.0.0 onward, the
> public REST API surface (`/api/*`), the database schema
> (managed by the numbered migrations under `backend/migrations/`),
> and the on-disk configuration shape (`config.toml` keys +
> environment variable contracts) are stable. Breaking changes to
> any of those surfaces will require a v2.0.0 bump. **Drop-in
> upgrade from v0.31.0** — no new database migrations, no `/api/*`
> contract changes, no UI changes beyond the WhatsNew modal welcoming
> you to 1.0.0.

---

## 🎉 Why 1.0.0 now

The 0.x series has been production-tracked at multiple sites since
v0.27.0 and has accumulated nine consecutive minor releases without
a regression-driven rollback. The feature surface — multi-protocol
sessions (RDP / VNC / SSH / Web / VDI), managed-account checkout
with approval workflows, hash-chained audit logging, recordings,
folders, tags, custom keybindings, and the v0.31.0 scriptable
Command Palette — has reached the maturity bar we set for a 1.0
tag. Tagging now formalises the upgrade-safety contract operators
have been relying on informally.

## 📜 What the SemVer commitment covers

- **Stable:** every documented `/api/*` endpoint (request shape,
  response shape, status-code semantics); every column in every
  table created by migrations `001`–`055`; every key in
  `config.toml` and every `STRATA_*` environment variable read by
  `backend/src/config.rs`.
- **Free to evolve in minor / patch releases:** internal Rust
  modules under `backend/src/services/` and `backend/src/routes/`
  (function signatures, struct shapes, helper utilities), the
  React component tree under `frontend/src/components/`, the
  Vitest / Playwright test suites, the CHANGELOG / WHATSNEW /
  documentation prose, the contents of the WhatsNew modal, and
  any unreleased migration whose number exceeds `055` at tag time.
- **Reserved for v2.0.0:** removing or breaking-shape-changing any
  `/api/*` endpoint, dropping or renaming any column referenced by
  a `/api/*` response, removing or renaming any `config.toml` key
  or `STRATA_*` env var read by the running binary.

## 🚢 What's actually in the release

Everything that shipped under v0.31.0 — verbatim. The version
strings in `VERSION`, `backend/Cargo.toml`, `backend/Cargo.lock`,
`frontend/package.json`, `frontend/package-lock.json`, and the
README badge are the only files that changed for the 1.0.0 tag.
The release pipeline publishes `ghcr.io/<org>/strata-backend:1.0.0`
and `ghcr.io/<org>/strata-frontend:1.0.0` alongside the rolling
`:latest` tag; the previous `:0.31.0` images remain available and
are byte-identical.

For a refresher on the v0.31.0 feature set (built-in `:command`
palette, personal `:command` mappings, ghost-text autocomplete, and
the `command.executed` audit stream) see the v0.31.0 entry in
[CHANGELOG.md](CHANGELOG.md).

---

# What's New in v0.31.0

> **The Command Palette grows up.** v0.31.0 adds **built-in commands**, **personal `:command` mappings** (including `open-path` for opening UNC shares and folders directly in remote Explorer), **ghost-text autocomplete**, and a brand-new **`command.executed` audit stream**, turning the in-session palette from a connection picker into a fully scriptable, user-extensible command surface. Up to 50 mappings per user, six action types, server-validated, hash-chain audited. **Drop-in upgrade from v0.30.2** — no new database migrations.

---

## ⌨️ Type `:` to enter command mode

Pressing `Ctrl+K` (or your customised binding from v0.30.1) and typing
a colon now switches the palette into **command mode**. Six built-ins
ship out of the box:

| Command                | What it does                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `:reload`              | Reconnect the active session (forces an IDR keyframe — clears stale GFX without dropping the tunnel)                              |
| `:disconnect`          | Close the active session and return to the dashboard                                                                              |
| `:close`               | Friendlier alias for `:disconnect` — closes the current server page                                                               |
| `:fullscreen`          | Toggle fullscreen with Keyboard Lock (the same chord the SessionBar uses, so OS shortcuts stay captured)                          |
| `:commands`            | Inline list of every command available to you — built-ins plus your personal mappings, with a colour-coded pill for each kind     |
| `:explorer <arg>`      | Drives the Run dialog on the active session — `:explorer cmd` opens a command prompt, `:explorer powershell` opens a PowerShell prompt, `:explorer \\server\share` opens a share, `:explorer notepad` launches Notepad. Anything `start` accepts works. |

Commands that need an active session (`:reload`, `:disconnect`,
`:close`, `:explorer`) are disabled (greyed) when none is open; the
palette shows a clear reason rather than silently no-op'ing.

`:explorer` is the ad-hoc twin of the `open-path` mapping action: same
Win+R → paste argument → Enter choreography, same ≤ 1024-char cap,
same control-character rejection, and the audit log records only
`{ arg_length: N }` — never the literal argument.

---

## 🎯 Personal `:command` mappings — define your own shortcuts

Visit **Profile → Command Palette Mappings** to define up to **50** of
your own `:command` triggers. Six action types are supported:

| Action            | What it opens                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open-connection` | A specific saved connection by its UUID                                                                                                                              |
| `open-folder`     | The dashboard pre-filtered to a folder                                                                                                                               |
| `open-tag`        | The dashboard pre-filtered to a tag                                                                                                                                  |
| `open-page`       | An in-app route (`/dashboard`, `/profile`, `/credentials`, `/settings`, `/admin`, `/audit`, `/recordings`)                                                          |
| `open-path`       | **Opens a path on the active remote session.** Drives the Windows Run dialog (Win+R → paste path → Enter), so a UNC share like `\\computer456\share`, a local folder like `C:\Users\Public`, or a `shell:` URI like `shell:startup` opens directly in Explorer on the remote box. The example everyone wants: `:comp1` → `\\computer456\share`. |
| `paste-text`      | Sends free-form text into the active session via clipboard + Ctrl+V (no Enter, just a paste). Up to 4096 chars.                                                       |

Triggers are validated against `^[a-z0-9_-]{1,32}$`, must not collide
with built-in command names, and must be unique within your own list.
The Profile UI surfaces every error inline — no toast soup, no silent
trims.

---

## 📂 Open paths on the remote session — `open-path`

The headline mapping action: **type `:comp1` and have
`\\computer456\share` open in Explorer on the remote box.** Under the
hood the palette drives the Windows Run dialog on the active session:

1. Sends **Win+R** (keysyms `0xffeb` Super_L + `0x72` "r") to open the
   Run dialog.
2. Pushes the path onto the remote clipboard via
   `Guacamole.Client.createClipboardStream`.
3. Sends **Ctrl+V** to paste the path into the dialog.
4. Sends **Enter** (`0xff0d`) — the Windows shell hands off to whichever
   handler is registered for that URI scheme (Explorer for UNC shares
   and folders, control-panel applets for `shell:…` URIs, the default
   browser for `http://…`, etc.).

Path-string validation is strict: ≤ 1024 characters, **no control
characters** (newline injection through the Run dialog would let a
stored mapping execute follow-up commands). The audit log captures
only `{ path_length: N }`, never the literal path, so chained-hash
review of the audit stream cannot leak share names or internal hosts.

---

## 👻 Ghost-text autocomplete (Tab to accept)

While typing in command mode, the palette renders a low-opacity
**ghost-text overlay** showing the longest unambiguous extension of your
current input across every command available to you. Press **Tab** or
**Right Arrow** (only when your caret is at the end of the input) to
accept. The longest-common-prefix algorithm runs over the merged
built-in + user-mapping list, so adding a `:reset` mapping correctly
disambiguates against the built-in `:reload` rather than silently
auto-jumping to the wrong command.

---

## 🔴 Friendly invalid-state UI

Type a slug that doesn't resolve (`:nope`) or invoke a built-in that
isn't currently usable (`:reload` with no active session) and the
palette:

- Switches the input border to `var(--color-danger)`
- Renders a `role="alert"` reason line below the input on wide
  viewports (and surfaces it in `title` for pointer hover / screen
  readers)
- Sets `aria-invalid="true"` on the input
- Makes Enter a hard no-op — no audit event, no navigation

Nothing surprises you. Nothing fires until the slug is valid.

---

## 📋 Every executed command writes one audit row

Every successful command execution writes one `command.executed` row to
the existing **append-only, SHA-256 chain-hashed `audit_logs` table**:

```
action_type = "command.executed"
details     = { trigger, action, args, target_id }
```

The endpoint that backs this — **`POST /api/user/command-audit`** — is
fire-and-forget from the frontend (audit failures must never block the
action) and shares the same advisory-locked chain-hash code path used
by every other Strata audit event. Security teams can review what
operators ran, against which target, and when, with the same
tamper-evidence guarantees as `tunnel.connected`, `checkout.activated`,
and the rest of the existing audit taxonomy.

The endpoint hard-codes `action_type` server-side, so a malicious
client cannot poison the audit-event namespace by passing a fake
type through the request body.

---

## 🛡️ Defence-in-depth validation

`commandMappings` is enforced at the backend before the JSONB blob ever
lands in `user_preferences`. The new `validate_command_mappings()` in
[`backend/src/services/user_preferences.rs`](backend/src/services/user_preferences.rs)
rejects:

- Non-array values
- Arrays with more than 50 entries
- Triggers that don't match `^[a-z0-9_-]{1,32}$`
- Triggers that collide with the built-in command names
- Duplicate triggers within a single user's list
- Actions outside the six-value allow-list
- `open-page` paths outside the seven-value page allow-list
- `args.connection_id` / `args.folder_id` / `args.tag_id` values that
  don't parse as UUIDs

12 unit tests in the same file cover every rejection branch plus the
happy paths for all six action types. A modified frontend that
bypasses client-side validation still cannot poison the database.

---

## 🚀 Upgrade notes

- **No database migrations.** Mappings live in the existing
  `user_preferences.preferences` JSONB column from v0.30.1.
- **Operators on v0.30.2 can `docker compose pull && up`** without
  further action.
- **Existing users see exactly the same palette experience as v0.30.2**
  until they explicitly add a mapping. Built-in commands become
  available to everyone immediately — no per-user opt-in.
- **External automation that PUTs `/api/user/preferences`** must now
  submit a valid `commandMappings` array (or omit the key entirely).
  Previously the JSONB blob was schema-less; v0.31.0 enforces the
  shape at the backend.

---

# What's New in v0.30.2

> **Maintenance & supply-chain hygiene release.** v0.30.2 lands the open Dependabot queue locally so dependency bumps don't accumulate against future feature work, clears a **CodeQL `rust/hardcoded-credentials` Critical finding** in a backend unit test, refreshes pinned-by-SHA GitHub Actions, and stabilises three CI-only test issues. **Drop-in upgrade from v0.30.1.** No database migrations, no API contract changes, no UI changes — operators on v0.30.1 can `docker compose pull && up` without further action.

---

## 🛡️ CodeQL #83 — `rust/hardcoded-credentials` (Critical) cleared

A CodeQL Critical alert flagged the `vdi_env_vars_overrides_reserved_keys_with_runtime_values` test in `backend/src/services/vdi.rs` because it passed string literals (`"alice"`, `"s3cret"`, `"attacker"`, `"leaked"`) into a function whose parameter name is `password`. The literal values were never reachable outside the `#[cfg(test)]` module — there is no production code path that consumes them — but the static-analysis signal is real noise on the security dashboard.

The test now constructs all four values at runtime via `format!("user-{}", Uuid::new_v4())` / `format!("pw-{}", …)` so no literal flows into a credential parameter. The override semantic that the test exercises (a connection's `extra` env-var blob smuggling `VDI_USERNAME` or `VDI_PASSWORD` keys must not leak past the runtime, which always wins) is unchanged.

---

## 📦 Dependency bumps

### Backend

- **`rustls` 0.23.38 → 0.23.39** (patch). Cargo.lock-only — the declared `"0.23"` requirement in `backend/Cargo.toml` already subsumes the patch.
- **`axum-prometheus` 0.7 → 0.10** (major). Strata's only call site is `PrometheusMetricLayer::pair()` in `backend/src/routes/mod.rs`. None of the breaking-surface APIs (`MakeDefaultHandle::make_default_handle(self)` in 0.7, `with_group_patterns_as` matchit-pattern syntax in 0.8, or the `metrics-exporter-prometheus` 0.18 upgrade in 0.10) are reached. Pulls in transitive bumps to `metrics` 0.23 → 0.24, `metrics-exporter-prometheus` 0.15 → 0.18, `metrics-util` 0.17 → 0.20.
- **`mrml` 5 → 6** (major). Strata's only call sites are `mrml::parse(&str)` and `mrml::prelude::render::RenderOptions::default()` in `backend/src/services/email/templates.rs`. Both are stable across the 5→6 boundary, which contains bug-fixes-and-deps-bump only (font-family quoted-name parse, `mj-include` inside `mjml`, container-width propagation, VML namespace preservation).

### Frontend

- **`jsdom` 29.0.2 → 29.1.0** (minor) and **`vite` 8.0.9 → 8.0.10** (patch). Both `devDependencies` (test runner / build tool) — no runtime bundle change.
- **`npm audit` → 0 vulnerabilities.**

---

## 🔐 GitHub Actions SHA pinning refreshed

Pinned-by-SHA-with-tag-comment workflow actions are bumped to their newest tagged commits to pick up upstream security fixes. The existing `# vN.N.N` trailing-comment convention is preserved so Dependabot keeps tracking them.

**`.github/workflows/ci.yml`:**

| Action                         | From | To     | Commit                                     |
| ------------------------------ | ---- | ------ | ------------------------------------------ |
| `actions/setup-node` (×3)      | v4   | v6.4.0 | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` |
| `actions/upload-artifact` (×3) | v4   | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |

**`.github/workflows/release.yml`:**

| Action                        | From | To     | Commit                                     |
| ----------------------------- | ---- | ------ | ------------------------------------------ |
| `docker/metadata-action`      | v5   | v6.0.0 | `030e881283bb7a6894de51c315a6bfe6a94e05cf` |
| `actions/upload-artifact`     | v4   | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `sigstore/cosign-installer`   | v3   | v4.1.1 | `cad07c2e89fa2edd6e2d7bab4c1aa38e53f76003` |
| `softprops/action-gh-release` | v2   | v3.0.0 | `b4309332981a82ec1c5618f44dd2e27cc8bfbfda` |

---

## 🧪 CI stability fixes

### `web_login_script` Linux ETXTBSY

Three tests in `backend/src/services/web_login_script.rs` (`spawn_succeeds_with_zero_exit`, `spawn_surfaces_non_zero_exit`, `spawn_kills_on_timeout`) intermittently failed on Linux CI runners with _"Text file busy"_ because the temp script file was still being held by an `fs::File` write handle when the test attempted `set_permissions()` followed immediately by `spawn()`. Linux refuses to `execve(2)` a file that has an open writer.

**Fix:** explicit `f.sync_all().unwrap(); drop(f);` _before_ `set_permissions()`, so the kernel flushes the inode and releases the write lock prior to exec. No production change — the production caller already drops its handle before chmod.

### Flaky `SessionWatermark` paint assertion

The `uses N/A for missing client_ip` case in `frontend/src/__tests__/SessionWatermark.test.tsx` asserted `fillTextSpy.mock.calls.some(args => args[0].includes("N/A"))` synchronously after `render()` resolved the canvas mount. The watermark paint actually runs in a `useEffect` triggered by the user-state commit, **one tick after** the canvas appears.

**Fix:** wrap the assertion in `await waitFor(...)` so the matcher polls until the paint completes. This matches the same fix already applied to the sibling case earlier in the v0.30.1 cycle.

### Trivy SARIF upload no-op when scanner failed

In `.github/workflows/trivy.yml` the `github/codeql-action/upload-sarif` step previously failed with _"Path does not exist: trivy-frontend.sarif"_ whenever the prior Trivy scan step itself errored out (because the matrix step uses `continue-on-error: true`).

**Fix:** added `if: always() && hashFiles(format('trivy-{0}.sarif', matrix.service)) != ''` so the upload skips cleanly when no SARIF file was produced, rather than masking the real Trivy failure with a misleading upload-not-found error.

---

## ✅ Validation

- **Frontend:** `npx vitest run` → 47 files / **1232 tests, all green.**
- **Frontend:** `npm audit` → **0 vulnerabilities.**
- **Backend:** `cargo update -p axum-prometheus -p mrml` resolved cleanly to `axum-prometheus 0.10.0` + `mrml 6.0.1`. The downstream `cargo check` is authoritative on CI (the local Windows workstation hits an unrelated Defender block on build-script execution under the cargo target dir, which does not affect Linux CI).

---

## 🚀 Upgrade notes

- **No database migrations.** The migration runner has no work to do for this release.
- **No API contract changes.** All `/api/*` routes, request/response shapes, and audit-event names are byte-identical to v0.30.1.
- **No UI changes.** Operators won't see anything different in the running app.
- **Operators on custom forks of `axum-prometheus` or `mrml`** should re-run their own integration suite — the major-version bumps exercise a large transitive-dependency delta even though Strata's call sites are unchanged.

---

# What's New in v0.30.1

> **Per-user preferences release.** v0.30.1 introduces a per-user preferences subsystem stored server-side, and the first preference it powers: a fully customisable keybinding for the in-session **Command Palette** (default `Ctrl+K`). Operators whose host applications collide with `Ctrl+K` — Visual Studio, JetBrains IDEs, Slack, Obsidian — can now rebind the palette to any combination they prefer, or disable it entirely. The setting follows the operator across browsers and devices because it lives in PostgreSQL, not localStorage. **Drop-in upgrade from v0.30.0.** A single additive migration (`058_user_preferences.sql`) creates the new table — no existing rows are mutated, and users who never open the Profile page get exactly the same `Ctrl+K` behaviour as before.

---

## ⌨️ Customisable Command Palette shortcut

Strata's in-session **Command Palette** is the operator's escape hatch from a captured Guacamole session — it pops over the remote-display canvas, intercepts keystrokes before the remote OS sees them, and lets the user disconnect, switch sessions, copy/paste, share, etc. It is bound to `Ctrl+K` by default. That keystroke unfortunately collides with several common host-side shortcuts:

- **Visual Studio** — `Ctrl+K, …` is the chord prefix for Peek, Comment selection, and the entire **Edit ▸ Advanced** menu.
- **JetBrains IDEs (IntelliJ, Rider, PyCharm, …)** — `Ctrl+K` is **Commit changes**.
- **Slack / Microsoft Teams** — `Ctrl+K` is the conversation quick-switcher.
- **Obsidian / Notion** — `Ctrl+K` is the link-insert / quick-find prompt.

When a Strata tab has focus the in-page handler swallows `Ctrl+K` so it can pop the palette — which means the operator's host app never sees the chord. v0.30.1 lets each user customise the binding away from the default.

### How it works

1. Click the **user avatar** at the bottom of the sidebar — that block is now a link to a new `/profile` page (was a static label).
2. Under **Keyboard Shortcuts**, click the **Command Palette** button. It enters recording mode (the button highlights and the helper text reads _"Press a shortcut… (Esc to cancel)"_).
3. Press the new combination. Modifier-only presses (just `Shift`, just `Ctrl`, etc.) are ignored — the recorder waits for an actual key. Press `Esc` to cancel without committing.
4. The button reverts to the recorded value (e.g. `Ctrl+Shift+P`, `Alt+Space`, `Ctrl+Backquote`). Click **Save** to persist.
5. **Reset to Ctrl+K** restores the default. **Disable** stores the empty string, turning the palette off entirely (the operator can still close it via the in-palette UI when something else opens it, e.g. a session reconnect modal that programmatically opens it).

### Cross-platform binding semantics

The matcher deliberately treats `Ctrl` in a stored binding as "**Ctrl OR ⌘**" so the same preference works on every operator's OS without per-device tweaking. A binding of `Ctrl+K` matches:

- `Ctrl+K` on Windows / Linux
- `⌘+K` on macOS

(If a future preference needs to distinguish Ctrl from ⌘, that's a separate knob — out of scope for v0.30.1.)

The matcher is also **case-insensitive** on the event side (so `K` and `k` both match a stored `Ctrl+K`), and **modifier-order insensitive** in the stored string (`Shift+Ctrl+P` and `Ctrl+Shift+P` parse identically). `Cmd`, `Meta`, `Win`, and `Super` are aliases for the same modifier.

### Where the binding takes effect

Two production keystroke traps respect the new preference, both via a `useRef` so the keydown listener doesn't have to be rebound when the user changes the value mid-session:

- The **main session window** trap in `frontend/src/pages/SessionClient.tsx` (capture-phase, runs **before** Guacamole's keyboard handler so the chord can't leak through to the remote OS).
- The **popout / multi-monitor child window** trap in `frontend/src/components/usePopOut.ts`. The popout doesn't open the palette directly — it relays a `strata:open-command-palette` postMessage back to the main window, which then opens it. Both windows now use the same matcher.

The postMessage listener itself in `SessionClient.tsx` was untouched — it dispatches on message type, not on key.

---

## 🗄️ Per-user preferences subsystem

The Command Palette binding is stored in a brand-new `user_preferences` table, designed up-front to be the foundation for additional preferences without further migrations. Schema:

```sql
CREATE TABLE user_preferences (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The blob is intentionally schema-less at the database layer — the **frontend owns the shape**. The backend enforces exactly one invariant: the top-level value MUST be a JSON object. Anything else (array, string, number, null) returns `400 Bad Request`. Future preferences (e.g. RDP keyboard-layout overrides, dashboard tile order, default-recording behaviour) just add new keys to the same blob.

### Backend surface

- New service module `backend/src/services/user_preferences.rs` with `get(pool, user_id) -> Value` and `set(pool, user_id, prefs)`. The setter is an idempotent UPSERT (`ON CONFLICT (user_id) DO UPDATE`).
- Two new endpoints, both on the standard `Extension<AuthUser>` middleware path:
  - `GET /api/user/preferences` → `200 { ... }` (or `200 {}` if no row exists yet).
  - `PUT /api/user/preferences` → accepts and returns the same JSON object; `400` for non-object bodies.

### Frontend surface

- React context provider `frontend/src/components/UserPreferencesProvider.tsx`, mounted in `App.tsx` between `SettingsProvider` and `SessionManagerProvider`. Exposes `useUserPreferences()` with `{ preferences, loading, error, update, reload }`. Performs optimistic updates with rollback on failure. Falls back to safe defaults when used outside the provider, so the login screen and unit-test harnesses keep working.
- Profile page `frontend/src/pages/Profile.tsx` at `/profile`. Two sections today: **Account** (read-only summary from `/api/user/me`) and **Keyboard Shortcuts** (the recorder UI described above). Designed so additional preference sections drop in as new `<section>` blocks.
- Keybinding utility `frontend/src/utils/keybindings.ts` — `parseBinding`, `matchesBinding`, `bindingFromEvent`, `DEFAULT_COMMAND_PALETTE_BINDING`. Covered by 16 vitest cases.
- API client additions in `frontend/src/api.ts`: `getUserPreferences()`, `updateUserPreferences(prefs)`, `UserPreferences` interface.

---

## ✅ Migration / upgrade notes

- **Drop-in upgrade from v0.30.0.** The migration runner picks up `058_user_preferences.sql` automatically on backend start. The table is `IF NOT EXISTS` and has no constraints that touch existing data, so the migration is reversible by hand if needed.
- **Defaults preserved.** Until a user explicitly visits `/profile` and saves something, the preferences row does not exist. The frontend transparently substitutes `commandPaletteBinding = "Ctrl+K"` so the experience is byte-identical to v0.30.0.
- **No backend dependency changes.** No new crates; the existing `serde_json` / `sqlx` stack is enough.

---

# What's New in v0.30.0

> **Runtime delivery release.** v0.30.0 ships the live runtime spawn for the two new connection protocols whose pure-logic foundation landed in v0.29.0. Connecting to a `web` connection now actually launches Xvnc + Chromium and tunnels them through guacd; connecting to a `vdi` connection now actually launches the Strata-managed Docker desktop container, attaches it to the Compose-prefixed `guac-internal` network, and tunnels its xrdp through guacd. The roadmap items `protocols-web-sessions` and `protocols-vdi` move from **In Progress** to **Shipped**. **No new database migrations** — the v0.29.0 migration `057_session_types_web_vdi.sql` already created the runtime tables. **Drop-in upgrade from v0.29.0.**

---

## 🌐 Web Browser Sessions — runtime delivery

The `web` protocol is now end-to-end functional in the default compose graph. New `backend/src/services/web_runtime.rs` ties the v0.29.0 foundation modules together into a single `WebRuntimeRegistry::ensure(connection_id, user_id, session_id, spec)` call invoked from the tunnel handler:

1. Allocate an X-display (`:100`–`:199`) via `WebDisplayAllocator`.
2. Allocate a CDP debug port (`9222`–`9421`) via `CdpPortAllocator`.
3. Create a per-session ephemeral profile dir (`/tmp/strata-chromium-{uuid}`).
4. Write the operator-supplied `Login Data` autofill row when the connection is configured with credentials, encrypted with Chromium's per-profile AES-128-CBC key (PBKDF2-SHA1, `v10` prefix).
5. Spawn `Xvnc :{display} -SecurityTypes None -localhost yes -geometry {width}x{height}` and wait for it to bind on the allocated VNC port.
6. Spawn `chromium --kiosk --user-data-dir={profile} --remote-debugging-address=127.0.0.1 --remote-debugging-port={cdp} --host-rules="MAP * ~NOTFOUND, MAP {allowed} {allowed}" --start-maximized {url}` under `DISPLAY=:{display}`.
7. Detect immediate-exit crashes (Chromium dies within 500 ms of spawn) and surface them as `WebRuntimeError::ChromiumImmediateExit`.
8. Run the configured login script via the localhost-only CDP transport (`backend/src/services/web_cdp.rs`, `backend/src/services/web_login_script.rs`) to handle the SSO redirect chain before guacd attaches.
9. Register the handle so subsequent reconnects against the same `(connection_id, user_id)` reuse the live process pair without re-spawning.

The kiosk's framebuffer geometry now matches the operator's actual browser window dimensions (new `window_width` / `window_height` fields on `ChromiumLaunchSpec` and `WebSpawnSpec`) so the Chromium tab fills the operator's viewport edge-to-edge with no letterboxing — the v0.29.0 RDP behaviour for `width`/`height`/`dpi` now applies to web kiosks too.

The route in `backend/src/routes/tunnel.rs` rewrites `wire_protocol = "vnc"` and substitutes the operator-typed hostname/port with `127.0.0.1:{5900+display}` returned by the runtime. The original `web` label is preserved on `nvr_protocol` so recordings keep the operator-facing name.

---

## 🖥️ VDI Desktop Containers — runtime delivery

The `vdi` protocol is now end-to-end functional via the `docker-compose.vdi.yml` overlay. New `backend/src/services/vdi_docker.rs` implements the `VdiDriver` trait against `bollard` 0.18 with default features so the unix-socket transport is available on Linux backends. `ensure_container` is idempotent: the deterministic name `strata-vdi-{conn[..12]}-{user[..12]}` lets a re-open of the same `(connection, user)` pair land on the same running container, preserving the persistent home and ephemeral-but-sticky session state.

### Auto-provisioned ephemeral RDP credentials

Operators no longer have to populate `username`/`password` on a VDI connection row — the tunnel route now calls `vdi::ephemeral_credentials(strata_username)` when the credential cascade resolves to no password. The function returns:

- A **deterministic** sanitised POSIX username — same Strata user always maps to the same POSIX user, so the bind-mounted `$HOME` is consistent across reconnects.
- A **fresh** 24-character alphanumeric password generated from `rand::distr::Alphanumeric` per call.

Both are injected into the spawned container as `VDI_USERNAME` / `VDI_PASSWORD`. Because xrdp inside the container authenticates against the same env-var pair, every VDI session gets a fresh password without operator interaction. The frontend `SessionClient.tsx` RDP prompt branch is updated to skip the credential dialog for `vdi`, so users never see "enter your credentials" for an internally managed account.

### VDI admin tab

New `frontend/src/pages/admin/VdiTab.tsx` exposes the `vdi_image_whitelist` (newline- or comma-separated, `#` comments) and `max_vdi_containers` (per-replica concurrency cap) settings via the generic `PUT /api/admin/settings` endpoint, registered alongside the other admin tabs in `AdminSettings.tsx` with a threat-model reminder linking to `docs/vdi.md`.

### Sticky `COMPOSE_FILE` overlay

The `.env` and `.env.example` files now ship and document a `COMPOSE_FILE` shortcut so plain `docker compose ...` commands automatically apply `docker-compose.vdi.yml` — without it, every operator command had to spell out both `-f` flags or risk silently dropping the docker.sock mount and the `STRATA_VDI_ENABLED` flag.

---

## 🛠️ Three runtime hot-fixes shipped in this release

Three issues surfaced during the live integration; all are fixed in v0.30.0 and documented in [`docs/vdi.md`](docs/vdi.md) for operators upgrading from the v0.29.0 foundation.

### 1. `docker.sock` permission

The backend runs as the unprivileged `strata` user via `gosu strata strata-backend`, but Docker Desktop on Windows mounts `/var/run/docker.sock` inside containers as `srw-rw---- root:root`. `bollard::Docker::connect_with_defaults()` is **lazy**: the connection check at startup succeeds even when the socket is unreadable, only the first real HTTP request fails with `Error in the hyper legacy client: client error (Connect)`.

`backend/entrypoint.sh` now stats the socket at runtime: when the GID is non-zero (typical Linux: 998 / 999) it creates a `docker-host` group with that GID and adds the `strata` user; when the GID is zero (Docker Desktop) it `chgrp strata` + `chmod g+rw` the bind-mount. Both paths emit a `[entrypoint] …` log line so operators can see which branch executed.

### 2. Compose-prefixed network resolution

Docker Compose prefixes network names with the project name, so the network the rest of the stack joins is actually `strata-client_guac-internal`, not `guac-internal`. The driver previously hard-coded the unprefixed name and every `ensure_container` failed with `404 network guac-internal not found`.

New `STRATA_VDI_NETWORK` env var on the backend, defaulted in `docker-compose.vdi.yml` to `${COMPOSE_PROJECT_NAME:-strata-client}_guac-internal`, threaded through to `DockerVdiDriver::connect(&network)` in `backend/src/main.rs`.

### 3. xrdp TLS / dynamic-resize quirks

The sample VDI image's xrdp uses a per-container self-signed certificate that Strata never trusts, and its display-update virtual channel drops the RDP session on resize storms (sidebar toggle, browser window resize). The tunnel handler now forces three overrides for `vdi` connections only:

- `ignore-cert=true` (both ends are Strata-controlled and traffic stays on the internal `guac-internal` bridge).
- `security=any` (xrdp negotiates whatever it can, since the cert is not trustworthy regardless).
- `resize-method=""` (no display-update messages — the frontend's guacamole-common-js display layer continues to scale the fixed framebuffer to fit the viewport client-side, so the user sees a letterbox / scale rather than a disconnect).

---

## 📝 Audit and recording

The action-type strings declared as fixed contracts in v0.29.0 are now actually emitted by the runtime: `web.session.start`, `web.session.end`, `web.autofill.write`, `vdi.container.ensure`, `vdi.container.destroy`, `vdi.image.rejected`. See [`docs/api-reference.md`](docs/api-reference.md) § _Audit Event Types_ for the per-event `details` schema.

`nvr_protocol` preserves the operator-facing `web` / `vdi` label even though the wire protocol is `vnc` / `rdp`, so recording playback shows the correct icon in the session list.

---

## 📚 Documentation

- **Web Sessions and VDI added to in-app docs.** The `/docs` page in the admin UI now ships two dedicated left-rail entries — _Web Sessions_ and _VDI Desktop_ — wired to `docs/web-sessions.md` and `docs/vdi.md`.
- **`docs/vdi.md`** rewritten for the shipping runtime: when-to-use, architecture diagrams, the full `connections.extra` schema, ephemeral-credentials flow, image whitelist semantics, network resolution (`STRATA_VDI_NETWORK`), the `entrypoint.sh` socket-permission handling, the security overrides for VDI, audit-event contract, reaper disconnect classification, custom-image build requirements, and a troubleshooting matrix.
- **`docs/web-sessions.md`** updated with viewport-matched framebuffer details, the runtime registry reuse semantics, the login-script runner section, and a troubleshooting matrix mapping each `WebRuntimeError` variant to its operator-facing remediation.
- **`docs/architecture.md`** gains an _Extended protocols_ deep-dive with ASCII diagrams of both spawn pipelines, the display / port allocator state machines, the deterministic container-naming scheme, and the wire-protocol translation (`web→vnc`, `vdi→rdp`).
- **`docs/security.md`** _Web Sessions and VDI extended threat model_ augmented with the v0.30.0 ephemeral-credentials flow, the scope of TLS overrides for VDI (vdi-only, RDP unaffected), the `STRATA_VDI_NETWORK` selection rule, and the entrypoint socket-permission handling.
- **`docs/api-reference.md`** documents the live audit events with their `details` schemas.
- **`docs/deployment.md`** documents the Windows-vs-Linux `COMPOSE_FILE` separator, the runtime requirements section, and the host resource budgeting guidance for VDI.
- **`README.md`** feature list updated with web and VDI as shipping protocols.

---

## 📦 Meta

- **Version bump (minor).** `VERSION`, `backend/Cargo.toml`, `backend/Cargo.lock`, `frontend/package.json`, `frontend/package-lock.json`, and the README badge are all bumped to `0.30.0`.
- **No new database migrations.** The v0.29.0 migration `057_session_types_web_vdi.sql` already created `vdi_containers` and the per-protocol settings rows; v0.30.0 only writes to those tables.
- **No API-contract changes for existing protocols.** RDP, VNC, SSH, Kubernetes, and Telnet behave identically. The new VDI-specific forced parameters (`ignore-cert`, `security`, `resize-method`) apply only when `protocol == "vdi"`.
- **Drop-in upgrade from v0.29.0.** Operators who do not enable VDI (i.e. do not apply `docker-compose.vdi.yml`) see no behaviour change beyond the new in-app docs entries and the live web-session runtime.

# What's New in v0.29.0

> **Foundation release.** v0.29.0 lands the typed config, allocator, egress guard, image whitelist, container-naming, and admin UI for two new connection protocols — `web` (kiosk Chromium inside Xvnc, tunnelled as VNC) and `vdi` (Strata-managed Docker desktop containers tunnelled as RDP) — along with 36 new backend unit tests, full operator docs, and a new admin endpoint for the VDI image whitelist. The **live runtime spawn** (`Xvnc` + Chromium for `web`, the `bollard`-backed `DockerVdiDriver` for `vdi`) is intentionally deferred to a follow-up release; both roadmap items remain marked **In Progress** in the admin UI. No migrations, no API-contract changes for existing protocols.

---

## 🌐 `web` protocol — Web Browser Sessions (foundation)

A new `connections.protocol = "web"` value lets operators publish a controlled, tunnelled Chromium kiosk pointed at a single internal web app (think: Splunk, Grafana, internal SharePoint, an admin console behind a jumphost). Sessions are recorded and brokered through the same VNC tunnel as everything else — there is no direct browser-to-target route.

This release ships everything **except the actual `Xvnc` + Chromium spawn** — that piece needs Dockerfile package additions and a sandboxing review, and is tracked separately. What's in v0.29.0:

- **Typed `connections.extra` schema** for `web` (`url`, `allowed_domains`, `login_script`) with lenient parsing — blank strings collapse to `None` so the admin form doesn't have to special-case empty optional fields.
- **`WebDisplayAllocator`** — thread-safe `:100`–`:199` X-display allocator with a 100-session cap per backend replica, full reuse on release, and exhaustion / release-unknown error paths covered.
- **CIDR egress allow-list (`web_allowed_networks`)** with **fail-closed semantics for an empty list** and **all-resolved-IPs-must-pass for DNS hosts** — the latter is explicit defence against DNS rebinding via mixed A records. Without this, a permissive `0.0.0.0/0` operator entry would otherwise be the trivial SSRF foothold.
- **Chromium kiosk argv builder (`chromium_command_args`)** mirroring rustguac: `--kiosk`, ephemeral per-session `--user-data-dir`, `--host-rules` for domain restriction, and crucially **`--remote-debugging-address=127.0.0.1`** — the CDP socket is bound to localhost only so it can never be reached from the network even if the network policy were misconfigured.
- **20 new backend unit tests** covering allocator increment / reuse / exhaustion, config parsing edge cases, CIDR matching across v4 and v6, host-lookup behaviour for literals and DNS rebinding, and the kiosk argv emission.
- **Admin form sections** in `connectionForm.tsx` (URL / allowed-domains / login-script) wired into `AccessTab.tsx` with port default `5900`.
- Two new dependencies in `backend/Cargo.toml`: `ipnet = "2"` and `url = "2"`.
- New operator runbook at [`docs/web-sessions.md`](docs/web-sessions.md) covering when-to-use, architecture, the `connections.extra` schema, the egress allow-list semantics, the planned audit events (`web.session.start` / `web.session.end` / `web.autofill.write` — strings are fixed now so the operator-facing contract is stable), and known operator pitfalls.

The Chromium **Login Data SQLite autofill writer** (PBKDF2-SHA1 / AES-128-CBC with the v10 prefix), the Chrome DevTools Protocol login-script runner, and the tunnel-handshake `web → vnc` selector translation are deferred — the autofill writer in particular is sensitive enough that we want it landing alongside its own dedicated audit event (`web.autofill.write`) and an end-to-end smoke test, not in this foundation release.

---

## 🖥️ `vdi` protocol — Strata-managed Desktop Containers (foundation)

A new `connections.protocol = "vdi"` value lets operators ship single-user Linux desktop containers — running xrdp inside a hardened image — and have Strata manage their lifecycle (create-on-connect, optional persistent home, idle-timeout reaping, deterministic naming for reuse). The connection is tunnelled as RDP so the whole existing recording / clipboard / file-browser pipeline applies unchanged.

What's in v0.29.0 (foundation only — `DockerVdiDriver` and the reaper extension are deferred):

- **`VdiDriver` async trait** + `NoopVdiDriver` stub returning `DriverUnavailable` until the operator opts in to mounting `/var/run/docker.sock` (which grants host root — see below).
- **Typed `VdiConfig::from_extra`** view (`image`, `cpu_limit`, `memory_limit_mb`, `idle_timeout_mins`, `env_vars`, `persistent_home`) with **reserved-key stripping** — `VDI_USERNAME` / `VDI_PASSWORD` are silently dropped from `env_vars` so the admin form cannot leak or override the runtime credentials. The runtime layer always wins.
- **`ImageWhitelist::parse`** — newline- or comma-separated, supports `#` comments, **strict equality matching only**. No glob, no tag substitution, no digest-vs-tag fuzziness. Pinning is a security feature: an operator who whitelists `myorg/strata-desktop:1.4.0` does not also implicitly trust `:latest`.
- **Deterministic per-(connection, user) container naming** (`container_name_for`, ≤63 chars) — the basis for persistent-home reuse without requiring DB-side container-ID bookkeeping.
- **Env-var layering (`vdi_env_vars`)** — operator-supplied env layered with reserved-key overrides so `VDI_USERNAME` / `VDI_PASSWORD` cannot be hijacked by a misconfigured admin form.
- **`DisconnectReason::from_xrdp_code`** classifier mapping the xrdp WTSChannel disconnect frame to `Logout` / `TabClosed` / `IdleTimeout` / `Other`, plus `should_destroy_immediately()` — logout and idle-timeout destroy the container; tab-close retains it for reuse on the next connect. The reaper has a deterministic input.
- **`GET /api/admin/vdi/images`** admin endpoint returning the operator whitelist, used to populate the image dropdown in the connection-editor UI.
- **16 new backend unit tests** covering all of the above.
- **Admin form sections** in `connectionForm.tsx` (image dropdown / CPU / memory / idle-timeout / env-vars / persistent-home) wired into `AccessTab.tsx` with port default `3389`. Reserved env keys are stripped client-side too as defence-in-depth.
- New operator runbook at [`docs/vdi.md`](docs/vdi.md) — including the **mandatory `docker.sock` warning**: mounting `/var/run/docker.sock` into the backend container grants the backend root on the host. This is why `DockerVdiDriver` is opt-in and why the live driver is gated on a separate operator decision, not a default-on capability.

The `bollard`-backed `DockerVdiDriver` itself, the live `ensure_container` reuse-by-name flow, the persistent-home bind mount under `home_base`, the idle reaper extension to `services/session_cleanup.rs`, the `contrib/vdi-sample/Dockerfile`, the opt-in `/var/run/docker.sock` mount in `docker-compose.yml`, and the `max_vdi_containers` concurrency cap are all explicitly deferred.

---

## 🎨 UI plumbing — protocol icons, badges, command palette

- New globe SVG icon for `web` and stacked-container SVG for `vdi` in the dashboard tile grid and the command palette protocol filter.
- New protocol badges in the active-sessions and recordings pages with matching unit-test coverage (`ActiveSessions.test.tsx`, `Sessions.test.tsx`).
- All 1192+ existing frontend tests continue to pass.

---

## 📚 Documentation

- New operator runbooks: [`docs/web-sessions.md`](docs/web-sessions.md) and [`docs/vdi.md`](docs/vdi.md).
- [`docs/architecture.md`](docs/architecture.md) gains an "Extended protocols" section linking both runbooks.
- [`docs/security.md`](docs/security.md) gains a **"Web Sessions and VDI: extended threat model"** section covering SSRF defence via `web_allowed_networks`, profile reuse, Chromium autofill secrecy, CDP localhost-only binding, the **`docker.sock` host-root warning**, image-whitelist strictness, the reserved env-key rule, the reaper semantics, and the per-replica concurrency caps.
- [`docs/api-reference.md`](docs/api-reference.md) documents `GET /api/admin/vdi/images`.

---

## 🛠 Upgrade notes

- **No database migrations.**
- **No API-contract changes** for existing connections, recordings, share links, or credential profiles.
- The two new connection types (`web`, `vdi`) reuse the existing `connections.extra` JSONB column and the existing audit / recording / credential-mapping pipelines.
- The roadmap items `protocols-web-sessions` and `protocols-vdi` remain marked **In Progress** in the admin UI — choosing the protocol in the connection editor will let you save a row, but **the live spawn is not in this release**. If you need the runtime now, watch the rustguac-parity tracker.
- Drop-in upgrade from v0.28.x.

---

# What's New in v0.28.0

> **Performance release.** v0.28.0 lands end-to-end H.264 GFX passthrough — RDP H.264 frames now travel from FreeRDP 3 all the way to the browser's WebCodecs `VideoDecoder` without a server-side transcode step. On Windows hosts with AVC444 properly configured, expect roughly an order-of-magnitude bandwidth reduction over the legacy bitmap path and meaningfully crisper text rendering during rapid window animations. No migrations, no API contract changes, drop-in upgrade.

---

## 🎥 H.264 GFX passthrough end-to-end (rustguac parity)

For the first time, RDP H.264 frames travel **FreeRDP 3 → guacd → WebSocket → browser's WebCodecs `VideoDecoder`** with **no intermediate server-side decode/re-encode**. Previously every RDP frame was decoded inside guacd and re-encoded as PNG / JPEG / WebP tiles before being shipped to the browser — that round-trip was the root cause of the cross-frame ghost artefacts that v0.27.0's Refresh Rect mitigation targeted. With passthrough enabled, that whole class of artefact cannot occur because there is no transcode step to lose state across.

The passthrough pipeline involves four cooperating components:

1. **`guacd` patch (`guacd/patches/004-h264-display-worker.patch`)** — a byte-identical port of upstream `sol1/rustguac`'s H.264 display-worker patch (SHA `7a13504c2b051ec651d39e1068dc7174dc796f97`). The patch hooks FreeRDP's RDPGFX `SurfaceCommand` callback, queues AVC NAL units on each `guac_display_layer`, and emits them as a custom `4.h264` Guacamole instruction during the per-frame flush. The previous Refresh-Rect-on-no-op-size patch at the same path is **superseded** — the in-session ghost recovery from v0.27.0 is no longer needed because the underlying ghost class cannot occur with a passthrough decoder.

2. **Vendored `guacamole-common-js` 1.6.0 (`frontend/src/lib/guacamole-vendor.js`)** — bundles a full `H264Decoder` (line ~13408) that lazily instantiates a `VideoDecoder` on the first `4.h264` opcode, plus a sync-point gate (`waitForPending`, line ~17085) that prevents the decoder being asked to flush before its pending-frame queue has drained. The `4.h264` opcode handler at line ~16755 routes inbound NAL units into the decoder. **Stock `guacamole-common-js` does not handle the `h264` opcode**, hence the vendored bundle. All `import Guacamole from "guacamole-common-js"` call sites continue to resolve through the existing Vite alias → `frontend/src/lib/guacamole-adapter.ts` → the vendored bundle, so no application code changed.

3. **Backend RDP defaults (`backend/src/tunnel.rs`)** — `full_param_map()` now seeds the full RDP defaults block required for AVC444 negotiation: `color-depth=32`, `disable-gfx=false`, `enable-h264=true`, `force-lossless=false`, `cursor=local`, plus the explicit `enable-*` / `disable-*` toggles that FreeRDP's `settings.c` requires (empty ≠ `"false"` in many guacd code paths). Per-connection `extras` continue to override defaults via the existing allowlist — which now permits `disable-gfx`, `disable-offscreen-caching`, `disable-auth`, `enable-h264`, `force-lossless`, and the related GFX toggles so the admin UI can drive them per connection.

4. **Windows host AVC444 configuration** — RDP hosts must have AVC444 enabled before any of the above starts paying off. v0.28.0 ships [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1), a read-first PowerShell helper that audits the current registry state, detects whether the host has a usable hardware GPU, prints the diff, and prompts before applying changes. Idempotent and safe to re-run.

### Why this is a big deal

| Aspect                            | Bitmap path (pre-v0.28.0)                           | H.264 passthrough (v0.28.0+)                                     |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Server-side work per frame        | RDP H.264 decode → re-encode to PNG/JPEG/WebP tiles | Forward NAL units verbatim                                       |
| Bandwidth (1080p typical desktop) | ~5–15 Mbps                                          | ~0.5–2 Mbps                                                      |
| Text rendering during animations  | Cross-frame ghosting on rapid window cycles         | Decoder reference chain stays intact                             |
| Browser CPU                       | Image-tile blit (cheap, but constant)               | Hardware video decode (cheaper, GPU-accelerated where available) |
| Server CPU                        | Transcode pipeline runs every frame                 | guacd just shovels NAL units                                     |

---

## 🛠️ Admin UX

### "Disable H.264 codec" checkbox is no longer dead

The toggle introduced in v0.26.0 was wired to `enable-gfx-h264` — a parameter name **guacd does not recognise** — so checking it had no effect. It is now bound to the correct `enable-h264` parameter and honoured by the backend allowlist. ([`frontend/src/pages/admin/connectionForm.tsx`](frontend/src/pages/admin/connectionForm.tsx))

### Color Depth dropdown labels reflect H.264 reality

The "Auto" placeholder was misleading because the backend forces `color-depth=32` whenever the field is empty (32-bit is **mandatory** for AVC444 negotiation). The select now reads "Default (32-bit, required for H.264)" and explicitly annotates the lower-bit options as **disabling H.264**, so admins are not surprised when a 16-bit choice silently degrades them to RemoteFX.

---

## 🧰 Operations

### Windows host AVC444 configuration script

[`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) is a read-first PowerShell helper for Windows RDP hosts. It:

- Inspects the current `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services` and `HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations` registry values.
- Enumerates `Win32_VideoController` and detects whether the host has a usable hardware GPU (filtering out Microsoft Basic Display, Hyper-V synthetic, and RemoteFX adapters; requires >256 MB adapter RAM and a real vendor name).
- On Server SKUs, prints the additional GPO requirement (`Use hardware graphics adapters for all Remote Desktop Services sessions`).
- Reports the diff between current and recommended values as a table.
- Prompts before applying any change, with an inline decision matrix for hosts **without** a hardware GPU (production multi-user → skip, production WAN with 1–2 users → proceed, verification → proceed).
- Conditionally skips the GPU-only keys (`AVCHardwareEncodePreferred`, `bEnumerateHWBeforeSW`) on hosts without a real GPU.
- Prints the post-reboot verification path: **Event Viewer → Applications and Services Logs → Microsoft → Windows → RemoteDesktopServices-RdpCoreTS → Operational**, watching for **Event ID 162** (AVC444 mode active) and **Event ID 170** (hardware encoding active).
- Offers an opt-in reboot at the end.

The desired-state map mirrors `sol1/rustguac`'s `contrib/setup-rdp-performance.ps1` and includes `MaxCompressionLevel=2`, `fEnableDesktopComposition=1`, `fEnableRemoteFXAdvancedRemoteApp=1`, `VisualExperiencePolicy=1`, `fClientDisableUDP=0`, and `SelectNetworkDetect=1` for full parity. The 60 FPS unlock (`DWMFRAMEINTERVAL=15`) is written to the **correct** `Terminal Server\WinStations` location, not the unrelated `\Windows\Dwm` key — an earlier draft of this script wrote it to the wrong location and so never actually unlocked 60 FPS.

### New operator runbook: `docs/h264-passthrough.md`

End-to-end documentation of the passthrough stack:

- **Pipeline anatomy** — what runs where, and which file owns each step.
- **Verification across four layers in priority order**:
  1. **Windows Event Viewer** (authoritative — Event 162 = AVC444 active, Event 170 = HW encoding active)
  2. **guacd logs** — "H.264 passthrough enabled for RDPGFX channel"
  3. **WebSocket frame trace** — `4.h264,…` instructions visible in DevTools
  4. **`client._h264Decoder.stats()`** — `framesDecoded > 0` confirms client-side decode
- **Windows host prerequisites** — what the helper script automates and why each registry value matters.
- **Decision matrix for hosts without a hardware GPU** — software AVC trade-offs (CPU cost ~1–2 cores per 1080p@30 session, bottlenecks at 2–4 concurrent sessions, lower quality at the same bitrate vs hardware AVC) and when the bitmap path is the better choice.

---

## ⚠️ Known limitations

### Chrome DevTools-induced ghosting

DevTools open in Chromium-based browsers can produce visible ghosting that **resembles** a codec problem but is not. Chrome throttles GPU-canvas compositing and `requestAnimationFrame` cadence on tabs whose DevTools panel is open; cached tile blits fall behind the live frame stream and the user perceives ghosting. Closing DevTools (or detaching it to a separate window) restores normal compositor behaviour. **This is a browser-side rendering artefact unrelated to H.264 and is not fixable in the Strata client.** If `client._h264Decoder?.stats()` shows `framesDecoded > 0` and the canvas still ghosts, DevTools is the most likely cause.

### H.264 is opportunistic — depends on the host

If AVC444 is not configured on the RDP host, `enable-h264=true` has no effect. guacd still loads the H.264 hook (you will see `H.264 passthrough enabled for RDPGFX channel` in the logs) but no AVC `SurfaceCommand` callbacks ever fire and the session falls back to the bitmap path silently. Run [`docs/Configure-RdpAvc444.ps1`](docs/Configure-RdpAvc444.ps1) on the host to enable it.

---

## 🔄 Upgrade notes

- **No migrations.** No backend or frontend API-contract changes. The previously-shipped per-connection `extras` column accepts the corrected `enable-h264` key without any migration.
- **guacd image rebuilds automatically** against the new patch (`004-h264-display-worker.patch`) on first deploy. The v0.27.0 `004-refresh-on-noop-size.patch` is **superseded**.
- **Refresh Display button retired.** The Session Bar's Refresh Display button has been removed because the underlying ghost class cannot occur with a passthrough decoder. The `refreshDisplay?: () => void` field on the `GuacSession` interface remains as a no-op for backwards compatibility with any third-party integrations that may have referenced it.
- **Breaking changes** — none.

---

# What's New in v0.27.0

> **Reliability release.** v0.27.0 ships an in-session fix for the H.264 GFX rendering corruption documented in v0.26.0 — no more mandatory Reconnect to clear the overlapping-window ghost.

---

## 🖥️ Refresh Display now fixes the overlapping-window ghost

v0.26.0 documented a class of rendering corruption where rapid window minimise/maximise cycles left multiple overlapping window states on the canvas, recoverable only by clicking **Reconnect**. v0.27.0 ships an in-session fix:

1. **Forked guacd patch (`guacd/patches/004-refresh-on-noop-size.patch`)** intercepts a Guacamole `size W H` instruction whose dimensions match the current remote desktop size (a no-op resize) and sends an RDP **Refresh Rect** PDU to the RDP server for the full screen. Refresh Rect asks the server to retransmit a full frame, which under FreeRDP 3's H.264 GFX pipeline triggers an IDR keyframe and resets the decoder's reference-frame chain.
2. **Frontend wire-up** — the Session Bar's **Refresh Display** button now drives this path via `client.sendSize(cw, ch)` with the current container dimensions. One click, no reconnect, no black-screen flash.

A 1-second per-session cooldown (new `guac_rdp_client.last_refresh_rect_timestamp` field) prevents an over-eager client flooding the RDP server with full-frame retransmit requests.

The hijack-the-`size`-instruction approach was deliberately chosen over a new Guacamole protocol opcode so that **stock `guacamole-common-js` (which Strata does not fork) continues to work unchanged**. The frontend change is also safe to run against an un-patched guacd — stock guacd silently ignores the no-op resize, the frontend's compositor nudge still fires, and the old behaviour is preserved.

## ⚠️ Server-dependent behaviour, safe fallbacks remain

MS-RDPEGFX specifies Refresh Rect as valid in GFX mode, but does **not** mandate that servers emit an IDR in response. On Windows 10/11 and Windows Server 2019/2022 the patch is expected to clear ghost frames within ~1 frame; on older or non-Microsoft RDP servers it may be a no-op and the **Reconnect** button remains the recovery path. Operators seeing persistent ghosts after Refresh Display should still fall back to Reconnect or to the per-connection **Disable H.264 codec** toggle.

## 🔄 Upgrade notes

- **No migrations.** No API-contract changes. No breaking changes to existing configs or persisted state.
- The v0.26.0 **Known issues** entry for H.264 reference-frame corruption is **superseded** by this release; the workarounds listed there (Reconnect button + per-connection Disable H.264 toggle) remain available as fallbacks for the server-dependent behaviour noted above.

---

# What's New in v0.26.0

> **Hardening release.** v0.26.0 is the result of an end-to-end code review across the backend and frontend, followed by a focused sweep of security, audit, and reliability fixes. No breaking API changes, one additive migration (056), drop-in upgrade.

---

## 🔒 Security & audit hardening

### Share tokens respect connection soft-deletes

Before v0.26.0, a share link minted against a connection that was subsequently soft-deleted would continue resolving — viewers hitting the `/share/:token` URL got routed at the stale connection metadata. `services::shares::find_active_by_token` now JOINs `connections` and filters `soft_deleted_at IS NULL`, so a deleted connection's shares stop working the moment the delete commits, even if the share row itself is still live.

### Brute-force isolation on shared tunnel rate limit

The `SHARE_RATE_LIMIT` overflow path used to call `map.clear()`, which meant an attacker spamming unique tokens could **reset every legitimate token's counter as a side-effect**. The new behaviour is a two-step LRU eviction: first drop entries whose windows have fully expired, then — only if still over the cap — evict the oldest-attempt entries. Real users' rate-limit state is unaffected by noise.

### Share rejection paths emit audit events

Two new event types appear in `audit_logs`:

- `connection.share_rate_limited` — emitted when a share URL hits the per-token rate limit
- `connection.share_invalid_token` — emitted when a lookup misses

Both carry a SHA-256-prefix fingerprint of the token (8 hex chars, the raw token is never persisted) plus the client IP, so operators can see probing activity against their share links without any PII leaks.

### User-route audit coverage gaps closed

Several self-service mutations were previously silent. They now emit audit events:

| Handler                                               | Event                             |
| ----------------------------------------------------- | --------------------------------- |
| `POST /api/user/accept-terms`                         | `user.terms_accepted`             |
| `PUT /api/user/credential-mappings`                   | `user.credential_mapping_set`     |
| `DELETE /api/user/credential-mappings/:connection_id` | `user.credential_mapping_removed` |
| `POST /api/user/checkouts/:id/retry`                  | `checkout.retry_activation`       |
| `POST /api/user/checkouts/:id/checkin`                | `checkout.checkin`                |

### Vault error paths sanitized

When Vault returns a server error or the HTTP transport fails, the full body / error detail is now emitted at `tracing::debug!` only. API callers see a generic `"Vault <status>"` or `"Vault request transport error"` message — no more raw Vault JSON leaking through to the client on a misconfigured instance.

### StubTransport compiled out of release builds

The in-memory test transport is now gated behind `#[cfg(test)]`. No path in a production binary can retain rendered message bodies (which can include justification strings and ephemeral credentials) in memory.

---

## 🛠️ Reliability & performance

### Input latency eliminated under bitmap bursts

The single biggest user-facing fix in v0.26.0. The WebSocket tunnel's proxy loop used to call `ws.send(...).await` inline inside the guacd→browser `tokio::select!` arm. Under heavy draw bursts — the classic symptom being a Win+Arrow window snap spewing a lot of bitmap updates in ~200 ms — the browser's WS receive buffer would fill, `ws.send().await` would block, and **while it was blocked the `ws.recv()` arm could not run**. So mouse movements and keystrokes queued up in the kernel TCP buffer and only flushed when the back-pressure relieved, producing three symptoms that were consistently reported together:

- Rendering freezes
- Mouse movement that felt like mouse acceleration had been turned on (a burst of queued movements arriving at once)
- Keyboard lag on the same timescale

The fix decouples the WebSocket sender from the select loop:

- `ws.split()` → `ws_sink` + `ws_stream`
- A bounded mpsc channel (1024 messages) sits in front of the sink
- A dedicated writer task drains the channel into the sink
- Every former `ws.send(...).await` call site now pushes to the channel — a fast in-memory append when the channel isn't full

Input-path latency is now independent of output-path backpressure. On the frontend, `display.onresize` events are coalesced to one `handleResize` per animation frame (FreeRDP 3 emits multiple partial size updates during snap animations), and the pending-buffer drain on the backend is now `O(remainder)` instead of `O(n)` via `Vec::drain`.

### Tunnel overflow emits a proper error frame

When guacd ever sends a single instruction larger than the pending-byte ceiling, the tunnel used to silently call `pending.clear()` — from the user's perspective the session would drop frames for no apparent reason. It now dispatches a Guacamole `error "…" "521"` to the websocket and closes the stream cleanly, so clients see exactly why the session ended.

### Indexed email retry sweep (migration 056)

The email retry worker runs `SELECT … WHERE status='failed' AND attempts<3 ORDER BY created_at` every 30 seconds. Without an index this became a seq-scan once `email_deliveries` grew. Migration `056_email_deliveries_retry_idx.sql` adds a partial index:

```sql
CREATE INDEX email_deliveries_retry_idx
    ON email_deliveries (created_at)
    WHERE status = 'failed' AND attempts < 3;
```

The index stays tiny because the retryable population is tiny.

### Settings cache TTL: 30 s → 5 s

Admin toggles (feature flags, branding, SMTP enable) used to take up to 30 seconds to propagate across replicas. The cache TTL is now 5 seconds, keeping operator feedback near-instant while still absorbing the hot-path read burst from auth middleware. A pg NOTIFY-based invalidator remains on the roadmap for zero-staleness.

---

## ✨ Admin UX polish

### Notifications tab — template test-send picker

The SMTP test-send panel gained a dropdown next to the recipient input letting admins dry-run **any of the real notification templates** (checkout requested / approved / denied / expiring) against their live relay. The backend renders the real MJML template with a synthetic sample context (requester, approver, justification, expiry), prefixes the subject with `[TEST]` so it can't masquerade as a real notification, and pulls the `tenant_base_url` and `branding_accent_color` from the live settings so the preview reflects the operator's actual branding.

### Port & TLS dropdowns are now bidirectionally symmetric

Picking a canonical port (25 / 465 / 587) now also snaps the TLS mode to the conventional pairing (so port 465 → Implicit TLS, 587 → STARTTLS), mirroring the pre-existing "TLS mode snaps port" behaviour. The two dropdowns can no longer drift into nonsensical combinations like _port 465 + STARTTLS_.

### Password field: discriminated union

Frontend callers used to pass `password: undefined | "" | string` to `updateSmtpConfig` with a three-way semantic (keep / clear / set). That's now an explicit discriminated union:

```ts
password: { action: "keep" } | { action: "clear" } | { action: "set", value: string }
```

The wire format is unchanged — the API client serializes back to the old shape at the request boundary — but the intent is now unambiguous in every caller.

---

## 📚 Docs & roadmap hygiene

- **Roadmap retention policy** codified in `docs/roadmap.md`: shipped items are visible for the minor line in which they landed and pruned at the next minor bump. No items in the markdown roadmap were flagged Shipped during the v0.25.x line, so nothing needs removing here — but the policy is now in place for future minor bumps.

---

## 📦 Upgrade notes

- **Database migration** — one additive migration: `056_email_deliveries_retry_idx.sql`. Safe on every supported Postgres version, no table locks beyond the `CREATE INDEX`.
- **Breaking API changes** — none. Frontend `SmtpConfigUpdate.password` type changed, but the backend wire format is identical.
- **Version bump** — `VERSION`, `frontend/package.json` (+ lock), `backend/Cargo.toml` (+ lock), and the README badge now read **0.26.0**.

---

# What's New in v0.25.2

> **The missing admin tab.** v0.25.2 ships the **Admin → Notifications** tab that the v0.25.0 release notes described but — as an observant administrator pointed out — never actually landed in the UI. The backend endpoints have been running since v0.25.0; this release puts a proper front-end on top of them. No migrations, no API changes, drop-in upgrade.

---

## 🖥️ Admin → Notifications — the SMTP configuration UI

A new top-level tab appears on the Admin Settings page (visible to users with `can_manage_system`). It is split into three sections:

### 1. SMTP relay configuration

Standard form fields for **host**, **port**, **TLS mode** (STARTTLS / Implicit TLS / None), **username**, **From address**, **From name**, and **brand accent colour** (used as the button colour in the HTML templates). The **Enable notification emails** master switch at the top is honoured by the dispatcher — off means _no outbound mail_, no TCP connection to the relay, no `email_deliveries` row churn.

### 🔐 The password field is Vault-aware

Because the SMTP password is **sealed into Vault server-side** (the backend rejects the PUT if Vault is sealed or in stub mode — see v0.25.0 notes), the UI never shows the actual stored value. Instead:

- An empty input with a **"•••••••• (sealed in Vault)"** placeholder appears when a password is already on file.
- Typing a new value and saving seals and replaces the stored secret.
- A **Keep existing** button discards your edit and leaves the stored value alone.
- A **Clear** button (only visible when a password is on file and you haven't started typing a new one) lets you remove the stored password on save — useful if you're switching to a relay that accepts anonymous SMTP from your subnet.

Three-state semantics are wired end-to-end: the `password` field on the PUT body is `undefined` to keep, `""` to clear, or a non-empty string to replace.

### 2. Send test email

A dedicated panel with a recipient input and a **Send test** button. The backend round-trips through the live `SmtpTransport` using the saved settings and returns the actual SMTP response on error (connection refused, 550 recipient rejected, certificate chain problems, etc. — all surface verbatim). Successful sends show up in the deliveries table below within a second.

The button is disabled until SMTP is enabled in the saved config — trying to test against unsaved form state leads to confusion, so we force a save first.

### 3. Recent deliveries

Last 50 rows of the `email_deliveries` audit table, ordered newest first, with a status filter (All / Queued / Sent / Failed / Bounced / Suppressed) and a manual **Refresh** button. Each row shows creation timestamp, template key, recipient, subject, status pill, attempt count, and the last error (hover for full text).

This is the same data that powered the v0.25.0 `GET /api/admin/notifications/deliveries` endpoint — which had been observable only via `curl` before now.

---

## 🛠️ API layer

Four new typed helpers in [`frontend/src/api.ts`](frontend/src/api.ts):

```ts
getSmtpConfig(): Promise<SmtpConfig>
updateSmtpConfig(body: SmtpConfigUpdate): Promise<{ status: string }>
testSmtpSend(recipient: string): Promise<{ status: string }>
listEmailDeliveries(status?, limit?): Promise<EmailDelivery[]>
```

Full TypeScript types (`SmtpConfig`, `SmtpConfigUpdate`, `EmailDelivery`) are exported for callers outside the Notifications tab.

---

## 📦 Upgrade notes

- **Database migration** — none.
- **API contract** — no new, removed, or changed endpoints. The v0.25.0 routes are now driven by the admin UI instead of requiring `curl`.
- **Breaking changes** — none.
- **Version bump** — `VERSION`, `frontend/package.json` (+ lock), `backend/Cargo.toml` (+ lock), and the README badge now read **0.25.2**.

---

## 🙏 Credits

Thanks to the admin who noticed the discrepancy between the release notes and the actual UI. The v0.25.0 changelog entry has been annotated in v0.25.2's _Fixed_ section as a documentation-honesty correction.

---

# What's New in v0.25.1

> **Quality-of-life patch release.** v0.25.1 lands a targeted RDP canvas-refresh fix for the "screen clipping" artefact that some users saw after minimising and restoring an active remote session, plus a zero-warning backend release build. No schema changes, no API contract changes, drop-in upgrade.

---

## 🖥️ RDP "screen clipping" fixed (with a new **Refresh display** button)

A subset of RDP users reported a stale rectangle of pixels remaining visible in the lower-right of the remote canvas after minimising and restoring the window (or toggling full-screen). The artefact would persist until the user manually resized the browser window, at which point the next draw cycle cleared it.

**Root cause.** Guacamole's JavaScript display emits a `display.onresize` event when the remote framebuffer changes size, but the browser compositor — with no CSS property change to invalidate its tile cache — would occasionally keep the pre-resize rectangle on screen if no pixel data arrived on the affected region before the next paint.

**The fix.** v0.25.1 introduces a `forceDisplayRepaint()` helper on `SessionClient.tsx` that nudges the canvas scale by a sub-pixel delta (`baseScale + 1e-4`), which the compositor treats as a transform change and which therefore invalidates every cached tile, forcing a full repaint of the `guacamole-common-js` display layers. The helper is:

1. **Auto-scheduled** at 50 ms, 200 ms, and 500 ms after every `display.onresize` event, so the common minimise/restore/full-screen-toggle cases self-heal with no user intervention.
2. **Exposed** through the session object as `refreshDisplay?: () => void` and surfaced in `SessionBar` as a **Refresh display** button, so users hitting rarer edge cases (GFX pipeline stalls, out-of-order H.264 frames on flaky networks) have a one-click recovery path.

The button only appears for sessions that publish `refreshDisplay` — historical recording playback is unaffected and does not show the control.

---

## 🧹 Zero-warning backend release build

The v0.25.0 notification pipeline landed with a public API surface sized for P8 (admin UI) and P9 (user opt-out UI) work that is still pending. Those reserved items generated 16 `unused_imports` / `dead_code` warnings during `docker compose build backend`.

v0.25.1 tidies the output: genuinely-unused imports are removed, and every retained-for-future-phase item (`InlineAttachment`, `BoxedTransport`, `SendError`, `StubTransport`, `describe`, `context_from_pairs`, the `reply_to`/`inline` builders, `DeliveryToRetry.attempts`, and `CheckoutEvent::target_account_dn`) now carries a focused `#[allow(dead_code)]` or `#[allow(unused_imports)]` annotation **with a rationale comment** pointing to the consuming phase. The outcome is a clean `cargo check --bin strata-backend --all-targets` — **0 warnings, 0 errors** — ready for an eventual `-D warnings` CI gate.

No runtime code was removed. All 852 backend unit tests pass unchanged.

---

## 📦 Upgrade notes

- **Database migration** — none. No schema change.
- **Breaking changes** — none. `GuacSession` gained an optional field (`refreshDisplay?: () => void`) used only by in-memory frontend code.
- **API contract** — unchanged; no new, removed, or renamed endpoints.
- **Version bump** — `VERSION`, `frontend/package.json`, `backend/Cargo.toml`, and `backend/Cargo.lock` now read **0.25.1**.

---

## 🙏 Credits

Thanks to the user who reported the RDP minimise/restore clipping; the repro steps (minimise → wait → restore, artefact persists until browser resize) were what identified the compositor-cache miss as the root cause rather than the originally-suspected canvas geometry bug.

---

# What's New in v0.25.0

> **Notifications release.** v0.25.0 delivers the long-awaited modern checkout-notification email pipeline — polished MJML templates, Outlook dark-mode hardening, an admin SMTP UI, per-user opt-outs, and a background retry worker. Zero-downtime upgrade; emails simply start flowing once an admin configures the SMTP relay.

---

## 📬 Modern managed-account notification emails

Strata now sends mobile-friendly HTML emails for every key managed-account checkout event:

| Event                                     | Recipients                                    | Opt-out?                 |
| ----------------------------------------- | --------------------------------------------- | ------------------------ |
| **Checkout pending approval**             | All assigned approvers for the target account | ✅ Yes                   |
| **Checkout approved**                     | The original requester                        | ✅ Yes                   |
| **Checkout rejected**                     | The original requester                        | ✅ Yes                   |
| **Self-approved checkout (audit notice)** | Configured audit recipients                   | ❌ No (audit visibility) |

Each email is rendered from an [MJML](https://mjml.io) template (mobile-responsive, tested across Gmail / Outlook / Apple Mail), dispatched as `multipart/related` with the Strata logo inlined as `cid:strata-logo`, and accompanied by a plain-text alternative for accessibility and minimal-client compatibility.

### 🌒 Outlook dark-mode "haze" fixed

Outlook desktop on Windows has a long-standing dark-mode quirk where it overlays a lighter rectangle ("haze") on top of HTML emails by inverting `bgcolor` attributes. v0.25.0 ships a reusable `wrap_for_outlook_dark_mode` helper that injects:

1. The VML namespace on `<html>`
2. A full-bleed `<v:background fill="t">` inside an `<!--[if gte mso 9]>` conditional
3. An Outlook-only stylesheet forcing dark backgrounds

VML backgrounds are immune to Outlook's inversion engine, so the result is a clean dark-themed email even in Outlook desktop dark mode. Future templates inherit the fix automatically.

---

## ⚙️ Admin SMTP configuration UI

A new **Admin → Notifications** tab exposes:

- **SMTP host / port / TLS mode** (`STARTTLS`, implicit-TLS, or plaintext for internal relays)
- **Username** (plaintext) and **password** (sealed into Vault — see security note below)
- **From-address** and **From-name**
- **Send test email** button — round-trips through the live transport and surfaces the actual SMTP response for debugging
- **Recent deliveries** view — last 50 attempts with status, attempt count, and error reason

### 🔐 Security note: SMTP password requires Vault

The SMTP password is **hard-required** to be stored in Vault. The `PUT /api/admin/notifications/smtp` endpoint refuses to save credentials if Vault is sealed or running in stub mode. This is intentional — SMTP credentials granting outbound mail are a high-value target and must never sit in plaintext on disk.

### 🚦 Dispatch is blocked when from-address is empty

If `smtp_from_address` is empty, the dispatcher silently skips all sends and audit-logs `notifications.misconfigured`. This prevents half-configured installs from queuing thousands of broken messages.

---

## 🙋 Per-user opt-outs (with audit trail)

v0.25.0 introduces a single `users.notifications_opt_out` boolean column. When set, the dispatcher suppresses **all** transactional messages for that user and records each suppression as a `notifications.skipped_opt_out` audit event with the template key and target entity ID. Every suppression is also reflected in the `email_deliveries` audit table with `status = 'suppressed'`.

Self-approved audit notices are intentionally **not opt-out-able** — they exist for security visibility, not user convenience. The dispatcher's `ignores_opt_out` branch is hard-coded to bypass the flag for the self-approved template.

> [!NOTE]
> The user-facing toggle UI ships in a follow-up release. For v0.25.0, administrators can set the flag directly via SQL (`UPDATE users SET notifications_opt_out = true WHERE id = $1`).

---

## 🔁 Background retry worker

Transient SMTP failures (network blips, 4xx responses, transient connection errors) are retried automatically by a new `email_retry_worker`:

- **Tick interval**: 30 seconds
- **Initial warm-up**: 60 seconds
- **Per-attempt timeout**: 120 seconds
- **Backoff**: exponential
- **Max attempts**: 3 — after which the row is marked `abandoned` and a `notifications.abandoned` audit event is emitted

**Permanent failures (5xx)** are _not_ retried — they go straight to `failed` so admins can see the underlying SMTP rejection in the deliveries view.

---

## 🗄️ Schema additions (migration 055)

```
email_deliveries             — every send attempt with status, attempts, last_error
users.notifications_opt_out  — single boolean column for global per-user opt-out
system_settings (8 new rows) — smtp_enabled, smtp_host, smtp_port, smtp_username,
                                smtp_tls_mode, smtp_from_address, smtp_from_name,
                                branding_accent_color
```

The SMTP password is **not** stored in `system_settings`. It lives sealed under Vault Transit using the same `seal_setting` / `unseal_setting` helpers as `recordings_azure_access_key`. The `email_deliveries` table is indexed on `(status, created_at)` for the retry worker's selection query, on `(related_entity_type, related_entity_id)` for per-checkout lookups, and on `recipient_user_id` (partial, NOT NULL) for per-user audit views.

---

## 📈 Approver fan-out improvement

Previously, only the first matching approver received the _pending_ notification. v0.25.0's `services::checkouts::approvers_for_account` now joins `approval_role_accounts` with `approval_role_assignments` to fan out to **every assigned approver** for the target account. No configuration change required.

---

## 🚀 Upgrade notes

- **Database migration** runs automatically on first boot of v0.25.0 (`055_notifications.sql`).
- **No emails will be sent** until an admin visits **Admin → Notifications**, configures SMTP, and saves a `from-address`. This is intentional — silent dispatch on an unconfigured relay would be worse than no dispatch at all.
- **Existing admins** see no behaviour change for non-notification flows. The dispatcher is fire-and-forget and never blocks the user-facing checkout request.
- **Per-user opt-outs default to "send"** for all opt-out-able events. Users wishing to mute notifications must visit **Profile → Notifications** after the upgrade.

---

## 🛠️ Under the hood

- **Migration**: [`backend/migrations/055_notifications.sql`](backend/migrations/055_notifications.sql) — adds `email_deliveries`, the `users.notifications_opt_out` column, and 8 SMTP/branding rows in `system_settings`.
- **Module layout**: `backend/src/services/email/` houses the trait (`transport.rs`), production transport (`smtp.rs`), MJML renderer (`templates.rs` + `templates/`), Outlook VML wrapper (`outlook.rs`), and retry worker (`worker.rs`). Dispatcher lives in `backend/src/services/notifications.rs`.
- **New crates**: `lettre 0.11` (rustls + tokio1), `mrml 5`, `tera 1`, `async-trait 0.1`. `ammonia` was _removed_ in favour of a custom 5-character `xml_escape` helper.
- **ADR**: [ADR-0008 — Notification pipeline](docs/adr/ADR-0008-notification-pipeline.md) records the design rationale (MJML + mrml, Vault-sealed password, opt-out semantics, retry strategy, alternatives considered).
- **Runbook**: [docs/runbooks/smtp-troubleshooting.md](docs/runbooks/smtp-troubleshooting.md) covers symptom triage, log inspection, common transient/permanent errors, and rollback.
- **Version bump**: `VERSION`, `frontend/package.json`, and `backend/Cargo.toml` all now read **0.25.0**.
- **Validation**: 852 / 852 backend tests pass (was 817 in v0.24.0); all 26 `services::email::*` tests green.

---

# What's New in v0.24.0

> **RBAC refinement release.** v0.24.0 introduces a dedicated permission for the in-session Quick Share feature and consolidates the two "create connections" permissions into a single, clearer flag. Zero-downtime, non-breaking upgrade for every existing role.

---

## 🔐 New permission: **Use Quick Share** (`can_use_quick_share`)

Quick Share — the ephemeral file CDN exposed on the Session Bar for handing files into a remote desktop — previously relied on implicit "if the button is visible, the user can use it" gating with no backend enforcement. In v0.24.0 it is a first-class role permission:

| Surface                      | Behaviour before v0.24.0                  | Behaviour in v0.24.0                                                                    |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| **Session Bar button**       | Always visible while a session was active | Visible only when the user's role grants `can_use_quick_share` (or `can_manage_system`) |
| **`POST /api/files/upload`** | Any authenticated user                    | Requires `can_use_quick_share`; returns `403 Forbidden` otherwise                       |
| **Admin role editor**        | No checkbox                               | New **Use Quick Share** checkbox under **Admin → Access → Roles**                       |

> [!NOTE]
> **Upgrade behaviour is non-breaking.** Migration 054 sets `can_use_quick_share = true` on every existing role on first boot. Administrators who want to restrict Quick Share should untick the new checkbox on the relevant roles after the upgrade.

### Why a separate permission?

Quick Share writes to the backend file-store and is **independent of the guacd drive / SFTP channels** (which remain gated by the per-connection `enable-drive` / `enable-sftp` extras fixed in v0.23.1). That makes it a distinct capability from "Browse Files", and cleaner to govern separately — some tenants want to grant drive access but forbid link-sharing, or vice versa.

`can_use_quick_share` is treated as a **user-facing feature flag**, not an administrative permission. It is deliberately **excluded** from `has_any_admin_permission()`, so granting a role only Quick Share does **not** unlock any admin UI or endpoint. A dedicated regression test (`has_any_admin_perm_excludes_quick_share`) guards this invariant.

---

## 🧩 Unified "Create connections" permission

The role editor used to carry two almost-always-identical permissions:

- **Create new connections** (`can_create_connections`)
- **Create connection folders** (`can_create_connection_folders`)

In every review those two checkboxes ended up ticked together; the separation produced confusion more often than it produced value. v0.24.0 consolidates them:

- The `can_create_connection_folders` column is dropped from the `roles` table.
- Before dropping, migration 054 OR's its value **into** `can_create_connections`, so any role that had folders-only keeps connection-creation rights.
- The role-editor checkbox for "Create connection folders" is removed. Users with **Create new connections** can now create and organise both connections _and_ their folder hierarchy.

> [!TIP]
> **No one loses a capability.** Roles that previously had only the folders flag are silently upgraded to full connection creation — consistent with the practical reality that folders are meaningless without connections to put in them.

---

## 📡 API surface changes

Every user / auth / role API now emits `can_use_quick_share` in place of `can_create_connection_folders`:

- `GET /api/user/me`
- `POST /api/auth/login` (response payload's `user` object)
- `GET /api/admin/roles`, `POST /api/admin/roles`, `PUT /api/admin/roles/:id`

External API consumers should update their field mappings. The JSON field **count and shape are preserved** — only the semantic meaning of the retired slot has changed. See [`docs/api-reference.md`](docs/api-reference.md) for the full updated schemas.

---

## 🛠️ Under the hood

- **Migration**: `backend/migrations/054_unify_connection_folder_perm_add_quick_share.sql` performs the OR-rollup and column swap in a single transaction.
- **New middleware helper**: `services::middleware::check_quick_share_permission(&AuthUser)` — reusable gate for any future Quick-Share-adjacent endpoint.
- **Frontend context**: `SessionManagerProvider` now exposes `canUseQuickShare: boolean`; `App.tsx` seeds it from the authenticated user.
- **Version bump**: `VERSION`, `frontend/package.json`, and `backend/Cargo.toml` all now read **0.24.0**.
- **Validation**: 1,165 / 1,165 Vitest tests pass; backend `cargo check --all-targets` clean; TypeScript strict mode clean.

---

# What's New in v0.23.1

> **Maintenance release — zero user-facing changes.** v0.23.1 closes out the final front-end complexity item and retires the compliance tracker that has guided the last six waves of work.

---

## 🧱 `AdminSettings.tsx` is no longer a monolith

The Admin Settings page used to live in a single **8,402-line** React file. That file has been broken up into one module per tab under `frontend/src/pages/admin/`:

| Tab                                                                                                                              | Module                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Health · Display · Network · SSO · Kerberos · Recordings · Vault · Access · Tags · AD Sync · Password Mgmt · Sessions · Security | one file each under `frontend/src/pages/admin/` |
| Connection-form helpers (`Section`, `FieldGrid`, `RdpSections`, `SshSections`, `VncSections`)                                    | `admin/connectionForm.tsx`                      |
| Shared RDP keyboard layouts                                                                                                      | `admin/rdpKeyboardLayouts.ts`                   |

`AdminSettings.tsx` itself is now a **258-line** dispatcher that loads settings once and renders the currently-selected tab. Net reduction across the admin surface: **−8,144 lines**. No behavioural changes; **1,162 / 1,162 frontend tests pass** and the backend suite is green.

### Why you care (even though nothing looks different)

- **Faster reviews**: each tab is now reviewed and tested in isolation.
- **Smaller edits**: touching the Vault tab no longer churns the whole file.
- **Lower recompile cost**: Vite HMR only reloads the affected tab.
- **Easier onboarding**: the admin surface is now self-documenting via its directory layout.

---

## 🗂️ Compliance tracker retired — 62 / 62 items closed

`docs/compliance-tracker.md` has been deleted. Every item across W0 – W5 is complete, and the artefacts that the tracker produced live on in their proper homes:

- **Seven ADRs** under `docs/adr/` (rate limiting, CSRF, feature flags, guacd model, JWT/refresh, Vault envelope, emergency bypass).
- **Five runbooks** under `docs/runbooks/` (disaster recovery, security incident, certificate rotation, vault operations, database operations).
- **Architecture baseline** captured in `docs/adrs/0001-architecture-baseline.md`.

Live references to the tracker (PR template, runbook index, ADR-0001) have been updated. Historical mentions in `CHANGELOG.md` and earlier `WHATSNEW.md` sections are preserved as point-in-time records.

---

## 🛠️ Under the hood

- No migrations, no config changes, no service restart semantics.
- Version bumped: `VERSION`, `frontend/package.json`, `backend/Cargo.toml` all now read **0.23.1**.
- Rust 1.95 / React 19 / TypeScript 6 toolchain from 0.23.0 is unchanged.

---

> **Compliance & operations release.** No feature-facing changes for end users — v0.22.0 closes out the data-retention and operational-documentation items from the compliance tracker so administrators and on-call engineers have runtime-configurable retention windows, concrete runbooks, and a documented design record.

---

## 🗑️ Recording retention now actually deletes

The scheduled recordings worker previously enforced `recordings_retention_days` only against **local files** in the recordings volume. Database rows and Azure Blob artefacts were left behind, so retention was partial and blob storage grew unbounded.

As of v0.22.0, every sync pass:

1. Selects every `recordings` row older than the configured window.
2. Deletes the underlying artefact — Azure blob via the Transit-sealed storage account key, or local file from the recordings volume.
3. Deletes the database row.

Each pass logs `purged_azure`, `purged_local`, and `deleted_rows` totals for auditability.

---

## 👤 User hard-delete window is now configurable

Soft-deleted users previously became unrecoverable after a **hardcoded 7 days**. That window was below many regulatory norms and could not be widened without a code change.

As of v0.22.0 the window defaults to **90 days** and is editable by an administrator in the Admin Settings → **Security** tab → **Data Retention** section. Valid range is **1 to 3650 days**. The setting (`user_hard_delete_days`) is applied by the background cleanup worker via parameter-bound `make_interval(days => $1)` — no SQL interpolation, no downtime to change.

> [!TIP]
> Shortening the window does not immediately delete existing soft-deleted users — it simply means the next worker pass will consider any row whose `deleted_at` is older than the new window.

---

## 📚 Architecture Decision Records — now written down

Five new ADRs capture decisions that were previously only in operator heads:

| ADR          | Topic                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| **ADR-0003** | Feature flags — why we kept boolean settings and when we'd promote to a real flag table |
| **ADR-0004** | guacd connection model, protocol-parameter allow-list, and trust boundaries             |
| **ADR-0005** | JWT + refresh-token TTLs, single-use refresh rotation, global-logout lever              |
| **ADR-0006** | Vault Transit envelope format (`vault:<base64>`), rotate + rewrap path                  |
| **ADR-0007** | Emergency approval bypass & scheduled-start checkouts — data model and audit invariants |

All live under `docs/adr/`.

---

## 📘 On-call runbooks — copy-pasteable, not prose

Five step-by-step runbooks were added under `docs/runbooks/`:

- **Disaster Recovery** — RTO ≤ 4h / RPO ≤ 24h, full restore sequence including Vault unseal and DNS cutover.
- **Security Incident Response** — SEV-1 containment in minutes, forensic SQL, remediation by incident class, post-incident cadence.
- **Certificate Rotation** — ACME and internal-CA paths side by side, with rollback.
- **Vault Operations** — unseal procedure, Transit key rotate + rewrap, and Shamir rekey for operator rotation.
- **Database Operations** — streaming-replica failover, compensating-migration pattern, and panic-boot recovery.

Each runbook follows a fixed template (Purpose → When to use → Prerequisites → Safety checks → Procedure → Verification → Rollback → Related).

---

## 🧭 Compliance tracker: Wave 5 closed

`docs/compliance-tracker.md` now shows **59 of 62** items done (up from 46). Every Wave 5 item — the three scheduled-job tasks, the feature-flags ADR, the four engineering ADRs, and the five runbooks — is ticked. The three remaining open items are deferred Wave 4 refactor tasks (`W4-4`, `W4-5`, `W4-6`) with no functional impact; they're tracked for a dedicated follow-up.

---

## 🛠️ Under the hood

- **Configurable retention windows** are bound via `make_interval(days => $1)` in every retention query path — no string concatenation of interval values anywhere.
- **No schema changes**, no migrations, no restart-required settings. Everything in this release is driven by existing `settings`-table keys or new static files.

---

# What's New in v0.20.2

> **v0.20.2 policy change**: Checkouts that go through an approver chain now **require a justification of at least 10 characters** (previously only Emergency Bypass required one). Approvers always see a written business reason before deciding. Self-approving users are unaffected — their comments remain optional.

---

# What's New in v0.20.1

> **v0.20.1 safeguard**: Emergency Approval Bypass checkouts are now hard-capped at **30 minutes**, regardless of the duration submitted. The duration input caps to 30 automatically when the ⚡ Emergency Bypass checkbox is ticked, and the backend enforces the same ceiling server-side. This tightens the exposure window for credentials released without approver review.

---

## 🕒 Schedule a Future Password Release

You can now request a password checkout that releases at a future moment instead of right now — perfect for change windows, planned maintenance, or passing a privileged credential to a colleague for a scheduled task.

### How to use it

1. Open the **Credentials** tab and start a new checkout request for a managed account.
2. Tick **"Schedule release for a future time"**.
3. Pick a date and time between **1 minute from now** and **14 days** in the future.
4. Submit. The checkout sits in the new **Scheduled** state — no password exists yet — and the Credentials card shows "🕒 Release scheduled for …".
5. When the scheduled time arrives, the backend automatically generates the password, resets it in Active Directory, and seals it in Vault. The checkout card flips to **Active** and you can reveal it exactly as usual.

> [!TIP]
> Scheduled checkouts count toward the "one open request per account" guard, so you cannot accidentally queue two overlapping releases.

---

## ⚡ Emergency Approval Bypass (Break-Glass)

When a production incident needs a privileged credential _right now_ and the approver chain is unavailable, admins can let users self-release with a mandatory written justification.

### How it works

- An administrator enables **"Emergency Approval Bypass (Break-Glass)"** inside an **AD Sync → Password Management** configuration.
- When the option is on, approval-required users see an **⚡ Emergency Bypass** checkbox on the checkout form.
- Enabling bypass requires a justification of at least **10 characters**, is **capped at 30 minutes** (the duration input is limited and any longer value submitted is clamped server-side), and skips the approver chain — the checkout activates immediately, just like a self-approved request.
- Every emergency checkout is flagged, badged with **⚡ Emergency** across the Credentials and Approvals views, and recorded in the audit log as `checkout.emergency_bypass` so the event can be reviewed after the fact.

> [!IMPORTANT]
> Break-glass is hidden on the form when you're scheduling a future release — the two options are mutually exclusive. Emergency = immediate, Scheduled = future.

---

## 🛠️ Additional Technical Updates

- **Migration 051**: Adds `pm_allow_emergency_bypass` to AD sync configs and `emergency_bypass` to checkout requests.
- **Migration 052**: Adds `scheduled_start_at` to checkout requests and introduces the `Scheduled` state (full state set: Pending, Approved, Scheduled, Active, Expired, Denied, CheckedIn). Partial index on `scheduled_start_at` keeps the worker's due-scan fast.
- **Single Expiration Worker**: The existing 60-second checkout worker now also activates due scheduled checkouts — no extra background processes.

---

_For a full technical list of changes, please refer to the [CHANGELOG.md](file:///c:/GitRepos/strata-client/CHANGELOG.md)._
