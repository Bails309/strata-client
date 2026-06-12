/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync. */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listOutboundShares,
  listPendingOutboundShares,
  decideOutboundShare,
  purgeOutboundShare,
  listOutboundApprovers,
  addOutboundApprover,
  removeOutboundApprover,
  outboundShareDownloadUrl,
  OutboundShare,
  OutboundShareApprover,
  User,
} from "../../api";
import Select from "../../components/Select";
import ConfirmModal from "../../components/ConfirmModal";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function statusBadge(status: string): string {
  switch (status) {
    case "approved":
      return "bg-success-dim text-success";
    case "denied":
    case "purged":
      return "bg-danger/10 text-danger";
    case "downloaded":
      return "bg-accent/10 text-accent";
    case "pending":
    default:
      return "bg-warning-dim text-warning";
  }
}

interface Props {
  users: User[];
  /** True when the current user has `can_manage_system` — only super-admins
   *  can manage the approver list and run manual purges. */
  isSuperAdmin: boolean;
  onSave: () => void;
  /**
   * Which sections of the tab to render. Lets the same component back
   * two surfaces:
   *  - `'admin'`        (default, back-compat) — Pending + History + Approvers.
   *  - `'policy-only'`  — only the Approver-delegation block. Used by
   *                       the renamed "Outbound Share Policy" Admin tab
   *                       now that the operational queue lives under
   *                       `/approvals`.
   *  - `'queue-only'`   — Pending + History, no Approvers. Used by the
   *                       tabbed `/approvals` page so designated
   *                       approvers and super-admins share one queue
   *                       view without seeing the delegation roster
   *                       twice.
   */
  variant?: "admin" | "policy-only" | "queue-only";
}

/**
 * Outbound Quick-Share admin / approver surface. Combines:
 *  - The pending-approval queue (Approve / Deny actions).
 *  - Full history with filter.
 *  - Approver-list management (super-admin only).
 *
 * Designated approvers without `can_manage_system` see only the queue
 * and history; they can decide but cannot purge or change delegations.
 *
 * `variant` controls which of those three blocks render — see the
 * [`Props`] docstring for the breakdown.
 */
export default function OutboundSharesTab({
  users,
  isSuperAdmin,
  onSave,
  variant = "admin",
}: Props) {
  const showQueue = variant === "admin" || variant === "queue-only";
  const showApprovers = variant === "admin" || variant === "policy-only";
  const [pending, setPending] = useState<OutboundShare[]>([]);
  const [history, setHistory] = useState<OutboundShare[]>([]);
  const [approvers, setApprovers] = useState<OutboundShareApprover[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denyModal, setDenyModal] = useState<{ share: OutboundShare; reason: string } | null>(null);
  // Pending in-app purge confirmation. Replaces the previous
  // `window.confirm()` call so the prompt matches the rest of the
  // admin UX (themed, focus-trapped, escape-to-cancel via the
  // shared ConfirmModal component) instead of dropping the user
  // into the browser-native modal.
  const [purgeModal, setPurgeModal] = useState<OutboundShare | null>(null);
  const [addingApprover, setAddingApprover] = useState<string>("");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      if (showQueue) {
        const [p, h] = await Promise.all([listPendingOutboundShares(), listOutboundShares()]);
        setPending(p);
        setHistory(h);
      }
      if (showApprovers && isSuperAdmin) {
        const a = await listOutboundApprovers();
        setApprovers(a);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load outbound shares");
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, showQueue, showApprovers]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh so background events (the hourly outbound-shares
  // purge sweeper flipping rows to `purged` / dropping rows past the
  // 7-day history-retention window, or another approver acting on
  // the queue) become visible without forcing the operator to click
  // Refresh. Visibility-gated so a forgotten tab in the background
  // doesn't keep polling — we also do an immediate refresh on tab
  // re-focus so the first thing the operator sees after switching
  // back is fresh state.
  useEffect(() => {
    const POLL_MS = 60_000;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(refresh, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [refresh]);

  const userById = useMemo(() => {
    const m = new Map<string, User>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  const eligibleApprovers = useMemo(() => {
    const have = new Set(approvers.map((a) => a.user_id));
    return users.filter((u) => !u.deleted_at && !have.has(u.id));
  }, [users, approvers]);

  const handleApprove = useCallback(
    async (s: OutboundShare) => {
      try {
        await decideOutboundShare(s.id, true);
        onSave();
        await refresh();
      } catch (e: unknown) {
        alert(e instanceof Error ? e.message : "Approve failed");
      }
    },
    [onSave, refresh]
  );

  const handleDenyConfirm = useCallback(async () => {
    if (!denyModal) return;
    try {
      await decideOutboundShare(denyModal.share.id, false, denyModal.reason || undefined);
      setDenyModal(null);
      onSave();
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Deny failed");
    }
  }, [denyModal, onSave, refresh]);

  const handlePurge = useCallback((s: OutboundShare) => {
    // Open the themed confirmation modal; the actual purge call
    // runs from `handlePurgeConfirm` once the user clicks through.
    setPurgeModal(s);
  }, []);

  const handlePurgeConfirm = useCallback(async () => {
    if (!purgeModal) return;
    const target = purgeModal;
    setPurgeModal(null);
    try {
      await purgeOutboundShare(target.id);
      onSave();
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Purge failed");
    }
  }, [purgeModal, onSave, refresh]);

  const handleAddApprover = useCallback(async () => {
    if (!addingApprover) return;
    try {
      await addOutboundApprover(addingApprover);
      setAddingApprover("");
      onSave();
      await refresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to add approver");
    }
  }, [addingApprover, onSave, refresh]);

  const handleRemoveApprover = useCallback(
    async (userId: string) => {
      try {
        await removeOutboundApprover(userId);
        onSave();
        await refresh();
      } catch (e: unknown) {
        alert(e instanceof Error ? e.message : "Failed to remove approver");
      }
    },
    [onSave, refresh]
  );

  if (loading) {
    return <div className="text-txt-tertiary text-sm p-4">Loading outbound shares…</div>;
  }

  // Resolve a requester display name, preferring the server-side JOIN
  // (`OutboundShare.requester_username`) so non-admin approvers who
  // cannot call `/admin/users` still get a friendly name. Falls back to
  // the admin-fetched user list, then to the raw user id.
  const requesterLabel = (s: OutboundShare): string =>
    s.requester_username || userById.get(s.requester_user_id)?.username || s.requester_user_id;

  // Header / intro copy varies by surface:
  //  - admin       → the original "Outbound Quick-Share" intro.
  //  - policy-only → "Outbound Share Policy" (delegation only).
  //  - queue-only  → no intro — the parent tabbed `/approvals` page
  //                  supplies its own heading.
  const headerBlock =
    variant === "queue-only" ? null : variant === "policy-only" ? (
      <div>
        <h2 className="text-lg font-bold mb-1">Outbound Share Policy</h2>
        <p className="text-xs text-txt-tertiary">
          Delegate the Outbound Quick-Share approval queue to non-admin reviewers (e.g. compliance
          officers). The operational queue itself now lives under <strong>Pending Approvals</strong>{" "}
          in the left nav.
        </p>
      </div>
    ) : (
      <div>
        <h2 className="text-lg font-bold mb-1">Outbound Quick-Share</h2>
        <p className="text-xs text-txt-tertiary">
          Approval-gated file exports. Files are encrypted at rest and purged after the configured
          TTL or on denial.
        </p>
      </div>
    );

  return (
    <div className="space-y-6">
      {headerBlock}

      {error && <div className="rounded px-3 py-2 bg-danger/10 text-danger text-sm">{error}</div>}

      {/* Pending queue */}
      {showQueue && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold uppercase tracking-wider text-txt-secondary">
              Pending ({pending.length})
            </h3>
            <button className="text-xs text-txt-secondary hover:text-txt-primary" onClick={refresh}>
              Refresh
            </button>
          </div>
          {pending.length === 0 ? (
            <div className="text-xs text-txt-tertiary italic p-4 rounded bg-surface-secondary/40 border border-white/5">
              No shares waiting for approval.
            </div>
          ) : (
            <div className="space-y-2">
              {pending.map((s) => {
                return (
                  <div
                    key={s.id}
                    className="rounded border border-white/10 bg-surface-secondary/50 p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate" title={s.filename}>
                          {s.filename}
                        </div>
                        <div className="text-[11px] text-txt-tertiary">
                          {requesterLabel(s)} · {formatSize(s.size)} ·{" "}
                          {s.content_type || "application/octet-stream"} ·{" "}
                          {new Date(s.created_at).toLocaleString()}
                        </div>
                      </div>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${statusBadge(s.status)}`}
                      >
                        DLP {s.dlp_score}
                      </span>
                    </div>
                    {s.dlp_reasons.length > 0 && (
                      <div className="text-[11px] text-txt-tertiary">
                        Flags: {s.dlp_reasons.join(", ")}
                      </div>
                    )}
                    {s.justification && (
                      <div className="text-[11px] text-txt-secondary italic border-l-2 border-white/10 pl-2">
                        &ldquo;{s.justification}&rdquo;
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button
                        className="btn-primary text-xs px-3 py-1"
                        onClick={() => handleApprove(s)}
                      >
                        Approve
                      </button>
                      <button
                        className="btn-ghost text-xs px-3 py-1 text-danger"
                        onClick={() => setDenyModal({ share: s, reason: "" })}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* History */}
      {showQueue && (
        <section>
          <h3 className="text-sm font-bold uppercase tracking-wider text-txt-secondary mb-2">
            History ({history.length})
          </h3>
          {history.length === 0 ? (
            <div className="text-xs text-txt-tertiary italic">No submissions yet.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-txt-tertiary">
                <tr>
                  <th className="text-left py-1">File</th>
                  <th className="text-left py-1">Requester</th>
                  <th className="text-left py-1">Status</th>
                  <th className="text-left py-1">DLP</th>
                  <th className="text-left py-1">Created</th>
                  <th className="text-left py-1">Decision</th>
                  <th className="text-left py-1 w-[140px]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => {
                  const decider = s.decided_by ? userById.get(s.decided_by) : null;
                  return (
                    <tr key={s.id} className="border-t border-white/5">
                      <td className="py-1.5">
                        <div className="font-medium truncate max-w-[200px]" title={s.filename}>
                          {s.filename}
                        </div>
                        <div className="text-[10px] text-txt-tertiary">{formatSize(s.size)}</div>
                      </td>
                      <td className="py-1.5">{requesterLabel(s)}</td>
                      <td className="py-1.5">
                        <div className="flex items-center gap-1 flex-wrap">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider ${statusBadge(s.status)}`}
                          >
                            {s.status}
                          </span>
                          {s.purged_at && s.status !== "purged" && (
                            <span
                              className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-white/5 text-txt-tertiary"
                              title={`Sealed material removed from disk at ${new Date(s.purged_at).toLocaleString()}. Row is kept here for audit until 7 days after purge.`}
                            >
                              Cleaned
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-1.5">{s.dlp_score}</td>
                      <td className="py-1.5 text-txt-tertiary">
                        {new Date(s.created_at).toLocaleString()}
                      </td>
                      <td className="py-1.5 text-txt-tertiary">
                        {decider?.username ? (
                          <span title={s.decision_reason || ""}>{decider.username}</span>
                        ) : (
                          <span className="opacity-40">—</span>
                        )}
                      </td>
                      <td className="py-1.5">
                        <div className="flex gap-1">
                          {s.status === "approved" && s.download_token && (
                            <a
                              href={outboundShareDownloadUrl(s.download_token)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="btn-ghost text-[10px] px-2 py-0.5"
                            >
                              Download
                            </a>
                          )}
                          {isSuperAdmin && s.status !== "purged" && (
                            <button
                              className="btn-ghost text-[10px] px-2 py-0.5 text-danger"
                              onClick={() => handlePurge(s)}
                            >
                              Purge
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* Approver list — super-admin only */}
      {showApprovers && isSuperAdmin && (
        <section>
          <h3 className="text-sm font-bold uppercase tracking-wider text-txt-secondary mb-1">
            Designated Approvers
          </h3>
          <p className="text-[11px] text-txt-tertiary mb-2">
            Super-admins (<code>can_manage_system</code>) can always decide. Use this list to
            delegate to non-admins (e.g. compliance officers).
          </p>
          <div className="space-y-2">
            {approvers.length === 0 ? (
              <div className="text-xs text-txt-tertiary italic">
                No delegated approvers — only super-admins can decide right now.
              </div>
            ) : (
              <ul className="space-y-1">
                {approvers.map((a) => (
                  <li
                    key={a.user_id}
                    className="flex items-center justify-between rounded px-2 py-1 bg-surface-secondary/40 border border-white/5 text-xs"
                  >
                    <div>
                      <span className="font-medium">{a.username}</span>{" "}
                      <span className="text-txt-tertiary">({a.email})</span>
                    </div>
                    <button
                      className="btn-ghost text-[10px] px-2 py-0.5 text-danger"
                      onClick={() => handleRemoveApprover(a.user_id)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2 items-center pt-2">
              <div className="flex-1">
                <Select
                  value={addingApprover}
                  onChange={setAddingApprover}
                  placeholder="Add an approver…"
                  searchable
                  options={eligibleApprovers.map((u) => ({
                    value: u.id,
                    label: `${u.username} (${u.email})`,
                  }))}
                />
              </div>
              <button
                className="btn-primary text-xs px-3 py-1"
                disabled={!addingApprover}
                onClick={handleAddApprover}
              >
                Add
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Deny modal */}
      {denyModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="card w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-bold mb-2">Deny share?</h3>
            <p className="text-xs text-txt-tertiary mb-3">
              Denying purges the staged file immediately. Optionally include a reason that the
              requester will see.
            </p>
            <textarea
              className="w-full mb-3 px-2 py-1 text-sm bg-black/20 border border-white/10 rounded resize-none"
              rows={3}
              placeholder="Reason (optional)"
              value={denyModal.reason}
              onChange={(e) => setDenyModal({ ...denyModal, reason: e.target.value })}
              maxLength={500}
            />
            <div className="flex justify-end gap-2">
              <button className="btn-ghost text-sm px-3 py-1" onClick={() => setDenyModal(null)}>
                Cancel
              </button>
              <button
                className="btn-primary text-sm px-3 py-1 bg-danger"
                onClick={handleDenyConfirm}
              >
                Deny &amp; purge
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Purge confirmation modal. Uses the shared ConfirmModal
          (themed + focus-trapped + escape-to-cancel) instead of
          the browser-native `window.confirm()` so the prompt fits
          the rest of the admin UX. `isDangerous` paints the
          red danger styling + alert glyph on the dialog. */}
      <ConfirmModal
        isOpen={purgeModal !== null}
        title="Purge staged file?"
        message={
          purgeModal
            ? `Purge "${purgeModal.filename}"? This permanently deletes the staged file and the encryption key.`
            : ""
        }
        confirmLabel="Purge"
        cancelLabel="Cancel"
        isDangerous
        onConfirm={handlePurgeConfirm}
        onCancel={() => setPurgeModal(null)}
      />
    </div>
  );
}
