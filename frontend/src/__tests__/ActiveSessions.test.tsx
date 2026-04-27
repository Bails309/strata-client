import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

vi.mock("../api", () => ({
  getActiveSessions: vi.fn(),
  killSessions: vi.fn(),
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

import ActiveSessions from "../pages/ActiveSessions";
import { getActiveSessions, killSessions } from "../api";

function makeSession(
  overrides: Partial<import("../api").ActiveSession> = {}
): import("../api").ActiveSession {
  return {
    session_id: "s1",
    connection_id: "c1",
    connection_name: "Server A",
    protocol: "rdp",
    user_id: "u1-abcdef01-2345",
    username: "admin",
    started_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    buffer_depth_secs: 0,
    bytes_from_guacd: 10 * 1024 * 1024,
    bytes_to_guacd: 512 * 1024,
    remote_host: "10.0.0.5",
    client_ip: "192.168.1.10",
    ...overrides,
  };
}

describe("ActiveSessions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getActiveSessions).mockResolvedValue([makeSession()]);
    vi.mocked(killSessions).mockResolvedValue({ status: "ok", killed_count: 1 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders heading", async () => {
    await act(async () => {
      render(<ActiveSessions />);
    });
    expect(await screen.findByText("Active Sessions")).toBeInTheDocument();
  });

  it("shows loading state initially", async () => {
    vi.mocked(getActiveSessions).mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(<ActiveSessions />);
    });
    expect(screen.getByText("Refreshing...")).toBeInTheDocument();
  });

  it("renders session rows", async () => {
    await act(async () => {
      render(<ActiveSessions />);
    });
    expect(await screen.findByText("Server A")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.10")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.5")).toBeInTheDocument();
  });

  it("shows empty state when no sessions", async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([]);
    await act(async () => {
      render(<ActiveSessions />);
    });
    expect(await screen.findByText("No active sessions found")).toBeInTheDocument();
  });

  it("toggles individual session checkbox", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => {
      render(<ActiveSessions />);
    });
    await screen.findByText("Server A");

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);
    expect(screen.getByText("Kill 1 Session(s)")).toBeInTheDocument();

    await user.click(checkboxes[1]);
    expect(screen.getByText("Kill 0 Session(s)")).toBeInTheDocument();
  });

  it("terminates sessions on confirm", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => {
      render(<ActiveSessions />);
    });
    await screen.findByText("Server A");

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);
    await user.click(screen.getByText("Kill 1 Session(s)"));
    await user.click(screen.getByText("Terminate"));

    expect(killSessions).toHaveBeenCalledWith(["s1"]);
  });

  it("refreshes on button click", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => {
      render(<ActiveSessions />);
    });
    await screen.findByText("Server A");
    expect(getActiveSessions).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("Refresh Now"));
    await waitFor(() => expect(getActiveSessions).toHaveBeenCalledTimes(2));
  });

  it("handles API error gracefully", async () => {
    vi.mocked(getActiveSessions).mockRejectedValue(new Error("fail"));
    await act(async () => {
      render(<ActiveSessions />);
    });
    await waitFor(() => {
      expect(screen.getByText("No active sessions found")).toBeInTheDocument();
    });
  });

  it("renders column headers", async () => {
    await act(async () => {
      render(<ActiveSessions />);
    });
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("Connection")).toBeInTheDocument();
    expect(screen.getByText("Protocol")).toBeInTheDocument();
    expect(screen.getByText("Source IP")).toBeInTheDocument();
    expect(screen.getByText("Remote Host")).toBeInTheDocument();
    expect(screen.getByText("Active Since")).toBeInTheDocument();
    expect(screen.getByText("Traffic")).toBeInTheDocument();
  });

  it("renders ssh and vnc protocol badges", async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ session_id: "s1", protocol: "ssh", connection_name: "SSH Box" }),
      makeSession({ session_id: "s2", protocol: "vnc", connection_name: "VNC Desktop" }),
      makeSession({ session_id: "s3", protocol: "telnet", connection_name: "Legacy" }),
    ]);
    await act(async () => {
      render(<ActiveSessions />);
    });
    expect(await screen.findByText("ssh")).toBeInTheDocument();
    expect(screen.getByText("vnc")).toBeInTheDocument();
    expect(screen.getByText("telnet")).toBeInTheDocument();
  });

  it("renders web protocol badge", async () => {
    // Web Browser sessions (rustguac parity Phase 2) get their own success-styled badge.
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ session_id: "sw", protocol: "web", connection_name: "Okta Login" }),
    ]);
    await act(async () => {
      render(<ActiveSessions />);
    });
    expect(await screen.findByText("web")).toBeInTheDocument();
  });

  it("renders vdi protocol badge", async () => {
    // VDI desktop containers (rustguac parity Phase 3) get their own accent-styled badge.
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ session_id: "sd", protocol: "vdi", connection_name: "Ubuntu Desktop" }),
    ]);
    await act(async () => {
      render(<ActiveSessions />);
    });
    expect(await screen.findByText("vdi")).toBeInTheDocument();
  });

  it("toggles all sessions with select-all checkbox", async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ session_id: "s1" }),
      makeSession({ session_id: "s2", connection_name: "Server B" }),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => {
      render(<ActiveSessions />);
    });
    await screen.findByText("Server A");

    const checkboxes = screen.getAllByRole("checkbox");
    // First checkbox is select-all
    await user.click(checkboxes[0]);
    expect(screen.getByText("Kill 2 Session(s)")).toBeInTheDocument();

    // Toggle all off
    await user.click(checkboxes[0]);
    expect(screen.getByText("Kill 0 Session(s)")).toBeInTheDocument();
  });

  it("shows duration with minutes only when less than 1 hour", async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
    ]);
    await act(async () => {
      render(<ActiveSessions />);
    });
    await screen.findByText("Server A");
    // Should show "5m Xs" without hours
    expect(screen.getByText(/^\d+m \d+s$/)).toBeInTheDocument();
  });

  it("handles kill failure gracefully", async () => {
    vi.mocked(killSessions).mockRejectedValue(new Error("network"));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => {
      render(<ActiveSessions />);
    });
    await screen.findByText("Server A");

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);
    await user.click(screen.getByText("Kill 1 Session(s)"));
    await user.click(screen.getByText("Terminate"));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith("Failed to terminate sessions");
    });
    alertSpy.mockRestore();
  });
});
