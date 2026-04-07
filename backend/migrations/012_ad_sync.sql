-- ╔═══════════════════════════════════════════════════════════════════╗
-- ║  Strata Client – Active Directory Sync                           ║
-- ╚═══════════════════════════════════════════════════════════════════╝
-- Supports importing computer objects from one or more AD domains via
-- LDAP, creating connections automatically, and soft-deleting any that
-- disappear from subsequent syncs (with 7-day grace before hard-delete).

-- ── AD Sync Source Configs ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_sync_configs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    label           TEXT NOT NULL,
    ldap_url        TEXT NOT NULL,                -- e.g. ldaps://dc1.contoso.com:636
    bind_dn         TEXT NOT NULL DEFAULT '',      -- e.g. CN=svc-strata,OU=Service Accounts,DC=contoso,DC=com
    bind_password   TEXT NOT NULL DEFAULT '',      -- stored encrypted in practice; plain for MVP
    search_base     TEXT NOT NULL,                -- e.g. OU=Servers,DC=contoso,DC=com
    search_filter   TEXT NOT NULL DEFAULT '(objectClass=computer)',
    search_scope    TEXT NOT NULL DEFAULT 'subtree' CHECK (search_scope IN ('base','onelevel','subtree')),
    protocol        TEXT NOT NULL DEFAULT 'rdp' CHECK (protocol IN ('rdp','ssh','vnc')),
    default_port    INT  NOT NULL DEFAULT 3389,
    domain_override TEXT,                         -- optionally force this domain on created connections
    group_id        UUID REFERENCES connection_groups(id) ON DELETE SET NULL,
    tls_skip_verify BOOLEAN NOT NULL DEFAULT false,
    sync_interval_minutes INT NOT NULL DEFAULT 60 CHECK (sync_interval_minutes >= 5),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Track AD-sourced connections ─────────────────────────────────────
-- Links a connection back to the AD config + DN that created it.
-- Also carries the soft-delete lifecycle columns.
ALTER TABLE connections
    ADD COLUMN IF NOT EXISTS ad_source_id UUID REFERENCES ad_sync_configs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS ad_dn        TEXT,
    ADD COLUMN IF NOT EXISTS soft_deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_connections_ad_source ON connections (ad_source_id);
CREATE INDEX IF NOT EXISTS idx_connections_soft_deleted ON connections (soft_deleted_at) WHERE soft_deleted_at IS NOT NULL;

-- ── Sync Run History ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_sync_runs (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    config_id     UUID NOT NULL REFERENCES ad_sync_configs(id) ON DELETE CASCADE,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error')),
    created       INT NOT NULL DEFAULT 0,
    updated       INT NOT NULL DEFAULT 0,
    soft_deleted  INT NOT NULL DEFAULT 0,
    hard_deleted  INT NOT NULL DEFAULT 0,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_ad_sync_runs_config ON ad_sync_runs (config_id, started_at DESC);

-- ── System settings for global AD sync enable ────────────────────────
INSERT INTO system_settings (key, value, updated_at)
VALUES ('ad_sync_enabled', 'false', now())
ON CONFLICT (key) DO NOTHING;
