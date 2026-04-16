-- Admin-managed global tags that appear for all users
CREATE TABLE IF NOT EXISTS admin_tags (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#6366f1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Many-to-many: admin tag ↔ connection
CREATE TABLE IF NOT EXISTS admin_connection_tags (
    tag_id        UUID NOT NULL REFERENCES admin_tags(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, connection_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_connection_tags_conn ON admin_connection_tags (connection_id);
