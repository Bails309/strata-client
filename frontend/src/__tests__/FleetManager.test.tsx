import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  deleteConnection: vi.fn(),
  getActiveSessions: vi.fn(),
  getAdSyncConfigs: vi.fn(),
  probeConnection: vi.fn(),
  triggerAdSync: vi.fn(),
  updateConnection: vi.fn(),
}));

import {
  getActiveSessions,
  getAdSyncConfigs,
  probeConnection,
  triggerAdSync,
  updateConnection,
  type Connection,
  type ConnectionFolder,
  type MeResponse,
} from "../api";
import FleetManager from "../pages/admin/fleet/FleetManager";
import {
  buildFleet,
  computeTelemetry,
  connectionPayload,
  folderSubtree,
  policiesFor,
} from "../pages/admin/fleet/fleetModel";

const conn = (over: Partial<Connection> & { id: string; name: string }): Connection => ({
  protocol: "rdp",
  hostname: `${over.id}.corp.local`,
  port: 3389,
  extra: {},
  health_status: "online",
  ...over,
});

const FOLDERS: ConnectionFolder[] = [
  { id: "prod", name: "Production" },
  { id: "web", name: "Web tier", parent_id: "prod" },
];

const CONNS: Connection[] = [
  conn({
    id: "dc01",
    name: "DC01",
    extra: { security: "nla", "auth-pkg": "kerberos" },
    folder_id: "prod",
  }),
  conn({
    id: "web01",
    name: "WEB01",
    folder_id: "web",
    health_status: "offline",
    extra: { "ignore-cert": "true" },
  }),
  conn({ id: "jump", name: "Jump", protocol: "ssh", port: 22, health_status: "unknown" }),
  conn({
    id: "bastion",
    name: "Bastion",
    protocol: "ssh",
    port: 22,
    extra: { "host-key": "ssh-ed25519 AAAA" },
  }),
];

const admin = { can_manage_system: true, can_view_sessions: true } as MeResponse;

describe("fleetModel", () => {
  it("derives security badges from real connection settings", () => {
    expect(policiesFor(CONNS[0]).map((p) => p.label)).toEqual(["NLA", "Kerberos"]);
    expect(policiesFor(CONNS[1]).map((p) => p.label)).toEqual(["Cert Ignored"]);
    expect(policiesFor(CONNS[2])).toEqual([
      expect.objectContaining({ label: "Unpinned", alert: true }),
    ]);
    expect(policiesFor(CONNS[3]).map((p) => p.label)).toEqual(["HostKey"]);
  });

  it("computes telemetry from health, posture and sessions", () => {
    const sessions = [
      { connection_id: "dc01", user_id: "u1" },
      { connection_id: "dc01", user_id: "u2" },
      { connection_id: "bastion", user_id: "u1" },
    ] as never[];
    const fleet = buildFleet(CONNS, FOLDERS, sessions);
    expect(fleet.find((r) => r.conn.id === "dc01")?.sessions).toBe(2);
    const t = computeTelemetry(fleet, sessions);
    expect(t.total).toBe(4);
    expect(t.protocolSummary).toBe("2 RDP · 2 SSH");
    expect(t.reachability).toBe(67);
    expect(t.unknown).toBe(1);
    expect(t.alertCount).toBe(2);
    expect(t.sessions).toBe(3);
    expect(t.liveUsers).toBe(2);
  });

  it("keeps every field when building an update payload", () => {
    const p = connectionPayload(CONNS[0], { folder_id: undefined });
    expect(p).toMatchObject({ name: "DC01", extra: CONNS[0].extra, folder_id: undefined });
  });

  it("expands a folder filter to its descendants", () => {
    expect([...folderSubtree(FOLDERS, "prod")].sort()).toEqual(["prod", "web"]);
  });
});

function mount(overrides: Partial<Parameters<typeof FleetManager>[0]> = {}) {
  const props = {
    user: admin,
    connections: CONNS,
    folders: FOLDERS,
    activeFormId: null,
    hostKeyPanel: null,
    verifyingHostKeys: false,
    onVerifyHostKeys: vi.fn(),
    onAdd: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onConnectionUpdated: vi.fn(),
    onConnectionDeleted: vi.fn(),
    requestConfirm: vi.fn(),
    ...overrides,
  };
  render(<FleetManager {...props} />);
  return props;
}

describe("FleetManager", () => {
  beforeEach(() => {
    vi.mocked(getActiveSessions).mockReset().mockResolvedValue([]);
    vi.mocked(getAdSyncConfigs).mockReset().mockResolvedValue([]);
    vi.mocked(probeConnection).mockReset();
    vi.mocked(updateConnection).mockReset();
    vi.mocked(triggerAdSync).mockReset();
  });

  it("renders the telemetry strip and two-tier endpoint cells", async () => {
    mount();
    const kpis = screen.getByRole("group", { name: "Fleet summary" });
    expect(within(kpis).getByText("2 RDP · 2 SSH")).toBeInTheDocument();
    expect(within(kpis).getByText("67%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy dc01.corp.local:3389" })).toBeInTheDocument();
    expect(screen.getByText("Unpinned")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("0 active").length).toBe(4));
  });

  it("filters by protocol and folder subtree", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Folder: All" }));
    await user.click(screen.getByRole("option", { name: "Production" }));
    expect(screen.getByText("DC01")).toBeInTheDocument();
    expect(screen.getByText("WEB01")).toBeInTheDocument();
    expect(screen.queryByText("Jump")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Protocol: All" }));
    await user.click(screen.getByRole("option", { name: "SSH" }));
    expect(screen.getByText("No connections match these filters.")).toBeInTheDocument();
  });

  it("debounces the search box", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText("Search connections"), "bastion");
    expect(screen.getByText("DC01")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("DC01")).toBeNull());
    expect(screen.getByText("Bastion")).toBeInTheDocument();
  });

  it("probes a single endpoint and shows the measured latency", async () => {
    const user = userEvent.setup();
    vi.mocked(probeConnection).mockResolvedValue({
      id: "dc01",
      health_status: "online",
      latency_ms: 12,
      health_checked_at: new Date().toISOString(),
    });
    const props = mount();
    await user.click(screen.getByRole("button", { name: "Probe DC01" }));
    expect(probeConnection).toHaveBeenCalledWith("dc01");
    expect(await screen.findByText("12ms")).toBeInTheDocument();
    expect(props.onConnectionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dc01", health_status: "online" })
    );
  });

  it("moves the selection to a folder from the bulk dock", async () => {
    const user = userEvent.setup();
    vi.mocked(updateConnection).mockImplementation(async (id, data) => ({ id, ...data }));
    const props = mount();
    await user.click(screen.getByLabelText("Select Jump"));
    await user.click(screen.getByLabelText("Select Bastion"));
    const dock = screen.getByRole("region", { name: "Bulk actions" });
    expect(dock).toHaveTextContent("2Endpoints Selected");
    await user.click(within(dock).getByRole("button", { name: "Move to folder" }));
    await user.click(screen.getByRole("menuitem", { name: /Web tier/ }));
    await waitFor(() => expect(updateConnection).toHaveBeenCalledTimes(2));
    expect(updateConnection).toHaveBeenCalledWith(
      "jump",
      expect.objectContaining({ folder_id: "web", name: "Jump" })
    );
    expect(props.onConnectionUpdated).toHaveBeenCalledTimes(2);
  });

  it("asks for confirmation before bulk delete and warns about live sessions", async () => {
    const user = userEvent.setup();
    vi.mocked(getActiveSessions).mockResolvedValue([
      { connection_id: "dc01", user_id: "u1" },
    ] as never[]);
    const props = mount();
    await waitFor(() => expect(screen.getByText("1 active")).toBeInTheDocument());
    await user.click(screen.getByLabelText("Select all matching connections"));
    await user.click(screen.getByRole("button", { name: "Delete Selected" }));
    expect(props.requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete 4 connections",
        message: expect.stringContaining("1 of them has active sessions"),
      })
    );
  });

  it("scopes host-key pinning to the selected SSH targets", async () => {
    const user = userEvent.setup();
    const props = mount();
    await user.click(screen.getByLabelText("Select DC01"));
    await user.click(screen.getByLabelText("Select Jump"));
    await user.click(screen.getByRole("button", { name: "Pin Host Keys (1)" }));
    expect(props.onVerifyHostKeys).toHaveBeenCalledWith(["jump"]);
  });

  it("triggers a directory sync from the toolbar", async () => {
    const user = userEvent.setup();
    vi.mocked(getAdSyncConfigs).mockResolvedValue([
      { id: "ad1", label: "Corp AD", ldap_url: "ldaps://dc", enabled: true },
    ] as never[]);
    vi.mocked(triggerAdSync).mockResolvedValue({ run_id: "r1", status: "started" });
    mount();
    await user.click(await screen.findByRole("button", { name: "Sync AD / LDAP" }));
    await user.click(screen.getByRole("menuitem", { name: "Corp AD" }));
    expect(triggerAdSync).toHaveBeenCalledWith("ad1");
  });

  it("offers clear-host-key only for pinned SSH targets", async () => {
    const user = userEvent.setup();
    const props = mount();
    await user.click(screen.getByRole("button", { name: "More actions for Jump" }));
    expect(screen.queryByRole("menuitem", { name: "Clear pinned host key" })).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "More actions for Bastion" }));
    await user.click(screen.getByRole("menuitem", { name: "Clear pinned host key" }));
    expect(props.requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Clear pinned host key" })
    );
  });
});
