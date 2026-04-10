-- Add a JSONB column to ad_sync_configs that stores default Guacamole
-- parameters applied to every connection created/updated by this sync source.
-- These map directly to allowed guacd parameters (e.g. "ignore-cert",
-- "enable-wallpaper", "recording-path", etc.).
ALTER TABLE ad_sync_configs
    ADD COLUMN IF NOT EXISTS connection_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;
