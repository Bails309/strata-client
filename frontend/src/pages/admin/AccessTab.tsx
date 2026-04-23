import { useEffect, useRef, useState } from "react";
import ConfirmModal from "../../components/ConfirmModal";
import Select from "../../components/Select";
import {
  Connection,
  ConnectionFolder,
  MeResponse,
  Role,
  User,
  createConnection,
  createConnectionFolder,
  createRole,
  createUser,
  deleteConnection,
  deleteConnectionFolder,
  deleteRole,
  deleteUser,
  getRoleMappings,
  getRoles,
  getUsers,
  restoreUser,
  updateConnection,
  updateConnectionFolder as _updateConnectionFolder,
  updateRole,
  updateRoleMappings,
  updateUser,
} from "../../api";
import { RdpSections, SshSections, VncSections } from "./connectionForm";

export default function AccessTab({
  user,
  roles,
  connections,
  folders,
  users,
  onRolesChanged,
  onConnectionCreated,
  onConnectionUpdated,
  onConnectionDeleted,
  onFoldersChanged,
  onUsersChanged,
}: {
  user: MeResponse;
  roles: Role[];
  connections: Connection[];
  folders: ConnectionFolder[];
  users: User[];
  onRolesChanged: (r: Role[]) => void;
  onConnectionCreated: (c: Connection) => void;
  onConnectionUpdated: (c: Connection) => void;
  onConnectionDeleted: (id: string) => void;
  onFoldersChanged: (f: ConnectionFolder[]) => void;
  onUsersChanged: (u: User[]) => void;
}) {
  const [newRole, setNewRole] = useState<{
    name: string;
    can_manage_system: boolean;
    can_manage_users: boolean;
    can_manage_connections: boolean;
    can_view_audit_logs: boolean;
    can_create_users: boolean;
    can_create_user_groups: boolean;
    can_create_connections: boolean;
    can_create_connection_folders: boolean;
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
    can_create_connection_folders: false,
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
      can_create_connection_folders: r.can_create_connection_folders,
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
  const [formMode, setFormMode] = useState<"closed" | "add" | "edit">("closed");
  const [formId, setFormId] = useState<string | null>(null);
  const [formCore, setFormCore] = useState({
    name: "",
    protocol: "rdp",
    hostname: "",
    port: 3389,
    domain: "",
    description: "",
    folder_id: "",
    watermark: "inherit",
  });
  const [formExtra, setFormExtra] = useState<Record<string, string>>({});
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParent, setNewFolderParent] = useState("");
  const [connSearch, setConnSearch] = useState("");
  const [connPage, setConnPage] = useState(1);
  const connPerPage = 20;
  const connFormRef = useRef<HTMLDivElement>(null);

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

  const filteredConnections = connections.filter((c) => {
    if (!connSearch) return true;
    const q = connSearch.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.hostname.toLowerCase().includes(q) ||
      c.protocol.toLowerCase().includes(q) ||
      (c.description || "").toLowerCase().includes(q) ||
      (folders.find((f) => f.id === c.folder_id)?.name || "").toLowerCase().includes(q)
    );
  });
  const connTotalPages = Math.max(1, Math.ceil(filteredConnections.length / connPerPage));
  const safeConnPage = Math.min(connPage, connTotalPages);
  const pagedConnections = filteredConnections.slice(
    (safeConnPage - 1) * connPerPage,
    safeConnPage * connPerPage
  );

  function openAdd() {
    setFormMode("add");
    setFormId(null);
    setFormCore({
      name: "",
      protocol: "rdp",
      hostname: "",
      port: 3389,
      domain: "",
      description: "",
      folder_id: "",
      watermark: "inherit",
    });
    setFormExtra({ "server-layout": "en-gb-qwerty", timezone: "Europe/London" });
    setTimeout(
      () => connFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50
    );
  }

  function openEdit(c: Connection) {
    setFormMode("edit");
    setFormId(c.id);
    setFormCore({
      name: c.name,
      protocol: c.protocol,
      hostname: c.hostname,
      port: c.port,
      domain: c.domain || "",
      description: c.description || "",
      folder_id: c.folder_id || "",
      watermark: c.watermark || "inherit",
    });
    setFormExtra(c.extra ? { ...c.extra } : {});
    setTimeout(
      () => connFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50
    );
  }

  function closeForm() {
    setFormMode("closed");
    setFormId(null);
  }

  const ex = (k: string) => formExtra[k] || "";
  const setEx = (k: string, v: string) => setFormExtra({ ...formExtra, [k]: v });

  // Strip empty values from extra before saving
  function cleanExtra(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(formExtra)) {
      if (v !== "" && v !== "false") out[k] = v;
    }
    return out;
  }

  async function handleSave() {
    try {
      const payload = {
        ...formCore,
        folder_id: formCore.folder_id || undefined,
        extra: cleanExtra(),
      };
      let c;
      if (formMode === "add") {
        c = await createConnection(payload);
        onConnectionCreated(c);
      } else if (formMode === "edit" && formId) {
        c = await updateConnection(formId, payload);
        onConnectionUpdated(c);
      }
      if (c) {
        setFormExtra(c.extra || {});
      }
      closeForm();
    } catch (err: any) {
      alert(err.message || "Failed to save connection");
    }
  }

  const handleDelete = (id: string) => {
    setConfirmModal({
      title: "Delete Connection",
      message: "Are you sure you want to delete this connection? This action cannot be undone.",
      isDangerous: true,
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await deleteConnection(id);
          onConnectionDeleted(id);
          if (id === formId) {
            closeForm();
          }
        } catch (err: any) {
          alert(err.message || "Failed to delete connection");
        } finally {
          setConfirmModal(null);
        }
      },
    });
  };

  return (
    <div className="grid gap-6">
      {/* Roles */}
      {(user.can_manage_system || user.can_create_user_groups) && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="!mb-0">Roles</h2>
            <p className="text-txt-tertiary text-xs">Standard RBAC roles for platform access</p>
          </div>

          <table className="mb-4">
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
                      {r.can_create_connection_folders && (
                        <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">
                          Folders
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
                        !r.can_create_connection_folders &&
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
                                } catch (err: any) {
                                  alert(err.message || "Failed to delete role");
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
                  can_create_connection_folders: false,
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

          {/* Role Modal */}
          {roleModalOpen && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
              <div className="card w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-bold mb-4">
                  {editingRole ? "Edit Role" : "Create New Role"}
                </h3>

                <div className="flex gap-2 mb-4 border-b border-border">
                  <button
                    className={`pb-2 px-1 text-xs font-bold uppercase tracking-wider transition-colors ${roleModalTab === "permissions" ? "text-accent border-b-2 border-accent" : "text-txt-tertiary hover:text-txt-primary"}`}
                    onClick={() => setRoleModalTab("permissions")}
                  >
                    Permissions
                  </button>
                  <button
                    className={`pb-2 px-1 text-xs font-bold uppercase tracking-wider transition-colors ${roleModalTab === "assignments" ? "text-accent border-b-2 border-accent" : "text-txt-tertiary hover:text-txt-primary"}`}
                    onClick={() => setRoleModalTab("assignments")}
                  >
                    Assignments
                  </button>
                </div>

                {roleModalTab === "permissions" ? (
                  <>
                    <div className="form-group mb-4">
                      <label>Role Name</label>
                      <input
                        value={newRole.name}
                        onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
                        placeholder="e.g. Helpdesk"
                        disabled={editingRole?.name === "admin" || editingRole?.name === "user"}
                      />
                    </div>

                    <div className="space-y-3 mb-6">
                      <label className="text-xs font-bold uppercase tracking-wider text-txt-tertiary">
                        Permissions
                      </label>
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
                          checked={newRole.can_create_connection_folders}
                          onChange={(e) =>
                            setNewRole({
                              ...newRole,
                              can_create_connection_folders: e.target.checked,
                            })
                          }
                        />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Create connection folders</span>
                          <span className="text-[10px] text-txt-tertiary">
                            Organize connections into folders
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
                      <label className="text-xs font-bold uppercase tracking-wider text-txt-tertiary block mb-2">
                        Assigned Folders
                      </label>
                      <div className="space-y-1 bg-surface-secondary/30 p-2 rounded-lg border border-border/50">
                        {folders.length === 0 ? (
                          <div className="text-[10px] text-txt-tertiary italic p-1">
                            No folders created yet
                          </div>
                        ) : (
                          folders.map((f) => (
                            <label
                              key={f.id}
                              className="flex items-center gap-2 cursor-pointer py-1 px-1.5 hover:bg-surface-secondary rounded transition-colors group"
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
                                {f.name}
                              </span>
                            </label>
                          ))
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-bold uppercase tracking-wider text-txt-tertiary block mb-2">
                        Individual Connections
                      </label>
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
                          await updateRoleMappings(
                            r.id,
                            assignmentConnectionIds,
                            assignmentFolderIds
                          );
                          onRolesChanged(roles.map((x) => (x.id === r.id ? r : x)));
                        } else {
                          const r = await createRole(newRole);
                          await updateRoleMappings(
                            r.id,
                            assignmentConnectionIds,
                            assignmentFolderIds
                          );
                          onRolesChanged([...roles, r]);
                        }
                        setRoleModalOpen(false);
                      } catch (err: any) {
                        alert(err.message || "Failed to save role");
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
        </div>
      )}

      {/* Connections */}
      {(user.can_manage_system || user.can_create_connections) && (
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="!mb-0">Connections</h2>
            <button className="btn-primary text-[0.8rem] px-3 py-1" onClick={openAdd}>
              + Add Connection
            </button>
          </div>
          <div className="mb-3">
            <input
              value={connSearch}
              onChange={(e) => {
                setConnSearch(e.target.value);
                setConnPage(1);
              }}
              placeholder="Search connections by name, host, protocol, description, or folder..."
              className="input w-full"
            />
          </div>
          <p className="text-sm text-txt-secondary mb-2">
            Showing{" "}
            {filteredConnections.length === connections.length
              ? connections.length
              : `${filteredConnections.length} of ${connections.length}`}{" "}
            connection{connections.length !== 1 ? "s" : ""}
          </p>
          <div className="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Protocol</th>
                  <th>Host</th>
                  <th>Port</th>
                  <th>Folder</th>
                  <th className="w-[140px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedConnections.map((c) => (
                  <tr key={c.id} className={formId === c.id ? "bg-surface-secondary" : ""}>
                    <td>
                      <div className="font-medium text-txt-primary">{c.name}</div>
                      {c.description && (
                        <div className="text-[0.75rem] text-txt-tertiary">{c.description}</div>
                      )}
                    </td>
                    <td>
                      <span className="badge badge-secondary py-0 px-1 text-[10px]">
                        {c.protocol.toUpperCase()}
                      </span>
                    </td>
                    <td>{c.hostname}</td>
                    <td>{c.port}</td>
                    <td>
                      {c.folder_id ? folders.find((f) => f.id === c.folder_id)?.name || "—" : "—"}
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <button
                          className="btn-ghost text-[0.8rem] px-2 py-1"
                          onClick={() => openEdit(c)}
                        >
                          Edit
                        </button>
                        <button
                          className="btn-ghost text-[0.8rem] px-2 py-1 text-danger"
                          onClick={() => handleDelete(c.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {connTotalPages > 1 && (
            <div className="flex items-center justify-between mt-4 bg-surface-secondary/30 p-2 rounded-lg border border-border/50">
              <div className="text-sm text-txt-tertiary">
                Page {safeConnPage} of {connTotalPages}
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-ghost text-xs px-2 py-1"
                  disabled={safeConnPage === 1}
                  onClick={() => setConnPage((p) => Math.max(1, p - 1))}
                >
                  ← Prev
                </button>
                <button
                  className="btn-ghost text-xs px-2 py-1"
                  disabled={safeConnPage === connTotalPages}
                  onClick={() => setConnPage((p) => Math.min(connTotalPages, p + 1))}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Connection Editor Form */}
      {(user.can_manage_system || user.can_create_connections) && formMode !== "closed" && (
        <div className="card" ref={connFormRef}>
          <div className="flex justify-between items-center mb-4">
            <h2 className="!mb-0">{formMode === "add" ? "Add Connection" : "Edit Connection"}</h2>
            <button className="btn text-[0.8rem] px-2 py-1" onClick={closeForm}>
              Cancel
            </button>
          </div>
          <div
            className="mb-4"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 100px 1fr 80px 1fr",
              gap: "0.5rem",
            }}
          >
            <div className="form-group !mb-0">
              <label>Name</label>
              <input
                value={formCore.name}
                onChange={(e) => setFormCore({ ...formCore, name: e.target.value })}
                placeholder="My Server"
              />
            </div>
            <div className="form-group !mb-0">
              <label>Protocol</label>
              <Select
                value={formCore.protocol}
                onChange={(v) => {
                  const ports: Record<string, number> = { rdp: 3389, ssh: 22, vnc: 5900 };
                  setFormCore({ ...formCore, protocol: v, port: ports[v] ?? formCore.port });
                }}
                options={[
                  { value: "rdp", label: "RDP" },
                  { value: "ssh", label: "SSH" },
                  { value: "vnc", label: "VNC" },
                ]}
              />
            </div>
            <div className="form-group !mb-0">
              <label>Hostname</label>
              <input
                value={formCore.hostname}
                onChange={(e) => setFormCore({ ...formCore, hostname: e.target.value })}
                placeholder="10.0.0.10"
              />
            </div>
            <div className="form-group !mb-0">
              <label>Port</label>
              <input
                type="number"
                value={formCore.port}
                onChange={(e) => setFormCore({ ...formCore, port: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="form-group !mb-0">
              <label>Domain</label>
              <input
                value={formCore.domain}
                onChange={(e) => setFormCore({ ...formCore, domain: e.target.value })}
                placeholder="EXAMPLE.COM"
              />
            </div>
          </div>
          <div
            className="mb-4"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem" }}
          >
            <div className="form-group !mb-0">
              <label>Description</label>
              <input
                value={formCore.description}
                onChange={(e) => setFormCore({ ...formCore, description: e.target.value })}
                placeholder="Optional description"
              />
            </div>
            <div className="form-group !mb-0">
              <label>Folder</label>
              <Select
                value={formCore.folder_id}
                onChange={(v) => setFormCore({ ...formCore, folder_id: v })}
                placeholder="No folder"
                options={[
                  { value: "", label: "No folder" },
                  ...folders.map((f) => ({
                    value: f.id,
                    label: f.parent_id ? `  └ ${f.name}` : f.name,
                  })),
                ]}
              />
            </div>
            <div className="form-group !mb-0">
              <label>Session Watermark</label>
              <Select
                value={formCore.watermark}
                onChange={(v) => setFormCore({ ...formCore, watermark: v })}
                options={[
                  { value: "inherit", label: "Inherit (global setting)" },
                  { value: "on", label: "Always on" },
                  { value: "off", label: "Always off" },
                ]}
              />
            </div>
          </div>

          <div className="mt-6">
            <h4 className="text-sm font-bold uppercase tracking-widest text-txt-tertiary mb-3">
              Protocol Parameters
            </h4>
            {formCore.protocol === "rdp" && (
              <RdpSections extra={formExtra} setExtra={setFormExtra} ex={ex} setEx={setEx} />
            )}
            {formCore.protocol === "ssh" && <SshSections ex={ex} setEx={setEx} />}
            {formCore.protocol === "vnc" && <VncSections ex={ex} setEx={setEx} />}
          </div>
          <div className="flex gap-2 mt-4">
            <button className="btn-primary" onClick={handleSave}>
              {formMode === "add" ? "Create Connection" : "Save Changes"}
            </button>
            <button className="btn" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Connection Folders */}
      {(user.can_manage_system || user.can_create_connection_folders) && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h2 className="!mb-0">Connection Folders</h2>
            <p className="text-txt-tertiary text-xs">Organize connections into hierarchy</p>
          </div>

          {folders.length > 0 ? (
            <table className="mb-4">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Parent</th>
                  <th className="w-[100px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {folders.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <span className="font-medium">{f.name}</span>
                    </td>
                    <td>
                      {f.parent_id ? (
                        folders.find((p) => p.id === f.parent_id)?.name || "—"
                      ) : (
                        <span className="text-txt-tertiary italic">Root</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn-ghost text-[0.8rem] px-2 py-1 text-danger hover:bg-danger/10"
                        onClick={() => {
                          setConfirmModal({
                            title: "Delete Folder",
                            message: `Are you sure you want to delete the folder "${f.name}"? All connections inside this folder will become unassigned.`,
                            isDangerous: true,
                            confirmLabel: "Delete",
                            onConfirm: async () => {
                              try {
                                await deleteConnectionFolder(f.id);
                                onFoldersChanged(folders.filter((x) => x.id !== f.id));
                              } catch (err: any) {
                                alert(err.message || "Failed to delete folder");
                              } finally {
                                setConfirmModal(null);
                              }
                            },
                          });
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-center py-6 bg-surface-secondary/30 rounded-lg border border-dashed border-border mb-4">
              <p className="text-txt-secondary text-sm">No folders created yet.</p>
            </div>
          )}

          <div className="bg-surface-secondary/50 p-3 rounded-lg border border-border/50">
            <div className="flex items-center gap-3">
              <div className="flex-1 max-w-[300px]">
                <input
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Folder name..."
                  className="w-full"
                />
              </div>
              <div className="w-[200px]">
                <Select
                  value={newFolderParent}
                  onChange={setNewFolderParent}
                  placeholder="Root Level"
                  options={[
                    { value: "", label: "Root Level" },
                    ...folders
                      .filter((f) => !f.parent_id)
                      .map((f) => ({ value: f.id, label: f.name })),
                  ]}
                />
              </div>
              <button
                className="btn-primary flex items-center gap-2 whitespace-nowrap shadow-sm"
                disabled={!newFolderName.trim()}
                onClick={async () => {
                  if (!newFolderName.trim()) return;
                  const f = await createConnectionFolder({
                    name: newFolderName.trim(),
                    parent_id: newFolderParent || undefined,
                  });
                  onFoldersChanged([...folders, f]);
                  setNewFolderName("");
                  setNewFolderParent("");
                }}
              >
                Add Folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Users */}
      {(user.can_manage_system || user.can_create_users) && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="!mb-0">Users</h2>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-txt-secondary hover:text-txt-primary transition-colors">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={showDeletedUsers}
                  onChange={(e) => setShowDeletedUsers(e.target.checked)}
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

          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Username / Name</th>
                  <th>Email</th>
                  <th>Auth Type</th>
                  <th>Role</th>
                  <th>OIDC Sub</th>
                  <th className="w-[100px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(showDeletedUsers ? deletedUsers : users).map((u) => (
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
                        className={`badge text-[10px] uppercase font-bold ${u.auth_type === "sso" ? "badge-accent" : "badge-secondary"}`}
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
                          } catch (err: any) {
                            alert(err.message || "Failed to update role");
                          }
                        }}
                      />
                    </td>
                    <td className="font-mono text-[0.7rem] text-txt-tertiary">
                      {u.sub || <span className="opacity-30">—</span>}
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
                              } catch (err: any) {
                                alert(err.message || "Failed to restore user");
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
                                  } catch (err: any) {
                                    alert(err.message || "Failed to delete user");
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
        </div>
      )}

      {/* Create User Modal */}
      {userModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div
            className="card w-full max-w-md shadow-2xl animate-in fade-in zoom-in duration-200"
            onClick={(e) => e.stopPropagation()}
          >
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
                    <label>Username</label>
                    <input
                      value={userForm.username}
                      onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}
                      placeholder="jsmith"
                    />
                  </div>
                  <div className="form-group !mb-0">
                    <label>Auth Type</label>
                    <Select
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
                  <label>Email Address</label>
                  <input
                    type="email"
                    value={userForm.email}
                    onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                    placeholder="john.smith@example.com"
                  />
                </div>

                <div className="form-group !mb-0">
                  <label>Initial Role</label>
                  <Select
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
                      } catch (err: any) {
                        setUserError(err.message || "Failed to create user");
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
      <ConfirmModal
        isOpen={!!confirmModal}
        title={confirmModal?.title || ""}
        message={confirmModal?.message || ""}
        confirmLabel={confirmModal?.confirmLabel}
        isDangerous={confirmModal?.isDangerous}
        onConfirm={() => confirmModal?.onConfirm()}
        onCancel={() => setConfirmModal(null)}
      />
    </div>
  );
}
