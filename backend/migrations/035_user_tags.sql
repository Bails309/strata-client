-- User-scoped tags / labels for organising connections
CREATE TABLE user_tags (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#6366f1',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE INDEX idx_user_tags_user ON user_tags (user_id);

-- Many-to-many: connection ↔ user tag
CREATE TABLE user_connection_tags (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    tag_id        UUID NOT NULL REFERENCES user_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, connection_id, tag_id)
);

CREATE INDEX idx_user_connection_tags_user ON user_connection_tags (user_id);
