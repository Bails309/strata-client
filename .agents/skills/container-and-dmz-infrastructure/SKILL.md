---
name: container-and-dmz-infrastructure
description: 'Modify and validate Dockerfiles (backend/Dockerfile, frontend/Dockerfile, crates/strata-dmz/Dockerfile), Docker Compose topologies (docker-compose*.yml), Nginx gateway configs (frontend/*.conf, frontend/common.fragment), the strata-dmz Kubernetes Helm chart (deploy/helm/strata-dmz/), or CI/shell scripts (scripts/**, .github/workflows/**). WHEN: changing container build stages, hardening/seccomp/capabilities, Nginx reverse-proxy timeouts or headers, DMZ split-topology mTLS/H2 config, Helm templates/values, or GitHub Actions workflows. DO NOT USE FOR: Rust/React application logic (use api-and-rbac-feature) or cutting a software version release (use release-and-documentation-cut).'
---

# Container, Nginx Gateway, DMZ, and Helm Infrastructure Workflow

Use this skill when modifying Dockerfiles, Docker Compose files, Nginx gateway configuration, the `strata-dmz` Helm chart, shell scripts, or GitHub Actions workflows. Follow [AGENTS.md](../../../AGENTS.md) (§10, §12, §14, §20, §22, §23).

## 1. Discovery and Inspection

1. **Direct file inspection**:
   - Note that Codebase Memory flags `backend/Dockerfile`, `clamav/clamd.conf`, `frontend/http_only.conf`, `frontend/https_enabled.conf`, and `frontend/njs.conf` as `parse_unusable`. Always read Dockerfiles, Nginx configs, Compose files, and Helm templates directly with `read_file` or `grep_search`.
   - Use Codebase Memory (`search_graph` with `project: "C-GitRepos-strata-client"`) to check how environment variables (`EnvVar` nodes) and DMZ link modules (`crates/strata-dmz/`, `backend/src/services/dmz_link/`) are consumed in Rust code.
2. **Consult relevant documentation**:
   - Read only the needed sections of [docs/deployment.md](../../../docs/deployment.md), [docs/deployment-kubernetes.md](../../../docs/deployment-kubernetes.md), [docs/dmz.md](../../../docs/dmz.md), [docs/dmz-implementation-plan.md](../../../docs/dmz-implementation-plan.md), [docs/av-scanning.md](../../../docs/av-scanning.md), and [docs/runbooks/dmz-incident.md](../../../docs/runbooks/dmz-incident.md).

## 2. Container and Runtime Hardening Invariants

1. **`backend/Dockerfile` and `backend` service (`docker-compose.yml`)**:
   - **Workspace stub caching layer**: The builder stage stubs `backend/src/main.rs`, `crates/strata-protocol/src/lib.rs`, `crates/strata-dmz/src/main.rs`, and `crates/strata-session/src/lib.rs`, plus copies `crates/vendor/`. Keep all four workspace members and `crates/vendor/` in sync in both `backend/Dockerfile` and `crates/strata-dmz/Dockerfile` so dependency layer caching never breaks.
   - **Non-root & Chromium sandbox**: Runs as non-root `strata` (via `gosu` in `backend/entrypoint.sh`) with a real home directory (`/home/strata`, required by Chromium crashpad). Do not remove `seccomp=./backend/seccomp-chromium.json` or `no-new-privileges:true`, which enable Chromium's namespace sandbox without `CAP_SYS_ADMIN`.
   - **Fonts**: Keep `fonts-dejavu-core` installed in the runtime image and CI test runners; `strata-session`'s terminal rasteriser requires it for SSH and Kubernetes sessions.
   - **Session capacity**: Keep `STRATA_BACKEND_CPUS` and `STRATA_BACKEND_MEMORY` defaulting to `0` (unlimited) in `docker-compose.yml` so the backend's admission ledger scales with host/cgroup memory rather than artificially capping concurrent sessions.
2. **`frontend/Dockerfile` and Nginx gateway (`frontend/common.fragment`, `frontend/*.conf`)**:
   - Container runs with `read_only: true`, `tmpfs` mounts for `/tmp`, `/var/cache/nginx`, `/var/log/nginx`, `/run`, `/etc/nginx/conf.d`, `no-new-privileges:true`, `cap_drop: [ALL]`, and `cap_add: [NET_BIND_SERVICE]`.
   - **WebSocket tunnel `send_timeout` invariant**: In `frontend/common.fragment`, `location /api/` **must** keep `send_timeout 60s;` (overriding the server-level `send_timeout 10s;`). Nginx uses `send_timeout` (not `proxy_send_timeout`) for Nginx-to-browser writes on upgraded WebSocket connections; lowering it causes 10-second disconnect/reconnect loops on idle tunnels.
3. **`crates/strata-dmz/Dockerfile` and DMZ split-topology (`docker-compose.dmz*.yml`)**:
   - Uses `gcr.io/distroless/cc-debian12:nonroot` (`USER nonroot:nonroot`, uid `65532`), stripped static binary, read-only rootfs, and holds zero Strata business secrets.
   - Enforce `.github/workflows/dmz-deps.yml`: the `strata-dmz` binary must not link forbidden crates (`sqlx`, `vaultrs`, `ldap3`, `krb5`, `strata-session`, etc.) or contain forbidden secret env-var strings (`JWT_SIGNING_KEY`, `OIDC_CLIENT_SECRET`, `VAULT_TOKEN`, `VAULT_ADDR`, `DATABASE_URL`, `GUAC_MASTER_KEY`).
4. **Helm chart (`deploy/helm/strata-dmz/`)**:
   - Chart versioning (`Chart.yaml` `version` and `appVersion`) is **independent** of the application `VERSION` file.
   - Since v2.1.1, no public container images are published to GHCR; `values.yaml` requires the operator to supply `image.repository`, and templates must fail to render when `image.repository` is omitted.
5. **Compose topology registry (`scripts/ci/validate-compose.sh`)**:
   - Every `docker-compose*.yml` file in the repository root **must** be included in `scripts/ci/validate-compose.sh` or the `repo-lint` CI job fails.
6. **Shell script line endings**:
   - Every `*.sh` script (entrypoints, CI scripts, test fixtures) must be saved with LF (`\n`) line endings; CRLF breaks container shebangs (`#!/bin/sh` / `#!/usr/bin/env bash`).

## 3. Validation

Run the exact `repo-lint`, `dmz-deps`, `docker-build`, and `trivy` checks from `.github/workflows/`:

1. **Validate all Docker Compose topologies**:
   ```sh
   sh scripts/ci/validate-compose.sh
   ```
2. **Validate Helm chart lint, render, and required-value guard**:
   ```sh
   docker run --rm -v "$PWD/deploy/helm:/charts:ro" alpine/helm:4.3.0 \
     lint --strict /charts/strata-dmz --set image.repository=registry.example.invalid/strata-dmz
   docker run --rm -v "$PWD/deploy/helm:/charts:ro" alpine/helm:4.3.0 \
     template ci /charts/strata-dmz --set image.repository=registry.example.invalid/strata-dmz > /dev/null
   # Must fail when image.repository is omitted:
   ! docker run --rm -v "$PWD/deploy/helm:/charts:ro" alpine/helm:4.3.0 \
     template ci /charts/strata-dmz > /dev/null 2>&1
   ```
3. **Validate shell scripts (`shellcheck`) and GitHub workflows (`actionlint`)**:
   ```sh
   docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:v0.11.0 \
     --severity=warning $(git ls-files '*.sh')
   docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:1.7.12 -color
   ```
4. **Build container images and verify DMZ binary closure**:
   ```sh
   docker build -f backend/Dockerfile -t strata/backend:scan .
   docker build -f frontend/Dockerfile -t strata/frontend:scan .
   docker build -f crates/strata-dmz/Dockerfile -t strata/strata-dmz:scan .
   ```
   - When changing base images or OS packages in `backend/Dockerfile` or `frontend/Dockerfile`, scan with Trivy (`CRITICAL,HIGH`, `ignore-unfixed: true`) matching `.github/workflows/trivy.yml`.

## 4. Documentation and Completion

- Update [docs/deployment.md](../../../docs/deployment.md), [docs/deployment-kubernetes.md](../../../docs/deployment-kubernetes.md), [docs/dmz.md](../../../docs/dmz.md), or [ARCHITECTURE.md](../../../ARCHITECTURE.md) when container topology, environment variables, ports, or volume mounts change.
