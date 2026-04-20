-- ════════════════════════════════════════════════════════════════════════
-- 041: Password Management (Account Password Blade)
-- ════════════════════════════════════════════════════════════════════════

-- ── A. Expand ad_sync_configs with password-management columns ─────────

ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_bind_user TEXT;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_bind_password TEXT;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_target_filter TEXT NOT NULL DEFAULT '(&(objectCategory=person)(objectClass=user))';

ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_pwd_min_length INTEGER NOT NULL DEFAULT 16;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_pwd_require_uppercase BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_pwd_require_lowercase BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_pwd_require_numbers BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_pwd_require_symbols BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_auto_rotate_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_auto_rotate_interval_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE ad_sync_configs ADD COLUMN IF NOT EXISTS pm_last_rotated_at TIMESTAMPTZ;

-- ── B. Approval Roles ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_roles (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Map Strata users → approval roles (many-to-many)
CREATE TABLE IF NOT EXISTS approval_role_assignments (
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id  UUID NOT NULL REFERENCES approval_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- Map approval roles → AD target scopes they can approve
CREATE TABLE IF NOT EXISTS approval_group_mappings (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_id     UUID NOT NULL REFERENCES approval_roles(id) ON DELETE CASCADE,
    ad_target_filter TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_group_mappings_role ON approval_group_mappings(role_id);

-- ── C. User-to-managed-account mappings ────────────────────────────────

CREATE TABLE IF NOT EXISTS user_account_mappings (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    managed_ad_dn    TEXT NOT NULL,
    can_self_approve BOOLEAN NOT NULL DEFAULT false,
    ad_sync_config_id UUID REFERENCES ad_sync_configs(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_account_mappings_user ON user_account_mappings(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_account_mappings_unique
    ON user_account_mappings(user_id, managed_ad_dn);

-- ── D. Password checkout requests ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS password_checkout_requests (
    id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    requester_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    managed_ad_dn          TEXT NOT NULL,
    ad_sync_config_id      UUID REFERENCES ad_sync_configs(id) ON DELETE SET NULL,
    status                 TEXT NOT NULL DEFAULT 'Pending'
                           CHECK (status IN ('Pending', 'Approved', 'Active', 'Expired', 'Denied')),
    requested_duration_mins INTEGER NOT NULL CHECK (requested_duration_mins > 0 AND requested_duration_mins <= 720),
    approved_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    justification_comment  TEXT NOT NULL,
    expires_at             TIMESTAMPTZ,
    vault_credential_id    UUID,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkout_requests_requester ON password_checkout_requests(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_checkout_requests_status ON password_checkout_requests(status);
CREATE INDEX IF NOT EXISTS idx_checkout_requests_expires ON password_checkout_requests(expires_at)
    WHERE status = 'Active';
