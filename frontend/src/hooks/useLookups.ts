import { useEffect, useState } from "react";
import {
  getMyConnectionsPage,
  getUserRefs,
  type Connection,
  type MyConnectionFilters,
  type UserRef,
} from "../api";

const DEBOUNCE_MS = 200;

/** Debounced server search; keeps the previous results while the next arrive. */
function useSearch<T>(
  query: string,
  enabled: boolean,
  fetch: (search: string) => Promise<T[]>,
  deps: string
) {
  const search = query.trim();
  const key = `${search}|${deps}`;
  const [state, setState] = useState<{ key: string; items: T[] }>({ key: "", items: [] });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        fetch(search)
          .then((items) => !cancelled && setState({ key, items }))
          .catch(() => !cancelled && setState({ key, items: [] }));
      },
      search ? DEBOUNCE_MS : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `fetch` is rebuilt every render; `deps` stands in for what it closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return { items: state.items, loading: enabled && state.key !== key };
}

/** The first `limit` of the caller's connections matching `query`. */
export function useConnectionSearch(
  query: string,
  enabled: boolean,
  limit = 50,
  filters: MyConnectionFilters = {}
) {
  return useSearch<Connection>(
    query,
    enabled,
    (search) => getMyConnectionsPage(1, limit, { ...filters, search }).then((p) => p.items),
    `${limit}|${JSON.stringify(filters)}`
  );
}

/** Live users matching `query`, for pickers. */
export function useUserSearch(query: string, enabled: boolean, limit = 20) {
  return useSearch<UserRef>(
    query,
    enabled,
    (search) => getUserRefs({ search, limit }),
    String(limit)
  );
}

/** Users named by `ids`, fetched as new ids appear. Unresolved ids are absent. */
export function useUserNames(ids: readonly (string | null | undefined)[]) {
  const [known, setKnown] = useState<Map<string, UserRef>>(() => new Map());
  const missing = [...new Set(ids.filter((id): id is string => !!id && !known.has(id)))].sort();
  const key = missing.join(",");
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const all = key.split(",");
    const chunks: string[][] = [];
    for (let i = 0; i < all.length; i += 200) chunks.push(all.slice(i, i + 200));
    Promise.all(chunks.map((c) => getUserRefs({ ids: c })))
      .then((lists) => {
        if (cancelled) return;
        setKnown((prev) => {
          const next = new Map(prev);
          for (const u of lists.flat()) next.set(u.id, u);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key]);
  return known;
}
