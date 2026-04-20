-- ════════════════════════════════════════════════════════════════════════
-- 045: Replace LDAP-filter-based approval scope with explicit account list
-- ════════════════════════════════════════════════════════════════════════

-- New table: map approval roles → specific managed AD accounts
CREATE TABLE IF NOT EXISTS approval_role_accounts (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_id     UUID NOT NULL REFERENCES approval_roles(id) ON DELETE CASCADE,
    managed_ad_dn TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_role_accounts_role ON approval_role_accounts(role_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_role_accounts_unique
    ON approval_role_accounts(role_id, managed_ad_dn);

-- Migrate any existing filter data is not feasible (filters ≠ DNs), so we just
-- drop the old table after creating the new one.
DROP TABLE IF EXISTS approval_group_mappings;
