import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection } from "../api";
import ConnectionCard from "../components/connections/ConnectionCard";
import {
  deriveLease,
  deriveSession,
  type ConnectionTargetState,
} from "../components/connections/connectionState";

const conn = {
  id: "c1",
  name: "Jump Host",
  protocol: "rdp",
  hostname: "10.0.0.5",
  port: 3389,
} as Connection;

const base: ConnectionTargetState = {
  health: "ONLINE",
  lease: { status: "UNASSIGNED", accountName: null },
  session: { state: "DISCONNECTED" },
};

function renderCard(state: Partial<ConnectionTargetState> = {}) {
  const handlers = {
    onConnect: vi.fn(),
    onResume: vi.fn(),
    onDisconnect: vi.fn(),
    onRenewAndConnect: vi.fn(),
  };
  render(<ConnectionCard conn={conn} icon={null} state={{ ...base, ...state }} {...handlers} />);
  return handlers;
}

describe("ConnectionCard", () => {
  it("shows reachability and Connect when idle, with no LIVE pill", async () => {
    const h = renderCard();
    expect(screen.getByText("Reachable")).toBeInTheDocument();
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
    expect(screen.queryByText(/Status:/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(h.onConnect).toHaveBeenCalled();
  });

  it("disables Connect and shows Unreachable for offline hosts", () => {
    renderCard({ health: "OFFLINE" });
    expect(screen.getByText("Unreachable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("offers Renew Lease & Connect for expired leases", async () => {
    const h = renderCard({ lease: { status: "EXPIRED", accountName: "svc-admin" } });
    expect(screen.getByText("svc-admin · Expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Renew Lease & Connect" }));
    expect(h.onRenewAndConnect).toHaveBeenCalled();
  });

  it("shows LIVE with Resume and Disconnect for connected sessions", async () => {
    const h = renderCard({ session: { state: "CONNECTED", sessionId: "s1", elapsedSeconds: 90 } });
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.queryByText("Reachable")).not.toBeInTheDocument();
    expect(screen.getByTestId("recent-card-c1")).toHaveClass("is-live");
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(h.onResume).toHaveBeenCalled();
    expect(h.onDisconnect).toHaveBeenCalled();
  });

  it("does not show LIVE while the tunnel is still connecting", () => {
    renderCard({ session: { state: "CONNECTING", sessionId: "s1" } });
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
  });
});

describe("connectionState", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const profile = {
    id: "p1",
    label: "svc-admin",
    created_at: "",
    updated_at: "",
    expires_at: "2026-01-01T13:00:00Z",
    expired: false,
    ttl_hours: 1,
    ttl_minutes: 0,
    extended_expiry: false,
  };

  it("derives lease TTL, capped by a linked checkout", () => {
    expect(deriveLease(profile, [], now)).toMatchObject({
      status: "VALID",
      ttlRemainingSeconds: 3600,
    });
    const checkout = { id: "k1", status: "Active", expires_at: "2026-01-01T12:10:00Z" };
    expect(deriveLease({ ...profile, checkout_id: "k1" }, [checkout] as never, now)).toMatchObject({
      status: "VALID",
      ttlRemainingSeconds: 600,
    });
  });

  it("treats a past expires_at or dead checkout as expired", () => {
    expect(deriveLease({ ...profile, expires_at: "2026-01-01T11:00:00Z" }, [], now).status).toBe(
      "EXPIRED"
    );
    const checkout = { id: "k1", status: "CheckedIn", expires_at: "2026-01-01T13:00:00Z" };
    expect(deriveLease({ ...profile, checkout_id: "k1" }, [checkout] as never, now).status).toBe(
      "EXPIRED"
    );
    expect(deriveLease(undefined, [], now).status).toBe("UNASSIGNED");
  });

  it("only reports CONNECTED for an open, error-free tunnel", () => {
    const s = { id: "s1", createdAt: now - 120_000, tunnel: { state: 1 } } as never;
    expect(deriveSession(s, now)).toMatchObject({ state: "CONNECTED", elapsedSeconds: 120 });
    expect(deriveSession({ ...(s as object), tunnel: { state: 0 } } as never, now).state).toBe(
      "CONNECTING"
    );
    expect(deriveSession({ ...(s as object), error: "boom" } as never, now).state).toBe(
      "DISCONNECTED"
    );
    expect(deriveSession(undefined, now).state).toBe("DISCONNECTED");
  });
});
