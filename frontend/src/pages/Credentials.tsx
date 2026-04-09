import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  getCredentialProfiles,
  createCredentialProfile,
  updateCredentialProfile,
  deleteCredentialProfile,
  getProfileMappings,
  setCredentialMapping,
  removeCredentialMapping,
  getMyConnections,
  CredentialProfile,
  CredentialMapping,
  Connection,
} from '../api';

interface EditingProfile {
  id?: string;
  label: string;
  username: string;
  password: string;
  ttl_hours: number;
}

export default function Credentials({ vaultConfigured }: { vaultConfigured: boolean }) {
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [mappings, setMappings] = useState<Record<string, CredentialMapping[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mappingProfileId, setMappingProfileId] = useState<string | null>(null);
  const [mappingConnectionIds, setMappingConnectionIds] = useState<string[]>([]);
  const [mappingSearch, setMappingSearch] = useState('');
  const [mappingDropdownOpen, setMappingDropdownOpen] = useState(false);
  const mappingDropdownRef = useRef<HTMLDivElement>(null);
  const mappingTriggerRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profs, conns] = await Promise.all([
        getCredentialProfiles(),
        getMyConnections(),
      ]);
      setProfiles(profs);
      setConnections(conns);

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
    if (!id) return;
    setError('');
    try {
      await deleteCredentialProfile(id);
      if (expanded === id) setExpanded(null);
      setDeletingId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function handleAddMapping() {
    if (!mappingProfileId || mappingConnectionIds.length === 0) return;
    setError('');
    try {
      for (const cid of mappingConnectionIds) {
        await setCredentialMapping(mappingProfileId, cid);
      }
      setMappingConnectionIds([]);
      setMappingSearch('');
      setMappingProfileId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Mapping failed');
    }
  }

  // Close multi-select dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (mappingTriggerRef.current?.contains(t)) return;
      if (mappingDropdownRef.current?.contains(t)) return;
      setMappingDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Position the portal dropdown below the trigger
  useEffect(() => {
    if (!mappingDropdownOpen || !mappingTriggerRef.current) return;
    const positionMenu = () => {
      const rect = mappingTriggerRef.current!.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const menuHeight = 280;
      const placeAbove = spaceBelow < menuHeight && rect.top > menuHeight;
      setMenuStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
        ...(placeAbove
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      });
    };
    positionMenu();
    window.addEventListener('scroll', positionMenu, true);
    window.addEventListener('resize', positionMenu);
    return () => {
      window.removeEventListener('scroll', positionMenu, true);
      window.removeEventListener('resize', positionMenu);
    };
  }, [mappingDropdownOpen]);

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

  const filteredAvailable = availableConnections.filter((c) => {
    if (!mappingSearch) return true;
    const q = mappingSearch.toLowerCase();
    return c.name.toLowerCase().includes(q)
      || c.hostname.toLowerCase().includes(q)
      || (c.description || '').toLowerCase().includes(q)
      || c.protocol.toLowerCase().includes(q);
  });

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
                          Expires {new Date(profile.expires_at).toLocaleString('en-GB', {
                            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
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
                        setDeletingId(profile.id);
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
                      <div className="mt-4" style={{ borderTop: profileMappings.length > 0 ? '1px solid var(--color-border)' : 'none', paddingTop: profileMappings.length > 0 ? '1rem' : 0 }}>
                        <label className="text-xs font-medium text-txt-secondary mb-1 block">Connections</label>
                        <div className="relative">
                          <div
                            ref={mappingTriggerRef}
                            className="cs-trigger cursor-pointer min-h-[2.5rem] flex flex-wrap items-center gap-1.5 !py-1.5"
                            onClick={() => setMappingDropdownOpen(!mappingDropdownOpen)}
                          >
                            {mappingConnectionIds.map((cid) => {
                              const conn = connections.find((c) => c.id === cid);
                              return conn ? (
                                <span key={cid} className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)' }}>
                                  {conn.name}
                                  <button
                                    type="button"
                                    className="hover:text-danger ml-0.5"
                                    onClick={(e) => { e.stopPropagation(); setMappingConnectionIds(mappingConnectionIds.filter((id) => id !== cid)); }}
                                  >
                                    ×
                                  </button>
                                </span>
                              ) : null;
                            })}
                            {mappingConnectionIds.length === 0 && (
                              <span className="text-txt-tertiary text-sm">Select connections…</span>
                            )}
                            <svg
                              className={`shrink-0 ml-auto text-txt-tertiary transition-transform duration-250 ${mappingDropdownOpen ? 'rotate-180 text-accent' : ''}`}
                              width="16" height="16" viewBox="0 0 16 16" fill="none"
                            >
                              <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </div>
                          {mappingDropdownOpen && createPortal(
                            <div ref={mappingDropdownRef} className="rounded-md shadow-lg" style={{ ...menuStyle, background: 'var(--color-surface-elevated)', border: '1px solid var(--color-glass-border)' }}>
                              <div className="p-2 pb-0">
                                <input
                                  className="input w-full !text-sm"
                                  placeholder="Search connections…"
                                  value={mappingSearch}
                                  onChange={(e) => setMappingSearch(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  autoFocus
                                />
                              </div>
                              <ul className="max-h-52 overflow-y-auto list-none m-0 p-1" role="listbox">
                                {filteredAvailable.length === 0 && (
                                  <li className="px-3 py-2 text-sm text-txt-tertiary">No matching connections</li>
                                )}
                                {filteredAvailable.map((c) => {
                                  const isSelected = mappingConnectionIds.includes(c.id);
                                  return (
                                    <li
                                      key={c.id}
                                      role="option"
                                      aria-selected={isSelected}
                                      className="cs-option flex items-center gap-2 cursor-pointer"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setMappingConnectionIds(
                                          isSelected
                                            ? mappingConnectionIds.filter((id) => id !== c.id)
                                            : [...mappingConnectionIds, c.id]
                                        );
                                      }}
                                    >
                                      <span className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 ${isSelected ? 'bg-accent border-accent' : 'border-txt-tertiary'}`} style={isSelected ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}>
                                        {isSelected && (
                                          <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                                            <path d="M3 7L6 10L11 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                          </svg>
                                        )}
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <div className="text-sm truncate">{c.name} <span className="text-txt-tertiary">({c.protocol.toUpperCase()})</span></div>
                                        {c.description && <div className="text-xs text-txt-tertiary truncate">{c.description}</div>}
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>,
                            document.body
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-3">
                          <button className="btn-primary !py-[0.55rem]" onClick={handleAddMapping} disabled={mappingConnectionIds.length === 0}>
                            Map {mappingConnectionIds.length > 0 ? `(${mappingConnectionIds.length})` : ''}
                          </button>
                          <button className="btn !py-[0.55rem]" onClick={() => { setMappingProfileId(null); setMappingConnectionIds([]); setMappingSearch(''); }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="btn text-xs mt-3"
                        onClick={() => { setMappingProfileId(profile.id); setMappingConnectionIds([]); setMappingSearch(''); }}
                      >
                        <span className="flex items-center gap-1.5">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                          </svg>
                          Add Connections
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

      {/* ── Delete Confirmation Modal ── */}
      {deletingId && createPortal(
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setDeletingId(null)}
        >
          <div 
            className="card max-w-sm w-full mx-4 shadow-2xl scale-in"
            onClick={e => e.stopPropagation()}
            style={{ border: '1px solid rgba(239, 68, 68, 0.2)' }}
          >
            <div className="flex items-center gap-3 text-danger mb-4">
              <div className="w-10 h-10 rounded-full bg-danger-dim flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              </div>
              <h3 className="!mb-0">Delete Profile?</h3>
            </div>
            
            <p className="text-txt-secondary text-sm mb-6">
              Are you sure you want to delete <span className="text-txt-primary font-semibold">{profiles.find(p => p.id === deletingId)?.label}</span>? 
              This will unmap it from <span className="text-txt-primary font-semibold">{mappings[deletingId]?.length || 0}</span> connections. This action cannot be undone.
            </p>

            <div className="flex gap-3">
              <button 
                className="btn-primary flex-1 !bg-danger hover:!bg-danger-hover border-none"
                onClick={() => handleDeleteProfile(deletingId)}
              >
                Delete Permanently
              </button>
              <button 
                className="btn flex-1"
                onClick={() => setDeletingId(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
