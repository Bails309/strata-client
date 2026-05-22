-- Per-user last successful authentication timestamp.
--
-- Populated by the local and SSO login handlers on every successful
-- authentication.  Surfaced in the Users admin blade and consumed by the
-- background `user_cleanup` worker for the optional stale-account
-- auto-soft-delete sweep (see `user_stale_days` system setting).
--
-- NULL means the user has never logged in.  The stale-account sweep
-- explicitly skips NULL rows so accounts that have only ever been
-- provisioned (e.g. fresh AD-sync imports that have not yet signed in)
-- are not aged out solely on the basis of when they were created.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Optional stale-account sweep threshold (days).  A value of 0 disables
-- the sweep entirely; positive values cause the existing daily
-- user_cleanup worker to soft-delete any live user whose `last_login_at`
-- is older than now() - INTERVAL '<value> days'.  Users with NULL
-- last_login_at are never touched by this sweep.
INSERT INTO system_settings (key, value) VALUES
    ('user_stale_days', '0')
ON CONFLICT (key) DO NOTHING;
