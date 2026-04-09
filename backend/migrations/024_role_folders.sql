-- ── Role-Folder Assignment ───────────────────────────────────────────

-- Create table for mapping roles to folders
CREATE TABLE role_folders (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    folder_id UUID NOT NULL REFERENCES connection_folders(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, folder_id)
);

-- Add index for performance on role checks
CREATE INDEX idx_role_folders_role ON role_folders(role_id);
CREATE INDEX idx_role_folders_folder ON role_folders(folder_id);

-- Ensure we have a similar index for role_connections if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_role_connections_role ON role_connections(role_id);
CREATE INDEX IF NOT EXISTS idx_role_connections_connection ON role_connections(connection_id);
