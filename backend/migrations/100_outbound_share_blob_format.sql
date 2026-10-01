-- Encrypted format of an outbound share's staged blob (PERF-03).
-- 1: one AES-256-GCM message, nonce in `sealed_dek_nonce`.
-- 2: chunked stream (services/file_crypto.rs), nonce prefix in the file.
ALTER TABLE outbound_shares
    ADD COLUMN IF NOT EXISTS blob_format SMALLINT NOT NULL DEFAULT 1
        CHECK (blob_format IN (1, 2));
