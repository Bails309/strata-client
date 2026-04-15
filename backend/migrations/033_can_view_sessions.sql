-- Add can_view_sessions permission to roles
ALTER TABLE roles ADD COLUMN can_view_sessions BOOLEAN NOT NULL DEFAULT FALSE;
