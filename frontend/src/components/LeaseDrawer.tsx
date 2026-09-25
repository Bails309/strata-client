/* Slide-over lease manager: every credential lease with its bindings, plus
   bulk extend (Safeguard JIT) and early check-in. */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  bulkSafeguardCheckout,
  checkinCheckout,
  safeguardCheckin,
  type CredentialProfile,
  type MeResponse,
} from "../api";
import { useToast } from "./ToastProvider";
import { useLeaseTargets } from "./LeaseBatchBody";
import {
  canRenewInPlace,
  formatAgo,
  formatLeft,
  isLeaseExpired,
  leaseKind,
  refreshLeases,
  useNow,
} from "./leaseStore";

const SOON_MS = 60 * 60 * 1000;
const KIND_LABEL = { local: "Local", jit: "JIT", checkout: "Checkout" } as const;

type Group = "expired" | "soon" | "active";

function groupOf(p: CredentialProfile, now: number): Group {
  if (isLeaseExpired(p, now)) return "expired";
  return Date.parse(p.expires_at) - now <= SOON_MS ? "soon" : "active";
}

const GROUP_TITLE: Record<Group, string> = {
  expired: "Expired",
  soon: "Expiring within 1 hour",
  active: "Active",
};

export default function LeaseDrawer({
  profiles,
  user,
  onClose,
}: {
  profiles: CredentialProfile[];
  user?: MeResponse | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const now = useNow(30_000);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmCheckin, setConfirmCheckin] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const targets = useLeaseTargets(profiles.map((p) => p.id));

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const out: Record<Group, CredentialProfile[]> = { expired: [], soon: [], active: [] };
    for (const p of profiles) out[groupOf(p, now)].push(p);
    for (const g of Object.values(out)) g.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
    return out;
  }, [profiles, now]);

  const chosen = profiles.filter((p) => selected.has(p.id));
  const extendable = chosen.filter(canRenewInPlace);
  const checkinable = chosen.filter(
    (p) => !isLeaseExpired(p, now) && (leaseKind(p) === "jit" || leaseKind(p) === "checkout")
  );

  const toggle = (id: string) => {
    setConfirmCheckin(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const finish = async () => {
    setSelected(new Set());
    setConfirmCheckin(false);
    await refreshLeases();
  };

  const extend = async () => {
    setBusy(true);
    try {
      const results = await bulkSafeguardCheckout(
        extendable.map((p) => p.id),
        "Extended from lease manager"
      );
      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok && r.state !== "pending");
      if (ok > 0) toast.success({ title: `${ok} JIT ${ok === 1 ? "lease" : "leases"} extended` });
      if (failed.length > 0)
        toast.error({
          title: "Some leases could not be extended",
          description: failed.map((r) => `${r.label}: ${r.error ?? "failed"}`).join("; "),
        });
      await finish();
    } catch (e) {
      toast.error({
        title: "Extend failed",
        description: e instanceof Error ? e.message : "Unable to extend leases",
      });
    } finally {
      setBusy(false);
    }
  };

  const checkin = async () => {
    setBusy(true);
    try {
      const jit = checkinable.filter((p) => leaseKind(p) === "jit").map((p) => p.id);
      const checkouts = checkinable.filter((p) => leaseKind(p) === "checkout");
      const outcomes = await Promise.allSettled([
        ...(jit.length > 0 ? [safeguardCheckin(jit)] : []),
        ...checkouts.map((p) => checkinCheckout(p.checkout_id!)),
      ]);
      const failed = outcomes.filter((o) => o.status === "rejected").length;
      if (failed === 0)
        toast.success({
          title: `${checkinable.length} ${checkinable.length === 1 ? "lease" : "leases"} checked in`,
        });
      else
        toast.error({
          title: `${failed} check-in ${failed === 1 ? "request" : "requests"} failed`,
        });
      await finish();
    } finally {
      setBusy(false);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="lease-drawer-root">
      <div className="lease-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="lease-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Credential leases"
        tabIndex={-1}
      >
        <header className="lease-drawer-header">
          <div>
            <h2 className="lease-drawer-title">Credential Leases</h2>
            <p className="lease-drawer-sub">
              {groups.expired.length} expired · {groups.soon.length} expiring soon ·{" "}
              {groups.active.length} active
            </p>
          </div>
          <button
            type="button"
            className="toast-close lease-drawer-close"
            onClick={onClose}
            aria-label="Close lease manager"
          >
            <svg
              width="16"
              height="16"
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
        </header>

        <div className="lease-drawer-body">
          {profiles.length === 0 && (
            <p className="lease-drawer-empty">No credential profiles yet.</p>
          )}
          {(["expired", "soon", "active"] as Group[]).map((g) =>
            groups[g].length === 0 ? null : (
              <section key={g} className={`lease-group lease-group-${g}`}>
                <h3 className="lease-group-title">
                  {GROUP_TITLE[g]} <span>({groups[g].length})</span>
                </h3>
                <ul className="lease-list">
                  {groups[g].map((p) => {
                    const at = Date.parse(p.expires_at);
                    const names = targets[p.id];
                    return (
                      <li key={p.id} className="lease-row">
                        <input
                          type="checkbox"
                          className="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => toggle(p.id)}
                          aria-label={`Select ${p.label}`}
                        />
                        <div className="lease-row-main">
                          <div className="lease-row-top">
                            <span className="lease-row-label">{p.label}</span>
                            <span className="lease-kind">{KIND_LABEL[leaseKind(p)]}</span>
                          </div>
                          <div className="lease-row-targets">
                            {names === undefined
                              ? "Loading bindings…"
                              : names.length > 0
                                ? names.join(", ")
                                : "No connections bound"}
                          </div>
                        </div>
                        <span className={`lease-row-when lease-when-${g}`}>
                          {g === "expired"
                            ? `Expired ${formatAgo(at, now)}`
                            : `${formatLeft(at, now)} left`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )
          )}
        </div>

        <footer className="lease-drawer-footer">
          {chosen.length > 0 ? (
            <div className="lease-bulk">
              <span className="lease-bulk-count">{chosen.length} selected</span>
              <button
                type="button"
                className="toast-btn toast-btn-primary"
                disabled={busy || extendable.length === 0}
                onClick={extend}
                title={extendable.length === 0 ? "Only Safeguard JIT leases can be extended" : ""}
              >
                Extend{extendable.length > 0 ? ` ${extendable.length}` : ""} (JIT)
              </button>
              <button
                type="button"
                className="toast-btn toast-btn-danger"
                disabled={busy || checkinable.length === 0}
                onClick={() => (confirmCheckin ? checkin() : setConfirmCheckin(true))}
                title={
                  checkinable.length === 0
                    ? "Only active JIT or checkout leases can be checked in"
                    : ""
                }
              >
                {confirmCheckin ? `Confirm check-in (${checkinable.length})` : "Check in"}
              </button>
              <button
                type="button"
                className="toast-btn"
                disabled={busy}
                onClick={() => {
                  setSelected(new Set());
                  setConfirmCheckin(false);
                }}
                title="Deselect all"
              >
                Deselect
              </button>
            </div>
          ) : (
            <div className="lease-links">
              <Link to="/credentials" onClick={onClose}>
                Manage in Credentials
              </Link>
              {(user?.is_approver || user?.is_outbound_approver) && (
                <Link to="/approvals" onClick={onClose}>
                  Pending approvals
                </Link>
              )}
              {(user?.can_view_audit_logs || user?.can_manage_system) && (
                <Link to="/audit" onClick={onClose}>
                  Audit history
                </Link>
              )}
            </div>
          )}
        </footer>
      </div>
    </div>,
    document.body
  );
}
