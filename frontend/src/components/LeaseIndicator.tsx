/* Header pill summarising credential leases; opens the lease manager. */
import { useCallback, useState } from "react";
import type { MeResponse } from "../api";
import LeaseDrawer from "./LeaseDrawer";
import { useOptionalToast } from "./ToastProvider";
import {
  EXPIRED_TOAST,
  formatLeft,
  isLeaseExpired,
  useLeases,
  useNow,
  WARNING_TOAST,
} from "./leaseStore";
import "./Lease.css";

const SOON_MS = 60 * 60 * 1000;

export default function LeaseIndicator({ user }: { user?: MeResponse | null }) {
  const { profiles } = useLeases();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const toast = useOptionalToast();

  if (!profiles || profiles.length === 0) return null;

  const expired = profiles.filter((p) => isLeaseExpired(p, now));
  const active = profiles.filter((p) => !isLeaseExpired(p, now));
  const soonest = active.reduce<number | null>((min, p) => {
    const at = Date.parse(p.expires_at);
    return Number.isFinite(at) && (min === null || at < min) ? at : min;
  }, null);

  let tone: "expired" | "soon" | "ok";
  let label: string;
  if (expired.length > 0) {
    tone = "expired";
    label = `${expired.length} ${expired.length === 1 ? "Lease" : "Leases"} Expired`;
  } else if (soonest !== null && soonest - now <= SOON_MS) {
    tone = "soon";
    label = `${active.length} Active · ${formatLeft(soonest, now)} left`;
  } else {
    tone = "ok";
    label = `${active.length} Active ${active.length === 1 ? "Lease" : "Leases"}`;
  }

  return (
    <>
      <button
        // Remounts when the expired count changes so the pulse plays once.
        key={expired.length}
        type="button"
        className={`lease-pill lease-pill-${tone} ${tone === "expired" ? "lease-pill-pulse" : ""}`}
        onClick={() => {
          // The manager shows everything the lease toasts would; clear them.
          toast?.dismiss(EXPIRED_TOAST);
          toast?.dismiss(WARNING_TOAST);
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="lease-pill-dot" aria-hidden="true" />
        {label}
      </button>
      {open && <LeaseDrawer profiles={profiles} user={user} onClose={close} />}
    </>
  );
}
