ALTER TABLE approval_roles ADD COLUMN IF NOT EXISTS allow_emergency_bypass BOOLEAN NOT NULL DEFAULT true;
