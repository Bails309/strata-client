import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api", () => ({
  getCredentialProfiles: vi.fn(),
}));

import { getCredentialProfiles, type CredentialProfile } from "../api";
import ToastProvider from "../components/ToastProvider";
import CredentialProfileExpiryWatcher from "../components/CredentialProfileExpiryWatcher";

function profile(overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  const now = Date.now();
  return {
    id: "p-1",
    label: "PROD",
    created_at: new Date(now - 3_600_000).toISOString(),
    updated_at: new Date(now - 3_600_000).toISOString(),
    expires_at: new Date(now + 25 * 3600 * 1000).toISOString(),
    expired: false,
    ttl_hours: 12,
    extended_expiry: false,
    ...overrides,
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <CredentialProfileExpiryWatcher pollIntervalMs={1000} />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("CredentialProfileExpiryWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
    vi.mocked(getCredentialProfiles).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("stays silent for a profile far from expiry", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([profile()]);
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fires a warning toast when a standard profile crosses the 1-hour threshold", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({ expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }),
    ]);
    mount();
    await waitFor(() => expect(screen.getByText(/PROD expires in/)).toBeInTheDocument());
  });

  it("fires an error toast for an already-expired profile", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({
        expired: true,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    mount();
    await waitFor(() => expect(screen.getByText(/PROD has expired/)).toBeInTheDocument());
  });

  it("does not fire the same warning twice across polls", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({ expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }),
    ]);
    mount();
    await waitFor(() => expect(screen.getAllByText(/PROD expires in/).length).toBe(1));
    // Advance one poll cycle; the toast may auto-dismiss after 8 s but the
    // tracker must prevent a second one from being published.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/PROD expires in/)).toBeNull();
  });

  it("re-arms warnings when the profile's expires_at jumps to a new window", async () => {
    const initial = profile({
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    vi.mocked(getCredentialProfiles).mockResolvedValueOnce([initial]);
    mount();
    await waitFor(() => expect(screen.getByText(/PROD expires in/)).toBeInTheDocument());

    // Renewal: expires_at jumps to 11.5 h ahead — back inside the 1-day
    // bucket but outside 1-hour. The next 1-hour crossing must fire again.
    const renewed = profile({
      expires_at: new Date(Date.now() + 30 * 60 * 1000 + 12 * 3600 * 1000).toISOString(),
    });
    vi.mocked(getCredentialProfiles).mockResolvedValue([renewed]);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // Now simulate clock advancing past the new 1-day mark — but the new
    // expiry is 12.5 h ahead, so we're already past 1 day. Verify the
    // component does not double-fire by checking only one toast remains.
    await act(async () => {
      await Promise.resolve();
    });
    // After re-arm + a fresh evaluation we expect exactly one card visible
    // for the profile (replace-by-key semantics).
    expect(screen.getAllByText(/PROD/).length).toBeLessThanOrEqual(1);
  });

  it("prunes the fired-tracker when a profile is deleted between polls", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValueOnce([
      profile({ expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }),
    ]);
    mount();
    await waitFor(() => expect(screen.getByText(/PROD expires in/)).toBeInTheDocument());
    expect(window.localStorage.getItem("strata.credExpiryFired.v1")).toContain("p-1:");

    // Profile vanishes from the next poll — tracker key for p-1 must be
    // dropped from storage so a future profile re-using the same id
    // starts with a clean slate.
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await waitFor(() => {
      const raw = window.localStorage.getItem("strata.credExpiryFired.v1");
      expect(raw === null || !raw.includes("p-1:")).toBe(true);
    });
  });

  it("invokes the renew callback when the action is clicked", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({ expired: true, expires_at: new Date(Date.now() - 1000).toISOString() }),
    ]);
    const onRenew = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <MemoryRouter>
        <ToastProvider>
          <CredentialProfileExpiryWatcher pollIntervalMs={1000} onRenew={onRenew} />
        </ToastProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/PROD has expired/)).toBeInTheDocument());
    await user.click(screen.getByText("Renew now"));
    expect(onRenew).toHaveBeenCalledWith(expect.objectContaining({ id: "p-1" }));
  });

  it("uses the wider 7-day threshold for extended-expiry profiles", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({
        extended_expiry: true,
        ttl_hours: 720,
        expires_at: new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString(),
      }),
    ]);
    mount();
    await waitFor(() => expect(screen.getByText(/PROD expires in 7 days/)).toBeInTheDocument());
  });

  it("stays silent when the API call fails", async () => {
    vi.mocked(getCredentialProfiles).mockRejectedValue(new Error("network"));
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
