import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api", () => ({
  createRole: vi.fn(),
  getConnectionRefs: vi.fn(),
  getRoleMappings: vi.fn(),
  getUsersPage: vi.fn(),
  updateRole: vi.fn(),
  updateRoleMappings: vi.fn(),
}));
vi.mock("../contexts/SettingsContext", () => ({
  useSettings: () => ({ formatDateTime: (s: string) => s }),
}));

import {
  createRole,
  getConnectionRefs,
  getRoleMappings,
  getUsersPage,
  updateRole,
  updateRoleMappings,
  type Connection,
  type ConnectionFolder,
  type Role,
  type User,
} from "../api";
import EditRoleModal from "../pages/admin/roles/EditRoleModal";
import { draftFromRole, inheritedConnectionIds } from "../pages/admin/roles/roleModel";
import { toRefs } from "./fakeListServer";

const baseRole = (over: Partial<Role> & { id: string; name: string }): Role => ({
  can_manage_system: false,
  can_manage_users: false,
  can_manage_connections: false,
  can_view_audit_logs: false,
  can_create_users: false,
  can_create_user_groups: false,
  can_create_connections: false,
  can_use_quick_share: false,
  can_use_quick_share_outbound: false,
  can_create_sharing_profiles: false,
  can_view_sessions: false,
  ...over,
});

const HELPDESK = baseRole({
  id: "r1",
  name: "helpdesk",
  description: "Tier 1",
  can_use_quick_share: true,
});
const ADMIN = baseRole({ id: "r0", name: "admin", can_manage_system: true });

const FOLDERS: ConnectionFolder[] = [
  { id: "prod", name: "Production" },
  { id: "web", name: "Web tier", parent_id: "prod" },
];

const CONNS: Connection[] = [
  {
    id: "dc01",
    name: "DC01",
    protocol: "rdp",
    hostname: "dc01.corp",
    port: 3389,
    folder_id: "prod",
  },
  {
    id: "web01",
    name: "WEB01",
    protocol: "rdp",
    hostname: "web01.corp",
    port: 3389,
    folder_id: "web",
  },
  { id: "jump", name: "Jump", protocol: "ssh", hostname: "jump.corp", port: 22 },
];

const USERS = [
  { id: "u1", username: "alice", email: "alice@corp", auth_type: "sso", role_name: "helpdesk" },
  { id: "u2", username: "bob", email: "bob@corp", auth_type: "local", role_name: "admin" },
] as User[];

function open(role: Role | null, over: Partial<Parameters<typeof EditRoleModal>[0]> = {}) {
  const props = {
    role,
    roles: [ADMIN, HELPDESK],
    folders: FOLDERS,
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...over,
  };
  render(<EditRoleModal {...props} />);
  return props;
}

beforeEach(() => {
  vi.mocked(getConnectionRefs).mockReset().mockResolvedValue(toRefs(CONNS));
  vi.mocked(getUsersPage)
    .mockReset()
    .mockImplementation(async (_page, _perPage, f) => {
      const name = [ADMIN, HELPDESK].find((r) => r.id === f?.role_id)?.name;
      const items = USERS.filter((u) => u.role_name === name);
      return { items, total: items.length };
    });
  vi.mocked(getRoleMappings).mockReset().mockResolvedValue({ connection_ids: [], folder_ids: [] });
  vi.mocked(updateRole)
    .mockReset()
    .mockImplementation(async (id, data) => ({ ...HELPDESK, ...data, id }) as Role);
  vi.mocked(createRole)
    .mockReset()
    .mockImplementation(async (data) => ({ ...data, id: "new" }) as Role);
  vi.mocked(updateRoleMappings).mockReset().mockResolvedValue({ status: "ok" });
});

describe("roleModel", () => {
  it("folder grants cover only connections filed directly in the folder", () => {
    expect([...inheritedConnectionIds(new Set(["prod"]), CONNS)]).toEqual(["dc01"]);
  });

  it("drafts carry every flag and the description", () => {
    const d = draftFromRole(HELPDESK);
    expect(d.description).toBe("Tier 1");
    expect(d.can_use_quick_share).toBe(true);
    expect(d.can_manage_connections).toBe(false);
  });
});

describe("EditRoleModal", () => {
  it("groups permissions by category with risk tiers", async () => {
    open(HELPDESK);
    const dialog = await screen.findByRole("dialog", { name: "Edit role: helpdesk" });
    expect(within(dialog).getByText("Platform & system administration")).toBeInTheDocument();
    const admin = within(dialog).getByRole("checkbox", { name: "Administer system" });
    expect(admin.closest("label")).toHaveTextContent("Critical");
    // Previously hidden flags are now visible.
    expect(
      within(dialog).getByRole("checkbox", { name: "Manage all connections" })
    ).not.toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Use Inbound Quick Share" })).toBeChecked();
  });

  it("counts changes and saves permissions without touching unchanged mappings", async () => {
    const user = userEvent.setup();
    const props = open(HELPDESK);
    const save = await screen.findByRole("button", { name: "Save Changes" });
    expect(save).toBeDisabled();
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Audit system" }));
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "Tier 2");
    expect(screen.getByText("2 unsaved changes")).toBeInTheDocument();

    await user.click(save);
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(updateRole).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({
        name: "helpdesk",
        description: "Tier 2",
        can_view_audit_logs: true,
        can_use_quick_share: true,
      })
    );
    expect(updateRoleMappings).not.toHaveBeenCalled();
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), false);
  });

  it("marks only a folder's own connections as inherited", async () => {
    const user = userEvent.setup();
    open(HELPDESK);
    await user.click(await screen.findByRole("tab", { name: "Asset assignments" }));
    await user.click(screen.getByRole("checkbox", { name: "Grant folder Production" }));

    const dc = screen.getByRole("checkbox", { name: "Grant connection DC01" });
    expect(dc).toBeChecked();
    expect(dc).toBeDisabled();
    expect(dc.closest("li")).toHaveTextContent("Inherited from folder");

    const web = screen.getByRole("checkbox", { name: "Grant connection WEB01" });
    expect(web).not.toBeChecked();
    expect(web).toBeEnabled();
    expect(screen.getByText("Not covered by parent folder")).toBeInTheDocument();
    expect(screen.getByText(/1 connection reachable/)).toBeInTheDocument();
  });

  it("lets a redundant direct grant be removed from an inherited connection", async () => {
    vi.mocked(getRoleMappings).mockResolvedValue({
      connection_ids: ["dc01", "jump"],
      folder_ids: ["prod"],
    });
    const user = userEvent.setup();
    open(HELPDESK);
    await user.click(await screen.findByRole("tab", { name: "Asset assignments" }));
    expect(screen.getByText("Inherited · also granted directly")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove direct grant for DC01" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(updateRoleMappings).toHaveBeenCalledWith("r1", ["jump"], ["prod"]));
  });

  it("warns when the role already reaches every connection", async () => {
    const user = userEvent.setup();
    open(ADMIN);
    await user.click(await screen.findByRole("tab", { name: "Asset assignments" }));
    expect(screen.getByRole("note")).toHaveTextContent("already opens every connection");
  });

  it("refuses to open when assignments cannot be loaded", async () => {
    vi.mocked(getRoleMappings).mockRejectedValue(new Error("HTTP 500"));
    open(HELPDESK);
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 500");
    expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
  });

  it("creates a role with assignments and rejects duplicate names", async () => {
    const user = userEvent.setup();
    const props = open(null);
    const create = screen.getByRole("button", { name: "Create Role" });
    expect(create).toBeDisabled();
    expect(screen.queryByRole("tab", { name: /Members/ })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Role name"), "Admin");
    expect(screen.getByText("A role with this name already exists.")).toBeInTheDocument();
    expect(create).toBeDisabled();

    await user.clear(screen.getByLabelText("Role name"));
    await user.type(screen.getByLabelText("Role name"), "auditors");
    await user.click(screen.getByRole("tab", { name: "Asset assignments" }));
    await user.click(screen.getByRole("checkbox", { name: "Grant connection Jump" }));
    await user.click(create);

    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(createRole).toHaveBeenCalledWith(expect.objectContaining({ name: "auditors" }));
    expect(updateRoleMappings).toHaveBeenCalledWith("new", ["jump"], []);
    expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }), true);
  });

  it("keeps a created role when its assignments fail, and retries as an update", async () => {
    vi.mocked(updateRoleMappings).mockRejectedValueOnce(new Error("HTTP 502"));
    const user = userEvent.setup();
    const props = open(null);
    await user.type(screen.getByLabelText("Role name"), "auditors");
    await user.click(screen.getByRole("tab", { name: "Asset assignments" }));
    await user.click(screen.getByRole("checkbox", { name: "Grant connection Jump" }));
    await user.click(screen.getByRole("button", { name: "Create Role" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Role saved, but its assignments");
    expect(props.onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(createRole).toHaveBeenCalledTimes(1);
    expect(updateRole).toHaveBeenCalledWith("new", expect.objectContaining({ name: "auditors" }));
  });

  it("asks before discarding unsaved changes", async () => {
    const user = userEvent.setup();
    const props = open(HELPDESK);
    await user.click(await screen.findByRole("checkbox", { name: "Audit system" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard 1 unsaved change?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("lists the users who hold the role", async () => {
    const user = userEvent.setup();
    open(HELPDESK);
    await user.click(await screen.findByRole("tab", { name: "Members (1)" }));
    const list = screen.getByRole("list", { name: "Role members" });
    expect(within(list).getByText("alice")).toBeInTheDocument();
    expect(within(list).getByText("SSO")).toBeInTheDocument();
    expect(within(list).queryByText("bob")).not.toBeInTheDocument();
  });

  it("locks the name of built-in roles", async () => {
    open(ADMIN);
    expect(await screen.findByLabelText("Role name")).toBeDisabled();
    expect(screen.getByText("System role")).toBeInTheDocument();
  });

  it("does not claim Administer system covers Outbound Quick Share", async () => {
    open(ADMIN);
    const audit = await screen.findByRole("checkbox", { name: "Audit system" });
    expect(audit.closest("label")).toHaveTextContent("Already granted through Administer system");
    const outbound = screen.getByRole("checkbox", { name: "Use Outbound Quick Share" });
    expect(outbound.closest("label")).not.toHaveTextContent("Already granted");
  });
});
