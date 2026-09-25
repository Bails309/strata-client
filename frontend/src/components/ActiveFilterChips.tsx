import React from "react";
import { FilterState } from "../hooks/useConnectionFilter";

export interface ActiveFilterChipsProps {
  filters: FilterState;
  setFilter: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
  resetAllFilters: () => void;
  selectedTagName?: string | null;
  className?: string;
}

export const ActiveFilterChips: React.FC<ActiveFilterChipsProps> = ({
  filters,
  setFilter,
  resetAllFilters,
  selectedTagName,
  className = "",
}) => {
  const hasActiveFilters =
    Boolean(filters.favoritesOnly) ||
    Boolean(filters.selectedTag) ||
    (Boolean(filters.selectedProtocol) &&
      filters.selectedProtocol !== "ALL" &&
      filters.selectedProtocol !== "") ||
    Boolean(filters.searchQuery.trim());

  if (!hasActiveFilters) return null;

  return (
    <div className={`flex items-center gap-2 pt-2 flex-wrap ${className}`}>
      <span className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">
        Active:
      </span>
      {filters.favoritesOnly && (
        <button
          type="button"
          onClick={() => setFilter("favoritesOnly", false)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-[#3ACEEF]/10 border border-[#3ACEEF]/30 text-xs text-[#3ACEEF] hover:bg-[#3ACEEF]/20 transition-colors cursor-pointer"
        >
          ★ Favorites <span className="hover:text-white">✕</span>
        </button>
      )}
      {filters.selectedTag && (
        <button
          type="button"
          onClick={() => setFilter("selectedTag", null)}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-[#3ACEEF]/10 border border-[#3ACEEF]/30 text-xs text-[#3ACEEF] hover:bg-[#3ACEEF]/20 transition-colors cursor-pointer"
        >
          🏷️ {selectedTagName || filters.selectedTag} <span className="hover:text-white">✕</span>
        </button>
      )}
      {filters.selectedProtocol &&
        filters.selectedProtocol !== "ALL" &&
        filters.selectedProtocol !== "" && (
          <button
            type="button"
            onClick={() => setFilter("selectedProtocol", "ALL")}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-[#3ACEEF]/10 border border-[#3ACEEF]/30 text-xs text-[#3ACEEF] hover:bg-[#3ACEEF]/20 transition-colors cursor-pointer"
          >
            {filters.selectedProtocol.toUpperCase()} <span className="hover:text-white">✕</span>
          </button>
        )}
      {filters.searchQuery.trim() && (
        <button
          type="button"
          onClick={() => setFilter("searchQuery", "")}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-[#3ACEEF]/10 border border-[#3ACEEF]/30 text-xs text-[#3ACEEF] hover:bg-[#3ACEEF]/20 transition-colors cursor-pointer"
        >
          &quot;{filters.searchQuery}&quot; <span className="hover:text-white">✕</span>
        </button>
      )}
      <button
        type="button"
        onClick={resetAllFilters}
        className="text-xs text-slate-400 hover:text-white underline ml-2 cursor-pointer"
      >
        Reset all
      </button>
    </div>
  );
};

export default ActiveFilterChips;
