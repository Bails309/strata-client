-- Migration 015: Support multiple search bases (OU scopes) per AD sync config
ALTER TABLE ad_sync_configs ADD COLUMN search_bases TEXT[] NOT NULL DEFAULT '{}';
UPDATE ad_sync_configs SET search_bases = ARRAY[search_base] WHERE search_base IS NOT NULL AND search_base != '';
ALTER TABLE ad_sync_configs DROP COLUMN search_base;
