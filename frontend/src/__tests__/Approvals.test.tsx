import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  getPendingApprovals: vi.fn(),
  decideCheckout: vi.fn(),
}));

import Approvals from "../pages/Approvals";
import { getPendingApprovals, decideCheckout } from "../api";
import type { MeResponse } from "../api";

const mockUser: MeResponse = {
  id: "u1",
  username: "admin",
  role: "admin",
  client_ip: "127.0.0.1",
  watermark_enabled: false,
  vault_configured: true,
  can_manage_system: true,
  can_manage_users: true,
  can_manage_connections: true,
  can_view_audit_logs: true,
  can_create_users: true,
  can_create_user_groups: true,
  can_create_connections: true,
  can_use_quick_share: true,
  can_create_sharing_profiles: true,
  can_view_sessions: true,
  is_approver: true,
};

const pendingRequests = [
  {
    id: "cr1",
    requester_user_id: "u2",
    requester_username: "alice",
    managed_ad_dn: "CN=svc-account,OU=Service,DC=corp,DC=local",
    status: "Pending" as const,
    requested_duration_mins: 120,
    justification_comment: "Need to fix production issue",
    created_at: new Date(Date.now() - 30 * 60000).toISOString(), // 30 mins ago
    updated_at: new Date().toISOString(),
  },
  {
    id: "cr2",
    requester_user_id: "u3",
    requester_username: "bob",
    managed_ad_dn: "CN=admin-account,DC=corp,DC=local",
    status: "Pending" as const,
    requested_duration_mins: 30,
    created_at: new Date(Date.now() - 2 * 3600000).toISOString(), // 2 hours ago
    updated_at: new Date().toISOString(),
  },
  {
    id: "cr3",
    requester_user_id: "u4",
    managed_ad_dn: "CN=test\\,comma,DC=corp,DC=local",
    status: "Pending" as const,
    requested_duration_mins: 1440, // 24 hours
    created_at: new Date(Date.now() - 25 * 3600000).toISOString(), // 25 hours ago
    updated_at: new Date().toISOString(),
  },
];

describe("Approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders heading and empty state", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([]);
    render(<Approvals user={mockUser} />);
    expect(screen.getByText("Pending Approvals")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("No pending approvals.")).toBeInTheDocument();
    });
  });

  it("renders pending requests with requester info and DN parsing", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue(pendingRequests);
    render(<Approvals user={mockUser} />);

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    // CN extracted from DN
    expect(screen.getByText("svc-account")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("admin-account")).toBeInTheDocument();
    // Escaped comma in CN
    expect(screen.getByText("test,comma")).toBeInTheDocument();
  });

  it("shows duration formatting (hours and minutes)", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue(pendingRequests);
    render(<Approvals user={mockUser} />);
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    // 120 mins → 2h
    expect(screen.getByText("2h")).toBeInTheDocument();
    // 30 mins → 30m
    expect(screen.getByText("30m")).toBeInTheDocument();
    // 1440 mins → 24h
    expect(screen.getByText("24h")).toBeInTheDocument();
  });

  it("shows justification comment when present", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue(pendingRequests);
    render(<Approvals user={mockUser} />);
    await waitFor(() => {
      expect(screen.getByText(/Need to fix production issue/)).toBeInTheDocument();
    });
  });

  it("shows timeAgo formatting", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([
      {
        ...pendingRequests[0],
        created_at: new Date(Date.now() - 10000).toISOString(), // 10 seconds ago
      },
    ]);
    render(<Approvals user={mockUser} />);
    await waitFor(() => {
      expect(screen.getByText("just now")).toBeInTheDocument();
    });
  });

  it("approves a request and shows flash message", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getPendingApprovals).mockResolvedValue(pendingRequests);
    vi.mocked(decideCheckout).mockResolvedValue({ status: "Approved" });
    render(<Approvals user={mockUser} />);

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });

    const approveButtons = screen.getAllByText("Approve");
    await user.click(approveButtons[0]);

    await waitFor(() => {
      expect(decideCheckout).toHaveBeenCalledWith("cr1", true);
    });
    expect(screen.getByText("Checkout approved")).toBeInTheDocument();
  });

  it("denies a request and shows flash message", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getPendingApprovals).mockResolvedValue(pendingRequests);
    vi.mocked(decideCheckout).mockResolvedValue({ status: "Denied" });
    render(<Approvals user={mockUser} />);

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });

    const denyButtons = screen.getAllByText("Deny");
    await user.click(denyButtons[0]);

    await waitFor(() => {
      expect(decideCheckout).toHaveBeenCalledWith("cr1", false);
    });
    expect(screen.getByText("Checkout denied")).toBeInTheDocument();
  });

  it("shows error message when decision fails", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getPendingApprovals).mockResolvedValue(pendingRequests);
    vi.mocked(decideCheckout).mockRejectedValue(new Error("Network error"));
    render(<Approvals user={mockUser} />);

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });

    const approveButtons = screen.getAllByText("Approve");
    await user.click(approveButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("handles decision failure with no message", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getPendingApprovals).mockResolvedValue([pendingRequests[0]]);
    vi.mocked(decideCheckout).mockRejectedValue({});
    render(<Approvals user={mockUser} />);

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Approve"));
    await waitFor(() => {
      expect(screen.getByText("Decision failed")).toBeInTheDocument();
    });
  });

  it("refresh button reloads pending approvals", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getPendingApprovals).mockResolvedValue([]);
    render(<Approvals user={mockUser} />);

    await waitFor(() => {
      expect(getPendingApprovals).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByText("Refresh"));
    await waitFor(() => {
      expect(getPendingApprovals).toHaveBeenCalledTimes(2);
    });
  });

  it("shows Pending badge on each request", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([pendingRequests[0]]);
    render(<Approvals user={mockUser} />);
    await waitFor(() => {
      expect(screen.getByText("Pending")).toBeInTheDocument();
    });
  });

  it("shows requester_user_id as fallback when username missing", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([pendingRequests[2]]);
    render(<Approvals user={mockUser} />);
    await waitFor(() => {
      expect(screen.getByText("u4")).toBeInTheDocument();
    });
  });

  it("disables buttons for the request being decided", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let resolveDecision: (v: any) => void;
    vi.mocked(getPendingApprovals).mockResolvedValue([pendingRequests[0]]);
    vi.mocked(decideCheckout).mockReturnValue(
      new Promise((r) => {
        resolveDecision = r;
      })
    );
    render(<Approvals user={mockUser} />);

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });

    // Click Approve - the first button matching "Approve" text
    const approveBtn = screen.getByRole("button", { name: /Approve/i });
    const denyBtn = screen.getByRole("button", { name: /Deny/i });
    await user.click(approveBtn);

    // Both buttons for this request should be disabled while deciding
    await waitFor(() => {
      expect(approveBtn).toBeDisabled();
      expect(denyBtn).toBeDisabled();
    });

    resolveDecision!({ status: "Approved" });
  });

  it("handles getPendingApprovals failure silently", async () => {
    vi.mocked(getPendingApprovals).mockRejectedValue(new Error("fail"));
    render(<Approvals user={mockUser} />);
    // Should still render - no crash
    await waitFor(() => {
      expect(screen.getByText("Pending Approvals")).toBeInTheDocument();
    });
  });

  it("displays full DN as secondary text", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([pendingRequests[0]]);
    render(<Approvals user={mockUser} />);
    await waitFor(() => {
      expect(screen.getByText("CN=svc-account,OU=Service,DC=corp,DC=local")).toBeInTheDocument();
    });
  });

  it("shows minutes format for duration under 60", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([
      {
        ...pendingRequests[0],
        requested_duration_mins: 45,
      },
    ]);
    render(<Approvals user={mockUser} />);
    await waitFor(() => {
      expect(screen.getByText("45m")).toBeInTheDocument();
    });
  });

  it("shows hours with remaining minutes", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([
      {
        ...pendingRequests[0],
        requested_duration_mins: 90,
      },
    ]);
    render(<Approvals user={mockUser} />);
    await waitFor(() => {
      expect(screen.getByText(/1h\s+30m/)).toBeInTheDocument();
    });
  });
});
