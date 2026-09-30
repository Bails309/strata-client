-- SEC-08: tokens issued before this instant are no longer valid for the user.
-- Set on password change/reset and deletion; NULL means no cutoff.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_after TIMESTAMPTZ;
