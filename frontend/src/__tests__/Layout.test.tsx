import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Mock the api module
vi.mock("../api", () => ({
  readCookie: vi.fn(),
  getMe: vi.fn().mockResolvedValue({
    username: "testadmin",
    role: "admin",
    client_ip: "10.0.0.1",
    watermark_enabled: false,
  }),
}));

// Mock the ThemeProvider
vi.mock("../components/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", preference: "dark", setPreference: vi.fn(), cycle: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock the SessionManager
vi.mock("../components/SessionManager", () => ({
  useSessionManager: () => ({
    sessions: [],
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    setTiledSessionIds: vi.fn(),
    setFocusedSessionIds: vi.fn(),
  }),
  SessionManagerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import Layout, { useSidebarWidth } from "../components/Layout";
import { publishPendingApprovals } from "../components/approvalStore";

const adminUser: import("../api").MeResponse = {
  id: "u1",
  username: "testadmin",
  role: "admin",
  client_ip: "10.0.0.1",
  watermark_enabled: false,
  vault_configured: true,
  terms_accepted_at: "2024-01-01T00:00:00Z",
  terms_accepted_version: 1,
  can_manage_system: true,
  can_manage_users: true,
  can_manage_connections: true,
  can_view_audit_logs: true,
  can_create_users: true,
  can_create_user_groups: true,
  can_create_connections: true,
  can_use_quick_share: true,
  can_use_quick_share_outbound: true,
  can_create_sharing_profiles: true,
  can_view_sessions: true,
  is_approver: false,
  is_outbound_approver: false,
  outbound_share_requires_approval: true,
};

function renderLayout(route = "/") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Layout user={adminUser} onLogout={vi.fn()} />
    </MemoryRouter>
  );
}

describe("Layout", () => {
  it("renders navigation links", () => {
    renderLayout();
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(screen.getByText("Platform Admin")).toBeInTheDocument();
    expect(screen.getByText("Audit Trail")).toBeInTheDocument();
  });

  it("renders credentials link", () => {
    renderLayout();
    expect(screen.getByText("Credentials & Vault")).toBeInTheDocument();
  });

  it("renders brand logo", () => {
    renderLayout();
    const logo = screen.getByAltText("Strata Client");
    expect(logo).toBeInTheDocument();
  });

  it("shows username and role after loading", () => {
    renderLayout();
    expect(screen.getByText("testadmin")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });

  it("highlights active nav item based on route", () => {
    renderLayout("/admin");
    const admin = screen.getByRole("button", { name: "Platform Admin" });
    expect(admin.className).toContain("is-active");
    expect(screen.getByRole("link", { name: "Connections" })).not.toHaveAttribute("aria-current");
  });

  it("groups items under section headers", () => {
    renderLayout();
    expect(screen.getByRole("group", { name: "Workspace" })).toHaveTextContent("Connections");
    expect(screen.getByRole("group", { name: "Security & Audit" })).toHaveTextContent(
      "Audit Trail"
    );
    // Not an approver: the approvals item and nothing else is hidden.
    expect(screen.queryByText("Pending Approvals")).not.toBeInTheDocument();
  });

  it("shows the admin sub-tree with real admin routes", async () => {
    renderLayout("/admin/access");
    expect(screen.getByRole("link", { name: "Roles & RBAC" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Fleet Endpoints" })).toHaveAttribute(
      "href",
      "/admin/connections"
    );
    expect(screen.getByRole("link", { name: "Connection Folders" })).toHaveAttribute(
      "href",
      "/admin/connections#connection-folders"
    );
    await userEvent.click(screen.getByRole("button", { name: "Platform Admin" }));
    expect(screen.queryByRole("link", { name: "Roles & RBAC" })).not.toBeInTheDocument();
  });

  it("shows a pending-approval badge from the watcher's count", () => {
    publishPendingApprovals(3);
    render(
      <MemoryRouter>
        <Layout user={{ ...adminUser, is_outbound_approver: true }} onLogout={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: /Pending Approvals/ })).toHaveTextContent("3 pending");
    publishPendingApprovals(0);
  });

  it("remembers the collapsed rail and labels icons for assistive tech", async () => {
    localStorage.removeItem("strata-sidebar-collapsed");
    const { unmount } = renderLayout();
    await userEvent.click(screen.getByTitle("Collapse sidebar"));
    expect(localStorage.getItem("strata-sidebar-collapsed")).toBe("1");
    unmount();

    renderLayout();
    expect(screen.getByTitle("Expand sidebar")).toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeInTheDocument();
    localStorage.removeItem("strata-sidebar-collapsed");
  });

  it("collapses sidebar when collapse button is clicked", async () => {
    renderLayout();
    const collapseBtn = screen.getByTitle("Collapse sidebar");
    expect(collapseBtn).toBeInTheDocument();
    await userEvent.click(collapseBtn);
    expect(screen.getByTitle("Expand sidebar")).toBeInTheDocument();
  });
});

describe("useSidebarWidth", () => {
  it("returns default width outside provider", () => {
    function Inner() {
      const w = useSidebarWidth();
      return <span>{w}</span>;
    }
    render(<Inner />);
    expect(screen.getByText("180")).toBeInTheDocument();
  });
});
