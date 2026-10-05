import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getMyConnectionFacets,
  getMyConnectionsByIds,
  getMyConnectionsPage,
  type Connection,
  type ConnectionFacets,
  type MyConnectionFilters,
  type Page,
} from "../api";

/** Connections fetched per folder before "Show more". */
export const FOLDER_PAGE_SIZE = 200;
/** Tree id of the bucket for connections in no folder. */
export const UNGROUPED = "__ungrouped";
const RECENT_COUNT = 5;
/** How often on-screen rows re-read reachability; the server re-probes every 120 s. */
export const HEALTH_REFRESH_MS = 30_000;

type Health = Pick<Connection, "health_status" | "health_checked_at">;

/** `items` with fresh reachability applied; the same array if nothing changed. */
function patchHealth(items: Connection[], fresh: Map<string, Health>): Connection[] {
  let changed = false;
  const next = items.map((c) => {
    const h = fresh.get(c.id);
    if (!h || (h.health_status === c.health_status && h.health_checked_at === c.health_checked_at))
      return c;
    changed = true;
    return { ...c, ...h };
  });
  return changed ? next : items;
}

export interface FolderRows {
  items: Connection[];
  /** Matching connections filed directly in the folder. */
  total: number;
  /** Continuation for "Show more"; absent once everything is loaded. */
  next?: string;
}

interface Options {
  filters: MyConnectionFilters;
  folderView: boolean;
  page: number;
  pageSize: number;
}

const NO_ROWS: Record<string, FolderRows> = {};

/**
 * The dashboard's connections, fetched a page or a folder at a time.
 * Counts come from the facets endpoint, so nothing here needs every
 * connection the user can open.
 */
export default function useDashboardConnections({ filters, folderView, page, pageSize }: Options) {
  const [version, setVersion] = useState(0);
  const key = `${JSON.stringify(filters)}|${version}`;
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  const [facets, setFacets] = useState<ConnectionFacets | null>(null);
  const [pageRows, setPageRows] = useState<Page<Connection> | null>(null);
  const [folderRows, setFolderRows] = useState<{ key: string; rows: Record<string, FolderRows> }>({
    key: "",
    rows: {},
  });
  const [recents, setRecents] = useState<Connection[]>([]);
  const inflight = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    getMyConnectionFacets(filters)
      .then((f) => !cancelled && setFacets(f))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filters, version]);

  useEffect(() => {
    if (folderView) return;
    let cancelled = false;
    getMyConnectionsPage(page, pageSize, filters)
      .then((p) => !cancelled && setPageRows(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filters, folderView, page, pageSize, version]);

  useEffect(() => {
    let cancelled = false;
    getMyConnectionsPage(1, RECENT_COUNT, { sort: "recent" })
      .then((p) => !cancelled && setRecents(p.items))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [version]);

  const rowsNow = useMemo(
    () => (folderRows.key === key ? folderRows.rows : NO_ROWS),
    [folderRows, key]
  );

  const fetchFolder = useCallback(
    (id: string, after?: string) => {
      const requestKey = key;
      const tag = `${requestKey}|${id}|${after ?? ""}`;
      if (inflight.current.has(tag)) return;
      inflight.current.add(tag);
      getMyConnectionsPage(1, FOLDER_PAGE_SIZE, {
        ...filters,
        folder: id === UNGROUPED ? "none" : id,
        after,
      })
        .then((p) =>
          setFolderRows((prev) => {
            // A response for filters that have since changed is dropped.
            if (requestKey !== keyRef.current) return prev;
            const rows = prev.key === requestKey ? { ...prev.rows } : {};
            const before = after ? (rows[id]?.items ?? []) : [];
            rows[id] = { items: [...before, ...p.items], total: p.total, next: p.next };
            return { key: requestKey, rows };
          })
        )
        .catch(() => {})
        .finally(() => inflight.current.delete(tag));
    },
    [filters, key]
  );

  /** Fetch the first page of each folder in `ids` not loaded yet. */
  const ensureFolders = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        if (!rowsNow[id]) fetchFolder(id);
      }
    },
    [rowsNow, fetchFolder]
  );

  const loadMore = useCallback(
    (id: string) => {
      const next = rowsNow[id]?.next;
      if (next) fetchFolder(id, next);
    },
    [rowsNow, fetchFolder]
  );

  /** Every row currently loaded, for actions that start from an id. */
  const rowsById = useMemo(() => {
    const m = new Map<string, Connection>();
    for (const c of recents) m.set(c.id, c);
    for (const c of pageRows?.items ?? []) m.set(c.id, c);
    for (const f of Object.values(rowsNow)) for (const c of f.items) m.set(c.id, c);
    return m;
  }, [recents, pageRows, rowsNow]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Reachability changes under a page that stays open. Patch the status of the
  // loaded rows in place rather than reloading, which would collapse folders.
  const loadedIds = useRef<string[]>([]);
  useEffect(() => {
    loadedIds.current = [...rowsById.keys()];
  }, [rowsById]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (document.visibilityState === "hidden" || loadedIds.current.length === 0) return;
      getMyConnectionsByIds(loadedIds.current)
        .then((rows) => {
          if (cancelled) return;
          const fresh = new Map<string, Health>(
            rows.map((c) => [
              c.id,
              { health_status: c.health_status, health_checked_at: c.health_checked_at },
            ])
          );
          setPageRows((p) => {
            if (!p) return p;
            const items = patchHealth(p.items, fresh);
            return items === p.items ? p : { ...p, items };
          });
          setRecents((r) => patchHealth(r, fresh));
          setFolderRows((prev) => {
            let changed = false;
            const rows: Record<string, FolderRows> = {};
            for (const [id, f] of Object.entries(prev.rows)) {
              const items = patchHealth(f.items, fresh);
              if (items !== f.items) changed = true;
              rows[id] = items === f.items ? f : { ...f, items };
            }
            return changed ? { ...prev, rows } : prev;
          });
        })
        .catch(() => {});
    };
    const timer = setInterval(refresh, HEALTH_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return {
    facets,
    pageRows,
    folderRows: rowsNow,
    recents,
    rowsById,
    ensureFolders,
    loadMore,
    reload,
  };
}
