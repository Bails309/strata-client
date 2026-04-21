import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAuditLogs } from "../api";

// Mock the api module
vi.mock("../api", () => ({
  getAuditLogs: vi.fn(),
}));

vi.mock("../contexts/SettingsContext", () => ({
  useSettings: () => ({
    settings: {},
    timeSettings: {
      display_timezone: "UTC",
      display_time_format: "HH:mm:ss",
      display_date_format: "YYYY-MM-DD",
    },
    loading: false,
    refreshSettings: vi.fn(),
    updateSettings: vi.fn(),
    formatDateTime: (date: any) => {
      if (!date) return "—";
      return new Date(date).toISOString();
    },
  }),
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import AuditLogs from "../pages/AuditLogs";

describe("AuditLogs", () => {
  it("renders heading", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([]);
    render(<AuditLogs />);
    expect(await screen.findByText("Audit Logs")).toBeInTheDocument();
  });

  it("renders column headers", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([]);
    render(<AuditLogs />);
    await screen.findByText("Audit Logs");
    expect(screen.getByText("ID")).toBeInTheDocument();
    expect(screen.getByText("Timestamp")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("Hash")).toBeInTheDocument();
  });

  it("displays audit log entries after fetch", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-15T10:30:00Z",
        action_type: "auth.login",
        user_id: "abc-123",
        username: "admin",
        details: { ip: "192.168.1.1" },
        current_hash: "abcdef1234567890abcdef1234567890",
      },
      {
        id: 2,
        created_at: "2026-01-15T11:00:00Z",
        action_type: "settings.update",
        user_id: "abc-123",
        username: "admin",
        details: { key: "sso_enabled" },
        current_hash: "fedcba0987654321fedcba0987654321",
      },
    ]);

    render(<AuditLogs />);
    // Wait for the async data to appear
    expect(await screen.findByText("auth.login")).toBeInTheDocument();
    expect(await screen.findByText("settings.update")).toBeInTheDocument();
    const adminCells = await screen.findAllByText("admin");
    expect(adminCells.length).toBeGreaterThanOrEqual(1);
  });

  it("renders pagination controls", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([]);
    render(<AuditLogs />);
    await screen.findByText("Audit Logs");
    expect(screen.getByText("Previous")).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("Previous button is disabled on page 1", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([]);
    render(<AuditLogs />);
    await screen.findByText("Audit Logs");
    const prev = screen.getByText("Previous");
    expect(prev).toBeDisabled();
  });

  it("navigates to next page", async () => {
    // Return 50 items so the Next button is enabled (disabled when < 50)
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      created_at: "2026-01-15T10:30:00Z",
      action_type: "auth.login",
      user_id: "abc-123",
      username: "admin",
      details: { ip: "192.168.1.1" },
      current_hash: "abcdef1234567890abcdef1234567890",
    }));
    vi.mocked(getAuditLogs).mockResolvedValue(fullPage);

    const user = userEvent.setup();
    render(<AuditLogs />);

    // Wait for data to load so Next becomes enabled
    await screen.findAllByText("auth.login");
    await user.click(screen.getByText("Next"));
    expect(screen.getByText("Page 2")).toBeInTheDocument();
  });

  it("Previous button navigates back to page 1", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      created_at: "2026-01-15T10:30:00Z",
      action_type: "auth.login",
      user_id: "abc-123",
      username: "admin",
      details: { ip: "192.168.1.1" },
      current_hash: "abcdef1234567890abcdef1234567890",
    }));
    vi.mocked(getAuditLogs).mockResolvedValue(fullPage);

    const user = userEvent.setup();
    render(<AuditLogs />);
    await screen.findAllByText("auth.login");
    await user.click(screen.getByText("Next"));
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    await user.click(screen.getByText("Previous"));
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("shows truncated user_id when username is absent", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 10,
        created_at: "2026-01-15T12:00:00Z",
        action_type: "user.login",
        user_id: "abcdef12-3456-7890-abcd-ef1234567890",
        username: undefined,
        details: {},
        current_hash: "aaa111bbb222ccc333ddd444eee555ff",
      },
      {
        id: 11,
        created_at: "2026-01-15T12:05:00Z",
        action_type: "system.event",
        user_id: undefined,
        username: undefined,
        details: {},
        current_hash: "bbb222ccc333ddd444eee555fff666aa",
      },
    ]);

    render(<AuditLogs />);
    // user_id truncated to first 8 chars
    expect(await screen.findByText("abcdef12")).toBeInTheDocument();
    // Dash shown when both username and user_id are absent
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  /* ── badgeClass branches ──────────────────────── */
  const badgeCases: [string, string][] = [
    ["tunnel.connected", "badge-accent"],
    ["auth.local_login", "badge-success"],
    ["ad_sync.completed", "badge-warning"],
    ["connection.created", "badge-accent"],
    ["connection_folder.created", "badge-accent"],
    ["settings.updated", "badge-warning"],
    ["sso.configured", "badge-warning"],
    ["vault.configured", "badge-warning"],
    ["kerberos.configured", "badge-warning"],
    ["recordings.configured", "badge-warning"],
    ["role.created", "badge-warning"],
    ["user.created", "badge-accent"],
    ["credential.updated", "badge-success"],
    ["sessions.killed", "badge-error"],
    ["unknown.action", "badge-success"],
  ];

  badgeCases.forEach(([action, expected]) => {
    it(`badge class for ${action} contains ${expected}`, async () => {
      vi.mocked(getAuditLogs).mockResolvedValue([
        {
          id: 1,
          created_at: "2026-01-01T00:00:00Z",
          action_type: action,
          user_id: "u1",
          username: "admin",
          details: { count: 1 },
          current_hash: "aabbccdd11223344",
        },
      ]);
      render(<AuditLogs />);
      const badge = await screen.findByText(action);
      expect(badge.className).toContain(expected);
    });
  });

  /* ── formatDetails switch branches ────────────── */
  it("shows tunnel.connected with connection name", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "tunnel.connected",
        user_id: "u1",
        username: "admin",
        details: { connection_id: "c1" },
        current_hash: "aabbccdd11223344",
        connection_name: "ServerX",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("ServerX")).toBeInTheDocument();
  });

  it("shows tunnel.connected without connection name", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "tunnel.connected",
        user_id: "u1",
        username: "admin",
        details: { connection_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/abcdef12/)).toBeInTheDocument();
  });

  it("shows tunnel.failed with error", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "tunnel.failed",
        user_id: "u1",
        username: "admin",
        details: { connection_id: "c1", error: "timeout" },
        current_hash: "aabbccdd11223344",
        connection_name: "Srv",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/timeout/)).toBeInTheDocument();
  });

  it("shows tunnel.failed without connection name", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "tunnel.failed",
        user_id: "u1",
        username: "admin",
        details: { connection_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/abcdef12/)).toBeInTheDocument();
  });

  it("shows sessions.killed singular", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "sessions.killed",
        user_id: "u1",
        username: "admin",
        details: { count: 1 },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("1 session terminated")).toBeInTheDocument();
  });

  it("shows sessions.killed plural", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "sessions.killed",
        user_id: "u1",
        username: "admin",
        details: { count: 3 },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("3 sessions terminated")).toBeInTheDocument();
  });

  it("shows auth.local_login", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "auth.local_login",
        user_id: "u1",
        username: "admin",
        details: { username: "joe" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/logged in \(local\)/)).toBeInTheDocument();
  });

  it("shows auth.sso_login", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "auth.sso_login",
        user_id: "u1",
        username: "admin",
        details: { username: "joe" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/logged in \(SSO\)/)).toBeInTheDocument();
  });

  it("shows connection.created", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "connection.created",
        user_id: "u1",
        username: "admin",
        details: { name: "NewConn" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Created connection/)).toBeInTheDocument();
  });

  it("shows connection.updated", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "connection.updated",
        user_id: "u1",
        username: "admin",
        details: { name: "EditConn" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Updated connection/)).toBeInTheDocument();
  });

  it("shows connection.deleted", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "connection.deleted",
        user_id: "u1",
        username: "admin",
        details: { id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Deleted connection/)).toBeInTheDocument();
  });

  it("shows connection.shared with name and mode", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "connection.shared",
        user_id: "u1",
        username: "admin",
        details: { connection_id: "c1", mode: "view" },
        current_hash: "aabbccdd11223344",
        connection_name: "SharedSrv",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("SharedSrv")).toBeInTheDocument();
    expect(screen.getByText(/(view)/)).toBeInTheDocument();
  });

  it("shows connection.shared without name", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "connection.shared",
        user_id: "u1",
        username: "admin",
        details: { connection_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/abcdef12/)).toBeInTheDocument();
  });

  it("shows connection_folder.created", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "connection_folder.created",
        user_id: "u1",
        username: "admin",
        details: { name: "Prod" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Created folder/)).toBeInTheDocument();
  });

  it("shows connection_folder.deleted", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "connection_folder.deleted",
        user_id: "u1",
        username: "admin",
        details: { id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Deleted folder/)).toBeInTheDocument();
  });

  it("shows role.created", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "role.created",
        user_id: "u1",
        username: "admin",
        details: { name: "Admin" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Created role/)).toBeInTheDocument();
  });

  it("shows role.updated", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "role.updated",
        user_id: "u1",
        username: "admin",
        details: { name: "Admin" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Updated role/)).toBeInTheDocument();
  });

  it("shows role.deleted", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "role.deleted",
        user_id: "u1",
        username: "admin",
        details: { name: "Viewer" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Deleted role/)).toBeInTheDocument();
  });

  it("shows role_mappings.updated", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "role_mappings.updated",
        user_id: "u1",
        username: "admin",
        details: { role_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Updated role mappings/)).toBeInTheDocument();
  });

  it("shows user.created", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "user.created",
        user_id: "u1",
        username: "admin",
        details: { email: "a@b.com", auth_type: "local" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Created user/)).toBeInTheDocument();
  });

  it("shows user.deleted", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "user.deleted",
        user_id: "u1",
        username: "admin",
        details: { id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Deleted user/)).toBeInTheDocument();
  });

  it("shows user.restored", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "user.restored",
        user_id: "u1",
        username: "admin",
        details: { id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Restored user/)).toBeInTheDocument();
  });

  it("shows credential.updated with connection name", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "credential.updated",
        user_id: "u1",
        username: "admin",
        details: { connection_id: "c1" },
        current_hash: "aabbccdd11223344",
        connection_name: "CredSrv",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Updated credential for/)).toBeInTheDocument();
    expect(screen.getByText("CredSrv")).toBeInTheDocument();
  });

  it("shows credential.updated without connection name", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "credential.updated",
        user_id: "u1",
        username: "admin",
        details: { connection_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Updated credential/)).toBeInTheDocument();
  });

  it("shows credential_profile.created", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "credential_profile.created",
        user_id: "u1",
        username: "admin",
        details: { label: "MyProf" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Created credential profile/)).toBeInTheDocument();
  });

  it("shows credential_profile.updated", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "credential_profile.updated",
        user_id: "u1",
        username: "admin",
        details: { profile_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Updated credential profile/)).toBeInTheDocument();
  });

  it("shows credential_profile.deleted", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "credential_profile.deleted",
        user_id: "u1",
        username: "admin",
        details: { profile_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Deleted credential profile/)).toBeInTheDocument();
  });

  it("shows ad_sync.completed with deletions", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "ad_sync.completed",
        user_id: "u1",
        username: "admin",
        details: { label: "Corp", created: 5, updated: 3, soft_deleted: 2, hard_deleted: 1 },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/5 created/)).toBeInTheDocument();
    expect(screen.getByText(/2 soft-deleted/)).toBeInTheDocument();
  });

  it("shows ad_sync.completed without deletions", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "ad_sync.completed",
        user_id: "u1",
        username: "admin",
        details: { label: "Corp", created: 5, updated: 3, soft_deleted: 0, hard_deleted: 0 },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/5 created/)).toBeInTheDocument();
    expect(screen.queryByText(/soft-deleted/)).not.toBeInTheDocument();
  });

  it("shows ad_sync.config_created", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "ad_sync.config_created",
        user_id: "u1",
        username: "admin",
        details: { label: "Office" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Created AD sync config/)).toBeInTheDocument();
  });

  it("shows ad_sync.config_updated", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "ad_sync.config_updated",
        user_id: "u1",
        username: "admin",
        details: { id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Updated AD sync config/)).toBeInTheDocument();
  });

  it("shows ad_sync.config_deleted", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "ad_sync.config_deleted",
        user_id: "u1",
        username: "admin",
        details: { id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Deleted AD sync config/)).toBeInTheDocument();
  });

  it("shows settings.updated singular", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "settings.updated",
        user_id: "u1",
        username: "admin",
        details: { count: 1 },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("1 setting updated")).toBeInTheDocument();
  });

  it("shows settings.updated plural", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "settings.updated",
        user_id: "u1",
        username: "admin",
        details: { count: 5 },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("5 settings updated")).toBeInTheDocument();
  });

  it("shows settings.auth_methods_updated", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "settings.auth_methods_updated",
        user_id: "u1",
        username: "admin",
        details: { sso_enabled: true, local_auth_enabled: false },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/SSO on/)).toBeInTheDocument();
    expect(screen.getByText(/Local off/)).toBeInTheDocument();
  });

  it("shows sso.configured", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "sso.configured",
        user_id: "u1",
        username: "admin",
        details: {},
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("SSO configured")).toBeInTheDocument();
  });

  it("shows vault.configured", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "vault.configured",
        user_id: "u1",
        username: "admin",
        details: { address: "https://vault.local" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Vault configured/)).toBeInTheDocument();
  });

  it("shows kerberos.configured", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "kerberos.configured",
        user_id: "u1",
        username: "admin",
        details: { realm: "CORP.COM" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("CORP.COM")).toBeInTheDocument();
  });

  it("shows kerberos.realm_created", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "kerberos.realm_created",
        user_id: "u1",
        username: "admin",
        details: { realm: "NEW.COM" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Created Kerberos realm/)).toBeInTheDocument();
  });

  it("shows kerberos.realm_updated", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "kerberos.realm_updated",
        user_id: "u1",
        username: "admin",
        details: { realm_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Updated Kerberos realm/)).toBeInTheDocument();
  });

  it("shows kerberos.realm_deleted", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "kerberos.realm_deleted",
        user_id: "u1",
        username: "admin",
        details: { realm_id: "abcdef12-3456" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/Deleted Kerberos realm/)).toBeInTheDocument();
  });

  it("shows recordings.configured enabled", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "recordings.configured",
        user_id: "u1",
        username: "admin",
        details: { enabled: true },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("Recordings enabled")).toBeInTheDocument();
  });

  it("shows recordings.configured disabled", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "recordings.configured",
        user_id: "u1",
        username: "admin",
        details: { enabled: false },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("Recordings disabled")).toBeInTheDocument();
  });

  it("shows fallback JSON for unknown action type", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "mystery.action",
        user_id: "u1",
        username: "admin",
        details: { foo: "bar" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText(/foo.*bar/)).toBeInTheDocument();
  });

  it("shortId truncates long ids and passes short ones through", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 1,
        created_at: "2026-01-01T00:00:00Z",
        action_type: "connection.deleted",
        user_id: "u1",
        username: "admin",
        details: { id: "short" },
        current_hash: "aabbccdd11223344",
      },
    ]);
    render(<AuditLogs />);
    expect(await screen.findByText("short")).toBeInTheDocument();
  });
});
