import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QuickShareOutbound from "../components/QuickShareOutbound";
import type { OutboundShare, OutboundShareIngestToken } from "../api";

// Fields QuickShareOutbound actually reads off a session. Kept narrow so
// the test doesn't depend on the full GuacSession type (which carries
// live Guacamole.Client / Tunnel handles that aren't worth stubbing).
type SessionStub = {
  id: string;
  connectionId: string;
  protocol: string;
  filesystems: { name: string }[];
  fileTransferEnabled?: boolean;
  pendingOutboundJustification?: string;
};

// ── api mocks ─────────────────────────────────────────────────────────
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    issueOutboundShareIngestToken: vi.fn(),
    listMyOutboundShares: vi.fn(),
    outboundShareDownloadUrl: (t: string) => `/api/user/outbound-shares/download/${t}`,
  };
});

import {
  issueOutboundShareIngestToken,
  listMyOutboundShares,
} from "../api";

// ── SessionManager mock ───────────────────────────────────────────────
const updateSession = vi.fn();
let mockSessionState: {
  sessions: SessionStub[];
  activeSessionId: string | null;
} = { sessions: [], activeSessionId: null };

vi.mock("../components/SessionManager", () => ({
  useSessionManager: () => ({
    sessions: mockSessionState.sessions,
    activeSessionId: mockSessionState.activeSessionId,
    updateSession,
  }),
}));

// ── Select mock ───────────────────────────────────────────────────────
// The project Select component renders a complex headlessui combobox.
// Replace with a plain native <select> so the tests can drive it with
// `selectOptions`.
vi.mock("../components/Select", () => ({
  default: ({
    id,
    value,
    onChange,
    options,
  }: {
    id?: string;
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <select
      id={id}
      data-testid="select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

// ── Clipboard mock ────────────────────────────────────────────────────
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: writeTextMock },
  writable: true,
  configurable: true,
});

// ── Fixtures ──────────────────────────────────────────────────────────
const makeSession = (over: Partial<SessionStub> = {}): SessionStub => ({
  id: "sess-1",
  connectionId: "conn-1",
  protocol: "rdp",
  filesystems: [{ name: "Strata" }],
  fileTransferEnabled: true,
  pendingOutboundJustification: undefined,
  ...over,
});

const makeShare = (over: Partial<OutboundShare> = {}): OutboundShare => ({
  id: "h-1",
  requester_user_id: "u-1",
  session_id: null,
  connection_id: null,
  filename: "report.pdf",
  content_type: "application/pdf",
  size: 4096,
  sha256: "deadbeef",
  storage_path: null,
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

const makeToken = (over: Partial<OutboundShareIngestToken> = {}): OutboundShareIngestToken => ({
  token: "tok-123",
  expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  upload_path: "/api/outbound-ingest/tok-123",
  ...over,
});

const baseProps = {
  onClose: vi.fn(),
  sidebarWidth: 240,
  sessionBarCollapsed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  writeTextMock.mockClear();
  updateSession.mockReset();
  mockSessionState = { sessions: [], activeSessionId: null };
  vi.mocked(listMyOutboundShares).mockResolvedValue([]);
  vi.mocked(issueOutboundShareIngestToken).mockResolvedValue(makeToken());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("QuickShareOutbound", () => {
  it("renders the header and how-to banner; no-session warning when nothing is active", async () => {
    render(<QuickShareOutbound {...baseProps} />);
    expect(screen.getByText("Outbound Share")).toBeInTheDocument();
    expect(screen.getByText(/How to export a file from this session/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Open or focus a session to enable outbound transfers/i)
    ).toBeInTheDocument();
    await waitFor(() => expect(listMyOutboundShares).toHaveBeenCalled());
    expect(screen.getByText(/No submissions yet/i)).toBeInTheDocument();
  });

  it("close button invokes onClose", async () => {
    const onClose = vi.fn();
    render(<QuickShareOutbound {...baseProps} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /Close outbound share panel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the mapped drive name when the active session exposes a filesystem", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    expect(screen.getByText("Strata")).toBeInTheDocument();
  });

  it("falls back to 'This PC' hint for RDP without filesystems", async () => {
    mockSessionState = {
      sessions: [
        makeSession({
          id: "sess-1",
          filesystems: [],
        }),
      ],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    expect(screen.getByText("This PC")).toBeInTheDocument();
  });

  it("warns when the active connection has file transfer disabled", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", fileTransferEnabled: false })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    expect(
      screen.getByText(/File transfer is not configured on this connection/i)
    ).toBeInTheDocument();
  });

  it("disables the justification textarea when no session is active", () => {
    render(<QuickShareOutbound {...baseProps} />);
    expect(screen.getByPlaceholderText(/Why does the next exported file/i)).toBeDisabled();
  });

  it("writes the justification into the session via updateSession", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    const ta = screen.getByPlaceholderText(/Why does the next exported file/i);
    await userEvent.type(ta, "x");
    expect(updateSession).toHaveBeenCalledWith("sess-1", {
      pendingOutboundJustification: "x",
    });
  });

  it("defaults the snippet to plain curl for SSH protocol sessions", () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "ssh" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    expect(screen.getByTestId("select")).toHaveValue("curl");
  });

  it("defaults the snippet to curl-win for non-SSH/Telnet sessions", () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "rdp" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    expect(screen.getByTestId("select")).toHaveValue("curl-win");
  });

  it("Generate button is disabled without an active session", () => {
    render(<QuickShareOutbound {...baseProps} />);
    expect(screen.getByRole("button", { name: /Generate upload command/i })).toBeDisabled();
  });

  it("mints an ingest token and renders the curl snippet + countdown", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "ssh" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    await waitFor(() =>
      expect(issueOutboundShareIngestToken).toHaveBeenCalledWith({
        session_id: "sess-1",
        connection_id: "conn-1",
        justification: undefined,
      })
    );
    await screen.findByText(/Expires in/);
    // The snippet for curl format
    expect(screen.getByText(/curl -fL -F 'file=@\.\/<your-file>'/)).toBeInTheDocument();
    // Button label flips to Regenerate
    expect(
      screen.getByRole("button", { name: /Regenerate upload command/i })
    ).toBeInTheDocument();
  });

  it("includes the trimmed justification in the mint request when present", async () => {
    mockSessionState = {
      sessions: [
        makeSession({
          id: "sess-1",
          pendingOutboundJustification: "  audit  ",
        }),
      ],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    await waitFor(() =>
      expect(issueOutboundShareIngestToken).toHaveBeenCalledWith({
        session_id: "sess-1",
        connection_id: "conn-1",
        justification: "audit",
      })
    );
  });

  it("renders the issue error when the mint fails", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1" })],
      activeSessionId: "sess-1",
    };
    vi.mocked(issueOutboundShareIngestToken).mockRejectedValue(new Error("mint-fail"));
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    expect(await screen.findByText("mint-fail")).toBeInTheDocument();
  });

  it("falls back to a generic mint-fail message when the rejection is not an Error", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1" })],
      activeSessionId: "sess-1",
    };
    vi.mocked(issueOutboundShareIngestToken).mockRejectedValue("nope");
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    expect(await screen.findByText(/Failed to mint upload token/)).toBeInTheDocument();
  });

  it("renders the insecure curl-win snippet when 'Skip TLS cert check' is enabled", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "rdp" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.click(screen.getByLabelText(/Skip TLS cert check/i));
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    await screen.findByText(/curl\.exe -kfL/);
  });

  it("renders the PowerShell snippet when the format Select is changed", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "rdp" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.selectOptions(screen.getByTestId("select"), "powershell");
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    await screen.findByText(/Invoke-WebRequest -Uri/);
  });

  it("renders the insecure PowerShell snippet variant", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "rdp" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.selectOptions(screen.getByTestId("select"), "powershell");
    await userEvent.click(screen.getByLabelText(/Skip TLS cert check/i));
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    await screen.findByText(/ServicePointManager/);
  });

  it("copies the snippet to clipboard when Copy is clicked", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "ssh" })],
      activeSessionId: "sess-1",
    };
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    await screen.findByText(/Expires in/);
    await userEvent.click(screen.getByRole("button", { name: /^Copy$/ }));
    await waitFor(() => expect(writeTextMock).toHaveBeenCalled());
    expect(await screen.findByText(/^Copied$/)).toBeInTheDocument();
  });

  it("swallows clipboard rejections without crashing", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "ssh" })],
      activeSessionId: "sess-1",
    };
    writeTextMock.mockRejectedValueOnce(new Error("clipboard denied"));
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    await screen.findByText(/Expires in/);
    await userEvent.click(screen.getByRole("button", { name: /^Copy$/ }));
    await waitFor(() => expect(writeTextMock).toHaveBeenCalled());
    // No "Copied" should appear and the panel should still render
    expect(screen.queryByText(/^Copied$/)).not.toBeInTheDocument();
  });

  it("shows an expired-token notice once the ingest token has elapsed", async () => {
    mockSessionState = {
      sessions: [makeSession({ id: "sess-1", protocol: "ssh" })],
      activeSessionId: "sess-1",
    };
    vi.mocked(issueOutboundShareIngestToken).mockResolvedValue(
      makeToken({ expires_at: new Date(Date.now() - 1000).toISOString() })
    );
    render(<QuickShareOutbound {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /Generate upload command/i }));
    expect(await screen.findByText(/Token expired/i)).toBeInTheDocument();
    // Copy button is disabled when expired
    expect(screen.getByRole("button", { name: /^Copy$/ })).toBeDisabled();
  });

  it("re-fetches history when the global submitted event fires", async () => {
    render(<QuickShareOutbound {...baseProps} />);
    await waitFor(() => expect(listMyOutboundShares).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event("strata:outbound-share-submitted"));
    });
    await waitFor(() => expect(listMyOutboundShares).toHaveBeenCalledTimes(2));
  });

  it("renders history rows including a download link for approved shares", async () => {
    vi.mocked(listMyOutboundShares).mockResolvedValue([
      makeShare({
        id: "h-1",
        status: "approved",
        download_token: "tok-abc",
        dlp_reasons: ["pii"],
        decision_reason: "ok by Bob",
      }),
      makeShare({ id: "h-2", filename: "img.png", size: 1024 * 1024 * 5, status: "pending" }),
    ]);
    render(<QuickShareOutbound {...baseProps} />);
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("img.png")).toBeInTheDocument();
    expect(screen.getByText(/Flags: pii/)).toBeInTheDocument();
    expect(screen.getByText(/Approver: ok by Bob/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Download/ });
    expect(link).toHaveAttribute("href", "/api/user/outbound-shares/download/tok-abc");
  });

  it("Refresh button re-fetches history and disables itself while loading", async () => {
    render(<QuickShareOutbound {...baseProps} />);
    await waitFor(() => expect(listMyOutboundShares).toHaveBeenCalledTimes(1));
    vi.mocked(listMyOutboundShares).mockReturnValue(new Promise(() => {}));
    await userEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
    expect(screen.getByRole("button", { name: /Refreshing/ })).toBeDisabled();
  });

  it("swallows listMyOutboundShares rejection and still renders empty state", async () => {
    vi.mocked(listMyOutboundShares).mockRejectedValue(new Error("list-fail"));
    render(<QuickShareOutbound {...baseProps} />);
    expect(await screen.findByText(/No submissions yet/i)).toBeInTheDocument();
  });

  it("formats history sizes across the B / KB / MB / GB ladder", async () => {
    vi.mocked(listMyOutboundShares).mockResolvedValue([
      makeShare({ id: "h-a", filename: "tiny", size: 500 }),
      makeShare({ id: "h-b", filename: "kb", size: 2048 }),
      makeShare({ id: "h-c", filename: "mb", size: 1024 * 1024 * 3 }),
      makeShare({ id: "h-d", filename: "gb", size: 1024 * 1024 * 1024 * 2 }),
    ]);
    render(<QuickShareOutbound {...baseProps} />);
    expect(await screen.findByText(/500 B/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
    expect(screen.getByText(/3\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0 GB/)).toBeInTheDocument();
  });
});
