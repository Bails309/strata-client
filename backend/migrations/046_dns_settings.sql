-- Configurable DNS servers and search domains used by guacd containers to
-- resolve internal hostnames.  When dns_enabled is 'true', the backend writes
-- a resolv.conf with the configured nameservers and search domains to a shared
-- volume that guacd reads on startup.
INSERT INTO system_settings (key, value) VALUES
    ('dns_enabled',        'false'),
    ('dns_servers',        ''),
    ('dns_search_domains', '')
ON CONFLICT (key) DO NOTHING;
