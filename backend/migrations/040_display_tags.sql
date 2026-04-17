-- Per-user "display tag" for a connection.
-- Each user can pin at most ONE tag per connection to show in the active sessions sidebar.
CREATE TABLE user_connection_display_tags (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    tag_id        UUID NOT NULL REFERENCES user_tags(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, connection_id)
);
