import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  refreshAccessToken: vi.fn(),
  readCookie: (name: string) => {
    const m = document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(name + "="));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
  },
}));

import SessionTimeoutWarning from "../components/SessionTimeoutWarning";
import { refreshAccessToken } from "../api";

/**
 * The component reads `session_expires` cookie holding **unix epoch seconds**.
 * These helpers prime / clear that cookie consistently across tests.
 */
function setExpiryMs(absMs: number) {
  const seconds = Math.floor(absMs / 1000);
  document.cookie = `session_expires=${seconds}; path=/`;
}
function clearExpiry() {
  document.cookie = "session_expires=; path=/; max-age=0";
}

describe("SessionTimeoutWarning", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(refreshAccessToken).mockResolvedValue(true);
    clearExpiry();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearExpiry();
  });

  it("renders nothing when no session_expires cookie", () => {
    const { container } = render(<SessionTimeoutWarning />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when expiry is far in the future", () => {
    setExpiryMs(Date.now() + 600_000);
    const { container } = render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(container.querySelector(".fixed")).toBeNull();
  });

  it("shows warning when expiry is within 120 seconds", () => {
    setExpiryMs(Date.now() + 60_000);
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText("Session expiring")).toBeInTheDocument();
  });

  it("shows time remaining", () => {
    // session_expires cookie holds whole seconds, so we set ~91s ahead so the
    // floored display falls in the 1:28-1:30 range after a 1.1s tick.
    setExpiryMs(Date.now() + 91_000);
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText(/1:2[7-9]|1:30/)).toBeInTheDocument();
  });

  it("shows Extend Session button", () => {
    setExpiryMs(Date.now() + 60_000);
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText("Extend Session")).toBeInTheDocument();
  });

  it("calls refreshAccessToken on Extend click", async () => {
    setExpiryMs(Date.now() + 60_000);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    await user.click(screen.getByText("Extend Session"));
    await waitFor(() => expect(refreshAccessToken).toHaveBeenCalled());
  });

  it("hides warning after dismiss", async () => {
    setExpiryMs(Date.now() + 60_000);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    await user.click(screen.getByText("Dismiss"));
    expect(screen.queryByText("Session expiring")).not.toBeInTheDocument();
  });

  it("calls onExpired when timer reaches zero", () => {
    const onExpired = vi.fn();
    setExpiryMs(Date.now() + 2000);
    render(<SessionTimeoutWarning onExpired={onExpired} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onExpired).toHaveBeenCalled();
  });

  it("hides warning after successful extend", async () => {
    setExpiryMs(Date.now() + 60_000);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    await user.click(screen.getByText("Extend Session"));
    await waitFor(() => {
      expect(screen.queryByText("Session expiring")).not.toBeInTheDocument();
    });
  });

  it("shows seconds-only display when under a minute", () => {
    setExpiryMs(Date.now() + 30_000);
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText(/\d+s/)).toBeInTheDocument();
  });

  it("triggers proactive refresh on user activity within threshold", () => {
    setExpiryMs(Date.now() + 300_000);
    render(<SessionTimeoutWarning />);
    window.dispatchEvent(new Event("mousedown"));
    expect(refreshAccessToken).toHaveBeenCalled();
  });

  it("does not trigger proactive refresh outside threshold", () => {
    setExpiryMs(Date.now() + 900_000);
    render(<SessionTimeoutWarning />);
    window.dispatchEvent(new Event("mousedown"));
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("does not hide warning when extend fails", async () => {
    vi.mocked(refreshAccessToken).mockResolvedValue(false);
    setExpiryMs(Date.now() + 60_000);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    await user.click(screen.getByText("Extend Session"));
    await waitFor(() => {
      expect(screen.getByText("Session expiring")).toBeInTheDocument();
    });
  });

  it("enforces proactive refresh cooldown", () => {
    setExpiryMs(Date.now() + 300_000);
    render(<SessionTimeoutWarning />);
    window.dispatchEvent(new Event("mousedown"));
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("keydown"));
    // Should not call again due to cooldown
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });
});
