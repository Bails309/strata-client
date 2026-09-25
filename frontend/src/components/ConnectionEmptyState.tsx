import React from "react";
import { FilterState } from "../hooks/useConnectionFilter";

export interface ConnectionEmptyStateProps {
  filters: FilterState;
  filteredCount?: number;
  globalCount: number;
  onClearScope: () => void;
  onResetAll: () => void;
  totalConnections?: number;
}

export const ConnectionEmptyState: React.FC<ConnectionEmptyStateProps> = ({
  filters,
  globalCount,
  onClearScope,
  onResetAll,
  totalConnections,
}) => {
  if (totalConnections === 0) {
    return (
      <div className="py-12 text-center text-xs text-slate-500 text-txt-tertiary">
        No connections available. Ask your administrator to assign connections to your role.
      </div>
    );
  }

  const isConstrained =
    Boolean(filters.favoritesOnly || filters.selectedTag) && Boolean(filters.searchQuery);

  if (isConstrained && globalCount > 0) {
    return (
      <div className="py-12 text-center">
        <h4 className="text-sm font-semibold text-white">No matches in current filter</h4>
        <p className="text-xs text-slate-400 mt-1">
          Found{" "}
          <span className="text-[#3ACEEF] font-medium">
            {globalCount} connection{globalCount > 1 ? "s" : ""}
          </span>{" "}
          matching &quot;{filters.searchQuery}&quot; outside your active scope.
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <button
            type="button"
            onClick={onClearScope}
            className="px-3.5 py-1.5 rounded-[4px] bg-[#3ACEEF] text-[#070B12] text-xs font-semibold hover:bg-[#45F6CE] shadow-[0_0_12px_rgba(58,206,239,0.3)] transition-all cursor-pointer"
          >
            Show all {globalCount} results
          </button>
          <button
            type="button"
            onClick={onResetAll}
            className="px-3.5 py-1.5 rounded-[4px] border border-white/[0.08] text-xs text-slate-300 hover:bg-white/[0.06] transition-all cursor-pointer"
          >
            Clear all filters
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="py-12 text-center text-xs text-slate-500">
      No connections found matching your query.
    </div>
  );
};

export default ConnectionEmptyState;
