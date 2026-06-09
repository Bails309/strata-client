/* Polls the approval queues an approver is gated for and surfaces in-session
   popup cards so a decision can be made without leaving the current page. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import {
  CheckoutRequest,
  MeResponse,
  OutboundShare,
  decideCheckout,
  decideOutboundShare,
  getPendingApprovals,
  listPendingOutboundShares,
} from "../api";
import { useToast } from "./ToastProvider";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Tunables                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** Poll cadence. The two endpoints are bounded single-table reads scoped to
 *  the approver, so 45 s is cheap and still feels responsive when an
 *  approval lands while the approver is mid-session. */
const POLL_INTERVAL_MS = 45_000;

/** How long an unactioned popup stays on screen before it auto-dismisses.
 *  Once dismissed, it does not re-appear until the underlying queue entry
 *  is decided/withdrawn — see `STORAGE_KEY` below. */
const AUTO_DISMISS_MS = 30_000;

/** localStorage namespace. Tracks `<kind>:<id> → firstShownAtMs` so a
 *  dismissed popup does not re-spawn on the next poll, and so two tabs
 *  do not double-up. Pruned to the live pending set each cycle to keep
 *  the record bounded. */
const STORAGE_KEY = "strata.pendingApprovalShown.v1";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Types                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

interface CheckoutCard {
  uid: string;
  kind: "checkout";
  id: string;
  data: CheckoutRequest;
}
interface OutboundCard {
  uid: string;
  kind: "outbound";
  id: string;
  data: OutboundShare;
}
type ApprovalCard = CheckoutCard | OutboundCard;

type ShownMap = Record<string, number>;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Storage helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function loadShown(): ShownMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as ShownMap;
  } catch {
    return {};
  }
}

function saveShown(map: ShownMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / privacy mode — best-effort */
  }
}

function pruneShown(map: ShownMap, liveUids: Set<string>): ShownMap {
  const next: ShownMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (liveUids.has(k)) next[k] = v;
  }
  return next;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Formatting helpers                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDurationMins(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

function cnFromDn(dn: string): string {
  const m = dn.match(/^CN=((?:\\.|[^,])+)/i);
  return m ? m[1].replace(/\\(.)/g, "$1") : dn;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Watcher                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export interface PendingApprovalWatcherProps {
  user: MeResponse;
  /** Override for the poll interval (used by tests to compress time). */
  pollIntervalMs?: number;
  /** Override for the per-card auto-dismiss window. */
  autoDismissMs?: number;
}

export default function PendingApprovalWatcher({
  user,
  pollIntervalMs = POLL_INTERVAL_MS,
  autoDismissMs = AUTO_DISMISS_MS,
}: PendingApprovalWatcherProps) {
  const toast = useToast();
  const navigate = useNavigate();

  // Source-of-truth flags for which queues to poll. Re-derived per render but
  // captured in the polling closure via the explicit dependency below.
  const watchCheckouts = !!(user.vault_configured && user.is_approver);
  const watchOutbound = !!user.is_outbound_approver;

  const [cards, setCards] = useState<ApprovalCard[]>([]);

  // Refresh is stable across renders so the polling effect doesn't re-arm.
  const refresh = useCallback(async () => {
    if (!watchCheckouts && !watchOutbound) return;

    const [checks, outs] = await Promise.all([
      watchCheckouts ? getPendingApprovals().catch(() => [] as CheckoutRequest[]) : Promise.resolve([]),
      watchOutbound ? listPendingOutboundShares().catch(() => [] as OutboundShare[]) : Promise.resolve([]),
    ]);

    // Build the incoming set and the de-dup key index in one pass.
    const incoming: ApprovalCard[] = [];
    const liveUids = new Set<string>();
    for (const c of checks) {
      if (c.status !== "Pending") continue;
      const uid = `checkout:${c.id}`;
      liveUids.add(uid);
      incoming.push({ uid, kind: "checkout", id: c.id, data: c });
    }
    for (const s of outs) {
      if (s.status !== "pending") continue;
      const uid = `outbound:${s.id}`;
      liveUids.add(uid);
      incoming.push({ uid, kind: "outbound", id: s.id, data: s });
    }

    // Persist the shown-set first so a concurrent tab sees the same view.
    const shown = pruneShown(loadShown(), liveUids);
    const now = Date.now();
    const newOnes = incoming.filter((c) => !(c.uid in shown));
    for (const c of newOnes) shown[c.uid] = now;
    saveShown(shown);

    setCards((prev) => {
      // Keep cards already visible (so an in-progress "deny + reason" flow
      // isn't wiped on poll), update their bodies in case the server-side
      // record changed, and append cards we haven't shown yet.
      const stillLive = prev
        .filter((c) => liveUids.has(c.uid))
        .map((c) => {
          const fresh = incoming.find((i) => i.uid === c.uid);
          return fresh ?? c;
        });
      const visibleUids = new Set(stillLive.map((c) => c.uid));
      const additions = newOnes.filter((c) => !visibleUids.has(c.uid));
      return [...stillLive, ...additions];
    });
  }, [watchCheckouts, watchOutbound]);

  // Mount/poll lifecycle. Mirrors CredentialProfileExpiryWatcher's wake-up
  // strategy (focus + visibilitychange) so a tab that slept through several
  // approvals catches up on resume.
  useEffect(() => {
    if (!watchCheckouts && !watchOutbound) return;
    let cancelled = false;
    void refresh();
    const id = setInterval(() => {
      if (!cancelled) void refresh();
    }, pollIntervalMs);
    const onWake = () => {
      if (!cancelled) void refresh();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [refresh, pollIntervalMs, watchCheckouts, watchOutbound]);

  const dismiss = useCallback((uid: string) => {
    setCards((prev) => prev.filter((c) => c.uid !== uid));
  }, []);

  if (typeof document === "undefined") return null;
  if (!watchCheckouts && !watchOutbound) return null;
  if (cards.length === 0) return null;

  // Top-LEFT placement so the popup never collides with the regular toast
  // stack (top-right) or the session-timeout warning (bottom-right).
  return createPortal(
    <div
      className="fixed top-4 left-4 z-[9999] flex flex-col gap-2"
      style={{ maxWidth: "min(420px, calc(100vw - 2rem))" }}
      role="region"
      aria-label="Pending approvals"
    >
      {cards.map((c) => (
        <ApprovalCardView
          key={c.uid}
          card={c}
          autoDismissMs={autoDismissMs}
          onDismiss={() => dismiss(c.uid)}
          onResolved={async (verb) => {
            dismiss(c.uid);
            toast.success({ title: verb === "approved" ? "Approval recorded" : "Denial recorded" });
            await refresh();
          }}
          onError={(message) =>
            toast.error({ title: "Decision failed", description: message })
          }
          onViewAll={() => {
            dismiss(c.uid);
            navigate("/approvals");
          }}
        />
      ))}
    </div>,
    document.body
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Card                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

interface CardProps {
  card: ApprovalCard;
  autoDismissMs: number;
  onDismiss: () => void;
  onResolved: (verb: "approved" | "denied") => void | Promise<void>;
  onError: (message: string) => void;
  onViewAll: () => void;
}

function ApprovalCardView({
  card,
  autoDismissMs,
  onDismiss,
  onResolved,
  onError,
  onViewAll,
}: CardProps) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Auto-dismiss timer. Paused while the user is composing a deny reason
  // (so the form doesn't disappear under them) or while a decision is in
  // flight (so a slow network doesn't drop the card before the API
  // responds).
  useEffect(() => {
    if (denying || busy) return;
    const t = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(t);
  }, [denying, busy, autoDismissMs, onDismiss]);

  const heading = useMemo(() => {
    if (card.kind === "checkout") return "Credential checkout requested";
    return "Outbound file share requested";
  }, [card.kind]);

  const accent = card.kind === "checkout" ? "var(--color-accent, #8b5cf6)" : "var(--color-warning, #eab308)";
  const dim = card.kind === "checkout" ? "var(--color-accent-dim, rgba(139, 92, 246, 0.12))" : "var(--color-warning-dim, rgba(234, 179, 8, 0.12))";

  const approve = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (card.kind === "checkout") {
        await decideCheckout(card.id, true);
      } else {
        await decideOutboundShare(card.id, true);
      }
      await onResolved("approved");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Unable to approve");
      setBusy(false);
    }
  }, [busy, card, onResolved, onError]);

  const confirmDeny = useCallback(async () => {
    if (busy) return;
    const trimmed = reason.trim();
    if (trimmed.length === 0) return; // gated by disabled button below
    setBusy(true);
    try {
      if (card.kind === "checkout") {
        await decideCheckout(card.id, false, trimmed);
      } else {
        await decideOutboundShare(card.id, false, trimmed);
      }
      await onResolved("denied");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Unable to deny");
      setBusy(false);
    }
  }, [busy, reason, card, onResolved, onError]);

  return (
    <div
      className="card flex flex-col gap-2 shadow-2xl pointer-events-auto animate-fade-in"
      role="alertdialog"
      aria-label={heading}
      style={{
        border: `1px solid ${accent}`,
        borderLeftWidth: "3px",
        background: "var(--color-surface)",
        backdropFilter: "blur(8px)",
        padding: "0.75rem 0.875rem",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex items-center justify-center w-8 h-8 rounded-full shrink-0"
          style={{ background: dim }}
          aria-hidden="true"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: accent }}
          >
            {card.kind === "checkout" ? (
              <>
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </>
            ) : (
              <>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </>
            )}
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-txt-primary mb-0.5">{heading}</p>
          {card.kind === "checkout" ? (
            <CheckoutBody data={card.data} />
          ) : (
            <OutboundBody data={card.data} />
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 -mr-1 -mt-1 p-1 rounded text-txt-secondary hover:text-txt-primary"
          aria-label="Dismiss notification"
          style={{ background: "transparent" }}
          disabled={busy}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {!denying ? (
        <div className="flex gap-2 mt-1 flex-wrap">
          <button
            type="button"
            onClick={approve}
            disabled={busy}
            className="btn btn-sm"
            style={{
              background: "var(--color-success, #22c55e)",
              color: "#fff",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Working…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setDenying(true)}
            disabled={busy}
            className="btn btn-sm"
            style={{
              background: "var(--color-danger, #ef4444)",
              color: "#fff",
              opacity: busy ? 0.6 : 1,
            }}
          >
            Deny
          </button>
          <button
            type="button"
            onClick={onViewAll}
            disabled={busy}
            className="btn btn-sm"
            style={{ background: "var(--color-surface-secondary, var(--color-surface))" }}
          >
            View all
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 mt-1">
          <label className="text-xs text-txt-secondary" htmlFor={`deny-reason-${card.uid}`}>
            Reason for denial (required)
          </label>
          <textarea
            id={`deny-reason-${card.uid}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Outside change window, contact owner first"
            className="w-full text-sm rounded-sm p-2"
            style={{
              background: "var(--color-surface-secondary, var(--color-surface))",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-primary, inherit)",
              resize: "vertical",
            }}
            autoFocus
            disabled={busy}
          />
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={confirmDeny}
              disabled={busy || reason.trim().length === 0}
              className="btn btn-sm"
              style={{
                background: "var(--color-danger, #ef4444)",
                color: "#fff",
                opacity: busy || reason.trim().length === 0 ? 0.6 : 1,
              }}
            >
              {busy ? "Working…" : "Confirm deny"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDenying(false);
                setReason("");
              }}
              disabled={busy}
              className="btn btn-sm"
              style={{ background: "var(--color-surface-secondary, var(--color-surface))" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Per-kind body                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

function CheckoutBody({ data }: { data: CheckoutRequest }) {
  const requester = data.requester_username ?? "(unknown user)";
  const target = data.friendly_name ?? cnFromDn(data.managed_ad_dn);
  return (
    <div className="text-xs text-txt-secondary leading-relaxed">
      <div>
        <span className="text-txt-primary font-medium">{requester}</span> wants{" "}
        <span className="text-txt-primary">{target}</span>
        {data.emergency_bypass ? (
          <span
            className="ml-1 inline-block text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded"
            style={{
              background: "var(--color-danger-dim, rgba(239, 68, 68, 0.15))",
              color: "var(--color-danger, #ef4444)",
            }}
          >
            Emergency
          </span>
        ) : null}
      </div>
      <div className="mt-0.5">Duration: {formatDurationMins(data.requested_duration_mins)}</div>
      {data.justification_comment ? (
        <div className="mt-1 italic">“{data.justification_comment}”</div>
      ) : (
        <div className="mt-1 italic text-txt-tertiary">No justification provided</div>
      )}
    </div>
  );
}

function OutboundBody({ data }: { data: OutboundShare }) {
  const requester = data.requester_username ?? "(unknown user)";
  // DLP score is 0–100 on the wire. Anything ≥ 50 is flagged in the queue UI;
  // we surface the score itself so an approver can decide whether to dig in.
  const dlpFlagged = data.dlp_score >= 50 || (data.dlp_reasons?.length ?? 0) > 0;
  return (
    <div className="text-xs text-txt-secondary leading-relaxed">
      <div>
        <span className="text-txt-primary font-medium">{requester}</span> wants to send{" "}
        <span className="text-txt-primary break-all">{data.filename}</span>{" "}
        <span className="text-txt-tertiary">({formatSize(data.size)})</span>
      </div>
      {dlpFlagged && (
        <div className="mt-0.5">
          <span
            className="inline-block text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded"
            style={{
              background: "var(--color-warning-dim, rgba(234, 179, 8, 0.15))",
              color: "var(--color-warning, #eab308)",
            }}
          >
            DLP {data.dlp_score}
          </span>
          {data.dlp_reasons && data.dlp_reasons.length > 0 && (
            <span className="ml-1 text-txt-tertiary">{data.dlp_reasons.join(", ")}</span>
          )}
        </div>
      )}
      {data.justification ? (
        <div className="mt-1 italic">“{data.justification}”</div>
      ) : (
        <div className="mt-1 italic text-txt-tertiary">No justification provided</div>
      )}
    </div>
  );
}
