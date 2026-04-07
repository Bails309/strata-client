-- Add password_hash column for local accounts
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Allow sub to be NULL for local accounts (already nullable)
