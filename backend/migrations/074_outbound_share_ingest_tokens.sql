-- 074_outbound_share_ingest_tokens.sql
--
-- One-shot in-session ingest tokens for the outbound Quick-Share
-- pipeline. An authenticated user mints a token from the SPA, the
-- token is rendered into a `curl` / `Invoke-WebRequest` snippet that
-- the user pastes inside the remote session. The remote session
-- POSTs the file at `/api/outbound-shares/ingest/{token}` (no cookie,
-- no CSRF — the token IS the auth) and the file is fed into the
-- existing outbound-shares submit() pipeline as if the user had
-- uploaded it directly.
--
-- The token captures the same context the user provided at mint
-- time (which session + connection + justification), so the audit
-- chain stays intact across the network hop. Tokens are short-lived
-- (10-minute TTL) and single-use; expired rows are reaped by the
-- existing daily cleanup worker.

CREATE TABLE IF NOT EXISTS outbound_share_ingest_tokens (
    token         TEXT        PRIMARY KEY,
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id    TEXT        NULL,
    connection_id UUID        NULL REFERENCES connections(id) ON DELETE SET NULL,
    justification TEXT        NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_ip    TEXT        NULL,
    used_at       TIMESTAMPTZ NULL,
    used_ip       TEXT        NULL
);

CREATE INDEX IF NOT EXISTS outbound_share_ingest_tokens_expires_at_idx
    ON outbound_share_ingest_tokens (expires_at);

CREATE INDEX IF NOT EXISTS outbound_share_ingest_tokens_user_id_idx
    ON outbound_share_ingest_tokens (user_id);
