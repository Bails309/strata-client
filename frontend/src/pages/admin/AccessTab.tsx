import { useEffect, useState } from "react";
import ConfirmModal from "../../components/ConfirmModal";
import Select from "../../components/Select";
import { orderFoldersByHierarchy } from "../../utils/folderTree";
import { useSettings } from "../../contexts/SettingsContext";
import {
  Connection,
  ConnectionFolder,
  MeResponse,
  Role,
  User,
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  getRoleMappings,
  getRoles,
  getUsers,
  restoreUser,
  updateRole,
  updateRoleMappings,
  updateUser,
} from "../../api";

interface AccessTabProps {
  user: MeResponse;
  roles: Role[];
  connections?: Connection[];
  folders?: ConnectionFolder[];
  users: User[];
  onRolesChanged: (r: Role[]) => void;
  onUsersChanged: (u: User[]) => void;
}

export default function AccessTab({
  user,
  roles,
  connections = [],
  folders = [],
  users,
  onRolesChanged,
  onUsersChanged,
}: AccessTabProps) {
  const { formatDateTime } = useSettings();
  const [subTab, setSubTab] = useState<"roles" | "permissions" | "policies">("roles");

  const [newRole, setNewRole] = useState<{
    name: string;
    can_manage_system: boolean;
    can_manage_users: boolean;
    can_manage_connections: boolean;
    can_view_audit_logs: boolean;
    can_create_users: boolean;
    can_create_user_groups: boolean;
    can_create_connections: boolean;
    can_use_quick_share: boolean;
    can_use_quick_share_outbound: boolean;
    can_create_sharing_profiles: boolean;
    can_view_sessions: boolean;
  }>({
    name: "",
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
  });

  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    isDangerous?: boolean;
    onConfirm: () => void;
  } | null>(null);

  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleModalTab, setRoleModalTab] = useState<"permissions" | "assignments">("permissions");
  const [assignmentConnectionIds, setAssignmentConnectionIds] = useState<string[]>([]);
  const [assignmentFolderIds, setAssignmentFolderIds] = useState<string[]>([]);

  // Users list — client-side filter + pagination
  const [userSearch, setUserSearch] = useState("");
  const [userPage, setUserPage] = useState(1);
  const userPerPage = 20;

  // User Management
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [userForm, setUserForm] = useState<{
    username: string;
    email: string;
    full_name: string;
    role_id: string;
    auth_type: "local" | "sso";
  }>({ username: "", email: "", full_name: "", role_id: "", auth_type: "local" });
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [userError, setUserError] = useState("");
  const [userSaving, setUserSaving] = useState(false);
  const [showDeletedUsers, setShowDeletedUsers] = useState(false);
  const [deletedUsers, setDeletedUsers] = useState<User[]>([]);

  useEffect(() => {
    if (showDeletedUsers) {
      getUsers(true).then((all) => {
        setDeletedUsers(all.filter((u) => !!u.deleted_at));
      });
    }
  }, [showDeletedUsers, users]);

  const visibleUsersSource = showDeletedUsers ? deletedUsers : users;
  const filteredUsers = visibleUsersSource.filter((u) => {
    if (!userSearch) return true;
    const q = userSearch.toLowerCase();
    return (
      u.username.toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.full_name || "").toLowerCase().includes(q) ||
      (u.role_name || "").toLowerCase().includes(q) ||
      (u.sub || "").toLowerCase().includes(q)
    );
  });
  const userTotalPages = Math.max(1, Math.ceil(filteredUsers.length / userPerPage));
  const safeUserPage = Math.min(userPage, userTotalPages);
  const pagedUsers = filteredUsers.slice(
    (safeUserPage - 1) * userPerPage,
    safeUserPage * userPerPage
  );

  const handleEditRole = async (r: Role) => {
    setEditingRole(r);
    setNewRole({
      name: r.name,
      can_manage_system: r.can_manage_system,
      can_manage_users: r.can_manage_users,
      can_manage_connections: r.can_manage_connections,
      can_view_audit_logs: r.can_view_audit_logs,
      can_create_users: r.can_create_users,
      can_create_user_groups: r.can_create_user_groups,
      can_create_connections: r.can_create_connections,
      can_use_quick_share: r.can_use_quick_share,
      can_use_quick_share_outbound: r.can_use_quick_share_outbound,
      can_create_sharing_profiles: r.can_create_sharing_profiles,
      can_view_sessions: r.can_view_sessions,
    });
    setRoleModalTab("permissions");
    setAssignmentConnectionIds([]);
    setAssignmentFolderIds([]);
    setRoleModalOpen(true);

    try {
      const mappings = await getRoleMappings(r.id);
      setAssignmentConnectionIds(mappings.connection_ids);
      setAssignmentFolderIds(mappings.folder_ids);
    } catch (err) {
      console.error("Failed to fetch role mappings:", err);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Main Access Control Card with Segmented Top Tabs ── */}
      <div className="card w-full">
        {/* Horizontal Segmented Top Tabs */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-border pb-4 mb-6 gap-4">
          <div>
            <h2 className="!mb-0 text-xl font-bold text-txt-primary">Roles</h2>
            <p className="text-txt-tertiary text-xs mt-0.5">
              Standard RBAC roles, permission capabilities, and session policies
            </p>
          </div>
          <div className="inline-flex p-1 rounded-lg bg-surface-secondary border border-border/50 text-xs font-medium">
            <button
              onClick={() => setSubTab("roles")}
              className={`px-3 py-1.5 rounded-md transition-all ${
                subTab === "roles"
                  ? "bg-bg-surface text-txt-primary shadow-sm font-semibold"
                  : "text-txt-secondary hover:text-txt-primary"
              }`}
            >
              Roles
            </button>
            <button
              onClick={() => setSubTab("permissions")}
              className={`px-3 py-1.5 rounded-md transition-all ${
                subTab === "permissions"
                  ? "bg-bg-surface text-txt-primary shadow-sm font-semibold"
                  : "text-txt-secondary hover:text-txt-primary"
              }`}
            >
              Permissions
            </button>
            <button
              onClick={() => setSubTab("policies")}
              className={`px-3 py-1.5 rounded-md transition-all ${
                subTab === "policies"
                  ? "bg-bg-surface text-txt-primary shadow-sm font-semibold"
                  : "text-txt-secondary hover:text-txt-primary"
              }`}
            >
              Session Policies
            </button>
          </div>
        </div>

        {/* ── Sub-view 1: Roles (100% Container Width Table Card) ── */}
        {subTab === "roles" && (user.can_manage_system || user.can_create_user_groups) && (
          <div className="w-full space-y-4">
            <div className="table-responsive w-full">
              <table className="w-full">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Permissions</th>
                    <th className="w-[120px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className="font-semibold text-accent">{r.name}</span>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {r.can_manage_system && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              System
                            </span>
                          )}
                          {r.can_view_audit_logs && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              Audit
                            </span>
                          )}
                          {r.can_create_users && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              Users
                            </span>
                          )}
                          {r.can_create_user_groups && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              Roles
                            </span>
                          )}
                          {r.can_create_connections && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              Connections
                            </span>
                          )}
                          {r.can_use_quick_share && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              QS Inbound
                            </span>
                          )}
                          {r.can_use_quick_share_outbound && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              QS Outbound
                            </span>
                          )}
                          {r.can_create_sharing_profiles && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              Sharing
                            </span>
                          )}
                          {r.can_view_sessions && (
                            <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                              Sessions
                            </span>
                          )}
                          {!r.can_manage_system &&
                            !r.can_manage_users &&
                            !r.can_manage_connections &&
                            !r.can_view_audit_logs &&
                            !r.can_create_users &&
                            !r.can_create_user_groups &&
                            !r.can_create_connections &&
                            !r.can_use_quick_share &&
                            !r.can_use_quick_share_outbound &&
                            !r.can_create_sharing_profiles &&
                            !r.can_view_sessions && (
                              <span className="text-txt-tertiary text-[10px] italic">
                                No permissions
                              </span>
                            )}
                        </div>
                      </td>
                      <td>
                        <div className="flex gap-2">
                          <button
                            className="btn-ghost text-[0.8125rem] px-2 py-0.5"
                            onClick={() => handleEditRole(r)}
                          >
                            Edit
                          </button>
                          {r.name !== "admin" && r.name !== "user" && (
                            <button
                              className="btn-ghost text-[0.8125rem] px-2 py-0.5 text-danger"
                              onClick={() => {
                                setConfirmModal({
                                  title: "Delete Role",
                                  message: `Are you sure you want to delete the role "${r.name}"? This will remove all associated permissions and mappings.`,
                                  isDangerous: true,
                                  confirmLabel: "Delete",
                                  onConfirm: async () => {
                                    try {
                                      await deleteRole(r.id);
                                      getRoles().then(onRolesChanged);
                                    } catch (err) {
                                      alert(
                                        err instanceof Error ? err.message : "Failed to delete role"
                                      );
                                    } finally {
                                      setConfirmModal(null);
                                    }
                                  },
                                });
                              }}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="bg-surface-secondary/50 p-3 rounded-lg border border-border/50">
              <button
                className="btn-primary flex items-center gap-2 whitespace-nowrap shadow-sm mx-auto"
                onClick={() => {
                  setEditingRole(null);
                  setNewRole({
                    name: "",
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
                  });
                  setAssignmentConnectionIds([]);
                  setAssignmentFolderIds([]);
                  setRoleModalTab("permissions");
                  setRoleModalOpen(true);
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Create New Role
              </button>
            </div>
          </div>
        )}

        {/* ── Sub-view 2: Permissions Matrix ── */}
        {subTab === "permissions" && (
          <div className="space-y-4">
            <p className="text-xs text-txt-secondary">
              Role permissions dictate operational access across authentication, connection
              creation, audit visibility, and sharing profiles.
            </p>
            <div className="table-responsive w-full">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th>Capability</th>
                    <th>Scope</th>
                    {roles.map((r) => (
                      <th key={r.id} className="text-center">
                        {r.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      key: "can_manage_system",
                      label: "Administer System",
                      scope: "Settings, Vault, Auth, Infra",
                    },
                    {
                      key: "can_view_audit_logs",
                      label: "Audit System",
                      scope: "Monitor audit logs & activity",
                    },
                    {
                      key: "can_create_users",
                      label: "Create Users",
                      scope: "User provisioning lifecycle",
                    },
                    {
                      key: "can_create_user_groups",
                      label: "Create Roles",
                      scope: "RBAC roles and mappings",
                    },
                    {
                      key: "can_create_connections",
                      label: "Create Connections",
                      scope: "Endpoints & remote protocols",
                    },
                    {
                      key: "can_use_quick_share",
                      label: "Inbound Quick Share",
                      scope: "Upload files into session",
                    },
                    {
                      key: "can_use_quick_share_outbound",
                      label: "Outbound Quick Share",
                      scope: "Export files out of session",
                    },
                    {
                      key: "can_create_sharing_profiles",
                      label: "Share Connections",
                      scope: "Co-pilot screen sharing",
                    },
                    {
                      key: "can_view_sessions",
                      label: "View Own Sessions",
                      scope: "Live and recorded sessions",
                    },
                  ].map((row) => (
                    <tr key={row.key}>
                      <td className="font-medium text-txt-primary">{row.label}</td>
                      <td className="text-txt-tertiary">{row.scope}</td>
                      {roles.map((r) => {
                        const enabled = !!(r as unknown as Record<string, boolean>)[row.key];
                        return (
                          <td key={r.id} className="text-center">
                            <span
                              className={`inline-block w-2.5 h-2.5 rounded-full ${enabled ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" : "bg-white/10"}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Sub-view 3: Session Policies ── */}
        {subTab === "policies" && (
          <div className="space-y-4">
            <p className="text-xs text-txt-secondary">
              Session Policies govern tunnel timeouts, watermarking, recording behaviors, and
              transfer limits across active user sessions.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-surface-secondary/40 border border-border/60">
                <div className="text-sm font-semibold text-txt-primary mb-1">
                  Session Duration Caps
                </div>
                <div className="text-xs text-txt-secondary mb-3">
                  Hard limits enforced by the WebSocket watchdog.
                </div>
                <div className="text-xs space-y-1.5">
                  <div className="flex justify-between py-1 border-b border-border/40">
                    <span className="text-txt-tertiary">Max Session Duration:</span>
                    <span className="font-mono text-txt-primary">8 hours</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/40">
                    <span className="text-txt-tertiary">Idle Inactivity Timeout:</span>
                    <span className="font-mono text-txt-primary">20 minutes</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-txt-tertiary">Watchdog Poll Interval:</span>
                    <span className="font-mono text-txt-primary">30 seconds</span>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-lg bg-surface-secondary/40 border border-border/60">
                <div className="text-sm font-semibold text-txt-primary mb-1">
                  Watermark & Screen Recording
                </div>
                <div className="text-xs text-txt-secondary mb-3">
                  Compliance overlays and auditing protections.
                </div>
                <div className="text-xs space-y-1.5">
                  <div className="flex justify-between py-1 border-b border-border/40">
                    <span className="text-txt-tertiary">Global Watermark Default:</span>
                    <span className="font-mono text-txt-primary">
                      Enabled (Client IP + Timestamp)
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/40">
                    <span className="text-txt-tertiary">Screen Recording Format:</span>
                    <span className="font-mono text-txt-primary">
                      Guacamole Session Recording (.cast)
                    </span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-txt-tertiary">Outbound Share Queue:</span>
                    <span className="font-mono text-txt-primary">Approval Required by Default</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Users Table Card ── */}
      {(user.can_manage_system || user.can_create_users) && (
        <div className="card w-full">
          <div className="flex items-center justify-between mb-4">
            <h2 className="!mb-0 text-xl font-bold text-txt-primary">Users</h2>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-txt-secondary hover:text-txt-primary transition-colors">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={showDeletedUsers}
                  onChange={(e) => {
                    setShowDeletedUsers(e.target.checked);
                    setUserPage(1);
                  }}
                />
                Show Deleted Users
              </label>
              <button
                className="btn-primary text-xs py-1 px-3 shadow-sm"
                onClick={() => {
                  setUserForm({
                    username: "",
                    email: "",
                    full_name: "",
                    role_id: "",
                    auth_type: "local",
                  });
                  setCreatedPassword(null);
                  setUserError("");
                  setUserModalOpen(true);
                }}
              >
                + New User
              </button>
            </div>
          </div>

          <div className="mb-3">
            <input
              value={userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value);
                setUserPage(1);
              }}
              placeholder="Search users by name, username, email, role, or OIDC sub..."
              className="input w-full"
            />
          </div>
          <p className="text-sm text-txt-secondary mb-2">
            Showing{" "}
            {filteredUsers.length === visibleUsersSource.length
              ? visibleUsersSource.length
              : `${filteredUsers.length} of ${visibleUsersSource.length}`}{" "}
            user{visibleUsersSource.length !== 1 ? "s" : ""}
          </p>

          <div className="table-responsive w-full">
            <table className="admin-table w-full">
              <thead>
                <tr>
                  <th>Username / Name</th>
                  <th>Email</th>
                  <th>Auth Type</th>
                  <th>Role</th>
                  <th>Safeguard JIT</th>
                  <th title="By default every outbound Quick-Share submission is queued for approver review. Check this column to opt an individual user out of the approval queue — their submissions are auto-approved unconditionally (DLP score is still recorded for audit but does not block the transfer).">
                    Outbound Share Bypass
                  </th>
                  <th>OIDC Sub</th>
                  <th>Last Login</th>
                  <th className="w-[100px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedUsers.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="font-medium text-txt-primary">{u.username}</div>
                      {u.full_name && (
                        <div className="text-[10px] text-txt-tertiary uppercase tracking-tighter">
                          {u.full_name}
                        </div>
                      )}
                    </td>
                    <td className="text-sm">{u.email}</td>
                    <td>
                      <span
                        className={`badge text-[10px] uppercase font-bold ${
                          u.auth_type === "sso" ? "badge-accent" : "badge-secondary"
                        }`}
                      >
                        {u.auth_type}
                      </span>
                    </td>
                    <td>
                      <Select
                        className="w-32"
                        value={roles.find((r) => r.name === u.role_name)?.id || ""}
                        disabled={!!u.deleted_at}
                        options={roles.map((r) => ({ value: r.id, label: r.name }))}
                        onChange={async (newRoleId) => {
                          try {
                            await updateUser(u.id, { role_id: newRoleId });
                            const refreshed = await getUsers();
                            onUsersChanged(refreshed);
                          } catch (err) {
                            alert(err instanceof Error ? err.message : "Failed to update role");
                          }
                        }}
                      />
                    </td>
                    <td>
                      <label
                        className="inline-flex items-center gap-2 cursor-pointer"
                        title="Per-user opt-in for Safeguard JIT. The global master switch on the Safeguard tab must also be enabled."
                      >
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm"
                          checked={!!u.safeguard_jit_enabled}
                          disabled={!!u.deleted_at}
                          onChange={async (e) => {
                            const enabled = e.target.checked;
                            try {
                              await updateUser(u.id, { safeguard_jit_enabled: enabled });
                              const refreshed = await getUsers();
                              onUsersChanged(refreshed);
                            } catch (err) {
                              alert(
                                err instanceof Error
                                  ? err.message
                                  : "Failed to toggle Safeguard JIT"
                              );
                            }
                          }}
                        />
                        <span className="text-[10px] uppercase tracking-wider text-txt-tertiary">
                          {u.safeguard_jit_enabled ? "Enabled" : "Disabled"}
                        </span>
                      </label>
                    </td>
                    <td>
                      <label
                        className="inline-flex items-center gap-2 cursor-pointer"
                        title="When checked, this user's outbound Quick-Share submissions skip the approver queue and are auto-approved unconditionally. The DLP score is still recorded for audit but does not block the transfer. When unchecked, every submission is queued (system default)."
                      >
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm"
                          checked={u.outbound_share_requires_approval === false}
                          disabled={!!u.deleted_at}
                          onChange={async (e) => {
                            const bypass = e.target.checked;
                            const requires_approval: boolean | null = bypass ? false : null;
                            try {
                              await updateUser(u.id, {
                                outbound_share_requires_approval: requires_approval,
                              });
                              const refreshed = await getUsers();
                              onUsersChanged(refreshed);
                            } catch (err) {
                              alert(
                                err instanceof Error
                                  ? err.message
                                  : "Failed to update outbound approval"
                              );
                            }
                          }}
                        />
                        <span className="text-[10px] uppercase tracking-wider text-txt-tertiary">
                          {u.outbound_share_requires_approval === false ? "Bypass" : "Required"}
                        </span>
                      </label>
                    </td>
                    <td className="font-mono text-[0.7rem] text-txt-tertiary">
                      {u.sub || <span className="opacity-30">—</span>}
                    </td>
                    <td className="text-xs text-txt-secondary whitespace-nowrap">
                      {u.last_login_at ? (
                        formatDateTime(u.last_login_at)
                      ) : (
                        <span className="opacity-40 italic">Never</span>
                      )}
                    </td>
                    <td>
                      <div className="flex gap-1">
                        {u.deleted_at ? (
                          <button
                            className="btn-ghost text-xs text-accent py-1 px-2 hover:bg-accent/10"
                            onClick={async () => {
                              try {
                                await restoreUser(u.id);
                                const all = await getUsers();
                                onUsersChanged(all);
                              } catch (err) {
                                alert(
                                  err instanceof Error ? err.message : "Failed to restore user"
                                );
                              }
                            }}
                          >
                            Restore
                          </button>
                        ) : (
                          <button
                            className="btn-ghost text-xs text-danger py-1 px-2 hover:bg-danger/10"
                            onClick={() => {
                              setConfirmModal({
                                title: "Delete User",
                                message: `Delete user "${u.username}"? (Soft-delete for 7 days)`,
                                isDangerous: true,
                                confirmLabel: "Delete",
                                onConfirm: async () => {
                                  try {
                                    await deleteUser(u.id);
                                    onUsersChanged(users.filter((x) => x.id !== u.id));
                                  } catch (err) {
                                    alert(
                                      err instanceof Error ? err.message : "Failed to delete user"
                                    );
                                  } finally {
                                    setConfirmModal(null);
                                  }
                                },
                              });
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {userTotalPages > 1 && (
            <div className="flex items-center justify-between mt-4 bg-surface-secondary/30 p-2 rounded-lg border border-border/50">
              <div className="text-sm text-txt-tertiary">
                Page {safeUserPage} of {userTotalPages}
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-ghost text-xs px-2 py-1"
                  disabled={safeUserPage === 1}
                  onClick={() => setUserPage((p) => Math.max(1, p - 1))}
                >
                  ← Prev
                </button>
                <button
                  className="btn-ghost text-xs px-2 py-1"
                  disabled={safeUserPage === userTotalPages}
                  onClick={() => setUserPage((p) => Math.min(userTotalPages, p + 1))}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Role Modal ── */}
      {roleModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-bold mb-4">
              {editingRole ? "Edit Role" : "Create New Role"}
            </h3>

            <div className="flex gap-2 mb-4 border-b border-border">
              <button
                className={`pb-2 px-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                  roleModalTab === "permissions"
                    ? "text-accent border-b-2 border-accent"
                    : "text-txt-tertiary hover:text-txt-primary"
                }`}
                onClick={() => setRoleModalTab("permissions")}
              >
                Permissions
              </button>
              <button
                className={`pb-2 px-1 text-xs font-bold uppercase tracking-wider transition-colors ${
                  roleModalTab === "assignments"
                    ? "text-accent border-b-2 border-accent"
                    : "text-txt-tertiary hover:text-txt-primary"
                }`}
                onClick={() => setRoleModalTab("assignments")}
              >
                Assignments
              </button>
            </div>

            {roleModalTab === "permissions" ? (
              <>
                <div className="form-group mb-4">
                  <label htmlFor="role-name">Role Name</label>
                  <input
                    id="role-name"
                    value={newRole.name}
                    onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
                    placeholder="e.g. Helpdesk"
                    disabled={editingRole?.name === "admin" || editingRole?.name === "user"}
                  />
                </div>

                <div className="space-y-3 mb-6">
                  <span className="text-xs font-bold uppercase tracking-wider text-txt-tertiary">
                    Permissions
                  </span>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_manage_system}
                      onChange={(e) =>
                        setNewRole({ ...newRole, can_manage_system: e.target.checked })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Administer system</span>
                      <span className="text-[10px] text-txt-tertiary">
                        Settings, Auth, Vault, Infrastructure
                      </span>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_view_audit_logs}
                      onChange={(e) =>
                        setNewRole({ ...newRole, can_view_audit_logs: e.target.checked })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Audit system</span>
                      <span className="text-[10px] text-txt-tertiary">
                        Monitor administrative activity
                      </span>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_create_users}
                      onChange={(e) =>
                        setNewRole({ ...newRole, can_create_users: e.target.checked })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Create new users</span>
                      <span className="text-[10px] text-txt-tertiary">
                        Provisioning and user lifecycle
                      </span>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_create_user_groups}
                      onChange={(e) =>
                        setNewRole({ ...newRole, can_create_user_groups: e.target.checked })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Create new roles</span>
                      <span className="text-[10px] text-txt-tertiary">
                        Create and manage platform roles
                      </span>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_create_connections}
                      onChange={(e) =>
                        setNewRole({ ...newRole, can_create_connections: e.target.checked })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Create new connections</span>
                      <span className="text-[10px] text-txt-tertiary">
                        Hosts, protocols, shared drive configs
                      </span>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_use_quick_share}
                      onChange={(e) =>
                        setNewRole({
                          ...newRole,
                          can_use_quick_share: e.target.checked,
                        })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Use Inbound Quick Share</span>
                      <span className="text-[10px] text-txt-tertiary">
                        Upload files into an active session
                      </span>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_use_quick_share_outbound}
                      onChange={(e) =>
                        setNewRole({
                          ...newRole,
                          can_use_quick_share_outbound: e.target.checked,
                        })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Use Outbound Quick Share</span>
                      <span className="text-[10px] text-txt-tertiary">
                        Export files out of a session. Approval is required for every submission by
                        default; individual users may be opted out on the Users tab below.
                      </span>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_create_sharing_profiles}
                      onChange={(e) =>
                        setNewRole({
                          ...newRole,
                          can_create_sharing_profiles: e.target.checked,
                        })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Sharing Connections</span>
                      <span className="text-[10px] text-txt-tertiary">
                        Share active RDP / SSH sessions with others
                      </span>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newRole.can_view_sessions}
                      onChange={(e) =>
                        setNewRole({ ...newRole, can_view_sessions: e.target.checked })
                      }
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">View own sessions</span>
                      <span className="text-[10px] text-txt-tertiary">
                        View live and recorded sessions (own sessions only)
                      </span>
                    </div>
                  </label>
                </div>
              </>
            ) : (
              <div className="space-y-4 mb-6 max-h-[400px] overflow-y-auto pr-1">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-txt-tertiary block mb-2">
                    Assigned Folders
                  </span>
                  <div className="space-y-1 bg-surface-secondary/30 p-2 rounded-lg border border-border/50">
                    {folders.length === 0 ? (
                      <div className="text-[10px] text-txt-tertiary italic p-1">
                        No folders created yet
                      </div>
                    ) : (
                      orderFoldersByHierarchy(folders).map(({ folder: f, depth }) => (
                        <label
                          key={f.id}
                          className="flex items-center gap-2 cursor-pointer py-1 px-1.5 hover:bg-surface-secondary rounded transition-colors group"
                          style={depth > 0 ? { paddingLeft: `${6 + depth * 16}px` } : undefined}
                        >
                          <input
                            type="checkbox"
                            className="checkbox checkbox-sm"
                            checked={assignmentFolderIds.includes(f.id)}
                            onChange={(e) => {
                              if (e.target.checked)
                                setAssignmentFolderIds([...assignmentFolderIds, f.id]);
                              else
                                setAssignmentFolderIds(
                                  assignmentFolderIds.filter((id) => id !== f.id)
                                );
                            }}
                          />
                          <span className="text-xs font-medium group-hover:text-accent transition-colors">
                            {depth > 0 ? `└ ${f.name}` : f.name}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-txt-tertiary block mb-2">
                    Individual Connections
                  </span>
                  <div className="space-y-1 bg-surface-secondary/30 p-2 rounded-lg border border-border/50">
                    {connections.length === 0 ? (
                      <div className="text-[10px] text-txt-tertiary italic p-1">
                        No connections created yet
                      </div>
                    ) : (
                      connections.map((c) => (
                        <label
                          key={c.id}
                          className="flex items-center gap-2 cursor-pointer py-1 px-1.5 hover:bg-surface-secondary rounded transition-colors group"
                        >
                          <input
                            type="checkbox"
                            className="checkbox checkbox-sm"
                            checked={assignmentConnectionIds.includes(c.id)}
                            onChange={(e) => {
                              if (e.target.checked)
                                setAssignmentConnectionIds([...assignmentConnectionIds, c.id]);
                              else
                                setAssignmentConnectionIds(
                                  assignmentConnectionIds.filter((id) => id !== c.id)
                                );
                            }}
                          />
                          <div className="flex flex-col">
                            <span className="text-xs font-medium group-hover:text-accent transition-colors">
                              {c.name}
                            </span>
                            <span className="text-[9px] text-txt-tertiary">
                              {c.protocol.toUpperCase()} • {c.hostname}
                            </span>
                          </div>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button className="btn w-full" onClick={() => setRoleModalOpen(false)}>
                Cancel
              </button>
              <button
                className="btn-primary w-full"
                disabled={roleSaving || !newRole.name.trim()}
                onClick={async () => {
                  setRoleSaving(true);
                  try {
                    if (editingRole) {
                      const r = await updateRole(editingRole.id, newRole);
                      await updateRoleMappings(r.id, assignmentConnectionIds, assignmentFolderIds);
                      onRolesChanged(roles.map((x) => (x.id === r.id ? r : x)));
                    } else {
                      const r = await createRole(newRole);
                      await updateRoleMappings(r.id, assignmentConnectionIds, assignmentFolderIds);
                      onRolesChanged([...roles, r]);
                    }
                    setRoleModalOpen(false);
                  } catch (err) {
                    alert(err instanceof Error ? err.message : "Failed to save role");
                  } finally {
                    setRoleSaving(false);
                  }
                }}
              >
                {roleSaving ? "Saving..." : editingRole ? "Save Changes" : "Create Role"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create User Modal ── */}
      {userModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-md shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-txt-primary">Provision New User</h3>
              {!createdPassword && (
                <button
                  className="text-txt-tertiary hover:text-txt-primary"
                  onClick={() => setUserModalOpen(false)}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {createdPassword ? (
              <div className="space-y-4">
                <div className="p-4 bg-success-dim/20 border border-success/30 rounded-lg text-center">
                  <h4 className="font-bold text-success mb-1">User Created Successfully</h4>
                  <p className="text-sm text-txt-secondary">Local account ready for login.</p>
                </div>

                <div className="p-4 bg-surface-tertiary rounded-lg border border-border text-center">
                  <span className="text-[10px] uppercase tracking-widest text-txt-tertiary font-bold block mb-2">
                    Temporary Password
                  </span>
                  <div className="text-2xl font-mono tracking-tighter text-accent bg-surface-secondary py-3 rounded border border-accent/20 select-all">
                    {createdPassword}
                  </div>
                </div>

                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded text-amber-500 text-xs text-center">
                  This password will <strong>never be shown again</strong>.
                </div>

                <button
                  className="btn-primary w-full py-3"
                  onClick={() => {
                    setUserModalOpen(false);
                  }}
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="form-group !mb-0">
                    <label htmlFor="user-username">Username</label>
                    <input
                      id="user-username"
                      value={userForm.username}
                      onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}
                      placeholder="jsmith"
                    />
                  </div>
                  <div className="form-group !mb-0">
                    <label htmlFor="user-auth-type">Auth Type</label>
                    <Select
                      id="user-auth-type"
                      value={userForm.auth_type}
                      onChange={(v) =>
                        setUserForm({ ...userForm, auth_type: v as "local" | "sso" })
                      }
                      options={[
                        { value: "local", label: "Local (Password)" },
                        { value: "sso", label: "SSO (OIDC)" },
                      ]}
                    />
                  </div>
                </div>

                <div className="form-group !mb-0">
                  <label htmlFor="user-email">Email Address</label>
                  <input
                    id="user-email"
                    type="email"
                    value={userForm.email}
                    onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                    placeholder="john.smith@example.com"
                  />
                </div>

                <div className="form-group !mb-0">
                  <label htmlFor="user-initial-role">Initial Role</label>
                  <Select
                    id="user-initial-role"
                    value={userForm.role_id}
                    onChange={(v) => setUserForm({ ...userForm, role_id: v })}
                    options={roles.map((r) => ({ value: r.id, label: r.name }))}
                  />
                </div>

                {userError && (
                  <div className="p-3 bg-danger-dim text-danger text-sm rounded border border-danger/20">
                    {userError}
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button className="btn w-full" onClick={() => setUserModalOpen(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary w-full"
                    disabled={userSaving || !userForm.username}
                    onClick={async () => {
                      setUserSaving(true);
                      setUserError("");
                      try {
                        const res = await createUser({
                          username: userForm.username,
                          email: userForm.email,
                          role_id: userForm.role_id,
                          auth_type: userForm.auth_type,
                        });
                        if (res.password) {
                          setCreatedPassword(res.password);
                        } else {
                          setUserModalOpen(false);
                          getUsers().then(onUsersChanged);
                        }
                      } catch (err) {
                        setUserError(err instanceof Error ? err.message : "Failed to create user");
                      } finally {
                        setUserSaving(false);
                      }
                    }}
                  >
                    {userSaving ? "Creating..." : "Create User"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Confirm Modal ── */}
      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          isDangerous={confirmModal.isDangerous}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
}
