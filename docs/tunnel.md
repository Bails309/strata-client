# Tunnel and Ticket Behaviour

This page documents the WebSocket tunnel endpoint and the tunnel-ticket convenience used by UI flows such as Quick Share and one-off connections.

## WebSocket tunnel

- Endpoint: `GET /api/tunnel/:connection_id` (WebSocket upgrade).
- Auth: Requires `Authorization: Bearer <token>` or a valid session cookie.
- Behaviour: backend authenticates the caller, creates/loads a runtime `connection` session row, resolves credential profiles, constructs the Guacamole `select` and `connect` argument map, and proxies bytes bidirectionally between the browser and the selected `guacd` instance. The tunnel also mirrors bytes into the recording writer and participates in the auth watchdog (revocation polling + `MAX_TUNNEL_DURATION`).

## Tunnel tickets (one-off sessions)

- What: short-lived single-use tickets minted by server flows that encode session attributes (e.g. `credential_profile_id`, `display_name`, `expires_at`).
- Consume: tickets are consumed exactly once by the tunnel handler during initial request processing.
- Credential handling: when a ticket carries a `credential_profile_id` the tunnel handler canonicalises it and resolves the profile via the same credential-resolution pipeline used for mapped profiles, including:
  - `safeguard` JIT checkout (OneIdentity Safeguard integration),
  - Vault-sealed password cache lookups (per `(user_id, profile_id)`),
  - Local `encrypted_*` unseal when appropriate.

This canonicalisation ensures one-off profiles follow the same code path as mapped profiles and prevents duplicated logic paths that previously led to `vault::unseal` being called on empty placeholders for `safeguard`-kind profiles (causing "missing ciphertext" errors).

## Errors

- `400 Bad Request` — malformed ticket payload or invalid parameters.
- `401 Unauthorized` — expired or already-consumed ticket, or invalid authentication.
- `502 Bad Gateway` / `500 Internal Server Error` — Safeguard checkout or Vault errors; operators should consult backend logs for `Safeguard password cache` and `vault::unseal` diagnostics.

## Operational notes

- The ticket is a server-side convenience only — no ticket data is forwarded to the target host.
- When `safeguard` profiles are used, JIT checkout may synchronously call the appliance on connect; enabling the Vault password cache or setting longer profile TTLs reduces repeated upstream calls for long operator shifts.
