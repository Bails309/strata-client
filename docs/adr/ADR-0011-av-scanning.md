# ADR-0011 — Antivirus scanning trait: pluggable backends, fail-closed default, opt-in sidecar

- **Status:** Accepted
- **Date:** 2026-06-09
- **Wave:** v1.12.0 (file-mover hardening)
- **Related standards:** §4 (authn/z), §12 (protocol handling), §16 (DLP / file egress), §26 (audit)
- **Related docs:** [av-scanning.md](../av-scanning.md), [security.md](../security.md), [threat-model.md](../threat-model.md) §2.11
- **Supersedes:** —
- **Superseded by:** —

## Context

Through v1.11.x, the Quick Share file mover had no in-product
malware check on either direction:

- **Inbound** (`POST /api/files/upload`): operator drags a file
  into the Quick Share panel, file is stored in the
  session-scoped file store, a random unguessable URL is minted,
  and the user pastes the URL into the remote session shell to
  fetch it via `curl` / `wget` / `Invoke-WebRequest`. If the
  source file was infected, the malware reached the remote host
  through Strata with no audit trail recording the transfer
  involved an executable.
- **Outbound** (`POST /api/user/outbound-shares/submit` plus the
  v1.11.0 token-auth shell-side `POST
  /api/outbound-shares/ingest/{token}`): file leaves the remote
  session, is sealed by Vault Transit, runs through a built-in
  keyword-matching DLP heuristic, and is either auto-approved
  (low score + per-user opt-in) or queued for an approver. The
  DLP scanner caught keyword leaks but had no notion of
  executable malware.

Two distinct customer events forced this decision in mid-2026:

1. A compliance auditor at a Tier-1 deployment flagged the
   missing scan because the `outbound_share.requested` audit
   trail recorded the row without any "this file was scanned"
   attestation. Adding one out-of-band meant either
   side-loading a transparent proxy or modifying the backend at
   every site.
2. A real-world EICAR smoke test by another customer surfaced
   a Quick Share upload of a known-bad sample that completed
   cleanly. The file never touched a scanner on the way through
   Strata because Strata never asked one.

Options on the table:

| Option | Pros | Cons |
|---|---|---|
| **A. Hard-code `clamd` as a required dependency** | Smallest API surface; one less knob to misconfigure | Forces every deployment to run a ClamAV sidecar (~3 GB RAM); offends sites that have standardised on a commercial engine; breaks the existing "single-binary monolith works out of the box" property |
| **B. Pluggable trait, three backends ship (`off`/`clamav`/`command`)** | Default-off preserves v1.11.x behaviour; sites can pick their own engine; no new Cargo dependencies | Bigger surface to test; need to document the wire protocol + exit-code contract |
| **C. Out-of-band proxy (e.g. ICAP)** | Standardised industry pattern (Squid, Symantec PE) | Adds an ICAP daemon to the deployment topology; latency unpredictable; no Rust ICAP client is well-maintained |
| **D. Post-upload async scan with quarantine** | Doesn't add latency to the upload path | Files can be downloaded before the scan completes; defeats the point of inbound scan; vastly more state to manage |

A fourth, softer requirement: the operator experience must keep
working in single-binary monolith deployments where no AV
infrastructure is available, so the default cannot require any
new container.

## Decision

**Accept option B: a `Scanner` trait in `backend/src/services/av.rs`
with three concrete implementations (`OffScanner`,
`ClamAvScanner`, `CommandScanner`), wired into both Quick Share
upload paths, with fail-closed defaults and an opt-in `clamav`
compose profile.**

### Trait shape

```rust
#[async_trait]
pub trait Scanner: Send + Sync + std::fmt::Debug {
    async fn scan(&self, path: &Path, file_size_bytes: u64) -> Verdict;
    fn backend_name(&self) -> &'static str;
}

pub enum Verdict {
    Clean,
    Infected { signature: String },
    Skipped  { reason:    String },
    Error    { message:   String },
}

pub enum FailMode { Block, Allow }
```

The four-variant `Verdict` enum is deliberate:

- `Clean` and `Infected` are unambiguous engine answers.
- `Skipped` covers the two legitimate "no scan happened, pass"
  cases: backend is `off`, or the file exceeds the operator-set
  size ceiling. The handler treats `Skipped` as a pass under
  every fail-mode.
- `Error` is the one case where fail-mode actually matters —
  scanner timeout, daemon down, command not found, panic. Under
  the default `FailMode::Block` (per §4.5 — secure defaults) the
  upload is rejected; under `Allow` it passes through with the
  error captured in the audit row.

`Verdict::blocks(fail_mode)` is the one and only call site that
turns a verdict into a block/pass decision. This keeps the
fail-mode policy in one place; route handlers don't reach into
verdict internals.

### Three concrete implementations

#### `OffScanner` (default)

Returns `Skipped { reason: "scanning disabled" }`. Zero
overhead; the handler still calls `scan()` so the audit pipeline
is consistent.

#### `ClamAvScanner`

Implements the ClamAV `clamd` `INSTREAM` TCP wire protocol
directly against `tokio::net::TcpStream`. No `clamdscan`
shell-out, no shared filesystem mount. The full protocol is a
9-line state machine: opener `zINSTREAM\0`, length-prefixed
64 KB chunks (big-endian `u32`), terminator `0u32`, read
null-terminated response and parse `stream: OK` /
`stream: <SIG> FOUND` / `<error> ERROR`. Wrapped in a
`tokio::time::timeout` deadline per scan.

#### `CommandScanner`

Exec-driven contract: `0 = clean, 1 = infected, other = error`.
The command line is whitespace-split into an argv vector and
dispatched via `tokio::process::Command` with no shell wrapper.
`{path}` placeholder substitution, or path-appended if no
placeholder is present. Signature extraction parses the last
non-empty stdout line, falling back to stderr, with `Threat: `
and `Found: ` prefixes stripped. Works for Microsoft Defender,
Sophos, ESET, or any wrapper script.

### Fail-closed defaults

`STRATA_AV_FAIL_MODE=block` is the default for the same reason
`SameSite=Strict` is the default in
[ADR-0002](ADR-0002-csrf-samesite-strict.md): a silently-degraded
security control is worse than no control, because operators
assume it's working.

The default `STRATA_AV_BACKEND=off` is **not** in tension with
this — `off` is a no-op that the audit pipeline records
explicitly, so a deployment with no scanner is honest about not
having one. The fail-closed-default rule applies once an operator
chooses to opt in: at that point a scanner outage rejects rather
than silently passes.

**Infected verdicts are always rejected regardless of fail-mode.**
There is no override knob, by design — a `command` backend that
returns exit code 1 is treated as an unambiguous "infected"
signal whether the file is huge, the scanner is slow, or the
day is Sunday.

### Opt-in sidecar via compose profile

The new `clamav` service in `docker-compose.yml` lives behind the
opt-in `av` compose profile (`docker compose --profile av up -d`).
This preserves the v1.11.x property that `docker compose up -d`
on a fresh checkout produces a working stack — no operator has
to disable an unwanted scanner. Sites that want scanning enable
the profile and flip `STRATA_AV_BACKEND` in one operation.

### Row-attached audit state

The `outbound_shares` table gains four nullable columns via
migration `078_av_scanning.sql`:

- `av_scan_status` (`clean` | `infected` | `skipped` | `error`)
- `av_signature` (engine-reported signature on infected rows)
- `av_scanned_at` (TIMESTAMPTZ)
- `av_scanner_backend` (`off` | `clamav` | `command`)

Plus a partial index over `(av_scan_status) WHERE status IN
('infected','error')` so the operator-attention dashboard query
stays cheap as the table grows. All four columns are nullable so
v1.11.x rows render as "Pre-AV (v1.11.x)" without an alarming
red badge.

The audit-event extensions (`av_status`, `av_signature`,
`av_backend` keys on every `outbound_share.requested` row) make
the outbound flow self-attesting for compliance review without
needing to cross-reference an external SIEM.

### No new Cargo dependencies

The ClamAV INSTREAM protocol is implemented directly against
`tokio::net::TcpStream` (the wire format is small enough to live
in one file). The `command` backend uses
`tokio::process::Command`. Both are stdlib + existing tokio. We
explicitly rejected pulling in `clamav-client` or similar crates
because (a) the protocol is trivial enough to vendor, (b) we
control the timeout / cancellation behaviour end-to-end, and (c)
adding a third-party dependency in the upload hot-path means
that crate now has a supply-chain-attestation responsibility.

## Consequences

### Positive

- **Default-off** preserves v1.11.x behaviour bit-for-bit. No
  surprise blocks on upgrade.
- **Three backends cover the full operator-engine spectrum** —
  sites with ClamAV in-house, sites standardised on a commercial
  engine, and sites that don't want scanning at all.
- **Fail-closed by default** makes the security-control posture
  match operator expectations (when AV is on, AV is on).
- **Row-attached verdict** makes the outbound flow
  self-attesting for compliance review.
- **No new Cargo dependencies** keeps the supply-chain attack
  surface bounded and the build reproducible.
- **No new sidecar required** for the default deployment shape;
  opt-in compose profile keeps the small-deployment story intact.

### Negative

- **Bigger surface to test** — three backends × four verdict
  variants × two fail-modes. We address this with 15 unit tests
  in `services::av` covering verdict tagging, fail-mode
  semantics, argv building, signature extraction, oversize-skip,
  and the three command-scanner exit-code paths.
- **The `command` backend's exit-code contract is opinionated** —
  any scanner that doesn't return `0`/`1` cleanly requires a
  wrapper script. We accept this because the alternative (a
  per-engine adapter for Defender, Sophos, ESET, …) would
  balloon the maintenance surface for marginal benefit.
- **ClamAV's resource footprint is non-trivial** (~1.4 GB
  resident DB, ~3 GB cap on the bundled sidecar). This is the
  upstream's baseline — the trait abstraction means sites that
  can't spare the memory route to the `command` backend
  instead.
- **No streaming upload while scanning** — the file must land
  fully on disk before `scan()` is called, because the INSTREAM
  protocol needs a known length per chunk and the `command`
  backend needs a file path. This is fine for Quick Share's
  500 MB per-file ceiling but rules out scanning a multi-GB
  streamed body without buffering it. We accept this because
  Quick Share has never supported streamed uploads.

### Neutral

- **Helm chart guidance** is documented in
  [deployment-kubernetes.md](../deployment-kubernetes.md) but
  the chart itself does not bundle a ClamAV sidecar
  (intentionally — chart users are expected to compose with
  their own clamav workload or use the `command` backend with
  a re-based backend image).

## Alternatives considered

1. **Hard-code `clamd` as a required dependency.** Rejected
   because it offends sites that have standardised on a
   commercial engine and breaks the single-binary-monolith
   story.
2. **ICAP proxy.** Rejected because (a) no well-maintained Rust
   ICAP client exists, (b) adds an entire daemon to the
   deployment topology, and (c) latency is unpredictable
   because ICAP servers vary wildly in implementation quality.
3. **Post-upload async scan with quarantine.** Rejected because
   files can be downloaded before the scan completes, which
   defeats the point of an inbound scan. The async pattern
   does make sense for *outbound* (where the file sits in
   pending-approval anyway), but landing both directions on the
   same synchronous trait is much smaller surface than running
   two scan models in parallel.
4. **Run AV inside the backend container directly** (e.g.
   `libclamav-rs` static link). Rejected because (a) `libclamav`
   has C-level CVEs about once a year and we'd want signature
   updates without a backend rebuild, (b) the backend container
   would grow by ~1.5 GB, (c) signature reloads would require a
   backend restart.

## Implementation notes

- Scanner construction: `services::av::build(&cfg)` returns
  `Arc<dyn Scanner>`. Called once at backend boot in
  `main.rs::build`, stored in `AppState::av_scanner`.
- `AppState` also carries `av_fail_mode: FailMode` so both fields
  are accessible from route handlers without re-parsing env.
- Test fixtures: 10 backend test fixtures across
  `routes/{auth, mod, health, user, admin}.rs` seed
  `av_scanner: Arc::new(OffScanner), av_fail_mode:
  FailMode::Block` on AppState construction.
- Wire-protocol source of truth:
  [backend/src/services/av.rs](../../backend/src/services/av.rs).
- Migration: `backend/migrations/078_av_scanning.sql`.

## Status review

- **v1.12.0**: Accepted, shipped. 15 unit tests passing. EICAR
  smoke test green on the bundled sidecar.
- **Revisit:** if (a) a Rust ICAP client matures and a customer
  needs ICAP, or (b) the trait surface needs per-role policy
  (currently global) — see
  [roadmap.md → Per-role AV scan-policy editor](../roadmap.md#per-role-av-scan-policy-editor)
  for the proposed direction.

## Related

- [av-scanning.md](../av-scanning.md) — operator deep-dive
- [runbooks/av-operations.md](../runbooks/av-operations.md) — on-call procedures
- [security.md](../security.md) — outbound Quick Share mitigation table
- [threat-model.md](../threat-model.md) §2.11 — STRIDE for the Quick Share file mover
- [CHANGELOG.md](../../CHANGELOG.md#1120--2026-06-09) — v1.12.0 release notes
- [ADR-0002 — CSRF SameSite=Strict](ADR-0002-csrf-samesite-strict.md) — precedent for fail-closed-by-default security controls
- [ADR-0006 — Vault Transit envelope](ADR-0006-vault-transit-envelope.md) — outbound submissions are scanned *before* sealing
