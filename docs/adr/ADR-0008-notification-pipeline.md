# ADR-0008 — Transactional-email subsystem (notification pipeline)

- **Status**: Accepted
- **Date**: 2026-04-25
- **Wave**: P3–P7 (v0.25.0 Notifications release)
- **Related standards**: §11 (approval workflow), §26 (audit), §4.6 (secrets-at-rest)
- **Supersedes**: —
- **Superseded by**: —

## Context

Through v0.24.0, Strata Client had no first-class email pipeline. The
managed-account workflow leaned entirely on the in-app activity feed and
on operators noticing approval requests in the **Approvals** page. This
worked at small scale but fell over once approvers were geographically
distributed or off-shift, and it provided no asynchronous record for
requesters that their checkout had been approved or rejected.

Three concrete requirements drove this ADR:

1. **Asynchronous notification** of the four checkout state transitions
   (pending approval, approved, rejected, self-approved audit notice)
   via email, without blocking the user-facing request.
2. **Resilience**: transient SMTP failures (network blips, 4xx) must not
   drop messages on the floor. Permanent failures (5xx) must not be
   retried indefinitely.
3. **Auditability** of every decision the dispatcher makes, including
   suppressions due to per-user opt-out and refusals to send when the
   relay is misconfigured.

A fourth, softer requirement: messages must look modern in every major
client (Gmail, Outlook desktop/web/mobile, Apple Mail) and survive
Outlook desktop's dark-mode "haze" overlay, which inverts `bgcolor`
attributes on otherwise-correct HTML.

## Decision

**Adopt an MJML-based template pipeline rendered server-side via
[`mrml`](https://github.com/jdrouet/mrml), an `EmailTransport` trait
with a production `SmtpTransport` (lettre 0.11), a single
`email_deliveries` audit table, and a background retry worker.**

### Trait + transport

```rust
#[async_trait]
pub trait EmailTransport: Send + Sync {
    async fn send(&self, msg: EmailMessage) -> Result<(), SendError>;
}
```

Two implementations:

- **`SmtpTransport`** — production. Uses `lettre 0.11` with rustls and
  Tokio. Supports `STARTTLS` (587), implicit TLS (465), and plaintext
  (`none`, internal relays only). The `send` impl classifies errors as
  permanent (5xx, malformed envelope) or transient (4xx, network) so the
  retry worker can skip the former.
- **`StubTransport`** — tests only. Captures messages in a `Mutex<Vec>`.

### Vault-sealed SMTP password

The SMTP password is **never** stored in `system_settings` in plaintext.
It is sealed via the existing `crate::services::vault::seal_setting`
helper (same Transit envelope as `recordings_azure_access_key`) and
unsealed at send time in `SmtpTransport::load_settings`.

`PUT /api/admin/notifications/smtp` rejects any update that supplies a
new password while Vault is sealed or in stub mode. Half-configured
installs fail loudly rather than silently writing the password to disk.

### Schema (migration 055)

A single audit table plus one column on `users`. **No** separate
`notification_settings` or `notification_user_prefs` tables — settings
live in `system_settings` (existing infrastructure), prefs are a single
boolean column.

```sql
ALTER TABLE users ADD COLUMN notifications_opt_out BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE email_deliveries (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    template_key         TEXT         NOT NULL,
    recipient_user_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
    recipient_email      TEXT         NOT NULL,
    subject              TEXT         NOT NULL,
    related_entity_type  TEXT,
    related_entity_id    UUID,
    status               TEXT         NOT NULL
                         CHECK (status IN ('queued','sent','failed','bounced','suppressed')),
    attempts             INT          NOT NULL DEFAULT 0,
    last_error           TEXT,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sent_at              TIMESTAMPTZ
);
```

The rendered email **body** is intentionally not stored. Only metadata
is retained, keeping sensitive justification text confined to the
source `password_checkout_requests` row (single access path).

### Templates: MJML standalone, no partials

MJML compiles to table-based HTML that survives every major client
without per-client tweaking. The `mrml` Rust port renders MJML
server-side with no Node.js dependency.

**Decision: standalone templates, no partials.** mrml's XML parser does
not tolerate Tera's `{% include %}` mechanism — whitespace from the
include directive breaks parsing at section/column boundaries. Each of
the four templates (`checkout_pending`, `checkout_approved`,
`checkout_rejected`, `checkout_self_approved`) is therefore
self-contained: no `_header.mjml` / `_footer.mjml`, no
`<mj-attributes>` block, font-family set per-element.

### Custom `xml_escape`, not ammonia

`ammonia::clean_text` was evaluated and rejected — it over-escapes
(encodes spaces as `&#32;`), which breaks layout and bloats payload
size. The renderer uses a hand-rolled 5-character helper covering only
the XML-significant characters (`& < > " '`).

### Outlook dark-mode wrapper (VML)

`wrap_for_outlook_dark_mode` injects:

1. The VML namespace on `<html>` (`xmlns:v="urn:schemas-microsoft-com:vml"`)
2. A full-bleed `<v:background fill="t">` rectangle inside an
   `<!--[if gte mso 9]>` conditional
3. An Outlook-only stylesheet forcing dark backgrounds on tables/divs

VML backgrounds are immune to Outlook desktop's dark-mode inversion
engine. Future templates inherit the fix automatically by passing
through this helper.

### Dispatcher hooks

Four call sites in `routes/user.rs` invoke
`notifications::spawn_dispatch(state, event)`:

| Call site | Event |
|---|---|
| `request_checkout` (Pending) | `CheckoutEvent::Pending` |
| `request_checkout` (SelfApproved) | `CheckoutEvent::SelfApproved` (bypasses opt-out) |
| `decide_checkout` (Approved) | `CheckoutEvent::Approved` |
| `decide_checkout` (Rejected) | `CheckoutEvent::Rejected` |

`spawn_dispatch` is fire-and-forget — it returns immediately so the
user-facing request is never blocked by mail delivery.

### Retry worker

Background task wired into `main.rs` alongside the existing periodic
workers (using the established `services::worker::spawn_periodic`
pattern):

- **Tick**: 30 s
- **Initial warm-up**: 60 s
- **Per-attempt timeout**: 120 s
- **Selection**: `status = 'failed' AND attempts < 3 AND retry_after < now()`
- **Backoff**: exponential
- **Abandonment**: after the third failure, status remains `failed`
  and a `notifications.abandoned` audit event is emitted; the worker
  no longer selects the row.

Permanent (5xx) failures bypass the retry path entirely.

## Alternatives considered

### Send via background queue (Redis, RabbitMQ)

**Rejected.** Strata's existing periodic-worker infrastructure is
adequate for the volume (<1000 messages/day for any plausible install
size). Adding a queue broker would mean another container, another
health-check, another HA story, and another credential to seal in
Vault. The `email_deliveries` table is a sufficient queue.

### Hand-rolled HTML templates

**Rejected.** Cross-client compatibility (especially Outlook + Gmail
mobile + dark mode) requires table-based markup, inline styles, and
client-specific conditionals that are tedious and error-prone to
maintain by hand. MJML solves this once.

### Render MJML in a Node.js sidecar

**Rejected.** mrml is a pure-Rust port that produces output identical
to upstream MJML for the constructs we use. A Node.js sidecar would
double the container count and complicate the boot sequence.

### Per-event opt-out flags

**Rejected for v0.25.0.** A single `notifications_opt_out` boolean is
sufficient for the four templates we ship today. Per-event flags can
be added in a future migration without breaking the dispatcher's
existing branch (the `ignores_opt_out` flag is already per-template).

### Store rendered body in `email_deliveries`

**Rejected.** Justification text is the most sensitive field in a
checkout flow. Storing the rendered body would create a second access
path to that text, making any future ACL change on
`password_checkout_requests` ineffective at limiting blast radius.
Metadata-only is the conservative choice.

## Consequences

- **Positive**: Asynchronous notification works end-to-end. Approvers
  off-platform receive timely emails. Requesters get closure on
  approved/rejected requests. Self-approval audit trail is now visible
  to security teams via email, not just in-app.
- **Positive**: The pipeline is idiomatic for the codebase — uses the
  existing `system_settings`, Vault `seal_setting`, periodic-worker,
  and audit infrastructure rather than introducing parallel systems.
- **Positive**: The Outlook dark-mode fix is reusable; future
  templates (password expiry warnings, AD sync failures, etc.) inherit
  it automatically.
- **Negative**: One more set of credentials to manage. Operators must
  configure SMTP before approvers will receive emails — the dispatcher
  refuses to send when `smtp_from_address` is empty (this is logged as
  `notifications.misconfigured`, not silent).
- **Negative**: mrml's strict XML parser foreclosed the obvious "share
  a header partial" approach. New templates must be self-contained.
  Documented in repo memory and in the architecture doc.

## Verification

- All 26 tests in `services::email::*` pass.
- `cargo test --bin strata-backend` reports 852 passing tests after the
  v0.25.0 changes (vs. 817 in v0.24.0).
- `POST /api/admin/notifications/test-send` round-trips through the
  live transport and surfaces SMTP errors verbatim for debugging.
- Suppression behaviour verified: setting
  `users.notifications_opt_out = true` causes the next dispatch to
  insert an `email_deliveries` row with `status = 'suppressed'` and
  emit a `notifications.skipped_opt_out` audit event.

## References

- [docs/architecture.md § Transactional-Email Pipeline](../architecture.md#transactional-email-pipeline)
- [docs/security.md § Notification Pipeline](../security.md#notification-pipeline-transactional-email)
- [docs/api-reference.md § Notification Endpoints (Admin)](../api-reference.md#notification-endpoints-admin)
- [docs/runbooks/smtp-troubleshooting.md](../runbooks/smtp-troubleshooting.md)
- [ADR-0006 — Vault Transit envelope](ADR-0006-vault-transit-envelope.md) (sealing pattern reused)
