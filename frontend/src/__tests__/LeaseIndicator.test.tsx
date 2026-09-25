import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api", () => ({
  getProfileMappings: vi.fn(),
  bulkSafeguardCheckout: vi.fn(),
  safeguardCheckin: vi.fn(),
  checkinCheckout: vi.fn(),
}));

import {
  bulkSafeguardCheckout,
  checkinCheckout,
  getProfileMappings,
  safeguardCheckin,
  type CredentialProfile,
  type MeResponse,
} from "../api";
import ToastProvider from "../components/ToastProvider";
import LeaseIndicator from "../components/LeaseIndicator";
import {
  formatAgo,
  formatLeft,
  formatRemaining,
  publishLeases,
  resetLeases,
} from "../components/leaseStore";
import { clearLeaseTargetCache } from "../components/LeaseBatchBody";

function lease(overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    id: "p-1",
    label: "sa1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 8 * 3600e3).toISOString(),
    expired: false,
    ttl_hours: 12,
    ttl_minutes: 0,
    extended_expiry: false,
    ...overrides,
  };
}

const user = { vault_configured: true, can_view_audit_logs: true } as MeResponse;

function mount() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <LeaseIndicator user={user} />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("LeaseIndicator", () => {
  beforeEach(() => {
    resetLeases();
    clearLeaseTargetCache();
    vi.mocked(getProfileMappings).mockReset();
    vi.mocked(getProfileMappings).mockResolvedValue([
      { connection_id: "c1", connection_name: "gputestvm", protocol: "rdp" },
    ]);
    vi.mocked(bulkSafeguardCheckout).mockReset();
    vi.mocked(safeguardCheckin).mockReset();
    vi.mocked(checkinCheckout).mockReset();
  });
  afterEach(() => resetLeases());

  it("renders nothing until the watcher publishes leases", () => {
    mount();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("summarises expired leases in rose", () => {
    mount();
    act(() =>
      publishLeases([
        lease({ id: "p-1", expired: true }),
        lease({ id: "p-2", expired: true }),
        lease({ id: "p-3" }),
      ])
    );
    const pill = screen.getByRole("button", { name: /2 Leases Expired/ });
    expect(pill.className).toContain("lease-pill-expired");
  });

  it("shows the soonest remaining time when a lease is inside the hour", () => {
    mount();
    act(() =>
      publishLeases([lease({ expires_at: new Date(Date.now() + 12 * 60e3 + 5000).toISOString() })])
    );
    const pill = screen.getByRole("button", { name: /1 Active · 12m left/ });
    expect(pill.className).toContain("lease-pill-soon");
  });

  it("opens the lease manager with grouped leases and bindings", async () => {
    const u = userEvent.setup();
    mount();
    act(() =>
      publishLeases([
        lease({ id: "p-1", label: "sa1", expired: true }),
        lease({ id: "p-2", label: "gpu" }),
      ])
    );
    await u.click(screen.getByRole("button", { name: /Lease Expired/ }));
    const dialog = screen.getByRole("dialog", { name: "Credential leases" });
    expect(dialog).toHaveTextContent("Expired (1)");
    expect(dialog).toHaveTextContent("Active (1)");
    await waitFor(() => expect(screen.getAllByText("gputestvm")).toHaveLength(2));
    expect(screen.getByRole("link", { name: "Audit history" })).toBeInTheDocument();
    await u.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("bulk-extends selected JIT leases", async () => {
    const u = userEvent.setup();
    vi.mocked(bulkSafeguardCheckout).mockResolvedValue([
      { profile_id: "p-1", label: "sa1", ok: true },
    ]);
    mount();
    act(() => publishLeases([lease({ id: "p-1", label: "sa1", kind: "safeguard" })]));
    await u.click(screen.getByRole("button", { name: /Active Lease/ }));
    await u.click(screen.getByRole("checkbox", { name: "Select sa1" }));
    await u.click(screen.getByRole("button", { name: /Extend 1 \(JIT\)/ }));
    expect(bulkSafeguardCheckout).toHaveBeenCalledWith(["p-1"], expect.any(String));
    await waitFor(() => expect(screen.getByText("1 JIT lease extended")).toBeInTheDocument());
  });

  it("requires a confirmation click before checking leases in", async () => {
    const u = userEvent.setup();
    vi.mocked(checkinCheckout).mockResolvedValue({ status: "CheckedIn" });
    vi.mocked(safeguardCheckin).mockResolvedValue([{ profile_id: "p-1", ok: true }]);
    mount();
    act(() =>
      publishLeases([
        lease({ id: "p-1", label: "sa1", kind: "safeguard" }),
        lease({ id: "p-2", label: "svc", checkout_id: "co-9" }),
        lease({ id: "p-3", label: "local" }),
      ])
    );
    await u.click(screen.getByRole("button", { name: /Active Leases/ }));
    for (const name of ["sa1", "svc", "local"]) {
      await u.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    }
    await u.click(screen.getByRole("button", { name: "Check in" }));
    expect(checkinCheckout).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Confirm check-in (2)" }));
    expect(safeguardCheckin).toHaveBeenCalledWith(["p-1"]);
    expect(checkinCheckout).toHaveBeenCalledWith("co-9");
    await waitFor(() => expect(screen.getByText("2 leases checked in")).toBeInTheDocument());
  });
});

describe("lease time formatting", () => {
  it("formats elapsed and remaining time compactly", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(formatAgo(now - 10_000, now)).toBe("just now");
    expect(formatAgo(now - 5 * 60e3, now)).toBe("5m ago");
    expect(formatAgo(now - 3 * 3600e3, now)).toBe("3h ago");
    expect(formatAgo(now - 3 * 86400e3, now)).toBe("3d ago");
    expect(formatLeft(now + 30_000, now)).toBe("30s");
    expect(formatLeft(now + 12 * 60e3, now)).toBe("12m");
    expect(formatLeft(now + 185 * 60e3, now)).toBe("3h 5m");
    expect(formatLeft(now + 52 * 3600e3, now)).toBe("2d 4h");
    expect(formatRemaining(now + 20_000, now)).toBe("less than a minute");
    expect(formatRemaining(now + 60e3, now)).toBe("1 minute");
    expect(formatRemaining(now + 185 * 60e3, now)).toBe("3 hours 5 minutes");
    expect(formatRemaining(now + 6 * 86400e3 - 50, now)).toBe("6 days");
    expect(formatRemaining(now + 25 * 3600e3, now)).toBe("1 day 1 hour");
  });
});
