-- 019: Add unique index for AD-sourced connections
-- Enables high-performance bulk upserts (ON CONFLICT) and prevents
-- duplicate syncing if search bases overlap.

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_ad_source_dn
    ON connections (ad_source_id, ad_dn)
    WHERE ad_source_id IS NOT NULL AND ad_dn IS NOT NULL;
