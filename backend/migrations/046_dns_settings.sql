-- Configurable DNS servers used by the backend to resolve connection hostnames
-- before passing them to guacd.  When dns_enabled is 'true' and at least one
-- server is configured, the backend resolves the connection hostname itself
-- (using the listed nameservers) and sends the resolved IP to guacd.
INSERT INTO system_settings (key, value) VALUES
    ('dns_enabled',   'false'),
    ('dns_servers',   '')
ON CONFLICT (key) DO NOTHING;
