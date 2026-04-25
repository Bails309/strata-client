# Rustguac Parity — Implementation Tracker

Tracks the work to bring [rustguac](https://github.com/sol1/rustguac)-style
**Web Browser Sessions** and **VDI Desktop Containers** into Strata.

This document is the working tracker. Strategic intent and admin-visible
status live on the roadmap:

- Roadmap (markdown): [docs/roadmap.md](../roadmap.md) — section *Protocols
  & Session Types*
- Roadmap (admin UI): Documentation → Roadmap → *Protocols & Session Types*
- Roadmap item IDs (used for status overrides in `system_settings.roadmap_statuses`):
  - `protocols-web-sessions`
  - `protocols-vdi-containers`

**Target release:** v0.30.0 (per the release procedure in
[`docs/runbooks/`](.) — VERSION, Cargo.toml, package.json + lock,
README, CHANGELOG, WHATSNEW, RELEASE_CARDS, roadmap prune on minor).

---

## Phase checklist

Tick items as PRs land. Keep this file in sync with the in-app todo list.

### Phase 1 — Schema + type plumbing (additive, no UX change)

- [ ] Migration `057_session_types_web_vdi.sql` (verify next sequential number
  before committing)
  - [ ] `connections.protocol` CHECK constraint widened to include `web`, `vdi`
  - [ ] Nullable columns added to `connections`:
    - `url TEXT`
    - `allowed_domains TEXT[]`
    - `login_script TEXT`
    - `autofill JSONB`
    - `container_image TEXT`
    - `cpu_limit NUMERIC`
    - `memory_limit_mb INT`
    - `idle_timeout_mins INT`
    - `env_vars JSONB`
    - `persistent_home BOOL`
  - [ ] New table `vdi_containers` (`session_id` PK, `connection_id`,
        `container_id`, `container_name`, `started_at`, `last_seen_at`, `state`)
- [ ] `backend/src/services/connections.rs`
  - [ ] Extend `Connection`, `NewConnection`, `UpdateConnection` with the new
        optional fields
  - [ ] Update `SELECT_COLUMNS` (line 12) and INSERT/UPDATE binds
- [ ] `backend/src/tunnel.rs`
  - [ ] New branches in `HandshakeParams` for `web` and `vdi`
  - [ ] Extend the protocol allow-list comment block (~line 204)
- [ ] `frontend/src/api.ts`
  - [ ] Extend `ConnectionPayload` / `NewConnection` types with the new
        optional fields
  - [ ] Extend the protocol union: `"rdp" | "vnc" | "ssh" | "web" | "vdi"`

### Phase 2 — Web Browser Sessions

Backend:

- [ ] `backend/src/services/web_session.rs`
  - [ ] Display allocator (BitSet over `:100`–`:199`)
  - [ ] Spawn Xvnc + Chromium kiosk; ephemeral profile under
        `/tmp/strata-chromium-{uuid}`
  - [ ] Optional autofill: write Chromium Login Data SQLite using
        AES-128-CBC, PBKDF2(`peanuts`/`saltysalt`), v10 prefix
        (crates: `rusqlite`, `aes`, `pbkdf2`)
  - [ ] Domain allow-list via Chromium `--host-rules` from `allowed_domains`
  - [ ] Egress CIDR check from new system setting `web_allowed_networks`
  - [ ] Login automation runner over Chrome DevTools Protocol on per-session
        ports `9200`–`9299`, 120 s timeout
- [ ] Managed Chromium policy file shipped in backend `Dockerfile`
- [ ] Concurrency cap: `max_web_sessions` in `system_settings`

Frontend:

- [ ] New `frontend/src/pages/admin/WebSections.tsx`
  - [ ] URL input
  - [ ] Allowed-domains chip input
  - [ ] Autofill credential builder (username, password, target host)
  - [ ] Login-script picker (dropdown of registered scripts)
  - [ ] Display-only `web_allowed_networks` summary
- [ ] Wire into `frontend/src/pages/admin/AccessTab.tsx`
  - [ ] Add `web` to protocol `<select>` (~line 913) + ports lookup (~line 916)
  - [ ] New conditional sub-section block (~line 995):
        `{formCore.protocol === "web" && <WebSections … />}`
- [ ] Guard `frontend/src/pages/admin/AdSyncTab.tsx` to `rdp|ssh|vnc` only
- [ ] Icons
  - [ ] `frontend/src/components/CommandPalette.tsx` `ProtocolIcon` — globe SVG
  - [ ] `frontend/src/pages/ActiveSessions.tsx` `protocolIcon` helper — globe
- [ ] Tests
  - [ ] Extend `frontend/src/__tests__/ActiveSessions.test.tsx` "renders ssh
        and vnc protocol badges" to include `web`
  - [ ] Backend unit test for the autofill DB writer (round-trip via
        decrypted read)

### Phase 3 — VDI Desktop Containers

Backend:

- [ ] `backend/src/services/vdi.rs`
  - [ ] `VdiDriver` trait
  - [ ] `DockerVdiDriver` implementation via `bollard`
  - [ ] `ensure_container` reuse-by-name pattern
  - [ ] Persistent home via bind mount under configurable `home_base`
  - [ ] Image whitelist (config + `system_settings`)
  - [ ] Env injection: `VDI_USERNAME`, `VDI_PASSWORD`
  - [ ] Idle reaper extension to `backend/src/services/session_cleanup.rs`
  - [ ] Logout vs tab-close differentiation from xrdp disconnect reason
- [ ] New route `GET /api/admin/vdi/images` returning whitelisted images
- [ ] `contrib/vdi-sample/Dockerfile` — sample image (xrdp on 3389)
- [ ] `docker-compose.yml` — opt-in mount of `/var/run/docker.sock` with
      explicit comment warning that this grants host root
- [ ] Concurrency cap: `max_vdi_containers` in `system_settings`

Frontend:

- [ ] New `frontend/src/pages/admin/VdiSections.tsx`
  - [ ] Image dropdown (fetched from `GET /api/admin/vdi/images`)
  - [ ] CPU limit + memory limit inputs
  - [ ] `idle_timeout_mins` input
  - [ ] Env-var key/value editor
  - [ ] Persistent-home toggle
- [ ] Wire into `AccessTab.tsx` (protocol select + sub-section block, port
      default `3389`)
- [ ] Audit `frontend/src/pages/SessionClient.tsx` (line 192, line 1193) —
      treat `vdi` as `rdp` for branching (clipboard, recording, etc.)
- [ ] Icons
  - [ ] `CommandPalette.tsx` — container SVG
  - [ ] `ActiveSessions.tsx` — container SVG
- [ ] Tests
  - [ ] Extend protocol-badge test for `vdi`
  - [ ] Backend integration test for `ensure_container` reuse

### Phase 4 — UX / Docs / Security

- [ ] `docs/web-sessions.md` — new (mirror rustguac's `web-sessions.md`)
- [ ] `docs/vdi.md` — new (mirror rustguac's `vdi.md`)
- [ ] Update `docs/architecture.md` diagram to include Xvnc + Chromium and
      the Docker driver path
- [ ] Update `docs/security.md` threat model:
  - [ ] `docker.sock` = host root (opt-in; sidecar recommendation)
  - [ ] Web profile is ephemeral, autofill secrets cleared on session end
  - [ ] SSRF guard via `web_allowed_networks`
- [ ] Audit events
  - [ ] `web.session.start` / `web.session.end`
  - [ ] `web.autofill.write`
  - [ ] `vdi.container.ensure` / `vdi.container.destroy`
- [ ] README features list
- [ ] CHANGELOG entry
- [ ] WHATSNEW card
- [ ] RELEASE_CARDS entry
- [ ] Bump version → `v0.30.0` (VERSION, `backend/Cargo.toml`, Cargo.lock,
      `frontend/package.json`, frontend lockfile, README badges)
- [ ] After release: flip both roadmap items to **Shipped** in the admin UI
- [ ] On next minor (`v0.31.0`) cut: prune the two roadmap entries from
      `docs/roadmap.md` and clear matching `system_settings.roadmap_statuses`

---

## Open risks / decisions

1. **`docker.sock` = host root.** v1 mounts the socket directly behind an
   opt-in compose profile. Production guidance recommends a privileged
   sidecar exposing a narrow gRPC API; track as a follow-up.
2. **Concurrency caps.** `max_web_sessions` and `max_vdi_containers` need
   sensible defaults and per-tenant overrides.
3. **xrdp self-signed certs.** Set `ignore-cert=true` scoped to the docker
   network only; do not leak the flag to user-configured RDP connections.
4. **Multi-replica backends.** A shared `VdiDriver` (Nomad / Proxmox /
   K8s) is **out of scope for v1**. Document the single-replica
   constraint when VDI is enabled.
5. **Recording.** Both new types appear to guacd as standard VNC / RDP, so
   the existing recording pipeline works unchanged. Confirm with an
   end-to-end test before release.

---

## Merge order

`Phase 1` → `Phase 2 (Web)` → `Phase 3 (VDI)` → `Phase 4 (docs/security)`.

Web ships before VDI: lower blast radius, no host-root requirement, and it
exercises the new schema + form plumbing without touching the Docker
attack surface.
