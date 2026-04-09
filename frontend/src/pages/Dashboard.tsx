import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMyConnections, getConnectionInfo, Connection, getFavorites, toggleFavorite, getCredentialProfiles, getProfileMappings, setCredentialMapping, removeCredentialMapping, CredentialProfile, createTunnelTicket, getServiceHealth } from '../api';
import { useSessionManager } from '../components/SessionManager';
import Select from '../components/Select';

const PAGE_SIZE = 50;

function ProtocolIcon({ protocol }: { protocol: string }) {
  const p = protocol.toLowerCase();
  if (p === 'rdp') {
    return (
      <svg width="20" height="20" viewBox="0 0 88 88" fill="currentColor">
        <path d="M0 12.4l35.687-4.86.016 34.423-35.67.143L0 12.4zm35.67 33.529l.028 34.453L0 75.39V45.71h35.67V45.93zM40.336 6.326L87.971 0v41.527H40.33l.006-35.2zM87.971 46.26l-.011 41.74-47.624-6.661V46.26h47.635z" />
      </svg>
    );
  }
  if (p === 'ssh') {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>
      </svg>
    );
  }
  if (p === 'db') {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19C3 20.6569 7.02944 22 12 22C16.9706 22 21 20.6569 21 19V5"/><path d="M3 12C3 13.6569 7.02944 15 12 15C16.9706 15 21 13.6569 21 12"/>
      </svg>
    );
  }
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  );
}

/** Connections that need credentials before tiled open */
interface TiledCredPrompt {
  /** Connections that need credential input (no vault creds, RDP protocol) */
  needsCreds: Connection[];
  /** Connections that are ready to connect (have vault creds or non-RDP) */
  ready: Connection[];
}

export default function Dashboard() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [tiledCredPrompt, setTiledCredPrompt] = useState<TiledCredPrompt | null>(null);
  const [tiledCreds, setTiledCreds] = useState<Record<string, { username: string; password: string }>>({});
  const [vaultConfigured, setVaultConfigured] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [showFavorites, setShowFavorites] = useState(false);
  const [folderView, setFolderView] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [credProfiles, setCredProfiles] = useState<CredentialProfile[]>([]);
  /** Map of connection_id → profile_id currently assigned */
  const [connProfileMap, setConnProfileMap] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const { createSession, setTiledSessionIds, setFocusedSessionIds, setActiveSessionId } = useSessionManager();
  const selectAllRef = useRef<HTMLInputElement>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const profiles = await getCredentialProfiles();
      setCredProfiles(profiles);
      // Build reverse map: connection_id → profile_id
      const map: Record<string, string> = {};
      await Promise.all(
        profiles.map(async (p) => {
          try {
            const mappings = await getProfileMappings(p.id);
            for (const m of mappings) {
              map[m.connection_id] = p.id;
            }
          } catch { /* ignore */ }
        }),
      );
      setConnProfileMap(map);
    } catch { /* vault may not be configured */ }
  }, []);

  useEffect(() => {
    getMyConnections().then(setConnections).catch(() => {});
    getServiceHealth().then((h) => setVaultConfigured(h.vault.configured)).catch(() => {});
    getFavorites().then((ids) => setFavorites(new Set(ids))).catch(() => {});
    loadProfiles();
  }, [loadProfiles]);

  const filtered = useMemo(() => {
    let list = connections;
    if (showFavorites) {
      list = list.filter(c => favorites.has(c.id));
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q) || c.hostname.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q));
    }
    if (typeFilter) {
      list = list.filter(c => c.protocol.toLowerCase() === typeFilter.toLowerCase());
    }
    return list;
  }, [connections, search, typeFilter, showFavorites, favorites]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Build grouped structure for folder view
  const groupedConnections = useMemo(() => {
    if (!folderView) return null;
    const folderMap = new Map<string, { name: string; connections: Connection[] }>();
    const ungrouped: Connection[] = [];
    for (const conn of paged) {
      const fid = conn.folder_id;
      if (fid && conn.folder_name) {
        if (!folderMap.has(fid)) folderMap.set(fid, { name: conn.folder_name, connections: [] });
        folderMap.get(fid)!.connections.push(conn);
      } else {
        ungrouped.push(conn);
      }
    }
    return { folders: [...folderMap.entries()], ungrouped };
  }, [folderView, paged]);

  const toggleFolderCollapse = useCallback((fid: string) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (next.has(fid)) next.delete(fid); else next.add(fid);
      return next;
    });
  }, []);

  // Drive indeterminate state on the "select all" checkbox
  useEffect(() => {
    if (selectAllRef.current) {
      const some = checked.size > 0 && checked.size < paged.length;
      selectAllRef.current.indeterminate = some;
    }
  }, [checked, paged.length]);

  const protocols = useMemo(() =>
    [...new Set(connections.map(c => c.protocol.toUpperCase()))].sort(),
    [connections]
  );

  const handleProfileChange = useCallback(async (connectionId: string, profileId: string) => {
    try {
      if (profileId === '') {
        await removeCredentialMapping(connectionId);
        setConnProfileMap((prev) => {
          const next = { ...prev };
          delete next[connectionId];
          return next;
        });
      } else {
        await setCredentialMapping(profileId, connectionId);
        setConnProfileMap((prev) => ({ ...prev, [connectionId]: profileId }));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { setPage(1); }, [search, typeFilter, showFavorites]);

  const handleToggleFavorite = useCallback(async (connectionId: string) => {
    const result = await toggleFavorite(connectionId);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (result.favorited) next.add(connectionId); else next.delete(connectionId);
      return next;
    });
  }, []);

  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAllChecked = useCallback(() => {
    setChecked((prev) =>
      prev.size === paged.length ? new Set() : new Set(paged.map((c) => c.id)),
    );
  }, [paged]);

  const openTiled = useCallback(async () => {
    if (checked.size < 2) return;

    // Check which connections need credentials
    const checkedConns = [...checked]
      .map((id) => connections.find((c) => c.id === id))
      .filter(Boolean) as Connection[];

    const infos = await Promise.all(
      checkedConns.map(async (conn) => {
        try {
          const info = await getConnectionInfo(conn.id);
          return { conn, info };
        } catch {
          return { conn, info: { protocol: conn.protocol, has_credentials: false } };
        }
      }),
    );

    const needsCreds: Connection[] = [];
    const ready: Connection[] = [];
    for (const { conn, info } of infos) {
      if (info.has_credentials || conn.protocol.toLowerCase() !== 'rdp') {
        ready.push(conn);
      } else {
        needsCreds.push(conn);
      }
    }

    if (needsCreds.length > 0) {
      // Show credential prompt before connecting
      setTiledCredPrompt({ needsCreds, ready });
      // Initialize empty cred forms
      const initial: Record<string, { username: string; password: string }> = {};
      for (const conn of needsCreds) {
        initial[conn.id] = { username: '', password: '' };
      }
      setTiledCreds(initial);
    } else {
      // All connections have vault credentials – open immediately
      launchTiled(ready, {});
    }
  }, [checked, connections]);

  /** Create all tiled sessions and navigate */
  const launchTiled = useCallback(async (
    conns: Connection[],
    creds: Record<string, { username: string; password: string }>,
  ) => {
    const ids: string[] = [];
    const containerEl = document.createElement('div');
    containerEl.style.width = '800px';
    containerEl.style.height = '600px';

    for (const conn of conns) {
      const token = localStorage.getItem('access_token') || '';
      const dpr = window.devicePixelRatio || 1;
      const connCreds = creds[conn.id];

      // Obtain a one-time tunnel ticket so credentials never appear in the WebSocket URL
      let ticketId: string | undefined;
      try {
        const resp = await createTunnelTicket({
          connection_id: conn.id,
          username: connCreds?.username || undefined,
          password: connCreds?.password || undefined,
          width: 800,
          height: 600,
          dpi: Math.round(96 * dpr),
        });
        ticketId = resp.ticket;
      } catch {
        continue; // skip this connection on ticket failure
      }

      const connectParams = new URLSearchParams();
      connectParams.set('token', token);
      connectParams.set('ticket', ticketId);
      connectParams.set('width', '800');
      connectParams.set('height', '600');
      connectParams.set('dpi', String(Math.round(96 * dpr)));

      const session = createSession({
        connectionId: conn.id,
        name: conn.name,
        protocol: conn.protocol,
        containerEl,
        connectParams,
      });
      ids.push(session.id);
    }

    if (ids.length > 0) {
      setTiledSessionIds(ids);
      setFocusedSessionIds([ids[0]]);
      setActiveSessionId(ids[0]);
      navigate('/tiled');
    }
    setChecked(new Set());
    setTiledCredPrompt(null);
    setTiledCreds({});
  }, [createSession, setTiledSessionIds, setFocusedSessionIds, setActiveSessionId, navigate]);

  /** Submit the tiled credential prompt form */
  const handleTiledCredSubmit = useCallback(() => {
    if (!tiledCredPrompt) return;
    const allConns = [...tiledCredPrompt.ready, ...tiledCredPrompt.needsCreds];
    launchTiled(allConns, tiledCreds);
  }, [tiledCredPrompt, tiledCreds, launchTiled]);

  // ── Top 5 most recently accessed connections for the hero cards ──
  const recentConnections = useMemo(() => {
    return [...connections]
      .filter((c) => c.last_accessed)
      .sort((a, b) => new Date(b.last_accessed!).getTime() - new Date(a.last_accessed!).getTime())
      .slice(0, 5);
  }, [connections]);

  /** Get credential status for a connection based on its mapped profile */
  const getCredStatus = useCallback((connId: string): 'active' | 'expired' | 'none' => {
    const profileId = connProfileMap[connId];
    if (!profileId) return 'none';
    const profile = credProfiles.find((p) => p.id === profileId);
    if (!profile) return 'none';
    return profile.expired ? 'expired' : 'active';
  }, [connProfileMap, credProfiles]);

  return (
    <div>
      <h1>My Connections</h1>

      {/* ── Recent Connections — Premium Glass Cards ── */}
      {recentConnections.length > 0 && (
        <div className="recent-cards-section">
          <div className="recent-cards-grid">
            {recentConnections.map((conn) => {
              const status = getCredStatus(conn.id);
              const isIP = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(conn.hostname);
              const domainLabel = conn.domain || (isIP ? '' : conn.hostname.split('.').slice(1).join('.'));
              return (
                <div
                  key={conn.id}
                  className="recent-card"
                  onClick={() => navigate(`/session/${conn.id}`)}
                >
                  {/* Status indicator dot */}
                  <div
                    className="recent-card-dot"
                    style={{
                      background: status === 'active' ? '#22c55e' : status === 'expired' ? '#ef4444' : '#8b5cf6',
                      boxShadow: status === 'active'
                        ? '0 0 8px rgba(34, 197, 94, 0.6)'
                        : status === 'expired'
                          ? '0 0 8px rgba(239, 68, 68, 0.6)'
                          : '0 0 8px rgba(139, 92, 246, 0.6)',
                    }}
                  />

                  {/* Card protocol icon */}
                  <div className="recent-card-icon-badge">
                    <ProtocolIcon protocol={conn.protocol} />
                  </div>

                  {/* Card content */}
                  <h3 className="recent-card-title">{conn.name}</h3>
                  <p className="recent-card-detail">
                    {conn.protocol.toUpperCase()} - {conn.hostname}:{conn.port}
                  </p>
                  <div className="recent-card-meta">
                    {(domainLabel || status !== 'none') && (
                      <p>
                        Status: {domainLabel ? `${domainLabel} ` : ''}
                        <span style={{
                          color: status === 'active' ? '#22c55e' : status === 'expired' ? '#ef4444' : 'var(--color-txt-tertiary)',
                        }}>
                          ({status === 'none' ? 'no profile' : status})
                        </span>
                      </p>
                    )}
                    <p>
                      Last Accessed:{' '}
                      {new Date(conn.last_accessed!).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                      })}
                    </p>
                  </div>

                  {/* Connect button */}
                  <button
                    className="btn-connect-glass w-full"
                    style={{
                      '--btn-border': status === 'active' ? 'rgba(34, 197, 94, 0.4)' : status === 'expired' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(139, 92, 246, 0.4)',
                      '--btn-text': status === 'active' ? '#22c55e' : status === 'expired' ? '#ef4444' : '#a78bfa',
                      '--btn-glow': status === 'active' ? 'rgba(34, 197, 94, 0.15)' : status === 'expired' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(139, 92, 246, 0.15)',
                    } as React.CSSProperties}
                    onClick={(e) => { e.stopPropagation(); navigate(`/session/${conn.id}`); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <polygon points="5,3 19,12 5,21" />
                    </svg>
                    Connect
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-4 mb-5 flex-wrap">
        <div className="flex items-center gap-2 flex-1 max-w-xs rounded-sm px-3 transition-all duration-200 focus-within:ring-3 focus-within:ring-accent-dim"
          style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-border)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-txt-tertiary">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            type="text"
            placeholder="Search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="!border-none !bg-transparent !shadow-none py-2 text-[0.8125rem] w-full focus:!shadow-none"
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="!mb-0 text-xs uppercase text-txt-tertiary font-semibold tracking-wide">Type</label>
          <div className="min-w-[140px]">
            <Select
              value={typeFilter}
              onChange={setTypeFilter}
              placeholder="Select select"
              options={[
                { value: '', label: 'All' },
                ...protocols.map(p => ({ value: p, label: p })),
              ]}
            />
          </div>
        </div>

        <button
          className={`btn-sm inline-flex items-center gap-1.5 ${showFavorites ? '!border-accent !text-accent' : ''}`}
          onClick={() => setShowFavorites(!showFavorites)}
          title={showFavorites ? 'Show all connections' : 'Show favorites only'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={showFavorites ? 'var(--color-accent)' : 'none'} stroke={showFavorites ? 'var(--color-accent)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          Favorites{favorites.size > 0 ? ` (${favorites.size})` : ''}
        </button>

        <button
          className={`btn-sm inline-flex items-center gap-1.5 ${folderView ? '!border-accent !text-accent' : ''}`}
          onClick={() => setFolderView(!folderView)}
          title={folderView ? 'Flat list view' : 'Group by folder'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={folderView ? 'var(--color-accent)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          Folders
        </button>

        {checked.size >= 2 && (
          <button className="btn-sm-primary" onClick={openTiled}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
            Open Tiled ({checked.size})
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="card !p-0 !overflow-hidden">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={paged.length > 0 && checked.size === paged.length}
                  onChange={toggleAllChecked}
                  className="checkbox"
                  title="Select all"
                />
              </th>
              <th>Connection Name</th>
              <th>Type</th>
              <th>Details</th>
              <th>Last Accessed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {folderView && groupedConnections ? (
              <>
                {groupedConnections.folders.map(([fid, folder]) => (
                  <ConnectionFolderRows
                    key={fid}
                    folderId={fid}
                    folderName={folder.name}
                    connections={folder.connections}
                    collapsed={collapsedFolders.has(fid)}
                    onToggleCollapse={() => toggleFolderCollapse(fid)}
                    checked={checked}
                    toggleChecked={toggleChecked}
                    favorites={favorites}
                    onToggleFavorite={handleToggleFavorite}
                    vaultConfigured={vaultConfigured}
                    credProfiles={credProfiles}
                    connProfileMap={connProfileMap}
                    onProfileChange={handleProfileChange}
                    navigate={navigate}
                  />
                ))}
                {groupedConnections.ungrouped.length > 0 && (
                  <ConnectionFolderRows
                    key="__ungrouped"
                    folderId="__ungrouped"
                    folderName="Ungrouped"
                    connections={groupedConnections.ungrouped}
                    collapsed={collapsedFolders.has('__ungrouped')}
                    onToggleCollapse={() => toggleFolderCollapse('__ungrouped')}
                    checked={checked}
                    toggleChecked={toggleChecked}
                    favorites={favorites}
                    onToggleFavorite={handleToggleFavorite}
                    vaultConfigured={vaultConfigured}
                    credProfiles={credProfiles}
                    connProfileMap={connProfileMap}
                    onProfileChange={handleProfileChange}
                    navigate={navigate}
                  />
                )}
              </>
            ) : (
              paged.map((conn) => (
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  checked={checked.has(conn.id)}
                  onToggleChecked={() => toggleChecked(conn.id)}
                  isFavorite={favorites.has(conn.id)}
                  onToggleFavorite={() => handleToggleFavorite(conn.id)}
                  vaultConfigured={vaultConfigured}
                  credProfiles={credProfiles}
                  assignedProfileId={connProfileMap[conn.id] || ''}
                  onProfileChange={handleProfileChange}
                  onConnect={() => navigate(`/session/${conn.id}`)}
                />
              ))
            )}
            {paged.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-txt-secondary">
                  {connections.length === 0
                    ? 'No connections available. Ask your administrator to assign connections to your role.'
                    : 'No connections match your filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 flex-wrap gap-4">
          <span className="text-[0.8125rem] text-txt-secondary">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length} connections
          </span>
          <div className="flex items-center gap-1">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn-sm inline-flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              Previous
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const p = i + 1;
              return (
                <button
                  key={p}
                  className={`btn w-8 h-8 !p-0 inline-flex items-center justify-center text-[0.8125rem] rounded-sm ${
                    page === p ? 'text-white !border-transparent' : ''
                  }`}
                  style={page === p ? { background: 'var(--color-accent)', boxShadow: 'var(--shadow-accent)' } : undefined}
                  onClick={() => setPage(p)}
                >
                  {p}
                </button>
              );
            })}
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="btn-sm inline-flex items-center gap-1">
              Next
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Tiled credential prompt modal ── */}
      {tiledCredPrompt && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}
          onClick={() => setTiledCredPrompt(null)}
        >
          <div
            className="card"
            style={{ maxWidth: 440, width: '100%', maxHeight: '80vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: 4 }}>Enter Credentials</h3>
            <p className="text-[0.8125rem] text-txt-secondary" style={{ marginBottom: 16 }}>
              The following connections require credentials to connect.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleTiledCredSubmit();
              }}
            >
              {tiledCredPrompt.needsCreds.map((conn) => (
                <div key={conn.id} style={{ marginBottom: 16 }}>
                  <div className="text-[0.8125rem] font-semibold" style={{ marginBottom: 6 }}>
                    <span className="badge badge-accent" style={{ marginRight: 8 }}>{conn.protocol.toUpperCase()}</span>
                    {conn.name}
                  </div>
                  <div className="flex gap-2">
                    <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                      <input
                        type="text"
                        placeholder="Username"
                        value={tiledCreds[conn.id]?.username || ''}
                        onChange={(e) =>
                          setTiledCreds((prev) => ({
                            ...prev,
                            [conn.id]: { ...prev[conn.id], username: e.target.value },
                          }))
                        }
                      />
                    </div>
                    <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                      <input
                        type="password"
                        placeholder="Password"
                        value={tiledCreds[conn.id]?.password || ''}
                        onChange={(e) =>
                          setTiledCreds((prev) => ({
                            ...prev,
                            [conn.id]: { ...prev[conn.id], password: e.target.value },
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex gap-2 justify-end" style={{ marginTop: 8 }}>
                <button type="button" className="btn-sm" onClick={() => setTiledCredPrompt(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn-sm-primary">
                  Connect All ({tiledCredPrompt.ready.length + tiledCredPrompt.needsCreds.length})
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Connection Row Component ────────────────────────────────────────

function ConnectionRow({ conn, checked, onToggleChecked, isFavorite, onToggleFavorite, vaultConfigured, credProfiles, assignedProfileId, onProfileChange, onConnect }: {
  conn: Connection;
  checked: boolean;
  onToggleChecked: () => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  vaultConfigured: boolean;
  credProfiles: CredentialProfile[];
  assignedProfileId: string;
  onProfileChange: (connectionId: string, profileId: string) => void;
  onConnect: () => void;
}) {
    const status: 'active' | 'expired' | 'none' = useMemo(() => {
      const profile = credProfiles.find(p => p.id === assignedProfileId);
      if (!profile) return 'none';
      return profile.expired ? 'expired' : 'active';
    }, [credProfiles, assignedProfileId]);

    const statusColors = {
      active: { border: 'rgba(34, 197, 94, 0.4)', text: '#22c55e', glow: 'rgba(34, 197, 94, 0.15)' },
      expired: { border: 'rgba(239, 68, 68, 0.4)', text: '#ef4444', glow: 'rgba(239, 68, 68, 0.15)' },
      none: { border: 'rgba(139, 92, 246, 0.4)', text: '#a78bfa', glow: 'rgba(139, 92, 246, 0.15)' },
    }[status];

    return (
      <tr>
        <td>
          <input type="checkbox" checked={checked} onChange={onToggleChecked} className="checkbox" />
        </td>
        <td>
          <div className="font-medium">{conn.name}</div>
          {conn.description && <div className="text-[0.75rem] text-txt-tertiary mt-0.5">{conn.description}</div>}
        </td>
        <td>
          <div className="flex items-center gap-2.5 text-accent-light">
            <ProtocolIcon protocol={conn.protocol} />
            <span className="badge badge-accent">{conn.protocol.toUpperCase()}</span>
          </div>
        </td>
        <td className="text-[0.8125rem] text-txt-secondary">
          {conn.protocol.toUpperCase()} — {conn.hostname}:{conn.port}
        </td>
        <td className="text-[0.8125rem] text-txt-secondary">
          {conn.last_accessed
            ? new Date(conn.last_accessed).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })
            : '—'}
        </td>
        <td>
          <div className="flex gap-2">
            <button
              className="btn-sm !px-2"
              onClick={onToggleFavorite}
              title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24"
                fill={isFavorite ? 'var(--color-warning, #f59e0b)' : 'none'}
                stroke={isFavorite ? 'var(--color-warning, #f59e0b)' : 'currentColor'}
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </button>
            <button
              className="btn-connect-glass"
              style={{
                '--btn-border': statusColors.border,
                '--btn-text': statusColors.text,
                '--btn-glow': statusColors.glow,
                padding: '0.35rem 0.8rem',
                fontSize: '0.75rem'
              } as React.CSSProperties}
              onClick={onConnect}
            >
              Connect
            </button>
          {vaultConfigured && (
            <div className="min-w-[140px]">
              <Select
                value={assignedProfileId}
                onChange={(v) => onProfileChange(conn.id, v)}
                placeholder="No profile"
                options={[
                  { value: '', label: 'None' },
                  ...credProfiles.map(p => ({ value: p.id, label: p.expired ? `${p.label} (expired)` : p.label })),
                ]}
              />
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Connection Folder Rows ───────────────────────────────────────────

function ConnectionFolderRows({ folderId: _fid, folderName, connections, collapsed, onToggleCollapse, checked, toggleChecked, favorites, onToggleFavorite, vaultConfigured, credProfiles, connProfileMap, onProfileChange, navigate }: {
  folderId: string;
  folderName: string;
  connections: Connection[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  checked: Set<string>;
  toggleChecked: (id: string) => void;
  favorites: Set<string>;
  onToggleFavorite: (id: string) => void;
  vaultConfigured: boolean;
  credProfiles: CredentialProfile[];
  connProfileMap: Record<string, string>;
  onProfileChange: (connectionId: string, profileId: string) => void;
  navigate: (path: string) => void;
}) {
  return (
    <>
      <tr
        onClick={onToggleCollapse}
        style={{ cursor: 'pointer', background: 'var(--color-surface-secondary)' }}
      >
        <td colSpan={6} className="!py-2">
          <div className="flex items-center gap-2 font-semibold text-[0.8125rem]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
            <span>{folderName}</span>
            <span className="text-txt-tertiary font-normal">({connections.length})</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>
        </td>
      </tr>
      {!collapsed && connections.map((conn) => (
        <ConnectionRow
          key={conn.id}
          conn={conn}
          checked={checked.has(conn.id)}
          onToggleChecked={() => toggleChecked(conn.id)}
          isFavorite={favorites.has(conn.id)}
          onToggleFavorite={() => onToggleFavorite(conn.id)}
          vaultConfigured={vaultConfigured}
          credProfiles={credProfiles}
          assignedProfileId={connProfileMap[conn.id] || ''}
          onProfileChange={onProfileChange}
          onConnect={() => navigate(`/session/${conn.id}`)}
        />
      ))}
    </>
  );
}
