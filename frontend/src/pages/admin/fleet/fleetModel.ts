/* Derived, display-ready view of the connection fleet. Everything here is
   computed from data the backend already returns — no invented metrics. */
import type { ActiveSession, Connection, ConnectionFolder } from "../../../api";

export type Health = "online" | "offline" | "unknown";

export type Tone = "cyan" | "emerald" | "slate" | "amber" | "blue" | "violet";

export interface PolicyBadge {
  key: string;
  label: string;
  tone: Tone;
  title: string;
  /** Counts towards the Security Alerts card. */
  alert?: boolean;
}

export interface FleetRecord {
  conn: Connection;
  health: Health;
  policies: PolicyBadge[];
  sessions: number;
  folderName: string | null;
}

const flag = (c: Connection, key: string) => c.extra?.[key] === "true";

export function policiesFor(c: Connection): PolicyBadge[] {
  const out: PolicyBadge[] = [];
  const security = c.extra?.["security"];
  if (c.protocol === "rdp" || c.protocol === "vdi") {
    if (security === "nla" || security === "nla-ext") {
      out.push({
        key: "nla",
        label: "NLA",
        tone: "emerald",
        title: "Network Level Authentication required",
      });
    } else if (security === "rdp") {
      out.push({
        key: "legacy-sec",
        label: "Legacy Sec",
        tone: "amber",
        title: "Standard RDP security (no TLS/NLA)",
        alert: true,
      });
    }
    if (c.extra?.["auth-pkg"] === "kerberos") {
      out.push({
        key: "kerberos",
        label: "Kerberos",
        tone: "slate",
        title: "Kerberos-only authentication",
      });
    }
  }
  if (c.protocol === "ssh") {
    if (c.extra?.["host-key"]) {
      out.push({ key: "hostkey", label: "HostKey", tone: "emerald", title: "SSH host key pinned" });
    } else {
      out.push({
        key: "unpinned",
        label: "Unpinned",
        tone: "amber",
        title: "No SSH host key pinned — the target is not authenticated",
        alert: true,
      });
    }
  }
  if (flag(c, "ignore-cert")) {
    out.push({
      key: "cert",
      label: "Cert Ignored",
      tone: "amber",
      title: "Server certificate validation is disabled",
      alert: true,
    });
  }
  if (flag(c, "read-only")) {
    out.push({
      key: "ro",
      label: "Read-only",
      tone: "blue",
      title: "Input is not sent to the target",
    });
  }
  const noCopy = flag(c, "disable-copy");
  const noPaste = flag(c, "disable-paste");
  if (noCopy || noPaste) {
    out.push({
      key: "clip",
      label: noCopy && noPaste ? "Clip Locked" : noCopy ? "No Copy" : "No Paste",
      tone: "violet",
      title: "Clipboard transfer restricted",
    });
  }
  return out;
}

export function toHealth(status: Connection["health_status"]): Health {
  return status === "online" || status === "offline" ? status : "unknown";
}

export function buildFleet(
  connections: Connection[],
  folders: ConnectionFolder[],
  sessions: ActiveSession[] | null
): FleetRecord[] {
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const perConn = new Map<string, number>();
  for (const s of sessions ?? [])
    perConn.set(s.connection_id, (perConn.get(s.connection_id) ?? 0) + 1);
  return connections.map((conn) => ({
    conn,
    health: toHealth(conn.health_status),
    policies: policiesFor(conn),
    sessions: perConn.get(conn.id) ?? 0,
    folderName: conn.folder_id ? (folderName.get(conn.folder_id) ?? null) : null,
  }));
}

export interface FleetTelemetry {
  total: number;
  protocolSummary: string;
  online: number;
  offline: number;
  unknown: number;
  /** Online share of the targets that have been checked; null if none were. */
  reachability: number | null;
  alertCount: number;
  alertSummary: string;
  sessions: number | null;
  liveUsers: number | null;
  lastSweep: number | null;
}

const countBy = <T>(items: T[], key: (t: T) => string) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

export function computeTelemetry(
  records: FleetRecord[],
  sessions: ActiveSession[] | null
): FleetTelemetry {
  const online = records.filter((r) => r.health === "online").length;
  const offline = records.filter((r) => r.health === "offline").length;
  const alerts = records.flatMap((r) => r.policies.filter((p) => p.alert));
  const lastSweep = records.reduce<number | null>((max, r) => {
    const t = r.conn.health_checked_at ? Date.parse(r.conn.health_checked_at) : NaN;
    return Number.isFinite(t) && (max === null || t > max) ? t : max;
  }, null);
  return {
    total: records.length,
    protocolSummary: countBy(records, (r) => r.conn.protocol.toUpperCase())
      .map(([p, n]) => `${n} ${p}`)
      .join(" · "),
    online,
    offline,
    unknown: records.length - online - offline,
    reachability: online + offline > 0 ? Math.round((online / (online + offline)) * 100) : null,
    alertCount: records.filter((r) => r.policies.some((p) => p.alert)).length,
    alertSummary: countBy(alerts, (a) => a.label)
      .map(([label, n]) => `${n} ${label}`)
      .join(" · "),
    sessions: sessions ? sessions.length : null,
    liveUsers: sessions ? new Set(sessions.map((s) => s.user_id)).size : null,
    lastSweep,
  };
}

/** Update payload that preserves every field of `c` except the overrides. */
export function connectionPayload(
  c: Connection,
  overrides: Partial<Omit<Connection, "id">> = {}
): Omit<Connection, "id"> {
  return {
    name: c.name,
    protocol: c.protocol,
    hostname: c.hostname,
    port: c.port,
    domain: c.domain,
    description: c.description,
    folder_id: c.folder_id || undefined,
    extra: c.extra ?? {},
    watermark: c.watermark,
    ...overrides,
  };
}

/** Folder ids that are `rootId` or any of its descendants. */
export function folderSubtree(folders: ConnectionFolder[], rootId: string): Set<string> {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

export function formatAgo(ms: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
