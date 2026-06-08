-- 073: Quick-Share Outbound (Approval-Gated)
--
-- Adds the schema needed for the new "outbound" Quick-Share workflow:
-- users export files from a remote session into an encrypted staging area,
-- those uploads are held in a Pending state until an approver decides
-- Approve (file released, single-use download link) or Deny (file purged).
--
-- This migration is purely additive (new tables + new columns with safe
-- defaults). All new RBAC and per-user flags default to the most
-- restrictive value so behaviour is unchanged on upgrade.

-- ── A. RBAC flag — per-role "may use outbound Quick Share" ─────────────
--
-- Defaults to FALSE so the feature is opt-in for every existing role.
-- Administrators must explicitly tick the new permission on each role
-- that should be allowed to request outbound exports.
ALTER TABLE roles
    ADD COLUMN IF NOT EXISTS can_use_quick_share_outbound BOOLEAN NOT NULL DEFAULT FALSE;

-- ── B. Per-user approval requirement ───────────────────────────────────
--
-- Mirrors the password-checkout `can_self_approve` model: every export by
-- a user with `outbound_share_requires_approval = TRUE` is held in the
-- approver queue. Users flagged FALSE get an immediate Approved row (the
-- DLP scanner still runs and the audit chain still records the request).
-- Default TRUE for safety on upgrade.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS outbound_share_requires_approval BOOLEAN NOT NULL DEFAULT TRUE;

-- ── C. Approver assignments ────────────────────────────────────────────
--
-- A flat list of users who can decide outbound-share requests. Kept
-- separate from the existing `approval_roles` machinery (password
-- checkouts) so the two surfaces can evolve independently and so the
-- blast radius of a permission mistake is bounded.
CREATE TABLE IF NOT EXISTS outbound_share_approvers (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── D. Outbound share requests ─────────────────────────────────────────
--
-- One row per outbound export. The blob ciphertext lives on disk at
-- `storage_path`; the AES-256-GCM DEK that encrypted it is wrapped by
-- Vault Transit and persisted alongside as (`sealed_dek_ciphertext`,
-- `sealed_dek_nonce`). The plaintext DEK never touches disk.
CREATE TABLE IF NOT EXISTS outbound_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- session_id is optional because outbound shares may be submitted
    -- outside an active remote session (e.g. via a re-upload flow).
    session_id TEXT,
    connection_id UUID REFERENCES connections(id) ON DELETE SET NULL,

    -- File metadata (post-sniff content_type, see services::outbound_shares).
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size BIGINT NOT NULL CHECK (size >= 0),
    sha256 TEXT NOT NULL,

    -- Vault-sealed envelope key + on-disk ciphertext location.
    -- These are NULLable because they are deliberately cleared once the
    -- share has been denied, downloaded, or purged — we never want stale
    -- sealing material sitting in the row for an inert capability.
    storage_path TEXT,
    sealed_dek_ciphertext BYTEA,
    sealed_dek_nonce BYTEA,

    -- Workflow. Status values are lowercase to match the
    -- `OutboundShareStatus` serde representation in the service layer
    -- (single source of truth — see `OutboundShareStatus::as_str`).
    justification TEXT,
    dlp_score INTEGER NOT NULL DEFAULT 0,
    dlp_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','denied','downloaded','purged')),
    decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,

    -- Single-use download token (NULL until approved; cleared after downloaded).
    download_token TEXT UNIQUE,
    downloaded_at TIMESTAMPTZ,

    -- Lifecycle.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    purged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbound_shares_requester ON outbound_shares(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_outbound_shares_status ON outbound_shares(status);
CREATE INDEX IF NOT EXISTS idx_outbound_shares_expires ON outbound_shares(expires_at)
    WHERE purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbound_shares_pending_created ON outbound_shares(created_at)
    WHERE status = 'pending';
