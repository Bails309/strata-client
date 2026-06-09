import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api", () => ({
  getPendingApprovals: vi.fn(),
  listPendingOutboundShares: vi.fn(),
  decideCheckout: vi.fn(),
  decideOutboundShare: vi.fn(),
}));

import {
  getPendingApprovals,
  listPendingOutboundShares,
  decideCheckout,
  decideOutboundShare,
  type CheckoutRequest,
  type OutboundShare,
  type MeResponse,
} from "../api";
import ToastProvider from "../components/ToastProvider";
import PendingApprovalWatcher from "../components/PendingApprovalWatcher";

function checkoutRequest(overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    id: "co-1",
    requester_user_id: "u-1",
    managed_ad_dn: "CN=svc_db_prod,OU=Service,DC=corp,DC=local",
    friendly_name: "svc_db_prod",
    status: "Pending",
    requested_duration_mins: 60,
    justification_comment: "Run quarterly backup",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    requester_username: "alice",
    ...overrides,
  };
}

function outboundShare(overrides: Partial<OutboundShare> = {}): OutboundShare {
  return {
    id: "ob-1",
    requester_user_id: "u-2",
    session_id: null,
    connection_id: null,
    filename: "report.pdf",
    content_type: "application/pdf",
    size: 1024 * 512,
    sha256: "abc",
    storage_path: "/tmp/x",
    justification: "Send to auditors",
    dlp_score: 10,
    dlp_reasons: [],
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    download_token: null,
    downloaded_at: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    purged_at: null,
    requester_username: "bob",
    ...overrides,
  };
}

function user(overrides: Partial<MeResponse> = {}): MeResponse {
  // Only fields the watcher actually reads matter — the rest of MeResponse
  // is filled by a Partial cast so this factory stays light.
  return {
    id: "approver",
    username: "approver",
    role: "user",
    client_ip: "127.0.0.1",
    watermark_enabled: false,
    vault_configured: true,
    can_manage_system: false,
    can_manage_users: false,
    can_manage_connections: false,
    can_view_audit_logs: false,
    can_create_users: false,
    can_create_user_groups: false,
    can_create_connections: false,
    can_use_quick_share: false,
    can_use_quick_share_outbound: false,
    can_create_sharing_profiles: false,
    can_view_sessions: false,
    is_approver: true,
    is_outbound_approver: true,
    outbound_share_requires_approval: true,
    ...overrides,
  };
}

function mount(props: Parameters<typeof PendingApprovalWatcher>[0] = { user: user() }) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <PendingApprovalWatcher pollIntervalMs={1000} autoDismissMs={30_000} {...props} />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("PendingApprovalWatcher", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(getPendingApprovals).mockReset();
    vi.mocked(listPendingOutboundShares).mockReset();
    vi.mocked(decideCheckout).mockReset();
    vi.mocked(decideOutboundShare).mockReset();
    vi.mocked(getPendingApprovals).mockResolvedValue([]);
    vi.mocked(listPendingOutboundShares).mockResolvedValue([]);
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders nothing for a user with no approval rights", async () => {
    mount({ user: user({ is_approver: false, is_outbound_approver: false }) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(getPendingApprovals).not.toHaveBeenCalled();
    expect(listPendingOutboundShares).not.toHaveBeenCalled();
  });

  it("only polls the queues the user is gated for", async () => {
    mount({
      user: user({ vault_configured: false, is_approver: false, is_outbound_approver: true }),
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getPendingApprovals).not.toHaveBeenCalled();
    expect(listPendingOutboundShares).toHaveBeenCalled();
  });

  it("shows a popup card when a checkout approval lands", async () => {
    vi.mocked(getPendingApprovals).mockResolvedValue([checkoutRequest()]);
    mount();
    await waitFor(() =>
      expect(screen.getByText(/Credential checkout requested/)).toBeInTheDocument()
    );
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText(/svc_db_prod/)).toBeInTheDocument();
    expect(screen.getByText(/Run quarterly backup/)).toBeInTheDocument();
  });

  it("shows a popup card when an outbound share approval lands", async () => {
    vi.mocked(listPendingOutboundShares).mockResolvedValue([
      outboundShare({ dlp_score: 75, dlp_reasons: ["pii:ssn"] }),
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getByText(/Outbound file share requested/)).toBeInTheDocument()
    );
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText(/DLP 75/)).toBeInTheDocument();
    expect(screen.getByText(/pii:ssn/)).toBeInTheDocument();
  });

  it("approves a checkout inline and clears the card", async () => {
    const user_ = userEvent.setup();
    vi.mocked(getPendingApprovals).mockResolvedValue([checkoutRequest()]);
    vi.mocked(decideCheckout).mockResolvedValue({ status: "Approved" });
    mount();
    await waitFor(() =>
      expect(screen.getByText(/Credential checkout requested/)).toBeInTheDocument()
    );
    // After approve, refresh() runs — return empty so the card stays gone.
    vi.mocked(getPendingApprovals).mockResolvedValue([]);
    await user_.click(screen.getByRole("button", { name: /^Approve$/ }));
    await waitFor(() => expect(decideCheckout).toHaveBeenCalledWith("co-1", true));
    await waitFor(() => expect(screen.queryByText(/Credential checkout requested/)).toBeNull());
  });

  it("requires a reason before deny is confirmed and sends it through for outbound", async () => {
    const user_ = userEvent.setup();
    vi.mocked(listPendingOutboundShares).mockResolvedValue([outboundShare()]);
    vi.mocked(decideOutboundShare).mockResolvedValue({ id: "ob-1", status: "denied" });
    mount();
    await waitFor(() =>
      expect(screen.getByText(/Outbound file share requested/)).toBeInTheDocument()
    );
    await user_.click(screen.getByRole("button", { name: /^Deny$/ }));
    // "Confirm deny" is disabled until a reason is entered.
    const confirm = screen.getByRole("button", { name: /Confirm deny/ });
    expect(confirm).toBeDisabled();
    await user_.type(screen.getByLabelText(/Reason for denial/), "Wrong recipient");
    expect(confirm).not.toBeDisabled();
    vi.mocked(listPendingOutboundShares).mockResolvedValue([]);
    await user_.click(confirm);
    await waitFor(() =>
      expect(decideOutboundShare).toHaveBeenCalledWith("ob-1", false, "Wrong recipient")
    );
  });

  it("forwards the deny reason through to decideCheckout for credential checkouts", async () => {
    const user_ = userEvent.setup();
    vi.mocked(getPendingApprovals).mockResolvedValue([checkoutRequest()]);
    vi.mocked(decideCheckout).mockResolvedValue({ status: "Denied" });
    mount();
    await waitFor(() =>
      expect(screen.getByText(/Credential checkout requested/)).toBeInTheDocument()
    );
    await user_.click(screen.getByRole("button", { name: /^Deny$/ }));
    await user_.type(screen.getByLabelText(/Reason for denial/), "Out of change window");
    vi.mocked(getPendingApprovals).mockResolvedValue([]);
    await user_.click(screen.getByRole("button", { name: /Confirm deny/ }));
    await waitFor(() =>
      expect(decideCheckout).toHaveBeenCalledWith("co-1", false, "Out of change window")
    );
  });

  it("does not re-show the same pending item on subsequent polls after dismissal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user_ = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      vi.mocked(getPendingApprovals).mockResolvedValue([checkoutRequest()]);
      mount();
      await waitFor(() =>
        expect(screen.getByText(/Credential checkout requested/)).toBeInTheDocument()
      );
      await user_.click(screen.getByRole("button", { name: /Dismiss notification/ }));
      expect(screen.queryByText(/Credential checkout requested/)).toBeNull();
      // Force another poll cycle — the same pending row comes back from the
      // server but the de-dup tracker must keep the card hidden.
      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.queryByText(/Credential checkout requested/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
