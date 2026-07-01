import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

vi.mock("../api", () => ({
  bulkSafeguardCheckout: vi.fn(),
  getSafeguardSigninStatus: vi.fn(),
  listSafeguardCached: vi.fn(),
  safeguardCheckin: vi.fn(),
  releaseSafeguardPending: vi.fn(),
}));

vi.mock("../contexts/SettingsContext", () => ({
  useSettings: () => ({
    formatDateTime: (d: unknown) => (d ? new Date(d as string).toISOString() : "—"),
  }),
}));

import SafeguardBulkCheckoutCard from "../pages/credentials/SafeguardBulkCheckoutCard";
import {
  bulkSafeguardCheckout,
  getSafeguardSigninStatus,
  listSafeguardCached,
  releaseSafeguardPending,
  safeguardCheckin,
  type CredentialProfile,
  type SafeguardSigninStatus,
} from "../api";

const sgProfile = (over: Partial<CredentialProfile> = {}): CredentialProfile => ({
  id: "p1",
  label: "prod-db",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  expires_at: "2027-01-01T00:00:00Z",
  expired: false,
  ttl_hours: 4,
  extended_expiry: false,
  kind: "safeguard",
  safeguard_account_id: "42",
  safeguard_asset: "asset-1",
  ...over,
});

const status = (over: Partial<SafeguardSigninStatus> = {}): SafeguardSigninStatus => ({
  signed_in: true,
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  appliance_fqdn: "sg.corp",
  idp_alias: "sso",
  auth_mode: "per_user_browser",
  enabled: true,
  password_cache_enabled: true,
  ...over,
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("SafeguardBulkCheckoutCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (listSafeguardCached as any).mockResolvedValue([]);
    (getSafeguardSigninStatus as any).mockResolvedValue(status());
    (bulkSafeguardCheckout as any).mockResolvedValue([]);
    (safeguardCheckin as any).mockResolvedValue([]);
    (releaseSafeguardPending as any).mockResolvedValue({});
  });

  it("renders nothing when safeguardEnabled is false", () => {
    const { container } = render(
      <SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no safeguard profiles", () => {
    const { container } = render(
      <SafeguardBulkCheckoutCard
        profiles={[sgProfile({ id: "x", kind: "local" })]}
        safeguardEnabled
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists safeguard profiles and disables actions until justification provided", async () => {
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    expect(screen.getByText("prod-db")).toBeInTheDocument();
    const checkoutBtn = screen.getByRole("button", { name: /Checkout selected/ });
    expect(checkoutBtn).toBeDisabled();
  });

  it("warns when password caching is disabled", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(status({ password_cache_enabled: false }));
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    expect(screen.getByText(/requires the administrator to enable/i)).toBeInTheDocument();
  });

  it("warns when signed out", async () => {
    (getSafeguardSigninStatus as any).mockResolvedValue(status({ signed_in: false }));
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    expect(screen.getByText(/signed out of Safeguard/i)).toBeInTheDocument();
  });

  it("toggles single row, selects all, then runs bulk checkout and clears successful rows", async () => {
    const p1 = sgProfile({ id: "p1", label: "alpha" });
    const p2 = sgProfile({ id: "p2", label: "beta" });
    (bulkSafeguardCheckout as any).mockResolvedValue([
      { profile_id: "p1", label: "alpha", ok: true, expires_at: new Date().toISOString() },
      { profile_id: "p2", label: "beta", ok: false, error: "boom" },
    ]);
    render(<SafeguardBulkCheckoutCard profiles={[p1, p2]} safeguardEnabled />);
    await flush();

    // Select all
    fireEvent.click(screen.getByLabelText("Select all Safeguard profiles"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    // Toggle one off, then on via individual row
    fireEvent.click(screen.getByLabelText("Select alpha"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select alpha"));

    // Provide justification & checkout
    fireEvent.change(screen.getByLabelText(/Justification/i), {
      target: { value: "weekly audit" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();

    const callArgs = (bulkSafeguardCheckout as any).mock.calls[0];
    expect([...callArgs[0]].sort()).toEqual(["p1", "p2"]);
    expect(callArgs[1]).toBe("weekly audit");
    expect(screen.getByText("Checked out")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("requires non-empty justification to checkout", async () => {
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByLabelText("Select prod-db"));
    // Force-enable click via direct call by setting whitespace justification:
    fireEvent.change(screen.getByLabelText(/Justification/i), { target: { value: "   " } });
    // Button stays disabled — no API call
    expect(screen.getByRole("button", { name: /Checkout selected/ })).toBeDisabled();
    expect(bulkSafeguardCheckout).not.toHaveBeenCalled();
  });

  it("surfaces error when bulkSafeguardCheckout throws", async () => {
    (bulkSafeguardCheckout as any).mockRejectedValue(new Error("network down"));
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByLabelText("Select prod-db"));
    fireEvent.change(screen.getByLabelText(/Justification/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();
    expect(screen.getByText("network down")).toBeInTheDocument();
  });

  it("shows cached badge and checks in a single profile", async () => {
    const p = sgProfile({ id: "p1" });
    (listSafeguardCached as any).mockResolvedValue([
      {
        profile_id: "p1",
        username: "svc",
        request_id: "r1",
        expires_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      },
    ]);
    (safeguardCheckin as any).mockResolvedValue([{ profile_id: "p1", ok: true }]);
    render(<SafeguardBulkCheckoutCard profiles={[p]} safeguardEnabled />);
    await flush();
    expect(screen.getByText(/Cached · /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check in" }));
    await flush();
    expect(safeguardCheckin).toHaveBeenCalledWith(["p1"]);
  });

  it("checks in all cached profiles and surfaces failure", async () => {
    const p = sgProfile({ id: "p1" });
    (listSafeguardCached as any).mockResolvedValue([
      {
        profile_id: "p1",
        username: "svc",
        request_id: "r1",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ]);
    (safeguardCheckin as any).mockResolvedValue([
      { profile_id: "p1", ok: false, error: "appliance busy" },
    ]);
    render(<SafeguardBulkCheckoutCard profiles={[p]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Check in all/ }));
    await flush();
    expect(safeguardCheckin).toHaveBeenCalledWith([]);
    expect(screen.getByText(/appliance busy/)).toBeInTheDocument();
  });

  it("surfaces error when checkin throws", async () => {
    const p = sgProfile({ id: "p1" });
    (listSafeguardCached as any).mockResolvedValue([
      {
        profile_id: "p1",
        username: "svc",
        request_id: "r1",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ]);
    (safeguardCheckin as any).mockRejectedValue(new Error("net"));
    render(<SafeguardBulkCheckoutCard profiles={[p]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Check in all/ }));
    await flush();
    expect(screen.getByText("net")).toBeInTheDocument();
  });

  it("tolerates getSafeguardSigninStatus failing (best-effort refresh)", async () => {
    (getSafeguardSigninStatus as any).mockRejectedValue(new Error("no"));
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    // Card still renders the profile list
    expect(screen.getByText("prod-db")).toBeInTheDocument();
  });

  it("re-fetches when signinNonce changes", async () => {
    const { rerender } = render(
      <SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled signinNonce={1} />
    );
    await flush();
    const initial = (listSafeguardCached as any).mock.calls.length;
    rerender(
      <SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled signinNonce={2} />
    );
    await waitFor(() =>
      expect((listSafeguardCached as any).mock.calls.length).toBeGreaterThan(initial)
    );
  });

  it("renders Awaiting approval badge and Refresh button for pending rows", async () => {
    (bulkSafeguardCheckout as any).mockResolvedValue([
      {
        profile_id: "p1",
        label: "prod-db",
        ok: false,
        state: "pending",
        request_id: "AR-99",
        account_id: "42",
        asset: "asset-1",
        error: "Awaiting approver — request AR-99 is queued in Safeguard.",
      },
    ]);
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByLabelText("Select prod-db"));
    fireEvent.change(screen.getByLabelText(/Justification/i), { target: { value: "approval" } });
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeInTheDocument();
    expect(screen.getByText(/request AR-99/)).toBeInTheDocument();
  });

  it("manual Refresh on a pending row flips to Checked out when approver acts", async () => {
    (bulkSafeguardCheckout as any).mockResolvedValue([
      {
        profile_id: "p1",
        label: "prod-db",
        ok: false,
        state: "pending",
        request_id: "AR-100",
        account_id: "42",
        asset: "asset-1",
      },
    ]);
    (releaseSafeguardPending as any).mockResolvedValue({
      profile_id: "p1",
      label: "prod-db",
      ok: true,
      state: "ok",
      request_id: "AR-100",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByLabelText("Select prod-db"));
    fireEvent.change(screen.getByLabelText(/Justification/i), { target: { value: "approval" } });
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await flush();
    expect(releaseSafeguardPending).toHaveBeenCalledWith("p1", "AR-100");
    expect(screen.getByText("Checked out")).toBeInTheDocument();
  });

  it("manual Refresh failure surfaces error and clears pending state", async () => {
    (bulkSafeguardCheckout as any).mockResolvedValue([
      {
        profile_id: "p1",
        label: "prod-db",
        ok: false,
        state: "pending",
        request_id: "AR-101",
        account_id: "42",
        asset: "asset-1",
      },
    ]);
    (releaseSafeguardPending as any).mockRejectedValue(new Error("appliance down"));
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByLabelText("Select prod-db"));
    fireEvent.change(screen.getByLabelText(/Justification/i), { target: { value: "approval" } });
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await flush();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("appliance down")).toBeInTheDocument();
  });

  it("manual Refresh on a still-pending response keeps the Awaiting badge", async () => {
    (bulkSafeguardCheckout as any).mockResolvedValue([
      {
        profile_id: "p1",
        label: "prod-db",
        ok: false,
        state: "pending",
        request_id: "AR-102",
        account_id: "42",
        asset: "asset-1",
      },
    ]);
    (releaseSafeguardPending as any).mockResolvedValue({
      profile_id: "p1",
      label: "prod-db",
      ok: false,
      state: "pending",
      request_id: "AR-102",
      error: "Awaiting approver — request AR-102 is queued in Safeguard.",
    });
    render(<SafeguardBulkCheckoutCard profiles={[sgProfile()]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByLabelText("Select prod-db"));
    fireEvent.change(screen.getByLabelText(/Justification/i), { target: { value: "approval" } });
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await flush();
    expect(releaseSafeguardPending).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
  });

  it("pending rows are NOT removed from selection after bulk checkout (only ok rows are)", async () => {
    const p1 = sgProfile({ id: "p1", label: "alpha" });
    const p2 = sgProfile({ id: "p2", label: "beta" });
    (bulkSafeguardCheckout as any).mockResolvedValue([
      { profile_id: "p1", label: "alpha", ok: true, state: "ok" },
      {
        profile_id: "p2",
        label: "beta",
        ok: false,
        state: "pending",
        request_id: "AR-7",
      },
    ]);
    render(<SafeguardBulkCheckoutCard profiles={[p1, p2]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByLabelText("Select all Safeguard profiles"));
    fireEvent.change(screen.getByLabelText(/Justification/i), { target: { value: "audit" } });
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();
    // p1 (ok) removed, p2 (pending) retained → "1 selected".
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("preserves a pending row from an earlier checkout when a second checkout runs for a different profile (v1.12.10 regression)", async () => {
    // Repro of the bug report: user checks out an Adhoc (approval-required) profile,
    // sees "Awaiting approval", then checks out a different Test (no-approval) profile.
    // The Adhoc pending row MUST survive the second checkout so the poll loop keeps
    // watching for the approver, and the Refresh button stays on the row so the user
    // can chase the approval manually.
    const adhoc = sgProfile({ id: "adhoc", label: "adhoc-priv" });
    const test = sgProfile({ id: "test", label: "test-svc" });
    // First checkout: only adhoc, returns pending.
    (bulkSafeguardCheckout as any).mockResolvedValueOnce([
      {
        profile_id: "adhoc",
        label: "adhoc-priv",
        ok: false,
        state: "pending",
        request_id: "AR-42",
      },
    ]);
    render(<SafeguardBulkCheckoutCard profiles={[adhoc, test]} safeguardEnabled />);
    await flush();
    fireEvent.click(screen.getByLabelText("Select adhoc-priv"));
    fireEvent.change(screen.getByLabelText(/Justification/i), { target: { value: "audit" } });
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeInTheDocument();

    // Second checkout: only test, returns ok.
    (bulkSafeguardCheckout as any).mockResolvedValueOnce([
      { profile_id: "test", label: "test-svc", ok: true, state: "ok" },
    ]);
    // Clear adhoc selection first so the second checkout targets only `test`.
    fireEvent.click(screen.getByLabelText("Select adhoc-priv"));
    fireEvent.click(screen.getByLabelText("Select test-svc"));
    fireEvent.click(screen.getByRole("button", { name: /Checkout selected/ }));
    await flush();
    // Adhoc's pending row MUST still be present — this was the bug.
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeInTheDocument();
    // And the new test row should show the successful badge alongside it.
    expect(screen.getByText("Checked out")).toBeInTheDocument();
  });
});
