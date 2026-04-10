-- Per-user last-accessed tracking.
-- The connections.last_accessed column was global (any user's access updated
-- the same timestamp).  This table tracks per-user access so that
-- "My Connections" shows recent connections based on the logged-in user's
-- own activity.

CREATE TABLE IF NOT EXISTS user_connection_access (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    last_accessed TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, connection_id)
);

-- Seed the new table from the existing global timestamp so that admins
-- don't lose their existing "recent" data.  We assign the global
-- last_accessed to every user who currently has access to the connection.
INSERT INTO user_connection_access (user_id, connection_id, last_accessed)
SELECT u.id, c.id, c.last_accessed
FROM connections c
CROSS JOIN users u
WHERE c.last_accessed IS NOT NULL
  AND c.soft_deleted_at IS NULL
  AND (
      u.role_id IS NULL  -- admins (no role restriction)
      OR EXISTS (SELECT 1 FROM role_connections rc WHERE rc.role_id = u.role_id AND rc.connection_id = c.id)
      OR EXISTS (SELECT 1 FROM role_folders rf WHERE rf.role_id = u.role_id AND rf.folder_id = c.folder_id)
  )
ON CONFLICT DO NOTHING;
