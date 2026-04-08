-- 017: Add missing indexes and DB constraints for performance and integrity
-- This migration addresses issues found during code review.

-- ── Foreign key indexes (prevent full-table scans on JOINs / WHERE) ──

CREATE INDEX IF NOT EXISTS idx_connection_shares_owner_user
    ON connection_shares (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_connection_shares_connection
    ON connection_shares (connection_id);

CREATE INDEX IF NOT EXISTS idx_credential_mappings_credential
    ON credential_mappings (credential_id);

CREATE INDEX IF NOT EXISTS idx_role_connections_connection
    ON role_connections (connection_id);

CREATE INDEX IF NOT EXISTS idx_user_favorites_connection
    ON user_favorites (connection_id);

-- ── Query-pattern indexes ──

-- TTL cleanup queries: SELECT … WHERE expires_at < now()
CREATE INDEX IF NOT EXISTS idx_credential_profiles_expires_at
    ON credential_profiles (expires_at);

-- AD sync scheduler: SELECT … WHERE enabled = true
CREATE INDEX IF NOT EXISTS idx_ad_sync_configs_enabled
    ON ad_sync_configs (enabled) WHERE enabled = true;

-- Connection listing sorted by creation
CREATE INDEX IF NOT EXISTS idx_connections_created_at
    ON connections (created_at DESC);

-- ── Integrity constraints ──

-- Ensure at most one Kerberos realm can be the default.
-- PostgreSQL UNIQUE index WHERE condition enforces this at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_kerberos_realms_single_default
    ON kerberos_realms (is_default) WHERE is_default = true;

-- Ensure OIDC subject uniqueness only for non-NULL values.
-- (Multiple local accounts can have sub = NULL, but two OIDC accounts
-- must never map to the same external subject.)
-- Drop the existing column-level UNIQUE first if it exists.
DO $$
BEGIN
    -- Check if the old unique constraint exists and drop it
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_sub_key' AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users DROP CONSTRAINT users_sub_key;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sub_oidc
    ON users (sub) WHERE sub IS NOT NULL;
