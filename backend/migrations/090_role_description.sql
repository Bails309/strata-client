-- Free-text purpose of a role, shown in the admin role editor.
-- Empty rather than NULL so the API always returns a string.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
