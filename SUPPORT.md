# Getting help with Strata Client

Thanks for using Strata Client. This page tells you the right place to ask,
based on what you need.

## I have a question — "how do I…?"

Use **GitHub Discussions**:
<https://github.com/Bails309/strata-client/discussions>

Good fits for Discussions:

- "How do I configure OIDC against Keycloak / Entra ID / Okta?"
- "What's the right way to scale guacd horizontally?"
- "Can I run Strata behind an existing reverse proxy?"
- "How do I import existing connections from another tool?"

If your question can be answered by reading docs first, please skim:

- [docs/faq.md](docs/faq.md) — start here; covers the most common operator questions.
- [README.md](README.md) — capabilities and quick-start.
- [docs/architecture.md](docs/architecture.md) — how the pieces fit.
- [docs/deployment.md](docs/deployment.md) — production deployment + upgrades.
- [docs/security.md](docs/security.md) — auth, RBAC, encryption, audit.
- [docs/api-reference.md](docs/api-reference.md) — REST + WebSocket surface.
- [CHANGELOG.md](CHANGELOG.md) — what changed and when.

## I think I found a bug

Open a **GitHub Issue** using the *Bug report* template:
<https://github.com/Bails309/strata-client/issues/new/choose>

Please include:

- Strata Client version (`cat VERSION` or the badge in the SPA's About page).
- Deployment topology (bundled Postgres / Vault, or external?).
- Steps to reproduce.
- Expected vs. actual behaviour.
- Logs from the relevant container — `docker compose logs --tail=200 backend`
  and/or `guacd`. **Redact** any tokens, hostnames, or credentials.

## I have a feature request

Open a **GitHub Issue** using the *Feature request* template, or — for
larger ideas — start a **Discussion** in the *Ideas* category first so we
can shape it together before any code is written.

## I think I found a security issue

**Do not** open a public issue. Follow [SECURITY.md](SECURITY.md) for the
private-disclosure process.

## I want to contribute code

Read [CONTRIBUTING.md](CONTRIBUTING.md). It covers local dev setup, the
coding standards we enforce in CI, the migration policy, and the PR
checklist.

## I'm an operator running Strata in production

The runbooks in [docs/runbooks/](docs/runbooks/) cover the recurring
operational scenarios (certificate rotation, database operations, disaster
recovery, security incident response, SMTP troubleshooting, Vault
operations). For anything not covered there, open a Discussion in the
*Q&A* category — chances are other operators have hit the same thing.

## Commercial support

This project is community-supported under the Apache-2.0 licence. Commercial
support, custom integrations, and managed hosting are not currently offered
by the maintainers; if that changes, this page will be updated.
