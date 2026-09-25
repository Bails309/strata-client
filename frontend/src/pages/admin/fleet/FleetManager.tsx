/* Connections admin as a fleet control plane: posture summary, filters,
   two-tier endpoint table with per-row actions, and a bulk-action dock. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  deleteConnection,
  getActiveSessions,
  getAdSyncConfigs,
  probeConnection,
  triggerAdSync,
  updateConnection,
  type ActiveSession,
  type AdSyncConfig,
  type Connection,
  type ConnectionFolder,
  type ConnectionProbeResult,
  type MeResponse,
} from "../../../api";
import { useOptionalToast } from "../../../components/ToastProvider";
import FleetTelemetryStrip from "./FleetTelemetryStrip";
import FleetToolbar, { UNFILED, type FleetFilters } from "./FleetToolbar";
import FleetTable from "./FleetTable";
import FleetBulkDock from "./FleetBulkDock";
import { buildFleet, computeTelemetry, connectionPayload, folderSubtree } from "./fleetModel";
import "./Fleet.css";

const PAGE_SIZE = 20;
const SESSION_POLL_MS = 30_000;
const PROBE_CONCURRENCY = 4;

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  isDangerous?: boolean;
  onConfirm: () => Promise<void> | void;
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export default function FleetManager({
  user,
  connections,
  folders,
  activeFormId,
  hostKeyPanel,
  verifyingHostKeys,
  onVerifyHostKeys,
  onAdd,
  onEdit,
  onDuplicate,
  onDelete,
  onConnectionUpdated,
  onConnectionDeleted,
  requestConfirm,
}: {
  user: MeResponse;
  connections: Connection[];
  folders: ConnectionFolder[];
  activeFormId: string | null;
  hostKeyPanel: ReactNode;
  verifyingHostKeys: boolean;
  onVerifyHostKeys: (ids?: string[]) => void;
  onAdd: () => void;
  onEdit: (c: Connection) => void;
  onDuplicate: (c: Connection) => void;
  onDelete: (id: string) => void;
  onConnectionUpdated: (c: Connection) => void;
  onConnectionDeleted: (id: string) => void;
  requestConfirm: (req: ConfirmRequest | null) => void;
}) {
  const toast = useOptionalToast();
  const [filters, setFilters] = useState<FleetFilters>({
    search: "",
    protocol: "",
    folder: "",
    health: "",
  });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [probing, setProbing] = useState<Set<string>>(() => new Set());
  const [probeResults, setProbeResults] = useState<Map<string, ConnectionProbeResult>>(
    () => new Map()
  );
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [adSyncConfigs, setAdSyncConfigs] = useState<AdSyncConfig[]>([]);
  const [busy, setBusy] = useState(false);

  const canSeeSessions = !!(user.can_manage_system || user.can_view_sessions);

  useEffect(() => {
    if (!canSeeSessions) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const rows = await getActiveSessions();
        if (cancelled) return;
        setSessions(rows);
        timer = setTimeout(load, SESSION_POLL_MS);
      } catch {
        if (!cancelled) setSessions(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canSeeSessions]);

  useEffect(() => {
    if (!user.can_manage_system) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => getAdSyncConfigs())
      .then((rows) => !cancelled && setAdSyncConfigs(rows ?? []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user.can_manage_system]);

  const fleet = useMemo(
    () => buildFleet(connections, folders, sessions),
    [connections, folders, sessions]
  );
  const telemetry = useMemo(() => computeTelemetry(fleet, sessions), [fleet, sessions]);
  const protocols = useMemo(
    () => [...new Set(connections.map((c) => c.protocol))].sort(),
    [connections]
  );

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const inFolder =
      filters.folder && filters.folder !== UNFILED ? folderSubtree(folders, filters.folder) : null;
    return fleet.filter((r) => {
      const c = r.conn;
      if (filters.protocol && c.protocol !== filters.protocol) return false;
      if (filters.health && r.health !== filters.health) return false;
      if (filters.folder === UNFILED && c.folder_id) return false;
      if (inFolder && !(c.folder_id && inFolder.has(c.folder_id))) return false;
      if (!q) return true;
      return [
        c.name,
        c.hostname,
        String(c.port),
        c.description ?? "",
        r.folderName ?? "",
        c.protocol,
      ]
        .join("\n")
        .toLowerCase()
        .includes(q);
    });
  }, [fleet, filters, folders]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Drop ids that no longer exist (deleted elsewhere).
  const liveSelected = useMemo(() => {
    const ids = new Set(connections.map((c) => c.id));
    return new Set([...selected].filter((id) => ids.has(id)));
  }, [selected, connections]);
  const selectedConns = connections.filter((c) => liveSelected.has(c.id));
  const allSelected = filtered.length > 0 && filtered.every((r) => liveSelected.has(r.conn.id));
  const someSelected = filtered.some((r) => liveSelected.has(r.conn.id));

  const changeFilters = useCallback((f: FleetFilters) => {
    setFilters(f);
    setPage(1);
  }, []);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of filtered) {
        if (checked) next.add(r.conn.id);
        else next.delete(r.conn.id);
      }
      return next;
    });

  const probeOne = async (c: Connection): Promise<ConnectionProbeResult | null> => {
    setProbing((p) => new Set(p).add(c.id));
    try {
      const res = await probeConnection(c.id);
      setProbeResults((m) => new Map(m).set(c.id, res));
      onConnectionUpdated({
        ...c,
        health_status: res.health_status,
        health_checked_at: res.health_checked_at,
      });
      return res;
    } catch (e) {
      toast?.error({ title: `Probe failed for ${c.name}`, description: errorText(e, "") });
      return null;
    } finally {
      setProbing((p) => {
        const next = new Set(p);
        next.delete(c.id);
        return next;
      });
    }
  };

  const probeSelected = async () => {
    setBusy(true);
    let online = 0;
    let done = 0;
    await runPool(selectedConns, PROBE_CONCURRENCY, async (c) => {
      const res = await probeOne(c);
      if (res) done += 1;
      if (res?.health_status === "online") online += 1;
    });
    setBusy(false);
    if (done > 0)
      toast?.info({ title: `Probed ${done}: ${online} reachable, ${done - online} not` });
  };

  const moveSelected = async (folderId: string | null) => {
    setBusy(true);
    const failures: string[] = [];
    await runPool(selectedConns, PROBE_CONCURRENCY, async (c) => {
      try {
        const updated = await updateConnection(
          c.id,
          connectionPayload(c, { folder_id: folderId ?? undefined })
        );
        onConnectionUpdated(updated);
      } catch (e) {
        failures.push(`${c.name}: ${errorText(e, "failed")}`);
      }
    });
    setBusy(false);
    const target = folderId ? (folders.find((f) => f.id === folderId)?.name ?? "folder") : "Root";
    const moved = selectedConns.length - failures.length;
    if (moved > 0) toast?.success({ title: `Moved ${moved} to ${target}` });
    if (failures.length > 0)
      toast?.error({ title: "Some connections were not moved", description: failures.join("; ") });
  };

  const deleteSelected = () => {
    const targets = selectedConns;
    const live = fleet.filter((r) => liveSelected.has(r.conn.id) && r.sessions > 0);
    requestConfirm({
      title: `Delete ${targets.length} ${targets.length === 1 ? "connection" : "connections"}`,
      message:
        (live.length > 0
          ? `${live.length} of them ${live.length === 1 ? "has" : "have"} active sessions right now. `
          : "") + "Deleting removes them for every user and role. This action cannot be undone.",
      confirmLabel: "Delete",
      isDangerous: true,
      onConfirm: async () => {
        setBusy(true);
        const failures: string[] = [];
        await runPool(targets, PROBE_CONCURRENCY, async (c) => {
          try {
            await deleteConnection(c.id);
            onConnectionDeleted(c.id);
          } catch (e) {
            failures.push(`${c.name}: ${errorText(e, "failed")}`);
          }
        });
        setBusy(false);
        setSelected(new Set());
        requestConfirm(null);
        if (failures.length > 0)
          toast?.error({
            title: "Some connections were not deleted",
            description: failures.join("; "),
          });
      },
    });
  };

  const clearHostKey = (c: Connection) =>
    requestConfirm({
      title: "Clear pinned host key",
      message: `Sessions to ${c.name} will be refused until a new host key is pinned. Continue?`,
      confirmLabel: "Clear key",
      isDangerous: true,
      onConfirm: async () => {
        try {
          const extra = { ...(c.extra ?? {}) };
          delete extra["host-key"];
          onConnectionUpdated(await updateConnection(c.id, connectionPayload(c, { extra })));
        } catch (e) {
          toast?.error({ title: "Could not clear the host key", description: errorText(e, "") });
        } finally {
          requestConfirm(null);
        }
      },
    });

  const syncDirectory = async (config: AdSyncConfig) => {
    try {
      await triggerAdSync(config.id);
      toast?.success({
        title: `Directory sync started: ${config.label || config.ldap_url}`,
        description: "New and changed connections appear here when the run completes.",
      });
    } catch (e) {
      toast?.error({ title: "Directory sync failed to start", description: errorText(e, "") });
    }
  };

  const sshSelected = selectedConns.filter((c) => c.protocol === "ssh");

  return (
    <div className="card fleet-card">
      <div className="fleet-header">
        <div>
          <span className="fleet-eyebrow">Fleet Management</span>
          <h2 className="!mb-0">Connections</h2>
          <p className="fleet-subtitle">
            Target infrastructure, access posture and live load across every gateway endpoint.
          </p>
        </div>
      </div>

      <FleetTelemetryStrip t={telemetry} />

      <FleetToolbar
        filters={filters}
        onFiltersChange={changeFilters}
        protocols={protocols}
        folders={folders}
        adSyncConfigs={adSyncConfigs}
        onSyncDirectory={syncDirectory}
        canVerifyHostKeys={connections.some((c) => c.protocol === "ssh")}
        verifyingHostKeys={verifyingHostKeys}
        onVerifyHostKeys={() => onVerifyHostKeys()}
        onAdd={onAdd}
      />

      {hostKeyPanel}

      <p className="fleet-count">
        Showing{" "}
        {filtered.length === connections.length
          ? connections.length
          : `${filtered.length} of ${connections.length}`}{" "}
        connection{connections.length !== 1 ? "s" : ""}
      </p>

      {filtered.length === 0 ? (
        <div className="fleet-empty">
          {connections.length === 0
            ? "No connections yet. Add one to start building your fleet."
            : "No connections match these filters."}
        </div>
      ) : (
        <FleetTable
          records={paged}
          selected={liveSelected}
          allSelected={allSelected}
          someSelected={someSelected}
          onToggle={toggle}
          onToggleAll={toggleAll}
          probing={probing}
          probeResults={probeResults}
          activeFormId={activeFormId}
          sessionsKnown={sessions !== null}
          actions={{
            onEdit,
            onProbe: (c) => void probeOne(c),
            onDuplicate,
            onClearHostKey: clearHostKey,
            onDelete: (c) => onDelete(c.id),
          }}
        />
      )}

      {totalPages > 1 && (
        <div className="fleet-pager">
          <span>
            Page {safePage} of {totalPages}
          </span>
          <div>
            <button
              type="button"
              className="fleet-btn fleet-btn-sm"
              disabled={safePage === 1}
              onClick={() => setPage(safePage - 1)}
            >
              ← Prev
            </button>
            <button
              type="button"
              className="fleet-btn fleet-btn-sm"
              disabled={safePage === totalPages}
              onClick={() => setPage(safePage + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {liveSelected.size > 0 && (
        <FleetBulkDock
          count={liveSelected.size}
          sshCount={sshSelected.length}
          folders={folders}
          busy={busy}
          onMove={(id) => void moveSelected(id)}
          onProbe={() => void probeSelected()}
          onPinHostKeys={() => onVerifyHostKeys(sshSelected.map((c) => c.id))}
          onDelete={deleteSelected}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}
