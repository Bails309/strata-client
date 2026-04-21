import { useEffect, useState, useCallback, useRef } from "react";
import { getTimezones } from "../utils/time";
import { useSettings } from "../contexts/SettingsContext";
import Select from "../components/Select";
import ConfirmModal from "../components/ConfirmModal";
import {
  getSettings,
  updateSettings,
  updateSso,
  getKerberosRealms,
  createKerberosRealm,
  updateKerberosRealm,
  deleteKerberosRealm,
  KerberosRealm,
  updateRecordings,
  updateVault,
  updateDns,
  updateAuthMethods,
  getServiceHealth,
  getMetrics,
  getRoles,
  createRole,
  updateRole,
  deleteRole,
  deleteConnection,
  getConnectionFolders,
  createConnectionFolder,
  updateConnectionFolder as _updateConnectionFolder,
  deleteConnectionFolder,
  getConnections,
  createConnection,
  updateConnection,
  getRoleMappings,
  updateRoleMappings,
  getUsers,
  createUser,
  deleteUser,
  updateUser,
  restoreUser,
  getAdSyncConfigs,
  createAdSyncConfig,
  updateAdSyncConfig,
  deleteAdSyncConfig,
  triggerAdSync,
  testAdSyncConnection,
  testPmTargetFilter,
  testSsoConnection,
  getAdSyncRuns,
  AdSyncConfig,
  AdSyncRun,
  Role,
  Connection,
  ConnectionFolder,
  User,
  ServiceHealth,
  MetricsSummary,
  MeResponse,
  getSessionStats,
  SessionStats,
  UserTag,
  getAdminTagsAdmin,
  createAdminTag,
  updateAdminTag,
  deleteAdminTag,
  getAdminConnectionTagsAdmin,
  setAdminConnectionTags,
  getApprovalRoles,
  createApprovalRole,
  deleteApprovalRole,
  getRoleAssignments,
  setRoleAssignments as apiSetRoleAssignments,
  getRoleAccounts,
  setRoleAccounts,
  getAccountMappings,
  createAccountMapping,
  deleteAccountMapping,
  updateAccountMapping,
  getUnmappedAccounts,
  testRotation,
  getCheckoutRequests,
  ApprovalRole,
  UserAccountMapping,
  CheckoutRequest,
  DiscoveredAccount,
} from "../api";
import { formatDateTime } from "../utils/time";

type Tab =
  | "health"
  | "display"
  | "network"
  | "sso"
  | "kerberos"
  | "vault"
  | "recordings"
  | "access"
  | "tags"
  | "ad-sync"
  | "passwords"
  | "sessions"
  | "security";

// ── RDP keyboard layout options (shared between the RDP form and the AD Sync
// connection defaults) ─────────────────────────────────────────────────────
const RDP_KEYBOARD_LAYOUTS: { value: string; label: string }[] = [
  { value: "", label: "Default (US English)" },
  { value: "en-us-qwerty", label: "US English (Qwerty)" },
  { value: "en-gb-qwerty", label: "UK English (Qwerty)" },
  { value: "de-de-qwertz", label: "German (Qwertz)" },
  { value: "de-ch-qwertz", label: "Swiss German (Qwertz)" },
  { value: "fr-fr-azerty", label: "French (Azerty)" },
  { value: "fr-ch-qwertz", label: "Swiss French (Qwertz)" },
  { value: "fr-be-azerty", label: "Belgian French (Azerty)" },
  { value: "it-it-qwerty", label: "Italian (Qwerty)" },
  { value: "es-es-qwerty", label: "Spanish (Qwerty)" },
  { value: "es-latam-qwerty", label: "Latin American (Qwerty)" },
  { value: "pt-br-qwerty", label: "Brazilian Portuguese (Qwerty)" },
  { value: "pt-pt-qwerty", label: "Portuguese (Qwerty)" },
  { value: "sv-se-qwerty", label: "Swedish (Qwerty)" },
  { value: "da-dk-qwerty", label: "Danish (Qwerty)" },
  { value: "no-no-qwerty", label: "Norwegian (Qwerty)" },
  { value: "fi-fi-qwerty", label: "Finnish (Qwerty)" },
  { value: "hu-hu-qwertz", label: "Hungarian (Qwertz)" },
  { value: "ja-jp-qwerty", label: "Japanese (Qwerty)" },
  { value: "tr-tr-qwerty", label: "Turkish-Q (Qwerty)" },
  { value: "failsafe", label: "Failsafe (Unicode events)" },
];

export default function AdminSettings({ user }: { user: MeResponse }) {
  const [tab, setTab] = useState<Tab>(
    user.can_manage_system
      ? "health"
      : user.can_manage_users ||
          user.can_manage_connections ||
          user.can_create_users ||
          user.can_create_user_groups ||
          user.can_create_connections ||
          user.can_create_connection_folders ||
          user.can_create_sharing_profiles
        ? "access"
        : user.can_view_audit_logs
          ? "sessions"
          : "health"
  );
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Role[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [folders, setFolders] = useState<ConnectionFolder[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [adSyncConfigs, setAdSyncConfigs] = useState<AdSyncConfig[]>([]);
  const [msg, setMsg] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    setLoadError("");
    Promise.all([
      getSettings().then(setSettings),
      getRoles().then(setRoles),
      getConnections().then(setConnections),
      getConnectionFolders().then(setFolders),
      getUsers().then(setUsers),
      getAdSyncConfigs()
        .then(setAdSyncConfigs)
        .catch(() => {}),
    ]).catch(() => setLoadError("Failed to load settings"));
  }, []);

  function flash(text: string) {
    setMsg(text);
    setTimeout(() => setMsg(""), 3000);
  }

  return (
    <div>
      <h1>Admin Settings</h1>

      {msg && <div className="rounded-md mb-4 px-4 py-2 bg-success-dim text-success">{msg}</div>}

      {loadError && (
        <div className="rounded-md mb-4 px-4 py-2 bg-danger/10 text-danger">{loadError}</div>
      )}

      <div className="tabs">
        {(
          [
            "health",
            "display",
            "network",
            "sso",
            "kerberos",
            "vault",
            "recordings",
            "access",
            "tags",
            "ad-sync",
            "passwords",
            "sessions",
            "security",
          ] as Tab[]
        )
          .filter((t) => {
            if (t === "access")
              return (
                user.can_manage_system ||
                user.can_manage_users ||
                user.can_manage_connections ||
                user.can_create_users ||
                user.can_create_user_groups ||
                user.can_create_connections ||
                user.can_create_connection_folders ||
                user.can_create_sharing_profiles
              );
            if (t === "tags") return user.can_manage_system || user.can_manage_connections;
            if (t === "sessions") return user.can_manage_system || user.can_view_audit_logs;
            // All other tabs are system management
            return user.can_manage_system;
          })
          .map((t) => (
            <button
              key={t}
              className={`tab ${tab === t ? "tab-active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "sso"
                ? "SSO / OIDC"
                : t === "ad-sync"
                  ? "AD Sync"
                  : t === "passwords"
                    ? "Password Mgmt"
                    : t === "sessions"
                      ? "Sessions"
                      : t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
      </div>

      {/* ── Health ── */}
      {tab === "health" && <HealthTab onNavigateVault={() => setTab("vault")} />}

      {/* ── Display ── */}
      {tab === "display" && (
        <DisplayTab
          settings={settings}
          onSave={() => {
            flash("Display settings updated");
            getSettings()
              .then(setSettings)
              .catch(() => {});
          }}
        />
      )}

      {/* ── Network / DNS ── */}
      {tab === "network" && (
        <NetworkTab
          settings={settings}
          onSave={() => {
            flash("Network settings updated");
            getSettings()
              .then(setSettings)
              .catch(() => {});
          }}
        />
      )}

      {/* ── SSO ── */}
      {tab === "sso" && <SsoTab settings={settings} onSave={() => flash("SSO updated")} />}

      {/* ── Kerberos ── */}
      {tab === "kerberos" && <KerberosTab onSave={() => flash("Kerberos updated")} />}

      {/* ── Recordings ── */}
      {tab === "recordings" && (
        <RecordingsTab settings={settings} onSave={() => flash("Recordings updated")} />
      )}

      {/* ── Vault ── */}
      {tab === "vault" && (
        <VaultTab
          settings={settings}
          onSave={() => {
            flash("Vault updated");
            getSettings()
              .then(setSettings)
              .catch(() => {});
          }}
        />
      )}

      {/* ── Access Control ── */}
      {tab === "access" && (
        <AccessTab
          user={user}
          roles={roles}
          connections={connections}
          folders={folders}
          users={users}
          onRolesChanged={setRoles}
          onConnectionCreated={(c) => setConnections([...connections, c])}
          onConnectionUpdated={(c) =>
            setConnections(connections.map((x) => (x.id === c.id ? c : x)))
          }
          onConnectionDeleted={(id) => setConnections(connections.filter((x) => x.id !== id))}
          onFoldersChanged={(f) => setFolders(f)}
          onUsersChanged={(u) => setUsers(u)}
        />
      )}

      {/* ── Tags ── */}
      {tab === "tags" && <TagsTab connections={connections} onSave={() => flash("Tags updated")} />}

      {/* ── AD Sync ── */}
      {tab === "ad-sync" && <AdSyncTab folders={folders} onSave={() => flash("AD Sync updated")} />}

      {/* ── Password Management ── */}
      {tab === "passwords" && (
        <PasswordsTab
          users={users}
          adSyncConfigs={adSyncConfigs}
          onSave={() => flash("Password management updated")}
        />
      )}

      {/* ── Active Sessions (NVR) ── */}
      {tab === "sessions" && <SessionsTab />}

      {/* ── Security ── */}
      {tab === "security" && (
        <SecurityTab
          settings={settings}
          onSave={() => {
            flash("Security settings updated");
            getSettings()
              .then(setSettings)
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}

// ── Sub-tabs ─────────────────────────────────────────────────────────

function HealthTab({ onNavigateVault }: { onNavigateVault: () => void }) {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(60);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([getServiceHealth().catch(() => null), getMetrics().catch(() => null)])
      .then(([h, m]) => {
        setHealth(h);
        setMetrics(m);
        setLastChecked(new Date());
        setCountdown(60);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh countdown
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          refresh();
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  function formatUptime(secs: number): string {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    return `${h}h ${m}m`;
  }

  if (loading && !health) {
    return (
      <div className="card">
        <p className="text-txt-secondary">Loading service health...</p>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="card">
        <p className="text-danger">Failed to load service health.</p>
        <button className="btn mt-3" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  const iconStyle = (color: string) => ({
    width: 40,
    height: 40,
    borderRadius: 10,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    background: `${color}18`,
    color,
    flexShrink: 0 as const,
  });

  return (
    <div className="grid gap-5">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="!mb-1 text-xl font-bold">System Health</h1>
          <p className="text-txt-tertiary text-sm italic">
            Real-time status and diagnostics for core infrastructure.
          </p>
        </div>
        <button
          className="shrink-0 flex items-center gap-2 text-xs rounded-lg px-3 py-2"
          style={{
            background: "var(--color-surface-tertiary)",
            border: "1px solid var(--color-glass-border)",
            color: "var(--color-txt-secondary)",
          }}
          onClick={refresh}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={loading ? "animate-spin" : ""}
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          Auto-refreshing in {countdown}s
        </button>
      </div>

      {/* Service Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Database */}
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <div className="flex items-center justify-between">
            <div style={iconStyle("#8b5cf6")}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
                <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
              </svg>
            </div>
            <span
              className={`badge ${health.database.connected ? "badge-success" : "badge-error"}`}
            >
              {health.database.connected ? "Healthy" : "Unhealthy"}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-0.5">Database</h3>
            <p className="text-xs text-txt-tertiary">PostgreSQL Persistence Layer</p>
          </div>
          <div className="mt-auto space-y-2 text-xs">
            {health.database.latency_ms != null && (
              <div className="flex justify-between">
                <span className="text-txt-tertiary">Latency</span>
                <span className="font-semibold text-txt-primary">
                  {health.database.latency_ms}ms
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Mode</span>
              <span className="font-semibold text-txt-primary capitalize">
                {health.database.mode}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Host</span>
              <span
                className="font-mono text-txt-secondary text-[0.65rem] truncate ml-2"
                title={health.database.host}
              >
                {health.database.host}
              </span>
            </div>
          </div>
        </div>

        {/* guacd Gateway */}
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <div className="flex items-center justify-between">
            <div style={iconStyle("#f59e0b")}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <span className={`badge ${health.guacd.reachable ? "badge-success" : "badge-error"}`}>
              {health.guacd.reachable ? "Healthy" : "Unhealthy"}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-0.5">guacd</h3>
            <p className="text-xs text-txt-tertiary">Remote Desktop Gateway</p>
          </div>
          <div className="mt-auto space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Host</span>
              <span className="font-mono text-txt-secondary">{health.guacd.host}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Port</span>
              <span className="font-mono text-txt-secondary">{health.guacd.port}</span>
            </div>
            {metrics && (
              <div className="flex justify-between">
                <span className="text-txt-tertiary">Pool Size</span>
                <span className="font-semibold text-txt-primary">{metrics.guacd_pool_size}</span>
              </div>
            )}
          </div>
        </div>

        {/* Vault */}
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <div className="flex items-center justify-between">
            <div style={iconStyle("#22c55e")}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <span
              className={`badge ${health.vault.configured ? "badge-success" : "badge-warning"}`}
            >
              {health.vault.configured ? "Healthy" : "Not Configured"}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-0.5">Vault</h3>
            <p className="text-xs text-txt-tertiary">Encryption & Secret Management</p>
          </div>
          <div className="mt-auto space-y-2 text-xs">
            {health.vault.configured ? (
              <>
                <div className="flex justify-between">
                  <span className="text-txt-tertiary">Mode</span>
                  <span className="font-semibold text-txt-primary capitalize">
                    {health.vault.mode === "local" ? "Bundled" : "External"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-txt-tertiary">Address</span>
                  <span
                    className="font-mono text-txt-secondary text-[0.65rem] truncate ml-2"
                    title={health.vault.address}
                  >
                    {health.vault.address}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-txt-tertiary">
                Not configured.{" "}
                <button
                  className="text-accent underline bg-transparent border-0 cursor-pointer p-0 text-xs"
                  onClick={onNavigateVault}
                >
                  Set up Vault
                </button>
              </p>
            )}
          </div>
        </div>

        {/* Schema */}
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <div className="flex items-center justify-between">
            <div style={iconStyle("#06b6d4")}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" x2="8" y1="13" y2="13" />
                <line x1="16" x2="8" y1="17" y2="17" />
                <line x1="10" x2="8" y1="9" y2="9" />
              </svg>
            </div>
            <span
              className={`badge ${health.schema.status === "in_sync" ? "badge-success" : health.schema.status === "unavailable" ? "badge-warning" : "badge-error"}`}
            >
              {health.schema.status === "in_sync"
                ? "Healthy"
                : health.schema.status === "unavailable"
                  ? "Unavailable"
                  : "Out of Sync"}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-0.5">Schema</h3>
            <p className="text-xs text-txt-tertiary">Database Migrations</p>
          </div>
          <div className="mt-auto space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Status</span>
              <span className="font-semibold text-txt-primary">
                {health.schema.status === "in_sync"
                  ? "In Sync"
                  : health.schema.status === "unavailable"
                    ? "Unavailable"
                    : "Out of Sync"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Applied</span>
              <span className="font-mono text-txt-secondary">
                {health.schema.applied_migrations}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Expected</span>
              <span className="font-mono text-txt-secondary">
                {health.schema.expected_migrations}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={iconStyle("#8b5cf6")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Uptime
            </p>
            <p className="text-sm font-bold text-txt-primary">{formatUptime(health.uptime_secs)}</p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={iconStyle("#f59e0b")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="7" height="7" x="3" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="14" rx="1" />
              <rect width="7" height="7" x="3" y="14" rx="1" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Active Sessions
            </p>
            <p className="text-sm font-bold text-txt-primary">{metrics?.active_sessions ?? 0}</p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={iconStyle("#ef4444")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Strata Version
            </p>
            <p className="text-sm font-bold text-txt-primary">v{__APP_VERSION__}</p>
            {health.version && health.version !== __APP_VERSION__ && (
              <p className="text-[0.6rem] text-yellow-400">Backend: v{health.version}</p>
            )}
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={iconStyle("#22c55e")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Environment
            </p>
            <p className="text-sm font-bold text-txt-primary uppercase">{health.environment}</p>
          </div>
        </div>
      </div>

      {/* Last Checked */}
      {lastChecked && (
        <p className="text-right text-[0.65rem] text-txt-tertiary">
          Last Checked: {lastChecked.toLocaleDateString("en-GB")},{" "}
          {lastChecked.toLocaleTimeString("en-GB")}
        </p>
      )}
    </div>
  );
}

function SsoTab({ settings, onSave }: { settings: Record<string, string>; onSave: () => void }) {
  const [issuer, setIssuer] = useState(settings.sso_issuer_url || "");
  const [clientId, setClientId] = useState(settings.sso_client_id || "");
  const [clientSecret, setClientSecret] = useState(settings.sso_client_secret || "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  useEffect(() => {
    setIssuer(settings.sso_issuer_url || "");
    setClientId(settings.sso_client_id || "");
    setClientSecret(settings.sso_client_secret || "");
  }, [settings]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testSsoConnection({
        issuer_url: issuer,
        client_id: clientId,
        client_secret: clientSecret,
      });
      setTestResult({ success: res.status === "success", msg: res.message });
    } catch (err: unknown) {
      setTestResult({ success: false, msg: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  const callbackUrl = `${window.location.origin}/api/auth/sso/callback`;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="!mb-0">SSO / OIDC (Keycloak)</h2>
        <div className="flex flex-col items-end">
          <span className="text-[10px] uppercase tracking-wider text-txt-tertiary font-bold mb-1">
            Callback URL
          </span>
          <code className="text-[11px] bg-surface-tertiary px-2 py-1 rounded border border-border font-mono text-accent">
            {callbackUrl}
          </code>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="sso-issuer">Issuer URL</label>
        <input
          id="sso-issuer"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          placeholder="https://keycloak.example.com/realms/strata"
        />
      </div>
      <div className="form-group">
        <label htmlFor="sso-client-id">Client ID</label>
        <input id="sso-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor="sso-client-secret">Client Secret</label>
        <input
          id="sso-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={settings.sso_client_secret ? "********" : ""}
        />
      </div>

      {testResult && (
        <div
          className={`rounded-md mb-4 px-4 py-2 text-sm ${testResult.success ? "bg-success-dim text-success" : "bg-danger-dim text-danger"}`}
        >
          <div className="flex items-center gap-2">
            {testResult.success ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
            {testResult.msg}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          className="btn-primary"
          onClick={async () => {
            await updateSso({
              issuer_url: issuer,
              client_id: clientId,
              client_secret: clientSecret,
            });
            onSave();
          }}
        >
          Save SSO Settings
        </button>
        <button
          className="btn"
          onClick={handleTest}
          disabled={testing || !issuer || !clientId || !clientSecret}
        >
          {testing ? "Testing..." : "Test Connection"}
        </button>
      </div>
    </div>
  );
}

function KerberosTab({ onSave }: { onSave: () => void }) {
  const [realms, setRealms] = useState<KerberosRealm[]>([]);
  const [editing, setEditing] = useState<{
    id?: string;
    realm: string;
    kdcs: string[];
    admin_server: string;
    ticket_lifetime: string;
    renew_lifetime: string;
    is_default: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await getKerberosRealms();
      setRealms(list);
    } catch {
      setError("Failed to load Kerberos realms");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateKdc = (i: number, val: string) => {
    if (!editing) return;
    const next = [...editing.kdcs];
    next[i] = val;
    setEditing({ ...editing, kdcs: next });
  };

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      if (editing.id) {
        await updateKerberosRealm(editing.id, {
          realm: editing.realm,
          kdc_servers: editing.kdcs.filter(Boolean),
          admin_server: editing.admin_server,
          ticket_lifetime: editing.ticket_lifetime,
          renew_lifetime: editing.renew_lifetime,
          is_default: editing.is_default,
        });
      } else {
        if (!editing.realm) {
          setError("Realm name is required");
          setSaving(false);
          return;
        }
        await createKerberosRealm({
          realm: editing.realm,
          kdc_servers: editing.kdcs.filter(Boolean),
          admin_server: editing.admin_server,
          ticket_lifetime: editing.ticket_lifetime,
          renew_lifetime: editing.renew_lifetime,
          is_default: editing.is_default,
        });
      }
      setEditing(null);
      await load();
      onSave();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError("");
    try {
      await deleteKerberosRealm(id);
      await load();
      onSave();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function openNew() {
    setEditing({
      realm: "",
      kdcs: [""],
      admin_server: "",
      ticket_lifetime: "10h",
      renew_lifetime: "7d",
      is_default: realms.length === 0,
    });
  }

  function openEdit(r: KerberosRealm) {
    setEditing({
      id: r.id,
      realm: r.realm,
      kdcs: r.kdc_servers.split(",").filter(Boolean),
      admin_server: r.admin_server,
      ticket_lifetime: r.ticket_lifetime,
      renew_lifetime: r.renew_lifetime,
      is_default: r.is_default,
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="!mb-0">Kerberos Realms</h2>
          <p className="text-txt-secondary text-sm mt-1">
            Configure one or more Active Directory domains / Kerberos realms. Each realm gets its
            own KDC configuration in the shared krb5.conf.
          </p>
        </div>
        <button className="btn-primary" onClick={openNew}>
          <span className="flex items-center gap-2">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Realm
          </span>
        </button>
      </div>

      {error && (
        <div className="rounded-sm mb-4 px-4 py-2 text-[0.8125rem] bg-danger-dim text-danger">
          {error}
        </div>
      )}

      {/* ── Create / Edit form ── */}
      {editing && (
        <div
          className="card mb-4"
          style={{ border: "1px solid var(--color-accent)", boxShadow: "var(--shadow-accent)" }}
        >
          <h3 className="!mb-4">{editing.id ? "Edit Realm" : "New Kerberos Realm"}</h3>
          <div className="form-group">
            <label htmlFor="krb-realm">Realm Name</label>
            <input
              id="krb-realm"
              value={editing.realm}
              onChange={(e) => setEditing({ ...editing, realm: e.target.value })}
              placeholder="EXAMPLE.COM"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>KDC Servers</label>
            {editing.kdcs.map((k, i) => (
              <div key={i} className="flex gap-2 mb-[0.4rem]">
                <input
                  id={`krb-kdc-${i}`}
                  value={k}
                  onChange={(e) => updateKdc(i, e.target.value)}
                  placeholder={`KDC ${i + 1} (e.g. dc${i + 1}.example.com)`}
                />
                {editing.kdcs.length > 1 && (
                  <button
                    type="button"
                    className="btn !w-auto px-[0.7rem] py-[0.4rem] shrink-0"
                    onClick={() =>
                      setEditing({ ...editing, kdcs: editing.kdcs.filter((_, j) => j !== i) })
                    }
                  >
                    X
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="btn !w-auto mt-1 text-[0.8rem]"
              onClick={() => setEditing({ ...editing, kdcs: [...editing.kdcs, ""] })}
            >
              + Add KDC
            </button>
          </div>
          <div className="form-group">
            <label htmlFor="krb-admin">Admin Server</label>
            <input
              id="krb-admin"
              value={editing.admin_server}
              onChange={(e) => setEditing({ ...editing, admin_server: e.target.value })}
              placeholder="dc1.example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="form-group">
              <label htmlFor="krb-ticket">Ticket Lifetime</label>
              <input
                id="krb-ticket"
                value={editing.ticket_lifetime}
                onChange={(e) => setEditing({ ...editing, ticket_lifetime: e.target.value })}
                placeholder="10h"
              />
            </div>
            <div className="form-group">
              <label htmlFor="krb-renew">Renew Lifetime</label>
              <input
                id="krb-renew"
                value={editing.renew_lifetime}
                onChange={(e) => setEditing({ ...editing, renew_lifetime: e.target.value })}
                placeholder="7d"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer !mb-0">
              <input
                type="checkbox"
                className="checkbox"
                checked={editing.is_default}
                onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
              />
              <span className="text-sm">Default realm</span>
            </label>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : editing.id ? "Update Realm" : "Create Realm"}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Realms list ── */}
      {realms.length === 0 && !editing ? (
        <div className="card text-center py-12">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto mb-4 text-txt-tertiary"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20" />
            <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
          </svg>
          <p className="text-txt-secondary text-sm">
            No Kerberos realms configured. Add a realm to enable Kerberos / NLA authentication for
            your connections.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {realms.map((r) => (
            <div key={r.id} className="card !p-0 !overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                    style={{
                      background: "var(--color-accent-dim)",
                      color: "var(--color-accent-light)",
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M2 12h20" />
                      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                    </svg>
                  </div>
                  <div>
                    <span className="font-semibold text-[0.9rem] text-txt-primary">
                      {r.realm.toUpperCase()}
                    </span>
                    {r.is_default && (
                      <span
                        className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{
                          background: "var(--color-accent-dim)",
                          color: "var(--color-accent-light)",
                        }}
                      >
                        Default
                      </span>
                    )}
                    <div className="text-txt-tertiary text-xs mt-0.5">
                      {r.kdc_servers.split(",").filter(Boolean).length} KDC
                      {r.kdc_servers.split(",").filter(Boolean).length !== 1 ? "s" : ""}
                      {" · "}
                      {r.admin_server || "No admin server"}
                      {" · "}Ticket {r.ticket_lifetime} / Renew {r.renew_lifetime}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn !px-2 !py-1 text-xs" onClick={() => openEdit(r)}>
                    Edit
                  </button>
                  <button
                    className="btn !px-2 !py-1 text-xs text-danger"
                    onClick={() => handleDelete(r.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordingsTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [enabled, setEnabled] = useState(settings.recordings_enabled === "true");
  const [days, setDays] = useState(settings.recordings_retention_days || "30");
  const [storageType, setStorageType] = useState(settings.recordings_storage_type || "local");
  const [azureAccount, setAzureAccount] = useState(settings.recordings_azure_account_name || "");
  const [azureContainer, setAzureContainer] = useState(
    settings.recordings_azure_container_name || "recordings"
  );
  const [azureKey, setAzureKey] = useState(settings.recordings_azure_access_key || "");

  useEffect(() => {
    setEnabled(settings.recordings_enabled === "true");
    setDays(settings.recordings_retention_days || "30");
    setStorageType(settings.recordings_storage_type || "local");
    setAzureAccount(settings.recordings_azure_account_name || "");
    setAzureContainer(settings.recordings_azure_container_name || "recordings");
    setAzureKey(settings.recordings_azure_access_key || "");
  }, [settings]);

  return (
    <div className="card">
      <h2>Session Recordings</h2>
      <div className="form-group">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="checkbox"
          />
          Enable session recording
        </label>
      </div>
      <div className="form-group">
        <label>Retention (days)</label>
        <input type="number" value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Storage Backend</label>
        <Select
          value={storageType}
          onChange={(v) => setStorageType(v)}
          options={[
            { value: "local", label: "Local (Docker Volume)" },
            { value: "azure_blob", label: "Azure Blob Storage" },
          ]}
        />
      </div>
      {storageType === "azure_blob" && (
        <>
          <div className="form-group">
            <label>Account Name</label>
            <input
              value={azureAccount}
              onChange={(e) => setAzureAccount(e.target.value)}
              placeholder="mystorageaccount"
            />
          </div>
          <div className="form-group">
            <label>Container Name</label>
            <input
              value={azureContainer}
              onChange={(e) => setAzureContainer(e.target.value)}
              placeholder="recordings"
            />
          </div>
          <div className="form-group">
            <label>Access Key</label>
            <input
              type="password"
              value={azureKey}
              onChange={(e) => setAzureKey(e.target.value)}
              placeholder="Base64-encoded storage account key"
            />
          </div>
        </>
      )}
      <button
        className="btn-primary"
        onClick={async () => {
          await updateRecordings({
            enabled,
            retention_days: parseInt(days),
            storage_type: storageType,
            azure_account_name: storageType === "azure_blob" ? azureAccount : undefined,
            azure_container_name: storageType === "azure_blob" ? azureContainer : undefined,
            azure_access_key: storageType === "azure_blob" ? azureKey : undefined,
          });
          onSave();
        }}
      >
        Save Recording Settings
      </button>
    </div>
  );
}

function VaultTab({ settings, onSave }: { settings: Record<string, string>; onSave: () => void }) {
  const [mode, setMode] = useState<"local" | "external">("local");
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [transitKey, setTransitKey] = useState("guac-master-key");
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [saving, setSaving] = useState(false);
  const [credTtl, setCredTtl] = useState(12);
  const [ttlSaving, setTtlSaving] = useState(false);

  useEffect(() => {
    getServiceHealth()
      .then((h) => {
        setHealth(h);
        if (h.vault.configured) {
          setMode(h.vault.mode === "local" ? "local" : "external");
          setAddress(h.vault.address);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const v = parseInt(settings.credential_ttl_hours || "12", 10);
    setCredTtl(Math.max(1, Math.min(12, isNaN(v) ? 12 : v)));
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    try {
      if (mode === "local") {
        await updateVault({ mode: "local", transit_key: transitKey });
      } else {
        await updateVault({ mode: "external", address, token, transit_key: transitKey });
      }
      onSave();
    } catch {
      // handled by caller
    } finally {
      setSaving(false);
    }
  }

  const currentMode =
    health?.vault.mode === "local"
      ? "Bundled"
      : health?.vault.mode === "external"
        ? "External"
        : null;

  return (
    <div className="card">
      <h2>Vault Configuration</h2>
      {currentMode && (
        <p className="text-txt-secondary text-sm mb-4">
          Currently using <strong>{currentMode}</strong> vault at{" "}
          <code className="bg-surface-tertiary px-1.5 py-0.5 rounded text-xs">
            {health?.vault.address}
          </code>
          .
        </p>
      )}

      <div className="form-group">
        <label className="text-sm font-medium mb-2 block">Vault Mode</label>
        <div className="flex gap-2">
          <button
            className={`btn flex-1 ${mode === "local" ? "!bg-accent/10 !border-accent !text-accent" : ""}`}
            onClick={() => setMode("local")}
          >
            Bundled
          </button>
          <button
            className={`btn flex-1 ${mode === "external" ? "!bg-accent/10 !border-accent !text-accent" : ""}`}
            onClick={() => setMode("external")}
          >
            External
          </button>
        </div>
      </div>

      {mode === "local" && (
        <p className="text-txt-secondary text-sm mb-4">
          Uses the bundled Vault container. It will be automatically initialized, unsealed, and
          configured.
        </p>
      )}

      {mode === "external" && (
        <>
          <div className="form-group">
            <label>Vault URL</label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="http://vault:8200"
            />
          </div>
          <div className="form-group">
            <label>Vault Token / AppRole</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="s.xxxxxxxxx"
            />
          </div>
        </>
      )}

      <div className="form-group">
        <label>Transit Key Name</label>
        <input value={transitKey} onChange={(e) => setTransitKey(e.target.value)} />
      </div>

      <button className="btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save Vault Settings"}
      </button>

      {/* ── Credential Password Expiry ── */}
      <div
        style={{
          borderTop: "1px solid var(--color-border)",
          marginTop: "2rem",
          paddingTop: "1.5rem",
        }}
      >
        <h3 className="!mb-1">Credential Password Expiry</h3>
        <p className="text-txt-secondary text-sm mb-4">
          Stored credentials automatically expire after this duration. Users must update their
          password before expired credentials will be used. Maximum allowed TTL is 12 hours.
        </p>
        <div className="form-group">
          <label>Time-to-Live (hours)</label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={12}
              step={1}
              value={credTtl}
              onChange={(e) => setCredTtl(Number(e.target.value))}
              className="flex-1"
              style={{ accentColor: "var(--color-accent)" }}
            />
            <span className="text-txt-primary font-semibold tabular-nums w-10 text-right">
              {credTtl}h
            </span>
          </div>
        </div>
        <button
          className="btn-primary"
          disabled={ttlSaving}
          onClick={async () => {
            setTtlSaving(true);
            try {
              await updateSettings([{ key: "credential_ttl_hours", value: String(credTtl) }]);
              onSave();
            } catch {
              /* ignore */
            } finally {
              setTtlSaving(false);
            }
          }}
        >
          {ttlSaving ? "Saving..." : "Save Expiry Setting"}
        </button>
      </div>
    </div>
  );
}

function AccessTab({
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

// ── Helper: Collapsible Section ─────────────────────────────────────

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border rounded-md mb-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full text-left px-3 py-2 bg-surface-secondary border-0 cursor-pointer font-semibold text-sm text-txt-primary ${open ? "rounded-t-md" : "rounded-md"}`}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && <div className="p-3">{children}</div>}
    </div>
  );
}

// ── Helper: 2-column grid of form fields ────────────────────────────

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-2">{children}</div>;
}

// ── RDP Parameter Sections ──────────────────────────────────────────

function RdpSections({
  extra: _extra,
  setExtra: _setExtra,
  ex,
  setEx,
}: {
  extra: Record<string, string>;
  setExtra: (v: Record<string, string>) => void;
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The security mode to use for the RDP connection. 'Any' allows the server to choose. 'NLA' uses Network Level Authentication. 'TLS' uses TLS encryption. 'RDP' uses standard RDP encryption. 'VMConnect' uses Hyper-V's enhanced session mode.">
              Security Mode
            </label>
            <Select
              value={ex("security") || "any"}
              onChange={(v) => setEx("security", v)}
              options={[
                { value: "any", label: "Any" },
                { value: "nla", label: "NLA" },
                { value: "nla-ext", label: "NLA + Extended" },
                { value: "tls", label: "TLS" },
                { value: "rdp", label: "RDP Encryption" },
                { value: "vmconnect", label: "Hyper-V / VMConnect" },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2 mt-1"
              title="Ignore the certificate returned by the server, even if it cannot be validated. Useful when connecting to servers with self-signed certificates."
            >
              <input
                type="checkbox"
                checked={ex("ignore-cert") === "true"}
                onChange={(e) => setEx("ignore-cert", e.target.checked ? "true" : "false")}
                className="checkbox"
              />
              Ignore server certificate
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Remote Desktop Gateway">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The hostname of the Remote Desktop Gateway to tunnel the RDP connection through.">
              Gateway Hostname
            </label>
            <input
              value={ex("gateway-hostname")}
              onChange={(e) => setEx("gateway-hostname", e.target.value)}
              placeholder="gw.example.com"
              title="The hostname of the Remote Desktop Gateway to tunnel the RDP connection through."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The port of the Remote Desktop Gateway. By default, this is 443.">
              Gateway Port
            </label>
            <input
              type="number"
              value={ex("gateway-port")}
              onChange={(e) => setEx("gateway-port", e.target.value)}
              placeholder="443"
              title="The port of the Remote Desktop Gateway. By default, this is 443."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The domain to use when authenticating with the Remote Desktop Gateway.">
              Gateway Domain
            </label>
            <input
              value={ex("gateway-domain")}
              onChange={(e) => setEx("gateway-domain", e.target.value)}
              title="The domain to use when authenticating with the Remote Desktop Gateway."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The username to use when authenticating with the Remote Desktop Gateway.">
              Gateway Username
            </label>
            <input
              value={ex("gateway-username")}
              onChange={(e) => setEx("gateway-username", e.target.value)}
              title="The username to use when authenticating with the Remote Desktop Gateway."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The password to use when authenticating with the Remote Desktop Gateway.">
              Gateway Password
            </label>
            <input
              type="password"
              value={ex("gateway-password")}
              onChange={(e) => setEx("gateway-password", e.target.value)}
              title="The password to use when authenticating with the Remote Desktop Gateway."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Basic Settings">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The server-side keyboard layout. This is the layout of the RDP server and determines how keystrokes are interpreted.">
              Keyboard Layout
            </label>
            <Select
              value={ex("server-layout")}
              onChange={(v) => setEx("server-layout", v)}
              placeholder="Default (US English)"
              options={RDP_KEYBOARD_LAYOUTS}
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The timezone that the client should send to the server for configuring the local time display, in IANA format (e.g. America/New_York).">
              Timezone
            </label>
            <Select
              value={ex("timezone")}
              onChange={(v) => setEx("timezone", v)}
              placeholder="System default"
              options={[
                { value: "", label: "System default" },
                ...getTimezones().map((tz) => ({ value: tz, label: tz })),
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the client to present to the RDP server. Typically not required.">
              Client Name
            </label>
            <input
              value={ex("client-name")}
              onChange={(e) => setEx("client-name", e.target.value)}
              placeholder="Strata"
              title="The name of the client to present to the RDP server. Typically not required."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The full path to the program to run immediately upon connecting. Not needed for normal desktop sessions.">
              Initial Program
            </label>
            <input
              value={ex("initial-program")}
              onChange={(e) => setEx("initial-program", e.target.value)}
              title="The full path to the program to run immediately upon connecting. Not needed for normal desktop sessions."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Connect to the administrator console (Session 0) of the RDP server. This is the physical console session."
            >
              <input
                type="checkbox"
                checked={ex("console") === "true"}
                onChange={(e) => setEx("console", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Administrator console
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enable multi-touch support, allowing touch events from the client to be forwarded to the remote desktop."
            >
              <input
                type="checkbox"
                checked={ex("enable-touch") === "true"}
                onChange={(e) => setEx("enable-touch", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable multi-touch
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The color depth to request from the RDP server, in bits per pixel. If omitted, the color depth is automatically negotiated.">
              Color Depth
            </label>
            <Select
              value={ex("color-depth")}
              onChange={(v) => setEx("color-depth", v)}
              placeholder="Auto"
              options={[
                { value: "", label: "Auto" },
                { value: "8", label: "8-bit (256 colors)" },
                { value: "16", label: "16-bit (High color)" },
                { value: "24", label: "24-bit (True color)" },
                { value: "32", label: "32-bit" },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The method to use to update the RDP session when the browser window is resized. 'Display Update' sends a display update command. 'Reconnect' disconnects and reconnects with the new resolution.">
              Resize Method
            </label>
            <Select
              value={ex("resize-method") || "display-update"}
              onChange={(v) => setEx("resize-method", v)}
              options={[
                { value: "display-update", label: "Display Update" },
                { value: "reconnect", label: "Reconnect" },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Forces lossless image compression for all graphical updates. Increases quality but uses more bandwidth."
            >
              <input
                type="checkbox"
                checked={ex("force-lossless") === "true"}
                onChange={(e) => setEx("force-lossless", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Force lossless compression
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Prevents any user input from being sent to the remote desktop. The session is view-only."
            >
              <input
                type="checkbox"
                checked={ex("read-only") === "true"}
                onChange={(e) => setEx("read-only", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Read-only (view only)
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Clipboard">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="Controls how line endings in clipboard content are normalized. 'Preserve' keeps original line endings, 'Unix' converts to LF, 'Windows' converts to CRLF.">
              Normalize Clipboard
            </label>
            <Select
              value={ex("normalize-clipboard")}
              onChange={(v) => setEx("normalize-clipboard", v)}
              placeholder="Default (preserve)"
              options={[
                { value: "", label: "Default (preserve)" },
                { value: "preserve", label: "Preserve" },
                { value: "unix", label: "Unix (LF)" },
                { value: "windows", label: "Windows (CRLF)" },
              ]}
            />
          </div>
          <div className="form-group !mb-0" />
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Prevents text from being copied from the remote desktop to the local clipboard."
            >
              <input
                type="checkbox"
                checked={ex("disable-copy") === "true"}
                onChange={(e) => setEx("disable-copy", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable copy from remote
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Prevents text from being pasted from the local clipboard to the remote desktop."
            >
              <input
                type="checkbox"
                checked={ex("disable-paste") === "true"}
                onChange={(e) => setEx("disable-paste", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable paste to remote
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Device Redirection">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables audio playback from the remote desktop. Audio is enabled by default."
            >
              <input
                type="checkbox"
                checked={ex("disable-audio") === "true"}
                onChange={(e) => setEx("disable-audio", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable audio playback
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables audio input (microphone) support, allowing the user's local microphone to be used within the remote desktop session."
            >
              <input
                type="checkbox"
                checked={ex("enable-audio-input") === "true"}
                onChange={(e) => setEx("enable-audio-input", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable audio input (microphone)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables printer redirection. PDF documents sent to the redirected printer will be available for download via the Guacamole menu."
            >
              <input
                type="checkbox"
                checked={ex("enable-printing") === "true"}
                onChange={(e) => setEx("enable-printing", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable printing
            </label>
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the redirected printer device. This will be the name of the printer as it appears on the remote desktop.">
              Printer Name
            </label>
            <input
              value={ex("printer-name")}
              onChange={(e) => setEx("printer-name", e.target.value)}
              placeholder="Strata Printer"
              title="The name of the redirected printer device. This will be the name of the printer as it appears on the remote desktop."
            />
          </div>
        </FieldGrid>
        <hr className="border-0 border-t border-border my-3" />
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables file transfer over a virtual drive. Files can be transferred to/from the remote desktop using the Guacamole menu."
            >
              <input
                type="checkbox"
                checked={ex("enable-drive") === "true"}
                onChange={(e) => setEx("enable-drive", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable drive / file transfer
            </label>
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the filesystem used for transferred files. This is the name the virtual drive will have within the remote desktop.">
              Drive Name
            </label>
            <input
              value={ex("drive-name")}
              onChange={(e) => setEx("drive-name", e.target.value)}
              placeholder="Shared Drive"
              title="The name of the filesystem used for transferred files. This is the name the virtual drive will have within the remote desktop."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The directory on the guacd server in which transferred files should be stored.">
              Drive Path
            </label>
            <input
              value={ex("drive-path")}
              onChange={(e) => setEx("drive-path", e.target.value)}
              placeholder="/var/lib/guacamole/drive"
              title="The directory on the guacd server in which transferred files should be stored."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Automatically creates the drive path directory if it does not already exist on the guacd server."
            >
              <input
                type="checkbox"
                checked={ex("create-drive-path") === "true"}
                onChange={(e) => setEx("create-drive-path", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Auto-create drive path
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables file downloads from the remote desktop to the local browser."
            >
              <input
                type="checkbox"
                checked={ex("disable-download") === "true"}
                onChange={(e) => setEx("disable-download", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable file download
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables file uploads from the local browser to the remote desktop."
            >
              <input
                type="checkbox"
                checked={ex("disable-upload") === "true"}
                onChange={(e) => setEx("disable-upload", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable file upload
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Performance">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables rendering of the desktop wallpaper. By default wallpaper is disabled to reduce bandwidth usage."
            >
              <input
                type="checkbox"
                checked={ex("enable-wallpaper") === "true"}
                onChange={(e) => setEx("enable-wallpaper", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable wallpaper
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables use of theming of windows and controls. By default theming within RDP sessions is disabled."
            >
              <input
                type="checkbox"
                checked={ex("enable-theming") === "true"}
                onChange={(e) => setEx("enable-theming", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable theming
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Renders text with smooth edges (ClearType). By default text is rendered with rough edges to reduce bandwidth."
            >
              <input
                type="checkbox"
                checked={ex("enable-font-smoothing") === "true"}
                onChange={(e) => setEx("enable-font-smoothing", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable font smoothing (ClearType)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Displays window contents as windows are moved. By default only the window border is drawn while dragging."
            >
              <input
                type="checkbox"
                checked={ex("enable-full-window-drag") === "true"}
                onChange={(e) => setEx("enable-full-window-drag", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable full-window drag
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Allows graphical effects such as transparent windows and shadows (Aero). Disabled by default."
            >
              <input
                type="checkbox"
                checked={ex("enable-desktop-composition") === "true"}
                onChange={(e) =>
                  setEx("enable-desktop-composition", e.target.checked ? "true" : "")
                }
                className="checkbox"
              />
              Enable desktop composition (Aero)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Allows menu open and close animations. Disabled by default."
            >
              <input
                type="checkbox"
                checked={ex("enable-menu-animations") === "true"}
                onChange={(e) => setEx("enable-menu-animations", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable menu animations
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables RDP's built-in bitmap caching. Usually only needed to work around bugs in specific RDP server implementations."
            >
              <input
                type="checkbox"
                checked={ex("disable-bitmap-caching") === "true"}
                onChange={(e) => setEx("disable-bitmap-caching", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable bitmap caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables caching of off-screen regions. RDP normally caches regions not currently visible to accelerate retrieval when they come into view."
            >
              <input
                type="checkbox"
                checked={ex("disable-offscreen-caching") === "true"}
                onChange={(e) => setEx("disable-offscreen-caching", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable offscreen caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables caching of frequently used symbols and fonts (glyphs). Usually only needed to work around bugs in specific RDP implementations."
            >
              <input
                type="checkbox"
                checked={ex("disable-glyph-caching") === "true"}
                onChange={(e) => setEx("disable-glyph-caching", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable glyph caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables the Graphics Pipeline Extension (GFX) which accelerates display rendering. Enabled by default; disable if the server does not support it."
            >
              <input
                type="checkbox"
                checked={ex("disable-gfx") === "true"}
                onChange={(e) => setEx("disable-gfx", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable graphics pipeline (GFX)
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="RemoteApp">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The name of the RemoteApp to launch. Use '||' prefix for publishing (e.g. '||notepad'). The application must be registered as a RemoteApp on the server.">
              Program
            </label>
            <input
              value={ex("remote-app")}
              onChange={(e) => setEx("remote-app", e.target.value)}
              placeholder="||notepad"
              title="The name of the RemoteApp to launch. Use '||' prefix for publishing (e.g. '||notepad'). The application must be registered as a RemoteApp on the server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The working directory for the RemoteApp, if any.">
              Working Directory
            </label>
            <input
              value={ex("remote-app-dir")}
              onChange={(e) => setEx("remote-app-dir", e.target.value)}
              placeholder="C:\Users\user"
              title="The working directory for the RemoteApp, if any."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="Command-line parameters to pass to the RemoteApp.">Parameters</label>
            <input
              value={ex("remote-app-args")}
              onChange={(e) => setEx("remote-app-args", e.target.value)}
              title="Command-line parameters to pass to the RemoteApp."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Load Balancing / Preconnection">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The load balancing info or token to send to the RDP server. Used when connecting to a load-balanced RDS farm.">
              Load Balance Info
            </label>
            <input
              value={ex("load-balance-info")}
              onChange={(e) => setEx("load-balance-info", e.target.value)}
              title="The load balancing info or token to send to the RDP server. Used when connecting to a load-balanced RDS farm."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The numeric ID of the RDP source. Used with Hyper-V and other systems that support preconnection PDUs.">
              Preconnection ID
            </label>
            <input
              type="number"
              value={ex("preconnection-id")}
              onChange={(e) => setEx("preconnection-id", e.target.value)}
              title="The numeric ID of the RDP source. Used with Hyper-V and other systems that support preconnection PDUs."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="A text value identifying the RDP source to connect to. Used with Hyper-V or other systems supporting preconnection PDUs.">
              Preconnection BLOB
            </label>
            <input
              value={ex("preconnection-blob")}
              onChange={(e) => setEx("preconnection-blob", e.target.value)}
              title="A text value identifying the RDP source to connect to. Used with Hyper-V or other systems supporting preconnection PDUs."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <p className="text-xs text-txt-tertiary mb-3">
          Recording path and filename are managed automatically by the system. Use the Recordings
          tab to enable/disable recording globally.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Exclude graphical output from the recording, producing a recording that contains only user input events."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-output") === "true"}
                onChange={(e) => setEx("recording-exclude-output", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude graphical output
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Exclude user mouse events from the recording, producing a recording without a visible mouse cursor."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-mouse") === "true"}
                onChange={(e) => setEx("recording-exclude-mouse", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude mouse events
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Exclude user touch events from the recording."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-touch") === "true"}
                onChange={(e) => setEx("recording-exclude-touch", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude touch events
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Include user key events in the recording. Can be interpreted with the guaclog utility to produce a human-readable log of keys pressed."
            >
              <input
                type="checkbox"
                checked={ex("recording-include-keys") === "true"}
                onChange={(e) => setEx("recording-include-keys", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="SFTP">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables SFTP-based file transfer. Files can be transferred to/from the RDP server using the Guacamole menu."
            >
              <input
                type="checkbox"
                checked={ex("enable-sftp") === "true"}
                onChange={(e) => setEx("enable-sftp", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable SFTP file transfer
            </label>
          </div>
          <div className="form-group !mb-0" />
          <div className="form-group !mb-0">
            <label title="The hostname of the SSH/SFTP server to use for file transfer. If omitted, the RDP server hostname is used.">
              SFTP Hostname
            </label>
            <input
              value={ex("sftp-hostname")}
              onChange={(e) => setEx("sftp-hostname", e.target.value)}
              placeholder="Same as RDP host"
              title="The hostname of the SSH/SFTP server to use for file transfer. If omitted, the RDP server hostname is used."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The port of the SSH/SFTP server. Defaults to 22.">SFTP Port</label>
            <input
              type="number"
              value={ex("sftp-port")}
              onChange={(e) => setEx("sftp-port", e.target.value)}
              placeholder="22"
              title="The port of the SSH/SFTP server. Defaults to 22."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The username to authenticate as when connecting to the SFTP server.">
              SFTP Username
            </label>
            <input
              value={ex("sftp-username")}
              onChange={(e) => setEx("sftp-username", e.target.value)}
              title="The username to authenticate as when connecting to the SFTP server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The password to use when authenticating with the SFTP server.">
              SFTP Password
            </label>
            <input
              type="password"
              value={ex("sftp-password")}
              onChange={(e) => setEx("sftp-password", e.target.value)}
              title="The password to use when authenticating with the SFTP server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The entire contents of the SSH private key to use when authenticating with the SFTP server, in OpenSSH format.">
              SFTP Private Key
            </label>
            <textarea
              value={ex("sftp-private-key")}
              onChange={(e) => setEx("sftp-private-key", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              title="The entire contents of the SSH private key to use when authenticating with the SFTP server, in OpenSSH format."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The passphrase to use to decrypt the SSH private key, if it is encrypted.">
              SFTP Passphrase
            </label>
            <input
              type="password"
              value={ex("sftp-passphrase")}
              onChange={(e) => setEx("sftp-passphrase", e.target.value)}
              title="The passphrase to use to decrypt the SSH private key, if it is encrypted."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The default location for file uploads. If not specified, the user's home directory will be used.">
              Default Upload Directory
            </label>
            <input
              value={ex("sftp-directory")}
              onChange={(e) => setEx("sftp-directory", e.target.value)}
              title="The default location for file uploads. If not specified, the user's home directory will be used."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The directory to expose to connected users via SFTP. If omitted, '/' will be used by default.">
              SFTP Root Directory
            </label>
            <input
              value={ex("sftp-root-directory")}
              onChange={(e) => setEx("sftp-root-directory", e.target.value)}
              placeholder="/"
              title="The directory to expose to connected users via SFTP. If omitted, '/' will be used by default."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Wake-on-LAN">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Send a Wake-on-LAN (WoL) magic packet to the remote host before attempting to connect. Useful for waking machines that are powered off."
            >
              <input
                type="checkbox"
                checked={ex("wol-send-packet") === "true"}
                onChange={(e) => setEx("wol-send-packet", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Send WoL packet before connecting
            </label>
          </div>
          <div className="form-group !mb-0" />
          <div className="form-group !mb-0">
            <label title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF.">
              MAC Address
            </label>
            <input
              value={ex("wol-mac-addr")}
              onChange={(e) => setEx("wol-mac-addr", e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The broadcast address to which the WoL magic packet should be sent. Defaults to 255.255.255.255 (local broadcast).">
              Broadcast Address
            </label>
            <input
              value={ex("wol-broadcast-addr")}
              onChange={(e) => setEx("wol-broadcast-addr", e.target.value)}
              placeholder="255.255.255.255"
              title="The broadcast address to which the WoL magic packet should be sent. Defaults to 255.255.255.255 (local broadcast)."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The UDP port to use when sending the WoL magic packet. Defaults to 9.">
              UDP Port
            </label>
            <input
              type="number"
              value={ex("wol-udp-port")}
              onChange={(e) => setEx("wol-udp-port", e.target.value)}
              placeholder="9"
              title="The UDP port to use when sending the WoL magic packet. Defaults to 9."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The number of seconds to wait after sending the WoL magic packet before attempting the connection.">
              Wait Time (seconds)
            </label>
            <input
              type="number"
              value={ex("wol-wait-time")}
              onChange={(e) => setEx("wol-wait-time", e.target.value)}
              placeholder="0"
              title="The number of seconds to wait after sending the WoL magic packet before attempting the connection."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Kerberos / NLA">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The authentication package to use for Network Level Authentication (NLA).">
              Auth Package
            </label>
            <Select
              value={ex("auth-pkg")}
              onChange={(v) => setEx("auth-pkg", v)}
              placeholder="Default (auto-detect)"
              options={[
                { value: "", label: "Default (auto-detect)" },
                { value: "kerberos", label: "Kerberos only" },
                { value: "ntlm", label: "NTLM only" },
              ]}
            />
          </div>
          {ex("auth-pkg") === "kerberos" && (
            <>
              <div className="form-group !mb-0">
                <label title="The URL of the Kerberos Key Distribution Center (KDC) to use for obtaining Kerberos tickets. Only needed if not using the global Kerberos realm configuration.">
                  KDC URL
                </label>
                <input
                  value={ex("kdc-url")}
                  onChange={(e) => setEx("kdc-url", e.target.value)}
                  placeholder="kdc.example.com"
                  title="The URL of the Kerberos Key Distribution Center (KDC). Leave blank to use the KDC from the matching Kerberos realm."
                />
              </div>
              <div className="form-group !mb-0">
                <label title="The file path for the Kerberos credential cache. The cache stores obtained tickets for reuse.">
                  Kerberos Cache Path
                </label>
                <input
                  value={ex("kerberos-cache")}
                  onChange={(e) => setEx("kerberos-cache", e.target.value)}
                  placeholder="/tmp/krb5cc_guacd"
                  title="The file path for the Kerberos credential cache. Leave blank for default."
                />
              </div>
            </>
          )}
        </FieldGrid>
        {(!ex("auth-pkg") || ex("auth-pkg") === "") && (
          <p className="text-xs text-zinc-400 mt-2">
            When set to <strong>Default (auto-detect)</strong>, the client and server negotiate the
            best authentication method via SPNEGO. Realms configured in the{" "}
            <strong>Kerberos</strong> tab are written to the shared{" "}
            <code className="text-zinc-300">krb5.conf</code> which guacd uses automatically —
            Kerberos-only servers will use Kerberos; servers that support NTLM will negotiate
            normally.
          </p>
        )}
      </Section>
    </>
  );
}

// ── SSH Parameter Sections ──────────────────────────────────────────

function SshSections({
  ex,
  setEx,
}: {
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The entire contents of the SSH private key to use for public key authentication. Must be in OpenSSH format.">
              Private Key
            </label>
            <textarea
              value={ex("private-key")}
              onChange={(e) => setEx("private-key", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              title="The entire contents of the SSH private key to use for public key authentication. Must be in OpenSSH format."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The passphrase to use to decrypt the SSH private key, if it is encrypted.">
              Passphrase
            </label>
            <input
              type="password"
              value={ex("passphrase")}
              onChange={(e) => setEx("passphrase", e.target.value)}
              title="The passphrase to use to decrypt the SSH private key, if it is encrypted."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The known public key of the SSH server, in OpenSSH format. If provided, the server's identity will be verified against this key.">
              Host Key
            </label>
            <input
              value={ex("host-key")}
              onChange={(e) => setEx("host-key", e.target.value)}
              placeholder="Server public key (optional)"
              title="The known public key of the SSH server, in OpenSSH format. If provided, the server's identity will be verified against this key."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The color scheme to use for the terminal display.">Color Scheme</label>
            <Select
              value={ex("color-scheme")}
              onChange={(v) => setEx("color-scheme", v)}
              placeholder="Default (black on white)"
              options={[
                { value: "", label: "Default (black on white)" },
                { value: "green-black", label: "Green on black" },
                { value: "white-black", label: "White on black" },
                { value: "gray-black", label: "Gray on black" },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the font to use in the terminal. This must be a font available on the guacd server.">
              Font Name
            </label>
            <input
              value={ex("font-name")}
              onChange={(e) => setEx("font-name", e.target.value)}
              placeholder="monospace"
              title="The name of the font to use in the terminal. This must be a font available on the guacd server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The size of the font to use in the terminal, in points.">Font Size</label>
            <input
              type="number"
              value={ex("font-size")}
              onChange={(e) => setEx("font-size", e.target.value)}
              placeholder="12"
              title="The size of the font to use in the terminal, in points."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The maximum number of lines of terminal scrollback to allow. Each line requires additional memory. Defaults to 1000.">
              Scrollback (lines)
            </label>
            <input
              type="number"
              value={ex("scrollback")}
              onChange={(e) => setEx("scrollback", e.target.value)}
              placeholder="1000"
              title="The maximum number of lines of terminal scrollback to allow. Each line requires additional memory. Defaults to 1000."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Prevents any user input from being sent to the SSH server. The session is view-only."
            >
              <input
                type="checkbox"
                checked={ex("read-only") === "true"}
                onChange={(e) => setEx("read-only", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Read-only
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Terminal Behavior">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The command to execute on the remote server upon connecting, instead of the default shell.">
              Command
            </label>
            <input
              value={ex("command")}
              onChange={(e) => setEx("command", e.target.value)}
              placeholder="Execute on connect"
              title="The command to execute on the remote server upon connecting, instead of the default shell."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The locale to use for the SSH session (e.g. en_US.UTF-8). Controls character encoding.">
              Locale
            </label>
            <input
              value={ex("locale")}
              onChange={(e) => setEx("locale", e.target.value)}
              placeholder="en_US.UTF-8"
              title="The locale to use for the SSH session (e.g. en_US.UTF-8). Controls character encoding."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The timezone to pass to the SSH server via the TZ environment variable, in IANA format (e.g. America/New_York).">
              Timezone
            </label>
            <Select
              value={ex("timezone")}
              onChange={(v) => setEx("timezone", v)}
              placeholder="System default"
              options={[
                { value: "", label: "System default" },
                ...getTimezones().map((tz) => ({ value: tz, label: tz })),
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The terminal emulator type string to send to the SSH server (e.g. xterm-256color, vt100). This determines which escape sequences are supported.">
              Terminal Type
            </label>
            <input
              value={ex("terminal-type")}
              onChange={(e) => setEx("terminal-type", e.target.value)}
              placeholder="xterm-256color"
              title="The terminal emulator type string to send to the SSH server (e.g. xterm-256color, vt100). This determines which escape sequences are supported."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The interval in seconds at which to send keepalive packets to the SSH server. Set to 0 to disable. Useful for preventing idle timeouts.">
              Server Alive Interval
            </label>
            <input
              type="number"
              value={ex("server-alive-interval")}
              onChange={(e) => setEx("server-alive-interval", e.target.value)}
              placeholder="0"
              title="The interval in seconds at which to send keepalive packets to the SSH server. Set to 0 to disable. Useful for preventing idle timeouts."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="SFTP">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables SFTP file transfer within the SSH connection. Files can be transferred using the Guacamole menu."
            >
              <input
                type="checkbox"
                checked={ex("enable-sftp") === "true"}
                onChange={(e) => setEx("enable-sftp", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable SFTP
            </label>
          </div>
          <div className="form-group !mb-0">
            <label title="The root directory to expose to connected users via SFTP. If omitted, '/' will be used.">
              SFTP Root Directory
            </label>
            <input
              value={ex("sftp-root-directory")}
              onChange={(e) => setEx("sftp-root-directory", e.target.value)}
              placeholder="/"
              title="The root directory to expose to connected users via SFTP. If omitted, '/' will be used."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables file downloads from the remote server to the local browser."
            >
              <input
                type="checkbox"
                checked={ex("sftp-disable-download") === "true"}
                onChange={(e) => setEx("sftp-disable-download", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable file download
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables file uploads from the local browser to the remote server."
            >
              <input
                type="checkbox"
                checked={ex("sftp-disable-upload") === "true"}
                onChange={(e) => setEx("sftp-disable-upload", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable file upload
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <p className="text-xs text-txt-tertiary mb-3">
          Recording path and filename are managed automatically by the system. Use the Recordings
          tab to enable/disable recording globally.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Include user key events in the recording. Can be interpreted with the guaclog utility to produce a human-readable log of keys pressed."
            >
              <input
                type="checkbox"
                checked={ex("recording-include-keys") === "true"}
                onChange={(e) => setEx("recording-include-keys", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Wake-on-LAN">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Send a Wake-on-LAN (WoL) magic packet to the remote host before attempting to connect."
            >
              <input
                type="checkbox"
                checked={ex("wol-send-packet") === "true"}
                onChange={(e) => setEx("wol-send-packet", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Send WoL packet
            </label>
          </div>
          <div className="form-group !mb-0">
            <label title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF.">
              MAC Address
            </label>
            <input
              value={ex("wol-mac-addr")}
              onChange={(e) => setEx("wol-mac-addr", e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF."
            />
          </div>
        </FieldGrid>
      </Section>
    </>
  );
}

// ── VNC Parameter Sections ──────────────────────────────────────────

function VncSections({
  ex,
  setEx,
}: {
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label title="The password to use when connecting to the VNC server.">Password</label>
            <input
              type="password"
              value={ex("password")}
              onChange={(e) => setEx("password", e.target.value)}
              title="The password to use when connecting to the VNC server."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label title="The color depth to request from the VNC server, in bits per pixel.">
              Color Depth
            </label>
            <Select
              value={ex("color-depth")}
              onChange={(v) => setEx("color-depth", v)}
              placeholder="Auto"
              options={[
                { value: "", label: "Auto" },
                { value: "8", label: "8-bit" },
                { value: "16", label: "16-bit" },
                { value: "24", label: "24-bit" },
                { value: "32", label: "32-bit" },
              ]}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label title="Controls how the mouse cursor is displayed. 'Local' renders the cursor on the client for performance. 'Remote' shows the VNC server's cursor.">
              Cursor
            </label>
            <Select
              value={ex("cursor")}
              onChange={(v) => setEx("cursor", v)}
              placeholder="Local"
              options={[
                { value: "", label: "Local" },
                { value: "remote", label: "Remote" },
              ]}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              title="Prevents any user input from being sent to the VNC server. The session is view-only."
            >
              <input
                type="checkbox"
                checked={ex("read-only") === "true"}
                onChange={(e) => setEx("read-only", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Read-only
            </label>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              title="Swap the red and blue color components in the received image data. May be needed for certain VNC servers that report colors incorrectly."
            >
              <input
                type="checkbox"
                checked={ex("swap-red-blue") === "true"}
                onChange={(e) => setEx("swap-red-blue", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Swap red/blue
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Clipboard">
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              title="Prevents text from being copied from the remote desktop to the local clipboard."
            >
              <input
                type="checkbox"
                checked={ex("disable-copy") === "true"}
                onChange={(e) => setEx("disable-copy", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable copy from remote
            </label>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              title="Prevents text from being pasted from the local clipboard to the remote desktop."
            >
              <input
                type="checkbox"
                checked={ex("disable-paste") === "true"}
                onChange={(e) => setEx("disable-paste", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable paste to remote
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <p className="text-xs text-txt-tertiary mb-3">
          Recording path and filename are managed automatically by the system. Use the Recordings
          tab to enable/disable recording globally.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Exclude graphical output from the recording, producing a recording that contains only user input events."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-output") === "true"}
                onChange={(e) => setEx("recording-exclude-output", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude graphical output
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Exclude user mouse events from the recording, producing a recording without a visible mouse cursor."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-mouse") === "true"}
                onChange={(e) => setEx("recording-exclude-mouse", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude mouse events
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Exclude user touch events from the recording."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-touch") === "true"}
                onChange={(e) => setEx("recording-exclude-touch", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude touch events
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Include user key events in the recording. Can be interpreted with the guaclog utility to produce a human-readable log of keys pressed."
            >
              <input
                type="checkbox"
                checked={ex("recording-include-keys") === "true"}
                onChange={(e) => setEx("recording-include-keys", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>
    </>
  );
}

// ── guacd Capacity Gauge ────────────────────────────────────────────

function GuacdCapacityGauge({ metrics }: { metrics: MetricsSummary }) {
  const poolSize = metrics.guacd_pool_size || 1;
  const activeSessions = metrics.active_sessions;
  const recPerInstance = metrics.recommended_per_instance || 20;
  const totalCapacity = poolSize * recPerInstance;
  const perInstance = poolSize > 0 ? activeSessions / poolSize : activeSessions;
  const usagePercent = Math.min((activeSessions / totalCapacity) * 100, 100);

  // Format system resources for display
  const memGB = metrics.system_total_memory
    ? (metrics.system_total_memory / 1_073_741_824).toFixed(1)
    : null;
  const cpuCores = metrics.system_cpu_cores || null;

  // Format total live bandwidth
  const totalBw = metrics.total_bytes_from_guacd + metrics.total_bytes_to_guacd;
  const fmtBw = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`;
    return `${(b / 1_073_741_824).toFixed(2)} GB`;
  };

  // Color zones
  const getColor = (pct: number) => {
    if (pct >= 80) return "#ef4444"; // red
    if (pct >= 60) return "#f59e0b"; // amber
    return "#22c55e"; // green
  };

  const color = getColor(usagePercent);

  // Recommendation
  const getRecommendation = () => {
    if (usagePercent >= 90)
      return {
        level: "critical" as const,
        text: "Capacity critical — add guacd instances immediately to avoid degraded performance.",
      };
    if (usagePercent >= 75)
      return {
        level: "warning" as const,
        text: "Consider adding another guacd instance. Performance may degrade above 80% capacity.",
      };
    if (usagePercent >= 50)
      return {
        level: "info" as const,
        text: "Capacity healthy. Plan to scale when sustained load exceeds 75%.",
      };
    return null;
  };

  const recommendation = getRecommendation();

  // Semi-circle arc gauge
  const radius = 70;
  const strokeWidth = 12;
  const circumference = Math.PI * radius; // half-circle
  const offset = circumference - (usagePercent / 100) * circumference;

  // Protocol breakdown
  const protocols = Object.entries(metrics.sessions_by_protocol);

  return (
    <div
      className="rounded-xl p-5"
      style={{
        background: "var(--color-surface-secondary)",
        border: "1px solid var(--color-glass-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
      }}
    >
      <div className="flex items-center gap-2 mb-4">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
        <h3 className="text-sm font-bold" style={{ color: "var(--color-accent)" }}>
          guacd Resource Capacity
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 items-center">
        {/* Gauge */}
        <div className="flex flex-col items-center">
          <svg width="180" height="105" viewBox="0 0 180 105">
            {/* Background arc */}
            <path
              d={`M ${90 - radius} 95 A ${radius} ${radius} 0 0 1 ${90 + radius} 95`}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
            />
            {/* Value arc */}
            <path
              d={`M ${90 - radius} 95 A ${radius} ${radius} 0 0 1 ${90 + radius} 95`}
              fill="none"
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.4s ease" }}
            />
            {/* Percentage text */}
            <text
              x="90"
              y="78"
              textAnchor="middle"
              fill={color}
              fontSize="28"
              fontWeight="bold"
              fontFamily="system-ui"
            >
              {Math.round(usagePercent)}%
            </text>
            <text
              x="90"
              y="96"
              textAnchor="middle"
              fill="var(--color-txt-tertiary)"
              fontSize="10"
              fontFamily="system-ui"
            >
              capacity used
            </text>
          </svg>
        </div>

        {/* Info panel */}
        <div className="grid gap-3">
          {/* Metric pills */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                Active Sessions
              </p>
              <p className="text-lg font-bold" style={{ color }}>
                {activeSessions}
              </p>
            </div>
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                guacd Instances
              </p>
              <p className="text-lg font-bold text-txt-primary">{poolSize}</p>
            </div>
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                Per Instance
              </p>
              <p className="text-lg font-bold text-txt-primary">{perInstance.toFixed(1)}</p>
            </div>
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                Max Recommended
              </p>
              <p className="text-lg font-bold text-txt-primary">{totalCapacity}</p>
            </div>
          </div>

          {/* Protocol breakdown + bandwidth */}
          {protocols.length > 0 && (
            <div className="flex items-center gap-3 text-xs flex-wrap">
              <span className="text-txt-tertiary font-semibold">By Protocol:</span>
              {protocols.map(([proto, count]) => (
                <span
                  key={proto}
                  className="uppercase text-[0.6rem] font-bold tracking-wider px-2 py-0.5 rounded"
                  style={{
                    background: "var(--color-surface-tertiary)",
                    color: "var(--color-txt-secondary)",
                  }}
                >
                  {proto} {count}
                </span>
              ))}
              {totalBw > 0 && (
                <>
                  <span className="text-txt-tertiary">|</span>
                  <span className="text-txt-tertiary font-semibold">Live Bandwidth:</span>
                  <span
                    className="text-[0.6rem] font-bold tracking-wider px-2 py-0.5 rounded"
                    style={{
                      background: "var(--color-surface-tertiary)",
                      color: "var(--color-txt-secondary)",
                    }}
                  >
                    ↓{fmtBw(metrics.total_bytes_from_guacd)} ↑{fmtBw(metrics.total_bytes_to_guacd)}
                  </span>
                </>
              )}
            </div>
          )}

          {/* System resources */}
          {(memGB || cpuCores) && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-txt-tertiary font-semibold">Host Resources:</span>
              {cpuCores && (
                <span
                  className="text-[0.6rem] font-bold tracking-wider px-2 py-0.5 rounded"
                  style={{
                    background: "var(--color-surface-tertiary)",
                    color: "var(--color-txt-secondary)",
                  }}
                >
                  {cpuCores} vCPUs
                </span>
              )}
              {memGB && (
                <span
                  className="text-[0.6rem] font-bold tracking-wider px-2 py-0.5 rounded"
                  style={{
                    background: "var(--color-surface-tertiary)",
                    color: "var(--color-txt-secondary)",
                  }}
                >
                  {memGB} GB RAM
                </span>
              )}
              <span className="text-[0.55rem] text-txt-tertiary italic">
                ({recPerInstance}/instance after 30% reserve)
              </span>
            </div>
          )}

          {/* Capacity bar */}
          <div>
            <div className="flex justify-between text-[0.6rem] text-txt-tertiary mb-1">
              <span>0</span>
              <span
                className="font-semibold"
                style={{ color: usagePercent >= 75 ? "#f59e0b" : "var(--color-txt-tertiary)" }}
              >
                {Math.round(totalCapacity * 0.75)} (scale threshold)
              </span>
              <span>{totalCapacity}</span>
            </div>
            <div
              className="relative h-3 rounded-full overflow-hidden"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              {/* Scale threshold marker */}
              <div
                className="absolute top-0 bottom-0 w-px"
                style={{ left: "75%", background: "#f59e0b", opacity: 0.6, zIndex: 2 }}
              />
              {/* Fill */}
              <div
                className="h-full rounded-full"
                style={{
                  width: `${usagePercent}%`,
                  background: `linear-gradient(90deg, #22c55e, ${usagePercent > 60 ? "#f59e0b" : "#22c55e"}, ${usagePercent > 80 ? "#ef4444" : usagePercent > 60 ? "#f59e0b" : "#22c55e"})`,
                  transition: "width 0.6s ease",
                }}
              />
            </div>
          </div>

          {/* Recommendation */}
          {recommendation && (
            <div
              className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
              style={{
                background:
                  recommendation.level === "critical"
                    ? "rgba(239,68,68,0.1)"
                    : recommendation.level === "warning"
                      ? "rgba(245,158,11,0.1)"
                      : "rgba(34,197,94,0.08)",
                border: `1px solid ${recommendation.level === "critical" ? "rgba(239,68,68,0.25)" : recommendation.level === "warning" ? "rgba(245,158,11,0.25)" : "rgba(34,197,94,0.15)"}`,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 mt-0.5"
                stroke={
                  recommendation.level === "critical"
                    ? "#ef4444"
                    : recommendation.level === "warning"
                      ? "#f59e0b"
                      : "#22c55e"
                }
              >
                {recommendation.level === "info" ? (
                  <>
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </>
                ) : (
                  <>
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </>
                )}
              </svg>
              <span
                style={{
                  color:
                    recommendation.level === "critical"
                      ? "#ef4444"
                      : recommendation.level === "warning"
                        ? "#f59e0b"
                        : "#22c55e",
                }}
              >
                {recommendation.text}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sessions Tab (NVR) ──────────────────────────────────────────────

function SessionsTab() {
  const { formatDateTime } = useSettings();
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);

  useEffect(() => {
    getSessionStats()
      .then(setStats)
      .catch(() => {});
    getMetrics()
      .then(setMetrics)
      .catch(() => {});
  }, []);

  // Refresh metrics periodically
  useEffect(() => {
    const interval = setInterval(() => {
      getMetrics()
        .then(setMetrics)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  }

  const statIconStyle = (color: string) => ({
    width: 36,
    height: 36,
    borderRadius: 8,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    background: `${color}18`,
    color,
    flexShrink: 0 as const,
  });

  return (
    <div className="grid gap-5">
      {/* Stat Cards */}
      <p className="text-xs text-txt-tertiary italic">Showing data from the last 30 days</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={statIconStyle("#8b5cf6")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="7" height="7" x="3" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="14" rx="1" />
              <rect width="7" height="7" x="3" y="14" rx="1" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Total Sessions
            </p>
            <p className="text-sm font-bold text-txt-primary">
              {stats ? stats.total_sessions.toLocaleString() : "—"}
            </p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={statIconStyle("#f59e0b")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Total Hours
            </p>
            <p className="text-sm font-bold text-txt-primary">
              {stats ? stats.total_hours.toFixed(1) : "—"}
            </p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={statIconStyle("#06b6d4")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Unique Users
            </p>
            <p className="text-sm font-bold text-txt-primary">
              {stats ? stats.unique_users.toLocaleString() : "—"}
            </p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={statIconStyle("#22c55e")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Active Now
            </p>
            <p className="text-sm font-bold text-txt-primary">{stats ? stats.active_now : "—"}</p>
          </div>
        </div>
      </div>

      {/* Usage Analytics */}
      {stats && (stats.daily_trend?.length > 0 || stats.avg_duration_mins > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Daily Trend Chart */}
          {stats.daily_trend?.length > 0 && (
            <div
              className="md:col-span-2 rounded-xl p-5 flex flex-col"
              style={{
                background: "var(--color-surface-secondary)",
                border: "1px solid var(--color-glass-border)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
              }}
            >
              <h3 className="text-sm font-bold mb-3" style={{ color: "var(--color-accent)" }}>
                Daily Usage (30 days)
              </h3>
              {(() => {
                const raw = stats.daily_trend;

                // Fill missing days so the chart has no gaps
                const filled: typeof raw = [];
                if (raw.length > 0) {
                  const start = new Date(raw[0].date + "T00:00:00");
                  const end = new Date(raw[raw.length - 1].date + "T00:00:00");
                  const lookup = new Map(raw.map((d) => [d.date, d]));
                  for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
                    const key = dt.toISOString().slice(0, 10);
                    filled.push(
                      lookup.get(key) ?? { date: key, sessions: 0, hours: 0, unique_users: 0 }
                    );
                  }
                }
                const trend = filled.length > 0 ? filled : raw;

                const maxSessions = Math.max(...trend.map((d) => d.sessions), 1);
                const maxHours = Math.max(...trend.map((d) => d.hours), 0.1);

                // SVG dimensions
                const padL = 32;
                const padR = 8;
                const padT = 8;
                const padB = 24;
                const vbW = 600;
                const vbH = 160;
                const plotW = vbW - padL - padR;
                const plotH = vbH - padT - padB;

                // Bar sizing — fill the plot width naturally
                const barW = plotW / Math.max(trend.length, 1);
                const offsetX = padL;
                const barPad = Math.min(barW * 0.15, 6);

                // Y-axis grid — pick ~4 nice ticks
                const rawStep = maxSessions / 4;
                const yStep =
                  rawStep <= 1 ? 1 : rawStep <= 5 ? Math.ceil(rawStep) : Math.ceil(rawStep / 5) * 5;
                const yTicks: number[] = [];
                for (let v = 0; v <= maxSessions; v += yStep) yTicks.push(v);
                if (yTicks[yTicks.length - 1] < maxSessions)
                  yTicks.push(yTicks[yTicks.length - 1] + yStep);
                const yMax = yTicks[yTicks.length - 1] || 1;

                // Gridlines + Y labels
                const gridLines = yTicks
                  .map((v) => {
                    const y = padT + plotH - (v / yMax) * plotH;
                    return (
                      `<line x1="${padL}" x2="${vbW - padR}" y1="${y}" y2="${y}" stroke="var(--color-glass-border)" stroke-width="0.5" stroke-dasharray="3,3"/>` +
                      `<text x="${padL - 4}" y="${y + 2}" text-anchor="end" fill="var(--color-txt-tertiary)" font-size="7" font-family="inherit">${v}</text>`
                    );
                  })
                  .join("");

                // Session bars (skip zero-height)
                const sessionBars = trend
                  .map((d, i) => {
                    if (d.sessions === 0) return "";
                    const x = offsetX + i * barW + barPad;
                    const w = barW - barPad * 2;
                    const barH = (d.sessions / yMax) * plotH;
                    const y = padT + plotH - barH;
                    return (
                      `<rect x="${x}" y="${y}" width="${w}" height="${barH}" rx="2" fill="var(--color-accent)" opacity="0.7">` +
                      `<title>${d.date}\n${d.sessions} session${d.sessions !== 1 ? "s" : ""} · ${d.hours.toFixed(1)} hrs</title></rect>`
                    );
                  })
                  .join("");

                // Hours line + dots
                const hoursCoords = trend.map((d, i) => {
                  const x = offsetX + i * barW + barW / 2;
                  const y = padT + plotH - (d.hours / maxHours) * plotH;
                  return { x, y, d };
                });
                const hoursPolyline = hoursCoords.map((c) => `${c.x},${c.y}`).join(" ");
                const hoursDots = hoursCoords
                  .map(
                    (c) =>
                      `<circle cx="${c.x}" cy="${c.y}" r="2.5" fill="#f59e0b" stroke="var(--color-surface-secondary)" stroke-width="1">` +
                      `<title>${c.d.date}\n${c.d.hours.toFixed(1)} hrs</title></circle>`
                  )
                  .join("");

                // X-axis labels — show all when ≤ 14 days, otherwise evenly spaced
                const labelIndices = new Set<number>();
                if (trend.length <= 14) {
                  trend.forEach((_, i) => labelIndices.add(i));
                } else {
                  labelIndices.add(0);
                  labelIndices.add(trend.length - 1);
                  const labelStep = Math.max(1, Math.floor(trend.length / 8));
                  for (let i = labelStep; i < trend.length - 1; i += labelStep) labelIndices.add(i);
                }

                const xLabels = [...labelIndices]
                  .map((i) => {
                    const x = offsetX + i * barW + barW / 2;
                    const label = trend[i].date.slice(5); // "MM-DD"
                    return `<text x="${x}" y="${vbH - 4}" text-anchor="middle" fill="var(--color-txt-tertiary)" font-size="7" font-family="inherit">${label}</text>`;
                  })
                  .join("");

                // Baseline axis
                const baseline = `<line x1="${padL}" x2="${vbW - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="var(--color-glass-border)" stroke-width="0.5"/>`;

                return (
                  <div className="flex-1 flex flex-col min-h-0">
                    <svg
                      viewBox={`0 0 ${vbW} ${vbH}`}
                      className="w-full flex-1"
                      style={{ minHeight: "10rem" }}
                      preserveAspectRatio="xMidYMid meet"
                    >
                      <g
                        dangerouslySetInnerHTML={{
                          __html: baseline + gridLines + sessionBars + xLabels,
                        }}
                      />
                      {trend.length > 1 && (
                        <polyline
                          points={hoursPolyline}
                          fill="none"
                          stroke="#f59e0b"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      )}
                      <g dangerouslySetInnerHTML={{ __html: hoursDots }} />
                    </svg>
                    <div className="flex items-center gap-4 mt-1 text-[0.6rem] text-txt-tertiary">
                      <span className="flex items-center gap-1">
                        <span
                          className="inline-block w-2 h-2 rounded-sm"
                          style={{ background: "var(--color-accent)", opacity: 0.7 }}
                        />
                        Sessions
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-3 h-0.5 rounded bg-amber-400" />
                        Hours
                      </span>
                      <span className="ml-auto">
                        {trend[0]?.date} — {trend[trend.length - 1]?.date}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Right column: additional stats + protocol + peak hours */}
          <div className="grid gap-4">
            {/* Duration + Bandwidth cards */}
            <div className="grid grid-cols-2 gap-3">
              <div
                className="rounded-xl px-4 py-3 flex items-center gap-3"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <div style={statIconStyle("#ec4899")}>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="M12 5l7 7-7 7" />
                  </svg>
                </div>
                <div>
                  <p className="text-[0.55rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                    Avg Duration
                  </p>
                  <p className="text-sm font-bold text-txt-primary">
                    {stats.avg_duration_mins?.toFixed(0) ?? "—"}m
                  </p>
                </div>
              </div>
              <div
                className="rounded-xl px-4 py-3 flex items-center gap-3"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <div style={statIconStyle("#6366f1")}>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 20V10" />
                    <path d="M18 20V4" />
                    <path d="M6 20v-4" />
                  </svg>
                </div>
                <div>
                  <p className="text-[0.55rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                    Median
                  </p>
                  <p className="text-sm font-bold text-txt-primary">
                    {stats.median_duration_mins?.toFixed(0) ?? "—"}m
                  </p>
                </div>
              </div>
            </div>

            {/* Total Bandwidth (historical) */}
            {stats.total_bandwidth_bytes > 0 && (
              <div
                className="rounded-xl px-4 py-3 flex items-center gap-3"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <div style={statIconStyle("#14b8a6")}>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2v20M2 12h20" />
                  </svg>
                </div>
                <div>
                  <p className="text-[0.55rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                    Total Bandwidth (30d)
                  </p>
                  <p className="text-sm font-bold text-txt-primary">
                    {formatBytes(stats.total_bandwidth_bytes)}
                  </p>
                </div>
              </div>
            )}

            {/* Protocol Distribution */}
            {stats.protocol_distribution?.length > 0 && (
              <div
                className="rounded-xl p-4"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <h4 className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold mb-2">
                  Protocol Distribution
                </h4>
                {(() => {
                  const total =
                    stats.protocol_distribution.reduce((s, p) => s + p.sessions, 0) || 1;
                  const colors: Record<string, string> = {
                    rdp: "#3b82f6",
                    ssh: "#22c55e",
                    vnc: "#f59e0b",
                    telnet: "#ef4444",
                  };
                  return (
                    <div className="grid gap-2">
                      {/* Stacked bar */}
                      <div
                        className="flex h-3 rounded-full overflow-hidden"
                        style={{ background: "var(--color-surface-tertiary)" }}
                      >
                        {stats.protocol_distribution.map((p) => (
                          <div
                            key={p.protocol}
                            style={{
                              width: `${(p.sessions / total) * 100}%`,
                              background: colors[p.protocol] || "#8b5cf6",
                            }}
                          />
                        ))}
                      </div>
                      {/* Legend */}
                      <div className="flex flex-wrap gap-3 text-[0.6rem]">
                        {stats.protocol_distribution.map((p) => (
                          <span
                            key={p.protocol}
                            className="flex items-center gap-1 text-txt-secondary"
                          >
                            <span
                              className="inline-block w-2 h-2 rounded-full"
                              style={{ background: colors[p.protocol] || "#8b5cf6" }}
                            />
                            <span className="uppercase font-bold tracking-wider">{p.protocol}</span>
                            <span className="text-txt-tertiary">
                              {p.sessions} ({Math.round((p.sessions / total) * 100)}%)
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Peak Hours */}
            {stats.peak_hours?.length > 0 && (
              <div
                className="rounded-xl p-4"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <h4 className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold mb-2">
                  Peak Hours
                </h4>
                {(() => {
                  const maxH = Math.max(...stats.peak_hours.map((h) => h.sessions), 1);
                  // Build full 24-hour array
                  const hourMap = new Map(stats.peak_hours.map((h) => [h.hour, h.sessions]));
                  const hours = Array.from({ length: 24 }, (_, i) => hourMap.get(i) || 0);
                  return (
                    <div className="grid gap-1">
                      <div className="flex gap-px items-end h-10">
                        {hours.map((count, i) => {
                          const pct = (count / maxH) * 100;
                          const intensity = count / maxH;
                          return (
                            <div
                              key={i}
                              className="flex-1 rounded-t-sm"
                              style={{
                                height: `${Math.max(pct, 4)}%`,
                                background:
                                  count === 0
                                    ? "var(--color-surface-tertiary)"
                                    : `rgba(59, 130, 246, ${0.2 + intensity * 0.8})`,
                                transition: "height 0.3s ease",
                              }}
                              title={`${i.toString().padStart(2, "0")}:00 — ${count} sessions`}
                            />
                          );
                        })}
                      </div>
                      <div className="flex text-[0.5rem] text-txt-tertiary">
                        <span>00</span>
                        <span className="ml-auto" style={{ marginLeft: `${(6 / 24) * 100 - 2}%` }}>
                          06
                        </span>
                        <span className="ml-auto" style={{ marginLeft: `${(6 / 24) * 100 - 2}%` }}>
                          12
                        </span>
                        <span className="ml-auto" style={{ marginLeft: `${(6 / 24) * 100 - 2}%` }}>
                          18
                        </span>
                        <span className="ml-auto">23</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Leaderboard Tables */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top Connections */}
        <div
          className="rounded-xl p-5"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <h3 className="text-sm font-bold mb-4" style={{ color: "var(--color-accent)" }}>
            Top Connections
          </h3>
          {!stats || stats.top_connections.length === 0 ? (
            <p className="text-sm text-txt-tertiary text-center py-6">No data yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-txt-tertiary">
                  <th className="text-left pb-2 font-semibold">Name</th>
                  <th className="text-left pb-2 font-semibold">Type</th>
                  <th className="text-right pb-2 font-semibold">Sessions</th>
                  <th className="text-right pb-2 font-semibold">Total Hours</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_connections.map((c) => (
                  <tr key={c.name} className="border-t border-white/5">
                    <td className="py-2 text-txt-primary font-medium">{c.name}</td>
                    <td className="py-2">
                      <span className="uppercase text-[0.6rem] font-bold tracking-wider px-1.5 py-0.5 rounded bg-white/5 text-txt-secondary">
                        {c.protocol}
                      </span>
                    </td>
                    <td className="py-2 text-right text-txt-secondary tabular-nums">
                      {c.sessions}
                    </td>
                    <td className="py-2 text-right text-txt-secondary tabular-nums">
                      {c.total_hours.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Top Users */}
        <div
          className="rounded-xl p-5"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <h3 className="text-sm font-bold mb-4" style={{ color: "var(--color-accent)" }}>
            Top Users
          </h3>
          {!stats || stats.top_users.length === 0 ? (
            <p className="text-sm text-txt-tertiary text-center py-6">No data yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-txt-tertiary">
                  <th className="text-left pb-2 font-semibold">User</th>
                  <th className="text-right pb-2 font-semibold">Sessions</th>
                  <th className="text-right pb-2 font-semibold">Total Hours</th>
                  <th className="text-right pb-2 font-semibold">Last Session</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_users.map((u) => (
                  <tr key={u.username} className="border-t border-white/5">
                    <td className="py-2 text-txt-primary font-medium">{u.username}</td>
                    <td className="py-2 text-right text-txt-secondary tabular-nums">
                      {u.sessions}
                    </td>
                    <td className="py-2 text-right text-txt-secondary tabular-nums">
                      {u.total_hours.toFixed(1)}
                    </td>
                    <td className="py-2 text-right text-txt-secondary text-[0.65rem]">
                      {u.last_session ? formatDateTime(u.last_session) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* guacd Capacity Gauge */}
      {metrics && <GuacdCapacityGauge metrics={metrics} />}
    </div>
  );
}

// ── AD Sync Tab ──────────────────────────────────────────────────────

function AdSyncTab({ folders, onSave }: { folders: ConnectionFolder[]; onSave: () => void }) {
  const { formatDateTime } = useSettings();
  const [configs, setConfigs] = useState<AdSyncConfig[]>([]);
  const [editing, setEditing] = useState<Partial<AdSyncConfig> | null>(null);
  const [selectedRuns, setSelectedRuns] = useState<{ configId: string; runs: AdSyncRun[] } | null>(
    null
  );
  const [syncing, setSyncing] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    status: string;
    message: string;
    sample?: string[];
    count?: number;
  } | null>(null);
  const [rotationTesting, setRotationTesting] = useState(false);
  const [rotationResult, setRotationResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [filterTesting, setFilterTesting] = useState(false);
  const [filterResult, setFilterResult] = useState<{
    status: string;
    message: string;
    hint?: string;
    count?: number;
    sample?: { dn: string; name: string; description?: string }[];
  } | null>(null);
  const certFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    getAdSyncConfigs()
      .then(setConfigs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!editing) return;
    try {
      // When 'Use AD source's bind credentials' is selected, pm_bind_user is null/undefined.
      // Send explicit empty strings so the backend clears them in the database.
      const payload = {
        ...editing,
        pm_bind_user: editing.pm_bind_user ?? "",
        pm_bind_password: editing.pm_bind_password ?? "",
      };
      if (editing.id) {
        await updateAdSyncConfig(editing.id, payload);
      } else {
        await createAdSyncConfig(payload);
      }
      setEditing(null);
      load();
      onSave();
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (id: string) => {
    if (
      !confirm(
        "Delete this AD sync source? Imported connections will remain but will no longer sync."
      )
    )
      return;
    await deleteAdSyncConfig(id);
    load();
  };

  const handleClone = (c: AdSyncConfig) => {
    setEditing({
      ...c,
      id: undefined,
      label: `${c.label} (Copy)`,
      clone_from: c.id,
      bind_password: "••••••••",
    });
  };

  const handleSync = async (id: string) => {
    setSyncing(id);
    try {
      await triggerAdSync(id);
      load();
      onSave();
    } finally {
      setSyncing(null);
    }
  };

  const handleViewRuns = async (configId: string) => {
    const runs = await getAdSyncRuns(configId);
    setSelectedRuns({ configId, runs });
  };

  const handleTestConnection = async (config: Partial<AdSyncConfig>) => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAdSyncConnection(config);
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ status: "error", message: e.message || "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleRotationTest = async () => {
    if (!editing?.id) return;
    setRotationTesting(true);
    setRotationResult(null);
    try {
      const res = await testRotation(editing.id);
      setRotationResult(res);
    } catch (e: any) {
      setRotationResult({ success: false, message: e.message || "Rotation test failed" });
    } finally {
      setRotationTesting(false);
    }
  };

  const handleTestFilter = async () => {
    if (!editing) return;
    setFilterTesting(true);
    setFilterResult(null);
    try {
      const res = await testPmTargetFilter(editing);
      setFilterResult(res);
    } catch (e: any) {
      setFilterResult({ status: "error", message: e.message || "Filter test failed" });
    } finally {
      setFilterTesting(false);
    }
  };

  const folderOptions = [
    { value: "", label: "— No folder —" },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
  ];

  const presetFilters = [
    "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
    "(&(objectClass=computer)(operatingSystem=*Server*)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
    "(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
    "(&(objectClass=computer)(operatingSystem=*Server*)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
  ];

  const isPresetFilter = (f: string) => presetFilters.includes(f);

  // ── Edit / Create form ──
  if (editing) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">
          {editing.id ? "Edit AD Source" : "Add AD Source"}
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium">Label</span>
            <input
              className="input mt-1"
              value={editing.label || ""}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              placeholder="Production AD"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">LDAP URL</span>
            <input
              className="input mt-1"
              value={editing.ldap_url || ""}
              onChange={(e) => setEditing({ ...editing, ldap_url: e.target.value })}
              placeholder="ldaps://dc1.contoso.com:636"
            />
          </label>
          <label className="block col-span-2">
            <span className="text-sm font-medium">Authentication Method</span>
            <Select
              value={editing.auth_method || "simple"}
              onChange={(v) => setEditing({ ...editing, auth_method: v })}
              options={[
                { value: "simple", label: "Simple Bind (DN + Password)" },
                { value: "kerberos", label: "Kerberos Keytab" },
              ]}
            />
          </label>
          {(editing.auth_method || "simple") === "simple" ? (
            <>
              <label className="block">
                <span className="text-sm font-medium">Bind DN</span>
                <input
                  className="input mt-1"
                  value={editing.bind_dn || ""}
                  onChange={(e) => setEditing({ ...editing, bind_dn: e.target.value })}
                  placeholder="CN=svc-strata,OU=Service Accounts,DC=contoso,DC=com"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium">Bind Password</span>
                <input
                  type="password"
                  className="input mt-1"
                  value={editing.bind_password || ""}
                  onChange={(e) => setEditing({ ...editing, bind_password: e.target.value })}
                />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="text-sm font-medium">Keytab Path</span>
                <input
                  className="input mt-1"
                  value={editing.keytab_path || ""}
                  onChange={(e) => setEditing({ ...editing, keytab_path: e.target.value })}
                  placeholder="/etc/krb5/strata.keytab"
                />
                <span className="text-xs opacity-50">
                  Path inside the container — mount via Docker volume
                </span>
              </label>
              <label className="block">
                <span className="text-sm font-medium">Kerberos Principal</span>
                <input
                  className="input mt-1"
                  value={editing.krb5_principal || ""}
                  onChange={(e) => setEditing({ ...editing, krb5_principal: e.target.value })}
                  placeholder="svc-strata@CONTOSO.COM"
                />
              </label>
            </>
          )}
          <div className="block col-span-2">
            <span className="text-sm font-medium">Search Bases (OU scopes)</span>
            {(editing.search_bases || [""]).map((base, i) => (
              <div key={i} className="flex items-center gap-2 mt-1">
                <input
                  className="input flex-1"
                  value={base}
                  onChange={(e) => {
                    const next = [...(editing.search_bases || [""])];
                    next[i] = e.target.value;
                    setEditing({ ...editing, search_bases: next });
                  }}
                  placeholder="OU=Servers,DC=contoso,DC=com"
                />
                {(editing.search_bases || [""]).length > 1 && (
                  <button
                    type="button"
                    className="text-red-400 hover:text-red-300 text-sm px-1"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        search_bases: (editing.search_bases || [""]).filter((_, j) => j !== i),
                      })
                    }
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="text-xs text-blue-400 hover:underline mt-1"
              onClick={() =>
                setEditing({ ...editing, search_bases: [...(editing.search_bases || [""]), ""] })
              }
            >
              + Add Search Base
            </button>
          </div>
          <label className="block">
            <span className="text-sm font-medium">Search Filter</span>
            <Select
              value={
                isPresetFilter(editing.search_filter || "")
                  ? editing.search_filter || "(objectClass=computer)"
                  : "_custom"
              }
              onChange={(v) => {
                if (v === "_custom") {
                  setEditing({ ...editing, search_filter: editing.search_filter || "" });
                } else {
                  setEditing({ ...editing, search_filter: v });
                }
              }}
              options={[
                {
                  value:
                    "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
                  label: "All Computers",
                },
                {
                  value:
                    "(&(objectClass=computer)(operatingSystem=*Server*)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
                  label: "Servers Only",
                },
                {
                  value:
                    "(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
                  label: "Enabled Computers Only",
                },
                {
                  value:
                    "(&(objectClass=computer)(operatingSystem=*Server*)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
                  label: "Enabled Servers Only",
                },
                { value: "_custom", label: "Custom Filter..." },
              ]}
            />
            {!isPresetFilter(editing.search_filter || "") && (
              <input
                className="input mt-1"
                value={editing.search_filter || ""}
                onChange={(e) => setEditing({ ...editing, search_filter: e.target.value })}
                placeholder="(&(objectClass=computer)(name=SRV*))"
              />
            )}
          </label>
          <label className="block">
            <span className="text-sm font-medium">Search Scope</span>
            <Select
              value={editing.search_scope || "subtree"}
              onChange={(v) => setEditing({ ...editing, search_scope: v })}
              options={[
                { value: "subtree", label: "Subtree" },
                { value: "onelevel", label: "One Level" },
                { value: "base", label: "Base" },
              ]}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Protocol</span>
            <Select
              value={editing.protocol || "rdp"}
              onChange={(v) => setEditing({ ...editing, protocol: v })}
              options={[
                { value: "rdp", label: "RDP" },
                { value: "ssh", label: "SSH" },
                { value: "vnc", label: "VNC" },
              ]}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Default Port</span>
            <input
              type="number"
              className="input mt-1"
              value={editing.default_port ?? 3389}
              onChange={(e) => setEditing({ ...editing, default_port: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Domain Override</span>
            <input
              className="input mt-1"
              value={editing.domain_override || ""}
              onChange={(e) =>
                setEditing({ ...editing, domain_override: e.target.value || undefined })
              }
              placeholder="Optional — force domain on connections"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Connection Folder</span>
            <Select
              value={editing.folder_id || ""}
              onChange={(v) => setEditing({ ...editing, folder_id: v || undefined })}
              options={folderOptions}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Sync Interval (minutes)</span>
            <input
              type="number"
              className="input mt-1"
              min={5}
              value={editing.sync_interval_minutes ?? 60}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  sync_interval_minutes: Math.max(5, Number(e.target.value)),
                })
              }
            />
          </label>
          <label className="flex items-center gap-2 mt-6">
            <input
              type="checkbox"
              className="checkbox"
              checked={editing.tls_skip_verify ?? false}
              onChange={(e) => setEditing({ ...editing, tls_skip_verify: e.target.checked })}
            />
            <span className="text-sm">Skip TLS verification</span>
          </label>
          <label className="flex items-center gap-2 mt-6">
            <input
              type="checkbox"
              className="checkbox"
              checked={editing.enabled ?? true}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            <span className="text-sm">Enabled</span>
          </label>
          {!editing.tls_skip_verify && (
            <div className="block col-span-2">
              <span className="text-sm font-medium">CA Certificate (PEM)</span>
              <div className="flex items-center gap-2 mt-1">
                <input
                  ref={certFileRef}
                  type="file"
                  accept=".pem,.crt,.cer"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onload = () =>
                        setEditing({ ...editing, ca_cert_pem: reader.result as string });
                      reader.readAsText(file);
                    }
                    if (certFileRef.current) certFileRef.current.value = "";
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => certFileRef.current?.click()}
                >
                  {editing.ca_cert_pem ? "↻ Replace Certificate" : "Upload Certificate"}
                </button>
                {editing.ca_cert_pem && (
                  <>
                    <span className="text-sm text-green-400">✓ Certificate loaded</span>
                    <button
                      type="button"
                      className="text-sm text-red-400 hover:underline"
                      onClick={() => setEditing({ ...editing, ca_cert_pem: "" })}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              <span className="text-xs opacity-50">
                Optional — upload your internal CA certificate for LDAPS with self-signed
                certificates
              </span>
            </div>
          )}
        </div>

        {/* ── Connection Defaults ── */}
        <div className="mt-6 border-t border-border/20 pt-4">
          <h4 className="text-sm font-semibold uppercase tracking-wider mb-3">
            Connection Defaults
          </h4>
          <p className="text-xs opacity-50 mb-4">
            These settings are applied to every connection created or updated by this sync source.
          </p>

          {(editing.protocol || "rdp") === "rdp" && (
            <>
              <div className="text-xs font-semibold uppercase tracking-wider opacity-60 mb-2">
                RDP Basic Settings
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-4">
                <div className="form-group !mb-0">
                  <label title="The server-side keyboard layout. This is the layout of the RDP server and determines how keystrokes are interpreted.">
                    Keyboard Layout
                  </label>
                  <Select
                    value={(editing.connection_defaults ?? {})["server-layout"] || ""}
                    onChange={(v) => {
                      const cd = { ...(editing.connection_defaults ?? {}) };
                      if (v) cd["server-layout"] = v;
                      else delete cd["server-layout"];
                      setEditing({ ...editing, connection_defaults: cd });
                    }}
                    placeholder="Default (US English)"
                    options={RDP_KEYBOARD_LAYOUTS}
                  />
                </div>
                <div className="form-group !mb-0">
                  <label title="The timezone that the client should send to the server for configuring the local time display, in IANA format (e.g. America/New_York).">
                    Timezone
                  </label>
                  <Select
                    value={(editing.connection_defaults ?? {})["timezone"] || ""}
                    onChange={(v) => {
                      const cd = { ...(editing.connection_defaults ?? {}) };
                      if (v) cd["timezone"] = v;
                      else delete cd["timezone"];
                      setEditing({ ...editing, connection_defaults: cd });
                    }}
                    placeholder="System default"
                    options={[
                      { value: "", label: "System default" },
                      ...getTimezones().map((tz) => ({ value: tz, label: tz })),
                    ]}
                  />
                </div>
              </div>

              <div className="text-xs font-semibold uppercase tracking-wider opacity-60 mb-2">
                RDP Display &amp; Performance
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-4">
                {(
                  [
                    [
                      "ignore-cert",
                      "Ignore server certificate",
                      "Ignore the certificate returned by the server, even if it cannot be validated. Useful when connecting to servers with self-signed certificates.",
                    ],
                    [
                      "enable-wallpaper",
                      "Enable wallpaper",
                      "Enables rendering of the desktop wallpaper. By default wallpaper is disabled to reduce bandwidth usage.",
                    ],
                    [
                      "enable-font-smoothing",
                      "Enable font smoothing",
                      "Renders text with smooth edges (ClearType). By default text is rendered with rough edges to reduce bandwidth.",
                    ],
                    [
                      "enable-desktop-composition",
                      "Enable desktop composition",
                      "Allows graphical effects such as transparent windows and shadows (Aero). Disabled by default.",
                    ],
                    [
                      "enable-theming",
                      "Enable theming",
                      "Enables use of theming of windows and controls. By default theming within RDP sessions is disabled.",
                    ],
                    [
                      "enable-full-window-drag",
                      "Enable full-window drag",
                      "Displays window contents as windows are moved. By default only the window border is drawn while dragging.",
                    ],
                    [
                      "enable-menu-animations",
                      "Enable menu animations",
                      "Allows menu open and close animations. Disabled by default.",
                    ],
                    [
                      "disable-bitmap-caching",
                      "Disable bitmap caching",
                      "Disables RDP's built-in bitmap caching. Usually only needed to work around bugs in specific RDP server implementations.",
                    ],
                    [
                      "disable-glyph-caching",
                      "Disable glyph caching",
                      "Disables caching of frequently used symbols and fonts (glyphs). Usually only needed to work around bugs in specific RDP implementations.",
                    ],
                    [
                      "disable-offscreen-caching",
                      "Disable offscreen caching",
                      "Disables caching of off-screen regions. RDP normally caches regions not currently visible to accelerate retrieval when they come into view.",
                    ],
                    [
                      "disable-gfx",
                      "Disable graphics pipeline (GFX)",
                      "Disables the Graphics Pipeline Extension (GFX) which accelerates display rendering. Enabled by default; disable if the server does not support it.",
                    ],
                  ] as [string, string, string][]
                ).map(([param, label, tooltip]) => (
                  <label key={param} className="flex items-center gap-2" title={tooltip}>
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={(editing.connection_defaults ?? {})[param] === "true"}
                      onChange={(e) => {
                        const cd = { ...(editing.connection_defaults ?? {}) };
                        if (e.target.checked) {
                          cd[param] = "true";
                        } else {
                          delete cd[param];
                        }
                        setEditing({ ...editing, connection_defaults: cd });
                      }}
                    />
                    <span className="text-sm">{label}</span>
                    <svg
                      className="w-3.5 h-3.5 opacity-40 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="12" cy="12" r="10" strokeWidth="2" />
                      <path strokeLinecap="round" strokeWidth="2" d="M12 16v-4m0-4h.01" />
                    </svg>
                  </label>
                ))}
              </div>

              <div className="text-xs font-semibold uppercase tracking-wider opacity-60 mb-2 mt-4">
                Session Recording
              </div>
              <p className="text-xs opacity-50 mb-2">
                Recording path and filename are managed automatically by the system.
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                {(
                  [
                    [
                      "recording-include-keys",
                      "Include key events",
                      "Include user key events in the recording. Can be interpreted with the guaclog utility to produce a human-readable log of keys pressed.",
                    ],
                    [
                      "recording-exclude-mouse",
                      "Exclude mouse events",
                      "Exclude user mouse events from the recording, producing a recording without a visible mouse cursor.",
                    ],
                    [
                      "recording-exclude-touch",
                      "Exclude touch events",
                      "Exclude user touch events from the recording.",
                    ],
                    [
                      "recording-exclude-output",
                      "Exclude graphical output",
                      "Exclude graphical output from the recording, producing a recording that contains only user input events.",
                    ],
                  ] as [string, string, string][]
                ).map(([param, label, tooltip]) => (
                  <label key={param} className="flex items-center gap-2" title={tooltip}>
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={(editing.connection_defaults ?? {})[param] === "true"}
                      onChange={(e) => {
                        const cd = { ...(editing.connection_defaults ?? {}) };
                        if (e.target.checked) {
                          cd[param] = "true";
                        } else {
                          delete cd[param];
                        }
                        setEditing({ ...editing, connection_defaults: cd });
                      }}
                    />
                    <span className="text-sm">{label}</span>
                    <svg
                      className="w-3.5 h-3.5 opacity-40 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="12" cy="12" r="10" strokeWidth="2" />
                      <path strokeLinecap="round" strokeWidth="2" d="M12 16v-4m0-4h.01" />
                    </svg>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Password Management ── */}
        <div className="mt-6 border-t border-border/20 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold uppercase tracking-wider">Password Management</h4>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="checkbox"
                checked={editing.pm_enabled ?? false}
                onChange={(e) => setEditing({ ...editing, pm_enabled: e.target.checked })}
              />
              Enable
            </label>
          </div>

          {editing.pm_enabled && (
            <div className="space-y-4">
              {/* Credential source */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Service Account Credentials
                </span>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      className="radio"
                      name="pm_cred_source"
                      checked={!editing.pm_bind_user}
                      onChange={() =>
                        setEditing({
                          ...editing,
                          pm_bind_user: undefined,
                          pm_bind_password: undefined,
                        })
                      }
                    />
                    Use this AD source&apos;s bind credentials
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      className="radio"
                      name="pm_cred_source"
                      checked={editing.pm_bind_user != null && editing.pm_bind_user !== undefined}
                      onChange={() =>
                        setEditing({
                          ...editing,
                          pm_bind_user: editing.pm_bind_user || "",
                          pm_bind_password: editing.pm_bind_password || "",
                        })
                      }
                    />
                    Use separate credentials for password management
                  </label>
                </div>
                {editing.pm_bind_user != null && editing.pm_bind_user !== undefined && (
                  <div className="grid grid-cols-2 gap-4 mt-2 ml-6">
                    <label className="block">
                      <span className="text-xs font-medium">PM Bind DN</span>
                      <input
                        className="input mt-1"
                        value={editing.pm_bind_user || ""}
                        onChange={(e) => setEditing({ ...editing, pm_bind_user: e.target.value })}
                        placeholder="CN=PMServiceAcct,OU=Service Accounts,DC=contoso,DC=com"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium">PM Bind Password</span>
                      <input
                        className="input mt-1"
                        type="password"
                        value={editing.pm_bind_password || ""}
                        onChange={(e) =>
                          setEditing({ ...editing, pm_bind_password: e.target.value })
                        }
                        placeholder="••••••••"
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* PM Search Bases */}
              <div className="block">
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Search Base OUs (Optional)
                </span>
                <p className="text-xs opacity-50 mb-2">
                  If specified, user discovery for password management will be restricted to these
                  OUs. Otherwise, the main AD sync search bases are used.
                </p>
                {(editing.pm_search_bases || [""]).map((base: string, i: number) => (
                  <div key={i} className="flex items-center gap-2 mt-1">
                    <input
                      className="input flex-1"
                      value={base}
                      onChange={(e) => {
                        const next = [...(editing.pm_search_bases || [""])];
                        next[i] = e.target.value;
                        setEditing({ ...editing, pm_search_bases: next });
                      }}
                      placeholder="OU=Managed Users,DC=example,DC=local"
                    />
                    {(editing.pm_search_bases || [""]).length > 1 && (
                      <button
                        type="button"
                        className="text-red-400 hover:text-red-300 text-sm px-1 font-bold"
                        onClick={() =>
                          setEditing({
                            ...editing,
                            pm_search_bases: (editing.pm_search_bases || [""]).filter(
                              (_: string, j: number) => j !== i
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="text-xs text-blue-400 hover:underline mt-1"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      pm_search_bases: [...(editing.pm_search_bases || [""]), ""],
                    })
                  }
                >
                  + Add PM Search Base
                </button>
              </div>

              {/* Target filter */}
              <div>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider opacity-60">
                    Target Account Filter
                  </span>
                  <div className="flex gap-2 mt-1">
                    <input
                      className="input flex-1"
                      value={
                        editing.pm_target_filter || "(&(objectCategory=person)(objectClass=user))"
                      }
                      onChange={(e) => setEditing({ ...editing, pm_target_filter: e.target.value })}
                      placeholder="(&(objectCategory=person)(objectClass=user))"
                    />
                    <button
                      className="btn btn-sm btn-secondary whitespace-nowrap"
                      disabled={filterTesting}
                      onClick={(e) => {
                        e.preventDefault();
                        handleTestFilter();
                      }}
                    >
                      {filterTesting ? "Searching..." : "🔍 Preview"}
                    </button>
                  </div>
                  <span className="text-xs opacity-50">
                    LDAP filter to discover managed accounts for password checkout
                  </span>
                </label>
                {filterResult && (
                  <div
                    className={`mt-2 p-3 rounded-lg border text-sm ${filterResult.status === "success" ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span>{filterResult.status === "success" ? "✅" : "❌"}</span>
                      <span className="font-medium">{filterResult.message}</span>
                    </div>
                    {filterResult.hint && (
                      <div className="mt-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/20 text-yellow-200/90 text-xs leading-relaxed">
                        <span className="font-semibold">💡 </span>
                        {filterResult.hint}
                      </div>
                    )}
                    {filterResult.sample && filterResult.sample.length > 0 && (
                      <div className="mt-2 max-h-48 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left opacity-60">
                              <th className="pb-1 pr-4">Account Name</th>
                              <th className="pb-1 pr-4">Distinguished Name</th>
                              <th className="pb-1">Description</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filterResult.sample.map((u, i) => (
                              <tr key={i} className="border-t border-border/10">
                                <td className="py-1 pr-4 font-medium">{u.name}</td>
                                <td className="py-1 pr-4 opacity-70 break-all">{u.dn}</td>
                                <td className="py-1 opacity-50">{u.description || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {(filterResult.count ?? 0) > 25 && (
                          <p className="mt-1 text-xs opacity-50">
                            Showing first 25 of {filterResult.count} accounts
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Password policy */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Password Generation Policy
                </span>
                <p className="text-xs opacity-50 mb-2">
                  Generated passwords will comply with these rules so they are accepted by Active
                  Directory.
                </p>
                <div className="flex items-center gap-4 mb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-xs font-medium">Minimum Length</span>
                    <input
                      type="number"
                      className="input w-20"
                      min={8}
                      max={128}
                      value={editing.pm_pwd_min_length ?? 16}
                      onChange={(e) =>
                        setEditing({ ...editing, pm_pwd_min_length: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  {(
                    [
                      ["pm_pwd_require_uppercase", "Require uppercase (A-Z)"],
                      ["pm_pwd_require_lowercase", "Require lowercase (a-z)"],
                      ["pm_pwd_require_numbers", "Require numbers (0-9)"],
                      ["pm_pwd_require_symbols", "Require special characters (!@#$...)"],
                    ] as [keyof AdSyncConfig, string][]
                  ).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={(editing[key] as boolean) ?? true}
                        onChange={(e) => setEditing({ ...editing, [key]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Auto-rotation */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Service Account Auto-Rotation (Zero-Knowledge)
                </span>
                <p className="text-xs opacity-50 mb-2">
                  When enabled, the service account will automatically rotate its own password on a
                  schedule. The new password is sealed in Vault — no human ever sees it.
                </p>
                <label className="flex items-center gap-2 text-sm mb-2">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={editing.pm_auto_rotate_enabled ?? false}
                    onChange={(e) =>
                      setEditing({ ...editing, pm_auto_rotate_enabled: e.target.checked })
                    }
                  />
                  Enable automatic rotation
                </label>
                {editing.pm_auto_rotate_enabled && (
                  <div className="flex items-center gap-4 ml-6 mb-2">
                    <label className="flex items-center gap-2 text-sm">
                      <span className="text-xs font-medium">Rotation interval (days)</span>
                      <input
                        type="number"
                        className="input w-20"
                        min={1}
                        max={365}
                        value={editing.pm_auto_rotate_interval_days ?? 30}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            pm_auto_rotate_interval_days: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                {editing.id && (
                  <div className="flex items-center gap-3 mt-3">
                    <button
                      className="btn btn-sm btn-secondary"
                      disabled={rotationTesting}
                      onClick={handleRotationTest}
                    >
                      {rotationTesting ? "Testing..." : "🔄 Test Rotation & Capabilities"}
                    </button>
                    {editing.pm_last_rotated_at && (
                      <span className="text-xs text-txt-secondary">
                        Last rotated: {formatDateTime(editing.pm_last_rotated_at)}
                      </span>
                    )}
                  </div>
                )}
                {rotationResult && (
                  <div
                    className={`mt-2 p-3 rounded text-sm ${rotationResult.success ? "bg-green-500/10 text-green-400 border border-green-500/30" : "bg-red-500/10 text-red-400 border border-red-500/30"}`}
                  >
                    {rotationResult.message}
                  </div>
                )}
              </div>

              {/* Emergency Approval Bypass */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Emergency Approval Bypass (Break-Glass)
                </span>
                <p className="text-xs opacity-50 mb-2">
                  When enabled, users who normally require approval may flag a checkout request as
                  an emergency to receive the password immediately without waiting for an approver.
                  Every use is recorded in the audit log and requires a justification.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={editing.pm_allow_emergency_bypass ?? false}
                    onChange={(e) =>
                      setEditing({ ...editing, pm_allow_emergency_bypass: e.target.checked })
                    }
                  />
                  Allow emergency bypass on password checkout requests
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-6">
          <button className="btn btn-primary" onClick={handleSave}>
            Save
          </button>
          <button
            className="btn btn-secondary"
            disabled={testing}
            onClick={() => handleTestConnection(editing)}
          >
            {testing ? "Testing..." : "⚡ Test Connection"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setEditing(null);
              setTestResult(null);
            }}
          >
            Cancel
          </button>
        </div>
        {testResult && (
          <div
            className={`mt-3 p-3 rounded text-sm ${testResult.status === "success" ? "bg-green-500/10 text-green-400 border border-green-500/30" : "bg-red-500/10 text-red-400 border border-red-500/30"}`}
          >
            <div>{testResult.message}</div>
            {testResult.sample && testResult.sample.length > 0 && (
              <div className="mt-2 text-xs opacity-80">
                <div className="font-medium mb-1">
                  Preview (first {testResult.sample.length}
                  {testResult.count && testResult.count > testResult.sample.length
                    ? ` of ${testResult.count}`
                    : ""}
                  ):
                </div>
                <ul className="list-disc list-inside space-y-0.5">
                  {testResult.sample.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Sync history overlay ──
  if (selectedRuns) {
    const cfg = configs.find((c) => c.id === selectedRuns.configId);
    return (
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Sync History — {cfg?.label}</h3>
          <button className="btn btn-secondary btn-sm" onClick={() => setSelectedRuns(null)}>
            ← Back
          </button>
        </div>
        {selectedRuns.runs.length === 0 ? (
          <p className="text-sm opacity-60">No sync runs yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Updated</th>
                  <th>Soft-Deleted</th>
                  <th>Hard-Deleted</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {selectedRuns.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateTime(r.started_at)}</td>
                    <td>
                      <span
                        className={`badge ${r.status === "success" ? "badge-success" : r.status === "error" ? "badge-error" : "badge-warning"}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td>{r.created}</td>
                    <td>{r.updated}</td>
                    <td>{r.soft_deleted}</td>
                    <td>{r.hard_deleted}</td>
                    <td className="max-w-xs truncate">{r.error_message || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ── Config list ──
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/30 border border-border/50 rounded-lg">
        <div>
          <h3 className="text-base font-semibold text-txt-primary">AD Sync Sources</h3>
          <p className="text-sm text-txt-secondary mt-1 max-w-2xl">
            Import connections from Active Directory via LDAP. Objects that disappear are
            soft-deleted for 7 days.
          </p>
        </div>
        <button
          className="btn-sm-primary"
          onClick={() =>
            setEditing({
              search_bases: [""],
              search_filter:
                "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
              search_scope: "subtree",
              protocol: "rdp",
              default_port: 3389,
              sync_interval_minutes: 60,
              enabled: true,
              auth_method: "simple",
            })
          }
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Source
        </button>
      </div>

      {configs.length === 0 ? (
        <div className="card text-center py-12 opacity-60">
          <p className="text-lg mb-2">No AD sync sources configured</p>
          <p className="text-sm">
            Add an Active Directory source to start importing connections automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((c) => (
            <div key={c.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold">{c.label}</h4>
                    <span
                      className={`badge text-xs ${c.enabled ? "badge-success" : "badge-error"}`}
                    >
                      {c.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <p className="text-sm opacity-70 mt-1">{c.ldap_url}</p>
                  <p className="text-xs opacity-50 mt-1">
                    Auth: {c.auth_method === "kerberos" ? "Kerberos Keytab" : "Simple Bind"}
                    {c.ca_cert_pem
                      ? " · CA Cert ✓"
                      : c.tls_skip_verify
                        ? " · TLS Skip Verify"
                        : ""}{" "}
                    · Base: <code>{(c.search_bases || []).join(", ") || "—"}</code> · Filter:{" "}
                    <code>{c.search_filter}</code> · Protocol: {c.protocol.toUpperCase()} · Every{" "}
                    {c.sync_interval_minutes}m
                  </p>
                </div>
                <div className="flex gap-2 shrink-0 ml-4">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={syncing === c.id}
                    onClick={() => handleSync(c.id)}
                  >
                    {syncing === c.id ? "Syncing..." : "⟳ Sync Now"}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleViewRuns(c.id)}>
                    History
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleClone(c)}>
                    Clone
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(c)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-secondary btn-sm text-red-500"
                    onClick={() => handleDelete(c.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tags Tab ───────────────────────────────────────────────────────────

const ADMIN_TAG_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
];

function TagsTab({ connections, onSave }: { connections: Connection[]; onSave: () => void }) {
  const [tags, setTags] = useState<UserTag[]>([]);
  const [connTagMap, setConnTagMap] = useState<Record<string, string[]>>({});
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(ADMIN_TAG_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [assignTag, setAssignTag] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([getAdminTagsAdmin(), getAdminConnectionTagsAdmin()]);
      setTags(t);
      setConnTagMap(m);
    } catch {
      setError("Failed to load tags");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    setError("");
    try {
      const tag = await createAdminTag(newName.trim(), newColor);
      setTags((prev) => [...prev, tag]);
      setNewName("");
      setNewColor(ADMIN_TAG_COLORS[(tags.length + 1) % ADMIN_TAG_COLORS.length]);
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create tag");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (id: string) => {
    setSaving(true);
    setError("");
    try {
      const tag = await updateAdminTag(id, {
        name: editName.trim() || undefined,
        color: editColor || undefined,
      });
      setTags((prev) => prev.map((t) => (t.id === id ? tag : t)));
      setEditingId(null);
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update tag");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setSaving(true);
    setError("");
    try {
      await deleteAdminTag(id);
      setTags((prev) => prev.filter((t) => t.id !== id));
      setConnTagMap((prev) => {
        const next = { ...prev };
        for (const connId of Object.keys(next)) {
          next[connId] = next[connId].filter((tid) => tid !== id);
        }
        return next;
      });
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete tag");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleConnection = async (tagId: string, connId: string) => {
    const current = connTagMap[connId] || [];
    const next = current.includes(tagId) ? current.filter((t) => t !== tagId) : [...current, tagId];
    try {
      await setAdminConnectionTags(connId, next);
      setConnTagMap((prev) => ({ ...prev, [connId]: next }));
    } catch {
      /* ignore */
    }
  };

  // Connections that have the currently-assigning tag
  const assignedConnIds = assignTag
    ? new Set(
        Object.entries(connTagMap)
          .filter(([, tids]) => tids.includes(assignTag))
          .map(([cid]) => cid)
      )
    : new Set<string>();

  return (
    <div className="card">
      <h3>Global Tags</h3>
      <p className="text-[0.8125rem] text-txt-secondary mb-4">
        Create tags that are visible to all users across the dashboard. Assign them to connections
        to help users organise their view.
      </p>

      {error && (
        <div className="rounded-md mb-3 px-3 py-2 bg-danger/10 text-danger text-[0.8125rem]">
          {error}
        </div>
      )}

      {/* Create new tag */}
      <div className="flex gap-2 items-end mb-6">
        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
          <label>Tag Name</label>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Production, Staging, Critical"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Color</label>
          <div className="flex gap-1">
            {ADMIN_TAG_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setNewColor(c)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: c,
                  border: newColor === c ? "2px solid white" : "2px solid transparent",
                  boxShadow: newColor === c ? `0 0 0 2px ${c}` : "none",
                  cursor: "pointer",
                }}
              />
            ))}
          </div>
        </div>
        <button
          className="btn-sm-primary"
          onClick={handleCreate}
          disabled={saving || !newName.trim()}
        >
          Create Tag
        </button>
      </div>

      {/* Tag list */}
      {tags.length === 0 ? (
        <p className="text-txt-tertiary text-[0.8125rem]">No global tags created yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tag</th>
              <th>Connections</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => {
              const connCount = Object.values(connTagMap).filter((tids) =>
                tids.includes(tag.id)
              ).length;
              const isEditing = editingId === tag.id;
              return (
                <tr key={tag.id}>
                  <td>
                    {isEditing ? (
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="text-[0.8125rem] !py-1"
                          style={{ maxWidth: 160 }}
                          onKeyDown={(e) => e.key === "Enter" && handleUpdate(tag.id)}
                        />
                        <div className="flex gap-1">
                          {ADMIN_TAG_COLORS.map((c) => (
                            <button
                              key={c}
                              onClick={() => setEditColor(c)}
                              style={{
                                width: 18,
                                height: 18,
                                borderRadius: "50%",
                                background: c,
                                border:
                                  editColor === c ? "2px solid white" : "1px solid transparent",
                                boxShadow: editColor === c ? `0 0 0 1px ${c}` : "none",
                                cursor: "pointer",
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[0.8125rem]">
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            background: tag.color,
                            display: "inline-block",
                          }}
                        />
                        {tag.name}
                      </span>
                    )}
                  </td>
                  <td className="text-[0.8125rem] text-txt-secondary">
                    {connCount} connection{connCount !== 1 ? "s" : ""}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {isEditing ? (
                        <>
                          <button
                            className="btn-sm text-xs"
                            onClick={() => handleUpdate(tag.id)}
                            disabled={saving}
                          >
                            Save
                          </button>
                          <button className="btn-sm text-xs" onClick={() => setEditingId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className={`btn-sm text-xs ${assignTag === tag.id ? "!border-accent !text-accent" : ""}`}
                            onClick={() => setAssignTag(assignTag === tag.id ? null : tag.id)}
                          >
                            Assign
                          </button>
                          <button
                            className="btn-sm text-xs"
                            onClick={() => {
                              setEditingId(tag.id);
                              setEditName(tag.name);
                              setEditColor(tag.color);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="btn-sm text-xs text-danger"
                            onClick={() => handleDelete(tag.id)}
                            disabled={saving}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Connection assignment panel */}
      {assignTag && (
        <div className="mt-4 card" style={{ background: "var(--color-surface-secondary)" }}>
          <h4 className="text-[0.875rem] mb-2">
            Assign &ldquo;{tags.find((t) => t.id === assignTag)?.name}&rdquo; to connections
          </h4>
          <div style={{ maxHeight: 300, overflow: "auto" }}>
            {connections.length === 0 ? (
              <p className="text-txt-tertiary text-[0.8125rem]">No connections available.</p>
            ) : (
              connections.map((conn) => (
                <label
                  key={conn.id}
                  className="flex items-center gap-2 py-1 cursor-pointer text-[0.8125rem]"
                >
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={assignedConnIds.has(conn.id)}
                    onChange={() => handleToggleConnection(assignTag, conn.id)}
                  />
                  <span
                    className="badge badge-accent text-[0.625rem]"
                    style={{ padding: "1px 6px" }}
                  >
                    {conn.protocol.toUpperCase()}
                  </span>
                  {conn.name}
                  <span className="text-txt-tertiary ml-auto">
                    {conn.hostname}:{conn.port}
                  </span>
                </label>
              ))
            )}
          </div>
          <button className="btn-sm mt-3" onClick={() => setAssignTag(null)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}

// ── Security Tab ───────────────────────────────────────────────────────

function SecurityTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    isDangerous?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [watermarkEnabled, setWatermarkEnabled] = useState(settings.watermark_enabled === "true");
  const [ssoEnabled, setSsoEnabled] = useState(settings.sso_enabled === "true");
  const [localAuthEnabled, setLocalAuthEnabled] = useState(
    settings.local_auth_enabled === undefined ? true : settings.local_auth_enabled === "true"
  );
  const [userHardDeleteDays, setUserHardDeleteDays] = useState(
    settings.user_hard_delete_days || "90"
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWatermarkEnabled(settings.watermark_enabled === "true");
    setSsoEnabled(settings.sso_enabled === "true");
    setLocalAuthEnabled(
      settings.local_auth_enabled === undefined ? true : settings.local_auth_enabled === "true"
    );
    setUserHardDeleteDays(settings.user_hard_delete_days || "90");
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    try {
      // Validate hard-delete window: positive integer, 1..3650 (10 years).
      const parsedDays = parseInt(userHardDeleteDays, 10);
      if (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > 3650) {
        throw new Error("User hard-delete window must be between 1 and 3650 days.");
      }

      // Update general security settings
      await updateSettings([
        { key: "watermark_enabled", value: String(watermarkEnabled) },
        { key: "user_hard_delete_days", value: String(parsedDays) },
      ]);

      // Update authentication methods (dedicated endpoint with validation)
      await updateAuthMethods({
        sso_enabled: ssoEnabled,
        local_auth_enabled: localAuthEnabled,
      });

      onSave();
    } catch {
      /* handled by parent */
    }
    setSaving(false);
  }

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Security Settings</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Configure global security policies and authentication methods.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Authentication Methods
          </h4>
          <div className="space-y-5">
            <div className="form-group">
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={localAuthEnabled}
                  onChange={(e) => {
                    const val = e.target.checked;
                    if (!val && !ssoEnabled) return; // Prevent disabling both
                    setLocalAuthEnabled(val);
                  }}
                  className="checkbox"
                />
                <div>
                  <span className="font-medium group-hover:text-txt-primary transition-colors">
                    Local Authentication
                  </span>
                  <p className="text-txt-secondary text-sm mt-0.5">
                    Allow users to log in with a username and password stored in the local database.
                  </p>
                </div>
              </label>
            </div>

            <div className="form-group">
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={ssoEnabled}
                  onChange={(e) => {
                    const val = e.target.checked;
                    if (!val && !localAuthEnabled) return; // Prevent disabling both
                    setSsoEnabled(val);
                  }}
                  className="checkbox"
                />
                <div>
                  <span className="font-medium group-hover:text-txt-primary transition-colors">
                    SSO / OIDC (Keycloak)
                  </span>
                  <p className="text-txt-secondary text-sm mt-0.5">
                    Enable Single Sign-On via OpenID Connect. Ensure you have configured the
                    provider settings in the SSO tab.
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-border/10">
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Session Protection
          </h4>
          <div className="form-group">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={watermarkEnabled}
                onChange={(e) => setWatermarkEnabled(e.target.checked)}
                className="checkbox"
              />
              <div>
                <span className="font-medium group-hover:text-txt-primary transition-colors">
                  Session Watermark
                </span>
                <p className="text-txt-secondary text-sm mt-0.5">
                  Overlay a semi-transparent watermark on all active sessions showing the user's
                  name, IP address, and timestamp. Helps deter unauthorized screen capture.
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="pt-6 border-t border-border/10">
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Data Retention
          </h4>
          <div className="form-group">
            <label htmlFor="user-hard-delete-days" className="block font-medium mb-1">
              User hard-delete window (days)
            </label>
            <input
              id="user-hard-delete-days"
              type="number"
              min={1}
              max={3650}
              value={userHardDeleteDays}
              onChange={(e) => setUserHardDeleteDays(e.target.value)}
              className="w-32"
            />
            <p className="text-txt-secondary text-sm mt-1">
              Number of days a soft-deleted user remains recoverable before the background
              cleanup task permanently removes their record and any associated session
              recordings. Defaults to 90 days. Must be between 1 and 3650.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-border/10">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Security Settings"}
        </button>
      </div>
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

// ── Network / DNS Tab ───────────────────────────────────────────────

function NetworkTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [dnsEnabled, setDnsEnabled] = useState(settings.dns_enabled === "true");
  const [dnsServers, setDnsServers] = useState(settings.dns_servers || "");
  const [dnsSearchDomains, setDnsSearchDomains] = useState(settings.dns_search_domains || "");
  const [saving, setSaving] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);

  useEffect(() => {
    setDnsEnabled(settings.dns_enabled === "true");
    setDnsServers(settings.dns_servers || "");
    setDnsSearchDomains(settings.dns_search_domains || "");
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    setRestartNeeded(false);
    try {
      const res = await updateDns({
        dns_enabled: dnsEnabled,
        dns_servers: dnsServers.trim(),
        dns_search_domains: dnsSearchDomains.trim(),
      });
      if (res.restart_required) setRestartNeeded(true);
      onSave();
    } catch {
      /* handled by parent */
    }
    setSaving(false);
  }

  // Simple client-side validation of DNS server entries
  function validateServers(): string | null {
    if (!dnsEnabled || !dnsServers.trim()) return null;
    const entries = dnsServers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of entries) {
      // Accept ip or ip:port
      const ipPortMatch = entry.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?$/);
      if (!ipPortMatch) return `Invalid DNS server address: "${entry}". Use IP or IP:port format.`;
      const octets = ipPortMatch[1].split(".").map(Number);
      if (octets.some((o) => o > 255)) return `Invalid IP address: "${ipPortMatch[1]}"`;
      if (ipPortMatch[2] && (Number(ipPortMatch[2]) < 1 || Number(ipPortMatch[2]) > 65535)) {
        return `Invalid port number: "${ipPortMatch[2]}"`;
      }
    }
    return null;
  }

  const validationError = validateServers();

  // Validate search domains (alphanumeric + dots + hyphens, max 6)
  function validateSearchDomains(): string | null {
    if (!dnsEnabled || !dnsSearchDomains.trim()) return null;
    const domains = dnsSearchDomains
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (domains.length > 6) return "resolv.conf supports at most 6 search domains.";
    for (const d of domains) {
      if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(d)) {
        return `Invalid domain: "${d}". Use only letters, numbers, dots, and hyphens.`;
      }
    }
    return null;
  }

  const searchDomainError = validateSearchDomains();

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Network &amp; DNS Settings</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Configure custom DNS servers for the guacd proxy containers. This is required when
            target servers use internal DNS zones (e.g. <code>.dmz.local</code>) that Docker's
            built-in DNS cannot resolve.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Custom DNS Servers
          </h4>
          <p className="text-sm text-txt-secondary mb-4">
            When enabled, your DNS server IPs are applied to the guacd containers so they can
            resolve internal hostnames the same way your host operating system does. This preserves
            hostname-based authentication (including Kerberos/NLA).
          </p>
          <div className="form-group">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={dnsEnabled}
                onChange={(e) => {
                  setDnsEnabled(e.target.checked);
                  setRestartNeeded(false);
                }}
                className="checkbox"
              />
              <div>
                <span className="font-medium group-hover:text-txt-primary transition-colors">
                  Enable Custom DNS
                </span>
                <p className="text-txt-secondary text-sm mt-0.5">
                  Apply custom nameservers to the guacd proxy containers.
                </p>
              </div>
            </label>
          </div>
        </div>

        {dnsEnabled && (
          <div className="pt-6 border-t border-border/10">
            <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
              DNS Servers
            </h4>
            <div className="form-group">
              <label className="form-label">DNS Server Addresses</label>
              <input
                className="input"
                value={dnsServers}
                onChange={(e) => {
                  setDnsServers(e.target.value);
                  setRestartNeeded(false);
                }}
                placeholder="e.g. 10.179.46.52, 10.179.46.53"
              />
              <p className="text-sm text-txt-secondary mt-1">
                Comma-separated list of DNS server IP addresses (typically your corporate / Active
                Directory DNS servers).
              </p>
              {validationError && <p className="text-sm text-danger mt-1">{validationError}</p>}
            </div>

            <div className="form-group mt-6">
              <label className="form-label">Search Domains</label>
              <input
                className="input"
                value={dnsSearchDomains}
                onChange={(e) => {
                  setDnsSearchDomains(e.target.value);
                  setRestartNeeded(false);
                }}
                placeholder="e.g. example.local, corp.example.com"
              />
              <p className="text-sm text-txt-secondary mt-1">
                Comma-separated list of DNS search domains. Required for <code>.local</code> zones
                and allows short hostnames (e.g. <code>server01</code>) to resolve as{" "}
                <code>server01.example.local</code>. Equivalent to the <code>Domains=</code>{" "}
                directive in <code>systemd-resolved</code>.
              </p>
              {searchDomainError && <p className="text-sm text-danger mt-1">{searchDomainError}</p>}
            </div>

            <div className="mt-4 p-4 rounded-lg bg-surface-secondary/30 border border-border/30">
              <h5 className="text-sm font-medium text-txt-primary mb-2">How it works</h5>
              <ol className="text-sm text-txt-secondary space-y-1 list-decimal list-inside">
                <li>You configure your internal DNS server IPs here and save</li>
                <li>The DNS configuration is written to a shared config volume</li>
                <li>After restarting guacd, it reads the custom DNS config at startup</li>
                <li>guacd resolves hostnames using your DNS servers — just like your host OS</li>
              </ol>
            </div>
          </div>
        )}
      </div>

      {restartNeeded && (
        <div className="mt-4 rounded-md px-4 py-3 bg-warning/10 border border-warning/30">
          <p className="text-sm font-medium text-warning">Restart required</p>
          <p className="text-sm text-txt-secondary mt-1">
            DNS settings have been saved. Restart the guacd service(s) to apply:
          </p>
          <code className="block mt-2 text-sm bg-surface-secondary px-3 py-2 rounded font-mono">
            docker-compose restart guacd
          </code>
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-border/10">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || (dnsEnabled && (!!validationError || !!searchDomainError))}
        >
          {saving ? "Saving..." : "Save Network Settings"}
        </button>
      </div>
    </div>
  );
}

// ── Display Tab ────────────────────────────────────────────────────────

function DisplayTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [timezone, setTimezone] = useState(settings.display_timezone || "UTC");
  const [dateFormat, setDateFormat] = useState(settings.display_date_format || "YYYY-MM-DD");
  const [timeFormat, setTimeFormat] = useState(settings.display_time_format || "HH:mm:ss");
  const [saving, setSaving] = useState(false);

  const timezones = getTimezones();

  async function handleSave() {
    setSaving(true);
    try {
      await updateSettings([
        { key: "display_timezone", value: timezone },
        { key: "display_date_format", value: dateFormat },
        { key: "display_time_format", value: timeFormat },
      ]);
      onSave();
    } catch {
      /* ignored */
    }
    setSaving(false);
  }

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Display Preferences</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Configure how dates, times, and timezones are displayed throughout the application.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8">
        <div className="space-y-6">
          <div className="form-group">
            <label className="block text-sm font-medium mb-2">Display Timezone</label>
            <p className="text-xs text-txt-secondary mb-3">
              All timestamps in logs and sessions will be converted to this timezone.
            </p>
            <Select
              value={timezone}
              onChange={setTimezone}
              options={timezones.map((tz) => ({ value: tz, label: tz }))}
            />
          </div>

          <div className="form-group">
            <label className="block text-sm font-medium mb-2">Date Format</label>
            <Select
              value={dateFormat}
              onChange={setDateFormat}
              options={[
                { value: "YYYY-MM-DD", label: "ISO (YYYY-MM-DD)" },
                { value: "DD/MM/YYYY", label: "European (DD/MM/YYYY)" },
                { value: "MM/DD/YYYY", label: "US (MM/DD/YYYY)" },
                { value: "DD-MM-YYYY", label: "DD-MM-YYYY" },
              ]}
            />
          </div>

          <div className="form-group">
            <label className="block text-sm font-medium mb-2">Time Format</label>
            <Select
              value={timeFormat}
              onChange={setTimeFormat}
              options={[
                { value: "HH:mm:ss", label: "24 Hour (HH:mm:ss)" },
                { value: "hh:mm:ss A", label: "12 Hour (hh:mm:ss AM/PM)" },
                { value: "HH:mm", label: "24 Hour Simple (HH:mm)" },
              ]}
            />
          </div>
        </div>

        <div className="bg-surface-secondary/30 p-6 rounded-lg border border-border/50 self-start">
          <h4 className="text-sm font-semibold uppercase tracking-wider mb-4 opacity-70">
            Preview
          </h4>
          <div className="space-y-4">
            <div>
              <div className="text-[10px] uppercase font-bold opacity-40 mb-1">
                Standard Timestamp
              </div>
              <div className="text-xl font-mono tabular-nums">
                {formatDateTime(new Date(), {
                  display_timezone: timezone,
                  display_date_format: dateFormat,
                  display_time_format: timeFormat,
                })}
              </div>
            </div>
            <div className="text-xs text-txt-secondary flex items-center gap-2">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Timezone: {timezone}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-border/10">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Display Settings"}
        </button>
      </div>
    </div>
  );
}

// ── Password Management Tab ────────────────────────────────────────────

function parseDN(dn: string): string {
  if (!dn) return "—";
  const cnMatch = dn.match(/(?:^|,)CN=((?:\\.|[^,])+)/i);
  const cn = cnMatch ? cnMatch[1].replace(/\\(.)/g, "$1") : "Unknown";

  const dcMatches = [...dn.matchAll(/DC=([^,]+)/gi)];
  const domain = dcMatches.map((m) => m[1]).join(".");

  return domain ? `${domain}\\${cn}` : cn;
}

function PasswordsTab({
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
                      Select which managed accounts this role's approvers can approve checkout
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
