import { useMemo, useState, useCallback } from "react";

export interface FilterState {
  searchQuery: string;
  favoritesOnly: boolean;
  selectedTag: string | null;
  selectedProtocol: string;
}

export interface ConnectionFilterItem {
  id: string;
  name: string;
  protocol: string;
  hostname?: string;
  description?: string;
  isFavorite?: boolean;
  tags?: string[];
  [key: string]: any;
}

export interface UseConnectionFilterReturn<T> {
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  setFilter: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
  resetAllFilters: () => void;
  clearScope: () => void;
  filteredConnections: T[];
  globalSearchMatches: T[];
}

export const initialFilterState: FilterState = {
  searchQuery: "",
  favoritesOnly: false,
  selectedTag: null,
  selectedProtocol: "ALL",
};

export function useConnectionFilter<T extends ConnectionFilterItem>(
  connections: T[],
  filtersOrInitial?: FilterState | Partial<FilterState>,
  controlledSetFilters?: React.Dispatch<React.SetStateAction<FilterState>>
): UseConnectionFilterReturn<T> {
  const isControlled = controlledSetFilters !== undefined;

  const [internalFilters, setInternalFilters] = useState<FilterState>({
    searchQuery: filtersOrInitial?.searchQuery ?? "",
    favoritesOnly: filtersOrInitial?.favoritesOnly ?? false,
    selectedTag: filtersOrInitial?.selectedTag ?? null,
    selectedProtocol: filtersOrInitial?.selectedProtocol ?? "ALL",
  });

  const filters: FilterState = isControlled
    ? (filtersOrInitial as FilterState)
    : internalFilters;

  const setFilters = isControlled ? controlledSetFilters : setInternalFilters;

  const setFilter = useCallback(
    <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value }));
    },
    [setFilters]
  );

  const resetAllFilters = useCallback(() => {
    setFilters({
      searchQuery: "",
      favoritesOnly: false,
      selectedTag: null,
      selectedProtocol: "ALL",
    });
  }, [setFilters]);

  const clearScope = useCallback(() => {
    setFilters((prev) => ({
      ...prev,
      favoritesOnly: false,
      selectedTag: null,
    }));
  }, [setFilters]);

  const filteredConnections = useMemo(() => {
    return connections.filter((conn) => {
      const q = filters.searchQuery ? filters.searchQuery.toLowerCase() : "";
      const matchesSearch =
        !filters.searchQuery ||
        conn.name.toLowerCase().includes(q) ||
        (conn.hostname && conn.hostname.toLowerCase().includes(q)) ||
        (conn.description && conn.description.toLowerCase().includes(q));

      const matchesFav = !filters.favoritesOnly || Boolean(conn.isFavorite);

      const matchesTag =
        !filters.selectedTag ||
        (Array.isArray(conn.tags) && conn.tags.includes(filters.selectedTag));

      const matchesProto =
        !filters.selectedProtocol ||
        filters.selectedProtocol === "ALL" ||
        filters.selectedProtocol === "" ||
        conn.protocol.toLowerCase() === filters.selectedProtocol.toLowerCase();

      return matchesSearch && matchesFav && matchesTag && matchesProto;
    });
  }, [connections, filters]);

  // Unscoped search: evaluate matches ignoring favorites and tag restrictions
  const globalSearchMatches = useMemo(() => {
    if (!filters.searchQuery.trim()) return [];
    const q = filters.searchQuery.toLowerCase();
    return connections.filter(
      (conn) =>
        conn.name.toLowerCase().includes(q) ||
        (conn.hostname && conn.hostname.toLowerCase().includes(q)) ||
        (conn.description && conn.description.toLowerCase().includes(q))
    );
  }, [connections, filters.searchQuery]);

  return {
    filters,
    setFilters,
    setFilter,
    resetAllFilters,
    clearScope,
    filteredConnections,
    globalSearchMatches,
  };
}

export default useConnectionFilter;
