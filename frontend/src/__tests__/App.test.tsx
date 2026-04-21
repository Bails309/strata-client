import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet } from "react-router-dom";
import App from "../App";
import React from "react";

// Mock heavy child components to keep tests fast
vi.mock("../pages/Dashboard", () => ({ default: () => <div>Dashboard</div> }));
vi.mock("../pages/Login", () => ({
  default: ({ onLogin }: { onLogin: () => void }) => (
    <div>
      Login Page
      <button onClick={onLogin}>mock-login</button>
    </div>
  ),
}));
vi.mock("../pages/AdminSettings", () => ({ default: () => <div>Admin</div> }));
vi.mock("../pages/AuditLogs", () => ({ default: () => <div>Audit</div> }));
vi.mock("../pages/SessionClient", () => ({ default: () => <div>Session</div> }));
vi.mock("../pages/TiledView", () => ({ default: () => <div>Tiled</div> }));
vi.mock("../pages/SharedViewer", () => ({ default: () => <div>Shared</div> }));
vi.mock("../pages/NvrPlayer", () => ({ default: () => <div>NVR</div> }));
vi.mock("../pages/Credentials", () => ({ default: () => <div>Credentials</div> }));
vi.mock("../components/Layout", () => ({
  default: ({ onLogout }: { onLogout?: () => void }) => (
    <div>
      <Outlet />
      {onLogout && <button onClick={onLogout}>mock-logout</button>}
    </div>
  ),
}));
vi.mock("../components/SessionManager", () => ({
  SessionManagerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../components/SessionBar", () => ({ default: () => null }));
vi.mock("../components/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/** Build a minimal JWT-shaped string with an `exp` claim so checkAuth accepts it. */
function fakeJwt(expOffsetSec = 3600) {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec }));
  return `h.${payload}.s`;
}

/** Create a URL-aware fetch mock. For /auth/check returns `authResult`,
 *  for everything else returns `otherResult`. */
function mockFetch(authResult: object | null, otherResult: object | null = authResult) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/auth/check")) {
      if (authResult === null) throw new Error("network error");
      return new Response(JSON.stringify(authResult), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (otherResult === null) throw new Error("network error");
    return new Response(JSON.stringify(otherResult), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const authedUser = {
  authenticated: true,
  user: {
    id: "1",
    username: "admin",
    role: "admin",
    terms_accepted_at: "2024-01-01T00:00:00Z",
    terms_accepted_version: 1,
  },
};

function renderApp(initialRoute = "/") {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <App />
    </MemoryRouter>
  );
}

describe("App routing", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redirects to /login when not authenticated", async () => {
    // No token in localStorage → no fetch at all
    renderApp("/");
    expect(await screen.findByText("Login Page")).toBeInTheDocument();
  });

  it("renders shared viewer without auth", async () => {
    renderApp("/shared/abc123");
    expect(await screen.findByText("Shared")).toBeInTheDocument();
  });

  it("clears stale token when /auth/check says not authenticated", async () => {
    localStorage.setItem("access_token", fakeJwt());
    mockFetch({ authenticated: false });

    renderApp("/");
    expect(await screen.findByText("Login Page")).toBeInTheDocument();
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("renders dashboard when authenticated", async () => {
    localStorage.setItem("access_token", fakeJwt());
    mockFetch(authedUser);

    renderApp("/");
    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
  });

  it("handles fetch error gracefully", async () => {
    localStorage.setItem("access_token", fakeJwt());
    mockFetch(null); // both calls throw

    renderApp("/");
    expect(await screen.findByText("Login Page")).toBeInTheDocument();
  });

  it("shows loading spinner while auth state is pending", () => {
    localStorage.setItem("access_token", fakeJwt());
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    renderApp("/");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("logs out and redirects to login", async () => {
    localStorage.setItem("access_token", fakeJwt());
    mockFetch(authedUser);

    renderApp("/");
    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    await userEvent.click(screen.getByText("mock-logout"));
    expect(await screen.findByText("Login Page")).toBeInTheDocument();
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("calls handleLogin and navigates to dashboard", async () => {
    // Start at login — no token
    renderApp("/login");
    await screen.findByText("Login Page");

    // Simulate login: set token and wire up success responses
    localStorage.setItem("access_token", fakeJwt());
    localStorage.setItem("token_expiry", String(Date.now() + 3600000));
    // handleLogin calls checkAuthStatus → /auth/check, and SettingsProvider calls /admin/settings
    mockFetch(authedUser);

    await act(async () => {
      await userEvent.click(screen.getByText("mock-login"));
    });

    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });
  });

  it("handleLogin clears tokens when auth check returns not authenticated", async () => {
    renderApp("/login");
    await screen.findByText("Login Page");

    localStorage.setItem("access_token", fakeJwt());
    localStorage.setItem("token_expiry", String(Date.now() + 3600000));
    mockFetch({ authenticated: false });

    await act(async () => {
      await userEvent.click(screen.getByText("mock-login"));
    });

    expect(localStorage.getItem("access_token")).toBeNull();
    expect(localStorage.getItem("token_expiry")).toBeNull();
  });

  it("shows disclaimer modal when terms not accepted", async () => {
    localStorage.setItem("access_token", fakeJwt());
    const noTermsUser = {
      authenticated: true,
      user: {
        id: "1",
        username: "admin",
        role: "admin",
        terms_accepted_at: null,
        terms_accepted_version: 0,
      },
    };
    mockFetch(noTermsUser);

    renderApp("/");
    expect(await screen.findByText("Session Recording Disclaimer")).toBeInTheDocument();
  });

  it("redirects non-admin user from /admin to /", async () => {
    localStorage.setItem("access_token", fakeJwt());
    const regularUser = {
      authenticated: true,
      user: {
        id: "2",
        username: "user1",
        role: "user",
        terms_accepted_at: "2024-01-01T00:00:00Z",
        terms_accepted_version: 1,
      },
    };
    mockFetch(regularUser);

    renderApp("/admin");
    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });
  });

  it("redirects user without vault from /credentials to /", async () => {
    localStorage.setItem("access_token", fakeJwt());
    const noVaultUser = {
      authenticated: true,
      user: {
        id: "2",
        username: "user1",
        role: "user",
        terms_accepted_at: "2024-01-01T00:00:00Z",
        terms_accepted_version: 1,
        vault_configured: false,
      },
    };
    mockFetch(noVaultUser);

    renderApp("/credentials");
    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });
  });
});
