-- Safeguard pending-approval request tracking (v1.12.11).
--
-- Before this migration the only place a Safeguard `PendingApproval`
-- request-id lived was React `useState` inside the bulk-checkout
-- card. If the user obtained the pending request via the auto-request
-- path (direct-connect JIT in `routes::tunnel`), no state was
-- persisted anywhere the SPA could read back — so the Credentials
-- → Request Checkout tab showed no "Awaiting approval" row, no
-- Refresh button, and the background poll never ran. The user's only
-- option was to keep re-clicking the connection tile and hitting the
-- same approval-required error every time (the appliance's own
-- workflow correctly reuses the pending request id via the
-- `jit_checkout` preflight, so no true duplicate request is opened
-- on the SPP side — but the UX is indistinguishable from a
-- re-request).
--
-- This table gives every JIT PendingApproval outcome (regardless of
-- whether it was created by the tunnel handler or the bulk-checkout
-- endpoint) a persistent home. Rows are inserted on `PendingApproval`
-- and deleted on the two termination paths:
--   - `services::safeguard::release_pending` succeeds (approver
--     acted → cache row now exists → pending row is redundant)
--   - `safeguard_checkin` releases the profile (user gave up or the
--     approver denied)
--
-- Layout mirrors `safeguard_cached_passwords` for a consistent
-- per-(user, profile) uniqueness contract and identical cascade
-- semantics.

CREATE TABLE IF NOT EXISTS safeguard_pending_requests (
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id  UUID        NOT NULL REFERENCES credential_profiles(id) ON DELETE CASCADE,
    request_id  TEXT        NOT NULL,
    account_id  TEXT        NOT NULL,
    asset       TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_safeguard_pending_req_user
    ON safeguard_pending_requests(user_id);
