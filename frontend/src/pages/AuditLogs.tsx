import { useEffect, useMemo, useState } from "react";
import { getAuditLogs, AuditLog, AuditLogFilters } from "../api";
import { useSettings } from "../contexts/SettingsContext";
import Select from "../components/Select";

/* Action-prefix presets exposed in the filter dropdown. Mirrors the
   colour-grouping in `badgeClass` below so the operator's mental model
   stays consistent between the filter menu and the badges. */
const ACTION_PREFIXES: { value: string; label: string }[] = [
  { value: "", label: "All actions" },
  { value: "tunnel", label: "Tunnel (sessions)" },
  { value: "sessions", label: "Sessions (kill / admin)" },
  { value: "auth", label: "Authentication" },
  { value: "user", label: "Users" },
  { value: "connection", label: "Connections" },
  { value: "connection_folder", label: "Connection folders" },
  { value: "role", label: "Roles" },
  { value: "credential", label: "Credentials" },
  { value: "credential_profile", label: "Credential profiles" },
  { value: "ad_sync", label: "AD sync" },
  { value: "settings", label: "Settings" },
  { value: "sso", label: "SSO" },
  { value: "vault", label: "Vault" },
  { value: "kerberos", label: "Kerberos" },
  { value: "recordings", label: "Recordings" },
  { value: "safeguard", label: "Safeguard" },
  { value: "password_checkout", label: "Password checkouts" },
];

/* Map action_type prefixes to badge colours */
function badgeClass(action: string): string {
  if (action.startsWith("tunnel.")) return "badge badge-accent";
  if (action.startsWith("auth.")) return "badge badge-success";
  if (action.startsWith("ad_sync.")) return "badge badge-warning";
  if (action.startsWith("connection.") || action.startsWith("connection_folder."))
    return "badge badge-accent";
  if (
    action.startsWith("settings.") ||
    action.startsWith("sso.") ||
    action.startsWith("vault.") ||
    action.startsWith("kerberos.") ||
    action.startsWith("recordings.")
  )
    return "badge badge-warning";
  if (action.startsWith("role")) return "badge badge-warning";
  if (action.startsWith("user.")) return "badge badge-accent";
  if (action.startsWith("credential")) return "badge badge-success";
  if (action.startsWith("sessions.")) return "badge badge-error";
  return "badge badge-success";
}

/* Human-readable details renderer */
function formatDetails(log: AuditLog): React.ReactNode {
  const d = log.details;
  const connName = log.connection_name;

  switch (log.action_type) {
    /* ── Tunnel / Sessions ────────────────────────── */
    case "tunnel.connected":
      return connName ? (
        <>
          Connected to <strong>{connName}</strong>
        </>
      ) : (
        <>Connection {shortId(d.connection_id)}</>
      );
    case "tunnel.failed":
      return (
        <>
          {connName ? (
            <>
              <strong>{connName}</strong>
            </>
          ) : (
            <>Connection {shortId(d.connection_id)}</>
          )}
          {d.error && <span className="text-txt-danger"> — {String(d.error)}</span>}
        </>
      );
    case "sessions.killed":
      return (
        <>
          {d.count} session{d.count === 1 ? "" : "s"} terminated
        </>
      );

    /* ── Auth ─────────────────────────────────────── */
    case "auth.local_login":
      return (
        <>
          <strong>{String(d.username)}</strong> logged in (local)
        </>
      );
    case "auth.sso_login":
      return (
        <>
          <strong>{String(d.username)}</strong> logged in (SSO)
        </>
      );

    /* ── Connections ──────────────────────────────── */
    case "connection.created":
      return (
        <>
          Created connection <strong>{String(d.name)}</strong>
        </>
      );
    case "connection.updated":
      return (
        <>
          Updated connection <strong>{String(d.name)}</strong>
        </>
      );
    case "connection.deleted":
      return <>Deleted connection {shortId(d.id)}</>;
    case "connection.shared":
      return (
        <>
          Shared{" "}
          {connName ? <strong>{connName}</strong> : <>connection {shortId(d.connection_id)}</>}
          {d.mode && <> ({String(d.mode)})</>}
        </>
      );

    /* ── Connection Folders ───────────────────────── */
    case "connection_folder.created":
      return (
        <>
          Created folder <strong>{String(d.name)}</strong>
        </>
      );
    case "connection_folder.deleted":
      return <>Deleted folder {shortId(d.id)}</>;

    /* ── Roles ────────────────────────────────────── */
    case "role.created":
      return (
        <>
          Created role <strong>{String(d.name)}</strong>
        </>
      );
    case "role.updated":
      return (
        <>
          Updated role <strong>{String(d.name)}</strong>
        </>
      );
    case "role.deleted":
      return (
        <>
          Deleted role <strong>{String(d.name)}</strong>
        </>
      );
    case "role_mappings.updated":
      return <>Updated role mappings {shortId(d.role_id)}</>;

    /* ── Users ────────────────────────────────────── */
    case "user.created":
      return (
        <>
          Created user <strong>{String(d.email)}</strong> ({String(d.auth_type)})
        </>
      );
    case "user.deleted":
      return <>Deleted user {shortId(d.id)}</>;
    case "user.restored":
      return <>Restored user {shortId(d.id)}</>;

    /* ── Credentials ──────────────────────────────── */
    case "credential.updated":
      return (
        <>
          {connName ? (
            <>
              Updated credential for <strong>{connName}</strong>
            </>
          ) : (
            <>Updated credential {shortId(d.connection_id)}</>
          )}
        </>
      );
    case "credential_profile.created":
      return (
        <>
          Created credential profile <strong>{String(d.label)}</strong>
        </>
      );
    case "credential_profile.updated":
      return <>Updated credential profile {shortId(d.profile_id)}</>;
    case "credential_profile.deleted":
      return <>Deleted credential profile {shortId(d.profile_id)}</>;

    /* ── AD Sync ──────────────────────────────────── */
    case "ad_sync.completed":
      return (
        <>
          <strong>{String(d.label)}</strong>
          {" — "}
          {Number(d.created)} created, {Number(d.updated)} updated
          {(Number(d.soft_deleted) > 0 || Number(d.hard_deleted) > 0) && (
            <>
              , {Number(d.soft_deleted)} soft-deleted, {Number(d.hard_deleted)} hard-deleted
            </>
          )}
        </>
      );
    case "ad_sync.config_created":
      return (
        <>
          Created AD sync config <strong>{String(d.label)}</strong>
        </>
      );
    case "ad_sync.config_updated":
      return <>Updated AD sync config {shortId(d.id)}</>;
    case "ad_sync.config_deleted":
      return <>Deleted AD sync config {shortId(d.id)}</>;

    /* ── Settings / Config ────────────────────────── */
    case "settings.updated":
      return (
        <>
          {d.count} setting{d.count === 1 ? "" : "s"} updated
        </>
      );
    case "settings.auth_methods_updated":
      return (
        <>
          Auth methods: SSO {d.sso_enabled ? "on" : "off"}, Local{" "}
          {d.local_auth_enabled ? "on" : "off"}
        </>
      );
    case "sso.configured":
      return <>SSO configured</>;
    case "vault.configured":
      return <>Vault configured ({String(d.address)})</>;
    case "kerberos.configured":
      return (
        <>
          Kerberos configured — realm <strong>{String(d.realm)}</strong>
        </>
      );
    case "kerberos.realm_created":
      return (
        <>
          Created Kerberos realm <strong>{String(d.realm)}</strong>
        </>
      );
    case "kerberos.realm_updated":
      return <>Updated Kerberos realm {shortId(d.realm_id)}</>;
    case "kerberos.realm_deleted":
      return <>Deleted Kerberos realm {shortId(d.realm_id)}</>;
    case "recordings.configured":
      return <>Recordings {d.enabled ? "enabled" : "disabled"}</>;

    /* ── Fallback ─────────────────────────────────── */
    default:
      return <span className="font-mono text-[0.75rem]">{JSON.stringify(d)}</span>;
  }
}

/** Show first 8 chars of a UUID (or any string-like value) */
function shortId(v: unknown): React.ReactNode {
  const s = String(v ?? "");
  return <code className="text-[0.75rem]">{s.length > 8 ? `${s.slice(0, 8)}…` : s}</code>;
}

export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(1);
  const { formatDateTime } = useSettings();

  // Filter inputs. Free-text fields are debounced via a 300ms effect
  // below so the operator can type without spamming the backend.
  const [actionPrefix, setActionPrefix] = useState("");
  const [username, setUsername] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Debounced copies that actually drive the request.
  const [debouncedUsername, setDebouncedUsername] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedUsername(username), 300);
    return () => clearTimeout(t);
  }, [username]);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters = useMemo<AuditLogFilters>(
    () => ({
      action_prefix: actionPrefix || undefined,
      username: debouncedUsername || undefined,
      search: debouncedSearch || undefined,
      // <input type="datetime-local"> emits values without a timezone
      // suffix; treat them as the operator's local time and let the
      // browser convert to a UTC ISO string for the backend.
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
    }),
    [actionPrefix, debouncedUsername, debouncedSearch, from, to]
  );

  // Reset to page 1 whenever filters change, otherwise a deep page
  // number from a previous search may render an empty table. This is an
  // intentional derived-state reset; React's rule-of-thumb against
  // setState-in-effect targets cascading-render bugs, but a single
  // setPage(1) on the filter-change boundary is bounded and correct.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [filters]);

  useEffect(() => {
    getAuditLogs(page, 50, filters)
      .then(setLogs)
      .catch(() => {});
  }, [page, filters]);

  const filtersActive = !!actionPrefix || !!username || !!search || !!from || !!to;
  const resetFilters = () => {
    setActionPrefix("");
    setUsername("");
    setSearch("");
    setFrom("");
    setTo("");
  };

  return (
    <div>
      <h1>Audit Logs</h1>

      <div className="card">
        {/* ── Filter bar ─────────────────────────────── */}
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <label className="flex flex-col text-xs text-txt-secondary">
            <span className="mb-1">Category</span>
            <Select
              value={actionPrefix}
              onChange={setActionPrefix}
              options={ACTION_PREFIXES}
              searchable
            />
          </label>

          <label className="flex flex-col text-xs text-txt-secondary">
            <span className="mb-1">Username</span>
            <input
              type="text"
              className="input"
              placeholder="username contains…"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>

          <label className="flex flex-col text-xs text-txt-secondary">
            <span className="mb-1">Search</span>
            <input
              type="text"
              className="input"
              placeholder="action, details, connection…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <label className="flex flex-col text-xs text-txt-secondary">
            <span className="mb-1">From</span>
            <input
              type="datetime-local"
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>

          <label className="flex flex-col text-xs text-txt-secondary">
            <span className="mb-1">To</span>
            <input
              type="datetime-local"
              className="input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>

          <button
            type="button"
            className="btn btn-secondary"
            onClick={resetFilters}
            disabled={!filtersActive}
          >
            Reset
          </button>
        </div>
        <div className="table-responsive">
          <table className="admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Timestamp</th>
                <th>Action</th>
                <th>User</th>
                <th>Details</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-txt-secondary py-6">
                    {filtersActive
                      ? "No audit log entries match the current filters."
                      : "No audit log entries."}
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id}>
                    <td>{log.id}</td>
                    <td className="text-[0.8rem] whitespace-nowrap font-mono">
                      {formatDateTime(log.created_at)}
                    </td>
                    <td>
                      <span className={badgeClass(log.action_type)}>{log.action_type}</span>
                    </td>
                    <td className="text-sm">
                      {log.username || (log.user_id ? log.user_id.slice(0, 8) : "—")}
                    </td>
                    <td className="text-[0.8rem] max-w-[400px]">{formatDetails(log)}</td>
                    <td className="font-mono text-[0.7rem] text-txt-secondary">
                      {log.current_hash.slice(0, 12)}…
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex justify-center gap-2 mt-4">
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="py-2 px-2 text-txt-secondary">Page {page}</span>
          <button className="btn" onClick={() => setPage(page + 1)} disabled={logs.length < 50}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
