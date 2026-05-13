# ADR-0013: Vitest Environment Stabilization (Fetch Polyfill)

## Status

Accepted

## Context

The Strata Client frontend uses Vitest for unit and component testing. As the application moved towards cookie-based authentication and relative API paths (e.g., `fetch("/api/auth/refresh")`) in v1.8.3, the Node.js environment used by Vitest began to fail. Specifically, `node-fetch` and the native Node `fetch` (based on `undici`) throw `ERR_INVALID_URL` when presented with relative paths, as they lack the concept of a "current origin" found in browsers. This led to widespread regressions in the v1.8.4 development cycle.

## Decision

Implement a global `fetch` polyfill in the Vitest `setup.ts` to simulate a browser-like environment.

1.  **URL Resolution**: The polyfill intercepts `fetch` calls and, if a relative path is detected (starting with `/`), prefixes it with `http://localhost`.
2.  **Mock Synchronization**: Mandate that all `api.ts` mocks include new utilities (like `readCookie`) to prevent runtime errors during component mounting in tests.
3.  **Async Act Pattern**: Standardize on `await act(async () => ...)` for all React state updates in tests to resolve "not wrapped in act(...)" warnings, ensuring test stability and accuracy.

## Consequences

- **Restored Test Suite Stability**: The "Invalid URL" errors are eliminated without requiring brittle changes to every individual test file.
- **Maintainable Mocking**: Centralizing the fetch logic in `setup.ts` keeps test code DRY and focused on component behavior rather than environment quirks.
- **Improved Developer Experience**: The test suite provides faster, more reliable feedback, reducing friction during the development of security-sensitive features.
