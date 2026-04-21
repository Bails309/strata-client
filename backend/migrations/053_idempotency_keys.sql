-- 045_idempotency_keys.sql
--
-- W2-10 — support idempotent retry of checkout activation (and any other
-- mutating route that opts in).
--
-- Clients supply an `Idempotency-Key` header on POST requests. The first
-- time a (user, route, key) triple is seen we record the response body +
-- status and let the request through. Subsequent requests with the same
-- triple (within TTL) short-circuit and return the cached response,
-- ensuring the underlying state change happens at most once even when the
-- client retries on network error.
--
-- Keys live in a dedicated table (not a row on `password_checkout_requests`)
-- so the pattern can be reused by other endpoints without schema churn.

CREATE TABLE idempotency_keys (
    key           TEXT        PRIMARY KEY,
    user_id       UUID        NOT NULL,
    route         TEXT        NOT NULL,
    status_code   INTEGER     NOT NULL,
    response_body JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL
);

-- Lookup path is always (user_id, route, key); the PK covers key, the
-- composite index speeds scoped lookups.
CREATE INDEX idempotency_keys_user_route_key_idx
    ON idempotency_keys (user_id, route, key);

-- Expiry sweeper uses this.
CREATE INDEX idempotency_keys_expires_at_idx
    ON idempotency_keys (expires_at);
