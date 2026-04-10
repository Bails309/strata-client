import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Select from '../components/Select';
import ConfirmModal from '../components/ConfirmModal';
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
  restoreUser,
  getActiveSessions,
  getAdSyncConfigs,
  createAdSyncConfig,
  updateAdSyncConfig,
  deleteAdSyncConfig,
  triggerAdSync,
  testAdSyncConnection,
  testSsoConnection,
  getAdSyncRuns,
  AdSyncConfig,
  AdSyncRun,
  Role,
  Connection,
  ConnectionFolder,
  User,
  ServiceHealth,
  ActiveSession,
  MetricsSummary,
  MeResponse,
} from '../api';

type Tab = 'health' | 'sso' | 'kerberos' | 'vault' | 'recordings' | 'access' | 'ad-sync' | 'sessions' | 'security';

export default function AdminSettings({ user }: { user: MeResponse }) {
  const [tab, setTab] = useState<Tab>(
    user.can_manage_system ? 'health' : 
    (user.can_manage_users || user.can_manage_connections || user.can_create_users || user.can_create_user_groups || user.can_create_connections || user.can_create_connection_folders || user.can_create_sharing_profiles) ? 'access' :
    user.can_view_audit_logs ? 'sessions' : 'health'
  );
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Role[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [folders, setFolders] = useState<ConnectionFolder[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [msg, setMsg] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    setLoadError('');
    Promise.all([
      getSettings().then(setSettings),
      getRoles().then(setRoles),
      getConnections().then(setConnections),
      getConnectionFolders().then(setFolders),
      getUsers().then(setUsers),
    ]).catch(() => setLoadError('Failed to load settings'));
  }, []);

  function flash(text: string) {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  }

  return (
    <div>
      <h1>Admin Settings</h1>

      {msg && (
        <div className="rounded-md mb-4 px-4 py-2 bg-success-dim text-success">
          {msg}
        </div>
      )}

      {loadError && (
        <div className="rounded-md mb-4 px-4 py-2 bg-danger/10 text-danger">
          {loadError}
        </div>
      )}

      <div className="tabs">
        {(['health', 'sso', 'kerberos', 'vault', 'recordings', 'access', 'ad-sync', 'sessions', 'security'] as Tab[])
          .filter(t => {
            if (t === 'access') return user.can_manage_system || user.can_manage_users || user.can_manage_connections
              || user.can_create_users || user.can_create_user_groups
              || user.can_create_connections || user.can_create_connection_folders
              || user.can_create_sharing_profiles;
            if (t === 'sessions') return user.can_manage_system || user.can_view_audit_logs;
            // All other tabs are system management
            return user.can_manage_system;
          })
          .map((t) => (
            <button key={t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
              {t === 'sso' ? 'SSO / OIDC' : 
               t === 'ad-sync' ? 'AD Sync' : 
               t === 'sessions' ? 'Audit Logs' : 
               t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
      </div>

      {/* ── Health ── */}
      {tab === 'health' && (
        <HealthTab onNavigateVault={() => setTab('vault')} />
      )}

      {/* ── SSO ── */}
      {tab === 'sso' && (
        <SsoTab settings={settings} onSave={() => flash('SSO updated')} />
      )}

      {/* ── Kerberos ── */}
      {tab === 'kerberos' && (
        <KerberosTab onSave={() => flash('Kerberos updated')} />
      )}

      {/* ── Recordings ── */}
      {tab === 'recordings' && (
        <RecordingsTab settings={settings} onSave={() => flash('Recordings updated')} />
      )}

      {/* ── Vault ── */}
      {tab === 'vault' && (
        <VaultTab settings={settings} onSave={() => { flash('Vault updated'); getSettings().then(setSettings).catch(() => {}); }} />
      )}

      {/* ── Access Control ── */}
      {tab === 'access' && (
        <AccessTab
          user={user}
          roles={roles}
          connections={connections}
          folders={folders}
          users={users}
          onRolesChanged={setRoles}
          onConnectionCreated={(c) => setConnections([...connections, c])}
          onConnectionUpdated={(c) => setConnections(connections.map((x) => x.id === c.id ? c : x))}
          onConnectionDeleted={(id) => setConnections(connections.filter((x) => x.id !== id))}
          onFoldersChanged={(f) => setFolders(f)}
          onUsersChanged={(u) => setUsers(u)}
        />
      )}

      {/* ── AD Sync ── */}
      {tab === 'ad-sync' && (
        <AdSyncTab folders={folders} onSave={() => flash('AD Sync updated')} />
      )}

      {/* ── Active Sessions (NVR) ── */}
      {tab === 'sessions' && <SessionsTab />}

      {/* ── Security ── */}
      {tab === 'security' && (
        <SecurityTab settings={settings} onSave={() => { flash('Security settings updated'); getSettings().then(setSettings).catch(() => {}); }} />
      )}
    </div>
  );
}

// ── Sub-tabs ─────────────────────────────────────────────────────────

function HealthTab({ onNavigateVault }: { onNavigateVault: () => void }) {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  function refresh() {
    setLoading(true);
    Promise.all([
      getServiceHealth().catch(() => null),
      getMetrics().catch(() => null),
    ])
      .then(([h, m]) => { setHealth(h); setMetrics(m); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { refresh(); }, []);

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
        <button className="btn mt-3" onClick={refresh}>Retry</button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex justify-between items-center">
        <p className="text-txt-secondary text-sm">
          Service configuration is managed through environment variables and docker-compose.
        </p>
        <button className="btn-primary shrink-0" onClick={refresh}>
          <span className="flex items-center gap-2">
            <svg 
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              className={loading ? 'animate-spin' : ''}
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
            </svg>
            {loading ? 'Refreshing...' : 'Refresh'}
          </span>
        </button>
      </div>

      {/* Database */}
      <div className="card">
        <div className="flex justify-between items-center mb-4">
          <h2 className="!mb-0">Database</h2>
          <span className={`badge ${health.database.connected ? 'badge-success' : 'badge-error'}`}>
            {health.database.connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <table>
          <tbody>
            <tr>
              <td className="text-txt-secondary w-[140px]">Mode</td>
              <td className="capitalize">{health.database.mode}</td>
            </tr>
            <tr>
              <td className="text-txt-secondary">Host</td>
              <td className="font-mono text-[0.8rem]">{health.database.host}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-txt-tertiary text-xs mt-3">
          Configure via <code className="bg-surface-tertiary px-1.5 py-0.5 rounded text-xs">DATABASE_URL</code> environment variable.
        </p>
      </div>

      {/* guacd */}
      <div className="card">
        <div className="flex justify-between items-center mb-4">
          <h2 className="!mb-0">guacd (Gateway)</h2>
          <span className={`badge ${health.guacd.reachable ? 'badge-success' : 'badge-error'}`}>
            {health.guacd.reachable ? 'Reachable' : 'Unreachable'}
          </span>
        </div>
        <table>
          <tbody>
            <tr>
              <td className="text-txt-secondary w-[140px]">Host</td>
              <td className="font-mono text-[0.8rem]">{health.guacd.host}</td>
            </tr>
            <tr>
              <td className="text-txt-secondary">Port</td>
              <td className="font-mono text-[0.8rem]">{health.guacd.port}</td>
            </tr>
            {metrics && (
              <tr>
                <td className="text-txt-secondary">Pool Size</td>
                <td>
                  <span className="font-mono text-[0.8rem]">{metrics.guacd_pool_size}</span>
                  <span className="text-txt-tertiary text-xs ml-2">
                    {metrics.guacd_pool_size > 1 ? `instance${metrics.guacd_pool_size > 2 ? 's' : ''} (round-robin)` : '(single instance)'}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="text-txt-tertiary text-xs mt-3">
          Configure via <code className="bg-surface-tertiary px-1.5 py-0.5 rounded text-xs">GUACD_HOST</code> and <code className="bg-surface-tertiary px-1.5 py-0.5 rounded text-xs">GUACD_PORT</code> environment variables.
        </p>
      </div>

      {/* Vault */}
      <div className="card">
        <div className="flex justify-between items-center mb-4">
          <h2 className="!mb-0">Vault (Encryption)</h2>
          <div className="flex items-center gap-2">
            {health.vault.configured && (
              <span className="badge">{health.vault.mode === 'local' ? 'Bundled' : 'External'}</span>
            )}
            <span className={`badge ${health.vault.configured ? 'badge-success' : 'badge-warning'}`}>
              {health.vault.configured ? 'Configured' : 'Not Configured'}
            </span>
          </div>
        </div>
        {health.vault.configured ? (
          <table>
            <tbody>
              <tr>
                <td className="text-txt-secondary w-[140px]">Mode</td>
                <td className="capitalize">{health.vault.mode === 'local' ? 'Bundled' : 'External'}</td>
              </tr>
              <tr>
                <td className="text-txt-secondary">Address</td>
                <td className="font-mono text-[0.8rem]">{health.vault.address}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="text-txt-secondary text-sm">
            Vault is not configured. Credentials will use local encryption.
          </p>
        )}
        <p className="text-txt-tertiary text-xs mt-3">
          Manage vault configuration in the <button className="text-accent underline bg-transparent border-0 cursor-pointer p-0 text-xs" onClick={onNavigateVault}>Vault tab</button>.
        </p>
      </div>
    </div>
  );
}

function SsoTab({ settings, onSave }: { settings: Record<string, string>; onSave: () => void }) {
  const [issuer, setIssuer] = useState(settings.sso_issuer_url || '');
  const [clientId, setClientId] = useState(settings.sso_client_id || '');
  const [clientSecret, setClientSecret] = useState(settings.sso_client_secret || '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  useEffect(() => {
    setIssuer(settings.sso_issuer_url || '');
    setClientId(settings.sso_client_id || '');
    setClientSecret(settings.sso_client_secret || '');
  }, [settings]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testSsoConnection({ issuer_url: issuer, client_id: clientId, client_secret: clientSecret });
      setTestResult({ success: res.status === 'success', msg: res.message });
    } catch (err: unknown) {
      setTestResult({ success: false, msg: err instanceof Error ? err.message : 'Test failed' });
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
          <span className="text-[10px] uppercase tracking-wider text-txt-tertiary font-bold mb-1">Callback URL</span>
          <code className="text-[11px] bg-surface-tertiary px-2 py-1 rounded border border-border font-mono text-accent">
            {callbackUrl}
          </code>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="sso-issuer">Issuer URL</label>
        <input id="sso-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://keycloak.example.com/realms/strata" />
      </div>
      <div className="form-group">
        <label htmlFor="sso-client-id">Client ID</label>
        <input id="sso-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor="sso-client-secret">Client Secret</label>
        <input id="sso-client-secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={settings.sso_client_secret ? '********' : ''} />
      </div>

      {testResult && (
        <div className={`rounded-md mb-4 px-4 py-2 text-sm ${testResult.success ? 'bg-success-dim text-success' : 'bg-danger-dim text-danger'}`}>
          <div className="flex items-center gap-2">
            {testResult.success ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
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
          onClick={async () => { await updateSso({ issuer_url: issuer, client_id: clientId, client_secret: clientSecret }); onSave(); }}
        >
          Save SSO Settings
        </button>
        <button 
          className="btn" 
          onClick={handleTest} 
          disabled={testing || !issuer || !clientId || !clientSecret}
        >
          {testing ? 'Testing...' : 'Test Connection'}
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
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const list = await getKerberosRealms();
      setRealms(list);
    } catch {
      setError('Failed to load Kerberos realms');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateKdc = (i: number, val: string) => {
    if (!editing) return;
    const next = [...editing.kdcs];
    next[i] = val;
    setEditing({ ...editing, kdcs: next });
  };

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setError('');
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
          setError('Realm name is required');
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
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError('');
    try {
      await deleteKerberosRealm(id);
      await load();
      onSave();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  function openNew() {
    setEditing({
      realm: '',
      kdcs: [''],
      admin_server: '',
      ticket_lifetime: '10h',
      renew_lifetime: '7d',
      is_default: realms.length === 0,
    });
  }

  function openEdit(r: KerberosRealm) {
    setEditing({
      id: r.id,
      realm: r.realm,
      kdcs: r.kdc_servers.split(',').filter(Boolean),
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
            Configure one or more Active Directory domains / Kerberos realms. Each realm gets its own KDC configuration in the shared krb5.conf.
          </p>
        </div>
        <button className="btn-primary" onClick={openNew}>
          <span className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
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
        <div className="card mb-4" style={{ border: '1px solid var(--color-accent)', boxShadow: 'var(--shadow-accent)' }}>
          <h3 className="!mb-4">{editing.id ? 'Edit Realm' : 'New Kerberos Realm'}</h3>
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
                <input id={`krb-kdc-${i}`} value={k} onChange={(e) => updateKdc(i, e.target.value)} placeholder={`KDC ${i + 1} (e.g. dc${i + 1}.example.com)`} />
                {editing.kdcs.length > 1 && (
                  <button type="button" className="btn !w-auto px-[0.7rem] py-[0.4rem] shrink-0"
                    onClick={() => setEditing({ ...editing, kdcs: editing.kdcs.filter((_, j) => j !== i) })}>X</button>
                )}
              </div>
            ))}
            <button type="button" className="btn !w-auto mt-1 text-[0.8rem]"
              onClick={() => setEditing({ ...editing, kdcs: [...editing.kdcs, ''] })}>+ Add KDC</button>
          </div>
          <div className="form-group">
            <label htmlFor="krb-admin">Admin Server</label>
            <input id="krb-admin" value={editing.admin_server} onChange={(e) => setEditing({ ...editing, admin_server: e.target.value })} placeholder="dc1.example.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="form-group">
              <label htmlFor="krb-ticket">Ticket Lifetime</label>
              <input id="krb-ticket" value={editing.ticket_lifetime} onChange={(e) => setEditing({ ...editing, ticket_lifetime: e.target.value })} placeholder="10h" />
            </div>
            <div className="form-group">
              <label htmlFor="krb-renew">Renew Lifetime</label>
              <input id="krb-renew" value={editing.renew_lifetime} onChange={(e) => setEditing({ ...editing, renew_lifetime: e.target.value })} placeholder="7d" />
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
              {saving ? 'Saving...' : editing.id ? 'Update Realm' : 'Create Realm'}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Realms list ── */}
      {realms.length === 0 && !editing ? (
        <div className="card text-center py-12">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4 text-txt-tertiary">
            <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
          </svg>
          <p className="text-txt-secondary text-sm">
            No Kerberos realms configured. Add a realm to enable Kerberos / NLA authentication for your connections.
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
                    style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
                    </svg>
                  </div>
                  <div>
                    <span className="font-semibold text-[0.9rem] text-txt-primary">{r.realm.toUpperCase()}</span>
                    {r.is_default && (
                      <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)' }}>
                        Default
                      </span>
                    )}
                    <div className="text-txt-tertiary text-xs mt-0.5">
                      {r.kdc_servers.split(',').filter(Boolean).length} KDC{r.kdc_servers.split(',').filter(Boolean).length !== 1 ? 's' : ''}
                      {' · '}{r.admin_server || 'No admin server'}
                      {' · '}Ticket {r.ticket_lifetime} / Renew {r.renew_lifetime}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="btn !px-2 !py-1 text-xs"
                    onClick={() => openEdit(r)}
                  >
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

function RecordingsTab({ settings, onSave }: { settings: Record<string, string>; onSave: () => void }) {
  const [enabled, setEnabled] = useState(settings.recordings_enabled === 'true');
  const [days, setDays] = useState(settings.recordings_retention_days || '30');
  const [storageType, setStorageType] = useState(settings.recordings_storage_type || 'local');
  const [azureAccount, setAzureAccount] = useState(settings.recordings_azure_account_name || '');
  const [azureContainer, setAzureContainer] = useState(settings.recordings_azure_container_name || 'recordings');
  const [azureKey, setAzureKey] = useState(settings.recordings_azure_access_key || '');

  useEffect(() => {
    setEnabled(settings.recordings_enabled === 'true');
    setDays(settings.recordings_retention_days || '30');
    setStorageType(settings.recordings_storage_type || 'local');
    setAzureAccount(settings.recordings_azure_account_name || '');
    setAzureContainer(settings.recordings_azure_container_name || 'recordings');
    setAzureKey(settings.recordings_azure_access_key || '');
  }, [settings]);

  return (
    <div className="card">
      <h2>Session Recordings</h2>
      <div className="form-group">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="checkbox" />
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
            { value: 'local', label: 'Local (Docker Volume)' },
            { value: 'azure_blob', label: 'Azure Blob Storage' },
          ]}
        />
      </div>
      {storageType === 'azure_blob' && (
        <>
          <div className="form-group">
            <label>Account Name</label>
            <input value={azureAccount} onChange={(e) => setAzureAccount(e.target.value)} placeholder="mystorageaccount" />
          </div>
          <div className="form-group">
            <label>Container Name</label>
            <input value={azureContainer} onChange={(e) => setAzureContainer(e.target.value)} placeholder="recordings" />
          </div>
          <div className="form-group">
            <label>Access Key</label>
            <input type="password" value={azureKey} onChange={(e) => setAzureKey(e.target.value)} placeholder="Base64-encoded storage account key" />
          </div>
        </>
      )}
      <button className="btn-primary" onClick={async () => {
        await updateRecordings({
          enabled,
          retention_days: parseInt(days),
          storage_type: storageType,
          azure_account_name: storageType === 'azure_blob' ? azureAccount : undefined,
          azure_container_name: storageType === 'azure_blob' ? azureContainer : undefined,
          azure_access_key: storageType === 'azure_blob' ? azureKey : undefined,
        });
        onSave();
      }}>
        Save Recording Settings
      </button>
    </div>
  );
}

function VaultTab({ settings, onSave }: { settings: Record<string, string>; onSave: () => void }) {
  const [mode, setMode] = useState<'local' | 'external'>('local');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [transitKey, setTransitKey] = useState('guac-master-key');
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [saving, setSaving] = useState(false);
  const [credTtl, setCredTtl] = useState(12);
  const [ttlSaving, setTtlSaving] = useState(false);

  useEffect(() => {
    getServiceHealth().then((h) => {
      setHealth(h);
      if (h.vault.configured) {
        setMode(h.vault.mode === 'local' ? 'local' : 'external');
        setAddress(h.vault.address);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const v = parseInt(settings.credential_ttl_hours || '12', 10);
    setCredTtl(Math.max(1, Math.min(12, isNaN(v) ? 12 : v)));
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    try {
      if (mode === 'local') {
        await updateVault({ mode: 'local', transit_key: transitKey });
      } else {
        await updateVault({ mode: 'external', address, token, transit_key: transitKey });
      }
      onSave();
    } catch {
      // handled by caller
    } finally {
      setSaving(false);
    }
  }

  const currentMode = health?.vault.mode === 'local' ? 'Bundled' : health?.vault.mode === 'external' ? 'External' : null;

  return (
    <div className="card">
      <h2>Vault Configuration</h2>
      {currentMode && (
        <p className="text-txt-secondary text-sm mb-4">
          Currently using <strong>{currentMode}</strong> vault at{' '}
          <code className="bg-surface-tertiary px-1.5 py-0.5 rounded text-xs">{health?.vault.address}</code>.
        </p>
      )}

      <div className="form-group">
        <label className="text-sm font-medium mb-2 block">Vault Mode</label>
        <div className="flex gap-2">
          <button
            className={`btn flex-1 ${mode === 'local' ? '!bg-accent/10 !border-accent !text-accent' : ''}`}
            onClick={() => setMode('local')}
          >
            Bundled
          </button>
          <button
            className={`btn flex-1 ${mode === 'external' ? '!bg-accent/10 !border-accent !text-accent' : ''}`}
            onClick={() => setMode('external')}
          >
            External
          </button>
        </div>
      </div>

      {mode === 'local' && (
        <p className="text-txt-secondary text-sm mb-4">
          Uses the bundled Vault container. It will be automatically initialized, unsealed, and configured.
        </p>
      )}

      {mode === 'external' && (
        <>
          <div className="form-group">
            <label>Vault URL</label>
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://vault:8200" />
          </div>
          <div className="form-group">
            <label>Vault Token / AppRole</label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="s.xxxxxxxxx" />
          </div>
        </>
      )}

      <div className="form-group">
        <label>Transit Key Name</label>
        <input value={transitKey} onChange={(e) => setTransitKey(e.target.value)} />
      </div>

      <button className="btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save Vault Settings'}
      </button>

      {/* ── Credential Password Expiry ── */}
      <div style={{ borderTop: '1px solid var(--color-border)', marginTop: '2rem', paddingTop: '1.5rem' }}>
        <h3 className="!mb-1">Credential Password Expiry</h3>
        <p className="text-txt-secondary text-sm mb-4">
          Stored credentials automatically expire after this duration. Users must update their password before expired credentials will be used.
          Maximum allowed TTL is 12 hours.
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
              style={{ accentColor: 'var(--color-accent)' }}
            />
            <span className="text-txt-primary font-semibold tabular-nums w-10 text-right">{credTtl}h</span>
          </div>
        </div>
        <button
          className="btn-primary"
          disabled={ttlSaving}
          onClick={async () => {
            setTtlSaving(true);
            try {
              await updateSettings([{ key: 'credential_ttl_hours', value: String(credTtl) }]);
              onSave();
            } catch { /* ignore */ }
            finally { setTtlSaving(false); }
          }}
        >
          {ttlSaving ? 'Saving...' : 'Save Expiry Setting'}
        </button>
      </div>
    </div>
  );
}

function AccessTab({
  user, roles, connections, folders, users, onRolesChanged, onConnectionCreated, onConnectionUpdated, onConnectionDeleted, onFoldersChanged, onUsersChanged,
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
  }>({
    name: '',
    can_manage_system: false,
    can_manage_users: false,
    can_manage_connections: false,
    can_view_audit_logs: false,
    can_create_users: false,
    can_create_user_groups: false,
    can_create_connections: false,
    can_create_connection_folders: false,
    can_create_sharing_profiles: false,
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
  const [roleModalTab, setRoleModalTab] = useState<'permissions' | 'assignments'>('permissions');
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
    });
    setRoleModalTab('permissions');
    setAssignmentConnectionIds([]);
    setAssignmentFolderIds([]);
    setRoleModalOpen(true);
    
    try {
      const mappings = await getRoleMappings(r.id);
      setAssignmentConnectionIds(mappings.connection_ids);
      setAssignmentFolderIds(mappings.folder_ids);
    } catch (err) {
      console.error('Failed to fetch role mappings:', err);
    }
  };
  const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
  const [formId, setFormId] = useState<string | null>(null);
  const [formCore, setFormCore] = useState({ name: '', protocol: 'rdp', hostname: '', port: 3389, domain: '', description: '', folder_id: '' });
  const [formExtra, setFormExtra] = useState<Record<string, string>>({});
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParent, setNewFolderParent] = useState('');
  const [connSearch, setConnSearch] = useState('');
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
    auth_type: 'local' | 'sso';
  }>({ username: '', email: '', full_name: '', role_id: '', auth_type: 'local' });
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [userError, setUserError] = useState('');
  const [userSaving, setUserSaving] = useState(false);
  const [showDeletedUsers, setShowDeletedUsers] = useState(false);
  const [deletedUsers, setDeletedUsers] = useState<User[]>([]);

  useEffect(() => {
    if (showDeletedUsers) {
      getUsers(true).then(all => {
        setDeletedUsers(all.filter(u => !!u.deleted_at));
      });
    }
  }, [showDeletedUsers, users]);

  const filteredConnections = connections.filter((c) => {
    if (!connSearch) return true;
    const q = connSearch.toLowerCase();
    return c.name.toLowerCase().includes(q)
      || c.hostname.toLowerCase().includes(q)
      || c.protocol.toLowerCase().includes(q)
      || (c.description || '').toLowerCase().includes(q)
      || (folders.find(f => f.id === c.folder_id)?.name || '').toLowerCase().includes(q);
  });
  const connTotalPages = Math.max(1, Math.ceil(filteredConnections.length / connPerPage));
  const safeConnPage = Math.min(connPage, connTotalPages);
  const pagedConnections = filteredConnections.slice((safeConnPage - 1) * connPerPage, safeConnPage * connPerPage);

  function openAdd() {
    setFormMode('add');
    setFormId(null);
    setFormCore({ name: '', protocol: 'rdp', hostname: '', port: 3389, domain: '', description: '', folder_id: '' });
    setFormExtra({ 'server-layout': 'en-gb-qwerty', 'timezone': 'Europe/London' });
    setTimeout(() => connFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  function openEdit(c: Connection) {
    setFormMode('edit');
    setFormId(c.id);
    setFormCore({ name: c.name, protocol: c.protocol, hostname: c.hostname, port: c.port, domain: c.domain || '', description: c.description || '', folder_id: c.folder_id || '' });
    setFormExtra(c.extra ? { ...c.extra } : {});
    setTimeout(() => connFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  function closeForm() {
    setFormMode('closed');
    setFormId(null);
  }

  const ex = (k: string) => formExtra[k] || '';
  const setEx = (k: string, v: string) => setFormExtra({ ...formExtra, [k]: v });

  // Strip empty values from extra before saving
  function cleanExtra(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(formExtra)) {
      if (v !== '' && v !== 'false') out[k] = v;
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
      if (formMode === 'add') {
        c = await createConnection(payload);
        onConnectionCreated(c);
      } else if (formMode === 'edit' && formId) {
        c = await updateConnection(formId, payload);
        onConnectionUpdated(c);
      }
      if (c) {
        setFormExtra(c.extra || {});
      }
      closeForm();
    } catch (err: any) {
      alert(err.message || 'Failed to save connection');
    }
  }

  const handleDelete = (id: string) => {
    setConfirmModal({
      title: 'Delete Connection',
      message: 'Are you sure you want to delete this connection? This action cannot be undone.',
      isDangerous: true,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        try {
          await deleteConnection(id);
          onConnectionDeleted(id);
          if (id === formId) {
            closeForm();
          }
        } catch (err: any) {
          alert(err.message || 'Failed to delete connection');
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
                  <td><span className="font-semibold text-accent">{r.name}</span></td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {r.can_manage_system && <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">System</span>}
                      {r.can_view_audit_logs && <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">Audit</span>}
                      {r.can_create_users && <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">Users</span>}
                      {r.can_create_user_groups && <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">Roles</span>}
                      {r.can_create_connections && <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">Connections</span>}
                      {r.can_create_connection_folders && <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">Folders</span>}
                      {r.can_create_sharing_profiles && <span className="badge badge-accent text-[9px] py-0 px-1.5 uppercase">Sharing</span>}
                      {!r.can_manage_system && !r.can_manage_users && !r.can_manage_connections && !r.can_view_audit_logs && !r.can_create_users && !r.can_create_user_groups && !r.can_create_connections && !r.can_create_connection_folders && !r.can_create_sharing_profiles && (
                        <span className="text-txt-tertiary text-[10px] italic">No permissions</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className="flex gap-2">
                      <button className="btn-ghost text-[0.8125rem] px-2 py-0.5" onClick={() => handleEditRole(r)}>Edit</button>
                      {r.name !== 'admin' && r.name !== 'user' && (
                        <button className="btn-ghost text-[0.8125rem] px-2 py-0.5 text-danger" onClick={() => {
                          setConfirmModal({
                            title: 'Delete Role',
                            message: `Are you sure you want to delete the role "${r.name}"? This will remove all associated permissions and mappings.`,
                            isDangerous: true,
                            confirmLabel: 'Delete',
                            onConfirm: async () => {
                              try {
                                await deleteRole(r.id);
                                getRoles().then(onRolesChanged);
                              } catch (err: any) {
                                alert(err.message || 'Failed to delete role');
                              } finally {
                                setConfirmModal(null);
                              }
                            },
                          });
                        }}>Delete</button>
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
                  name: '',
                  can_manage_system: false,
                  can_manage_users: false,
                  can_manage_connections: false,
                  can_view_audit_logs: false,
                  can_create_users: false,
                  can_create_user_groups: false,
                  can_create_connections: false,
                  can_create_connection_folders: false,
                  can_create_sharing_profiles: false,
                });
                setAssignmentConnectionIds([]);
                setAssignmentFolderIds([]);
                setRoleModalTab('permissions');
                setRoleModalOpen(true);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Create New Role
            </button>
          </div>

          {/* Role Modal */}
          {roleModalOpen && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
              <div className="card w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
                <h3 className="text-lg font-bold mb-4">{editingRole ? 'Edit Role' : 'Create New Role'}</h3>
                
                <div className="flex gap-2 mb-4 border-b border-border">
                  <button 
                    className={`pb-2 px-1 text-xs font-bold uppercase tracking-wider transition-colors ${roleModalTab === 'permissions' ? 'text-accent border-b-2 border-accent' : 'text-txt-tertiary hover:text-txt-primary'}`}
                    onClick={() => setRoleModalTab('permissions')}
                  >
                    Permissions
                  </button>
                  <button 
                    className={`pb-2 px-1 text-xs font-bold uppercase tracking-wider transition-colors ${roleModalTab === 'assignments' ? 'text-accent border-b-2 border-accent' : 'text-txt-tertiary hover:text-txt-primary'}`}
                    onClick={() => setRoleModalTab('assignments')}
                  >
                    Assignments
                  </button>
                </div>

                {roleModalTab === 'permissions' ? (
                  <>
                    <div className="form-group mb-4">
                      <label>Role Name</label>
                      <input 
                        value={newRole.name} 
                        onChange={e => setNewRole({...newRole, name: e.target.value})}
                        placeholder="e.g. Helpdesk"
                        disabled={editingRole?.name === 'admin' || editingRole?.name === 'user'}
                      />
                    </div>

                    <div className="space-y-3 mb-6">
                      <label className="text-xs font-bold uppercase tracking-wider text-txt-tertiary">Permissions</label>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input type="checkbox" className="checkbox" checked={newRole.can_manage_system} onChange={e => setNewRole({...newRole, can_manage_system: e.target.checked})} />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Administer system</span>
                          <span className="text-[10px] text-txt-tertiary">Settings, Auth, Vault, Infrastructure</span>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input type="checkbox" className="checkbox" checked={newRole.can_view_audit_logs} onChange={e => setNewRole({...newRole, can_view_audit_logs: e.target.checked})} />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Audit system</span>
                          <span className="text-[10px] text-txt-tertiary">Monitor administrative activity</span>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input type="checkbox" className="checkbox" checked={newRole.can_create_users} onChange={e => setNewRole({...newRole, can_create_users: e.target.checked})} />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Create new users</span>
                          <span className="text-[10px] text-txt-tertiary">Provisioning and user lifecycle</span>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input type="checkbox" className="checkbox" checked={newRole.can_create_user_groups} onChange={e => setNewRole({...newRole, can_create_user_groups: e.target.checked})} />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Create new roles</span>
                          <span className="text-[10px] text-txt-tertiary">Create and manage platform roles</span>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input type="checkbox" className="checkbox" checked={newRole.can_create_connections} onChange={e => setNewRole({...newRole, can_create_connections: e.target.checked})} />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Create new connections</span>
                          <span className="text-[10px] text-txt-tertiary">Hosts, protocols, shared drive configs</span>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input type="checkbox" className="checkbox" checked={newRole.can_create_connection_folders} onChange={e => setNewRole({...newRole, can_create_connection_folders: e.target.checked})} />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Create connection folders</span>
                          <span className="text-[10px] text-txt-tertiary">Organize connections into folders</span>
                        </div>
                      </label>
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <input type="checkbox" className="checkbox" checked={newRole.can_create_sharing_profiles} onChange={e => setNewRole({...newRole, can_create_sharing_profiles: e.target.checked})} />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Sharing Connections</span>
                          <span className="text-[10px] text-txt-tertiary">Share active RDP / SSH sessions with others</span>
                        </div>
                      </label>
                    </div>
                  </>
                ) : (
                  <div className="space-y-4 mb-6 max-h-[400px] overflow-y-auto pr-1">
                    <div>
                      <label className="text-xs font-bold uppercase tracking-wider text-txt-tertiary block mb-2">Assigned Folders</label>
                      <div className="space-y-1 bg-surface-secondary/30 p-2 rounded-lg border border-border/50">
                        {folders.length === 0 ? (
                          <div className="text-[10px] text-txt-tertiary italic p-1">No folders created yet</div>
                        ) : folders.map(f => (
                          <label key={f.id} className="flex items-center gap-2 cursor-pointer py-1 px-1.5 hover:bg-surface-secondary rounded transition-colors group">
                            <input 
                              type="checkbox" 
                              className="checkbox checkbox-sm" 
                              checked={assignmentFolderIds.includes(f.id)}
                              onChange={e => {
                                if (e.target.checked) setAssignmentFolderIds([...assignmentFolderIds, f.id]);
                                else setAssignmentFolderIds(assignmentFolderIds.filter(id => id !== f.id));
                              }}
                            />
                            <span className="text-xs font-medium group-hover:text-accent transition-colors">{f.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-bold uppercase tracking-wider text-txt-tertiary block mb-2">Individual Connections</label>
                      <div className="space-y-1 bg-surface-secondary/30 p-2 rounded-lg border border-border/50">
                        {connections.length === 0 ? (
                          <div className="text-[10px] text-txt-tertiary italic p-1">No connections created yet</div>
                        ) : connections.map(c => (
                          <label key={c.id} className="flex items-center gap-2 cursor-pointer py-1 px-1.5 hover:bg-surface-secondary rounded transition-colors group">
                            <input 
                              type="checkbox" 
                              className="checkbox checkbox-sm" 
                              checked={assignmentConnectionIds.includes(c.id)}
                              onChange={e => {
                                if (e.target.checked) setAssignmentConnectionIds([...assignmentConnectionIds, c.id]);
                                else setAssignmentConnectionIds(assignmentConnectionIds.filter(id => id !== c.id));
                              }}
                            />
                            <div className="flex flex-col">
                              <span className="text-xs font-medium group-hover:text-accent transition-colors">{c.name}</span>
                              <span className="text-[9px] text-txt-tertiary">{c.protocol.toUpperCase()} • {c.hostname}</span>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex gap-2">
                  <button className="btn w-full" onClick={() => setRoleModalOpen(false)}>Cancel</button>
                  <button 
                    className="btn-primary w-full" 
                    disabled={roleSaving || !newRole.name.trim()}
                    onClick={async () => {
                      setRoleSaving(true);
                      try {
                        if (editingRole) {
                          const r = await updateRole(editingRole.id, newRole);
                          await updateRoleMappings(r.id, assignmentConnectionIds, assignmentFolderIds);
                          onRolesChanged(roles.map(x => x.id === r.id ? r : x));
                        } else {
                          const r = await createRole(newRole);
                          await updateRoleMappings(r.id, assignmentConnectionIds, assignmentFolderIds);
                          onRolesChanged([...roles, r]);
                        }
                        setRoleModalOpen(false);
                      } catch (err: any) {
                        alert(err.message || 'Failed to save role');
                      } finally {
                        setRoleSaving(false);
                      }
                    }}
                  >
                    {roleSaving ? 'Saving...' : editingRole ? 'Save Changes' : 'Create Role'}
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
              onChange={(e) => { setConnSearch(e.target.value); setConnPage(1); }}
              placeholder="Search connections by name, host, protocol, description, or folder..."
              className="input w-full"
            />
          </div>
          <p className="text-sm text-txt-secondary mb-2">
            Showing {filteredConnections.length === connections.length ? connections.length : `${filteredConnections.length} of ${connections.length}`} connection{connections.length !== 1 ? 's' : ''}
          </p>
          <div className="table-responsive">
            <table>
              <thead><tr><th>Name</th><th>Protocol</th><th>Host</th><th>Port</th><th>Folder</th><th className="w-[140px]">Actions</th></tr></thead>
              <tbody>
                {pagedConnections.map((c) => (
                  <tr key={c.id} className={formId === c.id ? 'bg-surface-secondary' : ''}>
                    <td>
                      <div className="font-medium text-txt-primary">{c.name}</div>
                      {c.description && <div className="text-[0.75rem] text-txt-tertiary">{c.description}</div>}
                    </td>
                    <td><span className="badge badge-secondary py-0 px-1 text-[10px]">{c.protocol.toUpperCase()}</span></td>
                    <td>{c.hostname}</td>
                    <td>{c.port}</td>
                    <td>{c.folder_id ? (folders.find(f => f.id === c.folder_id)?.name || '—') : '—'}</td>
                    <td>
                      <div className="flex gap-1">
                        <button className="btn-ghost text-[0.8rem] px-2 py-1" onClick={() => openEdit(c)}>Edit</button>
                        <button className="btn-ghost text-[0.8rem] px-2 py-1 text-danger" onClick={() => handleDelete(c.id)}>Delete</button>
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
                  onClick={() => setConnPage(p => Math.max(1, p - 1))}
                >
                  ← Prev
                </button>
                <button
                  className="btn-ghost text-xs px-2 py-1"
                  disabled={safeConnPage === connTotalPages}
                  onClick={() => setConnPage(p => Math.min(connTotalPages, p + 1))}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Connection Editor Form */}
      {(user.can_manage_system || user.can_create_connections) && formMode !== 'closed' && (
        <div className="card" ref={connFormRef}>
          <div className="flex justify-between items-center mb-4">
            <h2 className="!mb-0">{formMode === 'add' ? 'Add Connection' : 'Edit Connection'}</h2>
            <button className="btn text-[0.8rem] px-2 py-1" onClick={closeForm}>Cancel</button>
          </div>
          <div className="mb-4" style={{ display: 'grid', gridTemplateColumns: '1fr 100px 1fr 80px 1fr', gap: '0.5rem' }}>
            <div className="form-group !mb-0">
              <label>Name</label>
              <input value={formCore.name} onChange={(e) => setFormCore({ ...formCore, name: e.target.value })} placeholder="My Server" />
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
                  { value: 'rdp', label: 'RDP' },
                  { value: 'ssh', label: 'SSH' },
                  { value: 'vnc', label: 'VNC' },
                ]}
              />
            </div>
            <div className="form-group !mb-0">
              <label>Hostname</label>
              <input value={formCore.hostname} onChange={(e) => setFormCore({ ...formCore, hostname: e.target.value })} placeholder="10.0.0.10" />
            </div>
            <div className="form-group !mb-0">
              <label>Port</label>
              <input type="number" value={formCore.port} onChange={(e) => setFormCore({ ...formCore, port: parseInt(e.target.value) || 0 })} />
            </div>
            <div className="form-group !mb-0">
              <label>Domain</label>
              <input value={formCore.domain} onChange={(e) => setFormCore({ ...formCore, domain: e.target.value })} placeholder="EXAMPLE.COM" />
            </div>
          </div>
          <div className="mb-4" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <div className="form-group !mb-0">
              <label>Description</label>
              <input value={formCore.description} onChange={(e) => setFormCore({ ...formCore, description: e.target.value })} placeholder="Optional description" />
            </div>
            <div className="form-group !mb-0">
              <label>Folder</label>
              <Select
                value={formCore.folder_id}
                onChange={(v) => setFormCore({ ...formCore, folder_id: v })}
                placeholder="No folder"
                options={[
                  { value: '', label: 'No folder' },
                  ...folders.map(f => ({ value: f.id, label: f.parent_id ? `  └ ${f.name}` : f.name })),
                ]}
              />
            </div>
          </div>

          <div className="mt-6">
            <h4 className="text-sm font-bold uppercase tracking-widest text-txt-tertiary mb-3">Protocol Parameters</h4>
            {formCore.protocol === 'rdp' && <RdpSections extra={formExtra} setExtra={setFormExtra} ex={ex} setEx={setEx} />}
            {formCore.protocol === 'ssh' && <SshSections ex={ex} setEx={setEx} />}
            {formCore.protocol === 'vnc' && <VncSections ex={ex} setEx={setEx} />}
          </div>
          <div className="flex gap-2 mt-4">
            <button className="btn-primary" onClick={handleSave}>
              {formMode === 'add' ? 'Create Connection' : 'Save Changes'}
            </button>
            <button className="btn" onClick={closeForm}>Cancel</button>
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
              <thead><tr><th>Name</th><th>Parent</th><th className="w-[100px]">Actions</th></tr></thead>
              <tbody>
                {folders.map((f) => (
                  <tr key={f.id}>
                    <td><span className="font-medium">{f.name}</span></td>
                    <td>{f.parent_id ? (folders.find(p => p.id === f.parent_id)?.name || '—') : <span className="text-txt-tertiary italic">Root</span>}</td>
                    <td>
                      <button className="btn-ghost text-[0.8rem] px-2 py-1 text-danger hover:bg-danger/10" onClick={() => {
                        setConfirmModal({
                          title: 'Delete Folder',
                          message: `Are you sure you want to delete the folder "${f.name}"? All connections inside this folder will become unassigned.`,
                          isDangerous: true,
                          confirmLabel: 'Delete',
                          onConfirm: async () => {
                            try {
                              await deleteConnectionFolder(f.id);
                              onFoldersChanged(folders.filter(x => x.id !== f.id));
                            } catch (err: any) {
                              alert(err.message || 'Failed to delete folder');
                            } finally {
                              setConfirmModal(null);
                            }
                          },
                        });
                      }}>Delete</button>
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
                    { value: '', label: 'Root Level' },
                    ...folders.filter(f => !f.parent_id).map(f => ({ value: f.id, label: f.name })),
                  ]}
                />
              </div>
              <button 
                className="btn-primary flex items-center gap-2 whitespace-nowrap shadow-sm"
                disabled={!newFolderName.trim()}
                onClick={async () => {
                  if (!newFolderName.trim()) return;
                  const f = await createConnectionFolder({ name: newFolderName.trim(), parent_id: newFolderParent || undefined });
                  onFoldersChanged([...folders, f]);
                  setNewFolderName('');
                  setNewFolderParent('');
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
                  onChange={e => setShowDeletedUsers(e.target.checked)} 
                />
                Show Deleted Users
              </label>
              <button 
                className="btn-primary text-xs py-1 px-3 shadow-sm"
                onClick={() => {
                  setUserForm({ username: '', email: '', full_name: '', role_id: '', auth_type: 'local' });
                  setCreatedPassword(null);
                  setUserError('');
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
                      {u.full_name && <div className="text-[10px] text-txt-tertiary uppercase tracking-tighter">{u.full_name}</div>}
                    </td>
                    <td className="text-sm">{u.email}</td>
                    <td>
                      <span className={`badge text-[10px] uppercase font-bold ${u.auth_type === 'sso' ? 'badge-accent' : 'badge-secondary'}`}>
                        {u.auth_type}
                      </span>
                    </td>
                    <td>
                      <span className="text-sm font-medium opacity-80">{u.role_name}</span>
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
                                alert(err.message || 'Failed to restore user');
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
                                title: 'Delete User',
                                message: `Delete user "${u.username}"? (Soft-delete for 7 days)`,
                                isDangerous: true,
                                confirmLabel: 'Delete',
                                onConfirm: async () => {
                                  try {
                                    await deleteUser(u.id);
                                    onUsersChanged(users.filter(x => x.id !== u.id));
                                  } catch (err: any) {
                                    alert(err.message || 'Failed to delete user');
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
          <div className="card w-full max-w-md shadow-2xl animate-in fade-in zoom-in duration-200" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-txt-primary">Provision New User</h3>
              {!createdPassword && (
                <button className="text-txt-tertiary hover:text-txt-primary" onClick={() => setUserModalOpen(false)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
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
                  <span className="text-[10px] uppercase tracking-widest text-txt-tertiary font-bold block mb-2">Temporary Password</span>
                  <div className="text-2xl font-mono tracking-tighter text-accent bg-surface-secondary py-3 rounded border border-accent/20 select-all">
                    {createdPassword}
                  </div>
                </div>

                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded text-amber-500 text-xs text-center">
                  This password will <strong>never be shown again</strong>.
                </div>

                <button className="btn-primary w-full py-3" onClick={() => { setUserModalOpen(false); }}>
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
                      onChange={e => setUserForm({...userForm, username: e.target.value})}
                      placeholder="jsmith"
                    />
                  </div>
                  <div className="form-group !mb-0">
                    <label>Auth Type</label>
                    <Select 
                      value={userForm.auth_type}
                      onChange={v => setUserForm({...userForm, auth_type: v as 'local' | 'sso'})}
                      options={[
                        { value: 'local', label: 'Local (Password)' },
                        { value: 'sso', label: 'SSO (OIDC)' },
                      ]}
                    />
                  </div>
                </div>

                <div className="form-group !mb-0">
                  <label>Email Address</label>
                  <input 
                    type="email"
                    value={userForm.email} 
                    onChange={e => setUserForm({...userForm, email: e.target.value})}
                    placeholder="john.smith@example.com"
                  />
                </div>

                <div className="form-group !mb-0">
                  <label>Initial Role</label>
                  <Select 
                    value={userForm.role_id}
                    onChange={v => setUserForm({...userForm, role_id: v})}
                    options={roles.map(r => ({ value: r.id, label: r.name }))}
                  />
                </div>

                {userError && (
                  <div className="p-3 bg-danger-dim text-danger text-sm rounded border border-danger/20">
                    {userError}
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button className="btn w-full" onClick={() => setUserModalOpen(false)}>Cancel</button>
                  <button 
                    className="btn-primary w-full" 
                    disabled={userSaving || !userForm.username}
                    onClick={async () => {
                      setUserSaving(true);
                      setUserError('');
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
                        setUserError(err.message || 'Failed to create user');
                      } finally {
                        setUserSaving(false);
                      }
                    }}
                  >
                    {userSaving ? 'Creating...' : 'Create User'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <ConfirmModal
        isOpen={!!confirmModal}
        title={confirmModal?.title || ''}
        message={confirmModal?.message || ''}
        confirmLabel={confirmModal?.confirmLabel}
        isDangerous={confirmModal?.isDangerous}
        onConfirm={() => confirmModal?.onConfirm()}
        onCancel={() => setConfirmModal(null)}
      />
    </div>
  );
}

// ── Helper: Collapsible Section ─────────────────────────────────────

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border rounded-md mb-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full text-left px-3 py-2 bg-surface-secondary border-0 cursor-pointer font-semibold text-sm text-txt-primary ${open ? 'rounded-t-md' : 'rounded-md'}`}
      >
        {open ? '▾' : '▸'} {title}
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
  extra: _extra, setExtra: _setExtra, ex, setEx,
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
            <label>Security Mode</label>
            <Select
              value={ex('security') || 'any'}
              onChange={(v) => setEx('security', v)}
              options={[
                { value: 'any', label: 'Any' },
                { value: 'nla', label: 'NLA' },
                { value: 'nla-ext', label: 'NLA + Extended' },
                { value: 'tls', label: 'TLS' },
                { value: 'rdp', label: 'RDP Encryption' },
                { value: 'vmconnect', label: 'Hyper-V / VMConnect' },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2 mt-1">
              <input type="checkbox" checked={ex('ignore-cert') !== 'false'} onChange={(e) => setEx('ignore-cert', e.target.checked ? 'true' : 'false')} className="checkbox" />
              Ignore server certificate
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Remote Desktop Gateway">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Gateway Hostname</label>
            <input value={ex('gateway-hostname')} onChange={(e) => setEx('gateway-hostname', e.target.value)} placeholder="gw.example.com" />
          </div>
          <div className="form-group !mb-0">
            <label>Gateway Port</label>
            <input type="number" value={ex('gateway-port')} onChange={(e) => setEx('gateway-port', e.target.value)} placeholder="443" />
          </div>
          <div className="form-group !mb-0">
            <label>Gateway Domain</label>
            <input value={ex('gateway-domain')} onChange={(e) => setEx('gateway-domain', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>Gateway Username</label>
            <input value={ex('gateway-username')} onChange={(e) => setEx('gateway-username', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>Gateway Password</label>
            <input type="password" value={ex('gateway-password')} onChange={(e) => setEx('gateway-password', e.target.value)} />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Basic Settings">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Keyboard Layout</label>
            <Select
              value={ex('server-layout')}
              onChange={(v) => setEx('server-layout', v)}
              placeholder="Default (US English)"
              options={[
                { value: '', label: 'Default (US English)' },
                { value: 'en-us-qwerty', label: 'US English (Qwerty)' },
                { value: 'en-gb-qwerty', label: 'UK English (Qwerty)' },
                { value: 'de-de-qwertz', label: 'German (Qwertz)' },
                { value: 'de-ch-qwertz', label: 'Swiss German (Qwertz)' },
                { value: 'fr-fr-azerty', label: 'French (Azerty)' },
                { value: 'fr-ch-qwertz', label: 'Swiss French (Qwertz)' },
                { value: 'fr-be-azerty', label: 'Belgian French (Azerty)' },
                { value: 'it-it-qwerty', label: 'Italian (Qwerty)' },
                { value: 'es-es-qwerty', label: 'Spanish (Qwerty)' },
                { value: 'es-latam-qwerty', label: 'Latin American (Qwerty)' },
                { value: 'pt-br-qwerty', label: 'Brazilian Portuguese (Qwerty)' },
                { value: 'pt-pt-qwerty', label: 'Portuguese (Qwerty)' },
                { value: 'sv-se-qwerty', label: 'Swedish (Qwerty)' },
                { value: 'da-dk-qwerty', label: 'Danish (Qwerty)' },
                { value: 'no-no-qwerty', label: 'Norwegian (Qwerty)' },
                { value: 'fi-fi-qwerty', label: 'Finnish (Qwerty)' },
                { value: 'hu-hu-qwertz', label: 'Hungarian (Qwertz)' },
                { value: 'ja-jp-qwerty', label: 'Japanese (Qwerty)' },
                { value: 'tr-tr-qwerty', label: 'Turkish-Q (Qwerty)' },
                { value: 'failsafe', label: 'Failsafe (Unicode events)' },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>Timezone</label>
            <input value={ex('timezone')} onChange={(e) => setEx('timezone', e.target.value)} placeholder="America/New_York" />
          </div>
          <div className="form-group !mb-0">
            <label>Client Name</label>
            <input value={ex('client-name')} onChange={(e) => setEx('client-name', e.target.value)} placeholder="Strata" />
          </div>
          <div className="form-group !mb-0">
            <label>Initial Program</label>
            <input value={ex('initial-program')} onChange={(e) => setEx('initial-program', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('console') === 'true'} onChange={(e) => setEx('console', e.target.checked ? 'true' : '')} className="checkbox" />
              Administrator console
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-touch') === 'true'} onChange={(e) => setEx('enable-touch', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable multi-touch
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Color Depth</label>
            <Select
              value={ex('color-depth')}
              onChange={(v) => setEx('color-depth', v)}
              placeholder="Auto"
              options={[
                { value: '', label: 'Auto' },
                { value: '8', label: '8-bit (256 colors)' },
                { value: '16', label: '16-bit (High color)' },
                { value: '24', label: '24-bit (True color)' },
                { value: '32', label: '32-bit' },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>Resize Method</label>
            <Select
              value={ex('resize-method') || 'display-update'}
              onChange={(v) => setEx('resize-method', v)}
              options={[
                { value: 'display-update', label: 'Display Update' },
                { value: 'reconnect', label: 'Reconnect' },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('force-lossless') === 'true'} onChange={(e) => setEx('force-lossless', e.target.checked ? 'true' : '')} className="checkbox" />
              Force lossless compression
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('read-only') === 'true'} onChange={(e) => setEx('read-only', e.target.checked ? 'true' : '')} className="checkbox" />
              Read-only (view only)
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Clipboard">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Normalize Clipboard</label>
            <Select
              value={ex('normalize-clipboard')}
              onChange={(v) => setEx('normalize-clipboard', v)}
              placeholder="Default (preserve)"
              options={[
                { value: '', label: 'Default (preserve)' },
                { value: 'preserve', label: 'Preserve' },
                { value: 'unix', label: 'Unix (LF)' },
                { value: 'windows', label: 'Windows (CRLF)' },
              ]}
            />
          </div>
          <div className="form-group !mb-0" />
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-copy') === 'true'} onChange={(e) => setEx('disable-copy', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable copy from remote
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-paste') === 'true'} onChange={(e) => setEx('disable-paste', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable paste to remote
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Device Redirection">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-audio') === 'true'} onChange={(e) => setEx('disable-audio', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable audio playback
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-audio-input') === 'true'} onChange={(e) => setEx('enable-audio-input', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable audio input (microphone)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-printing') === 'true'} onChange={(e) => setEx('enable-printing', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable printing
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>Printer Name</label>
            <input value={ex('printer-name')} onChange={(e) => setEx('printer-name', e.target.value)} placeholder="Strata Printer" />
          </div>
        </FieldGrid>
        <hr className="border-0 border-t border-border my-3" />
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-drive') === 'true'} onChange={(e) => setEx('enable-drive', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable drive / file transfer
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>Drive Name</label>
            <input value={ex('drive-name')} onChange={(e) => setEx('drive-name', e.target.value)} placeholder="Shared Drive" />
          </div>
          <div className="form-group !mb-0">
            <label>Drive Path</label>
            <input value={ex('drive-path')} onChange={(e) => setEx('drive-path', e.target.value)} placeholder="/var/lib/guacamole/drive" />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('create-drive-path') === 'true'} onChange={(e) => setEx('create-drive-path', e.target.checked ? 'true' : '')} className="checkbox" />
              Auto-create drive path
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-download') === 'true'} onChange={(e) => setEx('disable-download', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable file download
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-upload') === 'true'} onChange={(e) => setEx('disable-upload', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable file upload
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Performance">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-wallpaper') === 'true'} onChange={(e) => setEx('enable-wallpaper', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable wallpaper
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-theming') === 'true'} onChange={(e) => setEx('enable-theming', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable theming
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-font-smoothing') === 'true'} onChange={(e) => setEx('enable-font-smoothing', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable font smoothing (ClearType)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-full-window-drag') === 'true'} onChange={(e) => setEx('enable-full-window-drag', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable full-window drag
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-desktop-composition') === 'true'} onChange={(e) => setEx('enable-desktop-composition', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable desktop composition (Aero)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-menu-animations') === 'true'} onChange={(e) => setEx('enable-menu-animations', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable menu animations
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-bitmap-caching') === 'true'} onChange={(e) => setEx('disable-bitmap-caching', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable bitmap caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-offscreen-caching') === 'true'} onChange={(e) => setEx('disable-offscreen-caching', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable offscreen caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-glyph-caching') === 'true'} onChange={(e) => setEx('disable-glyph-caching', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable glyph caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-gfx') === 'true'} onChange={(e) => setEx('disable-gfx', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable graphics pipeline (GFX)
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="RemoteApp">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Program</label>
            <input value={ex('remote-app')} onChange={(e) => setEx('remote-app', e.target.value)} placeholder="||notepad" />
          </div>
          <div className="form-group !mb-0">
            <label>Working Directory</label>
            <input value={ex('remote-app-dir')} onChange={(e) => setEx('remote-app-dir', e.target.value)} placeholder="C:\Users\user" />
          </div>
          <div className="form-group !mb-0">
            <label>Parameters</label>
            <input value={ex('remote-app-args')} onChange={(e) => setEx('remote-app-args', e.target.value)} />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Load Balancing / Preconnection">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Load Balance Info</label>
            <input value={ex('load-balance-info')} onChange={(e) => setEx('load-balance-info', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>Preconnection ID</label>
            <input type="number" value={ex('preconnection-id')} onChange={(e) => setEx('preconnection-id', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>Preconnection BLOB</label>
            <input value={ex('preconnection-blob')} onChange={(e) => setEx('preconnection-blob', e.target.value)} />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Recording Path</label>
            <input value={ex('recording-path')} onChange={(e) => setEx('recording-path', e.target.value)} placeholder="/var/lib/guacamole/recordings" />
          </div>
          <div className="form-group !mb-0">
            <label>Recording Name</label>
            <input value={ex('recording-name')} onChange={(e) => setEx('recording-name', e.target.value)} placeholder="recording" />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('create-recording-path') === 'true'} onChange={(e) => setEx('create-recording-path', e.target.checked ? 'true' : '')} className="checkbox" />
              Auto-create recording path
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-exclude-output') === 'true'} onChange={(e) => setEx('recording-exclude-output', e.target.checked ? 'true' : '')} className="checkbox" />
              Exclude graphical output
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-exclude-mouse') === 'true'} onChange={(e) => setEx('recording-exclude-mouse', e.target.checked ? 'true' : '')} className="checkbox" />
              Exclude mouse events
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-exclude-touch') === 'true'} onChange={(e) => setEx('recording-exclude-touch', e.target.checked ? 'true' : '')} className="checkbox" />
              Exclude touch events
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-include-keys') === 'true'} onChange={(e) => setEx('recording-include-keys', e.target.checked ? 'true' : '')} className="checkbox" />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="SFTP">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-sftp') === 'true'} onChange={(e) => setEx('enable-sftp', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable SFTP file transfer
            </label>
          </div>
          <div className="form-group !mb-0" />
          <div className="form-group !mb-0">
            <label>SFTP Hostname</label>
            <input value={ex('sftp-hostname')} onChange={(e) => setEx('sftp-hostname', e.target.value)} placeholder="Same as RDP host" />
          </div>
          <div className="form-group !mb-0">
            <label>SFTP Port</label>
            <input type="number" value={ex('sftp-port')} onChange={(e) => setEx('sftp-port', e.target.value)} placeholder="22" />
          </div>
          <div className="form-group !mb-0">
            <label>SFTP Username</label>
            <input value={ex('sftp-username')} onChange={(e) => setEx('sftp-username', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>SFTP Password</label>
            <input type="password" value={ex('sftp-password')} onChange={(e) => setEx('sftp-password', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>SFTP Private Key</label>
            <textarea value={ex('sftp-private-key')} onChange={(e) => setEx('sftp-private-key', e.target.value)} rows={3} className="font-mono text-[0.8rem]" />
          </div>
          <div className="form-group !mb-0">
            <label>SFTP Passphrase</label>
            <input type="password" value={ex('sftp-passphrase')} onChange={(e) => setEx('sftp-passphrase', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>Default Upload Directory</label>
            <input value={ex('sftp-directory')} onChange={(e) => setEx('sftp-directory', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>SFTP Root Directory</label>
            <input value={ex('sftp-root-directory')} onChange={(e) => setEx('sftp-root-directory', e.target.value)} placeholder="/" />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Wake-on-LAN">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('wol-send-packet') === 'true'} onChange={(e) => setEx('wol-send-packet', e.target.checked ? 'true' : '')} className="checkbox" />
              Send WoL packet before connecting
            </label>
          </div>
          <div className="form-group !mb-0" />
          <div className="form-group !mb-0">
            <label>MAC Address</label>
            <input value={ex('wol-mac-addr')} onChange={(e) => setEx('wol-mac-addr', e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" />
          </div>
          <div className="form-group !mb-0">
            <label>Broadcast Address</label>
            <input value={ex('wol-broadcast-addr')} onChange={(e) => setEx('wol-broadcast-addr', e.target.value)} placeholder="255.255.255.255" />
          </div>
          <div className="form-group !mb-0">
            <label>UDP Port</label>
            <input type="number" value={ex('wol-udp-port')} onChange={(e) => setEx('wol-udp-port', e.target.value)} placeholder="9" />
          </div>
          <div className="form-group !mb-0">
            <label>Wait Time (seconds)</label>
            <input type="number" value={ex('wol-wait-time')} onChange={(e) => setEx('wol-wait-time', e.target.value)} placeholder="0" />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Kerberos / NLA">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Auth Package</label>
            <Select
              value={ex('auth-pkg')}
              onChange={(v) => setEx('auth-pkg', v)}
              placeholder="Default"
              options={[
                { value: '', label: 'Default' },
                { value: 'Negotiate', label: 'Negotiate (Kerberos/NTLM)' },
                { value: 'NTLM', label: 'NTLM only' },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>KDC URL</label>
            <input value={ex('kdc-url')} onChange={(e) => setEx('kdc-url', e.target.value)} placeholder="kdc.example.com" />
          </div>
          <div className="form-group !mb-0">
            <label>Kerberos Cache Path</label>
            <input value={ex('kerberos-cache')} onChange={(e) => setEx('kerberos-cache', e.target.value)} placeholder="/tmp/krb5cc_guacd" />
          </div>
        </FieldGrid>
      </Section>
    </>
  );
}

// ── SSH Parameter Sections ──────────────────────────────────────────

function SshSections({ ex, setEx }: { ex: (k: string) => string; setEx: (k: string, v: string) => void }) {
  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Private Key</label>
            <textarea value={ex('private-key')} onChange={(e) => setEx('private-key', e.target.value)} rows={3} className="font-mono text-[0.8rem]" />
          </div>
          <div className="form-group !mb-0">
            <label>Passphrase</label>
            <input type="password" value={ex('passphrase')} onChange={(e) => setEx('passphrase', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>Host Key</label>
            <input value={ex('host-key')} onChange={(e) => setEx('host-key', e.target.value)} placeholder="Server public key (optional)" />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Color Scheme</label>
            <Select
              value={ex('color-scheme')}
              onChange={(v) => setEx('color-scheme', v)}
              placeholder="Default (black on white)"
              options={[
                { value: '', label: 'Default (black on white)' },
                { value: 'green-black', label: 'Green on black' },
                { value: 'white-black', label: 'White on black' },
                { value: 'gray-black', label: 'Gray on black' },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>Font Name</label>
            <input value={ex('font-name')} onChange={(e) => setEx('font-name', e.target.value)} placeholder="monospace" />
          </div>
          <div className="form-group !mb-0">
            <label>Font Size</label>
            <input type="number" value={ex('font-size')} onChange={(e) => setEx('font-size', e.target.value)} placeholder="12" />
          </div>
          <div className="form-group !mb-0">
            <label>Scrollback (lines)</label>
            <input type="number" value={ex('scrollback')} onChange={(e) => setEx('scrollback', e.target.value)} placeholder="1000" />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('read-only') === 'true'} onChange={(e) => setEx('read-only', e.target.checked ? 'true' : '')} className="checkbox" />
              Read-only
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Terminal Behavior">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Command</label>
            <input value={ex('command')} onChange={(e) => setEx('command', e.target.value)} placeholder="Execute on connect" />
          </div>
          <div className="form-group !mb-0">
            <label>Locale</label>
            <input value={ex('locale')} onChange={(e) => setEx('locale', e.target.value)} placeholder="en_US.UTF-8" />
          </div>
          <div className="form-group !mb-0">
            <label>Timezone</label>
            <input value={ex('timezone')} onChange={(e) => setEx('timezone', e.target.value)} placeholder="America/New_York" />
          </div>
          <div className="form-group !mb-0">
            <label>Terminal Type</label>
            <input value={ex('terminal-type')} onChange={(e) => setEx('terminal-type', e.target.value)} placeholder="xterm-256color" />
          </div>
          <div className="form-group !mb-0">
            <label>Server Alive Interval</label>
            <input type="number" value={ex('server-alive-interval')} onChange={(e) => setEx('server-alive-interval', e.target.value)} placeholder="0" />
          </div>
        </FieldGrid>
      </Section>

      <Section title="SFTP">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-sftp') === 'true'} onChange={(e) => setEx('enable-sftp', e.target.checked ? 'true' : '')} className="checkbox" />
              Enable SFTP
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>SFTP Root Directory</label>
            <input value={ex('sftp-root-directory')} onChange={(e) => setEx('sftp-root-directory', e.target.value)} placeholder="/" />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('sftp-disable-download') === 'true'} onChange={(e) => setEx('sftp-disable-download', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable file download
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('sftp-disable-upload') === 'true'} onChange={(e) => setEx('sftp-disable-upload', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable file upload
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>Recording Path</label>
            <input value={ex('recording-path')} onChange={(e) => setEx('recording-path', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>Recording Name</label>
            <input value={ex('recording-name')} onChange={(e) => setEx('recording-name', e.target.value)} />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('create-recording-path') === 'true'} onChange={(e) => setEx('create-recording-path', e.target.checked ? 'true' : '')} className="checkbox" />
              Auto-create recording path
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-include-keys') === 'true'} onChange={(e) => setEx('recording-include-keys', e.target.checked ? 'true' : '')} className="checkbox" />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Wake-on-LAN">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('wol-send-packet') === 'true'} onChange={(e) => setEx('wol-send-packet', e.target.checked ? 'true' : '')} className="checkbox" />
              Send WoL packet
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>MAC Address</label>
            <input value={ex('wol-mac-addr')} onChange={(e) => setEx('wol-mac-addr', e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" />
          </div>
        </FieldGrid>
      </Section>
    </>
  );
}

// ── VNC Parameter Sections ──────────────────────────────────────────

function VncSections({ ex, setEx }: { ex: (k: string) => string; setEx: (k: string, v: string) => void }) {
  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Password</label>
            <input type="password" value={ex('password')} onChange={(e) => setEx('password', e.target.value)} />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Color Depth</label>
            <Select
              value={ex('color-depth')}
              onChange={(v) => setEx('color-depth', v)}
              placeholder="Auto"
              options={[
                { value: '', label: 'Auto' },
                { value: '8', label: '8-bit' },
                { value: '16', label: '16-bit' },
                { value: '24', label: '24-bit' },
                { value: '32', label: '32-bit' },
              ]}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Cursor</label>
            <Select
              value={ex('cursor')}
              onChange={(v) => setEx('cursor', v)}
              placeholder="Local"
              options={[
                { value: '', label: 'Local' },
                { value: 'remote', label: 'Remote' },
              ]}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={ex('read-only') === 'true'} onChange={(e) => setEx('read-only', e.target.checked ? 'true' : '')} className="checkbox" />
              Read-only
            </label>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={ex('swap-red-blue') === 'true'} onChange={(e) => setEx('swap-red-blue', e.target.checked ? 'true' : '')} className="checkbox" />
              Swap red/blue
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Clipboard">
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={ex('disable-copy') === 'true'} onChange={(e) => setEx('disable-copy', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable copy from remote
            </label>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={ex('disable-paste') === 'true'} onChange={(e) => setEx('disable-paste', e.target.checked ? 'true' : '')} className="checkbox" />
              Disable paste to remote
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Recording Path</label>
            <input value={ex('recording-path')} onChange={(e) => setEx('recording-path', e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Recording Name</label>
            <input value={ex('recording-name')} onChange={(e) => setEx('recording-name', e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={ex('create-recording-path') === 'true'} onChange={(e) => setEx('create-recording-path', e.target.checked ? 'true' : '')} className="checkbox" />
              Auto-create recording path
            </label>
          </div>
        </FieldGrid>
      </Section>
    </>
  );
}

// ── Sessions Tab (NVR) ──────────────────────────────────────────────

function SessionsTab() {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  function refresh() {
    setLoading(true);
    getActiveSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  function formatDuration(startedAt: string) {
    const start = new Date(startedAt).getTime();
    const now = Date.now();
    const secs = Math.floor((now - start) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatBuffer(secs: number) {
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Active Sessions</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Live user sessions with NVR buffer. Observe or rewind up to 5 minutes.
          </p>
        </div>
        <button
          onClick={refresh}
          className="btn-sm-primary"
          disabled={loading}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {sessions.length === 0 && !loading ? (
        <div className="text-center py-12 text-txt-secondary">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p>No active sessions</p>
          <p className="text-xs mt-1">Sessions appear here when users connect to remote desktops.</p>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Connection</th>
                <th>Duration</th>
                <th>Buffer</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.session_id}>
                  <td>
                    <span className="font-medium text-txt-primary">{s.username}</span>
                  </td>
                  <td>
                    <span className="text-txt-primary">{s.connection_name}</span>
                  </td>
                  <td>
                    <span className="text-txt-secondary text-sm font-mono tabular-nums">
                      {formatDuration(s.started_at)}
                    </span>
                  </td>
                  <td>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400">
                      {formatBuffer(s.buffer_depth_secs)}
                    </span>
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        className="btn btn-secondary text-xs py-1 px-2"
                        onClick={() => navigate(`/observe/${encodeURIComponent(s.session_id)}?offset=0&name=${encodeURIComponent(s.connection_name)}&user=${encodeURIComponent(s.username)}`)}
                        title="Watch live"
                      >
                        ● Live
                      </button>
                      <button
                        className="btn btn-secondary text-xs py-1 px-2"
                        onClick={() => navigate(`/observe/${encodeURIComponent(s.session_id)}?offset=300&name=${encodeURIComponent(s.connection_name)}&user=${encodeURIComponent(s.username)}`)}
                        title="Rewind and replay the last 5 minutes"
                      >
                        ⏪ Rewind
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── AD Sync Tab ──────────────────────────────────────────────────────

function AdSyncTab({ folders, onSave }: { folders: ConnectionFolder[]; onSave: () => void }) {
  const [configs, setConfigs] = useState<AdSyncConfig[]>([]);
  const [editing, setEditing] = useState<Partial<AdSyncConfig> | null>(null);
  const [selectedRuns, setSelectedRuns] = useState<{ configId: string; runs: AdSyncRun[] } | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: string; message: string; sample?: string[]; count?: number } | null>(null);
  const certFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    getAdSyncConfigs().then(setConfigs).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!editing) return;
    try {
      if (editing.id) {
        await updateAdSyncConfig(editing.id, editing);
      } else {
        await createAdSyncConfig(editing);
      }
      setEditing(null);
      load();
      onSave();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this AD sync source? Imported connections will remain but will no longer sync.')) return;
    await deleteAdSyncConfig(id);
    load();
  };

  const handleClone = (c: AdSyncConfig) => {
    setEditing({
      ...c,
      id: undefined,
      label: `${c.label} (Copy)`,
      clone_from: c.id,
      bind_password: '••••••••',
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
      setTestResult({ status: 'error', message: e.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const folderOptions = [
    { value: '', label: '— No folder —' },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
  ];

  const presetFilters = [
    '(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))',
    '(&(objectClass=computer)(operatingSystem=*Server*)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))',
    '(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))',
    '(&(objectClass=computer)(operatingSystem=*Server*)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))',
  ];

  const isPresetFilter = (f: string) => presetFilters.includes(f);

  // ── Edit / Create form ──
  if (editing) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">{editing.id ? 'Edit AD Source' : 'Add AD Source'}</h3>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium">Label</span>
            <input className="input mt-1" value={editing.label || ''} onChange={(e) => setEditing({ ...editing, label: e.target.value })} placeholder="Production AD" />
          </label>
          <label className="block">
            <span className="text-sm font-medium">LDAP URL</span>
            <input className="input mt-1" value={editing.ldap_url || ''} onChange={(e) => setEditing({ ...editing, ldap_url: e.target.value })} placeholder="ldaps://dc1.contoso.com:636" />
          </label>
          <label className="block col-span-2">
            <span className="text-sm font-medium">Authentication Method</span>
            <Select
              value={editing.auth_method || 'simple'}
              onChange={(v) => setEditing({ ...editing, auth_method: v })}
              options={[
                { value: 'simple', label: 'Simple Bind (DN + Password)' },
                { value: 'kerberos', label: 'Kerberos Keytab' },
              ]}
            />
          </label>
          {(editing.auth_method || 'simple') === 'simple' ? (
            <>
              <label className="block">
                <span className="text-sm font-medium">Bind DN</span>
                <input className="input mt-1" value={editing.bind_dn || ''} onChange={(e) => setEditing({ ...editing, bind_dn: e.target.value })} placeholder="CN=svc-strata,OU=Service Accounts,DC=contoso,DC=com" />
              </label>
              <label className="block">
                <span className="text-sm font-medium">Bind Password</span>
                <input type="password" className="input mt-1" value={editing.bind_password || ''} onChange={(e) => setEditing({ ...editing, bind_password: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="text-sm font-medium">Keytab Path</span>
                <input className="input mt-1" value={editing.keytab_path || ''} onChange={(e) => setEditing({ ...editing, keytab_path: e.target.value })} placeholder="/etc/krb5/strata.keytab" />
                <span className="text-xs opacity-50">Path inside the container — mount via Docker volume</span>
              </label>
              <label className="block">
                <span className="text-sm font-medium">Kerberos Principal</span>
                <input className="input mt-1" value={editing.krb5_principal || ''} onChange={(e) => setEditing({ ...editing, krb5_principal: e.target.value })} placeholder="svc-strata@CONTOSO.COM" />
              </label>
            </>
          )}
          <div className="block col-span-2">
            <span className="text-sm font-medium">Search Bases (OU scopes)</span>
            {(editing.search_bases || ['']).map((base, i) => (
              <div key={i} className="flex items-center gap-2 mt-1">
                <input
                  className="input flex-1"
                  value={base}
                  onChange={(e) => {
                    const next = [...(editing.search_bases || [''])];
                    next[i] = e.target.value;
                    setEditing({ ...editing, search_bases: next });
                  }}
                  placeholder="OU=Servers,DC=contoso,DC=com"
                />
                {(editing.search_bases || ['']).length > 1 && (
                  <button type="button" className="text-red-400 hover:text-red-300 text-sm px-1"
                    onClick={() => setEditing({ ...editing, search_bases: (editing.search_bases || ['']).filter((_, j) => j !== i) })}>✕</button>
                )}
              </div>
            ))}
            <button type="button" className="text-xs text-blue-400 hover:underline mt-1"
              onClick={() => setEditing({ ...editing, search_bases: [...(editing.search_bases || ['']), ''] })}>+ Add Search Base</button>
          </div>
          <label className="block">
            <span className="text-sm font-medium">Search Filter</span>
            <Select
              value={isPresetFilter(editing.search_filter || '') ? (editing.search_filter || '(objectClass=computer)') : '_custom'}
              onChange={(v) => {
                if (v === '_custom') {
                  setEditing({ ...editing, search_filter: editing.search_filter || '' });
                } else {
                  setEditing({ ...editing, search_filter: v });
                }
              }}
              options={[
                { value: '(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))', label: 'All Computers' },
                { value: '(&(objectClass=computer)(operatingSystem=*Server*)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))', label: 'Servers Only' },
                { value: '(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))', label: 'Enabled Computers Only' },
                { value: '(&(objectClass=computer)(operatingSystem=*Server*)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))', label: 'Enabled Servers Only' },
                { value: '_custom', label: 'Custom Filter...' },
              ]}
            />
            {!isPresetFilter(editing.search_filter || '') && (
              <input className="input mt-1" value={editing.search_filter || ''} onChange={(e) => setEditing({ ...editing, search_filter: e.target.value })} placeholder="(&(objectClass=computer)(name=SRV*))" />
            )}
          </label>
          <label className="block">
            <span className="text-sm font-medium">Search Scope</span>
            <Select
              value={editing.search_scope || 'subtree'}
              onChange={(v) => setEditing({ ...editing, search_scope: v })}
              options={[
                { value: 'subtree', label: 'Subtree' },
                { value: 'onelevel', label: 'One Level' },
                { value: 'base', label: 'Base' },
              ]}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Protocol</span>
            <Select
              value={editing.protocol || 'rdp'}
              onChange={(v) => setEditing({ ...editing, protocol: v })}
              options={[
                { value: 'rdp', label: 'RDP' },
                { value: 'ssh', label: 'SSH' },
                { value: 'vnc', label: 'VNC' },
              ]}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Default Port</span>
            <input type="number" className="input mt-1" value={editing.default_port ?? 3389} onChange={(e) => setEditing({ ...editing, default_port: Number(e.target.value) })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Domain Override</span>
            <input className="input mt-1" value={editing.domain_override || ''} onChange={(e) => setEditing({ ...editing, domain_override: e.target.value || undefined })} placeholder="Optional — force domain on connections" />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Connection Folder</span>
            <Select
              value={editing.folder_id || ''}
              onChange={(v) => setEditing({ ...editing, folder_id: v || undefined })}
              options={folderOptions}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Sync Interval (minutes)</span>
            <input type="number" className="input mt-1" min={5} value={editing.sync_interval_minutes ?? 60} onChange={(e) => setEditing({ ...editing, sync_interval_minutes: Math.max(5, Number(e.target.value)) })} />
          </label>
          <label className="flex items-center gap-2 mt-6">
            <input type="checkbox" className="checkbox" checked={editing.tls_skip_verify ?? false} onChange={(e) => setEditing({ ...editing, tls_skip_verify: e.target.checked })} />
            <span className="text-sm">Skip TLS verification</span>
          </label>
          <label className="flex items-center gap-2 mt-6">
            <input type="checkbox" className="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
            <span className="text-sm">Enabled</span>
          </label>
          {!(editing.tls_skip_verify) && (
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
                      reader.onload = () => setEditing({ ...editing, ca_cert_pem: reader.result as string });
                      reader.readAsText(file);
                    }
                    if (certFileRef.current) certFileRef.current.value = '';
                  }}
                />
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => certFileRef.current?.click()}>
                  {editing.ca_cert_pem ? '↻ Replace Certificate' : 'Upload Certificate'}
                </button>
                {editing.ca_cert_pem && (
                  <>
                    <span className="text-sm text-green-400">✓ Certificate loaded</span>
                    <button type="button" className="text-sm text-red-400 hover:underline" onClick={() => setEditing({ ...editing, ca_cert_pem: '' })}>
                      Remove
                    </button>
                  </>
                )}
              </div>
              <span className="text-xs opacity-50">Optional — upload your internal CA certificate for LDAPS with self-signed certificates</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-6">
          <button className="btn btn-primary" onClick={handleSave}>Save</button>
          <button
            className="btn btn-secondary"
            disabled={testing}
            onClick={() => handleTestConnection(editing)}
          >
            {testing ? 'Testing...' : '⚡ Test Connection'}
          </button>
          <button className="btn btn-secondary" onClick={() => { setEditing(null); setTestResult(null); }}>Cancel</button>
        </div>
        {testResult && (
          <div className={`mt-3 p-3 rounded text-sm ${testResult.status === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/30' : 'bg-red-500/10 text-red-400 border border-red-500/30'}`}>
            <div>{testResult.message}</div>
            {testResult.sample && testResult.sample.length > 0 && (
              <div className="mt-2 text-xs opacity-80">
                <div className="font-medium mb-1">Preview (first {testResult.sample.length}{testResult.count && testResult.count > testResult.sample.length ? ` of ${testResult.count}` : ''}):</div>
                <ul className="list-disc list-inside space-y-0.5">
                  {testResult.sample.map((name, i) => <li key={i}>{name}</li>)}
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
          <button className="btn btn-secondary btn-sm" onClick={() => setSelectedRuns(null)}>← Back</button>
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
                    <td>{new Date(r.started_at).toLocaleString('en-GB')}</td>
                    <td>
                      <span className={`badge ${r.status === 'success' ? 'badge-success' : r.status === 'error' ? 'badge-error' : 'badge-warning'}`}>
                        {r.status}
                      </span>
                    </td>
                    <td>{r.created}</td>
                    <td>{r.updated}</td>
                    <td>{r.soft_deleted}</td>
                    <td>{r.hard_deleted}</td>
                    <td className="max-w-xs truncate">{r.error_message || '—'}</td>
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
            Import connections from Active Directory via LDAP. Objects that disappear are soft-deleted for 7 days.
          </p>
        </div>
        <button 
          className="btn-sm-primary" 
          onClick={() => setEditing({ 
            search_bases: [''], 
            search_filter: '(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))', 
            search_scope: 'subtree', 
            protocol: 'rdp', 
            default_port: 3389, 
            sync_interval_minutes: 60, 
            enabled: true, 
            auth_method: 'simple' 
          })}
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
          <p className="text-sm">Add an Active Directory source to start importing connections automatically.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((c) => (
            <div key={c.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold">{c.label}</h4>
                    <span className={`badge text-xs ${c.enabled ? 'badge-success' : 'badge-error'}`}>
                      {c.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <p className="text-sm opacity-70 mt-1">{c.ldap_url}</p>
                  <p className="text-xs opacity-50 mt-1">
                    Auth: {c.auth_method === 'kerberos' ? 'Kerberos Keytab' : 'Simple Bind'}{c.ca_cert_pem ? ' · CA Cert ✓' : c.tls_skip_verify ? ' · TLS Skip Verify' : ''} · Base: <code>{(c.search_bases || []).join(', ') || '—'}</code> · Filter: <code>{c.search_filter}</code> · Protocol: {c.protocol.toUpperCase()} · Every {c.sync_interval_minutes}m
                  </p>
                </div>
                <div className="flex gap-2 shrink-0 ml-4">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={syncing === c.id}
                    onClick={() => handleSync(c.id)}
                  >
                    {syncing === c.id ? 'Syncing...' : '⟳ Sync Now'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleViewRuns(c.id)}>History</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleClone(c)}>Clone</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(c)}>Edit</button>
                  <button className="btn btn-secondary btn-sm text-red-500" onClick={() => handleDelete(c.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Security Tab ───────────────────────────────────────────────────────

function SecurityTab({ settings, onSave }: { settings: Record<string, string>; onSave: () => void }) {
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    isDangerous?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [watermarkEnabled, setWatermarkEnabled] = useState(settings.watermark_enabled === 'true');
  const [ssoEnabled, setSsoEnabled] = useState(settings.sso_enabled === 'true');
  const [localAuthEnabled, setLocalAuthEnabled] = useState(settings.local_auth_enabled === undefined ? true : settings.local_auth_enabled === 'true');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWatermarkEnabled(settings.watermark_enabled === 'true');
    setSsoEnabled(settings.sso_enabled === 'true');
    setLocalAuthEnabled(settings.local_auth_enabled === undefined ? true : settings.local_auth_enabled === 'true');
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    try {
      // Update general security settings
      await updateSettings([
        { key: 'watermark_enabled', value: String(watermarkEnabled) },
      ]);
      
      // Update authentication methods (dedicated endpoint with validation)
      await updateAuthMethods({
        sso_enabled: ssoEnabled,
        local_auth_enabled: localAuthEnabled,
      });

      onSave();
    } catch { /* handled by parent */ }
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
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">Authentication Methods</h4>
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
                  <span className="font-medium group-hover:text-txt-primary transition-colors">Local Authentication</span>
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
                  <span className="font-medium group-hover:text-txt-primary transition-colors">SSO / OIDC (Keycloak)</span>
                  <p className="text-txt-secondary text-sm mt-0.5">
                    Enable Single Sign-On via OpenID Connect. Ensure you have configured the provider settings in the SSO tab.
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-border/10">
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">Session Protection</h4>
          <div className="form-group">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={watermarkEnabled}
                onChange={(e) => setWatermarkEnabled(e.target.checked)}
                className="checkbox"
              />
              <div>
                <span className="font-medium group-hover:text-txt-primary transition-colors">Session Watermark</span>
                <p className="text-txt-secondary text-sm mt-0.5">
                  Overlay a semi-transparent watermark on all active sessions showing the user's name,
                  IP address, and timestamp. Helps deter unauthorized screen capture.
                </p>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-border/10">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Security Settings'}
        </button>
      </div>
      <ConfirmModal
        isOpen={!!confirmModal}
        title={confirmModal?.title || ''}
        message={confirmModal?.message || ''}
        confirmLabel={confirmModal?.confirmLabel}
        isDangerous={confirmModal?.isDangerous}
        onConfirm={() => confirmModal?.onConfirm()}
        onCancel={() => setConfirmModal(null)}
      />
    </div>
  );
}
