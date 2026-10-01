/* Connections admin as a fleet control plane: posture summary, filters,
   two-tier endpoint table with per-row actions, and a bulk-action dock. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  deleteConnection,
  getActiveSessions,
  getAdSyncConfigs,
  getConnectionRefs,
  getConnectionsPage,
  getFleetSummary,
  moveConnections,
  probeConnection,
  triggerAdSync,
  updateConnection,
  type ActiveSession,
  type AdSyncConfig,
  type AdminConnectionFilters,
  type Connection,
  type ConnectionFolder,
  type ConnectionProbeResult,
  type ConnectionRef,
  type FleetSummary,
  type MeResponse,
} from "../../../api";
import { useOptionalToast } from "../../../components/ToastProvider";
import FleetTelemetryStrip from "./FleetTelemetryStrip";
import FleetToolbar, { UNFILED, type FleetFilters } from "./FleetToolbar";
import FleetTable from "./FleetTable";
import FleetBulkDock from "./FleetBulkDock";
import { buildFleet, computeTelemetry, connectionPayload } from "./fleetModel";
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

const toRef = (c: Connection): ConnectionRef => ({
  id: c.id,
  name: c.name,
  protocol: c.protocol,
  hostname: c.hostname,
  port: c.port,
  folder_id: c.folder_id ?? null,
  url: c.extra?.url ?? null,
});

function serverFilters(f: FleetFilters): AdminConnectionFilters {
  return {
    search: f.search.trim(),
    protocol: f.protocol,
    folder: f.folder === UNFILED ? "unfiled" : f.folder,
    health: f.health as AdminConnectionFilters["health"],
  };
}

export default function FleetManager({
  user,
  folders,
  reloadKey,
  activeFormId,
  hostKeyPanel,
  verifyingHostKeys,
  onVerifyHostKeys,
  onAdd,
  onEdit,
  onDuplicate,
  onDelete,
  requestConfirm,
}: {
  user: MeResponse;
  folders: ConnectionFolder[];
  /** Changed by the parent after it creates, edits or deletes a connection. */
  reloadKey: number;
  activeFormId: string | null;
  hostKeyPanel: ReactNode;
  verifyingHostKeys: boolean;
  onVerifyHostKeys: (ids?: string[]) => void;
  onAdd: () => void;
  onEdit: (c: Connection) => void;
  onDuplicate: (c: Connection) => void;
  onDelete: (id: string) => void;
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
  const [rows, setRows] = useState<Connection[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  /** Bumped after a bulk action so the page and summary are refetched. */
  const [refresh, setRefresh] = useState(0);
  // Keyed by id so a selection can span pages.
  const [selected, setSelected] = useState<Map<string, ConnectionRef>>(() => new Map());
  /** Every connection matching `key`, once select-all has fetched them. */
  const [matching, setMatching] = useState<{ key: string; refs: ConnectionRef[] } | null>(null);
  const [probing, setProbing] = useState<Set<string>>(() => new Set());
  const [probeResults, setProbeResults] = useState<Map<string, ConnectionProbeResult>>(
    () => new Map()
  );
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [adSyncConfigs, setAdSyncConfigs] = useState<AdSyncConfig[]>([]);
  const [busy, setBusy] = useState(false);

  const canSeeSessions = !!(user.can_manage_system || user.can_view_sessions);
  const query = useMemo(() => serverFilters(filters), [filters]);
  const filterKey = `${JSON.stringify(query)}|${reloadKey}|${refresh}`;

  useEffect(() => {
    let cancelled = false;
    getConnectionsPage(page, PAGE_SIZE, query)
      .then((p) => {
        if (cancelled) return;
        setRows(p.items);
        setTotal(p.total);
        setLoaded(true);
        // The page emptied under us (deletes elsewhere): go to the last one.
        if (p.items.length === 0 && p.total > 0) setPage(Math.ceil(p.total / PAGE_SIZE));
      })
      .catch((e) => {
        if (!cancelled)
          toast?.error({ title: "Could not load connections", description: errorText(e, "") });
      });
    return () => {
      cancelled = true;
    };
  }, [page, query, reloadKey, refresh, toast]);

  useEffect(() => {
    let cancelled = false;
    getFleetSummary()
      .then((s) => !cancelled && setSummary(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reloadKey, refresh]);

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

  const fleet = useMemo(() => buildFleet(rows, folders, sessions), [rows, folders, sessions]);
  const telemetry = useMemo(() => computeTelemetry(summary, sessions), [summary, sessions]);
  const protocols = useMemo(
    () => (summary?.protocols ?? []).map((p) => p.protocol).sort(),
    [summary]
  );
  const sessionsPer = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions ?? []) m.set(s.connection_id, (m.get(s.connection_id) ?? 0) + 1);
    return m;
  }, [sessions]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  const selectedRefs = [...selected.values()];
  const matchingRefs = matching?.key === filterKey ? matching.refs : null;
  const pageSelected = rows.length > 0 && rows.every((c) => selected.has(c.id));
  const allSelected =
    total > 0 &&
    (matchingRefs
      ? matchingRefs.every((r) => selected.has(r.id))
      : total === rows.length && pageSelected);
  const someSelected =
    rows.some((c) => selected.has(c.id)) || !!matchingRefs?.some((r) => selected.has(r.id));

  const changeFilters = useCallback((f: FleetFilters) => {
    setFilters(f);
    setPage(1);
  }, []);

  const reloadAll = () => setRefresh((n) => n + 1);

  /** Replace a row on the current page with its updated copy. */
  const patchRow = (c: Connection) => setRows((prev) => prev.map((x) => (x.id === c.id ? c : x)));

  const toggle = (id: string) => {
    const row = rows.find((c) => c.id === id);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else if (row) next.set(id, toRef(row));
      return next;
    });
  };

  /** Select or clear every connection matching the filters, on every page. */
  const toggleAll = async (checked: boolean) => {
    let refs = matchingRefs;
    if (!refs) {
      try {
        refs = await getConnectionRefs(query);
      } catch (e) {
        toast?.error({ title: "Could not select connections", description: errorText(e, "") });
        return;
      }
      setMatching({ key: filterKey, refs });
    }
    const all = refs;
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of all) {
        if (checked) next.set(r.id, r);
        else next.delete(r.id);
      }
      return next;
    });
  };

  const probeOne = async (
    c: Pick<Connection, "id" | "name">
  ): Promise<ConnectionProbeResult | null> => {
    setProbing((p) => new Set(p).add(c.id));
    try {
      const res = await probeConnection(c.id);
      setProbeResults((m) => new Map(m).set(c.id, res));
      setRows((prev) =>
        prev.map((x) =>
          x.id === c.id
            ? { ...x, health_status: res.health_status, health_checked_at: res.health_checked_at }
            : x
        )
      );
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
    await runPool(selectedRefs, PROBE_CONCURRENCY, async (c) => {
      const res = await probeOne(c);
      if (res) done += 1;
      if (res?.health_status === "online") online += 1;
    });
    setBusy(false);
    getFleetSummary()
      .then(setSummary)
      .catch(() => {});
    if (done > 0)
      toast?.info({ title: `Probed ${done}: ${online} reachable, ${done - online} not` });
  };

  const moveSelected = async (folderId: string | null) => {
    setBusy(true);
    const target = folderId ? (folders.find((f) => f.id === folderId)?.name ?? "folder") : "Root";
    try {
      const { moved } = await moveConnections(
        selectedRefs.map((c) => c.id),
        folderId
      );
      if (moved > 0) toast?.success({ title: `Moved ${moved} to ${target}` });
      if (moved < selectedRefs.length)
        toast?.error({ title: `${selectedRefs.length - moved} connections were not moved` });
    } catch (e) {
      toast?.error({ title: "The connections were not moved", description: errorText(e, "") });
    } finally {
      setBusy(false);
      reloadAll();
    }
  };

  const deleteSelected = () => {
    const targets = selectedRefs;
    const live = targets.filter((c) => (sessionsPer.get(c.id) ?? 0) > 0);
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
          } catch (e) {
            failures.push(`${c.name}: ${errorText(e, "failed")}`);
          }
        });
        setBusy(false);
        setSelected(new Map());
        requestConfirm(null);
        reloadAll();
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
          patchRow(await updateConnection(c.id, connectionPayload(c, { extra })));
          getFleetSummary()
            .then(setSummary)
            .catch(() => {});
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

  const sshSelected = selectedRefs.filter((c) => c.protocol === "ssh");
  const fleetTotal = summary?.total ?? total;

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
        canVerifyHostKeys={protocols.includes("ssh")}
        verifyingHostKeys={verifyingHostKeys}
        onVerifyHostKeys={() => onVerifyHostKeys()}
        onAdd={onAdd}
      />

      {hostKeyPanel}

      {loaded && (
        <p className="fleet-count">
          Showing {total === fleetTotal ? total : `${total} of ${fleetTotal}`} connection
          {fleetTotal !== 1 ? "s" : ""}
        </p>
      )}

      {!loaded ? null : total === 0 ? (
        <div className="fleet-empty">
          {fleetTotal === 0
            ? "No connections yet. Add one to start building your fleet."
            : "No connections match these filters."}
        </div>
      ) : (
        <FleetTable
          records={fleet}
          selected={selectedIds}
          allSelected={allSelected}
          someSelected={someSelected}
          onToggle={toggle}
          onToggleAll={(checked) => void toggleAll(checked)}
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

      {selected.size > 0 && (
        <FleetBulkDock
          count={selected.size}
          sshCount={sshSelected.length}
          folders={folders}
          busy={busy}
          onMove={(id) => void moveSelected(id)}
          onProbe={() => void probeSelected()}
          onPinHostKeys={() => onVerifyHostKeys(sshSelected.map((c) => c.id))}
          onDelete={deleteSelected}
          onClear={() => setSelected(new Map())}
        />
      )}
    </div>
  );
}
