-- 057_session_types_web_vdi.sql
--
-- Foundation for the `web` and `vdi` connection protocols. Strictly
-- additive — admits two new protocol values and adds the runtime
-- tracking table for VDI containers. No existing rows are mutated.
--
--   * `web`  — ephemeral Chromium kiosk inside Xvnc, surfaced to guacd as
--              a standard VNC session. Phase 2.
--   * `vdi`  — on-demand Docker container running xrdp, surfaced to guacd
--              as a standard RDP session. Phase 3.
--
-- Per-protocol form fields (URL, allowed_domains, container_image,
-- cpu_limit, etc.) live in `connections.extra` JSONB alongside RDP/SSH/VNC
-- params — no new columns on `connections` are added here.

BEGIN;

-- (1) Widen the protocol CHECK constraint on the user-facing connections
--     table. Postgres requires drop+add for inline CHECKs.
ALTER TABLE connections
    DROP CONSTRAINT IF EXISTS connections_protocol_check;
ALTER TABLE connections
    ADD CONSTRAINT connections_protocol_check
    CHECK (protocol IN ('rdp', 'ssh', 'vnc', 'web', 'vdi'));

-- (2) Widen the matching constraint on AD-sync defaults. AD-sync itself
--     remains gated to rdp|ssh|vnc in the frontend (web and vdi are
--     interactive-create only) but the column-level constraint is widened
--     to keep the data model consistent if that policy ever changes.
ALTER TABLE ad_sync_configs
    DROP CONSTRAINT IF EXISTS ad_sync_configs_protocol_check;
ALTER TABLE ad_sync_configs
    ADD CONSTRAINT ad_sync_configs_protocol_check
    CHECK (protocol IN ('rdp', 'ssh', 'vnc', 'web', 'vdi'));

-- (3) Runtime tracking for VDI containers. A row is created when
--     `DockerVdiDriver::ensure_container` first provisions a container
--     for a (user, connection) tuple, and updated on each session start.
--     The idle reaper in `session_cleanup.rs` consults `last_seen_at` to
--     decide when a container can be stopped/destroyed.
--
--     `state` values: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'.
CREATE TABLE vdi_containers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    connection_id   UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    container_id    TEXT,                    -- Docker container ID; NULL while 'starting'
    container_name  TEXT NOT NULL,           -- deterministic, used for reuse-by-name
    image           TEXT NOT NULL,           -- resolved from the connection's allowed image
    state           TEXT NOT NULL DEFAULT 'starting'
                    CHECK (state IN ('starting','running','stopping','stopped','error')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at      TIMESTAMPTZ,
    last_error      TEXT,
    UNIQUE (connection_id, user_id)
);

CREATE INDEX idx_vdi_containers_state         ON vdi_containers (state);
CREATE INDEX idx_vdi_containers_last_seen_at  ON vdi_containers (last_seen_at);

COMMIT;
