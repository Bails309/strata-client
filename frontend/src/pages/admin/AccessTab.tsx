import { useEffect, useMemo, useState } from "react";
import ConfirmModal from "../../components/ConfirmModal";
import Select from "../../components/Select";
import EnterpriseCheckbox from "../../components/EnterpriseCheckbox";
import EditRoleModal from "./roles/EditRoleModal";
import { useSettings } from "../../contexts/SettingsContext";
import {
  Connection,
  ConnectionFolder,
  MeResponse,
  Role,
  User,
  createUser,
  deleteRole,
  deleteUser,
  getRoles,
  getUsers,
  restoreUser,
  updateUser,
} from "../../api";

function getVisiblePages(current: number, total: number): (number | string)[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, "...", total];
  }
  if (current >= total - 3) {
    return [1, "...", total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, "...", current - 1, current, current + 1, "...", total];
}

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

  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    isDangerous?: boolean;
    onConfirm: () => void;
  } | null>(null);

  const [roleEditor, setRoleEditor] = useState<{ role: Role | null } | null>(null);

  // Roles list — client-side filter + pagination (limit to 5 per page)
  const [roleSearch, setRoleSearch] = useState("");
  const [rolePage, setRolePage] = useState(1);
  const rolePerPage = 5;

  const filteredRoles = useMemo(() => {
    if (!roleSearch.trim()) return roles;
    const q = roleSearch.toLowerCase().trim();
    return roles.filter((r) => {
      if (r.name.toLowerCase().includes(q)) return true;
      const perms: string[] = [];
      if (r.can_manage_system) perms.push("system");
      if (r.can_view_audit_logs) perms.push("audit");
      if (r.can_create_users) perms.push("users");
      if (r.can_create_user_groups) perms.push("roles");
      if (r.can_create_connections) perms.push("connections");
      if (r.can_use_quick_share) perms.push("qs inbound", "inbound", "quick share");
      if (r.can_use_quick_share_outbound) perms.push("qs outbound", "outbound");
      if (r.can_create_sharing_profiles) perms.push("sharing");
      if (r.can_view_sessions) perms.push("sessions");
      if (r.can_manage_users) perms.push("manage users");
      if (r.can_manage_connections) perms.push("manage connections");
      return perms.some((p) => p.includes(q));
    });
  }, [roles, roleSearch]);

  const roleTotalPages = Math.max(1, Math.ceil(filteredRoles.length / rolePerPage));
  const safeRolePage = Math.min(rolePage, roleTotalPages);
  const pagedRoles = filteredRoles.slice(
    (safeRolePage - 1) * rolePerPage,
    safeRolePage * rolePerPage
  );

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
            {/* Search bar and counter */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="relative flex-1 max-w-md">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-txt-tertiary">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                </div>
                <input
                  type="text"
                  value={roleSearch}
                  onChange={(e) => {
                    setRoleSearch(e.target.value);
                    setRolePage(1);
                  }}
                  placeholder="Search roles by name or permission..."
                  className="input w-full pl-9 pr-8"
                  aria-label="Search roles"
                />
                {roleSearch && (
                  <button
                    type="button"
                    onClick={() => {
                      setRoleSearch("");
                      setRolePage(1);
                    }}
                    className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-txt-tertiary hover:text-txt-primary cursor-pointer"
                    aria-label="Clear search"
                  >
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="text-xs text-txt-secondary whitespace-nowrap self-center">
                Showing{" "}
                <span className="font-semibold text-txt-primary">
                  {filteredRoles.length === roles.length
                    ? roles.length
                    : `${filteredRoles.length} of ${roles.length}`}
                </span>{" "}
                role{roles.length !== 1 ? "s" : ""}
              </div>
            </div>

            {filteredRoles.length === 0 ? (
              <div className="text-center py-8 bg-surface-secondary/20 rounded-lg border border-border/40">
                <p className="text-sm text-txt-secondary">
                  No roles match &quot;{roleSearch}&quot;
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setRoleSearch("");
                    setRolePage(1);
                  }}
                  className="btn-ghost text-xs text-accent mt-2"
                >
                  Clear filter
                </button>
              </div>
            ) : (
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
                    {pagedRoles.map((r) => (
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
                              onClick={() => setRoleEditor({ role: r })}
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
            )}

            {/* Roles Pagination Controls */}
            {roleTotalPages > 1 && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-surface-secondary/30 p-2.5 rounded-lg border border-border/50">
                <div className="text-xs text-txt-tertiary">
                  Showing{" "}
                  <span className="font-medium text-txt-secondary">
                    {(safeRolePage - 1) * rolePerPage + 1}–
                    {Math.min(safeRolePage * rolePerPage, filteredRoles.length)}
                  </span>{" "}
                  of{" "}
                  <span className="font-medium text-txt-secondary">{filteredRoles.length}</span>{" "}
                  roles (Page {safeRolePage} of {roleTotalPages})
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    className="btn-ghost text-xs px-2.5 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                    disabled={safeRolePage === 1}
                    onClick={() => setRolePage((p) => Math.max(1, p - 1))}
                    aria-label="Previous page"
                  >
                    ← Prev
                  </button>
                  <div className="flex items-center gap-1">
                    {getVisiblePages(safeRolePage, roleTotalPages).map((p, idx) =>
                      typeof p === "number" ? (
                        <button
                          key={p}
                          onClick={() => setRolePage(p)}
                          className={`w-7 h-7 text-xs rounded transition-colors ${
                            safeRolePage === p
                              ? "bg-accent text-white font-semibold shadow-xs"
                              : "text-txt-secondary hover:bg-surface-secondary hover:text-txt-primary"
                          }`}
                          aria-label={`Page ${p}`}
                          aria-current={safeRolePage === p ? "page" : undefined}
                        >
                          {p}
                        </button>
                      ) : (
                        <span
                          key={`ellipsis-${idx}`}
                          className="px-1 text-xs text-txt-tertiary select-none"
                        >
                          …
                        </span>
                      )
                    )}
                  </div>
                  <button
                    className="btn-ghost text-xs px-2.5 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                    disabled={safeRolePage === roleTotalPages}
                    onClick={() => setRolePage((p) => Math.min(roleTotalPages, p + 1))}
                    aria-label="Next page"
                  >
                    Next →
                  </button>
                </div>
              </div>
            )}

            <div className="bg-surface-secondary/50 p-3 rounded-lg border border-border/50">
              <button
                className="btn-primary flex items-center gap-2 whitespace-nowrap shadow-sm mx-auto"
                onClick={() => setRoleEditor({ role: null })}
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
              <EnterpriseCheckbox
                checked={showDeletedUsers}
                onChange={(e) => {
                  setShowDeletedUsers(e.target.checked);
                  setUserPage(1);
                }}
                className="text-xs font-medium text-txt-secondary hover:text-txt-primary transition-colors"
                label="Show Deleted Users"
              />
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
                      <EnterpriseCheckbox
                        title="Per-user opt-in for Safeguard JIT. The global master switch on the Safeguard tab must also be enabled."
                        aria-label={`Safeguard JIT for ${u.username}`}
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
                      >
                        <span className="text-[10px] uppercase tracking-wider text-txt-tertiary">
                          {u.safeguard_jit_enabled ? "Enabled" : "Disabled"}
                        </span>
                      </EnterpriseCheckbox>
                    </td>
                    <td>
                      <EnterpriseCheckbox
                        title="When checked, this user's outbound Quick-Share submissions skip the approver queue and are auto-approved unconditionally. The DLP score is still recorded for audit but does not block the transfer. When unchecked, every submission is queued (system default)."
                        aria-label={`Outbound share bypass for ${u.username}`}
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
                      >
                        <span className="text-[10px] uppercase tracking-wider text-txt-tertiary">
                          {u.outbound_share_requires_approval === false ? "Bypass" : "Required"}
                        </span>
                      </EnterpriseCheckbox>
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

      {roleEditor && (
        <EditRoleModal
          role={roleEditor.role}
          roles={roles}
          folders={folders}
          connections={connections}
          users={users}
          onClose={() => setRoleEditor(null)}
          onSaved={(r, created) =>
            onRolesChanged(created ? [...roles, r] : roles.map((x) => (x.id === r.id ? r : x)))
          }
        />
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
