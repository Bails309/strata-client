// W4-9: Focused frontend negative tests covering form validation failure
// modes, network failures, and 401/403 handling surfaces that are not yet
// asserted by the higher-level page tests.
//
// These tests exercise the `request` helper and `ApiError` class directly so
// they are fast, deterministic, and do not depend on any specific page's
// mocks or routing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError, getStatus, login } from "../api";

describe("W4-9 negative: network failures", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("surfaces TypeError from fetch (DNS failure, offline) as an Error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(getStatus()).rejects.toThrow(/fetch/i);
  });

  it("surfaces aborted request as an Error rather than silently resolving", async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted");
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    await expect(getStatus()).rejects.toThrow(/abort/i);
  });

  it("does not swallow a server-side 500 response body", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "database is down" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;

    await expect(getStatus()).rejects.toThrow(/database is down/);
  });

  it("exposes the numeric status code on ApiError for 500", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;

    try {
      await getStatus();
      throw new Error("expected getStatus to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
    }
  });
});

describe("W4-9 negative: auth misuse", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("login rejects on a 401 response with the server's error message", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Invalid credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;

    await expect(login({ username: "admin", password: "wrong-pw" })).rejects.toThrow(
      /invalid credentials/i
    );
  });

  it("login rejects on a 429 rate-limit response without retrying silently", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ error: "Too many attempts" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(login({ username: "admin", password: "admin" })).rejects.toThrow(
      /too many attempts/i
    );
    // login() must fail fast; zero automatic retries.
    expect(calls).toBe(1);
  });

  it("ApiError is distinguishable from a generic Error by instanceof", () => {
    const a = new ApiError(403, "Forbidden");
    const b = new Error("plain");
    expect(a instanceof ApiError).toBe(true);
    expect(b instanceof ApiError).toBe(false);
  });
});

describe("W4-9 negative: malformed payloads", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects when server returns non-JSON on an expected-JSON endpoint", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<!DOCTYPE html><html>500 Internal Server Error</html>", {
          status: 500,
          headers: { "Content-Type": "text/html" },
        })
    ) as unknown as typeof fetch;

    // Error surface will be either a parse error or an HTTP error; either
    // way it must NOT resolve successfully.
    await expect(getStatus()).rejects.toBeDefined();
  });

  it("tolerates an empty 200 body on a JSON endpoint without throwing", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;

    // Current `request()` contract: on an empty 200 body we resolve with
    // `undefined` rather than throwing. This test pins that contract so any
    // future change is a deliberate choice — callers are expected to
    // null-check the result.
    await expect(getStatus()).resolves.toBeUndefined();
  });
});
