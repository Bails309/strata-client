-- Add last_accessed timestamp to connections
ALTER TABLE connections ADD COLUMN last_accessed TIMESTAMPTZ;
