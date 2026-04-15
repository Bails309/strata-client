import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getActiveSessions, getMyActiveSessions, killSessions,
  getRecordings, getMyRecordings, buildRecordingStreamUrl, buildMyRecordingStreamUrl,
  ActiveSession, HistoricalRecording, MeResponse,
} from '../api';
import HistoricalPlayer from '../components/HistoricalPlayer';
import ConfirmModal from '../components/ConfirmModal';
import { useSettings } from '../contexts/SettingsContext';

type Tab = 'live' | 'recordings';

export default function Sessions({ user }: { user: MeResponse | null }) {
  const navigate = useNavigate();
  const { formatDateTime } = useSettings();
  const [tab, setTab] = useState<Tab>('live');

  const isAdmin = user?.can_manage_system || user?.can_view_audit_logs;

  // ── Live Sessions state ─────────────────────────────────────────
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [liveLoading, setLiveLoading] = useState(true);
  const [killing, setKilling] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // ── Recordings state ────────────────────────────────────────────
  const [recordings, setRecordings] = useState<HistoricalRecording[]>([]);
  const [recLoading, setRecLoading] = useState(true);
  const [recError, setRecError] = useState('');
  const [selectedRec, setSelectedRec] = useState<HistoricalRecording | null>(null);
  const [search, setSearch] = useState('');

  // ── Live Sessions ───────────────────────────────────────────────
  const refreshLive = useCallback(async () => {
    try {
      const data = isAdmin ? await getActiveSessions() : await getMyActiveSessions();
      setSessions(data);
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    } finally {
      setLiveLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (tab === 'live') {
      refreshLive();
      const timer = setInterval(refreshLive, 10000);
      return () => clearInterval(timer);
    }
  }, [tab, refreshLive]);

  // ── Recordings ──────────────────────────────────────────────────
  const refreshRecordings = useCallback(async () => {
    setRecLoading(true);
    setRecError('');
    try {
      const data = isAdmin
        ? await getRecordings({ limit: 200 })
        : await getMyRecordings({ limit: 200 });
      setRecordings(data);
    } catch {
      setRecError('Failed to load recordings');
    } finally {
      setRecLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (tab === 'recordings') refreshRecordings();
  }, [tab, refreshRecordings]);

  // ── Helpers ─────────────────────────────────────────────────────
  const toggleAll = () => {
    if (selected.size === sessions.length) setSelected(new Set());
    else setSelected(new Set(sessions.map(s => s.session_id)));
  };

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const performKill = async () => {
    setShowConfirm(false);
    setKilling(true);
    try {
      await killSessions(Array.from(selected));
      setSelected(new Set());
      await refreshLive();
    } catch {
      alert('Failed to terminate sessions');
    } finally {
      setKilling(false);
    }
  };

  const getDuration = (startedAt: string) => {
    const diff = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  };

  const formatRecDuration = (secs: number | null) => {
    if (secs === null) return '—';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const protocolIcon = (proto: string) => {
    switch (proto.toLowerCase()) {
      case 'rdp': return <span className="badge badge-info uppercase">rdp</span>;
      case 'ssh': return <span className="badge badge-secondary uppercase">ssh</span>;
      case 'vnc': return <span className="badge badge-warning uppercase">vnc</span>;
      default: return <span className="badge uppercase">{proto}</span>;
    }
  };

  const filteredRecordings = recordings.filter((r) =>
    r.connection_name.toLowerCase().includes(search.toLowerCase()) ||
    (isAdmin && r.username.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Sessions</h1>
          <p className="text-txt-secondary text-sm mt-1">
            {isAdmin ? 'Monitor all user sessions and recordings.' : 'View your active sessions and past recordings.'}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-border">
        {(['live', 'recordings'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`pb-2 px-1 text-sm font-semibold uppercase tracking-wider transition-colors ${tab === t ? 'text-accent border-b-2 border-accent' : 'text-txt-tertiary hover:text-txt-primary'}`}
            onClick={() => setTab(t)}
          >
            {t === 'live' ? 'Live' : 'Recordings'}
          </button>
        ))}
      </div>

      {/* ── Live Tab ── */}
      {tab === 'live' && (
        <>
          <div className="flex items-center justify-end gap-3">
            <button className="btn-secondary text-sm h-9 px-4" onClick={refreshLive} disabled={liveLoading}>
              {liveLoading ? 'Refreshing...' : 'Refresh Now'}
            </button>
            {isAdmin && (
              <button
                className={`btn-danger text-sm h-9 px-4 ${selected.size === 0 || killing ? 'opacity-50 cursor-not-allowed' : ''}`}
                onClick={() => { if (selected.size > 0) setShowConfirm(true); }}
                disabled={selected.size === 0 || killing}
              >
                {killing ? 'Terminating...' : `Kill ${selected.size} Session(s)`}
              </button>
            )}
          </div>

          <div className="card p-0 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  {isAdmin && (
                    <th className="p-4 text-left w-10">
                      <input type="checkbox" className="checkbox"
                        checked={sessions.length > 0 && selected.size === sessions.length}
                        onChange={toggleAll}
                      />
                    </th>
                  )}
                  {isAdmin && <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">User</th>}
                  <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Connection</th>
                  <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Protocol</th>
                  <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Remote Host</th>
                  <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Active Since</th>
                  <th className="p-4 text-right text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Traffic</th>
                  <th className="p-4 text-right text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sessions.length === 0 ? (
                  <tr>
                    <td colSpan={isAdmin ? 8 : 6} className="p-12 text-center">
                      <div className="flex flex-col items-center gap-2">
                        <div className="p-3 bg-nav-link-hover rounded-full">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-txt-tertiary">
                            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" /><polyline points="13 2 13 9 20 9" />
                          </svg>
                        </div>
                        <p className="text-txt-secondary font-medium">No active sessions found</p>
                        <p className="text-xs text-txt-tertiary">New connections will appear here automatically.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  sessions.map((session) => (
                    <tr key={session.session_id} className={`hover:bg-nav-link-hover transition-colors ${selected.has(session.session_id) ? 'bg-accent-dim' : ''}`}>
                      {isAdmin && (
                        <td className="p-4">
                          <input type="checkbox" className="checkbox"
                            checked={selected.has(session.session_id)}
                            onChange={() => toggleOne(session.session_id)}
                          />
                        </td>
                      )}
                      {isAdmin && (
                        <td className="p-4">
                          <div className="flex flex-col">
                            <span className="text-sm font-semibold text-txt-primary">{session.username}</span>
                            <span className="text-[0.65rem] text-txt-tertiary font-mono">{session.user_id.slice(0, 8)}</span>
                          </div>
                        </td>
                      )}
                      <td className="p-4">
                        <span className="text-sm font-medium text-txt-primary">{session.connection_name}</span>
                      </td>
                      <td className="p-4">{protocolIcon(session.protocol)}</td>
                      <td className="p-4">
                        <span className="text-sm font-mono text-txt-primary">{session.remote_host}</span>
                      </td>
                      <td className="p-4">
                        <div className="flex flex-col">
                          <span className="text-sm text-txt-primary">{getDuration(session.started_at)}</span>
                          <span className="text-[0.65rem] text-txt-tertiary uppercase font-medium">Started {formatDateTime(session.started_at)}</span>
                        </div>
                      </td>
                      <td className="p-4 text-right">
                        <div className="flex flex-col items-end">
                          <span className="text-[0.7rem] text-txt-primary flex items-center gap-1">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-success"><path d="M12 5v14m-7-7l7 7 7-7"/></svg>
                            {(session.bytes_from_guacd / 1024 / 1024).toFixed(1)} MB
                          </span>
                          <span className="text-[0.7rem] text-txt-tertiary flex items-center gap-1">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent"><path d="M12 19V5m-7 7l7-7 7 7"/></svg>
                            {(session.bytes_to_guacd / 1024).toFixed(1)} KB
                          </span>
                        </div>
                      </td>
                      {isAdmin && (
                        <td className="p-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              className="btn btn-secondary text-xs py-1 px-2"
                              onClick={() => navigate(`/observe/${encodeURIComponent(session.session_id)}?offset=0&admin=1&name=${encodeURIComponent(session.connection_name)}&user=${encodeURIComponent(session.username)}`)}
                              title="Watch live"
                            >
                              <span className="inline-flex items-center gap-1 animate-pulse text-red-500">● Live</span>
                            </button>
                            <button
                              className="btn btn-secondary text-xs py-1 px-2"
                              onClick={() => navigate(`/observe/${encodeURIComponent(session.session_id)}?offset=300&admin=1&name=${encodeURIComponent(session.connection_name)}&user=${encodeURIComponent(session.username)}`)}
                              title="Rewind and replay the last 5 minutes"
                            >
                              ⏪ Rewind
                            </button>
                          </div>
                        </td>
                      )}
                      {!isAdmin && (
                        <td className="p-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              className="btn btn-secondary text-xs py-1 px-2"
                              onClick={() => navigate(`/observe/${encodeURIComponent(session.session_id)}?offset=0&name=${encodeURIComponent(session.connection_name)}&user=${encodeURIComponent(session.username)}`)}
                              title="Watch live"
                            >
                              <span className="inline-flex items-center gap-1 animate-pulse text-red-500">● Live</span>
                            </button>
                            <button
                              className="btn btn-secondary text-xs py-1 px-2"
                              onClick={() => navigate(`/observe/${encodeURIComponent(session.session_id)}?offset=300&name=${encodeURIComponent(session.connection_name)}&user=${encodeURIComponent(session.username)}`)}
                              title="Rewind and replay the last 5 minutes"
                            >
                              ⏪ Rewind
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {isAdmin && (
            <ConfirmModal
              isOpen={showConfirm}
              title="Terminate Sessions"
              message={`Are you sure you want to terminate ${selected.size} active session(s)? This will immediately disconnect the users.`}
              confirmLabel="Terminate"
              onConfirm={performKill}
              onCancel={() => setShowConfirm(false)}
              isDangerous={true}
            />
          )}
        </>
      )}

      {/* ── Recordings Tab ── */}
      {tab === 'recordings' && (
        <>
          <div className="flex items-center justify-between">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={isAdmin ? 'Filter by connection or user...' : 'Filter by connection name...'}
              className="input-sm w-full max-w-xs"
            />
            <button className="btn-secondary text-sm h-9 px-4" onClick={refreshRecordings} disabled={recLoading}>
              {recLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {recError && (
            <div className="px-4 py-2 rounded bg-red-500/10 text-red-400 text-sm">{recError}</div>
          )}

          {recLoading ? (
            <div className="text-center py-12 text-txt-secondary">
              <div className="w-6 h-6 rounded-full animate-spin mx-auto mb-3"
                style={{ border: '2px solid var(--color-border)', borderTopColor: 'var(--color-accent)' }} />
              Loading recordings…
            </div>
          ) : filteredRecordings.length === 0 ? (
            <div className="text-center py-12 text-txt-secondary">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p>No recordings found</p>
              <p className="text-xs mt-1">Session recordings will appear here once completed.</p>
            </div>
          ) : (
            <div className="card p-0 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                    {isAdmin && <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">User</th>}
                    <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Connection</th>
                    <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Started At</th>
                    <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Duration</th>
                    {isAdmin && <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Storage</th>}
                    <th className="p-4 text-right text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredRecordings.map((r) => (
                    <tr key={r.id} className="hover:bg-nav-link-hover transition-colors">
                      {isAdmin && (
                        <td className="p-4">
                          <span className="text-sm font-semibold text-txt-primary">{r.username}</span>
                        </td>
                      )}
                      <td className="p-4">
                        <span className="text-sm font-medium text-txt-primary">{r.connection_name}</span>
                      </td>
                      <td className="p-4">
                        <span className="text-txt-secondary text-sm">{formatDateTime(r.started_at)}</span>
                      </td>
                      <td className="p-4">
                        <span className="text-txt-secondary text-sm font-mono tabular-nums">{formatRecDuration(r.duration_secs)}</span>
                      </td>
                      {isAdmin && (
                        <td className="p-4">
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${r.storage_type === 'azure' ? 'bg-blue-500/10 text-blue-400' : 'bg-surface-tertiary text-txt-tertiary'}`}>
                            {r.storage_type}
                          </span>
                        </td>
                      )}
                      <td className="p-4 text-right">
                        <button className="btn-sm-primary py-1" onClick={() => setSelectedRec(r)}>
                          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                          </svg>
                          Play
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selectedRec && (
            <HistoricalPlayer
              recording={selectedRec}
              onClose={() => setSelectedRec(null)}
              streamUrlBuilder={isAdmin ? buildRecordingStreamUrl : buildMyRecordingStreamUrl}
            />
          )}
        </>
      )}
    </div>
  );
}
