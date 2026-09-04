# ADR-0015: Native Rust Session Engine (guacd Replacement)

- **Status:** Accepted
- **Date:** 2026-09-04
- **Release:** v2.0.0 (in progress)
- **Authors:** Strata core
- **Supersedes:** ADR-0004 (guacd connection model) — partially, on the
  timeline in "Migration" below
- **Superseded by:** none

## Context

Live RDP / VNC / SSH proxying is currently delegated to Apache Guacamole's
`guacd`. It works, and it has been made to work well — but it costs us on
three axes that are not going to get better.

**Memory safety.** `guacd` is C, and it links FreeRDP and `libvncclient`.
`docs/threat-model.md` already classifies the active-session path as the
platform's largest attack surface. Keeping it safe means the patch queue in
`guacd/patches/` (five patches at the time of writing, one of which had to
be retargeted after an upstream refactor silently fuzz-matched into the
wrong function) and pinning image digests in two Dockerfiles that must be
kept in step. Meanwhile `deny.toml` enforces provenance and licence
policy on every Rust crate we ship — and has no visibility into any of
this.

**Double encoding.** On a modern EGFX session the target sends us H.264.
`guacd` decodes those slices on the host CPU, composites them onto a Cairo
surface, computes bounding-box damage, then re-encodes the result as
PNG/WebP so it fits down the Guacamole text protocol — at which point the
browser decodes it a third time. Every frame is decoded, rasterised and
re-compressed on a server that had a perfectly good compressed bitstream
in its hands the whole time.

**Lifecycle mismatch.** Strata is Tokio: thousands of multiplexed streams
on non-blocking event loops. `guacd` is a thread or a `fork()` per
connection, reached over a socket whose connection parameters are the only
way to pass it a credential — so a secret checked out of Vault has to be
serialised into a plaintext parameter string to cross the boundary.

## Decision

Replace `guacd` with `crates/strata-session`, a native Rust session engine
in the Strata Cargo workspace.

**Placement.** The engine runs in the **trusted internal zone** alongside
the backend, never in the DMZ. `crates/strata-dmz` must not depend on it;
the edge reaches the session tier over the same signed-header internal
socket it already uses (ADR-0009). This is enforced in CI by
`.github/workflows/dmz-deps.yml`, which now fails if `strata-session`
appears in the DMZ dependency closure.

**Protocol stack.** Pure-Rust where a production-grade crate exists:

| Subsystem | Was | Becomes |
| --- | --- | --- |
| RDP | FreeRDP (C) | `ironrdp` — sans-I/O state machine, no hidden threads |
| SSH | libssh2 (C, polled) | `russh` — Tokio-native |
| Terminal state | Pango + Cairo | `alacritty_terminal`, rasterised only when needed |
| VNC | `libvncclient` (C) | `cxx` wrapper around an audited `libvncclient`, pointer work confined to an isolated worker |
| Recording | `guaclog` | in-process audit tap |

VNC is the honest exception: pure-Rust RFB implementations still lack
Tight encoding, dynamic resize and complete auth handshakes, so we contain
the C rather than pretend it is gone.

**Dual-track transport.** Two encoders sit behind one `FrameEncoder`
trait:

- *Guacamole Wire Compatibility Mode* — byte-identical framing to `guacd`,
  so an unmodified `guacamole-common-js` client cannot tell the
  difference. This is what makes the rollout a routing decision rather
  than a frontend release.
- *Native Direct Streaming Mode* — compressed H.264 slices and raw PTY
  bytes are wrapped in a 14-byte binary envelope
  (`strata_protocol::media`) and handed to the browser's `VideoDecoder`
  (WebCodecs) and `xterm.js` respectively. The server never touches a
  pixel.

**Credentials.** Vault-issued secrets are passed in-process as
`secrecy::SecretString` and zeroed after the handshake. `TargetSpec` has a
hand-written `Debug` that renders the secret as `<redacted>`, so a stray
`tracing` field cannot leak it. Teardown revokes through a
`CredentialGuard` hook, and revocation runs even when the engine shutdown
fails.

**Observation and dual control.** Both were awkward under `guacd` because
they meant coordinating through shared C client structs. They are now
message passing: the session actor publishes every outgoing frame to a
`tokio::sync::broadcast` ring, observers subscribe, and an observer that
falls behind is dropped rather than allowed to stall the operator. Dual
control is an `InputModerator` on the input path.

## Consequences

**Good.**

- `guacd/patches/`, the two digest pins and the C toolchain leave CI.
- `deny.toml` gains authority over the session tier for the first time.
- No plaintext credential crosses a process boundary.
- Direct streaming removes the decode/rasterise/re-encode round trip.

**Costs and risks.**

- `ironrdp` does not cover every FreeRDP feature we currently rely on.
  Phase 2 exists to find out which, on real sessions, before anything is
  decommissioned.
- Two downstream pipelines must be kept in behavioural parity for as long
  as older clients exist.
- The VNC path still contains C. It is isolated, not eliminated.
- Our own bugs replace upstream's. The mitigations are `cargo-fuzz` on
  every parser, and the recorded-stream parity harness.

**Rejected alternatives.**

- *Keep `guacd`, patch harder.* Does nothing about double encoding or the
  credential boundary, and the patch queue grows monotonically.
- *Fork `guacd`.* Inherits the C, and now we own it.
- *Pure-Rust VNC.* Feature coverage is not there; shipping it would be a
  visible regression.

## Migration

Four phases, each independently reversible.

| Phase | Deliverable | Rollback |
| --- | --- | --- |
| 1 | `crates/strata-session`: wire protocol, actor pipeline, transports, engine abstraction | None needed — new crate, nothing routed to it |
| 2 | Dual-stack. Backend routes a subset of RDP/SSH sessions to the Rust engine in Guacamole Wire Mode | Config flag routes all traffic back to `guacd` |
| 3 | Direct streaming end to end; Vault credential injection; observation and recording move off `guaclog` | Frontend flag reverts the client to wire mode |
| 4 | Decommission the `guacd` container, delete `guacd/patches/`, drop the C toolchain from CI | Re-enable the pinned `guacd` digest |

**Phase 1 is complete as of this ADR.** The parser, actor pipeline,
transports, audit sink and engine abstraction are implemented and tested;
`engine::mock` stands in for the real engines, which land in Phase 2.

## Verification

| Domain | Method | Target |
| --- | --- | --- |
| Protocol conformance | Replay recorded instruction streams through the parser | 100% structural equivalence |
| Parser robustness | `cargo-fuzz` on the instruction parser, the streaming decoder and the media envelope | No panic or unbounded allocation over 72h |
| Latency | Synthetic input-to-frame on 60 FPS RDP | p50 < 20 ms, p99 < 45 ms |
| Memory | 500 concurrent sessions | > 70% RSS reduction vs `guacd` |
| Credential hygiene | Core-dump inspection after handshake | No plaintext credential remnants |
| Supply chain | `cargo deny check` | Zero advisory / ban / licence violations |

## References

- `docs/threat-model.md`
- `docs/adr/ADR-0004-guacd-connection-model.md`
- `docs/adr/ADR-0009-dmz-deployment-mode.md`
- `deny.toml`
