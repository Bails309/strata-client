/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useState, useEffect, useCallback } from "react";
import { getMyRecordings, buildMyRecordingStreamUrl, HistoricalRecording } from "../api";
import HistoricalPlayer from "../components/HistoricalPlayer";
import { useSettings } from "../contexts/SettingsContext";

export default function MyRecordings() {
  const { formatDateTime } = useSettings();
  const [recordings, setRecordings] = useState<HistoricalRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<HistoricalRecording | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getMyRecordings({ limit: 200 });
      setRecordings(data);
    } catch {
      setError("Failed to load recordings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function formatDuration(secs: number | null) {
    if (secs === null) return "—";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  const filtered = recordings.filter((r) =>
    r.connection_name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold text-txt-primary mb-6">My Recordings</h1>

      {error && (
        <div className="mb-4 px-4 py-2 rounded bg-red-500/10 text-red-400 text-sm">{error}</div>
      )}

      {/* Search */}
      <div className="mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by connection name..."
          className="input-sm w-full max-w-xs"
        />
      </div>

      {loading ? (
        <div className="text-center py-12 text-txt-secondary">
          <div
            className="w-6 h-6 rounded-full animate-spin mx-auto mb-3"
            style={{
              border: "2px solid var(--color-border)",
              borderTopColor: "var(--color-accent)",
            }}
          />
          Loading recordings…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-txt-secondary">
          <svg
            className="w-12 h-12 mx-auto mb-3 opacity-40"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p>No recordings found</p>
          <p className="text-xs mt-1">Session recordings will appear here once completed.</p>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Connection</th>
                <th>Started At</th>
                <th>Duration</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="font-medium text-txt-primary">{r.connection_name}</span>
                  </td>
                  <td>
                    <span className="text-txt-secondary text-sm">
                      {formatDateTime(r.started_at)}
                    </span>
                  </td>
                  <td>
                    <span className="text-txt-secondary text-sm font-mono tabular-nums">
                      {formatDuration(r.duration_secs)}
                    </span>
                  </td>
                  <td className="text-right">
                    <button className="btn-sm-primary py-1" onClick={() => setSelected(r)}>
                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                          clipRule="evenodd"
                        />
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

      {selected && (
        <HistoricalPlayer
          recording={selected}
          onClose={() => setSelected(null)}
          streamUrlBuilder={buildMyRecordingStreamUrl}
        />
      )}
    </div>
  );
}
