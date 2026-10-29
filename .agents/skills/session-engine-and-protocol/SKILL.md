---
name: session-engine-and-protocol
description: 'Develop, debug, and test the native Rust remote-session engine (crates/strata-session, crates/strata-protocol, backend/src/session_engine.rs, backend/src/tunnel.rs) and browser session/clipboard/display integration (frontend/src/components/SessionManager.tsx, SessionClient.tsx, clipboardSync.ts, pasteShortcutGate.ts). WHEN: working on RDP (ironrdp, EGFX H.264, CLIPRDR, keymaps, DPI), SSH (russh), VNC (vnc-rs), Web kiosk (Xvnc/Chromium), VDI, Kubernetes exec, SFTP file transfer, terminal rasteriser (alacritty_terminal/fontdue), Guacamole wire framing, or live session target tests. DO NOT USE FOR: standard CRUD REST APIs (use api-and-rbac-feature) or Helm/Compose-only edits (use container-and-dmz-infrastructure).'
---

# Native Session Engine and Protocol Workflow

Use this skill when modifying or debugging remote session protocols, wire codecs, terminal rendering, clipboard synchronisation, or session lifecycle across `crates/strata-session/`, `crates/strata-protocol/`, `backend/src/session_engine.rs`, `backend/src/tunnel.rs`, and `frontend/src/components/`. Follow [AGENTS.md](../../../AGENTS.md) (§6–§10, §15–§19, §23).

## 1. Discovery and Architecture Grounding

1. **Query Codebase Memory first** (`project: "C-GitRepos-strata-client"`):
   - Use `search_graph` and `trace_path` to inspect `ProtocolEngine` implementations (`crates/strata-session/src/engine/`), `SessionActor` (`crates/strata-session/src/actor/`), `RoutingPolicy` (`crates/strata-session/src/routing.rs`), `backend/src/session_engine.rs`, and `backend/src/tunnel.rs`.
   - If modifying shared enums like `InputEvent::Resize`, `TargetEvent`, or `DisconnectCause`, trace all match arms across `ssh`, `rdp`, `vnc`, `kubernetes`, `terminal`, and `crates/strata-session/tests/*_live.rs`.
   - Run `check_index_coverage` on candidate files before relying on graph completeness.
2. **Consult relevant documentation**:
   - Read only the applicable sections of [docs/adr/ADR-0015-native-rust-session-engine.md](../../../docs/adr/ADR-0015-native-rust-session-engine.md), [docs/architecture.md](../../../docs/architecture.md), [docs/h264-passthrough.md](../../../docs/h264-passthrough.md), [docs/web-sessions.md](../../../docs/web-sessions.md), [docs/vdi.md](../../../docs/vdi.md), and runbooks under [docs/runbooks/](../../../docs/runbooks/) (`clipboard-diagnostics.md`, `session-disconnects.md`, `keyboard-input.md`, `session-capacity.md`).

## 2. Crate & Zone Invariants

1. **Safety and documentation lints**:
   - `crates/strata-session/src/lib.rs` enforces `#![forbid(unsafe_code)]` and `#![warn(missing_docs)]`. Every public item requires rustdoc comments and zero `unsafe` blocks.
2. **DMZ trust boundary (`.github/workflows/dmz-deps.yml`)**:
   - `strata-session` runs strictly in the **trusted internal zone** inside `strata-backend`.
   - `crates/strata-dmz` **must never** depend on `strata-session`, `sqlx`, `vaultrs`, `ldap3`, `krb5`, or `guac*`.
   - `crates/strata-protocol` must keep its minimal Tokio feature set (`io-util`, `macros`, `rt`, `time`, `sync`) without pulling in `net`, `process`, or `fs`.
3. **Feature flags and routing**:
   - Protocol engines in `crates/strata-session` are opt-in features (`ssh`, `ssh-rsa`, `rdp`, `vnc`, `kubernetes`, `sftp`, `terminal`).
   - Any protocol change must keep `RoutingPolicy::compiled_protocols()` in `crates/strata-session/src/routing.rs` aligned so uncompiled protocols are refused cleanly (`SessionBackend::Refused`).

## 3. Protocol and Subsystem Invariants

1. **RDP (`crates/strata-session/src/engine/rdp/`)**:
   - **CredSSP / NLA fail-closed**: Always configure `enable_tls: false, enable_credssp: true`. Never enable legacy TLS fallback, which completes the RDP handshake before authentication and exposes an unauthenticated login screen.
   - **H.264 EGFX passthrough (`gfx.rs`)**: Advertise `V10.7` (to handle hosts with `AVC444ModePreferred=1`, forwarding `stream1` and skipping chroma-only auxiliary updates). `avc_to_annex_b` must detect existing 3/4-byte Annex B start codes before converting. In `frontend/src/lib/guacamole-vendor.js`, blit 1:1 cropped to `min(destination, frame)` — never scale the 16x16 macroblock-padded coded frame onto the destination rect. After resize, call `request_full_repaint()`.
   - **Keyboard & layout (`layouts.rs`, `keymaps/*.keymap`)**: Printable characters use target layout scancodes (blank `server-layout` defaults to `en-GB` / `0x0809`; Unicode `VK_PACKET` is fallback only because Windows Server Core PSReadLine drops `VK_PACKET`). Track pressed scancodes in `keys_down` so key-up releases the exact scancode pressed. Emit `SyncEvent(NUM_LOCK)` (`ironrdp_pdu::input::fast_path::SynchronizeFlags`) only when `keys_down` is empty.
   - **DPI scaling**: Delegate exclusively to `strata_session::engine::rdp::desktop_scale_from_dpi`.
   - **Pointer**: Keep `enable_server_pointer: true` and `pointer_software_rendering: true` on `ConnectorConfig` and `ActiveStage`.
2. **SSH, Kubernetes Exec, and Terminal Rasteriser (`engine/ssh/`, `engine/kubernetes.rs`, `terminal/`)**:
   - **Grid cell size invariant**: Always construct `SshConfig` and `KubeConfig` with `CellSize` derived from `TerminalFont::discover()?.metrics().into()` (see `backend/src/session_engine.rs::connect_target`). Never use `CellSize::default()` (8x16), which desynchronises the remote PTY dimensions from the rendered `alacritty_terminal` grid.
   - **Terminal damage & cursor**: Diff cell snapshots against the previous frame so idle cursor-line damage does not re-encode PNGs continuously, and repaint both old and new cursor cells on cursor move.
   - **Kubernetes exec (`v4.channel.k8s.io`)**: Prefix frames with the channel byte (`0` stdin, `1` stdout, `2` stderr, `3` error, `4` resize). Channel 4 resize JSON must use capitalised `{"Width":n,"Height":n}`. Never request `stderr=true` when `tty=true`.
3. **VNC and Web Kiosk (`engine/vnc.rs`, `backend/src/services/web_session.rs`)**:
   - **Pixel format**: Encode desktop framebuffers (`bpp 32, depth 24`) as `Rgb8` (4th byte is padding, not alpha) and `SetCursor` as `Rgba8`.
   - **Request-driven RFB loop**: Send `FullRefresh` on initial connect, then after `recv_event()` + `poll_event()` batch drain, emit exactly one `X11Event::Refresh` per batch (including cursor-only batches, or the session stalls permanently).
   - **Web sessions**: Enforce `web_allowed_networks` CIDR egress checks (fail-closed when empty) and run Chromium under non-root `strata` with `backend/seccomp-chromium.json`.
4. **SFTP (`engine/sftp.rs`)**:
   - Allocate **negative** stream indices for server-initiated SFTP streams so they never collide with client upload streams (`>= 0`).
   - Enforce canonical path containment with a trailing `/` check, and require a pinned host key.
5. **Clipboard and Browser Tunnel (`frontend/src/components/`)**:
   - Route all local-to-remote clipboard sends through `frontend/src/components/clipboardSync.ts` (serialised per-session promise chain) and `frontend/src/utils/pasteShortcutGate.ts` (holding `Ctrl+V` / `Shift+Insert` until `prepareRemotePaste()` settles).
   - Remember Guacamole length prefixes are **character** counts (UTF-16/codepoints), not byte counts.
   - `Guacamole.Client` has no public `isConnected()` method at runtime; check `session.tunnel.state !== 2` (`CLOSED`).
6. **Governance & Disconnect Parity (`backend/src/session_engine.rs`)**:
   - Native sessions must preserve NVR live observation, `.guac` raw instruction recording via `GuacRecordingSink` (dropping binary `0xAA` envelopes), revocation + 8h duration watchdog, and cause-specific Guacamole `error` status codes (`DisconnectCause` -> `guac_wire` -> `frontend/src/utils/sessionEnd.ts`), including sending `error` over the WebSocket before closing when initial target connection or admission fails.

## 4. Validation

Run the checks enforced by `.github/workflows/ci.yml` (`backend-check`, `session-live`, `frontend-check`):

1. **Formatting & Clippy (all features)**:
   ```sh
   cargo fmt -p strata-session -p strata-protocol -p strata-backend -- --check
   cargo clippy -p strata-session --all-features --all-targets -- -D warnings
   cargo clippy -p strata-protocol --all-targets -- -D warnings
   cargo clippy -p strata-backend --all-targets -- -D warnings
   ```
2. **Unit and fuzz target checks**:
   - Ensure `fonts-dejavu-core` is installed in the test container so `TerminalFont::discover` succeeds.
   ```sh
   cargo test -p strata-protocol
   cargo test -p strata-session --all-features --lib
   cargo check --manifest-path crates/strata-session/fuzz/Cargo.toml
   ```
3. **Live protocol target suite (`session-live`)**:
   - When modifying SSH, SFTP, RDP, or Kubernetes engines, run the live target suite against `docker-compose.session-test.yml`:
   ```sh
   docker compose -f docker-compose.session-test.yml up -d --build
   cargo test -p strata-session --all-features --test ssh_live --test sftp_live --test rdp_live --test kube_live -- --ignored
   docker compose -f docker-compose.session-test.yml down -v
   ```
   - In SSH live tests, avoid asserting on raw strings the shell echoes back; embed empty quotes (e.g., `echo KEY''SYM_OK`) so command output is distinct from input echo.
4. **Frontend session tests** (when touching `frontend/src/`):
   - Run `npx tsc --noEmit`, `npm run lint`, and `npm run test:coverage` in `frontend/`.
