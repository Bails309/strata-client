import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

vi.mock("../api", () => ({
  getDmzLinks: vi.fn(),
  reconnectDmzLinks: vi.fn(),
}));

import DmzLinksTab from "../pages/admin/DmzLinksTab";
import { getDmzLinks, reconnectDmzLinks } from "../api";

const upRow = {
  endpoint: "tls://dmz1.internal:8444",
  state: "up",
  connects: 7,
  failures: 1,
  since_unix_secs: Math.floor(Date.now() / 1000) - 30,
  last_error: null,
};

const backoffRow = {
  endpoint: "tls://dmz2.internal:8444",
  state: "backoff",
  connects: 0,
  failures: 4,
  since_unix_secs: Math.floor(Date.now() / 1000) - 4000,
  last_error: "tls handshake timed out",
};

describe("DmzLinksTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getDmzLinks as any).mockResolvedValue({
      configured: true,
      links: [upRow, backoffRow],
    });
    (reconnectDmzLinks as any).mockResolvedValue({ nudged: 2 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the loading state before the first response arrives", () => {
    (getDmzLinks as any).mockReturnValue(new Promise(() => {}));
    render(<DmzLinksTab />);
    expect(screen.getByText("Loading DMZ link status...")).toBeInTheDocument();
  });

  it("renders the disabled-mode card when DMZ is not configured", async () => {
    (getDmzLinks as any).mockResolvedValue({ configured: false, links: [] });
    render(<DmzLinksTab />);
    await screen.findByText(/DMZ mode is not enabled/i);
  });

  it("renders an empty-state card when configured with zero endpoints", async () => {
    (getDmzLinks as any).mockResolvedValue({ configured: true, links: [] });
    render(<DmzLinksTab />);
    await screen.findByText("No DMZ endpoints configured.");
  });

  it("renders the link table with state badges and relative times", async () => {
    render(<DmzLinksTab />);
    await screen.findByText("tls://dmz1.internal:8444");
    expect(screen.getByText("tls://dmz2.internal:8444")).toBeInTheDocument();
    expect(screen.getByText("up")).toBeInTheDocument();
    expect(screen.getByText("backoff")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("tls handshake timed out")).toBeInTheDocument();
    expect(screen.getByText(/30s ago|29s ago|31s ago/)).toBeInTheDocument();
  });

  it("renders dash for empty since/last_error and uses minute/hour/day formats", async () => {
    const now = Math.floor(Date.now() / 1000);
    (getDmzLinks as any).mockResolvedValue({
      configured: true,
      links: [
        { ...upRow, endpoint: "tls://a", since_unix_secs: 0, last_error: null },
        { ...upRow, endpoint: "tls://b", state: "connecting", since_unix_secs: now - 120 },
        { ...upRow, endpoint: "tls://c", state: "authenticating", since_unix_secs: now - 7200 },
        { ...upRow, endpoint: "tls://d", state: "initializing", since_unix_secs: now - 200000 },
        { ...upRow, endpoint: "tls://e", state: "stopped", since_unix_secs: now - 5 },
        { ...upRow, endpoint: "tls://f", state: "unknown_state", since_unix_secs: now - 5 },
      ],
    });
    render(<DmzLinksTab />);
    await screen.findByText("tls://a");
    expect(screen.getByText("2m ago")).toBeInTheDocument();
    expect(screen.getByText("2h ago")).toBeInTheDocument();
    expect(screen.getByText("2d ago")).toBeInTheDocument();
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(2); // since=0 + last_error null fallbacks
    expect(screen.getByText("connecting")).toBeInTheDocument();
    expect(screen.getByText("authenticating")).toBeInTheDocument();
    expect(screen.getByText("initializing")).toBeInTheDocument();
    expect(screen.getByText("stopped")).toBeInTheDocument();
    expect(screen.getByText("unknown_state")).toBeInTheDocument();
  });

  it("force-reconnect calls the API, surfaces success message, and refreshes", async () => {
    render(<DmzLinksTab />);
    await screen.findByText("tls://dmz1.internal:8444");
    expect(getDmzLinks).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Force reconnect/ }));
    await waitFor(() => expect(reconnectDmzLinks).toHaveBeenCalledTimes(1));
    await screen.findByText("Reconnect requested for 2 link(s)");
    await waitFor(() => expect(getDmzLinks).toHaveBeenCalledTimes(2));
  });

  it("shows an error banner when force-reconnect fails", async () => {
    (reconnectDmzLinks as any).mockRejectedValue(new Error("nope"));
    render(<DmzLinksTab />);
    await screen.findByText("tls://dmz1.internal:8444");
    fireEvent.click(screen.getByRole("button", { name: /Force reconnect/ }));
    await screen.findByText("Reconnect request failed");
  });

  it("shows the retry card and re-fetches on click when the initial load fails", async () => {
    (getDmzLinks as any).mockRejectedValueOnce(new Error("boom"));
    render(<DmzLinksTab />);
    await screen.findByText("Failed to load DMZ link status");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await screen.findByText("tls://dmz1.internal:8444");
  });

  it("the manual refresh button re-fetches the link list", async () => {
    render(<DmzLinksTab />);
    await screen.findByText("tls://dmz1.internal:8444");
    fireEvent.click(screen.getByRole("button", { name: /Auto-refreshing in/ }));
    await waitFor(() => expect(getDmzLinks).toHaveBeenCalledTimes(2));
  });

  it("auto-refreshes every 15 seconds via the countdown timer", async () => {
    vi.useFakeTimers();
    try {
      (getDmzLinks as any).mockResolvedValue({
        configured: true,
        links: [upRow],
      });
      render(<DmzLinksTab />);
      await vi.waitFor(() => expect(getDmzLinks).toHaveBeenCalledTimes(1));

      // Drive the 1s countdown 15 times → exactly one auto-refresh.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      await vi.waitFor(() => expect(getDmzLinks).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
