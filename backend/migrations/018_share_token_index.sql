-- 018: Add unique index on connection_shares.share_token
-- The shared tunnel lookup (public, unauthenticated) queries by share_token.
-- Without an index this is a sequential scan on every request.

CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_shares_share_token
    ON connection_shares (share_token);
