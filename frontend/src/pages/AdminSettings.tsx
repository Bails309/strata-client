/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  getSettings,
  getRoles,
  getConnectionFolders,
  getConnectionRefs,
  getUsers,
  getAdSyncConfigs,
  AdSyncConfig,
  Role,
  ConnectionFolder,
  ConnectionRef,
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
import ConnectionsTab from "./admin/ConnectionsTab";
import NotificationsTab from "./admin/NotificationsTab";
import TrustedCAsTab from "./admin/TrustedCAsTab";
import VdiTab from "./admin/VdiTab";
import DmzLinksTab from "./admin/DmzLinksTab";
import SafeguardTab from "./admin/SafeguardTab";
import OutboundSharesTab from "./admin/OutboundSharesTab";
import AvBlockedTab from "./admin/AvBlockedTab";
import AuditLogs from "./AuditLogs";

export type Tab =
  | "health"
  | "display"
  | "network"
  | "sso"
  | "kerberos"
  | "vault"
  | "recordings"
  | "access"
  | "connections"
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
  | "av-blocked"
  | "security"
  | "audit";

const TAB_ALIASES: Record<string, Tab> = {
  jit: "safeguard",
  safeguard: "safeguard",
  sharing: "outbound-shares",
  "outbound-shares": "outbound-shares",
  dmz: "dmz-links",
  "dmz-links": "dmz-links",
  cas: "trusted-cas",
  "trusted-cas": "trusted-cas",
  access: "access",
  connections: "connections",
  network: "network",
  vdi: "vdi",
  display: "display",
  tags: "tags",
  notifications: "notifications",
  recordings: "recordings",
  audit: "audit",
  health: "health",
  vault: "vault",
  sessions: "sessions",
  passwords: "passwords",
  "ad-sync": "ad-sync",
  sso: "sso",
  kerberos: "kerberos",
  security: "security",
  "av-blocked": "av-blocked",
};

const TAB_LABELS: Record<Tab, string> = {
  health: "Health",
  display: "Display",
  network: "Network",
  sso: "SSO / OIDC",
  kerberos: "Kerberos",
  vault: "Vault",
  recordings: "Recordings",
  access: "Access",
  connections: "Connections",
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
  "av-blocked": "AV-Blocked Files",
  security: "Security",
  audit: "Audit Logs",
};

export default function AdminSettings({ user }: { user: MeResponse }) {
  const { tab: routeTab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();

  const initialTab: Tab =
    routeTab && TAB_ALIASES[routeTab]
      ? TAB_ALIASES[routeTab]
      : user.can_manage_system
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
            : "health";

  const [tab, setTab] = useState<Tab>(initialTab);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Role[]>([]);
  const [folders, setFolders] = useState<ConnectionFolder[]>([]);
  // Loaded only by the tabs that list every connection or user.
  const [connectionRefs, setConnectionRefs] = useState<ConnectionRef[] | null>(null);
  const [users, setUsers] = useState<User[] | null>(null);
  const [adSyncConfigs, setAdSyncConfigs] = useState<AdSyncConfig[]>([]);
  const [msg, setMsg] = useState("");
  const [loadError, setLoadError] = useState("");

  // Sync tab with URL route changes
  useEffect(() => {
    if (routeTab && TAB_ALIASES[routeTab]) {
      setTab(TAB_ALIASES[routeTab]);
    }
  }, [routeTab]);

  useEffect(() => {
    setLoadError("");
    Promise.all([
      getSettings().then(setSettings),
      getRoles().then(setRoles),
      getConnectionFolders().then(setFolders),
      getAdSyncConfigs()
        .then(setAdSyncConfigs)
        .catch(() => {}),
    ]).catch(() => setLoadError("Failed to load settings"));
  }, []);

  useEffect(() => {
    if (tab === "tags" && connectionRefs === null) {
      getConnectionRefs()
        .then(setConnectionRefs)
        .catch(() => setConnectionRefs([]));
    }
    if ((tab === "passwords" || tab === "outbound-shares") && users === null) {
      getUsers()
        .then(setUsers)
        .catch(() => setUsers([]));
    }
  }, [tab, connectionRefs, users]);

  function flash(text: string) {
    setMsg(text);
    setTimeout(() => setMsg(""), 3000);
  }

  function handleSelectTab(t: Tab) {
    setTab(t);
    // If running in full router context, update route
    if (routeTab) {
      navigate(`/admin/${t}`);
    }
  }

  return (
    <div className="w-full flex-1">
      <h1 className="text-2xl font-bold mb-6 text-txt-primary">Admin Settings</h1>

      {/* ── Status Messages ── */}
      {msg && <div className="rounded-md mb-4 px-4 py-2 bg-success-dim text-success">{msg}</div>}
      {loadError && (
        <div className="rounded-md mb-4 px-4 py-2 bg-danger/10 text-danger">{loadError}</div>
      )}

      {/* ── Accessible off-canvas quick navigation for screen readers and unit tests ──
          The persistent secondary vertical rail has been deprecated and removed from
          the standard layout flow to reclaim 250px+ of horizontal space for full-width
          tables. This accessible container provides tab triggers for testing and WCAG. ── */}
      <div aria-label="Admin settings tabs" className="sr-only">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => handleSelectTab(t)}
            className={tab === t ? "tab-active" : ""}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* ── Full-Width Flexible Workspace Content Area ── */}
      <div className="w-full flex-1 animate-fade-in">
        {/* ── Health ── */}
        {tab === "health" && <HealthTab onNavigateVault={() => handleSelectTab("vault")} />}

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

        {/* ── Access Control (Roles, Permissions, Session Policies) ── */}
        {tab === "access" && (
          <AccessTab user={user} roles={roles} folders={folders} onRolesChanged={setRoles} />
        )}

        {/* ── Connections (Dedicated admin connectivity manager) ── */}
        {tab === "connections" && (
          <ConnectionsTab user={user} folders={folders} onFoldersChanged={(f) => setFolders(f)} />
        )}

        {/* ── Tags ── */}
        {tab === "tags" && (
          <TagsTab connections={connectionRefs ?? []} onSave={() => flash("Tags updated")} />
        )}

        {/* ── AD Sync ── */}
        {tab === "ad-sync" && (
          <AdSyncTab folders={folders} onSave={() => flash("AD Sync updated")} />
        )}

        {/* ── Password Management ── */}
        {tab === "passwords" && (
          <PasswordsTab
            users={users ?? []}
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

        {/* ── Outbound Share Policy ── */}
        {tab === "outbound-shares" && (
          <OutboundSharesTab
            users={users ?? []}
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

        {/* ── AV-Blocked Files ── */}
        {tab === "av-blocked" && <AvBlockedTab />}

        {/* ── Audit Logs ── */}
        {tab === "audit" && <AuditLogs />}
      </div>
    </div>
  );
}
