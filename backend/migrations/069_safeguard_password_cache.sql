-- Safeguard password caching.
--
-- When the admin enables `password_cache_enabled`, a successful JIT
-- checkout has its plaintext password sealed and stored per
-- `(user_id, profile_id)` for the lifetime the admin requests
-- (`safeguard_config.default_checkout_hours`). Subsequent tunnel
-- opens for the same profile reuse the cached row WITHOUT a fresh
-- Safeguard API call — so users with long-running sessions do not
-- have to re-submit a 15-minute RSTS token every time they connect.
--
-- Auto-checkin is suppressed for cached requests: the Safeguard side
-- keeps the request open until its policy-driven expiry, mirroring
-- the user-credential TTL behaviour. The cached row is eagerly
-- deleted on read once `expires_at` has passed (see
-- `services::safeguard::password_cache::load`).

ALTER TABLE safeguard_config
    ADD COLUMN IF NOT EXISTS password_cache_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS safeguard_cached_passwords (
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id    UUID        NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
    ciphertext    BYTEA       NOT NULL,
    encrypted_dek BYTEA       NOT NULL,
    nonce         BYTEA       NOT NULL,
    username      TEXT,
    request_id    TEXT,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_safeguard_cached_pw_expires
    ON safeguard_cached_passwords(expires_at);
