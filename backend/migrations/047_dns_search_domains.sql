-- Backfill dns_search_domains for instances that already ran 046 before
-- the search domains field was added.
INSERT INTO system_settings (key, value) VALUES
    ('dns_search_domains', '')
ON CONFLICT (key) DO NOTHING;
