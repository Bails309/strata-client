import type { FleetTelemetry } from "./fleetModel";
import { formatAgo } from "./fleetModel";

function Card({
  label,
  value,
  tone,
  detail,
  title,
}: {
  label: string;
  value: string;
  tone: "white" | "emerald" | "amber" | "cyan" | "teal" | "muted";
  detail: string;
  title?: string;
}) {
  return (
    <div className="fleet-kpi" title={title}>
      <span className="fleet-kpi-label">{label}</span>
      <div className="fleet-kpi-body">
        <span className={`fleet-kpi-value fleet-tone-${tone}`}>{value}</span>
        <span className="fleet-kpi-detail">{detail}</span>
      </div>
    </div>
  );
}

export default function FleetTelemetryStrip({ t }: { t: FleetTelemetry }) {
  return (
    <div className="fleet-kpis" role="group" aria-label="Fleet summary">
      <Card
        label="Total Endpoints"
        value={String(t.total)}
        tone="white"
        detail={t.protocolSummary || "No connections yet"}
      />
      <Card
        label="Fleet Reachability"
        value={t.reachability === null ? "—" : `${t.reachability}%`}
        tone={t.reachability === null ? "muted" : t.offline > 0 ? "amber" : "emerald"}
        detail={`${t.online} / ${t.total} online${t.unknown > 0 ? ` · ${t.unknown} unchecked` : ""}`}
        title="From the last TCP health check of each target"
      />
      <Card
        label="Security Alerts"
        value={String(t.alertCount)}
        tone={t.alertCount > 0 ? "amber" : "emerald"}
        detail={t.alertSummary || "No posture issues"}
        title="Unpinned SSH host keys, disabled certificate checks and legacy RDP security"
      />
      <Card
        label="Active Sessions"
        value={t.sessions === null ? "—" : String(t.sessions)}
        tone={t.sessions ? "cyan" : "muted"}
        detail={
          t.liveUsers === null
            ? "Session data unavailable"
            : `${t.liveUsers} live ${t.liveUsers === 1 ? "user" : "users"}`
        }
      />
      <Card
        label="Last Health Sweep"
        value={t.lastSweep === null ? "—" : formatAgo(t.lastSweep)}
        tone="teal"
        detail="Automatic every 2 min"
        title={t.lastSweep === null ? undefined : new Date(t.lastSweep).toLocaleString()}
      />
    </div>
  );
}
