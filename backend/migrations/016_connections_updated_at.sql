-- Migration 016: Add updated_at column to connections table (needed by AD sync updates)
ALTER TABLE connections ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
