-- Connection groups (folder-like structure for organizing connections)
CREATE TABLE connection_groups (
    id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name      TEXT NOT NULL,
    parent_id UUID REFERENCES connection_groups(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name, parent_id)
);

-- Allow top-level groups with duplicate-safe unique constraint
CREATE UNIQUE INDEX idx_connection_groups_root_name
    ON connection_groups (name) WHERE parent_id IS NULL;

-- Add description and optional group assignment to connections
ALTER TABLE connections ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE connections ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES connection_groups(id) ON DELETE SET NULL;

CREATE INDEX idx_connections_group ON connections (group_id);
CREATE INDEX idx_connection_groups_parent ON connection_groups (parent_id);
