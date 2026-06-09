import { useEffect, useState } from "react";
import { getAuditLogs, AuditLog } from "../../api";
import { useSettings } from "../../contexts/SettingsContext";

/* Files blocked by the AV scanner during upload.
 *
 * This tab is a focused, operator-friendly view over the
 * `file.av_blocked` audit action — the same row the routes write when
 * either the inbound (Quick Share inbound / file drop) or the outbound
 * (Quick Share outbound, both drive-channel and token-ingest) AV scan
 * rejects an upload. Backed by the existing audit-logs endpoint so
 * permissions, pagination, and hash-chain semantics are inherited
 * without a second route.
 */

const PAGE_SIZE = 50;

type Source = "inbound" | "outbound_drive" | "outbound_token" | "unknown";

interface BlockRow {
  log: AuditLog;
  source: Source;
  filename: string;
  size: number | null;
  status: string;
  signature: string | null;
  message: string | null;
  backend: string | null;
  sessionId: string | null;
}

function parseRow(log: AuditLog): BlockRow {
  const d = log.details ?? {};
  const sourceRaw = typeof d.source === "string" ? d.source : "";
  const source: Source =
    sourceRaw === "inbound" || sourceRaw === "outbound_drive" || sourceRaw === "outbound_token"
      ? sourceRaw
      : "unknown";
  const sizeRaw = d.size;
  const size = typeof sizeRaw === "number" ? sizeRaw : null;
  return {
    log,
    source,
    filename: typeof d.filename === "string" ? d.filename : "—",
    size,
    status: typeof d.av_status === "string" ? d.av_status : "unknown",
    signature: typeof d.av_signature === "string" ? d.av_signature : null,
    message: typeof d.av_message === "string" ? d.av_message : null,
    backend: typeof d.av_backend === "string" ? d.av_backend : null,
    sessionId: typeof d.session_id === "string" ? d.session_id : null,
  };
}

function humanSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

function statusBadge(status: string): string {
  if (status === "infected") return "badge badge-error";
  if (status === "error") return "badge badge-warning";
  return "badge";
}

function sourceLabel(source: Source): string {
  switch (source) {
    case "inbound":
      return "Inbound";
    case "outbound_drive":
      return "Outbound (drive)";
    case "outbound_token":
      return "Outbound (token)";
    default:
      return "—";
  }
}

export default function AvBlockedTab() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState("");
  const { formatDateTime } = useSettings();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadError("");
    getAuditLogs(page, PAGE_SIZE, { action_type: "file.av_blocked" })
      .then(setLogs)
      .catch(() => setLoadError("Failed to load AV-blocked file list."));
  }, [page]);

  const rows = logs.map(parseRow);

  return (
    <div>
      <h2>AV-Blocked Files</h2>
      <p className="text-sm text-txt-secondary mb-4">
        Uploads rejected by the antivirus scanner during inbound (Quick Share inbound / file drop)
        or outbound (Quick Share outbound) ingest. The underlying entries are append-only rows in
        the audit log (<code>file.av_blocked</code>); use the Audit Logs page for full filtering and
        hash-chain verification.
      </p>

      {loadError && (
        <div className="rounded-md mb-4 px-4 py-2 bg-danger/10 text-danger">{loadError}</div>
      )}

      <div className="table-responsive">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>User</th>
              <th>Source</th>
              <th>Filename</th>
              <th>Size</th>
              <th>Status</th>
              <th>Signature</th>
              <th>Engine message</th>
              <th>Backend</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center text-txt-secondary py-6">
                  {page === 1
                    ? "No AV-blocked uploads have been recorded."
                    : "No more AV-blocked uploads on this page."}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.log.id}>
                  <td className="text-[0.8rem] whitespace-nowrap font-mono">
                    {formatDateTime(r.log.created_at)}
                  </td>
                  <td className="text-sm">
                    {r.log.username || (r.log.user_id ? r.log.user_id.slice(0, 8) : "—")}
                  </td>
                  <td className="text-sm whitespace-nowrap">{sourceLabel(r.source)}</td>
                  <td className="text-sm max-w-[260px] truncate" title={r.filename}>
                    {r.filename}
                  </td>
                  <td className="text-sm whitespace-nowrap">{humanSize(r.size)}</td>
                  <td>
                    <span className={statusBadge(r.status)}>{r.status}</span>
                  </td>
                  <td
                    className="text-[0.8rem] font-mono max-w-[220px] truncate"
                    title={r.signature ?? undefined}
                  >
                    {r.signature ?? "—"}
                  </td>
                  <td
                    className="text-[0.8rem] max-w-[280px] truncate"
                    title={r.message ?? undefined}
                  >
                    {r.message ?? "—"}
                  </td>
                  <td className="text-sm whitespace-nowrap">{r.backend ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-center gap-2 mt-4">
        <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span className="py-2 px-2 text-txt-secondary">Page {page}</span>
        <button
          className="btn"
          onClick={() => setPage(page + 1)}
          disabled={logs.length < PAGE_SIZE}
        >
          Next
        </button>
      </div>
    </div>
  );
}
