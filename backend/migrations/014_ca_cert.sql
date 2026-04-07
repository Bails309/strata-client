-- Add optional CA certificate (PEM) for LDAPS with self-signed / internal CAs
ALTER TABLE ad_sync_configs ADD COLUMN ca_cert_pem TEXT;
