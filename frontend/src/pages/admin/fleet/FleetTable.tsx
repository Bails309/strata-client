import { useState } from "react";
import { EnterpriseCheckbox } from "../../../components/EnterpriseCheckbox";
import type { Connection, ConnectionProbeResult } from "../../../api";
import type { FleetRecord, Health } from "./fleetModel";
import { formatAgo } from "./fleetModel";
import FleetMenu from "./FleetMenu";

const HEALTH_LABEL: Record<Health, string> = {
  online: "Reachable",
  offline: "Unreachable",
  unknown: "Not checked",
};

function healthText(r: FleetRecord, probe: ConnectionProbeResult | undefined) {
  if (probe && probe.health_status === r.health && probe.latency_ms !== null) {
    return `${probe.latency_ms}ms`;
  }
  return HEALTH_LABEL[r.health];
}

function target(c: Connection) {
  if (c.protocol === "web" && c.extra?.url) return c.extra.url;
  return `${c.hostname}:${c.port}`;
}

function CopyTarget({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="fleet-target"
      title={copied ? "Copied" : "Copy to clipboard"}
      aria-label={`Copy ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <span>{value}</span>
      <span className="fleet-target-icon" aria-hidden="true">
        {copied ? "✓" : "⧉"}
      </span>
    </button>
  );
}

export interface FleetRowActions {
  onEdit: (c: Connection) => void;
  onProbe: (c: Connection) => void;
  onDuplicate: (c: Connection) => void;
  onClearHostKey: (c: Connection) => void;
  onDelete: (c: Connection) => void;
}

export default function FleetTable({
  records,
  selected,
  allSelected,
  someSelected,
  onToggle,
  onToggleAll,
  probing,
  probeResults,
  activeFormId,
  sessionsKnown,
  actions,
}: {
  records: FleetRecord[];
  selected: Set<string>;
  allSelected: boolean;
  someSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  probing: Set<string>;
  probeResults: Map<string, ConnectionProbeResult>;
  activeFormId: string | null;
  sessionsKnown: boolean;
  actions: FleetRowActions;
}) {
  return (
    <div className="fleet-table-wrap">
      <table className="fleet-table">
        <thead>
          <tr>
            <th className="fleet-col-check">
              <EnterpriseCheckbox
                checked={allSelected}
                indeterminate={someSelected && !allSelected}
                onCheckedChange={onToggleAll}
                aria-label="Select all matching connections"
              />
            </th>
            <th>Endpoint &amp; Target</th>
            <th>Protocol</th>
            <th>Probe Health</th>
            <th>Security Policies</th>
            <th>Live Load</th>
            <th>Folder</th>
            <th className="fleet-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const c = r.conn;
            const isSelected = selected.has(c.id);
            const probe = probeResults.get(c.id);
            const isProbing = probing.has(c.id);
            return (
              <tr
                key={c.id}
                className={`${isSelected ? "fleet-row-selected" : ""} ${
                  activeFormId === c.id ? "fleet-row-editing" : ""
                }`}
              >
                <td className="fleet-col-check">
                  <EnterpriseCheckbox
                    checked={isSelected}
                    onCheckedChange={() => onToggle(c.id)}
                    aria-label={`Select ${c.name}`}
                  />
                </td>
                <td>
                  <div className="fleet-name">{c.name}</div>
                  <CopyTarget value={target(c)} />
                  {c.description && <div className="fleet-desc">{c.description}</div>}
                </td>
                <td>
                  <span className={`fleet-proto fleet-proto-${c.protocol}`}>
                    {c.protocol === "kubernetes" ? "K8S" : c.protocol.toUpperCase()}
                  </span>
                </td>
                <td>
                  <span
                    className={`fleet-health fleet-health-${isProbing ? "probing" : r.health}`}
                    title={
                      c.health_checked_at
                        ? `Checked ${formatAgo(Date.parse(c.health_checked_at))}`
                        : "Not yet checked"
                    }
                  >
                    <span className="fleet-health-dot" aria-hidden="true" />
                    {isProbing ? "Probing…" : healthText(r, probe)}
                  </span>
                </td>
                <td>
                  <div className="fleet-policies">
                    {r.policies.length === 0 ? (
                      <span className="fleet-muted">—</span>
                    ) : (
                      r.policies.map((p) => (
                        <span
                          key={p.key}
                          className={`fleet-badge fleet-badge-${p.tone}`}
                          title={p.title}
                        >
                          {p.label}
                        </span>
                      ))
                    )}
                  </div>
                </td>
                <td>
                  {!sessionsKnown ? (
                    <span className="fleet-muted">—</span>
                  ) : r.sessions > 0 ? (
                    <span className="fleet-load">
                      <span className="fleet-load-dot" aria-hidden="true" />
                      {r.sessions} active
                    </span>
                  ) : (
                    <span className="fleet-muted">0 active</span>
                  )}
                </td>
                <td>
                  <span className="fleet-folder">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    {r.folderName ?? "Root"}
                  </span>
                </td>
                <td className="fleet-col-actions">
                  <div className="fleet-actions">
                    <button
                      type="button"
                      className="fleet-icon-btn"
                      title="Configure"
                      aria-label={`Configure ${c.name}`}
                      onClick={() => actions.onEdit(c)}
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
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="fleet-icon-btn fleet-icon-accent"
                      title="Probe now"
                      aria-label={`Probe ${c.name}`}
                      disabled={isProbing}
                      onClick={() => actions.onProbe(c)}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <polygon points="6,4 20,12 6,20" />
                      </svg>
                    </button>
                    <FleetMenu
                      triggerLabel={`More actions for ${c.name}`}
                      triggerClassName="fleet-icon-btn"
                      trigger={<span aria-hidden="true">•••</span>}
                      items={[
                        { label: "Duplicate", onSelect: () => actions.onDuplicate(c) },
                        ...(c.protocol === "ssh" && c.extra?.["host-key"]
                          ? [
                              {
                                label: "Clear pinned host key",
                                onSelect: () => actions.onClearHostKey(c),
                              },
                            ]
                          : []),
                        {
                          label: "Delete connection",
                          danger: true,
                          onSelect: () => actions.onDelete(c),
                        },
                      ]}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
