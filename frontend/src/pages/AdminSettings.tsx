/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useEffect, useState } from "react";
import {
  getSettings,
  getRoles,
  getConnectionFolders,
  getConnections,
  getUsers,
  getAdSyncConfigs,
  AdSyncConfig,
  Role,
  Connection,
  ConnectionFolder,
  User,
  MeResponse,
} from "../api";
import SecurityTab from "./admin/SecurityTab";
import NetworkTab from "./admin/NetworkTab";
import DisplayTab from "./admin/DisplayTab";
import SsoTab from "./admin/SsoTab";
import KerberosTab from "./admin/KerberosTab";
import RecordingsTab from "./admin/RecordingsTab";
import VaultTab from "./admin/VaultTab";
import TagsTab from "./admin/TagsTab";
import HealthTab from "./admin/HealthTab";
import SessionsTab from "./admin/SessionsTab";
import PasswordsTab from "./admin/PasswordsTab";
import AdSyncTab from "./admin/AdSyncTab";
import AccessTab from "./admin/AccessTab";
import NotificationsTab from "./admin/NotificationsTab";
import TrustedCAsTab from "./admin/TrustedCAsTab";
import VdiTab from "./admin/VdiTab";
import DmzLinksTab from "./admin/DmzLinksTab";
import SafeguardTab from "./admin/SafeguardTab";
import OutboundSharesTab from "./admin/OutboundSharesTab";

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
  | "notifications"
  | "sessions"
  | "vdi"
  | "trusted-cas"
  | "dmz-links"
  | "safeguard"
  | "outbound-shares"
  | "security";

export default function AdminSettings({ user }: { user: MeResponse }) {
  const [tab, setTab] = useState<Tab>(
    user.can_manage_system
      ? "health"
      : user.can_manage_users ||
          user.can_manage_connections ||
          user.can_create_users ||
          user.can_create_user_groups ||
          user.can_create_connections ||
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

      <AdminNav user={user} tab={tab} onSelect={setTab}>
        {/* ── Health ── */}
        {tab === "health" && <HealthTab onNavigateVault={() => setTab("vault")} />}

        {/* ── DMZ Links ── */}
        {tab === "dmz-links" && <DmzLinksTab />}

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
        {tab === "tags" && (
          <TagsTab connections={connections} onSave={() => flash("Tags updated")} />
        )}

        {/* ── AD Sync ── */}
        {tab === "ad-sync" && (
          <AdSyncTab folders={folders} onSave={() => flash("AD Sync updated")} />
        )}

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

        {/* ── Notifications (SMTP) ── */}
        {tab === "notifications" && (
          <NotificationsTab onSave={() => flash("Notification settings updated")} />
        )}

        {/* ── VDI ── */}
        {tab === "vdi" && (
          <VdiTab
            settings={settings}
            onSave={() => {
              flash("VDI settings updated");
              getSettings()
                .then(setSettings)
                .catch(() => {});
            }}
          />
        )}

        {/* ── Trusted CAs ── */}
        {tab === "trusted-cas" && <TrustedCAsTab onSave={() => flash("Trusted CAs updated")} />}

        {/* ── Safeguard JIT ── */}
        {tab === "safeguard" && <SafeguardTab onSave={() => flash("Safeguard config updated")} />}

        {/* ── Outbound Share Policy (approver delegations only — the
            operational queue lives under /approvals, shared with the
            existing Pending Approvals (credential checkouts) surface) ── */}
        {tab === "outbound-shares" && (
          <OutboundSharesTab
            users={users}
            isSuperAdmin={!!user.can_manage_system}
            onSave={() => flash("Outbound share policy updated")}
            variant="policy-only"
          />
        )}

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
      </AdminNav>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sidebar nav for Admin Settings.
//
// Items are grouped into 5 sections so the previous 17-tab single
// row no longer overflows. Permission filtering matches the original
// inline logic; sections become hidden when no items inside are
// visible to the current user.
// ──────────────────────────────────────────────────────────────────
const TAB_LABELS: Record<Tab, string> = {
  health: "Health",
  display: "Display",
  network: "Network",
  sso: "SSO / OIDC",
  kerberos: "Kerberos",
  vault: "Vault",
  recordings: "Recordings",
  access: "Access",
  tags: "Tags",
  "ad-sync": "AD Sync",
  passwords: "Password Mgmt",
  notifications: "Notifications",
  sessions: "Sessions",
  vdi: "VDI",
  "trusted-cas": "Trusted CAs",
  "dmz-links": "DMZ Links",
  safeguard: "Safeguard JIT",
  "outbound-shares": "Outbound Share Policy",
  security: "Security",
};

const ADMIN_NAV_GROUPS: Array<{ title: string; items: Tab[] }> = [
  { title: "Overview", items: ["health", "sessions"] },
  {
    title: "Identity & Access",
    items: ["access", "ad-sync", "sso", "kerberos", "passwords", "safeguard", "outbound-shares"],
  },
  { title: "Connectivity", items: ["network", "dmz-links", "trusted-cas", "vdi"] },
  { title: "Workspace", items: ["display", "tags", "notifications", "recordings"] },
  { title: "Secrets & Security", items: ["vault", "security"] },
];

function tabVisible(t: Tab, user: MeResponse): boolean {
  if (t === "access")
    return (
      user.can_manage_system ||
      user.can_manage_users ||
      user.can_manage_connections ||
      user.can_create_users ||
      user.can_create_user_groups ||
      user.can_create_connections ||
      user.can_create_sharing_profiles
    );
  if (t === "tags") return user.can_manage_system || user.can_manage_connections;
  if (t === "sessions") return user.can_manage_system || user.can_view_audit_logs;
  // Outbound Share Policy is the *delegation* surface only — super-admin
  // only. Non-admin designated approvers reach the operational queue
  // via the left-nav "Pending Approvals" item (see Layout.tsx).
  if (t === "outbound-shares") return user.can_manage_system;
  return user.can_manage_system;
}

function AdminNav({
  user,
  tab,
  onSelect,
  children,
}: {
  user: MeResponse;
  tab: Tab;
  onSelect: (t: Tab) => void;
  children: React.ReactNode;
}) {
  const visibleGroups = ADMIN_NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((t) => tabVisible(t, user)),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      <nav
        className="lg:w-56 lg:shrink-0 lg:sticky lg:top-4 lg:self-start rounded-md p-2 bg-tabs space-y-3"
        style={{ background: "var(--color-tabs-bg)", border: "1px solid var(--color-border)" }}
        aria-label="Admin sections"
      >
        {visibleGroups.map((g) => (
          <div key={g.title}>
            <div className="px-3 pt-1 pb-1 text-[0.65rem] font-semibold uppercase tracking-wider text-[color:var(--color-txt-secondary)] opacity-70">
              {g.title}
            </div>
            <div className="flex flex-row flex-wrap lg:flex-col gap-1">
              {g.items.map((t) => {
                const active = tab === t;
                return (
                  <button
                    key={t}
                    onClick={() => onSelect(t)}
                    className={`text-left rounded-sm text-[0.8125rem] font-medium cursor-pointer transition-all duration-150 px-3 py-2 lg:w-full ${active ? "tab-active" : ""}`}
                    style={
                      active
                        ? {
                            background: "var(--color-accent)",
                            color: "#fff",
                            boxShadow: "var(--shadow-accent)",
                          }
                        : {
                            background: "transparent",
                            color: "var(--color-txt-secondary)",
                          }
                    }
                    onMouseEnter={(e) => {
                      if (!active) {
                        e.currentTarget.style.background = "var(--color-tab-hover-bg)";
                        e.currentTarget.style.color = "var(--color-txt-primary)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!active) {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = "var(--color-txt-secondary)";
                      }
                    }}
                  >
                    {TAB_LABELS[t]}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
