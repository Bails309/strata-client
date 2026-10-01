import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getMyConnectionFacets,
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

export interface FolderRows {
  items: Connection[];
  /** Matching connections filed directly in the folder. */
  total: number;
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
    (id: string, folderPage: number) => {
      const requestKey = key;
      const tag = `${requestKey}|${id}|${folderPage}`;
      if (inflight.current.has(tag)) return;
      inflight.current.add(tag);
      getMyConnectionsPage(folderPage, FOLDER_PAGE_SIZE, {
        ...filters,
        folder: id === UNGROUPED ? "none" : id,
      })
        .then((p) =>
          setFolderRows((prev) => {
            // A response for filters that have since changed is dropped.
            if (requestKey !== keyRef.current) return prev;
            const rows = prev.key === requestKey ? { ...prev.rows } : {};
            const before = folderPage === 1 ? [] : (rows[id]?.items ?? []);
            rows[id] = { items: [...before, ...p.items], total: p.total };
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
        if (!rowsNow[id]) fetchFolder(id, 1);
      }
    },
    [rowsNow, fetchFolder]
  );

  const loadMore = useCallback(
    (id: string) => {
      const loaded = rowsNow[id]?.items.length ?? 0;
      fetchFolder(id, Math.floor(loaded / FOLDER_PAGE_SIZE) + 1);
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
