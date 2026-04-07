import { useEffect, useState, useCallback } from 'react';
import {
  getCredentialProfiles,
  createCredentialProfile,
  updateCredentialProfile,
  deleteCredentialProfile,
  getProfileMappings,
  setCredentialMapping,
  removeCredentialMapping,
  getMyConnections,
  getStatus,
  CredentialProfile,
  CredentialMapping,
  Connection,
} from '../api';
import Select from '../components/Select';

interface EditingProfile {
  id?: string;
  label: string;
  username: string;
  password: string;
  ttl_hours: number;
}

export default function Credentials() {
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [mappings, setMappings] = useState<Record<string, CredentialMapping[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [vaultConfigured, setVaultConfigured] = useState(false);
  const [mappingProfileId, setMappingProfileId] = useState<string | null>(null);
  const [mappingConnectionId, setMappingConnectionId] = useState('');

  const load = useCallback(async () => {
    try {
      const [profs, conns, status] = await Promise.all([
        getCredentialProfiles(),
        getMyConnections(),
        getStatus(),
      ]);
      setProfiles(profs);
      setConnections(conns);
      setVaultConfigured(status.vault_configured);

      // Load mappings for all profiles
      const m: Record<string, CredentialMapping[]> = {};
      await Promise.all(
        profs.map(async (p) => {
          try {
            m[p.id] = await getProfileMappings(p.id);
          } catch {
            m[p.id] = [];
          }
        }),
      );
      setMappings(m);
    } catch {
      setError('Failed to load credential data');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSaveProfile() {
    if (!editing) return;
    setSaving(true);
    setError('');
    try {
      if (editing.id) {
        await updateCredentialProfile(editing.id, {
          label: editing.label,
          username: editing.username || undefined,
          password: editing.password || undefined,
          ttl_hours: editing.ttl_hours,
        });
      } else {
        if (!editing.label || !editing.username || !editing.password) {
          setError('All fields are required for a new profile');
          setSaving(false);
          return;
        }
        await createCredentialProfile(editing.label, editing.username, editing.password, editing.ttl_hours);
      }
      setEditing(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteProfile(id: string) {
    setError('');
    try {
      await deleteCredentialProfile(id);
      if (expanded === id) setExpanded(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function handleAddMapping() {
    if (!mappingProfileId || !mappingConnectionId) return;
    setError('');
    try {
      await setCredentialMapping(mappingProfileId, mappingConnectionId);
      setMappingConnectionId('');
      setMappingProfileId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Mapping failed');
    }
  }

  async function handleRemoveMapping(connectionId: string) {
    setError('');
    try {
      await removeCredentialMapping(connectionId);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    }
  }

  // Connections already mapped to any profile by this user
  const mappedConnectionIds = new Set(
    Object.values(mappings).flat().map((m) => m.connection_id),
  );

  const availableConnections = connections.filter((c) => !mappedConnectionIds.has(c.id));

  if (!vaultConfigured) {
    return (
      <div className="animate-fade-up" style={{ padding: '2rem', maxWidth: 800, margin: '0 auto' }}>
        <h1>Credentials</h1>
        <div className="card">
          <div className="flex items-center gap-3 text-warning">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div>
              <p className="font-semibold text-txt-primary">Vault Not Configured</p>
              <p className="text-txt-secondary text-sm mt-1">
                Credential profiles require HashiCorp Vault for secure encryption.
                Ask an administrator to configure Vault in Admin Settings.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-up" style={{ padding: '2rem', maxWidth: 900, margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="!mb-0">Credentials</h1>
          <p className="text-txt-secondary text-sm mt-1">
            Manage your saved credentials and map them to connections.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => setEditing({ label: '', username: '', password: '', ttl_hours: 12 })}
        >
          <span className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New Profile
          </span>
        </button>
      </div>

      {error && (
        <div className="rounded-sm mb-4 px-4 py-2 text-[0.8125rem] bg-danger-dim text-danger">
          {error}
        </div>
      )}

      {/* ── Create / Edit modal ── */}
      {editing && (
        <div className="card mb-6" style={{ border: '1px solid var(--color-accent)', boxShadow: 'var(--shadow-accent)' }}>
          <h2 className="!mb-4">{editing.id ? 'Edit Profile' : 'New Credential Profile'}</h2>
          <div className="form-group">
            <label>Label</label>
            <input
              value={editing.label}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              placeholder="e.g. Domain Admin, SSH Dev Server"
              autoFocus
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label>Username</label>
              <input
                value={editing.username}
                onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                placeholder={editing.id ? '(unchanged)' : 'jsmith'}
                autoComplete="off"
              />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={editing.password}
                onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                placeholder={editing.id ? '(unchanged)' : 'Enter password'}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="form-group">
            <label>Password Expiry</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={12}
                step={1}
                value={editing.ttl_hours}
                onChange={(e) => setEditing({ ...editing, ttl_hours: Number(e.target.value) })}
                className="flex-1"
                style={{ accentColor: 'var(--color-accent)' }}
              />
              <span className="text-txt-primary font-semibold tabular-nums w-16 text-right">
                {editing.ttl_hours} {editing.ttl_hours === 1 ? 'hour' : 'hours'}
              </span>
            </div>
            <p className="text-txt-tertiary text-xs mt-1">
              Credentials expire after this duration and must be updated. Maximum 12 hours.
            </p>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button className="btn-primary" onClick={handleSaveProfile} disabled={saving}>
              {saving ? 'Saving…' : editing.id ? 'Update' : 'Create Profile'}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Profiles list ── */}
      {profiles.length === 0 && !editing ? (
        <div className="card text-center py-12">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4 text-txt-tertiary">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
          <p className="text-txt-secondary text-sm">
            No credential profiles yet. Create one to securely store your remote server credentials.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {profiles.map((profile) => {
            const isExpanded = expanded === profile.id;
            const profileMappings = mappings[profile.id] || [];
            const isAddingMapping = mappingProfileId === profile.id;

            return (
              <div key={profile.id} className="card !p-0 !overflow-hidden" style={profile.expired ? { borderColor: 'var(--color-danger)', borderWidth: 1 } : undefined}>
                {/* Profile header */}
                <div
                  className="flex items-center justify-between px-5 py-4 cursor-pointer transition-colors duration-150"
                  style={{ borderBottom: isExpanded ? '1px solid var(--color-border)' : 'none' }}
                  onClick={() => setExpanded(isExpanded ? null : profile.id)}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                      style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)' }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                      </svg>
                    </div>
                    <div>
                      <span className="font-semibold text-[0.9rem] text-txt-primary">{profile.label}</span>
                      <span className="text-txt-tertiary text-xs ml-3">
                        {profileMappings.length} connection{profileMappings.length !== 1 ? 's' : ''}
                      </span>
                      {profile.expired ? (
                        <span className="ml-3 text-xs font-semibold px-2 py-0.5 rounded-full bg-danger-dim text-danger">
                          Expired — update required
                        </span>
                      ) : (
                        <span className="ml-3 text-xs text-txt-tertiary">
                          Expires {new Date(profile.expires_at).toLocaleString(undefined, {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="btn !px-2 !py-1 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing({ id: profile.id, label: profile.label, username: '', password: '', ttl_hours: profile.ttl_hours });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn !px-2 !py-1 text-xs text-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteProfile(profile.id);
                      }}
                    >
                      Delete
                    </button>
                    <svg
                      className={`shrink-0 text-txt-tertiary transition-transform duration-250 ${isExpanded ? 'rotate-180' : ''}`}
                      width="16" height="16" viewBox="0 0 16 16" fill="none"
                    >
                      <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </div>

                {/* Expanded: mappings */}
                {isExpanded && (
                  <div className="px-5 py-4" style={{ background: 'var(--color-surface)' }}>
                    {profileMappings.length > 0 ? (
                      <table className="w-full" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th>Connection</th>
                            <th>Protocol</th>
                            <th style={{ width: 80 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {profileMappings.map((m) => (
                            <tr key={m.connection_id}>
                              <td className="font-medium">{m.connection_name}</td>
                              <td>
                                <span className="text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                                  style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)' }}>
                                  {m.protocol}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="btn !px-2 !py-1 text-xs text-danger"
                                  onClick={() => handleRemoveMapping(m.connection_id)}
                                >
                                  Unmap
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="text-txt-tertiary text-sm mb-3">
                        No connections mapped. Add a connection below so these credentials are used automatically.
                      </p>
                    )}

                    {/* Add mapping */}
                    {isAddingMapping ? (
                      <div className="flex items-end gap-3 mt-4" style={{ borderTop: profileMappings.length > 0 ? '1px solid var(--color-border)' : 'none', paddingTop: profileMappings.length > 0 ? '1rem' : 0 }}>
                        <div className="flex-1">
                          <label className="text-xs font-medium text-txt-secondary mb-1 block">Connection</label>
                          <Select
                            value={mappingConnectionId}
                            onChange={setMappingConnectionId}
                            options={availableConnections.map((c) => ({
                              value: c.id,
                              label: `${c.name} (${c.protocol.toUpperCase()})`,
                            }))}
                            placeholder="Select a connection…"
                          />
                        </div>
                        <button className="btn-primary !py-[0.55rem]" onClick={handleAddMapping} disabled={!mappingConnectionId}>
                          Map
                        </button>
                        <button className="btn !py-[0.55rem]" onClick={() => { setMappingProfileId(null); setMappingConnectionId(''); }}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="btn text-xs mt-3"
                        onClick={() => { setMappingProfileId(profile.id); setMappingConnectionId(''); }}
                      >
                        <span className="flex items-center gap-1.5">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                          </svg>
                          Add Connection
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
