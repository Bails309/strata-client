# ADR-0014: Co-Pilot Multiplayer — Two-WebSocket Split

- **Status:** Accepted
- **Date:** 2026-05-22
- **Release:** v1.9.6
- **Authors:** Strata core
- **Supersedes:** none
- **Superseded by:** none

## Context

The v1.9.6 multiplayer / co-pilot feature lets up to six participants share
a single Strata connection — one screen plane, one input plane gated by an
input-token FSM, plus a control plane that carries roster, cursors, chat,
input-token arbitration, and (reserved) WebRTC SDP/ICE.

Two design options were on the table for how to carry the control plane:

1. **Single WebSocket, in-band JSON.** Reuse the existing
   `/api/shared/tunnel/{share_token}` WS and interleave JSON envelopes
   alongside Guacamole protocol instructions, demuxed by leading byte.
2. **Sibling WebSocket.** Add a separate
   `/api/shared/copilot/{share_token}` WS that carries **only** JSON
   envelopes; leave the tunnel WS untouched as a pure Guacamole transport.

Option (1) was implemented first and lived briefly on
`feat/co-pilot-mode` as commit `05bcfb9` before being superseded.

## Decision

We split the wire into two WebSockets (option 2).

- `/api/shared/tunnel/{share_token}?pid=<uuid>` carries Guacamole frames
  exactly as today. The new `pid` query parameter ties the tunnel WS to a
  specific participant so the backend can ask
  `CoPilotRoom::note_input_activity(pid)` whether the participant currently
  holds the input token before forwarding a frame.
- `/api/shared/copilot/{share_token}?name=<display_name>` carries the
  tagged-union JSON envelope protocol (`hello` / `welcome` / `roster` /
  `cursor` / `chat` / `input_*` / `audio_*` / `leave` / `join_error`).

Single-viewer shares ignore the copilot endpoint and the tunnel endpoint
treats a missing `pid` exactly as before.

## Consequences

### Positive

- **Client-library compatibility.** `Guacamole.WebSocketTunnel` (the
  upstream client we already depend on) parses incoming frames as
  Guacamole protocol instructions. In-band JSON envelopes corrupted its
  parser and would have required either forking it or stripping JSON
  before passing the WS to it.
- **Clean validation surface.** Envelope validation
  (`CoPilotMsg::validate()`) only ever sees JSON. Frame demux is a single
  byte-test (`b'{'`) rather than a stateful protocol parser.
- **Independent backpressure.** A slow chat participant cannot stall
  screen frames and vice versa — the two WebSockets have independent
  send buffers and independent close lifecycles.
- **Future RTC fits naturally.** The control plane is already the right
  shape for SDP/ICE relay; adding the WebRTC peer mesh later requires no
  protocol redesign.

### Negative

- **Two-handshake join.** A participant now opens two WebSockets to join
  a multiplayer share. `SharedViewer` waits for the copilot WS to emit
  `welcome` (which carries the server-assigned `pid`) before opening the
  tunnel WS so the latter can include `?pid=<uuid>`. This adds ~one RTT
  to the join path but only for multiplayer shares.
- **Two reconnect strategies.** If the tunnel WS drops but the copilot WS
  is healthy, the participant remains in the roster but loses the screen.
  The 1.9.6 client treats either drop as a full leave; a future commit
  may implement partial recovery.

### Neutral

- The audit-log shape, the `share_participant_audit` table, the
  `multiplayer_share_enabled` kill switch, and the `CoPilotRoom` FSM are
  all unchanged by the split — they live above the wire.

## Alternatives considered

- **Subprotocol negotiation.** Use `Sec-WebSocket-Protocol` to select
  "guac" vs. "co-pilot-v1" on a single endpoint. Rejected: still requires
  in-band demux on the "co-pilot-v1" subprotocol because Guacamole frames
  and JSON envelopes would still share one WS.
- **HTTP long-poll for the control plane.** Rejected: cursors at 30 Hz
  and chat are both natively push-shaped; long-poll would either be laggy
  or burn connections.

## Verification

- Backend protocol module: `backend/src/services/co_pilot.rs` (envelope
  union, `validate()` arms, bound constants).
- Backend room FSM: `backend/src/services/co_pilot/room.rs`
  (`try_claim_input`, `release`, `revoke`, 17-test FSM coverage).
- Backend handler: `backend/src/routes/share.rs` →
  `ws_copilot_room` (route registered in `backend/src/routes/mod.rs`).
- Frontend protocol mirror: `frontend/src/co-pilot/protocol.ts`.
- Frontend room hook: `frontend/src/co-pilot/useCoPilotRoom.ts`.
- Frontend two-WS dance: `frontend/src/pages/SharedViewer.tsx` (defers
  tunnel open until `room.ready`, appends `?pid=`).
