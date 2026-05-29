-- ── Code Review Fixes (2026-05) ──────────────────────────────────────
-- Bundled migration covering DB findings from the May 2026 deep-dive
-- code review. All changes are additive / IF [NOT] EXISTS so re-running
-- on a partially-applied database is safe.

-- ── H2: missing FK index on safeguard_checkout_audit.profile_id ──
-- The column is queried on cascade deletes and on per-profile audit
-- look-ups, but only (user_id) and (opened_at DESC) were indexed in
-- migration 067. Without this index, profile-scoped lookups scan the
-- whole audit table.
CREATE INDEX IF NOT EXISTS idx_sg_audit_profile
    ON safeguard_checkout_audit (profile_id);

-- ── M13: flip the soft-deleted partial index ──
-- Migration 012 created idx_connections_soft_deleted ON connections
-- (soft_deleted_at) WHERE soft_deleted_at IS NOT NULL — i.e. it indexes
-- the *deleted* rows. Every connection-list query in the product
-- filters `WHERE soft_deleted_at IS NULL`, which gets no benefit from
-- that index. Replace it with a partial index over the active rows,
-- keyed by name (the common ORDER BY).
DROP INDEX IF EXISTS idx_connections_soft_deleted;
CREATE INDEX IF NOT EXISTS idx_connections_active_by_name
    ON connections (name)
    WHERE soft_deleted_at IS NULL;
-- Keep a small index over the deleted rows for the hard-delete sweep
-- (`WHERE soft_deleted_at < now() - INTERVAL '7 days'`).
CREATE INDEX IF NOT EXISTS idx_connections_soft_deleted_at
    ON connections (soft_deleted_at)
    WHERE soft_deleted_at IS NOT NULL;
