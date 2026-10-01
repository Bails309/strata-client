/* Polls the approval queues an approver is gated for and publishes an
   actionable toast per request so a decision can be made without leaving
   the current page. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckoutRequest,
  MeResponse,
  OutboundShare,
  decideCheckout,
  decideOutboundShare,
  getPendingApprovals,
  listPendingOutboundShares,
} from "../api";
import { useToast, useToastHold, type ToastDetail, type ToastVariant } from "./ToastProvider";
import { publishPendingApprovals } from "./approvalStore";
import { pollWhileVisible } from "./pollWhileVisible";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Tunables                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** Poll cadence. The two endpoints are bounded single-table reads scoped to
 *  the approver, so 45 s is cheap and still feels responsive when an
 *  approval lands while the approver is mid-session. */
const POLL_INTERVAL_MS = 45_000;

/** How long an unactioned toast stays on screen before it auto-dismisses.
 *  Once dismissed, it does not re-appear until the underlying queue entry
 *  is decided/withdrawn — see `STORAGE_KEY` below. */
const AUTO_DISMISS_MS = 30_000;

/** localStorage namespace. Tracks `<kind>:<id> → firstShownAtMs` so a
 *  dismissed toast does not re-spawn on the next poll, and so two tabs
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
/*  Toast presentation per request kind                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const CHECKOUT_ICON = (
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>
);

const OUTBOUND_ICON = (
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </>
);

function isDlpFlagged(data: OutboundShare): boolean {
  // DLP score is 0–100 on the wire; ≥ 50 is flagged in the queue UI.
  return data.dlp_score >= 50 || (data.dlp_reasons?.length ?? 0) > 0;
}

function presentation(card: ApprovalCard): {
  title: string;
  variant: ToastVariant;
  description: string;
  details: ToastDetail[];
} {
  if (card.kind === "checkout") {
    const d = card.data;
    return {
      title: "Credential checkout requested",
      variant: d.emergency_bypass ? "error" : "info",
      description: d.justification_comment
        ? `“${d.justification_comment}”`
        : "No justification provided",
      details: [
        { label: "User", value: d.requester_username ?? "(unknown user)" },
        { label: "Account", value: d.friendly_name ?? cnFromDn(d.managed_ad_dn) },
        { label: "Duration", value: formatDurationMins(d.requested_duration_mins) },
      ],
    };
  }
  const d = card.data;
  return {
    title: "Outbound file share requested",
    variant: "warning",
    description: d.justification ? `“${d.justification}”` : "No justification provided",
    details: [
      { label: "User", value: d.requester_username ?? "(unknown user)" },
      { label: "File", value: d.filename, meta: formatSize(d.size) },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Watcher                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export interface PendingApprovalWatcherProps {
  user: MeResponse;
  /** Override for the poll interval (used by tests to compress time). */
  pollIntervalMs?: number;
  /** Override for the per-toast auto-dismiss window. */
  autoDismissMs?: number;
}

const toastKey = (uid: string) => `approval:${uid}`;

export default function PendingApprovalWatcher({
  user,
  pollIntervalMs = POLL_INTERVAL_MS,
  autoDismissMs = AUTO_DISMISS_MS,
}: PendingApprovalWatcherProps) {
  const toast = useToast();
  const navigate = useNavigate();

  const watchCheckouts = !!(user.vault_configured && user.is_approver);
  const watchOutbound = !!user.is_outbound_approver;

  // Uids this tab has published, so withdrawn/decided-elsewhere requests
  // can be pulled from the stack on the next poll.
  const publishedRef = useRef<Set<string>>(new Set());
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const publish = useCallback(
    (card: ApprovalCard) => {
      const key = toastKey(card.uid);
      const view = presentation(card);
      toast.show({
        key,
        ...view,
        icon: card.kind === "checkout" ? CHECKOUT_ICON : OUTBOUND_ICON,
        duration: autoDismissMs,
        content: (
          <ApprovalControls
            card={card}
            onResolved={async (verb) => {
              toast.dismiss(key);
              publishedRef.current.delete(card.uid);
              toast.success({
                title: verb === "approved" ? "Approval recorded" : "Denial recorded",
              });
              await refreshRef.current();
            }}
            onError={(message) => toast.error({ title: "Decision failed", description: message })}
            onViewAll={() => {
              toast.dismiss(key);
              navigate("/approvals");
            }}
          />
        ),
      });
      publishedRef.current.add(card.uid);
    },
    [toast, navigate, autoDismissMs]
  );

  const refresh = useCallback(async () => {
    if (!watchCheckouts && !watchOutbound) return;

    const [checks, outs] = await Promise.all([
      watchCheckouts
        ? getPendingApprovals().catch(() => [] as CheckoutRequest[])
        : Promise.resolve([]),
      watchOutbound
        ? listPendingOutboundShares().catch(() => [] as OutboundShare[])
        : Promise.resolve([]),
    ]);

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
    publishPendingApprovals(incoming.length);

    // Persist the shown-set first so a concurrent tab sees the same view.
    const shown = pruneShown(loadShown(), liveUids);
    const now = Date.now();
    const newOnes = incoming.filter((c) => !(c.uid in shown));
    for (const c of newOnes) shown[c.uid] = now;
    saveShown(shown);

    for (const uid of [...publishedRef.current]) {
      if (!liveUids.has(uid)) {
        toast.dismiss(toastKey(uid));
        publishedRef.current.delete(uid);
      }
    }
    // Already-visible toasts are left alone so an in-progress deny flow
    // isn't reset by a poll.
    for (const c of newOnes) publish(c);
  }, [watchCheckouts, watchOutbound, toast, publish]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Mount/poll lifecycle: hidden tabs pause, and a tab that slept through
  // several approvals catches up when it is shown again.
  useEffect(() => {
    if (!watchCheckouts && !watchOutbound) return;
    return pollWhileVisible(refresh, pollIntervalMs);
  }, [refresh, pollIntervalMs, watchCheckouts, watchOutbound]);

  return null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Inline approve / deny controls                                            */
/* ────────────────────────────────────────────────────────────────────────── */

interface ControlsProps {
  card: ApprovalCard;
  onResolved: (verb: "approved" | "denied") => void | Promise<void>;
  onError: (message: string) => void;
  onViewAll: () => void;
}

function ApprovalControls({ card, onResolved, onError, onViewAll }: ControlsProps) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Keep the toast on screen while a deny reason is being written or a
  // decision is in flight.
  useToastHold(denying || busy);

  const decide = useCallback(
    async (approve: boolean, why?: string) => {
      const send = card.kind === "checkout" ? decideCheckout : decideOutboundShare;
      if (why === undefined) await send(card.id, approve);
      else await send(card.id, approve, why);
    },
    [card]
  );

  const approve = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await decide(true);
      await onResolved("approved");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Unable to approve");
      setBusy(false);
    }
  }, [busy, decide, onResolved, onError]);

  const confirmDeny = useCallback(async () => {
    const trimmed = reason.trim();
    if (busy || trimmed.length === 0) return;
    setBusy(true);
    try {
      await decide(false, trimmed);
      await onResolved("denied");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Unable to deny");
      setBusy(false);
    }
  }, [busy, reason, decide, onResolved, onError]);

  const chips =
    card.kind === "checkout" ? (
      card.data.emergency_bypass ? (
        <span className="toast-chip toast-chip-danger">Emergency</span>
      ) : null
    ) : isDlpFlagged(card.data) ? (
      <div>
        <span className="toast-chip toast-chip-warning">DLP {card.data.dlp_score}</span>
        {card.data.dlp_reasons && card.data.dlp_reasons.length > 0 && (
          <span className="toast-summary">{card.data.dlp_reasons.join(", ")}</span>
        )}
      </div>
    ) : null;

  return (
    <>
      {chips}
      {!denying ? (
        <div className="toast-actions">
          <button
            type="button"
            onClick={approve}
            disabled={busy}
            className="toast-btn toast-btn-success"
          >
            {busy ? "Working…" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setDenying(true)}
            disabled={busy}
            className="toast-btn toast-btn-danger"
          >
            Deny
          </button>
          <button type="button" onClick={onViewAll} disabled={busy} className="toast-btn">
            View all
          </button>
        </div>
      ) : (
        <>
          <label className="toast-field-label" htmlFor={`deny-reason-${card.uid}`}>
            Reason for denial (required)
          </label>
          <textarea
            id={`deny-reason-${card.uid}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Outside change window, contact owner first"
            className="toast-textarea"
            autoFocus
            disabled={busy}
          />
          <div className="toast-actions">
            <button
              type="button"
              onClick={confirmDeny}
              disabled={busy || reason.trim().length === 0}
              className="toast-btn toast-btn-danger"
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
              className="toast-btn"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </>
  );
}
