---
name: release-and-documentation-cut
description: 'Prepare a Strata Client release (vX.Y.Z), bump version-bearing files, and author release and reference documentation following the repository five-places rule. WHEN: bumping VERSION/Cargo.toml/Cargo.lock/package.json/package-lock.json, writing CHANGELOG.md or WHATSNEW.md entries, adding RELEASE_CARDS in frontend/src/components/WhatsNewModal.tsx, updating the README.md release table, pruning docs/roadmap.md on minor bumps, or indexing new operational runbooks in docs/runbooks/. DO NOT USE FOR: implementing code features prior to release preparation (use api-and-rbac-feature or session-engine-and-protocol).'
---

# Release Cut and Five-Places Documentation Workflow

Use this skill when preparing a Strata Client release (`vX.Y.Z`) or synchronising release narratives, version manifests, and reference documentation. This workflow is governed by [docs/RELEASE_PROCESS.md](../../../docs/RELEASE_PROCESS.md), [docs/DOCUMENTATION_STANDARDS.md](../../../docs/DOCUMENTATION_STANDARDS.md), and [AGENTS.md](../../../AGENTS.md).

## 1. Pre-Flight and Branch Discipline

1. **Read the authoritative standards first**:
   - Read [docs/RELEASE_PROCESS.md](../../../docs/RELEASE_PROCESS.md) and [docs/DOCUMENTATION_STANDARDS.md](../../../docs/DOCUMENTATION_STANDARDS.md).
2. **Branch check**:
   - `main` is branch-protected. Always verify `git branch --show-current` before making commits; create or switch to `release/X.Y.Z` (or the appropriate feature/fix branch) rather than committing directly to `main`.
   - Never run `git push`, `git tag` push, or `gh release create` without explicit per-action user approval.

## 2. Synchronised Version Bump (7 Files, 10 Locations)

Every app release must update all 7 version-bearing files identically (`VERSION` is the source of truth):

1. [VERSION](../../../VERSION) — whole file (`X.Y.Z`, single line).
2. [package.json](../../../package.json) — top-level `"version": "X.Y.Z"`.
3. [package-lock.json](../../../package-lock.json) — **both** top-level `"version"` **and** `packages[""].version`.
4. [frontend/package.json](../../../frontend/package.json) — top-level `"version": "X.Y.Z"`.
5. [frontend/package-lock.json](../../../frontend/package-lock.json) — **both** top-level `"version"` **and** `packages[""].version`.
6. [Cargo.toml](../../../Cargo.toml) — `[workspace.package] version = "X.Y.Z"`.
7. [Cargo.lock](../../../Cargo.lock) — update the `version = "X.Y.Z"` field on all **four** workspace crates:
   - `strata-backend`
   - `strata-dmz`
   - `strata-protocol`
   - `strata-session`
   - *(Leave `strata-session-fuzz` at `0.0.0`.)*
8. **README badge**: Update the version badge in [README.md](../../../README.md) if it pins the current release.
9. **Exclusions**: Do **not** bump [deploy/helm/strata-dmz/Chart.yaml](../../../deploy/helm/strata-dmz/Chart.yaml) (`strata-dmz` chart versions independently).

Verify synchronization:
```sh
git grep -n "$(cat VERSION)" -- VERSION package.json package-lock.json frontend/package.json frontend/package-lock.json Cargo.toml Cargo.lock
```

## 3. The Five-Places Documentation Rule

Every user-visible release must be documented across all five artefacts in British English (`serialised`, `behaviour`, `licence` as a noun):

1. **[CHANGELOG.md](../../../CHANGELOG.md)**:
   - Prepend `## [X.Y.Z] — YYYY-MM-DD` (never append a title on the `##` line, as that breaks the `#xyz--yyyy-mm-dd` anchor used by `README.md`).
   - Place `### <Release type> — <one-line headline>` on the line below `## [X.Y.Z] — YYYY-MM-DD`.
   - Include all 7 required sections in order: **The ask**, **The symptom**, **The root cause** (linking exact files/functions), **The fix**, **Scope & safety** (explicitly stating schema, API, env-var, and dependency impact), **Testing**, and **Deploy**.
   - Keep older entries immutable; use explicit backfill notes in the new entry if documenting earlier changes.
2. **[WHATSNEW.md](../../../WHATSNEW.md)**:
   - Prepend `# What's New in vX.Y.Z` followed by a single operator-focused blockquote paragraph.
3. **[frontend/src/components/WhatsNewModal.tsx](../../../frontend/src/components/WhatsNewModal.tsx)**:
   - Prepend a new `{ version: "X.Y.Z", subtitle: "...", sections: [...] }` entry to `RELEASE_CARDS`.
   - **Mandatory**: `WHATS_NEW_VERSION` tracks `__APP_VERSION__` (`VERSION`). If the top card in `RELEASE_CARDS` is not updated, every user sees a stale release modal after upgrading.
   - Use **plain text only** in `subtitle` and `description` (no Markdown, no backticks, no links).
4. **[README.md](../../../README.md) (§ What's new)**:
   - Prepend a row to the release table using ASCII hyphens and ending with `([details](CHANGELOG.md#XYZ--YYYY-MM-DD))` (where `XYZ` is the version with dots removed).
5. **Reference documentation (`ARCHITECTURE.md` and `docs/*.md`)**:
   - Update whichever reference pages the release affects ([ARCHITECTURE.md](../../../ARCHITECTURE.md), [docs/architecture.md](../../../docs/architecture.md), [docs/security.md](../../../docs/security.md), [docs/api-reference.md](../../../docs/api-reference.md), [docs/deployment.md](../../../docs/deployment.md), [docs/faq.md](../../../docs/faq.md)) in present tense. Note that `frontend/src/pages/Documentation.tsx` bundles `docs/*.md` via `?raw` at build time automatically.
   - **Runbooks**: Any new runbook under `docs/runbooks/<name>.md` must follow the 8-section runbook template and be indexed in **both** [docs/runbooks/README.md](../../../docs/runbooks/README.md) **and** the runbook table in [docs/architecture.md](../../../docs/architecture.md).
   - **Minor version bumps (`X.Y.0`)**:
     - Prune entries from [docs/roadmap.md](../../../docs/roadmap.md) that shipped in the previous minor line and clear matching keys from `system_settings.roadmap_statuses` via a database migration.
     - Update the supported-versions table in [SECURITY.md](../../../SECURITY.md).

## 4. Formatting and Verification Gates

1. **UTF-8 and Prettier safety on Windows**:
   - Never use PowerShell `Set-Content -Encoding UTF8` (writes UTF-8 BOM and corrupts multi-byte characters like `—`).
   - Never run `prettier --write` on root/docs Markdown files or whole directories. Only format the modified `frontend/src/components/WhatsNewModal.tsx`:
     ```sh
     npx --prefix frontend prettier --write src/components/WhatsNewModal.tsx
     ```
2. **Verify no corrupted glyphs or empty merges**:
   - Check that `CHANGELOG.md` is intact and free of literal `\u2014` escapes.
3. **Run CI verification suite**:
   ```sh
   npm --prefix frontend run format:check
   npm --prefix frontend run lint
   npx --prefix frontend tsc --noEmit
   npm --prefix frontend run test:coverage
   npm --prefix frontend run build
   ```
   And verify Rust formatting, clippy, and tests (`cargo fmt --all -- --check`, `cargo clippy`, `cargo test`) before committing.
