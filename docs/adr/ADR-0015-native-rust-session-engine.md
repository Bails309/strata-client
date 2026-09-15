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

**No RSA in the SSH engine.** `russh`'s `rsa` feature pulls
`rsa 0.10.0-rc.x`, which carries RUSTSEC-2023-0071 — the Marvin attack,
key recovery through a timing sidechannel — with no fixed release. A
privileged-access gateway is precisely the wrong place to ship that, and
`cargo deny check advisories` agrees. The engine builds without it;
ed25519, ECDSA (P-256/384/521) and the post-quantum key exchange cover
every target running a current OpenSSH. An opt-in `ssh-rsa` cargo feature
exists for targets that present no other host key, and enabling it means
owning a documented `advisories.ignore` entry. `russh` also uses the
`ring` backend rather than the default `aws-lc-rs`, which is a C library
and would have quietly reintroduced what this migration removes.

**Host key verification is not optional.** The SSH engine takes an
allow-list of SHA-256 fingerprints and has no "accept anything" variant.

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

**Governance parity is a precondition, not a follow-up.** A session
served by the native engine is subject to the same recording, live
observation, administrative termination, revocation watchdog and
maximum-duration limit as one served by `guacd`. This matters more than
it might look: a routing flag that quietly exempted some sessions from
recording would be a worse outcome than never replacing `guacd` at all.
The recording is written by the engine itself as a `.guac` file in
`guacd`'s own format, so the existing playback route, `guacenc` and the
MP4 conversion path work against it without knowing the difference.

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

**Phase 1 is complete, and Phase 2 is substantially done.** The parser,
actor pipeline, transports, audit sink and engine abstraction are
implemented and tested. The SSH engine is real, the terminal rasteriser
renders it for existing `guacamole-common-js` clients, and the backend
consults `routing` before dialling `guacd`. Rollout is off by default:
`STRATA_SESSION_ENGINE=guacd`.

Outstanding in Phase 2: the VNC bridge. Until it lands, `routing`
refuses to send VNC sessions to the native engine no matter what the
rollout percentage says — a property with a test on it, because "rollout
at 100% on a build without that engine" is exactly how that mistake would
reach production.

Two RDP-specific consequences belong on the record:

- **NLA is not optional, and the engine fails closed.** The connector
  advertises CredSSP and nothing else. Advertising the legacy TLS
  security layer alongside it lets the server negotiate down, and on that
  layer the RDP connection completes *before* any credential is checked —
  authentication moves to an in-session login screen. A live test against
  xrdp found precisely this: a deliberately wrong password produced a
  healthy session that a gateway would have reported as authenticated.
  `ironrdp-tls` also does not verify the server certificate (RDP
  certificates are self-signed as a matter of course), so CredSSP's
  binding to the server public key is the only thing authenticating the
  target. Both reasons point the same way: no CredSSP, no session.
- **The RDP session runs on its own thread.** `ironrdp-async` 0.7's
  connection future is not `Send` — its `AsyncNetworkClient` hook is a
  bare trait object — so it cannot be driven from the shared Tokio
  runtime behind `ProtocolEngine`. The session owns a current-thread
  runtime for its lifetime and is reached over channels. This is the
  same isolation the plan anticipated for the VNC FFI bridge, arriving
  earlier than expected and for a different reason.

### Pinning `ironrdp` and `russh` so both engines can coexist

RDP is the primary protocol and SSH the secondary one, so the natural
instinct was to take current `ironrdp` and fit SSH around it. That turns
out to be the wrong way round, and the reason is worth recording.

`ironrdp-connector` 0.8 and later pin a `picky` release candidate that
pins `curve25519-dalek = "=5.0.0-rc.1"`. A patched `russh` requires
`curve25519-dalek ^5`, which resolves to 5.0.0 stable. Cargo cannot hold
two 5.x versions, so current `ironrdp` and current `russh` do not
resolve together. Verified against the registry:

Versions below are `ironrdp-connector`, not the `ironrdp` meta-crate.
The two are numbered independently — meta-crate 0.17.0 is connector
0.10.0 — so "upgrade to ironrdp 0.17" and "upgrade to connector 0.10"
name the same release, and there is no `ironrdp-connector` 0.17.

| Combination | Resolves | Builds | Notes |
| --- | --- | --- | --- |
| `ironrdp` 0.10 + `russh` 0.63 | no | — | two 5.x `curve25519-dalek` |
| `ironrdp` 0.10 + `russh` 0.60.2+ | no | — | same conflict; 0.60.1 is the ceiling |
| `ironrdp` 0.10 + `russh` 0.60.1 | yes | — | **below the RUSTSEC-2026-0154 fix** |
| `ironrdp` 0.10 + `russh` 0.54 | yes | yes | **`russh` carries RUSTSEC-2026-0153/0154** |
| `ironrdp` 0.9 + `russh` 0.63 | no | — | same `curve25519-dalek` conflict |
| `ironrdp` 0.8 + `russh` 0.63 | no | — | conflicts on `block-padding` instead |
| `ironrdp` 0.7 + `russh` 0.63 | yes | only with `picky` pinned | chosen |

The middle rows are the trap, and the first framing of this ADR understated
it. `russh` 0.54 is not the only version that makes current `ironrdp`
resolve — **0.60.1 does too**, which looks far more palatable until you
check the advisory: [RUSTSEC-2026-0154](https://rustsec.org/advisories/RUSTSEC-2026-0154.html)
(CVE-2026-46673) records `patched = [">=0.60.3"]`. Every `russh` that can
sit beside `ironrdp` 0.10 is therefore below the fix line, 0.60.1 by only
two patch releases. There is no "nearly current" compromise available.

Dropping `russh` to 0.54 is what "RDP first" naively implies — but 0.54
predates 0.58, and in those releases the unchecked `CryptoVec` growth of
RUSTSEC-2026-0153 is reachable from **remote SSH traffic** (transport
packet reads and zlib decompression, and we enable `flate2`). The
documented impact is process abort under allocation failure.

This engine runs **in-process inside the backend**. A remote peer able to
abort the process would not merely kill one SSH session; it would take
every concurrent RDP session down with it. Prioritising RDP therefore
argues *against* the older `russh`, not for it — the availability of the
primary protocol is what the vulnerable secondary one would destroy.

So: `russh` stays current and patched, and `ironrdp` sits on the 0.7
line. `picky` is pinned to `=7.0.0-rc.17` as well, because
`ironrdp-connector` 0.7 requires `picky = "7.0.0-rc.17"`, which for a
prerelease also matches rc.26 — and that newer `picky` no longer compiles
against the `sspi` version this `ironrdp` expects. Cargo has no
`[constraints]` section, so an unused `=` dependency is the only way to
hold it still.

#### Why a `[patch]` override does not rescue this

The obvious escape hatch is a workspace `[patch]`, and it does not work:

- **Patching `curve25519-dalek`** is impossible in principle. A patch entry
  supplies exactly one version, and no single version satisfies both
  `=5.0.0-rc.1` and `^5.0.0`.
- **Patching `picky`** to relax its dalek pin *would* resolve, at the cost
  of forking and maintaining a cryptography crate (X.509/PKI/JOSE) that
  sits in the CredSSP authentication path. For a security product that is
  a worse liability than running `ironrdp` three minors behind.
- **Disabling `picky`** is not available: `ironrdp-connector` 0.10 exposes
  only `default`, `qoi` and `qoiz`, so the dependency is mandatory.

#### Resolution: two vendored forks (2026-09-15)

The upgrade was taken, at the cost of two forks in `crates/vendor/`, wired
in through a workspace `[patch.crates-io]`. Both are small, both are
temporary, and both are liabilities — a fork pins us to a snapshot of
someone else's code, outside the crates.io supply chain, and silently
stops receiving upstream fixes.

**`crates/vendor/ironrdp-connector` — three lines.** Upstream 0.10.0 pins
`picky = "=7.0.0-rc.25"`, the last `picky` carrying
`curve25519-dalek = "=5.0.0-rc.1"`. The fork moves it to rc.26 (which
admits dalek 5.0.0 stable) and `sspi` 0.21 → 0.22, plus one line in
`src/credssp.rs` because `sspi` 0.22 made `TsRequest::buffer_len()` return
`Result<u16>`. Verified against IronRDP master `d2bb7376`, which still
carries the rc.25 pin — patching to upstream git does *not* work.

**`crates/vendor/sspi` — one line.** Being forced onto `sspi` 0.22.0 by
the above brought a new equality check on the SPNEGO `mechListMIC`
sequence number (`src/kerberos/utils.rs`). Windows RDP hosts send that MIC
with `seq_num` 0 while the AP-REP negotiated something else, so **every**
Kerberos NLA session was rejected — and rejected *before* the MIC checksum,
the part that actually carries the downgrade protection, is verified. The
fork drops the sequence comparison and leaves the checksum verification
untouched, restoring the behaviour of every `sspi` this product has
shipped (0.16, and 0.21.3 before it, neither of which has the check).

Routes that do **not** work, each tested rather than assumed:

- **Relaxing `picky` rc.25's dalek pin** instead, to keep `sspi` 0.21.
  rc.25 pins a whole RustCrypto release-candidate cluster —
  `ecdsa = "=0.17.0-rc.22"`, `ed25519-dalek`/`x25519-dalek` `=3.0.0-rc.1`
  — so it is not a one-line change, and the original judgement above
  stands.
- **Waiting for upstream.** `sspi` master HEAD is `f73e31c`, the 0.22.0
  release commit; the check is unchanged there.
- **Raw Kerberos, bypassing SPNEGO** so no `mechListMIC` exists.
  `credssp::ClientMode` offers only `Negotiate`, `Pku2u` and `Ntlm`.
- **NTLM over CredSSP.** Disabled on the target estate.

#### Un-fork procedure

`scripts/check-vendored-forks.sh` answers, per fork, whether the reason it
exists is still true. **Run it on every dependency bump and before every
release** — both forks should be deleted the moment upstream catches up,
and neither will announce itself.

- `ironrdp-connector` goes when a published connector resolves beside a
  `russh` at or above 0.60.3 on its own. Then: raise the whole set to
  whatever yields a **single** `ironrdp-svc` (mismatched satellites
  resolve happily and then fail to typecheck), and delete the
  `[patch.crates-io]` entry.
- `sspi` goes when a published release no longer contains the
  `invalid MIC token sequence number` check.

Either way, finish with the live RDP suite against a real NLA target.
Resolution and compilation prove nothing about CredSSP — that is exactly
how the `sspi` regression reached a running deployment.

Still outstanding after the upgrade: nothing. The connect future is `Send`
on this release (verified by compiling an `assert_send` against
`connect_finalize`), so the `LocalSet` worker pool in `engine/rdp/mod.rs`
was removed and RDP sessions are now ordinary `tokio::spawn` tasks, like
SSH and VNC.

Two operational constraints came out of the Phase 2 work and belong on
the record:

- Native SSH needs a `host-key-fingerprint` parameter on the connection.
  There is no trust-on-first-use path, so a connection without it stays
  on `guacd`.
- Wire Compatibility Mode needs a monospace font in the backend image.
  Direct Streaming Mode needs none.

## Verification

| Domain | Method | Target |
| --- | --- | --- |
| Protocol conformance | Replay recorded instruction streams through the parser | 100% structural equivalence |
| Parser robustness | `cargo-fuzz` on the instruction parser, the streaming decoder and the media envelope | No panic or unbounded allocation over 72h |
| Live SSH behaviour | `tests/ssh_live.rs` against a throwaway sshd (`docker-compose.ssh-test.yml`) | Shell I/O, keysym translation, PTY resize, host-key pinning, auth rejection || Live RDP behaviour | `tests/rdp_live.rs` against FreeRDP shadow (NLA) and xrdp (non-NLA) | CredSSP completion, framebuffer cropping, input, credential rejection, refusal to negotiate down || Latency | Synthetic input-to-frame on 60 FPS RDP | p50 < 20 ms, p99 < 45 ms |
| Memory | 500 concurrent sessions | > 70% RSS reduction vs `guacd` |
| Credential hygiene | Core-dump inspection after handshake | No plaintext credential remnants |
| Supply chain | `cargo deny check` | Zero advisory / ban / licence violations |

Mocks were never going to be enough for the protocol engines. A mock
cannot tell you whether `russh` negotiates with a real sshd, whether the
remote PTY actually adopts a resize, or whether a translated keysym
arrives at the shell as the character the user pressed — so the SSH
engine is exercised against a real OpenSSH server on an isolated Docker
network. Those tests are `#[ignore]`d, because a test that silently skips
when its target is missing is worse than one that is honestly absent.

## References

- `docs/threat-model.md`
- `docs/adr/ADR-0004-guacd-connection-model.md`
- `docs/adr/ADR-0009-dmz-deployment-mode.md`
- `deny.toml`
