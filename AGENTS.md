# AI Engineering Instructions

## 1. Purpose

These instructions apply to all AI-assisted work in this repository, including work performed through VS Code, GitHub Copilot, Google Antigravity and other compatible agents.

Deliver the smallest safe, maintainable and production-ready solution that satisfies the requirement. Changes must:

- Follow established architecture and engineering patterns.
- Work through the real application path end to end.
- Use secure, supported and compatible technologies.
- Avoid fake production behaviour, disconnected components and unnecessary dependencies.
- Preserve security, privacy, data integrity, compatibility and operability.
- Be tested and validated in proportion to scope and risk.
- Keep code, configuration, infrastructure, tests and documentation aligned.

Do not optimise merely for generating code quickly. Do not claim functionality works without appropriate evidence.

---

## 2. Authority and source of truth

Use this priority when interpreting a task:

1. The user's current requirement and explicit acceptance criteria.
2. This file and any applicable directory-scoped `AGENTS.md` files.
3. Current source code, configuration, schemas and Infrastructure as Code.
4. Relevant maintained documentation under `/docs`.
5. Existing tests and defined behavioural contracts.

Codebase Memory is a discovery and analysis mechanism for locating and understanding repository evidence. It does not override the underlying files, and stale index data is not authoritative.

The current implementation demonstrates current behaviour, but does not automatically prove intended, secure or supported behaviour.

If evidence conflicts:

- Identify the discrepancy rather than silently choosing a convenient interpretation.
- Determine intended behaviour from the strongest available evidence.
- Do not reproduce an insecure, unsupported or defective pattern merely because it exists.
- Update documentation when an intentional change makes it inaccurate.
- Report material uncertainty when intent cannot be established safely.

---

## 3. Documentation

Detailed project knowledge belongs under `/docs`; agent behaviour belongs in `AGENTS.md`.

Before significant work:

1. Identify documentation relevant to the task.
2. Read only the relevant documents or sections.
3. Verify material assumptions against the current implementation.
4. Use Codebase Memory to locate related documentation where useful.

Consult applicable documentation for architecture, development standards, security, identity, APIs, data, dependencies, infrastructure, deployment, operations and troubleshooting.

Do not automatically load all of `/docs`. Do not duplicate large sections of `/docs` in this file or in source comments.

Update relevant documentation when a change materially affects:

- Architecture or design decisions.
- Public APIs, interfaces or user-visible behaviour.
- Authentication, authorisation, trust boundaries or security controls.
- Configuration, dependencies or supported versions.
- Data models, schemas, flows or migrations.
- Infrastructure, deployment, operations or troubleshooting.

Trivial internal changes do not require unnecessary documentation updates.

---

## 4. Codebase Memory MCP

Use Codebase Memory when repository-wide context, relationships or impact analysis would materially improve the task.

Use it to:

- Locate relevant files, symbols, entry points and documentation.
- Find callers, callees, interfaces and dependencies.
- Trace execution and data paths.
- Identify related tests, configuration and infrastructure.
- Understand architecture and estimate blast radius.
- Detect disconnected, unused or orphaned new code.

### Index freshness

- Check index status or detect changes when freshness matters.
- Do not perform a full re-index for every prompt or minor edit.
- Update the index after significant structural changes, large pulls, major branch changes or when results appear stale.
- Verify important findings against current repository content before relying on them.

### Efficient retrieval

Use progressive discovery:

1. Find the relevant feature, symbol, route, configuration key or error.
2. Inspect callers, dependencies and related tests.
3. Retrieve targeted snippets or file outlines.
4. Read complete files only when wider context is genuinely required.
5. Broaden to repository-wide searches only when targeted retrieval is insufficient.

Do not repeatedly retrieve or analyse information already available in the current context.

---

## 5. Repository tooling

Before introducing tools or commands, discover and use the repository's established mechanisms.

Look for applicable:

- `README` and `/docs` guidance.
- Package scripts, task runners and Makefiles.
- Solution or project files.
- CI/CD definitions.
- Test, lint, format and type-check configuration.
- Dependency manifests and lock files.
- Container definitions.
- Infrastructure tooling.

Prefer the same commands and checks used by CI/CD. Do not introduce a second build, test, formatting, package-management or deployment mechanism when an established one is suitable.

Do not modify CI/CD merely to bypass a valid failure.

---

## 6. Proportional workflow

Planning and investigation must be proportional to scope and risk.

For small, obvious and isolated changes, make the focused change and run focused validation without unnecessary ceremony.

For significant, cross-cutting, security-sensitive, data-sensitive, infrastructure or integration work:

1. Restate the requirement and acceptance criteria.
2. Locate the existing implementation and comparable patterns.
3. Review relevant documentation.
4. Use Codebase Memory to identify relationships and blast radius.
5. Identify security, lifecycle, compatibility, data and deployment constraints.
6. Identify required tests and validation.
7. Form a concise implementation plan.
8. Implement the smallest safe complete change.
9. Validate the real execution path.
10. Review the diff, documentation impact and remaining risk.

Do not begin broad implementation while material requirements or trust boundaries remain misunderstood.

---

## 7. Engineering standards

Follow repository conventions for structure, naming, typing, interfaces, error handling, observability, testing and deployment.

Prefer:

- Existing patterns, utilities and shared components.
- Small cohesive changes over broad rewrites.
- Explicit behaviour over hidden side effects.
- Root-cause fixes over symptom suppression.
- Standard platform capabilities over unnecessary packages.
- Maintainable solutions over clever or speculative abstractions.

Do not:

- Refactor unrelated code without being asked.
- Introduce a new pattern when a suitable established one exists.
- Create duplicate utilities, models or services.
- Change public contracts unnecessarily.
- Remove working behaviour merely to simplify implementation.
- Add speculative features for hypothetical future needs.
- Suppress errors, weaken assertions or disable checks merely to obtain a pass.

If an established pattern is insecure, unsupported or clearly defective, follow the applicable security or engineering standard instead and explain the limited deviation.

---

## 8. Complete end-to-end implementation

Implement features as working vertical slices, not isolated demonstrations.

Trace and wire every applicable layer:

- User interface and state.
- Client/API integration.
- Routes, controllers and contracts.
- Business logic and services.
- Authentication and authorisation.
- Database, storage, queues and external services.
- Configuration and secrets.
- Infrastructure and deployment.
- Logging, metrics, tracing and health checks.
- Unit, integration and end-to-end tests.

A new file, screen, endpoint or service is not complete unless the intended application path reaches and uses it.

Verify, where applicable, that:

- Requests reach the intended endpoint.
- Contracts agree across boundaries.
- Identity and authorisation flow correctly.
- Configuration is consumed.
- Data is persisted and retrieved using the intended mechanism.
- External integrations use their real interfaces.
- Errors propagate and are handled appropriately.
- The UI reflects the real backend result rather than assumed success.

Use Codebase Memory to trace important paths and confirm new components are referenced, reachable and not orphaned.

---

## 9. No fake production behaviour

Do not use fake, mocked, placeholder, hard-coded or synthetic behaviour in production paths unless the user explicitly requests a prototype.

Never conceal incomplete integration by:

- Hard-coding sample records to make a UI appear functional.
- Returning placeholder API responses or static success messages.
- Replacing required persistence with in-memory state.
- Simulating a successful external-service call.
- Bypassing authentication or authorisation.
- Silently falling back to dummy data after a real integration fails.
- Creating stubs that report success without performing the operation.
- Leaving TODO implementations while representing the feature as complete.
- Converting an integration failure into apparent success.

Mocks, fakes and synthetic datasets are acceptable only in clearly separated tests, fixtures, local development tooling or explicitly requested prototypes.

If a real dependency, credential, service or environment is unavailable:

1. Implement what can be completed safely.
2. Preserve the real interface and honest failure behaviour.
3. Clearly identify what is blocked or unvalidated.
4. Do not represent partial functionality as complete.

---

## 10. Security, privacy and least privilege

Security is part of implementation and takes precedence over convenience.

Follow applicable security policies and `/docs` requirements. Preserve authentication, authorisation, trust boundaries, data protection and least privilege.

Never:

- Commit or hard-code passwords, tokens, API keys, private keys or sensitive certificates.
- Log secrets, credentials, tokens or unnecessary personal or sensitive data.
- Disable authentication, authorisation, TLS or certificate validation to make something work.
- Grant administrator, owner, root or similarly broad access where narrower access is sufficient.
- Expose sensitive internals in user-facing errors.
- Use insecure defaults or silently weaken a security control.

For externally supplied data:

- Treat it as untrusted unless an established trust boundary proves otherwise.
- Validate type, format, size and allowed values at the appropriate server-side boundary.
- Use parameterised or established safe query and command mechanisms.
- Apply context-appropriate output encoding and protections.
- Do not rely solely on client-side validation for security.

For security-sensitive work, identify identities, permissions, trust boundaries, data classification and abuse or failure paths before implementation.

---

## 11. Dependencies, provenance and lifecycle

Before adding or materially upgrading a runtime, framework, SDK, package, container image, operating system, database or tool:

1. Check whether the repository or standard platform already provides the capability.
2. Confirm compatibility with existing components and supported environments.
3. Prefer a stable, supported, secure release appropriate to the project.
4. Do not introduce End-of-Life or unsupported technology.
5. Avoid technology approaching End of Life when a practical longer-supported option exists.
6. Avoid preview, beta, release-candidate or experimental versions unless explicitly required and accepted.
7. Respect deliberate supported version pins and lock files.
8. Avoid unrelated dependency upgrades.

"Latest" means the latest stable, supported, secure and compatible release suitable for the project, not merely the highest version number.

For new or changed third-party dependencies:

- Use approved and verifiable sources.
- Respect applicable licensing and dependency-provenance policies.
- Review direct and transitive vulnerability findings using available repository tooling.
- Avoid abandoned or unmaintained packages when a maintained alternative is suitable.
- Do not knowingly introduce an unresolved known vulnerability where a secure supported alternative exists.
- Do not suppress a finding merely to make a scan pass.
- Record unavoidable exceptions, applicability assessments and residual risk through the approved process.

A clean scan is point-in-time evidence, not a permanent guarantee that no future vulnerability will be discovered.

---

## 12. Configuration and identity

Follow established configuration and identity patterns.

- Keep environment-specific values out of source code.
- Use the approved secret-management mechanism.
- Preserve environment separation.
- Fail clearly when mandatory configuration is missing.
- Do not silently substitute insecure defaults.
- Confirm every new configuration value is consumed.
- Document required settings without exposing secret values.

For access to cloud resources, APIs, databases, storage, queues, secrets, operating-system resources or deployment systems, grant only the permissions required.

Prefer the repository's established workload identity or managed identity approach where applicable. Do not broaden permissions as a shortcut around a configuration or integration problem.

---

## 13. Data, APIs and compatibility

### Data and persistence

- Follow existing data-access and migration patterns.
- Preserve integrity, confidentiality and existing records.
- Consider rollback, deployment order and compatibility during migrations.
- Avoid destructive schema changes unless explicitly required and understood.
- Do not replace intended persistent behaviour with in-memory behaviour.
- Keep models, schemas, migrations, application code, tests and documentation aligned.

### APIs and interfaces

- Identify consumers before changing contracts.
- Preserve compatibility where reasonably possible.
- Update affected clients, services, tests and documentation for intentional contract changes.
- Validate request and response contracts across boundaries.
- Clearly identify unavoidable breaking changes.

Consider impact on existing users, deployments, automation, stored data, configuration, integrations and infrastructure.

---

## 14. Infrastructure, deployment and observability

When resources are managed through Infrastructure as Code, make durable changes through the established IaC mechanism rather than undocumented manual changes.

Before infrastructure or deployment changes:

1. Identify dependent resources and deployment order.
2. Consider permissions, networking, data-loss risk, rollback and compatibility.
3. Validate templates and configuration with established tooling.
4. Update relevant operational documentation.
5. Avoid configuration drift.

Integrate significant backend or operational functionality with existing logging, metrics, tracing, correlation, diagnostics and health-check patterns where appropriate.

Do not create a separate observability mechanism when an established one exists. Do not log secrets or unnecessary sensitive data.

---

## 15. External integrations and resilience

When integrating with APIs, databases, queues or remote services:

- Follow established timeout, cancellation and retry conventions.
- Do not introduce unbounded retries or indefinite waits.
- Design for idempotency where retries, duplicate delivery or repeated execution are possible.
- Handle rate limiting and transient failures using established project patterns.
- Do not retry permanent validation, authentication or authorisation failures as though they were transient.
- Use bounded pagination or result limits where applicable.
- Preserve useful failure information.
- Do not silently convert dependency failure into apparent success.

Avoid holding locks, transactions or scarce connections across unnecessary remote calls.

---

## 16. Performance and resource efficiency

Avoid obvious performance and cost regressions.

For data-intensive, high-frequency or potentially large-scale paths, consider:

- Database query count, shape, indexing and transaction scope.
- Network round trips and payload size.
- Pagination and bounded result sets.
- Memory and CPU consumption.
- Blocking operations and repeated work.
- Existing caching behaviour and invalidation.
- Concurrency, connection and rate limits.
- Cloud-resource and execution costs where material.

Do not prematurely optimise ordinary code, but do not introduce known unbounded or unnecessarily expensive behaviour. Measure or validate performance when it is a material requirement.

---

## 17. User interface and accessibility

For user-facing changes:

- Follow established design and shared-component patterns.
- Preserve responsive behaviour.
- Use semantic markup and accessible names or labels.
- Preserve keyboard operation and logical focus behaviour.
- Maintain appropriate contrast and status communication according to project standards.
- Handle loading, empty, success and error states.
- Do not show optimistic success after the backend operation has failed.
- Avoid duplicating existing shared UI components.

Apply relevant automated and manual accessibility checks available in the repository.

---

## 18. Time, locale and encoding

Do not make implicit assumptions about timezone, locale, character encoding or date and number formats.

- Follow project conventions for canonical storage and transport.
- Perform user-facing localisation at the appropriate boundary.
- Use unambiguous formats for machine-to-machine exchange.
- Preserve Unicode support.
- Avoid locale-dependent parsing when a canonical representation is available.
- Handle daylight-saving transitions and clock assumptions where relevant.

---

## 19. Error handling

Do not hide unexpected failures or report success after failure.

- Find and fix the root cause where practical.
- Handle expected failures explicitly.
- Preserve useful diagnostic context without exposing secrets.
- Avoid overly broad exception handling.
- Do not silently swallow errors.
- Return user-safe errors while retaining actionable diagnostics through approved logging.
- Do not replace a failed real integration with mock or placeholder success.

---

## 20. Destructive and irreversible changes

Treat destructive or difficult-to-reverse operations with additional caution.

Before deleting, overwriting or irreversibly transforming data, infrastructure or configuration:

1. Identify affected resources, users and data.
2. Determine reversibility and rollback requirements.
3. Prefer non-destructive and backwards-compatible migration approaches.
4. Consider backup, recovery and audit requirements.
5. Avoid destructive operations merely to simplify implementation.
6. Do not delete data, resources or compatibility paths unless required and consequences are understood.

For migrations, prefer expand/migrate/contract or an equivalent staged approach where appropriate.

Do not execute destructive actions against shared or production environments unless the user explicitly requests the action and the repository's controls permit it.

---

## 21. Rollout and compatibility

For high-risk or materially behaviour-changing features, use the repository's existing feature-flag, staged-rollout or compatibility mechanism where appropriate.

- Do not invent a new feature-flag system when one is not required.
- Keep old and new components compatible for the required transition period.
- Plan migration order and rollback.
- Remove transitional paths only when their consumers and data have safely migrated.
- Avoid flags that permanently conceal incomplete or insecure implementation.

---

## 22. Generated artefacts and repository hygiene

Identify generated code, compiled output, lock files and generated configuration before editing.

- Do not manually edit generated artefacts when their source definition can be changed and regenerated through the established process.
- Update lock files only through the appropriate package manager or documented workflow.
- Do not commit temporary files, build output, local environment files, caches, logs, credentials or unrelated artefacts.
- Preserve intentional generated artefacts tracked by the repository.
- Review the final diff for accidental bulk formatting or generated noise.

---

## 23. Testing and validation

Testing must demonstrate intended behaviour, not merely mirror implementation.

Use applicable repository mechanisms, including:

- Unit, integration and end-to-end tests.
- Build or compilation.
- Type checking, linting and formatting checks.
- Schema and migration validation.
- Infrastructure validation.
- Container build or image checks.
- Dependency, licence and security scanning.
- Accessibility and performance checks where material.

After changes:

1. Run the smallest relevant checks first.
2. Expand validation according to blast radius and risk.
3. Test material success and failure paths.
4. Exercise real integration boundaries where practical.
5. Resolve failures introduced by the change rather than bypassing checks.

Do not:

- Delete or disable a valid failing test without understanding the cause.
- Weaken assertions merely to produce a pass.
- Alter correct tests to accommodate incorrect behaviour.
- Present mock-only testing as proof that a real integration works.
- Claim a test, build or scan was run when it was not.

If validation cannot be performed, state exactly what remains unvalidated, why and what evidence is still required.

---

## 24. Scope and change discipline

Stay focused on the requested outcome.

- Keep unrelated cleanup separate.
- Do not reformat or rename unrelated code.
- Mention material discovered issues without automatically expanding scope.
- Preserve backwards compatibility unless a breaking change is required and accepted.
- Review the final diff for accidental, generated or unrelated changes.

When broader change is genuinely required, explain the dependency rather than silently expanding scope.

---

## 25. Token and context efficiency

Optimise for the smallest sufficient context, not the fewest possible tokens.

### Retrieval

- Use Codebase Memory before broad exploration when structural discovery is needed.
- Prefer symbols, graph relationships, outlines and snippets over reading many complete files.
- Read complete files when local context, invariants or control flow require it.
- Retrieve only relevant `/docs` content.
- Start with specific feature names, symbols, routes, interfaces, configuration keys and errors; broaden only when results are insufficient.
- Do not repeat equivalent searches or re-read unchanged material already in context.

### Reasoning and output

- Keep intermediate narration concise.
- Do not repeatedly summarise established facts.
- Make planning proportional to risk and scope.
- Use concise plans for complex work, then proceed to implementation.
- Keep final reporting proportionate to the change.

When context is large, prioritise:

1. Current requirement and acceptance criteria.
2. Applicable instructions.
3. Relevant implementation and contracts.
4. Security, architecture and lifecycle constraints.
5. Dependencies and execution paths.
6. Relevant tests.
7. Relevant documentation.
8. Peripheral historical information.

Never sacrifice correctness, security, compatibility or end-to-end validation merely to save tokens.

---

## 26. Pre-implementation gate

Before significant implementation, establish as applicable:

- The existing pattern to follow.
- Relevant documentation and architecture.
- Entry points, callers, dependencies and blast radius.
- Acceptance criteria and affected user journeys.
- Security requirements, identities, permissions and trust boundaries.
- Data, migration and destructive-change impact.
- New dependencies, provenance and support status.
- Compatibility and breaking-change impact.
- Configuration, infrastructure, resilience and rollout requirements.
- Performance, accessibility and localisation implications.
- Tests and evidence required to prove the change.

Resolve or clearly report material conflicts before proceeding. Do not use fake behaviour to bypass an unresolved dependency.

---

## 27. Definition of Done

A significant task is complete only when all applicable conditions are met:

- The requirement and acceptance criteria are addressed.
- The real end-to-end path is implemented.
- Required components are connected, referenced and reachable.
- Production paths comply with Section 9 and contain no unapproved fake behaviour.
- Security, privacy and least-privilege requirements in Section 10 are satisfied.
- Dependencies and technologies meet Section 11.
- Data, compatibility, resilience and destructive-change concerns are addressed.
- Applicable validation required by Section 23 has passed.
- Documentation requirements in Section 3 are satisfied.
- The final diff contains no unintended changes or repository artefacts.
- Codebase Memory is updated when structural changes justify it.
- Remaining assumptions, risks and unvalidated behaviour are explicitly reported.

Creating files is not proof of implementation. Compilation alone is not proof of integration. Unit tests alone are not proof of end-to-end behaviour.

Classify outcomes accurately as:

- Implemented and validated.
- Implemented but not fully validated.
- Partially implemented.
- Blocked by an external dependency.
- Proposed but not implemented.

Never report a weaker state as fully working.

---

## 28. Completion response

For significant work, provide a concise completion summary:

### Changed

What was implemented and why.

### Integration

How the relevant components are connected through the real execution path.

### Validation

Exactly which tests, builds, scans or checks were run and their outcomes.

### Documentation

What was updated, or why no documentation change was required.

### Remaining issues

Any unvalidated behaviour, blockers, assumptions, residual risks or necessary follow-up.

For small changes, keep the summary proportionate.
