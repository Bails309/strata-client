/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync
   and timer-driven refresh. */
import { useCallback, useEffect, useState } from "react";
import { DmzLinkRow, DmzLinksResponse, getDmzLinks, reconnectDmzLinks } from "../../api";

export default function DmzLinksTab() {
  const [data, setData] = useState<DmzLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [countdown, setCountdown] = useState(15);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    setErr("");
    getDmzLinks()
      .then((d) => {
        setData(d);
        setCountdown(15);
      })
      .catch(() => setErr("Failed to load DMZ link status"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => {
      setCountdown((p) => {
        if (p <= 1) {
          refresh();
          return 15;
        }
        return p - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  function handleReconnect() {
    setReconnecting(true);
    setErr("");
    reconnectDmzLinks()
      .then((r) => {
        setMsg(`Reconnect requested for ${r.nudged} link(s)`);
        setTimeout(() => setMsg(""), 3000);
        refresh();
      })
      .catch(() => setErr("Reconnect request failed"))
      .finally(() => setReconnecting(false));
  }

  if (loading && !data) {
    return (
      <div className="card">
        <p className="text-txt-secondary">Loading DMZ link status...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card">
        <p className="text-danger">{err || "Failed to load DMZ link status."}</p>
        <button className="btn mt-3" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  if (!data.configured) {
    return (
      <div className="card">
        <h2 className="!mb-2 text-lg font-semibold">DMZ links</h2>
        <p className="text-txt-secondary">
          DMZ mode is not enabled on this backend node. Inbound mTLS link supervision is inactive.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="!mb-1 text-xl font-bold">DMZ Links</h1>
          <p className="text-txt-tertiary text-sm italic">
            Inbound mTLS connections from this backend node to public-facing DMZ relay(s).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary" onClick={handleReconnect} disabled={reconnecting}>
            {reconnecting ? "Reconnecting..." : "Force reconnect"}
          </button>
          <button
            className="shrink-0 flex items-center gap-2 text-xs rounded-lg px-3 py-2"
            style={{
              background: "var(--color-surface-tertiary)",
              border: "1px solid var(--color-glass-border)",
              color: "var(--color-txt-secondary)",
            }}
            onClick={refresh}
          >
            Auto-refreshing in {countdown}s
          </button>
        </div>
      </div>

      {msg && <div className="rounded-md px-4 py-2 bg-success-dim text-success">{msg}</div>}
      {err && <div className="rounded-md px-4 py-2 bg-danger/10 text-danger">{err}</div>}

      {data.links.length === 0 ? (
        <div className="card">
          <p className="text-txt-secondary">No DMZ endpoints configured.</p>
        </div>
      ) : (
        <div className="card">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-txt-tertiary border-b border-glass-border">
                <th className="py-2 pr-4">Endpoint</th>
                <th className="py-2 pr-4">State</th>
                <th className="py-2 pr-4">Connects</th>
                <th className="py-2 pr-4">Failures</th>
                <th className="py-2 pr-4">Since</th>
                <th className="py-2">Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.links.map((row) => (
                <DmzLinkTableRow key={row.endpoint} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DmzLinkTableRow({ row }: { row: DmzLinkRow }) {
  const stateColor = stateBadgeColor(row.state);
  return (
    <tr className="border-b border-glass-border/50 last:border-0">
      <td className="py-2 pr-4 font-mono">{row.endpoint}</td>
      <td className="py-2 pr-4">
        <span
          className="inline-block rounded px-2 py-0.5 text-xs font-medium"
          style={{ background: `${stateColor}22`, color: stateColor }}
        >
          {row.state}
        </span>
      </td>
      <td className="py-2 pr-4">{row.connects}</td>
      <td className="py-2 pr-4">{row.failures}</td>
      <td className="py-2 pr-4">{relTime(row.since_unix_secs)}</td>
      <td className="py-2 text-txt-secondary truncate max-w-md">{row.last_error ?? "-"}</td>
    </tr>
  );
}

function stateBadgeColor(s: string): string {
  switch (s) {
    case "up":
      return "var(--color-success)";
    case "connecting":
    case "authenticating":
    case "initializing":
      return "var(--color-warning)";
    case "backoff":
    case "stopped":
      return "var(--color-danger)";
    default:
      return "var(--color-txt-secondary)";
  }
}

function relTime(unixSecs: number): string {
  if (!unixSecs) return "-";
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - unixSecs);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
