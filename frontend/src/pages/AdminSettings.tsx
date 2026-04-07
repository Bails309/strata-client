import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Select from '../components/Select';
import {
  getSettings,
  updateSso,
  updateKerberos,
  updateRecordings,
  updateVault,
  getServiceHealth,
  getRoles,
  createRole,
  getConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  getConnectionGroups,
  createConnectionGroup,
  updateConnectionGroup as _updateConnectionGroup,
  deleteConnectionGroup,
  getUsers,
  getActiveSessions,
  Role,
  Connection,
  ConnectionGroup,
  User,
  ServiceHealth,
  ActiveSession,
} from '../api';

type Tab = 'health' | 'sso' | 'kerberos' | 'vault' | 'recordings' | 'access' | 'sessions';

export default function AdminSettings() {
  const [tab, setTab] = useState<Tab>('health');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Role[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [groups, setGroups] = useState<ConnectionGroup[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
    getRoles().then(setRoles).catch(() => {});
    getConnections().then(setConnections).catch(() => {});
    getConnectionGroups().then(setGroups).catch(() => {});
    getUsers().then(setUsers).catch(() => {});
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

      <div className="tabs">
        {(['health', 'sso', 'kerberos', 'vault', 'recordings', 'access', 'sessions'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'sso' ? 'SSO / OIDC' : t === 'health' ? 'Health' : t.charAt(0).toUpperCase() + t.slice(1)}
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
        <KerberosTab settings={settings} onSave={() => flash('Kerberos updated')} />
      )}

      {/* ── Recordings ── */}
      {tab === 'recordings' && (
        <RecordingsTab settings={settings} onSave={() => flash('Recordings updated')} />
      )}

      {/* ── Vault ── */}
      {tab === 'vault' && (
        <VaultTab onSave={() => flash('Vault updated')} />
      )}

      {/* ── Access Control ── */}
      {tab === 'access' && (
        <AccessTab
          roles={roles}
          connections={connections}
          groups={groups}
          users={users}
          onRoleCreated={(r) => setRoles([...roles, r])}
          onConnectionCreated={(c) => setConnections([...connections, c])}
          onConnectionUpdated={(c) => setConnections(connections.map((x) => x.id === c.id ? c : x))}
          onConnectionDeleted={(id) => setConnections(connections.filter((x) => x.id !== id))}
          onGroupsChanged={(g) => setGroups(g)}
        />
      )}

      {/* ── Active Sessions (NVR) ── */}
      {tab === 'sessions' && <SessionsTab />}
    </div>
  );
}

// ── Sub-tabs ─────────────────────────────────────────────────────────

function HealthTab({ onNavigateVault }: { onNavigateVault: () => void }) {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [loading, setLoading] = useState(true);

  function refresh() {
    setLoading(true);
    getServiceHealth()
      .then(setHealth)
      .catch(() => setHealth(null))
      .finally(() => setLoading(false));
  }

  useEffect(() => { refresh(); }, []);

  if (loading && !health) {
    return (
      <div className="card">
        <p className="text-txt-secondary">Loading service health…</p>
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
        <button className="btn shrink-0" onClick={refresh}>
          {loading ? 'Refreshing…' : 'Refresh'}
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
  const [clientSecret, setClientSecret] = useState('');

  useEffect(() => {
    setIssuer(settings.sso_issuer_url || '');
    setClientId(settings.sso_client_id || '');
  }, [settings]);

  return (
    <div className="card">
      <h2>SSO / OIDC (Keycloak)</h2>
      <div className="form-group">
        <label>Issuer URL</label>
        <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://keycloak.example.com/realms/strata" />
      </div>
      <div className="form-group">
        <label>Client ID</label>
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Client Secret</label>
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
      </div>
      <button className="btn-primary" onClick={async () => { await updateSso({ issuer_url: issuer, client_id: clientId, client_secret: clientSecret }); onSave(); }}>
        Save SSO Settings
      </button>
    </div>
  );
}

function KerberosTab({ settings, onSave }: { settings: Record<string, string>; onSave: () => void }) {
  const [realm, setRealm] = useState(settings.kerberos_realm || '');
  const [kdcs, setKdcs] = useState<string[]>((settings.kerberos_kdc || '').split(',').filter(Boolean));
  const [admin, setAdmin] = useState(settings.kerberos_admin_server || '');
  const [ticketLifetime, setTicketLifetime] = useState(settings.kerberos_ticket_lifetime || '10h');
  const [renewLifetime, setRenewLifetime] = useState(settings.kerberos_renew_lifetime || '7d');

  useEffect(() => {
    setRealm(settings.kerberos_realm || '');
    setKdcs((settings.kerberos_kdc || '').split(',').filter(Boolean));
    setAdmin(settings.kerberos_admin_server || '');
    setTicketLifetime(settings.kerberos_ticket_lifetime || '10h');
    setRenewLifetime(settings.kerberos_renew_lifetime || '7d');
  }, [settings]);

  const updateKdc = (i: number, val: string) => {
    const next = [...kdcs];
    next[i] = val;
    setKdcs(next);
  };

  return (
    <div className="card">
      <h2>Kerberos Configuration</h2>
      <div className="form-group">
        <label>Default Realm</label>
        <input value={realm} onChange={(e) => setRealm(e.target.value)} placeholder="EXAMPLE.COM" />
      </div>
      <div className="form-group">
        <label>KDC Servers</label>
        {kdcs.map((k, i) => (
          <div key={i} className="flex gap-2 mb-[0.4rem]">
            <input value={k} onChange={(e) => updateKdc(i, e.target.value)} placeholder={`KDC ${i + 1} (e.g. 10.0.0.${5 + i})`} />
            {kdcs.length > 1 && (
              <button type="button" className="btn !w-auto px-[0.7rem] py-[0.4rem] shrink-0"
                onClick={() => setKdcs(kdcs.filter((_, j) => j !== i))}>✕</button>
            )}
          </div>
        ))}
        <button type="button" className="btn !w-auto mt-1 text-[0.8rem]"
          onClick={() => setKdcs([...kdcs, ''])}>+ Add KDC</button>
      </div>
      <div className="form-group">
        <label>Admin Server</label>
        <input value={admin} onChange={(e) => setAdmin(e.target.value)} placeholder="10.0.0.5" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="form-group">
          <label>Ticket Lifetime</label>
          <input value={ticketLifetime} onChange={(e) => setTicketLifetime(e.target.value)} placeholder="10h" />
        </div>
        <div className="form-group">
          <label>Renew Lifetime</label>
          <input value={renewLifetime} onChange={(e) => setRenewLifetime(e.target.value)} placeholder="7d" />
        </div>
      </div>
      <button className="btn-primary" onClick={async () => {
        await updateKerberos({
          realm,
          kdc: kdcs.filter(Boolean),
          admin_server: admin,
          ticket_lifetime: ticketLifetime,
          renew_lifetime: renewLifetime,
        });
        onSave();
      }}>
        Save Kerberos Settings
      </button>
    </div>
  );
}

function RecordingsTab({ settings, onSave }: { settings: Record<string, string>; onSave: () => void }) {
  const [enabled, setEnabled] = useState(settings.recordings_enabled === 'true');
  const [days, setDays] = useState(settings.recordings_retention_days || '30');

  useEffect(() => {
    setEnabled(settings.recordings_enabled === 'true');
    setDays(settings.recordings_retention_days || '30');
  }, [settings]);

  return (
    <div className="card">
      <h2>Session Recordings</h2>
      <div className="form-group">
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="!w-auto mr-2" />
          Enable session recording
        </label>
      </div>
      <div className="form-group">
        <label>Retention (days)</label>
        <input type="number" value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
      <button className="btn-primary" onClick={async () => { await updateRecordings({ enabled, retention_days: parseInt(days) }); onSave(); }}>
        Save Recording Settings
      </button>
    </div>
  );
}

function VaultTab({ onSave }: { onSave: () => void }) {
  const [mode, setMode] = useState<'local' | 'external'>('local');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [transitKey, setTransitKey] = useState('guac-master-key');
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getServiceHealth().then((h) => {
      setHealth(h);
      if (h.vault.configured) {
        setMode(h.vault.mode === 'local' ? 'local' : 'external');
        setAddress(h.vault.address);
      }
    }).catch(() => {});
  }, []);

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
        {saving ? 'Saving…' : 'Save Vault Settings'}
      </button>
    </div>
  );
}

function AccessTab({
  roles, connections, groups, users, onRoleCreated, onConnectionCreated, onConnectionUpdated, onConnectionDeleted, onGroupsChanged,
}: {
  roles: Role[];
  connections: Connection[];
  groups: ConnectionGroup[];
  users: User[];
  onRoleCreated: (r: Role) => void;
  onConnectionCreated: (c: Connection) => void;
  onConnectionUpdated: (c: Connection) => void;
  onConnectionDeleted: (id: string) => void;
  onGroupsChanged: (g: ConnectionGroup[]) => void;
}) {
  const [newRoleName, setNewRoleName] = useState('');
  const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
  const [formId, setFormId] = useState<string | null>(null);
  const [formCore, setFormCore] = useState({ name: '', protocol: 'rdp', hostname: '', port: 3389, domain: '', description: '', group_id: '' });
  const [formExtra, setFormExtra] = useState<Record<string, string>>({});
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupParent, setNewGroupParent] = useState('');

  function openAdd() {
    setFormMode('add');
    setFormId(null);
    setFormCore({ name: '', protocol: 'rdp', hostname: '', port: 3389, domain: '', description: '', group_id: '' });
    setFormExtra({ 'server-layout': 'en-gb-qwerty', 'timezone': 'Europe/London' });
  }

  function openEdit(c: Connection) {
    setFormMode('edit');
    setFormId(c.id);
    setFormCore({ name: c.name, protocol: c.protocol, hostname: c.hostname, port: c.port, domain: c.domain || '', description: c.description || '', group_id: c.group_id || '' });
    setFormExtra(c.extra ? { ...c.extra } : {});
  }

  function closeForm() {
    setFormMode('closed');
    setFormId(null);
  }

  // Strip empty values from extra before saving
  function cleanExtra(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(formExtra)) {
      if (v !== '' && v !== 'false') out[k] = v;
    }
    return out;
  }

  async function handleSave() {
    const payload = {
      ...formCore,
      group_id: formCore.group_id || undefined,
      extra: cleanExtra(),
    };
    if (formMode === 'add') {
      const c = await createConnection(payload);
      onConnectionCreated(c);
    } else if (formMode === 'edit' && formId) {
      const c = await updateConnection(formId, payload);
      onConnectionUpdated(c);
    }
    closeForm();
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this connection? This cannot be undone.')) return;
    await deleteConnection(id);
    onConnectionDeleted(id);
    if (formId === id) closeForm();
  }

  const ex = (key: string) => formExtra[key] || '';
  const setEx = (key: string, val: string) => setFormExtra({ ...formExtra, [key]: val });

  return (
    <div className="grid gap-6">
      {/* Roles */}
      <div className="card">
        <h2>Roles</h2>
        <table>
          <thead><tr><th>Name</th><th>ID</th></tr></thead>
          <tbody>
            {roles.map((r) => <tr key={r.id}><td>{r.name}</td><td className="font-mono text-[0.8rem]">{r.id}</td></tr>)}
          </tbody>
        </table>
        <div className="flex gap-2 mt-4">
          <input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="New role name" />
          <button className="btn-primary" onClick={async () => { const r = await createRole(newRoleName); onRoleCreated(r); setNewRoleName(''); }}>
            Add Role
          </button>
        </div>
      </div>

      {/* Connections */}
      <div className="card">
        <div className="flex justify-between items-center mb-4">
          <h2 className="!mb-0">Connections</h2>
          <button className="btn-primary text-[0.8rem] px-3 py-1" onClick={openAdd}>
            + Add Connection
          </button>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Protocol</th><th>Host</th><th>Port</th><th>Group</th><th className="w-[140px]">Actions</th></tr></thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id} className={formId === c.id ? 'bg-surface-secondary' : ''}>
                <td>
                  <div>{c.name}</div>
                  {c.description && <div className="text-[0.75rem] text-txt-tertiary">{c.description}</div>}
                </td>
                <td>{c.protocol.toUpperCase()}</td>
                <td>{c.hostname}</td>
                <td>{c.port}</td>
                <td>{c.group_id ? (groups.find(g => g.id === c.group_id)?.name || '—') : '—'}</td>
                <td>
                  <div className="flex gap-1">
                    <button className="btn text-[0.8rem] px-2 py-1" onClick={() => openEdit(c)}>Edit</button>
                    <button className="btn text-[0.8rem] px-2 py-1 text-danger" onClick={() => handleDelete(c.id)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Connection Editor Form */}
      {formMode !== 'closed' && (
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="!mb-0">{formMode === 'add' ? 'Add Connection' : 'Edit Connection'}</h2>
            <button className="btn text-[0.8rem] px-2 py-1" onClick={closeForm}>Cancel</button>
          </div>

          {/* Core fields */}
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
              <input value={formCore.description} onChange={(e) => setFormCore({ ...formCore, description: e.target.value })} placeholder="Optional description shown on the connections page" />
            </div>
            <div className="form-group !mb-0">
              <label>Group</label>
              <Select
                value={formCore.group_id}
                onChange={(v) => setFormCore({ ...formCore, group_id: v })}
                placeholder="No group"
                options={[
                  { value: '', label: 'No group' },
                  ...groups.map(g => ({ value: g.id, label: g.parent_id ? `  └ ${g.name}` : g.name })),
                ]}
              />
            </div>
          </div>

          {/* Protocol-specific sections */}
          {formCore.protocol === 'rdp' && (
            <RdpSections extra={formExtra} setExtra={setFormExtra} ex={ex} setEx={setEx} />
          )}
          {formCore.protocol === 'ssh' && (
            <SshSections ex={ex} setEx={setEx} />
          )}
          {formCore.protocol === 'vnc' && (
            <VncSections ex={ex} setEx={setEx} />
          )}

          <div className="flex gap-2 mt-4">
            <button className="btn-primary" onClick={handleSave}>
              {formMode === 'add' ? 'Create Connection' : 'Save Changes'}
            </button>
            <button className="btn" onClick={closeForm}>Cancel</button>
          </div>
        </div>
      )}

      {/* Connection Groups */}
      <div className="card">
        <h2>Connection Groups</h2>
        {groups.length > 0 && (
          <table>
            <thead><tr><th>Name</th><th>Parent</th><th className="w-[100px]">Actions</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td>{g.parent_id ? (groups.find(p => p.id === g.parent_id)?.name || '—') : '—'}</td>
                  <td>
                    <button className="btn text-[0.8rem] px-2 py-1 text-danger" onClick={async () => {
                      if (!window.confirm(`Delete group "${g.name}"? Connections in this group will become ungrouped.`)) return;
                      await deleteConnectionGroup(g.id);
                      onGroupsChanged(groups.filter(x => x.id !== g.id));
                    }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {groups.length === 0 && <p className="text-txt-secondary text-sm mb-3">No groups yet. Create one to organize connections.</p>}
        <div className="flex gap-2 mt-4">
          <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="Group name" />
          <div className="min-w-[160px]">
            <Select
              value={newGroupParent}
              onChange={setNewGroupParent}
              placeholder="No parent (top-level)"
              options={[
                { value: '', label: 'No parent (top-level)' },
                ...groups.filter(g => !g.parent_id).map(g => ({ value: g.id, label: g.name })),
              ]}
            />
          </div>
          <button className="btn-primary" onClick={async () => {
            if (!newGroupName.trim()) return;
            const g = await createConnectionGroup({ name: newGroupName.trim(), parent_id: newGroupParent || undefined });
            onGroupsChanged([...groups, g]);
            setNewGroupName('');
            setNewGroupParent('');
          }}>
            Add Group
          </button>
        </div>
      </div>

      {/* Users */}
      <div className="card">
        <h2>Users</h2>
        <table>
          <thead><tr><th>Username</th><th>Role</th><th>OIDC Sub</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.role_name}</td>
                <td className="font-mono text-[0.8rem]">{u.sub || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Collapsible Section ─────────────────────────────────────────────

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
              <input type="checkbox" checked={ex('ignore-cert') !== 'false'} onChange={(e) => setEx('ignore-cert', e.target.checked ? 'true' : 'false')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('console') === 'true'} onChange={(e) => setEx('console', e.target.checked ? 'true' : '')} className="!w-auto" />
              Administrator console
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-touch') === 'true'} onChange={(e) => setEx('enable-touch', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('force-lossless') === 'true'} onChange={(e) => setEx('force-lossless', e.target.checked ? 'true' : '')} className="!w-auto" />
              Force lossless compression
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('read-only') === 'true'} onChange={(e) => setEx('read-only', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('disable-copy') === 'true'} onChange={(e) => setEx('disable-copy', e.target.checked ? 'true' : '')} className="!w-auto" />
              Disable copy from remote
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-paste') === 'true'} onChange={(e) => setEx('disable-paste', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('disable-audio') === 'true'} onChange={(e) => setEx('disable-audio', e.target.checked ? 'true' : '')} className="!w-auto" />
              Disable audio playback
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-audio-input') === 'true'} onChange={(e) => setEx('enable-audio-input', e.target.checked ? 'true' : '')} className="!w-auto" />
              Enable audio input (microphone)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-printing') === 'true'} onChange={(e) => setEx('enable-printing', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('enable-drive') === 'true'} onChange={(e) => setEx('enable-drive', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('create-drive-path') === 'true'} onChange={(e) => setEx('create-drive-path', e.target.checked ? 'true' : '')} className="!w-auto" />
              Auto-create drive path
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-download') === 'true'} onChange={(e) => setEx('disable-download', e.target.checked ? 'true' : '')} className="!w-auto" />
              Disable file download
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-upload') === 'true'} onChange={(e) => setEx('disable-upload', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('enable-wallpaper') === 'true'} onChange={(e) => setEx('enable-wallpaper', e.target.checked ? 'true' : '')} className="!w-auto" />
              Enable wallpaper
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-theming') === 'true'} onChange={(e) => setEx('enable-theming', e.target.checked ? 'true' : '')} className="!w-auto" />
              Enable theming
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-font-smoothing') === 'true'} onChange={(e) => setEx('enable-font-smoothing', e.target.checked ? 'true' : '')} className="!w-auto" />
              Enable font smoothing (ClearType)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-full-window-drag') === 'true'} onChange={(e) => setEx('enable-full-window-drag', e.target.checked ? 'true' : '')} className="!w-auto" />
              Enable full-window drag
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-desktop-composition') === 'true'} onChange={(e) => setEx('enable-desktop-composition', e.target.checked ? 'true' : '')} className="!w-auto" />
              Enable desktop composition (Aero)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('enable-menu-animations') === 'true'} onChange={(e) => setEx('enable-menu-animations', e.target.checked ? 'true' : '')} className="!w-auto" />
              Enable menu animations
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-bitmap-caching') === 'true'} onChange={(e) => setEx('disable-bitmap-caching', e.target.checked ? 'true' : '')} className="!w-auto" />
              Disable bitmap caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-offscreen-caching') === 'true'} onChange={(e) => setEx('disable-offscreen-caching', e.target.checked ? 'true' : '')} className="!w-auto" />
              Disable offscreen caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-glyph-caching') === 'true'} onChange={(e) => setEx('disable-glyph-caching', e.target.checked ? 'true' : '')} className="!w-auto" />
              Disable glyph caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('disable-gfx') === 'true'} onChange={(e) => setEx('disable-gfx', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('create-recording-path') === 'true'} onChange={(e) => setEx('create-recording-path', e.target.checked ? 'true' : '')} className="!w-auto" />
              Auto-create recording path
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-exclude-output') === 'true'} onChange={(e) => setEx('recording-exclude-output', e.target.checked ? 'true' : '')} className="!w-auto" />
              Exclude graphical output
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-exclude-mouse') === 'true'} onChange={(e) => setEx('recording-exclude-mouse', e.target.checked ? 'true' : '')} className="!w-auto" />
              Exclude mouse events
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-exclude-touch') === 'true'} onChange={(e) => setEx('recording-exclude-touch', e.target.checked ? 'true' : '')} className="!w-auto" />
              Exclude touch events
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-include-keys') === 'true'} onChange={(e) => setEx('recording-include-keys', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('enable-sftp') === 'true'} onChange={(e) => setEx('enable-sftp', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('wol-send-packet') === 'true'} onChange={(e) => setEx('wol-send-packet', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('read-only') === 'true'} onChange={(e) => setEx('read-only', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('enable-sftp') === 'true'} onChange={(e) => setEx('enable-sftp', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('sftp-disable-download') === 'true'} onChange={(e) => setEx('sftp-disable-download', e.target.checked ? 'true' : '')} className="!w-auto" />
              Disable file download
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('sftp-disable-upload') === 'true'} onChange={(e) => setEx('sftp-disable-upload', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('create-recording-path') === 'true'} onChange={(e) => setEx('create-recording-path', e.target.checked ? 'true' : '')} className="!w-auto" />
              Auto-create recording path
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ex('recording-include-keys') === 'true'} onChange={(e) => setEx('recording-include-keys', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('wol-send-packet') === 'true'} onChange={(e) => setEx('wol-send-packet', e.target.checked ? 'true' : '')} className="!w-auto" />
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
              <input type="checkbox" checked={ex('read-only') === 'true'} onChange={(e) => setEx('read-only', e.target.checked ? 'true' : '')} style={{ width: 'auto' }} />
              Read-only
            </label>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={ex('swap-red-blue') === 'true'} onChange={(e) => setEx('swap-red-blue', e.target.checked ? 'true' : '')} style={{ width: 'auto' }} />
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
              <input type="checkbox" checked={ex('disable-copy') === 'true'} onChange={(e) => setEx('disable-copy', e.target.checked ? 'true' : '')} style={{ width: 'auto' }} />
              Disable copy from remote
            </label>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={ex('disable-paste') === 'true'} onChange={(e) => setEx('disable-paste', e.target.checked ? 'true' : '')} style={{ width: 'auto' }} />
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
              <input type="checkbox" checked={ex('create-recording-path') === 'true'} onChange={(e) => setEx('create-recording-path', e.target.checked ? 'true' : '')} style={{ width: 'auto' }} />
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
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Active Sessions</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Live user sessions with NVR buffer. Observe any session to see what the user is doing — or rewind up to 5 minutes.
          </p>
        </div>
        <button
          onClick={refresh}
          className="btn btn-secondary text-sm"
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
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
