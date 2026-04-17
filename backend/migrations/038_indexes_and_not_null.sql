-- Migration 038: Add missing indexes and tighten constraints.

-- Index for soft-deleted user lookups (admin restore UI).
CREATE INDEX IF NOT EXISTS idx_users_deleted_at
    ON users (deleted_at) WHERE deleted_at IS NOT NULL;

-- Composite index for the hot path in connection access checks.
CREATE INDEX IF NOT EXISTS idx_user_connection_access_conn_user
    ON user_connection_access (connection_id, user_id);

-- Ensure connection share links always have an expiry.
-- Backfill existing NULL rows with 24 hours from now before adding constraint.
UPDATE connection_shares
   SET expires_at = NOW() + INTERVAL '24 hours'
 WHERE expires_at IS NULL;

ALTER TABLE connection_shares
    ALTER COLUMN expires_at SET NOT NULL;
