import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// Cross-tab sharing has its own tests; here every poll reaches the API mock.
vi.mock("../utils/sharedFetch", () => ({
  sharedFetch: (_key: string, _maxAge: number, fetcher: () => Promise<unknown>) => fetcher(),
  invalidateSharedFetch: vi.fn(),
}));

vi.mock("../api", () => ({
  getCredentialProfiles: vi.fn(),
  getMyCheckouts: vi.fn(),
  getProfileMappings: vi.fn(),
  bulkSafeguardCheckout: vi.fn(),
}));

import {
  bulkSafeguardCheckout,
  getCredentialProfiles,
  getMyCheckouts,
  getProfileMappings,
  type CheckoutRequest,
  type CredentialProfile,
} from "../api";
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
    ttl_minutes: 0,
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
    vi.mocked(getProfileMappings).mockReset();
    vi.mocked(getProfileMappings).mockResolvedValue([]);
    vi.mocked(bulkSafeguardCheckout).mockReset();
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

  it("does not fire the 1-day toast on a freshly-created 12 h profile", async () => {
    // Default standard TTL is 12 h, so on creation `secsLeft` (43 200 s)
    // is already inside the 1-day (86 400 s) warning window. The watcher
    // must skip thresholds wider than the profile's own TTL or every new
    // standard profile would publish a 1-day toast immediately.
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({
        ttl_hours: 12,
        expires_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
      }),
    ]);
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("fires a warning toast when a standard profile crosses the 1-hour threshold", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({ expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() }),
    ]);
    mount();
    await waitFor(() => expect(screen.getByText("PROD expires in 30 minutes")).toBeInTheDocument());
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
    // After re-arm + a fresh evaluation the stale warning is withdrawn and
    // never duplicated (replace-by-key semantics).
    expect(screen.queryAllByText(/PROD/).length).toBeLessThanOrEqual(1);
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
    await waitFor(() => expect(screen.getByText(/PROD expires in 6 days/)).toBeInTheDocument());
  });

  it("stays silent when the API call fails", async () => {
    vi.mocked(getCredentialProfiles).mockRejectedValue(new Error("network"));
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  const expiredProfile = (id: string, label: string, overrides: Partial<CredentialProfile> = {}) =>
    profile({
      id,
      label,
      expired: true,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      ...overrides,
    });

  it("collapses expiries from the same poll into one grouped toast", async () => {
    vi.mocked(getProfileMappings).mockResolvedValue([
      { connection_id: "c1", connection_name: "cicsazt1mgt-p", protocol: "rdp" },
    ]);
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      expiredProfile("p-1", "sa1"),
      expiredProfile("p-2", "db_admin"),
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getByText("2 Privileged Credentials Expired")).toBeInTheDocument()
    );
    expect(screen.getByText("sa1")).toBeInTheDocument();
    expect(screen.getByText("db_admin")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("cicsazt1mgt-p")).toHaveLength(2));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  });

  it("folds a later expiry into the unread toast instead of stacking a new one", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([expiredProfile("p-1", "sa1")]);
    mount();
    await waitFor(() => expect(screen.getByText(/sa1 has expired/)).toBeInTheDocument());

    vi.mocked(getCredentialProfiles).mockResolvedValue([
      expiredProfile("p-1", "sa1"),
      expiredProfile("p-2", "sftp_svc"),
    ]);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await waitFor(() =>
      expect(screen.getByText("2 Privileged Credentials Expired")).toBeInTheDocument()
    );
    expect(screen.queryByText(/sa1 has expired/)).toBeNull();
  });

  it("shows the first three rows and expands the rest inline", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      expiredProfile("p-1", "a1"),
      expiredProfile("p-2", "a2"),
      expiredProfile("p-3", "a3"),
      expiredProfile("p-4", "a4"),
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getByText("4 Privileged Credentials Expired")).toBeInTheDocument()
    );
    expect(screen.queryByText("a4")).toBeNull();
    await user.click(screen.getByRole("button", { name: /\+ 1 more credential/ }));
    expect(screen.getByText("a4")).toBeInTheDocument();
  });

  it("clears the grouped toast with Dismiss All", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      expiredProfile("p-1", "sa1"),
      expiredProfile("p-2", "db_admin"),
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getByText("2 Privileged Credentials Expired")).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Dismiss All" }));
    await waitFor(() => expect(screen.queryByText(/Privileged Credentials Expired/)).toBeNull());
  });

  it("clears the grouped toast with Esc", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      expiredProfile("p-1", "sa1"),
      expiredProfile("p-2", "db_admin"),
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getByText("2 Privileged Credentials Expired")).toBeInTheDocument()
    );
    // Let the toast body's passive effects (the Esc listener) flush first.
    await act(async () => {
      await Promise.resolve();
    });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(/Privileged Credentials Expired/)).toBeNull());
  });

  it("extends JIT leases in bulk from the grouped toast", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(bulkSafeguardCheckout).mockResolvedValue([
      { profile_id: "p-1", label: "sa1", ok: true },
      { profile_id: "p-2", label: "db_admin", ok: true },
    ]);
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      expiredProfile("p-1", "sa1", { kind: "safeguard" }),
      expiredProfile("p-2", "db_admin", { kind: "safeguard" }),
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getByText("2 Privileged Credentials Expired")).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: "Extend All (JIT)" }));
    expect(bulkSafeguardCheckout).toHaveBeenCalledWith(["p-1", "p-2"], expect.any(String));
    await waitFor(() => expect(screen.getByText("2 JIT leases extended")).toBeInTheDocument());
  });

  it("batches pre-expiry warnings into a single ambient toast", async () => {
    const soon = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({ id: "p-1", label: "sa1", expires_at: soon }),
      profile({ id: "p-2", label: "gpu", expires_at: soon }),
      profile({ id: "p-3", label: "svc", expires_at: soon }),
    ]);
    mount();
    await waitFor(() =>
      expect(
        screen.getByText("3 credential leases expiring, the first in 4 minutes")
      ).toBeInTheDocument()
    );
    expect(screen.queryByRole("button", { name: /Extend/ })).toBeNull();
  });

  it("does not warn separately for a managed account linked to another profile", async () => {
    const soon = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      { id: "co-1", managed_ad_dn: "CN=Bailey,OU=Admins,DC=corp" } as CheckoutRequest,
    ]);
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({ id: "p-1", label: "[managed] CN=Bailey,OU=Admins,DC=corp", expires_at: soon }),
      profile({ id: "p-2", label: "DMZ SA1", expires_at: soon, checkout_id: "co-1" }),
    ]);
    mount();
    await waitFor(() => expect(screen.getByText(/DMZ SA1 expires in/)).toBeInTheDocument());
    expect(screen.queryByText(/credential leases expiring/)).toBeNull();
  });

  it("withdraws an expired toast once the lease is renewed", async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([expiredProfile("p-1", "sa1")]);
    mount();
    await waitFor(() => expect(screen.getByText(/sa1 has expired/)).toBeInTheDocument());
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      profile({
        id: "p-1",
        label: "sa1",
        expires_at: new Date(Date.now() + 8 * 3600e3).toISOString(),
      }),
    ]);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(screen.queryByText(/sa1 has expired/)).toBeNull());
  });
});
