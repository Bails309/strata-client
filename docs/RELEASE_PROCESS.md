# Release Process (short checklist)

This checklist documents the steps used to prepare a Strata Client release.

1. Create release branch

   ```sh
   git checkout -b release/X.Y.Z
   ```

2. Bump versions

   - Update `VERSION` to `X.Y.Z`.
   - Update `package.json` and `frontend/package.json` `version` fields.
   - Update `Cargo.toml` workspace `version`.

3. Update changelog and whatsnew

   - Add a `## [X.Y.Z] — YYYY-MM-DD` section to `CHANGELOG.md` describing fixes.
   - Add a brief `WHATSNEW.md` entry and an in-app whats‑new `RELEASE_CARDS` entry in `frontend/src/components/WhatsNewModal.tsx`.

4. Docs and architecture

   - Update `ARCHITECTURE.md` / `docs/architecture.md` if there are topology or protocol changes.
   - Update `docs/api-reference.md` for new/changed endpoints or behaviours.

5. Tests & formatting

   - `cargo fmt --all -- --check`
   - `npm --prefix frontend run format:check`
   - Run unit and integration tests as appropriate.

6. Commit

   - Use focused commits, e.g.: `chore(release): bump version to X.Y.Z`, `docs: add whatsnew card vX.Y.Z`, `docs: update CHANGELOG for vX.Y.Z`.

7. Push & PR

   ```sh
   git push -u origin release/X.Y.Z
   gh pr create --base main --head release/X.Y.Z --fill
   ```

   - Add reviewers and link any relevant runbooks or test results.

8. CI / build

   - Ensure CI build passes. If there are packaging steps (images) run them locally:

   ```sh
   docker compose build backend frontend
   ```

9. Tag & release

   - After merge to `main`, create an annotated tag and GitHub release:

   ```sh
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   gh release create vX.Y.Z --notes-file CHANGELOG.md
   ```

10. Post-release

   - Update any downstream deploy manifests, helm charts, or operator runbooks.
   - Announce release and link PRs and notable commits.

*** End Patch