# ADR-0011: Mandatory Persistent JWT Secrets

## Status

Accepted

## Context

Prior to v1.8.3, the Strata Client backend generated a random `JWT_SECRET` on every startup if one was not provided in the `.env` file. While this was secure for ephemeral development environments, it caused all user sessions to be invalidated whenever the backend container was restarted (e.g., during image upgrades or configuration changes). In production environments with frequent updates or auto-scaling, this led to a poor user experience as active sessions were terminated unexpectedly.

## Decision

Starting with v1.8.3, providing a persistent `JWT_SECRET` via the environment is mandatory for production-grade stability.

1.  **Mandatory Secret**: The `.env.example` has been updated to include `JWT_SECRET` as a required variable.
2.  **Persistence**: Using a persistent secret ensures that JWT signatures remain valid across container restarts, as long as the tokens themselves have not expired according to their `exp` claim.
3.  **Security Recommendation**: The secret must be a cryptographically strong random string (minimum 32 characters recommended).

## Consequences

- **Improved Stability**: Maintenance windows and container restarts no longer force all users to log in again.
- **Operator Requirement**: Operators must ensure they generate and store a secure `JWT_SECRET` during the initial deployment.
- **Cross-Instance Compatibility**: Multiple backend replicas can now share the same secret, enabling horizontal scaling without session fragmentation.
