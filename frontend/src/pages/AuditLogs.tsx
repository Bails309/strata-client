import { useEffect, useState } from 'react';
import { getAuditLogs, AuditLog } from '../api';
import { useSettings } from '../contexts/SettingsContext';

/* Map action_type prefixes to badge colours */
function badgeClass(action: string): string {
  if (action.startsWith('tunnel.')) return 'badge badge-accent';
  if (action.startsWith('auth.')) return 'badge badge-success';
  if (action.startsWith('ad_sync.')) return 'badge badge-warning';
  if (action.startsWith('connection.') || action.startsWith('connection_folder.'))
    return 'badge badge-accent';
  if (action.startsWith('settings.') || action.startsWith('sso.') || action.startsWith('vault.') || action.startsWith('kerberos.') || action.startsWith('recordings.'))
    return 'badge badge-warning';
  if (action.startsWith('role')) return 'badge badge-warning';
  if (action.startsWith('user.')) return 'badge badge-accent';
  if (action.startsWith('credential')) return 'badge badge-success';
  if (action.startsWith('sessions.')) return 'badge badge-error';
  return 'badge badge-success';
}

/* Human-readable details renderer */
function formatDetails(log: AuditLog): React.ReactNode {
  const d = log.details;
  const connName = log.connection_name;

  switch (log.action_type) {
    /* ── Tunnel / Sessions ────────────────────────── */
    case 'tunnel.connected':
      return connName ? <>Connected to <strong>{connName}</strong></> : <>Connection {shortId(d.connection_id)}</>;
    case 'tunnel.failed':
      return (
        <>
          {connName ? <><strong>{connName}</strong></> : <>Connection {shortId(d.connection_id)}</>}
          {d.error && <span className="text-txt-danger"> — {String(d.error)}</span>}
        </>
      );
    case 'sessions.killed':
      return <>{d.count} session{d.count === 1 ? '' : 's'} terminated</>;

    /* ── Auth ─────────────────────────────────────── */
    case 'auth.local_login':
      return <><strong>{String(d.username)}</strong> logged in (local)</>;
    case 'auth.sso_login':
      return <><strong>{String(d.username)}</strong> logged in (SSO)</>;

    /* ── Connections ──────────────────────────────── */
    case 'connection.created':
      return <>Created connection <strong>{String(d.name)}</strong></>;
    case 'connection.updated':
      return <>Updated connection <strong>{String(d.name)}</strong></>;
    case 'connection.deleted':
      return <>Deleted connection {shortId(d.id)}</>;
    case 'connection.shared':
      return (
        <>
          Shared {connName ? <strong>{connName}</strong> : <>connection {shortId(d.connection_id)}</>}
          {d.mode && <> ({String(d.mode)})</>}
        </>
      );

    /* ── Connection Folders ───────────────────────── */
    case 'connection_folder.created':
      return <>Created folder <strong>{String(d.name)}</strong></>;
    case 'connection_folder.deleted':
      return <>Deleted folder {shortId(d.id)}</>;

    /* ── Roles ────────────────────────────────────── */
    case 'role.created':
      return <>Created role <strong>{String(d.name)}</strong></>;
    case 'role.updated':
      return <>Updated role <strong>{String(d.name)}</strong></>;
    case 'role.deleted':
      return <>Deleted role <strong>{String(d.name)}</strong></>;
    case 'role_mappings.updated':
      return <>Updated role mappings {shortId(d.role_id)}</>;

    /* ── Users ────────────────────────────────────── */
    case 'user.created':
      return <>Created user <strong>{String(d.email)}</strong> ({String(d.auth_type)})</>;
    case 'user.deleted':
      return <>Deleted user {shortId(d.id)}</>;
    case 'user.restored':
      return <>Restored user {shortId(d.id)}</>;

    /* ── Credentials ──────────────────────────────── */
    case 'credential.updated':
      return <>{connName ? <>Updated credential for <strong>{connName}</strong></> : <>Updated credential {shortId(d.connection_id)}</>}</>;
    case 'credential_profile.created':
      return <>Created credential profile <strong>{String(d.label)}</strong></>;
    case 'credential_profile.updated':
      return <>Updated credential profile {shortId(d.profile_id)}</>;
    case 'credential_profile.deleted':
      return <>Deleted credential profile {shortId(d.profile_id)}</>;

    /* ── AD Sync ──────────────────────────────────── */
    case 'ad_sync.completed':
      return (
        <>
          <strong>{String(d.label)}</strong>
          {' — '}
          {Number(d.created)} created, {Number(d.updated)} updated
          {(Number(d.soft_deleted) > 0 || Number(d.hard_deleted) > 0) && (
            <>, {Number(d.soft_deleted)} soft-deleted, {Number(d.hard_deleted)} hard-deleted</>
          )}
        </>
      );
    case 'ad_sync.config_created':
      return <>Created AD sync config <strong>{String(d.label)}</strong></>;
    case 'ad_sync.config_updated':
      return <>Updated AD sync config {shortId(d.id)}</>;
    case 'ad_sync.config_deleted':
      return <>Deleted AD sync config {shortId(d.id)}</>;

    /* ── Settings / Config ────────────────────────── */
    case 'settings.updated':
      return <>{d.count} setting{d.count === 1 ? '' : 's'} updated</>;
    case 'settings.auth_methods_updated':
      return <>Auth methods: SSO {d.sso_enabled ? 'on' : 'off'}, Local {d.local_auth_enabled ? 'on' : 'off'}</>;
    case 'sso.configured':
      return <>SSO configured</>;
    case 'vault.configured':
      return <>Vault configured ({String(d.address)})</>;
    case 'kerberos.configured':
      return <>Kerberos configured — realm <strong>{String(d.realm)}</strong></>;
    case 'kerberos.realm_created':
      return <>Created Kerberos realm <strong>{String(d.realm)}</strong></>;
    case 'kerberos.realm_updated':
      return <>Updated Kerberos realm {shortId(d.realm_id)}</>;
    case 'kerberos.realm_deleted':
      return <>Deleted Kerberos realm {shortId(d.realm_id)}</>;
    case 'recordings.configured':
      return <>Recordings {d.enabled ? 'enabled' : 'disabled'}</>;

    /* ── Fallback ─────────────────────────────────── */
    default:
      return <span className="font-mono text-[0.75rem]">{JSON.stringify(d)}</span>;
  }
}

/** Show first 8 chars of a UUID (or any string-like value) */
function shortId(v: unknown): React.ReactNode {
  const s = String(v ?? '');
  return <code className="text-[0.75rem]">{s.length > 8 ? `${s.slice(0, 8)}…` : s}</code>;
}

export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(1);
  const { formatDateTime } = useSettings();

  useEffect(() => {
    getAuditLogs(page).then(setLogs).catch(() => {});
  }, [page]);

  return (
    <div>
      <h1>Audit Logs</h1>

      <div className="card">
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
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{log.id}</td>
                  <td className="text-[0.8rem] whitespace-nowrap font-mono">
                    {formatDateTime(log.created_at)}
                  </td>
                  <td>
                    <span className={badgeClass(log.action_type)}>{log.action_type}</span>
                  </td>
                  <td className="text-sm">
                    {log.username || (log.user_id ? log.user_id.slice(0, 8) : '—')}
                  </td>
                  <td className="text-[0.8rem] max-w-[400px]">
                    {formatDetails(log)}
                  </td>
                  <td className="font-mono text-[0.7rem] text-txt-secondary">
                    {log.current_hash.slice(0, 12)}…
                  </td>
                </tr>
              ))}
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
