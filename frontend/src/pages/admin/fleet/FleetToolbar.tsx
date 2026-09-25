import { useEffect, useState } from "react";
import Select from "../../../components/Select";
import type { AdSyncConfig, ConnectionFolder } from "../../../api";
import { indentedFolderLabel, orderFoldersByHierarchy } from "../../../utils/folderTree";
import FleetMenu from "./FleetMenu";

export interface FleetFilters {
  search: string;
  protocol: string;
  folder: string;
  health: string;
}

export const UNFILED = "__unfiled";

const SEARCH_DEBOUNCE_MS = 250;

export default function FleetToolbar({
  filters,
  onFiltersChange,
  protocols,
  folders,
  adSyncConfigs,
  onSyncDirectory,
  canVerifyHostKeys,
  verifyingHostKeys,
  onVerifyHostKeys,
  onAdd,
}: {
  filters: FleetFilters;
  onFiltersChange: (f: FleetFilters) => void;
  protocols: string[];
  folders: ConnectionFolder[];
  adSyncConfigs: AdSyncConfig[];
  onSyncDirectory: (config: AdSyncConfig) => void;
  canVerifyHostKeys: boolean;
  verifyingHostKeys: boolean;
  onVerifyHostKeys: () => void;
  onAdd: () => void;
}) {
  const [text, setText] = useState(filters.search);

  useEffect(() => {
    if (text === filters.search) return;
    const t = setTimeout(() => onFiltersChange({ ...filters, search: text }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, filters, onFiltersChange]);

  return (
    <div className="fleet-toolbar">
      <div className="fleet-toolbar-row">
        <div className="fleet-search">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search name, host, port, description or folder…"
            aria-label="Search connections"
          />
        </div>
        <div className="fleet-filter">
          <Select
            value={filters.protocol}
            onChange={(protocol) => onFiltersChange({ ...filters, protocol })}
            options={[
              { value: "", label: "Protocol: All" },
              ...protocols.map((p) => ({ value: p, label: p.toUpperCase() })),
            ]}
          />
        </div>
        <div className="fleet-filter fleet-filter-wide">
          <Select
            value={filters.folder}
            onChange={(folder) => onFiltersChange({ ...filters, folder })}
            searchable={folders.length > 8}
            options={[
              { value: "", label: "Folder: All" },
              { value: UNFILED, label: "No folder" },
              ...orderFoldersByHierarchy(folders).map(({ folder, depth }) => ({
                value: folder.id,
                label: indentedFolderLabel(folder.name, depth),
              })),
            ]}
          />
        </div>
        <div className="fleet-filter">
          <Select
            value={filters.health}
            onChange={(health) => onFiltersChange({ ...filters, health })}
            options={[
              { value: "", label: "Health: All" },
              { value: "online", label: "Online" },
              { value: "offline", label: "Offline" },
              { value: "unknown", label: "Not checked" },
            ]}
          />
        </div>
      </div>

      <div className="fleet-toolbar-actions">
        {adSyncConfigs.length > 0 && (
          <FleetMenu
            triggerLabel="Sync AD / LDAP"
            triggerClassName="fleet-btn"
            header="Run a directory sync now"
            items={adSyncConfigs.map((c) => ({
              label: c.label || c.ldap_url,
              hint: c.enabled ? undefined : "This source is disabled",
              disabled: !c.enabled,
              onSelect: () => onSyncDirectory(c),
            }))}
            trigger={
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
                  <polyline points="21 3 21 8 16 8" />
                </svg>
                Sync AD / LDAP
                <span aria-hidden="true">▾</span>
              </>
            }
          />
        )}
        {canVerifyHostKeys && (
          <button
            type="button"
            className="fleet-btn"
            onClick={onVerifyHostKeys}
            disabled={verifyingHostKeys}
            title="Read the host key every SSH target presents and compare it with the pinned key"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            {verifyingHostKeys ? "Checking hosts…" : "Verify Host Keys"}
          </button>
        )}
        <button type="button" className="btn-primary fleet-add" onClick={onAdd}>
          + Add Connection
        </button>
      </div>
    </div>
  );
}
