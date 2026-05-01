import { useEffect, useState, useCallback } from "react";
import { getActiveSessions, killSessions, ActiveSession } from "../api";
import ConfirmModal from "../components/ConfirmModal";
import { useSettings } from "../contexts/SettingsContext";

export default function ActiveSessions() {
  const { formatDateTime } = useSettings();
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Poll for active sessions every 10 seconds
  const refresh = useCallback(async () => {
    try {
      const data = await getActiveSessions();
      setSessions(data);
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggleAll = () => {
    if (selected.size === sessions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sessions.map((s) => s.session_id)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleKill = () => {
    if (selected.size === 0) return;
    setShowConfirm(true);
  };

  const performKill = async () => {
    setShowConfirm(false);
    setKilling(true);
    try {
      await killSessions(Array.from(selected));
      setSelected(new Set());
      await refresh();
    } catch (err) {
      alert("Failed to terminate sessions");
    } finally {
      setKilling(false);
    }
  };

  // Humanize duration from started_at
  const getDuration = (startedAt: string) => {
    const start = new Date(startedAt).getTime();
    const now = Date.now();
    const diff = Math.floor((now - start) / 1000);

    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;

    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(" ");
  };

  const protocolIcon = (proto: string) => {
    switch (proto.toLowerCase()) {
      case "rdp":
        return <span className="badge badge-info uppercase">rdp</span>;
      case "ssh":
        return <span className="badge badge-secondary uppercase">ssh</span>;
      case "vnc":
        return <span className="badge badge-warning uppercase">vnc</span>;
      case "web":
        return <span className="badge badge-success uppercase">web</span>;
      case "vdi":
        return <span className="badge badge-accent uppercase">vdi</span>;
      case "kubernetes":
        return <span className="badge badge-primary uppercase">k8s</span>;
      default:
        return <span className="badge uppercase">{proto}</span>;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Active Sessions</h1>
          <p className="text-txt-secondary text-sm mt-1">
            Monitor and manage real-time user connections.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-secondary text-sm h-9 px-4" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Now"}
          </button>
          <button
            className={`btn-danger text-sm h-9 px-4 ${selected.size === 0 || killing ? "opacity-50 cursor-not-allowed" : ""}`}
            onClick={handleKill}
            disabled={selected.size === 0 || killing}
          >
            {killing ? "Terminating..." : `Kill ${selected.size} Session(s)`}
          </button>
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
              <th className="p-4 text-left w-10">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={sessions.length > 0 && selected.size === sessions.length}
                  onChange={toggleAll}
                />
              </th>
              <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
                User
              </th>
              <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
                Connection
              </th>
              <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
                Protocol
              </th>
              <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
                Source IP
              </th>
              <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
                Remote Host
              </th>
              <th className="p-4 text-left text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
                Active Since
              </th>
              <th className="p-4 text-right text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
                Traffic
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="p-3 bg-nav-link-hover rounded-full">
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="text-txt-tertiary"
                      >
                        <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
                        <polyline points="13 2 13 9 20 9" />
                      </svg>
                    </div>
                    <p className="text-txt-secondary font-medium">No active sessions found</p>
                    <p className="text-xs text-txt-tertiary">
                      New connections will appear here automatically.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              sessions.map((session) => (
                <tr
                  key={session.session_id}
                  className={`hover:bg-nav-link-hover transition-colors ${selected.has(session.session_id) ? "bg-accent-dim" : ""}`}
                >
                  <td className="p-4">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={selected.has(session.session_id)}
                      onChange={() => toggleOne(session.session_id)}
                    />
                  </td>
                  <td className="p-4">
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-txt-primary">
                        {session.username}
                      </span>
                      <span className="text-[0.65rem] text-txt-tertiary font-mono">
                        {session.user_id.slice(0, 8)}
                      </span>
                    </div>
                  </td>
                  <td className="p-4">
                    <span className="text-sm font-medium text-txt-primary">
                      {session.connection_name}
                    </span>
                  </td>
                  <td className="p-4">{protocolIcon(session.protocol)}</td>
                  <td className="p-4">
                    <span className="text-sm font-mono text-txt-primary">{session.client_ip}</span>
                  </td>
                  <td className="p-4">
                    <span className="text-sm font-mono text-txt-primary">
                      {session.remote_host}
                    </span>
                  </td>
                  <td className="p-4">
                    <div className="flex flex-col">
                      <span className="text-sm text-txt-primary">
                        {getDuration(session.started_at)}
                      </span>
                      <span className="text-[0.65rem] text-txt-tertiary uppercase font-medium">
                        Started {formatDateTime(session.started_at)}
                      </span>
                    </div>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex flex-col items-end">
                      <span className="text-[0.7rem] text-txt-primary flex items-center gap-1">
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="text-success"
                        >
                          <path d="M12 5v14m-7-7l7 7 7-7" />
                        </svg>
                        {(session.bytes_from_guacd / 1024 / 1024).toFixed(1)} MB
                      </span>
                      <span className="text-[0.7rem] text-txt-tertiary flex items-center gap-1">
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="text-accent"
                        >
                          <path d="M12 19V5m-7 7l7-7 7 7" />
                        </svg>
                        {(session.bytes_to_guacd / 1024).toFixed(1)} KB
                      </span>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ConfirmModal
        isOpen={showConfirm}
        title="Terminate Sessions"
        message={`Are you sure you want to terminate ${selected.size} active session(s)? This will immediately disconnect the users.`}
        confirmLabel="Terminate"
        onConfirm={performKill}
        onCancel={() => setShowConfirm(false)}
        isDangerous={true}
      />
    </div>
  );
}
