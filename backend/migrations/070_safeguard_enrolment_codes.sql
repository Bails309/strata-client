-- ── Safeguard sign-in: one-shot enrolment codes ─────────────────────
-- v1.10.2 lets the per-user Safeguard sign-in card auto-deliver the
-- Safeguard API token back to Strata instead of forcing the operator
-- to copy the JWT out of PowerShell and paste it into the UI.
--
-- The flow is bridged by a short-lived enrolment code minted by
-- Strata when the user clicks Sign in. The code is single-use, scoped
-- to the user_id that requested it, and expires in 5 minutes. The
-- PowerShell snippet rendered in the UI carries the code; the snippet
-- POSTs the resulting $SGToken to /api/safeguard/enrol, the backend
-- validates the code, seals the token via the existing Vault envelope
-- path, writes to safeguard_user_tokens (same as the manual paste
-- endpoint), and marks the code consumed so it can't be replayed.
--
-- Idempotent: re-runs cleanly thanks to IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS safeguard_enrolment_codes (
    code         TEXT PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_ip   TEXT
);

CREATE INDEX IF NOT EXISTS idx_safeguard_enrolment_codes_user
    ON safeguard_enrolment_codes(user_id);

CREATE INDEX IF NOT EXISTS idx_safeguard_enrolment_codes_expiry
    ON safeguard_enrolment_codes(expires_at);
