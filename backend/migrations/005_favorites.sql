-- User favorite connections
CREATE TABLE user_favorites (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, connection_id)
);

CREATE INDEX idx_user_favorites_user ON user_favorites (user_id);
