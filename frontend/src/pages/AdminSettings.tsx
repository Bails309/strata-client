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
