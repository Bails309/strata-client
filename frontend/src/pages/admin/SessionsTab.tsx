import { useEffect, useState } from "react";
import { useSettings } from "../../contexts/SettingsContext";
import { MetricsSummary, SessionStats, getMetrics, getSessionStats } from "../../api";

function GuacdCapacityGauge({ metrics }: { metrics: MetricsSummary }) {
  const poolSize = metrics.guacd_pool_size || 1;
  const activeSessions = metrics.active_sessions;
  const recPerInstance = metrics.recommended_per_instance || 20;
  const totalCapacity = poolSize * recPerInstance;
  const perInstance = poolSize > 0 ? activeSessions / poolSize : activeSessions;
  const usagePercent = Math.min((activeSessions / totalCapacity) * 100, 100);

  // Format system resources for display
  const memGB = metrics.system_total_memory
    ? (metrics.system_total_memory / 1_073_741_824).toFixed(1)
    : null;
  const cpuCores = metrics.system_cpu_cores || null;

  // Format total live bandwidth
  const totalBw = metrics.total_bytes_from_guacd + metrics.total_bytes_to_guacd;
  const fmtBw = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`;
    return `${(b / 1_073_741_824).toFixed(2)} GB`;
  };

  // Color zones
  const getColor = (pct: number) => {
    if (pct >= 80) return "#ef4444"; // red
    if (pct >= 60) return "#f59e0b"; // amber
    return "#22c55e"; // green
  };

  const color = getColor(usagePercent);

  // Recommendation
  const getRecommendation = () => {
    if (usagePercent >= 90)
      return {
        level: "critical" as const,
        text: "Capacity critical — add guacd instances immediately to avoid degraded performance.",
      };
    if (usagePercent >= 75)
      return {
        level: "warning" as const,
        text: "Consider adding another guacd instance. Performance may degrade above 80% capacity.",
      };
    if (usagePercent >= 50)
      return {
        level: "info" as const,
        text: "Capacity healthy. Plan to scale when sustained load exceeds 75%.",
      };
    return null;
  };

  const recommendation = getRecommendation();

  // Semi-circle arc gauge
  const radius = 70;
  const strokeWidth = 12;
  const circumference = Math.PI * radius; // half-circle
  const offset = circumference - (usagePercent / 100) * circumference;

  // Protocol breakdown
  const protocols = Object.entries(metrics.sessions_by_protocol);

  return (
    <div
      className="rounded-xl p-5"
      style={{
        background: "var(--color-surface-secondary)",
        border: "1px solid var(--color-glass-border)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
      }}
    >
      <div className="flex items-center gap-2 mb-4">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
        <h3 className="text-sm font-bold" style={{ color: "var(--color-accent)" }}>
          guacd Resource Capacity
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 items-center">
        {/* Gauge */}
        <div className="flex flex-col items-center">
          <svg width="180" height="105" viewBox="0 0 180 105">
            {/* Background arc */}
            <path
              d={`M ${90 - radius} 95 A ${radius} ${radius} 0 0 1 ${90 + radius} 95`}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
            />
            {/* Value arc */}
            <path
              d={`M ${90 - radius} 95 A ${radius} ${radius} 0 0 1 ${90 + radius} 95`}
              fill="none"
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.4s ease" }}
            />
            {/* Percentage text */}
            <text
              x="90"
              y="78"
              textAnchor="middle"
              fill={color}
              fontSize="28"
              fontWeight="bold"
              fontFamily="system-ui"
            >
              {Math.round(usagePercent)}%
            </text>
            <text
              x="90"
              y="96"
              textAnchor="middle"
              fill="var(--color-txt-tertiary)"
              fontSize="10"
              fontFamily="system-ui"
            >
              capacity used
            </text>
          </svg>
        </div>

        {/* Info panel */}
        <div className="grid gap-3">
          {/* Metric pills */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                Active Sessions
              </p>
              <p className="text-lg font-bold" style={{ color }}>
                {activeSessions}
              </p>
            </div>
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                guacd Instances
              </p>
              <p className="text-lg font-bold text-txt-primary">{poolSize}</p>
            </div>
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                Per Instance
              </p>
              <p className="text-lg font-bold text-txt-primary">{perInstance.toFixed(1)}</p>
            </div>
            <div
              className="rounded-lg px-3 py-2"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                Max Recommended
              </p>
              <p className="text-lg font-bold text-txt-primary">{totalCapacity}</p>
            </div>
          </div>

          {/* Protocol breakdown + bandwidth */}
          {protocols.length > 0 && (
            <div className="flex items-center gap-3 text-xs flex-wrap">
              <span className="text-txt-tertiary font-semibold">By Protocol:</span>
              {protocols.map(([proto, count]) => (
                <span
                  key={proto}
                  className="uppercase text-[0.6rem] font-bold tracking-wider px-2 py-0.5 rounded"
                  style={{
                    background: "var(--color-surface-tertiary)",
                    color: "var(--color-txt-secondary)",
                  }}
                >
                  {proto} {count}
                </span>
              ))}
              {totalBw > 0 && (
                <>
                  <span className="text-txt-tertiary">|</span>
                  <span className="text-txt-tertiary font-semibold">Live Bandwidth:</span>
                  <span
                    className="text-[0.6rem] font-bold tracking-wider px-2 py-0.5 rounded"
                    style={{
                      background: "var(--color-surface-tertiary)",
                      color: "var(--color-txt-secondary)",
                    }}
                  >
                    ↓{fmtBw(metrics.total_bytes_from_guacd)} ↑{fmtBw(metrics.total_bytes_to_guacd)}
                  </span>
                </>
              )}
            </div>
          )}

          {/* System resources */}
          {(memGB || cpuCores) && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-txt-tertiary font-semibold">Host Resources:</span>
              {cpuCores && (
                <span
                  className="text-[0.6rem] font-bold tracking-wider px-2 py-0.5 rounded"
                  style={{
                    background: "var(--color-surface-tertiary)",
                    color: "var(--color-txt-secondary)",
                  }}
                >
                  {cpuCores} vCPUs
                </span>
              )}
              {memGB && (
                <span
                  className="text-[0.6rem] font-bold tracking-wider px-2 py-0.5 rounded"
                  style={{
                    background: "var(--color-surface-tertiary)",
                    color: "var(--color-txt-secondary)",
                  }}
                >
                  {memGB} GB RAM
                </span>
              )}
              <span className="text-[0.55rem] text-txt-tertiary italic">
                ({recPerInstance}/instance after 30% reserve)
              </span>
            </div>
          )}

          {/* Capacity bar */}
          <div>
            <div className="flex justify-between text-[0.6rem] text-txt-tertiary mb-1">
              <span>0</span>
              <span
                className="font-semibold"
                style={{ color: usagePercent >= 75 ? "#f59e0b" : "var(--color-txt-tertiary)" }}
              >
                {Math.round(totalCapacity * 0.75)} (scale threshold)
              </span>
              <span>{totalCapacity}</span>
            </div>
            <div
              className="relative h-3 rounded-full overflow-hidden"
              style={{ background: "var(--color-surface-tertiary)" }}
            >
              {/* Scale threshold marker */}
              <div
                className="absolute top-0 bottom-0 w-px"
                style={{ left: "75%", background: "#f59e0b", opacity: 0.6, zIndex: 2 }}
              />
              {/* Fill */}
              <div
                className="h-full rounded-full"
                style={{
                  width: `${usagePercent}%`,
                  background: `linear-gradient(90deg, #22c55e, ${usagePercent > 60 ? "#f59e0b" : "#22c55e"}, ${usagePercent > 80 ? "#ef4444" : usagePercent > 60 ? "#f59e0b" : "#22c55e"})`,
                  transition: "width 0.6s ease",
                }}
              />
            </div>
          </div>

          {/* Recommendation */}
          {recommendation && (
            <div
              className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
              style={{
                background:
                  recommendation.level === "critical"
                    ? "rgba(239,68,68,0.1)"
                    : recommendation.level === "warning"
                      ? "rgba(245,158,11,0.1)"
                      : "rgba(34,197,94,0.08)",
                border: `1px solid ${recommendation.level === "critical" ? "rgba(239,68,68,0.25)" : recommendation.level === "warning" ? "rgba(245,158,11,0.25)" : "rgba(34,197,94,0.15)"}`,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 mt-0.5"
                stroke={
                  recommendation.level === "critical"
                    ? "#ef4444"
                    : recommendation.level === "warning"
                      ? "#f59e0b"
                      : "#22c55e"
                }
              >
                {recommendation.level === "info" ? (
                  <>
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </>
                ) : (
                  <>
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </>
                )}
              </svg>
              <span
                style={{
                  color:
                    recommendation.level === "critical"
                      ? "#ef4444"
                      : recommendation.level === "warning"
                        ? "#f59e0b"
                        : "#22c55e",
                }}
              >
                {recommendation.text}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SessionsTab() {
  const { formatDateTime } = useSettings();
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);

  useEffect(() => {
    getSessionStats()
      .then(setStats)
      .catch(() => {});
    getMetrics()
      .then(setMetrics)
      .catch(() => {});
  }, []);

  // Refresh metrics periodically
  useEffect(() => {
    const interval = setInterval(() => {
      getMetrics()
        .then(setMetrics)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  }

  const statIconStyle = (color: string) => ({
    width: 36,
    height: 36,
    borderRadius: 8,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    background: `${color}18`,
    color,
    flexShrink: 0 as const,
  });

  return (
    <div className="grid gap-5">
      {/* Stat Cards */}
      <p className="text-xs text-txt-tertiary italic">Showing data from the last 30 days</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={statIconStyle("#8b5cf6")}>
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
              Total Sessions
            </p>
            <p className="text-sm font-bold text-txt-primary">
              {stats ? stats.total_sessions.toLocaleString() : "—"}
            </p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={statIconStyle("#f59e0b")}>
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
              Total Hours
            </p>
            <p className="text-sm font-bold text-txt-primary">
              {stats ? stats.total_hours.toFixed(1) : "—"}
            </p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={statIconStyle("#06b6d4")}>
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
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div>
            <p className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
              Unique Users
            </p>
            <p className="text-sm font-bold text-txt-primary">
              {stats ? stats.unique_users.toLocaleString() : "—"}
            </p>
          </div>
        </div>

        <div
          className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
          }}
        >
          <div style={statIconStyle("#22c55e")}>
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
              Active Now
            </p>
            <p className="text-sm font-bold text-txt-primary">{stats ? stats.active_now : "—"}</p>
          </div>
        </div>
      </div>

      {/* Usage Analytics */}
      {stats && (stats.daily_trend?.length > 0 || stats.avg_duration_mins > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Daily Trend Chart */}
          {stats.daily_trend?.length > 0 && (
            <div
              className="md:col-span-2 rounded-xl p-5 flex flex-col"
              style={{
                background: "var(--color-surface-secondary)",
                border: "1px solid var(--color-glass-border)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
              }}
            >
              <h3 className="text-sm font-bold mb-3" style={{ color: "var(--color-accent)" }}>
                Daily Usage (30 days)
              </h3>
              {(() => {
                const raw = stats.daily_trend;

                // Fill missing days so the chart has no gaps
                const filled: typeof raw = [];
                if (raw.length > 0) {
                  const start = new Date(raw[0].date + "T00:00:00");
                  const end = new Date(raw[raw.length - 1].date + "T00:00:00");
                  const lookup = new Map(raw.map((d) => [d.date, d]));
                  for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
                    const key = dt.toISOString().slice(0, 10);
                    filled.push(
                      lookup.get(key) ?? { date: key, sessions: 0, hours: 0, unique_users: 0 }
                    );
                  }
                }
                const trend = filled.length > 0 ? filled : raw;

                const maxSessions = Math.max(...trend.map((d) => d.sessions), 1);
                const maxHours = Math.max(...trend.map((d) => d.hours), 0.1);

                // SVG dimensions
                const padL = 32;
                const padR = 8;
                const padT = 8;
                const padB = 24;
                const vbW = 600;
                const vbH = 160;
                const plotW = vbW - padL - padR;
                const plotH = vbH - padT - padB;

                // Bar sizing — fill the plot width naturally
                const barW = plotW / Math.max(trend.length, 1);
                const offsetX = padL;
                const barPad = Math.min(barW * 0.15, 6);

                // Y-axis grid — pick ~4 nice ticks
                const rawStep = maxSessions / 4;
                const yStep =
                  rawStep <= 1 ? 1 : rawStep <= 5 ? Math.ceil(rawStep) : Math.ceil(rawStep / 5) * 5;
                const yTicks: number[] = [];
                for (let v = 0; v <= maxSessions; v += yStep) yTicks.push(v);
                if (yTicks[yTicks.length - 1] < maxSessions)
                  yTicks.push(yTicks[yTicks.length - 1] + yStep);
                const yMax = yTicks[yTicks.length - 1] || 1;

                // Gridlines + Y labels
                const gridLines = yTicks
                  .map((v) => {
                    const y = padT + plotH - (v / yMax) * plotH;
                    return (
                      `<line x1="${padL}" x2="${vbW - padR}" y1="${y}" y2="${y}" stroke="var(--color-glass-border)" stroke-width="0.5" stroke-dasharray="3,3"/>` +
                      `<text x="${padL - 4}" y="${y + 2}" text-anchor="end" fill="var(--color-txt-tertiary)" font-size="7" font-family="inherit">${v}</text>`
                    );
                  })
                  .join("");

                // Session bars (skip zero-height)
                const sessionBars = trend
                  .map((d, i) => {
                    if (d.sessions === 0) return "";
                    const x = offsetX + i * barW + barPad;
                    const w = barW - barPad * 2;
                    const barH = (d.sessions / yMax) * plotH;
                    const y = padT + plotH - barH;
                    return (
                      `<rect x="${x}" y="${y}" width="${w}" height="${barH}" rx="2" fill="var(--color-accent)" opacity="0.7">` +
                      `<title>${d.date}\n${d.sessions} session${d.sessions !== 1 ? "s" : ""} · ${d.hours.toFixed(1)} hrs</title></rect>`
                    );
                  })
                  .join("");

                // Hours line + dots
                const hoursCoords = trend.map((d, i) => {
                  const x = offsetX + i * barW + barW / 2;
                  const y = padT + plotH - (d.hours / maxHours) * plotH;
                  return { x, y, d };
                });
                const hoursPolyline = hoursCoords.map((c) => `${c.x},${c.y}`).join(" ");
                const hoursDots = hoursCoords
                  .map(
                    (c) =>
                      `<circle cx="${c.x}" cy="${c.y}" r="2.5" fill="#f59e0b" stroke="var(--color-surface-secondary)" stroke-width="1">` +
                      `<title>${c.d.date}\n${c.d.hours.toFixed(1)} hrs</title></circle>`
                  )
                  .join("");

                // X-axis labels — show all when ≤ 14 days, otherwise evenly spaced
                const labelIndices = new Set<number>();
                if (trend.length <= 14) {
                  trend.forEach((_, i) => labelIndices.add(i));
                } else {
                  labelIndices.add(0);
                  labelIndices.add(trend.length - 1);
                  const labelStep = Math.max(1, Math.floor(trend.length / 8));
                  for (let i = labelStep; i < trend.length - 1; i += labelStep) labelIndices.add(i);
                }

                const xLabels = [...labelIndices]
                  .map((i) => {
                    const x = offsetX + i * barW + barW / 2;
                    const label = trend[i].date.slice(5); // "MM-DD"
                    return `<text x="${x}" y="${vbH - 4}" text-anchor="middle" fill="var(--color-txt-tertiary)" font-size="7" font-family="inherit">${label}</text>`;
                  })
                  .join("");

                // Baseline axis
                const baseline = `<line x1="${padL}" x2="${vbW - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="var(--color-glass-border)" stroke-width="0.5"/>`;

                return (
                  <div className="flex-1 flex flex-col min-h-0">
                    <svg
                      viewBox={`0 0 ${vbW} ${vbH}`}
                      className="w-full flex-1"
                      style={{ minHeight: "10rem" }}
                      preserveAspectRatio="xMidYMid meet"
                    >
                      <g
                        dangerouslySetInnerHTML={{
                          __html: baseline + gridLines + sessionBars + xLabels,
                        }}
                      />
                      {trend.length > 1 && (
                        <polyline
                          points={hoursPolyline}
                          fill="none"
                          stroke="#f59e0b"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      )}
                      <g dangerouslySetInnerHTML={{ __html: hoursDots }} />
                    </svg>
                    <div className="flex items-center gap-4 mt-1 text-[0.6rem] text-txt-tertiary">
                      <span className="flex items-center gap-1">
                        <span
                          className="inline-block w-2 h-2 rounded-sm"
                          style={{ background: "var(--color-accent)", opacity: 0.7 }}
                        />
                        Sessions
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-3 h-0.5 rounded bg-amber-400" />
                        Hours
                      </span>
                      <span className="ml-auto">
                        {trend[0]?.date} — {trend[trend.length - 1]?.date}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Right column: additional stats + protocol + peak hours */}
          <div className="grid gap-4">
            {/* Duration + Bandwidth cards */}
            <div className="grid grid-cols-2 gap-3">
              <div
                className="rounded-xl px-4 py-3 flex items-center gap-3"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <div style={statIconStyle("#ec4899")}>
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
                    <path d="M5 12h14" />
                    <path d="M12 5l7 7-7 7" />
                  </svg>
                </div>
                <div>
                  <p className="text-[0.55rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                    Avg Duration
                  </p>
                  <p className="text-sm font-bold text-txt-primary">
                    {stats.avg_duration_mins?.toFixed(0) ?? "—"}m
                  </p>
                </div>
              </div>
              <div
                className="rounded-xl px-4 py-3 flex items-center gap-3"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <div style={statIconStyle("#6366f1")}>
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
                    <path d="M12 20V10" />
                    <path d="M18 20V4" />
                    <path d="M6 20v-4" />
                  </svg>
                </div>
                <div>
                  <p className="text-[0.55rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                    Median
                  </p>
                  <p className="text-sm font-bold text-txt-primary">
                    {stats.median_duration_mins?.toFixed(0) ?? "—"}m
                  </p>
                </div>
              </div>
            </div>

            {/* Total Bandwidth (historical) */}
            {stats.total_bandwidth_bytes > 0 && (
              <div
                className="rounded-xl px-4 py-3 flex items-center gap-3"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <div style={statIconStyle("#14b8a6")}>
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
                    <path d="M12 2v20M2 12h20" />
                  </svg>
                </div>
                <div>
                  <p className="text-[0.55rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                    Total Bandwidth (30d)
                  </p>
                  <p className="text-sm font-bold text-txt-primary">
                    {formatBytes(stats.total_bandwidth_bytes)}
                  </p>
                </div>
              </div>
            )}

            {/* Protocol Distribution */}
            {stats.protocol_distribution?.length > 0 && (
              <div
                className="rounded-xl p-4"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <h4 className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold mb-2">
                  Protocol Distribution
                </h4>
                {(() => {
                  const total =
                    stats.protocol_distribution.reduce((s, p) => s + p.sessions, 0) || 1;
                  const colors: Record<string, string> = {
                    rdp: "#3b82f6",
                    ssh: "#22c55e",
                    vnc: "#f59e0b",
                    telnet: "#ef4444",
                  };
                  return (
                    <div className="grid gap-2">
                      {/* Stacked bar */}
                      <div
                        className="flex h-3 rounded-full overflow-hidden"
                        style={{ background: "var(--color-surface-tertiary)" }}
                      >
                        {stats.protocol_distribution.map((p) => (
                          <div
                            key={p.protocol}
                            style={{
                              width: `${(p.sessions / total) * 100}%`,
                              background: colors[p.protocol] || "#8b5cf6",
                            }}
                          />
                        ))}
                      </div>
                      {/* Legend */}
                      <div className="flex flex-wrap gap-3 text-[0.6rem]">
                        {stats.protocol_distribution.map((p) => (
                          <span
                            key={p.protocol}
                            className="flex items-center gap-1 text-txt-secondary"
                          >
                            <span
                              className="inline-block w-2 h-2 rounded-full"
                              style={{ background: colors[p.protocol] || "#8b5cf6" }}
                            />
                            <span className="uppercase font-bold tracking-wider">{p.protocol}</span>
                            <span className="text-txt-tertiary">
                              {p.sessions} ({Math.round((p.sessions / total) * 100)}%)
                            </span>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Peak Hours */}
            {stats.peak_hours?.length > 0 && (
              <div
                className="rounded-xl p-4"
                style={{
                  background: "var(--color-surface-secondary)",
                  border: "1px solid var(--color-glass-border)",
                }}
              >
                <h4 className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold mb-2">
                  Peak Hours
                </h4>
                {(() => {
                  const maxH = Math.max(...stats.peak_hours.map((h) => h.sessions), 1);
                  // Build full 24-hour array
                  const hourMap = new Map(stats.peak_hours.map((h) => [h.hour, h.sessions]));
                  const hours = Array.from({ length: 24 }, (_, i) => hourMap.get(i) || 0);
                  return (
                    <div className="grid gap-1">
                      <div className="flex gap-px items-end h-10">
                        {hours.map((count, i) => {
                          const pct = (count / maxH) * 100;
                          const intensity = count / maxH;
                          return (
                            <div
                              key={i}
                              className="flex-1 rounded-t-sm"
                              style={{
                                height: `${Math.max(pct, 4)}%`,
                                background:
                                  count === 0
                                    ? "var(--color-surface-tertiary)"
                                    : `rgba(59, 130, 246, ${0.2 + intensity * 0.8})`,
                                transition: "height 0.3s ease",
                              }}
                              title={`${i.toString().padStart(2, "0")}:00 — ${count} sessions`}
                            />
                          );
                        })}
                      </div>
                      <div className="flex text-[0.5rem] text-txt-tertiary">
                        <span>00</span>
                        <span className="ml-auto" style={{ marginLeft: `${(6 / 24) * 100 - 2}%` }}>
                          06
                        </span>
                        <span className="ml-auto" style={{ marginLeft: `${(6 / 24) * 100 - 2}%` }}>
                          12
                        </span>
                        <span className="ml-auto" style={{ marginLeft: `${(6 / 24) * 100 - 2}%` }}>
                          18
                        </span>
                        <span className="ml-auto">23</span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Leaderboard Tables */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top Connections */}
        <div
          className="rounded-xl p-5"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <h3 className="text-sm font-bold mb-4" style={{ color: "var(--color-accent)" }}>
            Top Connections
          </h3>
          {!stats || stats.top_connections.length === 0 ? (
            <p className="text-sm text-txt-tertiary text-center py-6">No data yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-txt-tertiary">
                  <th className="text-left pb-2 font-semibold">Name</th>
                  <th className="text-left pb-2 font-semibold">Type</th>
                  <th className="text-right pb-2 font-semibold">Sessions</th>
                  <th className="text-right pb-2 font-semibold">Total Hours</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_connections.map((c) => (
                  <tr key={c.name} className="border-t border-white/5">
                    <td className="py-2 text-txt-primary font-medium">{c.name}</td>
                    <td className="py-2">
                      <span className="uppercase text-[0.6rem] font-bold tracking-wider px-1.5 py-0.5 rounded bg-white/5 text-txt-secondary">
                        {c.protocol}
                      </span>
                    </td>
                    <td className="py-2 text-right text-txt-secondary tabular-nums">
                      {c.sessions}
                    </td>
                    <td className="py-2 text-right text-txt-secondary tabular-nums">
                      {c.total_hours.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Top Users */}
        <div
          className="rounded-xl p-5"
          style={{
            background: "var(--color-surface-secondary)",
            border: "1px solid var(--color-glass-border)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15), inset 0 1px 0 var(--color-glass-highlight)",
          }}
        >
          <h3 className="text-sm font-bold mb-4" style={{ color: "var(--color-accent)" }}>
            Top Users
          </h3>
          {!stats || stats.top_users.length === 0 ? (
            <p className="text-sm text-txt-tertiary text-center py-6">No data yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-txt-tertiary">
                  <th className="text-left pb-2 font-semibold">User</th>
                  <th className="text-right pb-2 font-semibold">Sessions</th>
                  <th className="text-right pb-2 font-semibold">Total Hours</th>
                  <th className="text-right pb-2 font-semibold">Last Session</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_users.map((u) => (
                  <tr key={u.username} className="border-t border-white/5">
                    <td className="py-2 text-txt-primary font-medium">{u.username}</td>
                    <td className="py-2 text-right text-txt-secondary tabular-nums">
                      {u.sessions}
                    </td>
                    <td className="py-2 text-right text-txt-secondary tabular-nums">
                      {u.total_hours.toFixed(1)}
                    </td>
                    <td className="py-2 text-right text-txt-secondary text-[0.65rem]">
                      {u.last_session ? formatDateTime(u.last_session) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* guacd Capacity Gauge */}
      {metrics && <GuacdCapacityGauge metrics={metrics} />}
    </div>
  );
}
