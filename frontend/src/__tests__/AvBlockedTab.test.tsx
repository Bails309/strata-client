import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAuditLogs } from "../api";

vi.mock("../api", () => ({
  readCookie: vi.fn(),
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

import AvBlockedTab from "../pages/admin/AvBlockedTab";

describe("AvBlockedTab", () => {
  it("renders heading and column headers", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([]);
    render(<AvBlockedTab />);
    expect(await screen.findByText("AV-Blocked Files")).toBeInTheDocument();
    expect(screen.getByText("Timestamp")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Filename")).toBeInTheDocument();
    expect(screen.getByText("Size")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Signature")).toBeInTheDocument();
    expect(screen.getByText("Engine message")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();
  });

  it("queries the audit endpoint with the file.av_blocked action_type", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([]);
    render(<AvBlockedTab />);
    await screen.findByText("AV-Blocked Files");
    expect(getAuditLogs).toHaveBeenCalledWith(1, 50, { action_type: "file.av_blocked" });
  });

  it("renders inbound and outbound rows with parsed details", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([
      {
        id: 11,
        created_at: "2026-02-01T12:00:00Z",
        action_type: "file.av_blocked",
        user_id: "u-111",
        username: "alice",
        details: {
          source: "inbound",
          filename: "report.docx",
          size: 2048,
          av_status: "infected",
          av_signature: "Eicar-Test-Signature",
          av_message: "Eicar-Test-Signature FOUND",
          av_backend: "clamav",
        },
        current_hash: "0".repeat(32),
      },
      {
        id: 12,
        created_at: "2026-02-01T12:05:00Z",
        action_type: "file.av_blocked",
        user_id: "u-222",
        username: "bob",
        details: {
          source: "outbound_token",
          filename: "payload.bin",
          size: 4096,
          av_status: "error",
          av_message: "clamd unreachable",
          av_backend: "clamav",
        },
        current_hash: "1".repeat(32),
      },
    ]);
    render(<AvBlockedTab />);
    expect(await screen.findByText("report.docx")).toBeInTheDocument();
    expect(screen.getByText("payload.bin")).toBeInTheDocument();
    expect(screen.getByText("Inbound")).toBeInTheDocument();
    expect(screen.getByText("Outbound (token)")).toBeInTheDocument();
    expect(screen.getByText("infected")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("Eicar-Test-Signature")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("shows empty state when no rows", async () => {
    vi.mocked(getAuditLogs).mockResolvedValue([]);
    render(<AvBlockedTab />);
    expect(
      await screen.findByText("No AV-blocked uploads have been recorded.")
    ).toBeInTheDocument();
  });

  it("Previous is disabled on page 1; Next paginates when full page returned", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      created_at: "2026-02-01T12:00:00Z",
      action_type: "file.av_blocked",
      user_id: "u-111",
      username: "alice",
      details: {
        source: "inbound",
        filename: `f-${i}.bin`,
        size: 1024,
        av_status: "infected",
        av_signature: "Sig",
        av_backend: "clamav",
      },
      current_hash: "0".repeat(32),
    }));
    vi.mocked(getAuditLogs).mockResolvedValue(fullPage);

    const user = userEvent.setup();
    render(<AvBlockedTab />);
    await screen.findAllByText("infected");

    expect(screen.getByText("Previous")).toBeDisabled();
    await user.click(screen.getByText("Next"));
    expect(screen.getByText("Page 2")).toBeInTheDocument();
  });

  it("displays an error banner if the fetch fails", async () => {
    vi.mocked(getAuditLogs).mockRejectedValue(new Error("boom"));
    render(<AvBlockedTab />);
    expect(await screen.findByText("Failed to load AV-blocked file list.")).toBeInTheDocument();
  });
});
