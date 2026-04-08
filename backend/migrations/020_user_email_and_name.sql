-- Migration 020: Add email and full_name to users table
-- This allows for strict SSO matching and local user management with random passwords.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'local';

-- Populate email for existing users using their username as a fallback
UPDATE users SET email = username WHERE email IS NULL;

-- Make email NOT NULL now that it's populated
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

-- Add index for faster lookups by email
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
