/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useEffect, useState, useCallback, useMemo } from "react";
import { MeResponse, CheckoutRequest, getPendingApprovals, decideCheckout } from "../api";
import OutboundSharesTab from "./admin/OutboundSharesTab";

// Tab keys for the two approval flows that share this page. Keep in
// sync with the visibility logic in `Approvals` below and with the
// matching nav-item gate in `components/Layout.tsx`.
type ApprovalTab = "checkouts" | "outbound";

function cnFromDn(dn: string): string {
  const m = dn.match(/^CN=((?:\\.|[^,])+)/i);
  return m ? m[1].replace(/\\(.)/g, "$1") : dn;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Approvals({ user }: { user: MeResponse }) {
  // Visibility of the two queues that live on this page.
  // - `showCheckouts`: Safeguard credential-checkout approvals; needs a
  //   vault and the `is_approver` flag (set when the user has any
  //   approval-role assignment).
  // - `showOutbound`: Outbound Quick-Share approvals; super-admins are
  //   implicit approvers, plus any user listed in
  //   `outbound_share_approvers`. See routes/user.rs for the source.
  const showCheckouts = !!(user.vault_configured && user.is_approver);
  const showOutbound = !!user.is_outbound_approver;

  // Default to checkouts when available, otherwise outbound. The nav
  // item is hidden when neither is visible, but we still render
  // gracefully ("You don't have approval rights yet.") to make the
  // failure mode obvious if someone hits the URL directly.
  const [activeTab, setActiveTab] = useState<ApprovalTab>(showCheckouts ? "checkouts" : "outbound");

  const [pending, setPending] = useState<CheckoutRequest[]>([]);
  const [msg, setMsg] = useState("");
  const [deciding, setDeciding] = useState<string | null>(null);
  // Per-row deny state. When `denyingId` is set, the row expands an inline
  // reason textarea and the Confirm button stays disabled until the field
  // is non-empty — matches the in-session PendingApprovalWatcher popup so
  // the two surfaces behave consistently.
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const flash = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(""), 4000);
  };

  const loadPending = useCallback(async () => {
    if (!showCheckouts) return;
    try {
      setPending(await getPendingApprovals());
    } catch {
      /* */
    }
  }, [showCheckouts]);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  const handleApprove = async (id: string) => {
    setDeciding(id);
    try {
      await decideCheckout(id, true);
      flash("Checkout approved");
      setDenyingId(null);
      setDenyReason("");
      loadPending();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setDeciding(null);
    }
  };

  const handleConfirmDeny = async (id: string) => {
    const trimmed = denyReason.trim();
    if (trimmed.length === 0) return;
    setDeciding(id);
    try {
      await decideCheckout(id, false, trimmed);
      flash("Checkout denied");
      setDenyingId(null);
      setDenyReason("");
      loadPending();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Decision failed");
    } finally {
      setDeciding(null);
    }
  };

  // Tab definitions used to build the tab strip. We hide the strip
  // entirely when only one queue is visible — the heading + body still
  // make sense on their own.
  const tabs = useMemo(
    () =>
      [
        showCheckouts ? { key: "checkouts" as const, label: "Credential Checkouts" } : null,
        showOutbound ? { key: "outbound" as const, label: "Outbound Shares" } : null,
      ].filter((t): t is { key: ApprovalTab; label: string } => t !== null),
    [showCheckouts, showOutbound]
  );

  return (
    <div className="animate-fade-up" style={{ padding: "2rem", maxWidth: 900, margin: "0 auto" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="!mb-0">Pending Approvals</h1>
          <p className="text-txt-secondary text-sm mt-1">
            {showCheckouts && showOutbound
              ? "Review credential-checkout requests and outbound file shares."
              : activeTab === "outbound"
                ? "Review outbound Quick-Share file exports awaiting decision."
                : "Review and approve or deny password checkout requests."}
          </p>
        </div>
        {activeTab === "checkouts" && (
          <button className="btn" onClick={loadPending}>
            Refresh
          </button>
        )}
      </div>

      {/* Tab strip — only rendered when the user can see both queues.
          Designated outbound approvers without checkout rights (and
          vice-versa) see the single body straight away. */}
      {tabs.length > 1 && (
        <div
          className="flex gap-1 mb-6"
          style={{ borderBottom: "1px solid var(--color-border)" }}
          role="tablist"
          aria-label="Approval queues"
        >
          {tabs.map((t) => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(t.key)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "text-txt-primary border-b-2 border-accent"
                    : "text-txt-secondary hover:text-txt-primary"
                }`}
                style={{ marginBottom: "-1px" }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {msg && <div className="rounded-md mb-4 px-4 py-2 bg-success-dim text-success">{msg}</div>}

      {tabs.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-txt-secondary text-sm">You don&rsquo;t have approval rights yet.</p>
        </div>
      )}

      {activeTab === "outbound" && showOutbound && (
        <OutboundSharesTab
          users={[]}
          isSuperAdmin={!!user.can_manage_system}
          onSave={() => flash("Outbound share updated")}
          variant="queue-only"
        />
      )}

      {activeTab === "checkouts" && showCheckouts && (
        <>
          {pending.length === 0 ? (
            <div className="card text-center py-12">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mx-auto mb-4 text-txt-tertiary"
              >
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
              </svg>
              <p className="text-txt-secondary text-sm">No pending approvals.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {pending.map((p) => (
                <div key={p.id} className="card overflow-hidden">
                  {/* Header */}
                  <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold"
                        style={{
                          background: "var(--color-accent-dim)",
                          color: "var(--color-accent)",
                        }}
                      >
                        {(p.requester_username || "?")[0].toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {p.requester_username || p.requester_user_id}
                        </div>
                        <div className="text-xs text-txt-tertiary">{timeAgo(p.created_at)}</div>
                      </div>
                    </div>
                    <span
                      className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full"
                      style={{
                        background: "var(--color-warning-dim)",
                        color: "var(--color-warning)",
                      }}
                    >
                      Pending
                    </span>
                  </div>

                  {/* Body */}
                  <div className="px-5 pb-4">
                    {/* Account */}
                    <div className="mb-3">
                      <div className="text-[11px] font-medium uppercase tracking-wider text-txt-tertiary mb-1">
                        Account
                      </div>
                      <div className="text-sm font-medium">{cnFromDn(p.managed_ad_dn)}</div>
                      <div className="text-xs text-txt-tertiary mt-0.5 break-all">
                        {p.managed_ad_dn}
                      </div>
                    </div>

                    {/* Details row */}
                    <div className="flex gap-6 mb-3">
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wider text-txt-tertiary mb-1">
                          Duration
                        </div>
                        <div className="text-sm">
                          {p.requested_duration_mins >= 60
                            ? `${Math.floor(p.requested_duration_mins / 60)}h ${p.requested_duration_mins % 60 ? `${p.requested_duration_mins % 60}m` : ""}`
                            : `${p.requested_duration_mins}m`}
                        </div>
                      </div>
                    </div>

                    {/* Justification */}
                    {p.justification_comment && (
                      <div className="mb-3">
                        <div className="text-[11px] font-medium uppercase tracking-wider text-txt-tertiary mb-1">
                          Justification
                        </div>
                        <div
                          className="text-sm rounded-md px-3 py-2 italic"
                          style={{
                            background: "var(--color-surface-elevated)",
                            border: "1px solid var(--color-glass-border)",
                          }}
                        >
                          &ldquo;{p.justification_comment}&rdquo;
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div
                      className="flex flex-col gap-2 pt-2"
                      style={{ borderTop: "1px solid var(--color-glass-border)" }}
                    >
                      {denyingId === p.id ? (
                        <div className="flex flex-col gap-2">
                          <label
                            className="text-[11px] font-medium uppercase tracking-wider text-txt-tertiary"
                            htmlFor={`approvals-deny-reason-${p.id}`}
                          >
                            Reason for denial (required)
                          </label>
                          <textarea
                            id={`approvals-deny-reason-${p.id}`}
                            value={denyReason}
                            onChange={(e) => setDenyReason(e.target.value)}
                            rows={2}
                            placeholder="e.g. Outside change window, contact owner first"
                            className="w-full text-sm rounded-md p-2"
                            style={{
                              background: "var(--color-surface-elevated)",
                              border: "1px solid var(--color-glass-border)",
                              color: "var(--color-text-primary, inherit)",
                              resize: "vertical",
                            }}
                            autoFocus
                            disabled={deciding === p.id}
                          />
                          <div className="flex gap-2">
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={deciding === p.id || denyReason.trim().length === 0}
                              onClick={() => handleConfirmDeny(p.id)}
                            >
                              {deciding === p.id ? "Working\u2026" : "Confirm deny"}
                            </button>
                            <button
                              className="btn btn-sm"
                              disabled={deciding === p.id}
                              onClick={() => {
                                setDenyingId(null);
                                setDenyReason("");
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            className="btn btn-sm btn-success"
                            disabled={deciding === p.id}
                            onClick={() => handleApprove(p.id)}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="mr-1.5"
                            >
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                            Approve
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            disabled={deciding === p.id}
                            onClick={() => {
                              setDenyingId(p.id);
                              setDenyReason("");
                            }}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="mr-1.5"
                            >
                              <path d="M18 6L6 18" />
                              <path d="M6 6l12 12" />
                            </svg>
                            Deny
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
