import { useCallback, useEffect, useState } from "react";
import Select from "../../components/Select";
import { useSettings } from "../../contexts/SettingsContext";
import {
  AdSyncConfig,
  ApprovalRole,
  CheckoutRequest,
  DiscoveredAccount,
  User,
  UserAccountMapping,
  createAccountMapping,
  createApprovalRole,
  deleteAccountMapping,
  deleteApprovalRole,
  getAccountMappings,
  getApprovalRoles,
  getCheckoutRequests,
  getRoleAccounts,
  getRoleAssignments,
  getUnmappedAccounts,
  setRoleAccounts,
  setRoleAssignments as apiSetRoleAssignments,
  updateAccountMapping,
} from "../../api";

function parseDN(dn: string): string {
  if (!dn) return "—";
  const cnMatch = dn.match(/(?:^|,)CN=((?:\\.|[^,])+)/i);
  const cn = cnMatch ? cnMatch[1].replace(/\\(.)/g, "$1") : "Unknown";

  const dcMatches = [...dn.matchAll(/DC=([^,]+)/gi)];
  const domain = dcMatches.map((m) => m[1]).join(".");

  return domain ? `${domain}\\${cn}` : cn;
}

export default function PasswordsTab({
  users,
  adSyncConfigs,
  onSave,
}: {
  users: User[];
  adSyncConfigs: AdSyncConfig[];
  onSave: () => void;
}) {
  const { formatDateTime } = useSettings();
  type SubTab = "roles" | "mappings" | "requests";
  const [subTab, setSubTab] = useState<SubTab>("roles");

  // ── Approval roles ──
  const [roles, setRoles] = useState<ApprovalRole[]>([]);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDesc, setNewRoleDesc] = useState("");
  const [roleAssignments, setRoleAssignments] = useState<
    Record<string, { id: string; username: string }[]>
  >({});
  const [roleAccountScopes, setRoleAccountScopes] = useState<Record<string, string[]>>({});
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [scopeSearch, setScopeSearch] = useState("");
  const [approverSearch, setApproverSearch] = useState("");
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);

  // ── Account mappings ──
  const [mappings, setMappings] = useState<UserAccountMapping[]>([]);
  const [newMapping, setNewMapping] = useState({
    user_id: "",
    managed_ad_dn: "",
    can_self_approve: false,
    ad_sync_config_id: "",
  });
  const [unmapped, setUnmapped] = useState<DiscoveredAccount[]>([]);
  const [loadingUnmapped, setLoadingUnmapped] = useState(false);

  // ── Checkout requests ──
  const [requests, setRequests] = useState<CheckoutRequest[]>([]);

  // ── Loaders ──
  const loadRoles = useCallback(async () => {
    try {
      const r = await getApprovalRoles();
      setRoles(r);
      // Load assignments and mappings for each
      const assignObj: Record<string, { id: string; username: string }[]> = {};
      const acctObj: Record<string, string[]> = {};
      await Promise.all(
        r.map(async (role) => {
          const [a, accounts] = await Promise.all([
            getRoleAssignments(role.id),
            getRoleAccounts(role.id),
          ]);
          assignObj[role.id] = a;
          acctObj[role.id] = accounts;
        })
      );
      setRoleAssignments(assignObj);
      setRoleAccountScopes(acctObj);
    } catch {
      /* ignore */
    }
  }, []);

  const loadMappings = useCallback(async () => {
    try {
      setMappings(await getAccountMappings());
    } catch {
      /* ignore */
    }
  }, []);

  const loadRequests = useCallback(async () => {
    try {
      setRequests(await getCheckoutRequests());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadRoles();
    loadMappings();
    loadRequests();
  }, [loadRoles, loadMappings, loadRequests]);

  // ── Handlers ──
  const handleCreateRole = async () => {
    if (!newRoleName.trim()) return;
    await createApprovalRole({ name: newRoleName, description: newRoleDesc || undefined });
    setNewRoleName("");
    setNewRoleDesc("");
    loadRoles();
    onSave();
  };

  const handleDeleteRole = async (id: string) => {
    await deleteApprovalRole(id);
    loadRoles();
    onSave();
  };

  const handleSaveAssignments = async (roleId: string) => {
    await apiSetRoleAssignments(roleId, selectedUsers);
    loadRoles();
    onSave();
  };

  const handleSaveAccounts = async (roleId: string) => {
    const payload = selectedAccounts.map((dn) => {
      const mapping = mappings.find((m) => m.managed_ad_dn === dn);
      return { dn, friendly_name: mapping?.friendly_name };
    });
    await setRoleAccounts(roleId, payload);
    loadRoles();
    onSave();
  };

  const handleCreateMapping = async () => {
    if (!newMapping.user_id || !newMapping.managed_ad_dn) return;
    const configId = newMapping.ad_sync_config_id;
    await createAccountMapping({
      user_id: newMapping.user_id,
      managed_ad_dn: newMapping.managed_ad_dn,
      friendly_name: unmapped.find((a) => a.dn === newMapping.managed_ad_dn)?.friendly_name,
      can_self_approve: newMapping.can_self_approve,
      ad_sync_config_id: configId || undefined,
    });
    setNewMapping({
      user_id: "",
      managed_ad_dn: "",
      can_self_approve: false,
      ad_sync_config_id: configId,
    });
    loadMappings();
    // Refresh unmapped accounts so the just-mapped account is removed from the dropdown
    if (configId) {
      getUnmappedAccounts(configId)
        .then(setUnmapped)
        .catch(() => setUnmapped([]));
    }
    onSave();
  };

  const handleDeleteMapping = async (id: string) => {
    await deleteAccountMapping(id);
    loadMappings();
    // Refresh unmapped accounts so deleted account reappears in the dropdown
    if (newMapping.ad_sync_config_id) {
      getUnmappedAccounts(newMapping.ad_sync_config_id)
        .then(setUnmapped)
        .catch(() => setUnmapped([]));
    }
  };

  const handleToggleSelfApprove = async (id: string, next: boolean) => {
    // Optimistic update so the modern dropdown feels instant.
    setMappings((prev) => prev.map((m) => (m.id === id ? { ...m, can_self_approve: next } : m)));
    try {
      await updateAccountMapping(id, { can_self_approve: next });
    } catch {
      // Revert on failure, then reload to pick up server truth.
      setMappings((prev) => prev.map((m) => (m.id === id ? { ...m, can_self_approve: !next } : m)));
      loadMappings();
    }
  };

  const pmConfigs = adSyncConfigs.filter((c) => c.pm_enabled);

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Password Management</h2>

      {/* Sub-tab nav */}
      <div className="tabs mb-4">
        {(["roles", "mappings", "requests"] as SubTab[]).map((t) => (
          <button
            key={t}
            className={`tab ${subTab === t ? "tab-active" : ""}`}
            onClick={() => setSubTab(t)}
          >
            {t === "roles"
              ? "Approval Roles"
              : t === "mappings"
                ? "Account Mappings"
                : "Checkout Requests"}
          </button>
        ))}
      </div>

      {/* ── Approval Roles ── */}
      {subTab === "roles" && (
        <div>
          <div className="card p-4 mb-4">
            <h3 className="font-medium mb-1">Create Approval Role</h3>
            <p className="text-txt-secondary text-xs mb-3">
              An approval role links a set of discovered managed AD accounts to Strata users who can
              approve checkout requests for those accounts.
            </p>
            <div className="grid grid-cols-2 gap-4 mb-2">
              <input
                className="input"
                placeholder="Role name"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
              />
              <input
                className="input"
                placeholder="Description (optional)"
                value={newRoleDesc}
                onChange={(e) => setNewRoleDesc(e.target.value)}
              />
            </div>
            <button className="btn btn-primary btn-sm" onClick={handleCreateRole}>
              Create Role
            </button>
          </div>

          {roles.map((role) => (
            <div
              key={role.id}
              className={`card p-4 mb-3 ${expandedRole === role.id ? "!overflow-visible" : ""}`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{role.name}</span>
                  {role.description && (
                    <span className="text-txt-secondary ml-2 text-sm">{role.description}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      if (expandedRole === role.id) {
                        setExpandedRole(null);
                      } else {
                        setExpandedRole(role.id);
                        setSelectedUsers((roleAssignments[role.id] || []).map((a) => a.id));
                        setSelectedAccounts(roleAccountScopes[role.id] || []);
                        setScopeSearch("");
                        setApproverSearch("");
                      }
                    }}
                  >
                    {expandedRole === role.id ? "Collapse" : "Configure"}
                  </button>
                  <button
                    className="btn btn-sm btn-secondary text-danger"
                    onClick={() => handleDeleteRole(role.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {expandedRole === role.id && (
                <div className="mt-4 border-t border-border/10 pt-4 space-y-6">
                  {/* Section 1: Managed Account Scope — which discovered accounts this role covers */}
                  <div>
                    <h4 className="text-sm font-semibold mb-1">Managed Account Scope</h4>
                    <p className="text-txt-secondary text-xs mb-2">
                      Select which managed accounts this role&apos;s approvers can approve checkout
                      requests for. Only accounts that have been discovered and mapped to users are
                      shown.
                    </p>
                    {(() => {
                      const uniqueDns = [...new Set(mappings.map((m) => m.managed_ad_dn))].sort();
                      const originalScope = roleAccountScopes[role.id] || [];
                      const hasScopeChanged =
                        selectedAccounts.length !== originalScope.length ||
                        !selectedAccounts.every((d) => originalScope.includes(d));
                      if (uniqueDns.length === 0) {
                        return (
                          <p className="text-txt-secondary text-xs italic">
                            No managed accounts found. Map accounts to users in the Account Mappings
                            tab first.
                          </p>
                        );
                      }

                      // Helper: extract CN display name from a DN
                      const cnFromDn = (dn: string) => {
                        const m = dn.match(/^CN=((?:\\.|[^,])+)/i);
                        return m ? m[1].replace(/\\(.)/g, "$1") : dn;
                      };

                      // Available = not yet selected
                      const available = uniqueDns.filter((dn) => !selectedAccounts.includes(dn));
                      const q = scopeSearch.toLowerCase();
                      const filtered = q
                        ? available.filter((dn) => dn.toLowerCase().includes(q))
                        : available;

                      return (
                        <>
                          {/* Selected accounts as removable chips */}
                          {selectedAccounts.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-2">
                              {selectedAccounts.map((dn) => (
                                <span
                                  key={dn}
                                  className="inline-flex items-center gap-1 bg-primary/20 text-primary text-xs rounded-full px-2.5 py-1"
                                  title={dn}
                                >
                                  {(() => {
                                    const m = mappings.find((map) => map.managed_ad_dn === dn);
                                    return m?.friendly_name || cnFromDn(dn);
                                  })()}
                                  <button
                                    className="hover:text-red-400 ml-0.5 font-bold leading-none"
                                    onClick={() =>
                                      setSelectedAccounts(selectedAccounts.filter((d) => d !== dn))
                                    }
                                    aria-label={`Remove ${cnFromDn(dn)}`}
                                  >
                                    &times;
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}

                          {/* Search + dropdown to add accounts */}
                          <div className="relative mb-2">
                            <input
                              type="text"
                              className="input input-sm w-full"
                              placeholder={`Search ${available.length} available account${available.length !== 1 ? "s" : ""}...`}
                              value={scopeSearch}
                              onChange={(e) => setScopeSearch(e.target.value)}
                            />
                            {scopeSearch && filtered.length > 0 && (
                              <div
                                className="absolute z-10 mt-1 w-full rounded-md shadow-lg max-h-64 overflow-y-auto p-1"
                                style={{
                                  background: "var(--color-surface-elevated)",
                                  border: "1px solid var(--color-glass-border)",
                                }}
                              >
                                {filtered.slice(0, 50).map((dn) => (
                                  <button
                                    key={dn}
                                    className="cs-option w-full text-left flex items-center justify-between gap-2"
                                    onClick={() => {
                                      setSelectedAccounts([...selectedAccounts, dn]);
                                      setScopeSearch("");
                                    }}
                                  >
                                    <span style={{ color: "var(--color-txt-primary)" }}>
                                      {(() => {
                                        const m = mappings.find((map) => map.managed_ad_dn === dn);
                                        return m?.friendly_name || cnFromDn(dn);
                                      })()}
                                    </span>
                                    <span
                                      className="text-xs truncate"
                                      style={{ color: "var(--color-txt-tertiary)" }}
                                    >
                                      {dn}
                                    </span>
                                  </button>
                                ))}
                                {filtered.length > 50 && (
                                  <div
                                    className="px-3 py-2 text-xs italic"
                                    style={{ color: "var(--color-txt-tertiary)" }}
                                  >
                                    {filtered.length - 50} more — refine your search
                                  </div>
                                )}
                              </div>
                            )}
                            {scopeSearch && filtered.length === 0 && (
                              <div
                                className="absolute z-10 mt-1 w-full rounded-md shadow-lg px-3 py-2 text-sm italic"
                                style={{
                                  background: "var(--color-surface-elevated)",
                                  border: "1px solid var(--color-glass-border)",
                                  color: "var(--color-txt-tertiary)",
                                }}
                              >
                                No matching accounts
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              className={`btn btn-sm ${hasScopeChanged ? "!bg-warning !text-black !border-warning hover:opacity-90" : "btn-primary"}`}
                              onClick={() => handleSaveAccounts(role.id)}
                            >
                              Save Scope
                            </button>
                            <span className="text-txt-secondary text-xs">
                              {selectedAccounts.length} of {uniqueDns.length} accounts selected
                            </span>
                          </div>
                        </>
                      );
                    })()}
                  </div>

                  {/* Section 2: Approvers — Strata users who can approve/deny requests */}
                  <div>
                    <h4 className="text-sm font-semibold mb-1">Approvers</h4>
                    <p className="text-txt-secondary text-xs mb-2">
                      Strata users who can approve or deny checkout requests for the accounts
                      selected above. These users will see matching requests on their Pending
                      Approvals page.
                    </p>
                    {(() => {
                      const availableUsers = users.filter((u) => !selectedUsers.includes(u.id));
                      const originalUsers = (roleAssignments[role.id] || []).map((a) => a.id);
                      const hasApproversChanged =
                        selectedUsers.length !== originalUsers.length ||
                        !selectedUsers.every((id) => originalUsers.includes(id));
                      const aq = approverSearch.toLowerCase();
                      const filteredUsers = aq
                        ? availableUsers.filter(
                            (u) =>
                              u.username.toLowerCase().includes(aq) ||
                              (u.email && u.email.toLowerCase().includes(aq))
                          )
                        : availableUsers;

                      return (
                        <>
                          {/* Selected approvers as removable chips */}
                          {selectedUsers.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-2">
                              {selectedUsers.map((uid) => {
                                const u = users.find((x) => x.id === uid);
                                return (
                                  <span
                                    key={uid}
                                    className="inline-flex items-center gap-1 bg-primary/20 text-primary text-xs rounded-full px-2.5 py-1"
                                  >
                                    {u?.username || uid}
                                    <button
                                      className="hover:text-red-400 ml-0.5 font-bold leading-none"
                                      onClick={() =>
                                        setSelectedUsers(selectedUsers.filter((id) => id !== uid))
                                      }
                                      aria-label={`Remove ${u?.username || uid}`}
                                    >
                                      &times;
                                    </button>
                                  </span>
                                );
                              })}
                            </div>
                          )}

                          {/* Search + dropdown to add approvers */}
                          <div className="relative mb-2">
                            <input
                              type="text"
                              className="input input-sm w-full"
                              placeholder={`Search ${availableUsers.length} available user${availableUsers.length !== 1 ? "s" : ""}...`}
                              value={approverSearch}
                              onChange={(e) => setApproverSearch(e.target.value)}
                            />
                            {approverSearch && filteredUsers.length > 0 && (
                              <div
                                className="absolute z-10 mt-1 w-full rounded-md shadow-lg max-h-64 overflow-y-auto p-1"
                                style={{
                                  background: "var(--color-surface-elevated)",
                                  border: "1px solid var(--color-glass-border)",
                                }}
                              >
                                {filteredUsers.slice(0, 50).map((u) => (
                                  <button
                                    key={u.id}
                                    className="cs-option w-full text-left flex items-center justify-between gap-2"
                                    onClick={() => {
                                      setSelectedUsers([...selectedUsers, u.id]);
                                      setApproverSearch("");
                                    }}
                                  >
                                    <span style={{ color: "var(--color-txt-primary)" }}>
                                      {u.username}
                                    </span>
                                    {u.email && u.email !== u.username && (
                                      <span
                                        className="text-xs truncate"
                                        style={{ color: "var(--color-txt-tertiary)" }}
                                      >
                                        {u.email}
                                      </span>
                                    )}
                                  </button>
                                ))}
                                {filteredUsers.length > 50 && (
                                  <div
                                    className="px-3 py-2 text-xs italic"
                                    style={{ color: "var(--color-txt-tertiary)" }}
                                  >
                                    {filteredUsers.length - 50} more — refine your search
                                  </div>
                                )}
                              </div>
                            )}
                            {approverSearch && filteredUsers.length === 0 && (
                              <div
                                className="absolute z-10 mt-1 w-full rounded-md shadow-lg px-3 py-2 text-sm italic"
                                style={{
                                  background: "var(--color-surface-elevated)",
                                  border: "1px solid var(--color-glass-border)",
                                  color: "var(--color-txt-tertiary)",
                                }}
                              >
                                No matching users
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              className={`btn btn-sm ${hasApproversChanged ? "!bg-warning !text-black !border-warning hover:opacity-90" : "btn-primary"}`}
                              onClick={() => handleSaveAssignments(role.id)}
                            >
                              Save Approvers
                            </button>
                            <span className="text-txt-secondary text-xs">
                              {selectedUsers.length} of {users.length} users selected
                            </span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          ))}

          {roles.length === 0 && (
            <p className="text-txt-secondary text-sm">No approval roles defined yet.</p>
          )}
        </div>
      )}

      {/* ── Account Mappings ── */}
      {subTab === "mappings" && (
        <div>
          {pmConfigs.length === 0 ? (
            <div className="card p-6 text-center">
              <p className="text-txt-secondary text-sm">
                No PM-enabled AD Sync sources. Enable Password Management on an AD Sync source
                first.
              </p>
            </div>
          ) : (
            <>
              {/* Create mapping */}
              <div className="card p-4 mb-4">
                <h3 className="font-medium mb-3">Create Account Mapping</h3>

                {/* Step 1: Select AD Source */}
                <div className="grid grid-cols-2 gap-4 mb-3">
                  <div>
                    <span className="text-xs font-medium block mb-1">AD Source</span>
                    <Select
                      value={newMapping.ad_sync_config_id}
                      onChange={(configId) => {
                        setNewMapping({
                          ...newMapping,
                          ad_sync_config_id: configId,
                          managed_ad_dn: "",
                        });
                        if (configId) {
                          setLoadingUnmapped(true);
                          getUnmappedAccounts(configId)
                            .then(setUnmapped)
                            .catch(() => setUnmapped([]))
                            .finally(() => setLoadingUnmapped(false));
                        } else {
                          setUnmapped([]);
                        }
                      }}
                      placeholder="Select PM-enabled AD source..."
                      options={pmConfigs.map((c) => ({ value: c.id, label: c.label }))}
                    />
                  </div>

                  {/* Step 2: Select Strata user */}
                  <div>
                    <span className="text-xs font-medium block mb-1">Strata User</span>
                    <Select
                      value={newMapping.user_id}
                      onChange={(val) => setNewMapping({ ...newMapping, user_id: val })}
                      placeholder="Select user..."
                      options={users.map((u) => ({ value: u.id, label: u.username }))}
                      searchable={true}
                    />
                  </div>
                </div>

                {/* Step 3: Select discovered AD account */}
                <div className="mb-3">
                  <span className="text-xs font-medium block mb-1">
                    Managed AD Account
                    {loadingUnmapped && (
                      <span className="ml-2 text-txt-secondary">(discovering...)</span>
                    )}
                  </span>
                  {newMapping.ad_sync_config_id && unmapped.length > 0 ? (
                    <Select
                      value={newMapping.managed_ad_dn}
                      onChange={(val) => setNewMapping({ ...newMapping, managed_ad_dn: val })}
                      placeholder="Select discovered account..."
                      options={unmapped.map((a) => ({
                        value: a.dn,
                        label: a.friendly_name || `${a.name} — ${a.dn}`,
                      }))}
                      searchable={true}
                    />
                  ) : (
                    <input
                      className="input w-full"
                      placeholder={
                        newMapping.ad_sync_config_id
                          ? loadingUnmapped
                            ? "Discovering accounts..."
                            : "No unmapped accounts found — type DN manually"
                          : "Select an AD source first, or type DN manually"
                      }
                      value={newMapping.managed_ad_dn}
                      onChange={(e) =>
                        setNewMapping({ ...newMapping, managed_ad_dn: e.target.value })
                      }
                    />
                  )}
                </div>

                <div className="flex items-center gap-4 mb-3">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={newMapping.can_self_approve}
                      onChange={(e) =>
                        setNewMapping({ ...newMapping, can_self_approve: e.target.checked })
                      }
                    />
                    Can self-approve
                  </label>
                </div>

                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleCreateMapping}
                  disabled={!newMapping.user_id || !newMapping.managed_ad_dn}
                >
                  Create Mapping
                </button>
              </div>

              {/* Existing mappings */}
              <div className="card p-4">
                <h3 className="font-medium mb-2">Existing Mappings</h3>
                {mappings.length === 0 ? (
                  <p className="text-txt-secondary text-sm">No account mappings.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/10">
                        <th className="text-left py-1">User</th>
                        <th className="text-left py-1">Managed AD DN</th>
                        <th className="text-left py-1">AD Source</th>
                        <th className="text-left py-1">Self-Approve</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {mappings.map((m) => (
                        <tr key={m.id} className="border-b border-border/5">
                          <td className="py-1">
                            {users.find((u) => u.id === m.user_id)?.username || m.user_id}
                          </td>
                          <td className="py-1">
                            <div className="text-sm font-medium">{m.friendly_name || "—"}</div>
                            <div
                              className="text-[10px] text-txt-tertiary font-mono truncate max-w-[300px]"
                              title={m.managed_ad_dn}
                            >
                              {m.managed_ad_dn}
                            </div>
                          </td>
                          <td className="py-1 text-xs text-txt-secondary">
                            {m.ad_sync_config_id
                              ? adSyncConfigs.find((c) => c.id === m.ad_sync_config_id)?.label ||
                                "—"
                              : "—"}
                          </td>
                          <td className="py-1">
                            <div className="w-24">
                              <Select
                                value={m.can_self_approve ? "yes" : "no"}
                                onChange={(v) => handleToggleSelfApprove(m.id, v === "yes")}
                                options={[
                                  { value: "yes", label: "Yes" },
                                  { value: "no", label: "No" },
                                ]}
                                className="w-24"
                              />
                            </div>
                          </td>
                          <td className="py-1">
                            <button
                              className="text-danger text-xs"
                              onClick={() => handleDeleteMapping(m.id)}
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Checkout Requests ── */}
      {subTab === "requests" && (
        <div>
          <button className="btn btn-sm mb-4" onClick={loadRequests}>
            Refresh
          </button>
          {requests.length === 0 ? (
            <p className="text-txt-secondary text-sm">No checkout requests.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/10">
                  <th className="text-left py-1">DN</th>
                  <th className="text-left py-1">Status</th>
                  <th className="text-left py-1">Duration</th>
                  <th className="text-left py-1">Requester</th>
                  <th className="text-left py-1">Decided By</th>
                  <th className="text-left py-1">Justification</th>
                  <th className="text-left py-1">Expires</th>
                  <th className="text-left py-1">Created</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-border/5">
                    <td className="py-1">
                      <div className="text-sm font-medium">
                        {r.friendly_name || parseDN(r.managed_ad_dn)}
                      </div>
                      <div
                        className="text-[10px] text-txt-tertiary font-mono truncate max-w-[200px]"
                        title={r.managed_ad_dn}
                      >
                        {r.managed_ad_dn}
                      </div>
                    </td>
                    <td className="py-1">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded ${
                          r.status === "Active"
                            ? "bg-success/20 text-success"
                            : r.status === "Pending"
                              ? "bg-warning/20 text-warning"
                              : r.status === "Denied"
                                ? "bg-danger/20 text-danger"
                                : "bg-border/20 text-txt-secondary"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="py-1">{r.requested_duration_mins}m</td>
                    <td className="py-1">
                      {users.find((u) => u.id === r.requester_user_id)?.username ||
                        r.requester_user_id}
                    </td>
                    <td className="py-1 text-xs">
                      {r.approved_by_user_id
                        ? r.approved_by_user_id === r.requester_user_id
                          ? "Self Approved"
                          : users.find((u) => u.id === r.approved_by_user_id)?.username ||
                            r.approved_by_user_id
                        : "—"}
                    </td>
                    <td className="py-1 text-xs max-w-[260px]">
                      {r.justification_comment ? (
                        <div
                          className="truncate text-txt-secondary"
                          title={r.justification_comment}
                        >
                          {r.justification_comment}
                        </div>
                      ) : (
                        <span className="text-txt-tertiary">—</span>
                      )}
                    </td>
                    <td className="py-1 text-xs">
                      {r.expires_at ? formatDateTime(r.expires_at) : "—"}
                    </td>
                    <td className="py-1 text-xs">
                      {r.created_at ? formatDateTime(r.created_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
