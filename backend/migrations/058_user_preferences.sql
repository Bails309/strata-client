-- 058_user_preferences.sql
--
-- Per-user UI preferences (keybindings, etc.). Stored as a single JSONB
-- blob keyed by user_id so we can add new preferences without further
-- migrations. Strictly additive — no existing rows are mutated.

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id     UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
