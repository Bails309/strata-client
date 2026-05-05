# Security Policy

Strata Client is a privileged-access proxy. It mediates remote-desktop, SSH,
Kubernetes, and web-kiosk sessions, holds Vault-sealed credentials, and writes
an immutable audit log. We take security reports seriously and aim to
acknowledge new reports within **two business days**.

## Supported versions

We provide security fixes for the latest minor release on the `main` branch.
Older minor lines do **not** receive backports — please upgrade.

| Version    | Supported          |
| ---------- | ------------------ |
| `1.4.x`    | :white_check_mark: |
| `1.3.x`    | :white_check_mark: (critical fixes only, until 2026-08) |
| `< 1.3.0`  | :x:                |

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Use one of the following private channels:

1. **Preferred** — GitHub's *Private vulnerability reporting*:
   <https://github.com/Bails309/strata-client/security/advisories/new>
2. Email `security@strata-client.example` (replace with your real address).
   PGP welcome; key fingerprint published on the maintainer's GitHub profile.

Please include, where possible:

- The Strata Client version (`docker compose exec backend strata-backend --version`
  or the `VERSION` file).
- A description of the issue, the impact, and any preconditions
  (auth required? specific role? specific protocol?).
- Reproduction steps or a proof-of-concept. Synthetic / staging environments
  are strongly preferred over reports against real production tenants.
- Whether the issue is currently being exploited in the wild, to your knowledge.

## What we consider in scope

- Authentication and authorisation bypasses (OIDC, local auth, refresh-token
  flow, RBAC, share tokens, checkout approvals).
- Tunnel / WebSocket abuse: cross-tenant data leakage, recording bypass,
  audit-log evasion, parameter injection into `guacd` not caught by
  `is_allowed_guacd_param`.
- Credential exposure: Vault Transit misuse, envelope-encryption flaws,
  credential leakage in logs, error responses, audit detail blobs, or emails.
- Injection in any user-controlled surface: SQL (`sqlx` raw queries),
  LDAP filter / DN, `kubectl`-style param injection, command-palette `paste-text`
  abuse, file-name handling in Quick Share, recording stream paths.
- guacd patches (`guacd/patches/*.patch`) introducing unsafe behaviour.
- Container / deployment surface: `docker-compose.vdi.yml` (host-root mount),
  the kiosk's `--no-sandbox` posture, the recordings volume gid handling.

## What we consider out of scope

- Denial of service via resource exhaustion of self-hosted infrastructure
  (the operator owns the deployment surface).
- Reports requiring physical access, a malicious browser extension, or a
  compromised endpoint.
- Findings on *example*, *test*, or *demo* deployments unless they reveal a
  defect that would also affect a hardened production deployment.
- Missing security headers on the bundled Nginx config that are explicitly
  documented as operator-tunable in [docs/deployment.md](docs/deployment.md).
- Self-XSS, social-engineering vectors, and clickjacking on pages that
  legitimately render user-controlled HTML inside an `iframe sandbox`.

## Disclosure timeline

Our default coordinated-disclosure window is **90 days** from the date of
acknowledgement. We will:

1. Acknowledge the report within two business days.
2. Triage and confirm severity using CVSS v3.1.
3. Develop, test, and ship a fix — typically as a patch release on the
   currently-supported minor.
4. Publish a GitHub Security Advisory (GHSA) with credit to the reporter
   (unless anonymity is requested).
5. Cross-reference the GHSA from the matching `## [x.y.z]` entry in
   [CHANGELOG.md](CHANGELOG.md).

For high-impact issues we may ship sooner; for low-severity issues we may
batch the fix into the next routine patch release.

## Hall of fame

We are happy to acknowledge security researchers who report responsibly.
If you would like a credit on the published advisory, mention it in your
report.
