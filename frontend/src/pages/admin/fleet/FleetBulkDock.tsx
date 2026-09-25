import type { ConnectionFolder } from "../../../api";
import { indentedFolderLabel, orderFoldersByHierarchy } from "../../../utils/folderTree";
import FleetMenu from "./FleetMenu";

export default function FleetBulkDock({
  count,
  sshCount,
  folders,
  busy,
  onMove,
  onProbe,
  onPinHostKeys,
  onDelete,
  onClear,
}: {
  count: number;
  sshCount: number;
  folders: ConnectionFolder[];
  busy: boolean;
  onMove: (folderId: string | null) => void;
  onProbe: () => void;
  onPinHostKeys: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="fleet-dock" role="region" aria-label="Bulk actions">
      <div className="fleet-dock-left">
        <span className="fleet-dock-count">
          <span className="fleet-dock-num">{count}</span>
          {count === 1 ? "Endpoint" : "Endpoints"} Selected
        </span>
        <span className="fleet-dock-sep" aria-hidden="true" />
        <FleetMenu
          triggerLabel="Move to folder"
          triggerClassName="fleet-btn fleet-btn-sm"
          align="left"
          disabled={busy}
          header="Move selected to…"
          trigger={
            <>
              Move to Folder <span aria-hidden="true">▾</span>
            </>
          }
          items={[
            { label: "Root (no folder)", onSelect: () => onMove(null) },
            ...orderFoldersByHierarchy(folders).map(({ folder, depth }) => ({
              label: indentedFolderLabel(folder.name, depth),
              onSelect: () => onMove(folder.id),
            })),
          ]}
        />
        <button type="button" className="fleet-btn fleet-btn-sm" onClick={onProbe} disabled={busy}>
          Trigger Probe
        </button>
        <button
          type="button"
          className="fleet-btn fleet-btn-sm"
          onClick={onPinHostKeys}
          disabled={busy || sshCount === 0}
          title={
            sshCount === 0
              ? "Select at least one SSH connection"
              : "Read the host keys of the selected SSH targets for review before pinning"
          }
        >
          Pin Host Keys{sshCount > 0 ? ` (${sshCount})` : ""}
        </button>
      </div>
      <div className="fleet-dock-right">
        <button type="button" className="fleet-btn fleet-btn-sm fleet-btn-ghost" onClick={onClear}>
          Clear
        </button>
        <button
          type="button"
          className="fleet-btn fleet-btn-sm fleet-btn-danger"
          onClick={onDelete}
          disabled={busy}
        >
          Delete Selected
        </button>
      </div>
    </div>
  );
}
