# Documentation Standards

This document defines the conventions used across the Strata Client repository for
release notes, what's-new cards, changelogs, API reference entries, and PR-level
documentation changes.

It describes _what_ each artefact must contain. The ordered checklist of _which_
artefacts to touch when cutting a release lives in
[RELEASE_PROCESS.md](RELEASE_PROCESS.md).

---

## 1. The five-places rule

Every user-visible change appears in **five** places, at five levels of detail.
Missing any one of them produces a specific, observable defect — which is why the
rule is stated as a hard requirement rather than a suggestion.

| # | Artefact                                      | Audience               | Length             | Cost of omitting it                                                             |
| - | --------------------------------------------- | ---------------------- | ------------------ | --------------------------------------------------------------------------------- |
| 1 | `CHANGELOG.md`                                | Maintainers, auditors  | As long as needed  | The root cause is lost the moment the author forgets it.                          |
| 2 | `WHATSNEW.md`                                 | Operators              | One blockquote     | No plain-language record of why an upgrade was needed.                            |
| 3 | `frontend/src/components/WhatsNewModal.tsx`   | End users, in-app      | Subtitle + 3–6 sections | **The modal re-shows a stale card to every user after upgrade.**              |
| 4 | `README.md` § What's new                       | Evaluators, GitHub     | One table row      | The repository front page misrepresents the current release.                      |
| 5 | The relevant `docs/*.md` reference page        | Engineers, on-call     | A real section     | The behaviour exists but is undocumented — the most expensive failure of the five. |

Items 1–4 tell the story of a *release*. Item 5 documents the *system as it now
is*, and is written in the present tense with no assumption that the reader knows
a change occurred.

---

## 2. Anatomy of a CHANGELOG entry

Each release is `## [X.Y.Z] — YYYY-MM-DD` followed by a `### <Release type> — <one-line headline>`
and then, in order:

1. **The ask** — the original request or report, quoted verbatim where one exists.
   Verbatim user language is preserved deliberately: it is what future readers will
   search for.
2. **The symptom** — what was observably wrong, including what _looked_ like the
   cause but was not, and how it differed from any superficially similar past
   defect.
3. **The root cause** — the actual mechanism, in enough depth that a reader could
   have found it themselves. Name the files and functions; link them. Where several
   defects compounded, enumerate them.
4. **The fix** — what changed and why that specific approach, including approaches
   rejected and why.
5. **Scope & safety** — an explicit statement covering schema, API surface,
   environment variables, dependencies, and behavioural change. State **"no schema,
   API, env-var, or dependency changes"** when that is the case; an unstated scope
   is indistinguishable from an unconsidered one.
6. **Testing** — what was added, what was run, and what passed.
7. **Deploy** — the exact command, and any operator action the release requires
   (migrations, forced re-login, edge-binary redeploys, one-time recovery steps).

Additional conventions:

- Use tables for advisory metadata, per-path exposure analysis, trigger
  enumerations, and any comparison a reader would otherwise have to assemble
  mentally.
- Keep older entries immutable. Corrections are made in the newest entry with a
  backfill note, never by silently editing history.
- If an earlier release shipped something that was never documented, backfill it in
  the current entry and say that it is a backfill.

---

## 3. Version bumps

`VERSION` is the single source of truth for the release string, but seven files
carry it. See the table in
[RELEASE_PROCESS.md § 2](RELEASE_PROCESS.md#2-bump-the-version--every-version-bearing-file)
for the authoritative list, which includes both `package-lock.json` files and the
four workspace crate entries in `Cargo.lock` (`strata-backend`, `strata-dmz`,
`strata-protocol`, `strata-session`).

`deploy/helm/strata-dmz` versions independently and is **not** bumped on an app
release.

---

## 4. API documentation

`docs/api-reference.md` is authoritative for the REST and WebSocket surfaces. Add
new endpoints, error codes, audit-event variants, and environment variables **at
the time of the code change**, not at release time.

- Document the failure modes, not just the happy path: every non-2xx status the
  handler can return, and the condition that produces it.
- Behavioural notes that change how an existing endpoint responds are tagged with
  the version that introduced them (e.g. "(v1.14.4 note)").
- Requirements that are not visible in a request or response but that a mixed-version
  deployment could violate — minimum dependency versions, transport floors — belong
  here too, because this is the page an integrator reads.
- Link out to `docs/*.md` for operational depth rather than duplicating it.

---

## 5. Architecture & security

- `ARCHITECTURE.md` is the **1-page executive summary**: at-a-glance, containers,
  trust boundaries, key data flows, and where to read next. It must stay short
  enough to read in one sitting.
- `docs/architecture.md` carries the detailed diagrams, container internals,
  protocol descriptions, and per-subsystem sections.
- `docs/security.md` carries the threat model, trust boundaries, encryption
  details, RBAC matrix, hardening measures, and supply-chain posture.

Security-relevant changes state the trust boundary they affect and whether the
relevant code path is reachable pre- or post-authentication. "Pre-authentication"
is called out explicitly wherever it applies.

Architecture Decision Records live in `docs/adr/` and record _why_ a design was
chosen and what was rejected. Operational runbooks live in `docs/runbooks/` and
must be indexed in both `docs/runbooks/README.md` and the runbook table in
`docs/architecture.md`.

---

## 6. What's-new modal

`frontend/src/components/WhatsNewModal.tsx` holds the `RELEASE_CARDS` array,
ordered **newest first**.

- Each card is `{ version, subtitle, sections[] }`; the subtitle is a single dense
  paragraph and sections are titled `{ title, description }` pairs.
- Card copy is **plain text rendered in the SPA** — no markdown, no backticks, no
  file links. Spell out symbols in prose (`vite to postcss to nanoid`, not a code
  span).
- Only add a card for versions with changes worth surfacing to an end user, but
  note that the dismissal key advances with `APP_VERSION` regardless: if the newest
  card is older than the running version, every user sees a stale release card
  after upgrading.
- The content must be consistent with `WHATSNEW.md` and `CHANGELOG.md`. Three
  descriptions of the same change that disagree are worse than one.

---

## 7. Linking

- Use workspace-relative links from the repository root:
  `[docs/architecture.md](docs/architecture.md)`.
- Inside `docs/`, link between pages relatively (`[security.md](security.md)`) and
  up to the root with `../` (`[deny.toml](../deny.toml)`).
- Link to a heading anchor where one exists
  (`security.md#dependency--supply-chain-security`) — note that GitHub renders an
  em dash or `&` in a heading as an extra hyphen in the anchor.
- CHANGELOG cross-references use the release anchor form
  `CHANGELOG.md#1145--2026-08-18`.
- Reference code by path and symbol so the claim can be checked:
  `` [`services/safeguard/mod.rs`](backend/src/services/safeguard/mod.rs) ``.

---

## 8. Style

- British English in prose (`serialised`, `behaviour`, `licence` as a noun).
- Em dashes for parenthetical breaks; ASCII hyphens inside the README release
  table, which is already dense with punctuation.
- Code identifiers, file paths, environment variables, and wire-protocol opcodes
  always in backticks.
- Prefer a table over a paragraph whenever the content is a comparison, an
  enumeration of cases, or a mapping.
- Prose is written for a reader who does **not** already know the answer. Avoid
  "simply", "just", and "obviously".

---

## 9. Review

- Documentation changes are reviewed in the same PR as the code they describe
  wherever possible. If a dedicated docs PR is unavoidable, link it to the release
  branch.
- A change is not complete until the five-places rule is satisfied for it.
- Prettier formats markdown alongside source; run
  `npm --prefix frontend run format` before committing documentation edits that
  touch the frontend workspace.

