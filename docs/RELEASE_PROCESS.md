# Release Process

This is the authoritative checklist for preparing a Strata Client release. It is
deliberately exhaustive: every step listed here exists because skipping it has
caused observable drift at least once.

> **Companion document:** [DOCUMENTATION_STANDARDS.md](DOCUMENTATION_STANDARDS.md)
> defines _what_ each documentation artefact must contain. This document defines
> _which_ artefacts to touch and in what order.

---

## 1. Create the release branch

```sh
git switch -c release/X.Y.Z
```

> `main` is **branch-protected** — a direct push is rejected with
> `GH013: Changes must be made through a pull request`. Always confirm you are on
> the release branch with `git branch --show-current` **before** the first commit;
> a stray commit on local `main` has to be cherry-picked back out.

---

## 2. Bump the version — every version-bearing file

`VERSION` is the single source of truth for the release string, but it is not the
only file that carries it. **All** of the following must agree, or the in-app
"What's New" gate, the container labels, and the crate metadata will disagree
with each other:

| File                                       | Field(s)                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `VERSION`                                  | whole file                                                                   |
| `package.json`                             | `version`                                                                    |
| `package-lock.json`                        | top-level `version` **and** `packages[""].version`                            |
| `frontend/package.json`                    | `version`                                                                    |
| `frontend/package-lock.json`               | top-level `version` **and** `packages[""].version`                            |
| `Cargo.toml`                               | `[workspace.package] version`                                                |
| `Cargo.lock`                               | the `strata-backend`, `strata-dmz`, `strata-protocol` **and** `strata-session` package entries |

Notes:

- The four workspace crates use `version.workspace = true`, so their `Cargo.toml`
  files need no edit — but their `Cargo.lock` entries are literal strings and **do**.
  The fuzz crate stays at `0.0.0` and must not be bumped. `strata-session` joined
  the workspace in v2.0.0; this table listed only three crates until then.
- The **root** `package-lock.json` is easy to forget because the root package has
  almost no dependencies. It silently sat at `1.8.4` from v1.8.4 until v1.14.5 for
  exactly this reason.
- `deploy/helm/strata-dmz` has **independent** versioning (`chart` / `appVersion`)
  and is **not** tied to `VERSION`. Do not bump it on an app release.

Verify with:

```sh
git grep -n "$(cat VERSION)" -- VERSION package.json package-lock.json frontend/package.json frontend/package-lock.json Cargo.toml Cargo.lock
```

---

## 3. Write the release narrative

Four artefacts, same story, four levels of detail. See
[DOCUMENTATION_STANDARDS.md](DOCUMENTATION_STANDARDS.md) for the required anatomy
of each.

1. **`CHANGELOG.md`** — prepend `## [X.Y.Z] — YYYY-MM-DD`. The full technical
   write-up: the ask, the symptom, the root cause, the fix, scope & safety,
   testing, and deploy instructions.
2. **`WHATSNEW.md`** — prepend `# What's New in vX.Y.Z` followed by a single
   blockquote paragraph. Written for an operator, not a maintainer.
3. **`frontend/src/components/WhatsNewModal.tsx`** — prepend an entry to
   `RELEASE_CARDS`. **This is not optional.** The modal's dismissal key advances
   with `APP_VERSION`, so if the top card is stale the modal re-shows an old
   release to every user after the upgrade.
4. **`README.md` § What's new** — prepend a row to the release table, ending with
   `([details](CHANGELOG.md#XYZ--YYYY-MM-DD))`. Note the table uses ASCII hyphens,
   not em dashes.

---

## 4. Update the reference documentation

Touch whichever of these the change affects — and state explicitly in the
CHANGELOG when the answer is "none":

- `ARCHITECTURE.md` — the 1-page executive summary; update if a trust boundary or
  key data flow moved.
- `docs/architecture.md` — detailed topology, protocol, and data-flow sections.
- `docs/security.md` — threat model, trust boundaries, hardening, supply chain.
- `docs/api-reference.md` — any new or changed REST/WebSocket surface, error code,
  audit event, or environment variable.
- `docs/deployment.md` — operator-facing upgrade notes and diagnostics.
- `docs/faq.md` — if the change alters an answer a user would search for.
- `docs/runbooks/` — add or update a runbook for anything an on-call engineer may
  have to diagnose, and index it in `docs/runbooks/README.md` **and** the runbook
  table in `docs/architecture.md`.
- `docs/roadmap.md` — on **minor** bumps only, prune entries shipped during the
  previous minor line and clear the matching `system_settings.roadmap_statuses`
  keys in the same change.

> Documentation under `docs/*.md` is imported into the in-app `/docs` page via
> `?raw` at build time by `frontend/src/pages/Documentation.tsx`. Editing those
> files flows straight through to the SPA — there is no registry to update.

---

## 5. Verify

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
npm --prefix frontend run format:check
npm --prefix frontend run lint
npx --prefix frontend tsc --noEmit
npm --prefix frontend run test:coverage
npm --prefix frontend run build
```

For dependency-bearing releases also run the supply-chain gates locally:

```sh
cargo audit --deny unsound --deny unmaintained
cargo deny --all-features check bans licenses sources
npm --prefix frontend audit --audit-level=high --omit=dev
```

Backend tests run in a container — the backend is a **bin** crate with no lib
target, so filter with
`cargo test -p strata-backend --bin strata-backend <filter>`.

---

## 6. Commit

Small, focused commits, one concern each:

```
chore(release): bump version to X.Y.Z
docs: add CHANGELOG entry for vX.Y.Z
docs(frontend): add What's New card for vX.Y.Z
docs: document <subject> in security/architecture reference
```

---

## 7. Push and open the PR

```sh
git push -u origin release/X.Y.Z
gh pr create --base main --head release/X.Y.Z --fill
```

Link any relevant runbooks, advisories, or test output in the PR body.

---

## 8. CI

The full pipeline must be green: secrets scan, dependency audit, migrations,
backend, frontend, E2E, and Docker build. To reproduce the packaging step
locally:

```sh
docker compose build backend frontend
```

---

## 9. Tag and release

After the PR merges to `main`:

```sh
git switch main && git pull
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --notes-file CHANGELOG.md
```

Pushing the tag publishes **no** container images: since v2.1.1 there is no
release workflow and nothing is pushed to GitHub Container Registry. Build the
tagged images and push them to the private registry:

```sh
git switch --detach vX.Y.Z
docker compose build backend frontend
for svc in backend frontend; do
  docker tag "strata/$svc:latest" "$REGISTRY/$svc:X.Y.Z"
  docker push "$REGISTRY/$svc:X.Y.Z"
done
```

Record the pushed digests in the release notes so deployments can pin by
digest ([deployment.md § Image provenance](deployment.md#image-provenance-private-registry)).
For DMZ topologies, build and push `strata-dmz` the same way from
`crates/strata-dmz`.

---

## 10. Post-release

- Update downstream deploy manifests, Helm charts, and operator runbooks.
- Confirm the in-app **What's New** modal shows the new card on a fresh load — a
  stale top card here is the most common release-documentation defect.
- Announce the release, linking the CHANGELOG anchor and any operator action the
  release requires (migrations, forced re-login, edge-binary redeploys).
