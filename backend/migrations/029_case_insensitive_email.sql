-- Migration 029: Case-insensitive email and username matching
-- Normalizes existing emails/usernames to lowercase and replaces the
-- case-sensitive unique constraints with case-insensitive unique indexes.

-- Normalize existing data to lowercase
UPDATE users SET email    = LOWER(email);
UPDATE users SET username = LOWER(username);

-- Drop old case-sensitive unique constraints and indexes
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
DROP INDEX IF EXISTS idx_users_email;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;

-- Create case-insensitive unique indexes
CREATE UNIQUE INDEX idx_users_email_ci    ON users (LOWER(email))    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_users_username_ci ON users (LOWER(username)) WHERE deleted_at IS NULL;
