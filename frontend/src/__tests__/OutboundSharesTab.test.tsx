import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OutboundSharesTab from "../pages/admin/OutboundSharesTab";
import type { OutboundShare, OutboundShareApprover, User } from "../api";

// ── api mocks ─────────────────────────────────────────────────────────
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listOutboundShares: vi.fn(),
    listPendingOutboundShares: vi.fn(),
    decideOutboundShare: vi.fn(),
    purgeOutboundShare: vi.fn(),
    listOutboundApprovers: vi.fn(),
    addOutboundApprover: vi.fn(),
    removeOutboundApprover: vi.fn(),
    outboundShareDownloadUrl: (t: string) => `/api/user/outbound-shares/download/${t}`,
  };
});

// ── Select mock ───────────────────────────────────────────────────────
// The project Select component renders a portal-based custom dropdown.
// Replace with a plain native <select> so tests can drive it with
// `userEvent.selectOptions`. Mirrors the mock used in
// QuickShareOutbound.test.tsx.
vi.mock("../components/Select", () => ({
  default: ({
    value,
    onChange,
    options,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
    placeholder?: string;
  }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder ?? ""}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

import {
  listOutboundShares,
  listPendingOutboundShares,
  decideOutboundShare,
  purgeOutboundShare,
  listOutboundApprovers,
  addOutboundApprover,
  removeOutboundApprover,
} from "../api";

// ── fixtures ──────────────────────────────────────────────────────────
const baseShare = (over: Partial<OutboundShare> = {}): OutboundShare => ({
  id: "s-1",
  requester_user_id: "u-1",
  session_id: null,
  connection_id: null,
  filename: "report.pdf",
  content_type: "application/pdf",
  size: 4096,
  sha256: "deadbeef",
  storage_path: "/srv/staged/s-1.enc",
  justification: null,
  dlp_score: 0,
  dlp_reasons: [],
  status: "pending",
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  download_token: null,
  downloaded_at: null,
  created_at: "2026-06-01T12:00:00Z",
  expires_at: "2026-06-08T12:00:00Z",
  purged_at: null,
  ...over,
});

const users: User[] = [
  {
    id: "u-1",
    username: "alice",
    email: "alice@corp.local",
    auth_type: "local",
    role_name: "user",
    safeguard_jit_enabled: false,
    outbound_share_requires_approval: true,
  },
  {
    id: "u-2",
    username: "bob",
    email: "bob@corp.local",
    auth_type: "local",
    role_name: "user",
    safeguard_jit_enabled: false,
    outbound_share_requires_approval: true,
  },
];

const onSave = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  onSave.mockReset();
  vi.mocked(listPendingOutboundShares).mockResolvedValue([]);
  vi.mocked(listOutboundShares).mockResolvedValue([]);
  vi.mocked(listOutboundApprovers).mockResolvedValue([]);
  vi.mocked(decideOutboundShare).mockResolvedValue({ id: "s-1", status: "approved" });
  vi.mocked(purgeOutboundShare).mockResolvedValue({ status: "purged" });
  vi.mocked(addOutboundApprover).mockResolvedValue({ status: "added" });
  vi.mocked(removeOutboundApprover).mockResolvedValue({ status: "removed" });
});

describe("OutboundSharesTab", () => {
  it("renders a loading state before the first fetch resolves", () => {
    vi.mocked(listPendingOutboundShares).mockReturnValue(new Promise(() => {}));
    vi.mocked(listOutboundShares).mockReturnValue(new Promise(() => {}));
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(screen.getByText(/Loading outbound shares/i)).toBeInTheDocument();
  });

  it("shows the empty-state copy when both queues are empty", async () => {
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(await screen.findByText("Pending (0)")).toBeInTheDocument();
    expect(screen.getByText(/No shares waiting for approval/i)).toBeInTheDocument();
    expect(screen.getByText(/No submissions yet/i)).toBeInTheDocument();
  });

  it("shows the load error when the pending fetch rejects", async () => {
    vi.mocked(listPendingOutboundShares).mockRejectedValue(new Error("boom"));
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("falls back to a generic error string when the rejection is not an Error", async () => {
    vi.mocked(listPendingOutboundShares).mockRejectedValue("nope");
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(await screen.findByText(/Failed to load outbound shares/i)).toBeInTheDocument();
  });

  it("renders a pending share with requester, DLP flags, justification and approves it", async () => {
    vi.mocked(listPendingOutboundShares).mockResolvedValue([
      baseShare({
        id: "p-1",
        dlp_score: 42,
        dlp_reasons: ["pii", "ssn"],
        justification: "audit export",
      }),
    ]);
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    // "alice" appears both in the pending row and in the super-admin add-approver
    // dropdown — match at least one occurrence.
    expect(screen.getAllByText(/alice/).length).toBeGreaterThan(0);
    expect(screen.getByText(/DLP 42/)).toBeInTheDocument();
    expect(screen.getByText(/Flags: pii, ssn/)).toBeInTheDocument();
    expect(screen.getByText(/audit export/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    await waitFor(() => expect(decideOutboundShare).toHaveBeenCalledWith("p-1", true));
    expect(onSave).toHaveBeenCalled();
  });

  it("alerts when approve fails", async () => {
    vi.mocked(listPendingOutboundShares).mockResolvedValue([baseShare({ id: "p-1" })]);
    vi.mocked(decideOutboundShare).mockRejectedValue(new Error("approve-fail"));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("report.pdf");
    await userEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("approve-fail"));
    alertSpy.mockRestore();
  });

  it("opens the deny modal, sends a reason, and refreshes", async () => {
    vi.mocked(listPendingOutboundShares).mockResolvedValue([baseShare({ id: "p-1" })]);
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("report.pdf");

    await userEvent.click(screen.getByRole("button", { name: /^Deny$/ }));
    const textarea = await screen.findByPlaceholderText(/Reason \(optional\)/i);
    await userEvent.type(textarea, "sensitive data");
    await userEvent.click(screen.getByRole("button", { name: /Deny & purge/i }));

    await waitFor(() =>
      expect(decideOutboundShare).toHaveBeenCalledWith("p-1", false, "sensitive data")
    );
    expect(onSave).toHaveBeenCalled();
  });

  it("alerts when deny-confirm fails and leaves the modal open", async () => {
    vi.mocked(listPendingOutboundShares).mockResolvedValue([baseShare({ id: "p-1" })]);
    vi.mocked(decideOutboundShare).mockRejectedValue(new Error("deny-fail"));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("report.pdf");

    await userEvent.click(screen.getByRole("button", { name: /^Deny$/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Deny & purge/i }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("deny-fail"));
    alertSpy.mockRestore();
  });

  it("closes the deny modal when Cancel is clicked", async () => {
    vi.mocked(listPendingOutboundShares).mockResolvedValue([baseShare({ id: "p-1" })]);
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("report.pdf");
    await userEvent.click(screen.getByRole("button", { name: /^Deny$/ }));
    await screen.findByRole("button", { name: /Cancel/ });
    await userEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument()
    );
  });

  it("renders history rows with download link for approved shares (super-admin sees Purge)", async () => {
    vi.mocked(listOutboundShares).mockResolvedValue([
      baseShare({
        id: "h-1",
        status: "approved",
        download_token: "tok-abc",
        decided_by: "u-2",
        decision_reason: "ok",
      }),
      baseShare({ id: "h-2", status: "purged", filename: "old.zip" }),
    ]);
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(await screen.findByText("History (2)")).toBeInTheDocument();
    const downloadLink = screen.getByRole("link", { name: /Download/ });
    expect(downloadLink).toHaveAttribute("href", "/api/user/outbound-shares/download/tok-abc");
    // Purge button visible on the non-purged row only
    expect(screen.getAllByRole("button", { name: /Purge/ })).toHaveLength(1);
  });

  it("runs the purge flow when the user confirms", async () => {
    vi.mocked(listOutboundShares).mockResolvedValue([
      baseShare({ id: "h-1", status: "approved", download_token: "tok-1" }),
    ]);
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("History (1)");
    await userEvent.click(screen.getByRole("button", { name: /Purge/ }));
    // The Purge button now opens the shared themed ConfirmModal instead of
    // triggering window.confirm; click the Purge button inside the modal.
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Purge/ }));
    await waitFor(() => expect(purgeOutboundShare).toHaveBeenCalledWith("h-1"));
    expect(onSave).toHaveBeenCalled();
  });

  it("skips purge when the user cancels the confirm prompt", async () => {
    vi.mocked(listOutboundShares).mockResolvedValue([
      baseShare({ id: "h-1", status: "approved", download_token: "tok-1" }),
    ]);
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("History (1)");
    await userEvent.click(screen.getByRole("button", { name: /Purge/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Cancel/ }));
    expect(purgeOutboundShare).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("alerts when purge fails", async () => {
    vi.mocked(listOutboundShares).mockResolvedValue([
      baseShare({ id: "h-1", status: "approved", download_token: "tok-1" }),
    ]);
    vi.mocked(purgeOutboundShare).mockRejectedValue(new Error("purge-fail"));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("History (1)");
    await userEvent.click(screen.getByRole("button", { name: /Purge/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Purge/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("purge-fail"));
    alertSpy.mockRestore();
  });

  it("renders the formatSize KB / MB / GB ladder via different file sizes", async () => {
    vi.mocked(listOutboundShares).mockResolvedValue([
      baseShare({ id: "h-1", filename: "tiny", size: 500 }),
      baseShare({ id: "h-2", filename: "kb", size: 2048 }),
      baseShare({ id: "h-3", filename: "mb", size: 1024 * 1024 * 3 }),
      baseShare({ id: "h-4", filename: "gb", size: 1024 * 1024 * 1024 * 2 }),
    ]);
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(await screen.findByText("500 B")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByText("3.0 MB")).toBeInTheDocument();
    expect(screen.getByText("2.0 GB")).toBeInTheDocument();
  });

  it("hides the approver-list section for non-super-admins and never calls listOutboundApprovers", async () => {
    render(<OutboundSharesTab users={users} isSuperAdmin={false} onSave={onSave} />);
    await screen.findByText("Pending (0)");
    expect(screen.queryByText(/Designated Approvers/i)).not.toBeInTheDocument();
    expect(listOutboundApprovers).not.toHaveBeenCalled();
  });

  it("renders the empty approver-list copy for super-admins", async () => {
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(await screen.findByText(/Designated Approvers/i)).toBeInTheDocument();
    expect(
      screen.getByText(/No delegated approvers — only super-admins can decide right now/i)
    ).toBeInTheDocument();
  });

  it("lists current approvers and removes one", async () => {
    const a: OutboundShareApprover = {
      user_id: "u-2",
      username: "bob",
      email: "bob@corp.local",
      full_name: null,
      created_at: "2026-06-01T00:00:00Z",
    };
    vi.mocked(listOutboundApprovers).mockResolvedValue([a]);
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    expect(await screen.findByText("bob")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Remove/ }));
    await waitFor(() => expect(removeOutboundApprover).toHaveBeenCalledWith("u-2"));
    expect(onSave).toHaveBeenCalled();
  });

  it("alerts when remove-approver fails", async () => {
    const a: OutboundShareApprover = {
      user_id: "u-2",
      username: "bob",
      email: "bob@corp.local",
      full_name: null,
      created_at: "2026-06-01T00:00:00Z",
    };
    vi.mocked(listOutboundApprovers).mockResolvedValue([a]);
    vi.mocked(removeOutboundApprover).mockRejectedValue(new Error("remove-fail"));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("bob");
    await userEvent.click(screen.getByRole("button", { name: /Remove/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("remove-fail"));
    alertSpy.mockRestore();
  });

  it("disables Add until an approver is picked, then adds one", async () => {
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText(/Designated Approvers/i);
    const addBtn = screen.getByRole("button", { name: /^Add$/ });
    expect(addBtn).toBeDisabled();
    const select = screen.getByRole("combobox");
    await userEvent.selectOptions(select, "u-2");
    expect(addBtn).not.toBeDisabled();
    await userEvent.click(addBtn);
    await waitFor(() => expect(addOutboundApprover).toHaveBeenCalledWith("u-2"));
    expect(onSave).toHaveBeenCalled();
  });

  it("alerts when add-approver fails", async () => {
    vi.mocked(addOutboundApprover).mockRejectedValue(new Error("add-fail"));
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText(/Designated Approvers/i);
    await userEvent.selectOptions(screen.getByRole("combobox"), "u-2");
    await userEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("add-fail"));
    alertSpy.mockRestore();
  });

  it("Refresh button re-fetches both queues", async () => {
    render(<OutboundSharesTab users={users} isSuperAdmin onSave={onSave} />);
    await screen.findByText("Pending (0)");
    vi.mocked(listPendingOutboundShares).mockClear();
    vi.mocked(listOutboundShares).mockClear();
    await userEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
    await waitFor(() => {
      expect(listPendingOutboundShares).toHaveBeenCalled();
      expect(listOutboundShares).toHaveBeenCalled();
    });
  });
});
