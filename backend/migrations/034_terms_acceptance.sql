-- Track when a user accepted the terms / recording disclaimer
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
-- Which version of the terms they accepted (bump to force re-acceptance)
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_version INT;
