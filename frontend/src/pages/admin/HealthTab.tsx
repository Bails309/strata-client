/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useCallback, useEffect, useState } from "react";
import { MetricsSummary, ServiceHealth, getMetrics, getServiceHealth } from "../../api";

export default function HealthTab({ onNavigateVault }: { onNavigateVault: () => void }) {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(60);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([getServiceHealth().catch(() => null), getMetrics().catch(() => null)])
      .then(([h, m]) => {
        setHealth(h);
        setMetrics(m);
        setLastChecked(new Date());
        setCountdown(60);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh countdown
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          refresh();
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  function formatUptime(secs: number): string {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    return `${h}h ${m}m`;
  }

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
        <button className="btn mt-3" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  const iconStyle = (color: string) => ({
    width: 40,
    height: 40,
    borderRadius: 10,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    background: `${color}18`,
    color,
    flexShrink: 0 as const,
  });

  return (
    <div className="grid gap-5">
      {/* Header */}
      <div className="flex justify-between items-start">
        <div>
          <h1 className="!mb-1 text-xl font-bold">System Health</h1>
          <p className="text-txt-tertiary text-sm italic">
            Real-time status and diagnostics for core infrastructure.
          </p>
        </div>
        <button
          className="shrink-0 flex items-center gap-2 text-xs rounded-lg px-3 py-2"
          style={{
            background: "var(--color-surface-tertiary)",
            border: "1px solid var(--color-glass-border)",
            color: "var(--color-txt-secondary)",
          }}
          onClick={refresh}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={loading ? "animate-spin" : ""}
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          Auto-refreshing in {countdown}s
        </button>
      </div>

      {/* Service Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Database */}
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <div className="flex items-center justify-between">
            <div style={iconStyle("#8b5cf6")}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
                <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
              </svg>
            </div>
            <span
              className={`badge ${health.database.connected ? "badge-success" : "badge-error"}`}
            >
              {health.database.connected ? "Healthy" : "Unhealthy"}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-0.5">Database</h3>
            <p className="text-xs text-txt-tertiary">PostgreSQL Persistence Layer</p>
          </div>
          <div className="mt-auto space-y-2 text-xs">
            {health.database.latency_ms !== null && health.database.latency_ms !== undefined && (
              <div className="flex justify-between">
                <span className="text-txt-tertiary">Latency</span>
                <span className="font-semibold text-txt-primary">
                  {health.database.latency_ms}ms
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Mode</span>
              <span className="font-semibold text-txt-primary capitalize">
                {health.database.mode}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Host</span>
              <span
                className="font-mono text-txt-secondary text-[0.65rem] truncate ml-2"
                title={health.database.host}
              >
                {health.database.host}
              </span>
            </div>
          </div>
        </div>

        {/* guacd Gateway */}
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <div className="flex items-center justify-between">
            <div style={iconStyle("#f59e0b")}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <span className={`badge ${health.guacd.reachable ? "badge-success" : "badge-error"}`}>
              {health.guacd.reachable ? "Healthy" : "Unhealthy"}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-0.5">guacd</h3>
            <p className="text-xs text-txt-tertiary">Remote Desktop Gateway</p>
          </div>
          <div className="mt-auto space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Host</span>
              <span className="font-mono text-txt-secondary">{health.guacd.host}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Port</span>
              <span className="font-mono text-txt-secondary">{health.guacd.port}</span>
            </div>
            {metrics && (
              <div className="flex justify-between">
                <span className="text-txt-tertiary">Pool Size</span>
                <span className="font-semibold text-txt-primary">{metrics.guacd_pool_size}</span>
              </div>
            )}
          </div>
        </div>

        {/* Vault */}
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <div className="flex items-center justify-between">
            <div style={iconStyle("#22c55e")}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <span
              className={`badge ${health.vault.configured ? "badge-success" : "badge-warning"}`}
            >
              {health.vault.configured ? "Healthy" : "Not Configured"}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-0.5">Vault</h3>
            <p className="text-xs text-txt-tertiary">Encryption & Secret Management</p>
          </div>
          <div className="mt-auto space-y-2 text-xs">
            {health.vault.configured ? (
              <>
                <div className="flex justify-between">
                  <span className="text-txt-tertiary">Mode</span>
                  <span className="font-semibold text-txt-primary capitalize">
                    {health.vault.mode === "local" ? "Bundled" : "External"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-txt-tertiary">Address</span>
                  <span
                    className="font-mono text-txt-secondary text-[0.65rem] truncate ml-2"
                    title={health.vault.address}
                  >
                    {health.vault.address}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-txt-tertiary">
                Not configured.{" "}
                <button
                  className="text-accent underline bg-transparent border-0 cursor-pointer p-0 text-xs"
                  onClick={onNavigateVault}
                >
                  Set up Vault
                </button>
              </p>
            )}
          </div>
        </div>

        {/* Schema */}
        <div
          className="rounded-xl p-5 flex flex-col gap-4"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <div className="flex items-center justify-between">
            <div style={iconStyle("#06b6d4")}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" x2="8" y1="13" y2="13" />
                <line x1="16" x2="8" y1="17" y2="17" />
                <line x1="10" x2="8" y1="9" y2="9" />
              </svg>
            </div>
            <span
              className={`badge ${health.schema.status === "in_sync" ? "badge-success" : health.schema.status === "unavailable" ? "badge-warning" : "badge-error"}`}
            >
              {health.schema.status === "in_sync"
                ? "Healthy"
                : health.schema.status === "unavailable"
                  ? "Unavailable"
                  : "Out of Sync"}
            </span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-0.5">Schema</h3>
            <p className="text-xs text-txt-tertiary">Database Migrations</p>
          </div>
          <div className="mt-auto space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Status</span>
              <span className="font-semibold text-txt-primary">
                {health.schema.status === "in_sync"
                  ? "In Sync"
                  : health.schema.status === "unavailable"
                    ? "Unavailable"
                    : "Out of Sync"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Applied</span>
              <span className="font-mono text-txt-secondary">
                {health.schema.applied_migrations}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-txt-tertiary">Expected</span>
              <span className="font-mono text-txt-secondary">
                {health.schema.expected_migrations}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={iconStyle("#8b5cf6")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Uptime
            </p>
            <p className="text-sm font-bold text-txt-primary">{formatUptime(health.uptime_secs)}</p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={iconStyle("#f59e0b")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="7" height="7" x="3" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="3" rx="1" />
              <rect width="7" height="7" x="14" y="14" rx="1" />
              <rect width="7" height="7" x="3" y="14" rx="1" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Active Sessions
            </p>
            <p className="text-sm font-bold text-txt-primary">{metrics?.active_sessions ?? 0}</p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={iconStyle("#ef4444")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Strata Version
            </p>
            <p className="text-sm font-bold text-txt-primary">v{__APP_VERSION__}</p>
            {health.version && health.version !== __APP_VERSION__ && (
              <p className="text-[0.6rem] text-yellow-400">Backend: v{health.version}</p>
            )}
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={iconStyle("#22c55e")}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Environment
            </p>
            <p className="text-sm font-bold text-txt-primary uppercase">{health.environment}</p>
          </div>
        </div>
      </div>

      {/* Last Checked */}
      {lastChecked && (
        <p className="text-right text-[0.65rem] text-txt-tertiary">
          Last Checked: {lastChecked.toLocaleDateString("en-GB")},{" "}
          {lastChecked.toLocaleTimeString("en-GB")}
        </p>
      )}
    </div>
  );
}
