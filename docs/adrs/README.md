# Architecture Decision Records (ADRs)

This directory captures significant architecture decisions for Strata Client.
Each ADR documents *why* a given design was chosen, what alternatives were
considered, and what follow-up actions (if any) the decision carries.

## Format

We use the lightweight **Michael Nygard** template:

```markdown
# ADR-XXXX: <Short noun phrase>

- **Status:** Proposed | Accepted | Superseded by ADR-YYYY | Deprecated
- **Date:** YYYY-MM-DD
- **Deciders:** Names / teams

## Context
What is the issue that we're seeing that is motivating this decision?

## Decision
What is the change that we're proposing or have agreed to implement?

## Consequences
What becomes easier or harder to do because of this change?

## Alternatives considered
Briefly, what else was on the table and why it was rejected.
```

## Conventions

1. **Filename**: `NNNN-kebab-case-title.md`, zero-padded 4-digit sequence
   (e.g. `0001-architecture-baseline.md`). Never reuse a number.
2. **Status transitions** are additive: when a later ADR supersedes this one,
   update the Status line to `Superseded by ADR-YYYY` — do **not** delete the
   superseded ADR.
3. **One decision per ADR**. If a PR naturally groups several decisions,
   write several small ADRs.
4. **Link** the ADR from any PR, runbook, or code comment that depends on the
   decision so future readers can trace the rationale.
5. **Immutability**: once an ADR is Accepted, its Context/Decision sections
   are not rewritten. New information → new ADR that supersedes.

## Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| [ADR-0001](./0001-architecture-baseline.md) | Architecture baseline (Rust + Axum + Vault Transit + JWT + guacd) | Accepted | 2026-04-21 |

When a new ADR lands, add it to this table. Keep the list newest-first **or**
strictly ascending by ID — whichever the team agrees; currently: ascending.
