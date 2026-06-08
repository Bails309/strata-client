# Documentation Standards

This document defines the conventions used across the Strata Client repository for release notes, whats‑new cards, changelogs, API reference entries, and PR-level documentation changes.

1. Release notes
   - Keep a canonical `CHANGELOG.md` that follows Keep a Changelog and semver grouping. Each release header must include date and short summary.
   - For each patch/minor release add a short whats‑new card in `WHATSNEW.md` and an in‑app `RELEASE_CARDS` entry in `frontend/src/components/WhatsNewModal.tsx` with newest-first ordering.

2. Version bumps
   - The top-level `VERSION` file is the single source of truth for the repo release string. Bump `package.json`, `frontend/package.json`, and the workspace `Cargo.toml` `version` when preparing a release.

3. API documentation
   - Keep `docs/api-reference.md` authoritative for REST + WebSocket surfaces. Add new endpoints or behavioural notes there at the time of code change. Link to `docs/*` pages for deeper operational detail.

4. Architecture & security
   - `ARCHITECTURE.md` is the 1‑page executive summary; `docs/architecture.md` and `docs/security.md` must contain detailed diagrams, trust boundaries, and migration notes.

5. Whats‑new modal
   - `frontend/src/components/WhatsNewModal.tsx` holds the `RELEASE_CARDS` array used in the in‑app UI. Always add a card there when shipping user-visible fixes and mirror the same content into `WHATSNEW.md` and `CHANGELOG.md`.

6. Release process
   - Create a release branch `release/X.Y.Z` and a corresponding docs branch `docs/complete-history-X.Y.Z` when preparing a release.
   - Small, focused commits per-file (e.g. `docs: update CHANGELOG for vX.Y.Z`, `docs(frontend): add whatsnew card vX.Y.Z`).

7. Linking
   - When referencing files in markdown use workspace-relative links (e.g. `[docs/architecture.md](docs/architecture.md)`).

8. Review
   - Docs changes should be reviewed in the same PR as release-bump commits where possible. If not, open a dedicated docs PR and link the release branch.

These standards are intentionally lightweight. The goal is consistent, discoverable release narrative and minimal drift between in‑app, repo-level, and website documentation.
