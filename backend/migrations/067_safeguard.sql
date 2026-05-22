-- ── Safeguard JIT Credential Checkout ─────────────────────────────────
-- v1.10.0+: integrate OneIdentity Safeguard "Just-In-Time" password
-- checkout so a Strata session can pull a managed credential at
-- tunnel-open time and never persist it.
--
-- The integration is configured entirely at runtime from the
-- "Safeguard JIT" admin tab — no hard-coded endpoints. A single
-- `safeguard_config` row (id = 1) holds every operator-tunable. The
-- feature is opt-in: `enabled` defaults to FALSE so the kind is hidden
-- from the UI until an admin turns it on.

CREATE TABLE IF NOT EXISTS safeguard_config (
    -- Singleton row; enforced by PK + CHECK so callers can always
    -- "SELECT … WHERE id = 1" without worrying about ordering.
    id                          SMALLINT  PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    -- Master kill-switch. When false the credential-profile kind
    -- "safeguard" is hidden from the UI and the tunnel cred resolver
    -- treats safeguard-backed profiles as expired (existing UX).
    enabled                     BOOLEAN   NOT NULL DEFAULT FALSE,

    -- Appliance reachability.
    appliance_fqdn              TEXT      NOT NULL DEFAULT '',
    appliance_port              INT       NOT NULL DEFAULT 443
                                    CHECK (appliance_port BETWEEN 1 AND 65535),
    verify_tls                  BOOLEAN   NOT NULL DEFAULT TRUE,
    -- Optional pinned CA bundle; reuses the same PEM convention as the
    -- 014_ca_cert.sql trusted-CA work.
    ca_cert_pem                 TEXT,

    -- Federation provider alias as configured on the Safeguard side
    -- (e.g. 'extf161' for Capita). Required for per-user OIDC mode.
    idp_alias                   TEXT      NOT NULL DEFAULT '',

    -- per_user_oidc → Strata redirects each user to Safeguard SSO and
    --                 stores a refresh token per user (highest audit
    --                 fidelity; deferred to a follow-up release).
    -- a2a           → Strata authenticates as a single registered
    --                 Application-to-Application identity. Audit shows
    --                 "Strata" as the requester; Strata's own audit log
    --                 records which user triggered each checkout.
    -- hybrid        → both modes coexist; per-user when available,
    --                 A2A fallback for shared-automation accounts.
    auth_mode                   TEXT      NOT NULL DEFAULT 'per_user_oidc'
                                    CHECK (auth_mode IN ('per_user_oidc','a2a','hybrid')),

    -- Default Safeguard `RequestedDurationHours` when creating an
    -- access request. Safeguard policy may clamp this server-side; we
    -- treat it as a hint.
    default_checkout_hours      INT       NOT NULL DEFAULT 12
                                    CHECK (default_checkout_hours BETWEEN 1 AND 12),

    -- Substituted into the Safeguard `ReasonComment` field. Supported
    -- tokens (resolved at runtime, optional):
    --   {session_id}   → Strata session UUID
    --   {user}         → Strata username
    --   {connection}   → connection label
    request_reason_template     TEXT      NOT NULL DEFAULT 'Strata session {session_id} for {user}',

    -- When true, Strata calls POST /AccessRequests/{id}/Checkin as
    -- soon as the tunnel WebSocket closes, so the upstream window
    -- matches actual usage instead of sitting open for 12 hours.
    auto_checkin_on_session_end BOOLEAN   NOT NULL DEFAULT TRUE,

    -- A2A secrets, stored as `vault:{json}` envelopes (services::vault::seal_setting).
    -- NULL when auth_mode='per_user_oidc' or fields are not yet provided.
    a2a_api_key_sealed          TEXT,
    a2a_client_cert_pem_sealed  TEXT,
    a2a_client_key_pem_sealed   TEXT,

    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ON DELETE SET NULL so deleting the operator who last touched
    -- the config doesn't cascade-delete the config itself.
    updated_by                  UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Seed the singleton row.
INSERT INTO safeguard_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── credential_profiles: add a `kind` discriminator + Safeguard refs ──
-- kind='local'     → existing encrypted username/password (default; no change).
-- kind='safeguard' → JIT-resolved; encrypted_* columns hold zero-length
--                    placeholders, and the (account_id, asset) tuple
--                    identifies the Safeguard managed account.
ALTER TABLE credential_profiles
    ADD COLUMN IF NOT EXISTS kind                  TEXT NOT NULL DEFAULT 'local'
        CHECK (kind IN ('local','safeguard')),
    ADD COLUMN IF NOT EXISTS safeguard_account_id  TEXT,
    ADD COLUMN IF NOT EXISTS safeguard_asset       TEXT;

-- Cheap lookup for "all safeguard-backed profiles owned by user X".
CREATE INDEX IF NOT EXISTS idx_credential_profiles_kind
    ON credential_profiles (kind)
    WHERE kind <> 'local';

-- ── Append-only audit of every JIT password resolution ────────────────
-- Independent of `audit_logs` so we keep the Safeguard timeline forensically
-- separate (matches the same shape as share_participant_audit). A row is
-- inserted at request-open, then UPDATEd to `success` / `failed` once the
-- password is in hand, and finally `checked_in` (or `expired`) when the
-- tunnel closes.
CREATE TABLE IF NOT EXISTS safeguard_checkout_audit (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Nullable: a profile can be deleted after the checkout has
    -- happened; we keep the audit row but lose the FK.
    profile_id      UUID        REFERENCES credential_profiles(id) ON DELETE SET NULL,
    sg_account_id   TEXT        NOT NULL,
    sg_asset        TEXT        NOT NULL,
    -- Safeguard's AccessRequests.Id (string in their API).
    sg_request_id   TEXT,
    session_id      TEXT,
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ,
    outcome         TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (outcome IN ('pending','success','failed','checked_in','expired')),
    error_message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sg_audit_user   ON safeguard_checkout_audit (user_id);
CREATE INDEX IF NOT EXISTS idx_sg_audit_opened ON safeguard_checkout_audit (opened_at DESC);
