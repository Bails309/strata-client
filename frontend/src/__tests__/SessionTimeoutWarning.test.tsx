import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  refreshAccessToken: vi.fn(),
}));

import SessionTimeoutWarning from "../components/SessionTimeoutWarning";
import { refreshAccessToken } from "../api";

describe("SessionTimeoutWarning", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(refreshAccessToken).mockResolvedValue(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders nothing when no token_expiry in localStorage", () => {
    const { container } = render(<SessionTimeoutWarning />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when expiry is far in the future", () => {
    localStorage.setItem("token_expiry", String(Date.now() + 600_000));
    const { container } = render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(container.querySelector(".fixed")).toBeNull();
  });

  it("shows warning when expiry is within 120 seconds", () => {
    localStorage.setItem("token_expiry", String(Date.now() + 60_000));
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText("Session expiring")).toBeInTheDocument();
  });

  it("shows time remaining", () => {
    localStorage.setItem("token_expiry", String(Date.now() + 90_000));
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText(/1:29|1:30/)).toBeInTheDocument();
  });

  it("shows Extend Session button", () => {
    localStorage.setItem("token_expiry", String(Date.now() + 60_000));
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText("Extend Session")).toBeInTheDocument();
  });

  it("calls refreshAccessToken on Extend click", async () => {
    localStorage.setItem("token_expiry", String(Date.now() + 60_000));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    await user.click(screen.getByText("Extend Session"));
    await waitFor(() => expect(refreshAccessToken).toHaveBeenCalled());
  });

  it("hides warning after dismiss", async () => {
    localStorage.setItem("token_expiry", String(Date.now() + 60_000));
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
    localStorage.setItem("token_expiry", String(Date.now() + 2000));
    render(<SessionTimeoutWarning onExpired={onExpired} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onExpired).toHaveBeenCalled();
  });

  it("hides warning after successful extend", async () => {
    localStorage.setItem("token_expiry", String(Date.now() + 60_000));
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
    localStorage.setItem("token_expiry", String(Date.now() + 30_000));
    render(<SessionTimeoutWarning />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText(/\d+s/)).toBeInTheDocument();
  });

  it("triggers proactive refresh on user activity within threshold", () => {
    localStorage.setItem("token_expiry", String(Date.now() + 300_000));
    render(<SessionTimeoutWarning />);
    window.dispatchEvent(new Event("mousedown"));
    expect(refreshAccessToken).toHaveBeenCalled();
  });

  it("does not trigger proactive refresh outside threshold", () => {
    localStorage.setItem("token_expiry", String(Date.now() + 900_000));
    render(<SessionTimeoutWarning />);
    window.dispatchEvent(new Event("mousedown"));
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("does not hide warning when extend fails", async () => {
    vi.mocked(refreshAccessToken).mockResolvedValue(false);
    localStorage.setItem("token_expiry", String(Date.now() + 60_000));
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
    localStorage.setItem("token_expiry", String(Date.now() + 300_000));
    render(<SessionTimeoutWarning />);
    window.dispatchEvent(new Event("mousedown"));
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("keydown"));
    // Should not call again due to cooldown
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });
});
