/* Body of the grouped lease toast: a compact credential matrix with inline
   expansion and bulk actions (extend JIT leases, dismiss, open the vault). */
import { useEffect, useState } from "react";
import { getProfileMappings, type CredentialProfile } from "../api";
import { useToastHold } from "./ToastProvider";
import { canRenewInPlace, formatAgo, formatLeft, leaseKind, useNow } from "./leaseStore";

export interface LeaseItem {
  profile: CredentialProfile;
  /** Expiry instant (ms since epoch). */
  atMs: number;
  /** Threshold label for pre-expiry warnings, e.g. "5 minutes". */
  label?: string;
}

const COLLAPSED_ROWS = 3;
const KIND_LABEL = { local: "Local", jit: "JIT", checkout: "Checkout" } as const;

const targetCache = new Map<string, string[]>();

/** Connection names each profile is mapped to, fetched once per profile. */
export function useLeaseTargets(profileIds: string[]): Record<string, string[]> {
  const [, setVersion] = useState(0);
  const idsKey = profileIds.join(",");

  useEffect(() => {
    let cancelled = false;
    const missing = idsKey.split(",").filter((id) => id && !targetCache.has(id));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (id) => {
        try {
          const rows = await getProfileMappings(id);
          targetCache.set(
            id,
            rows.map((r) => r.connection_name)
          );
        } catch {
          targetCache.set(id, []);
        }
      })
    ).then(() => {
      if (!cancelled) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  return Object.fromEntries(
    profileIds.filter((id) => targetCache.has(id)).map((id) => [id, targetCache.get(id)!])
  );
}

/** Forget cached mappings (e.g. after the user edits them). */
export function clearLeaseTargetCache(): void {
  targetCache.clear();
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export default function LeaseBatchBody({
  mode,
  items,
  onDismissAll,
  onExtendAll,
  onViewVault,
}: {
  mode: "expired" | "warning";
  items: LeaseItem[];
  onDismissAll: () => void;
  onExtendAll: () => Promise<void>;
  onViewVault: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(30_000);
  const targets = useLeaseTargets(items.map((i) => i.profile.id));
  useToastHold(busy || expanded);

  // Esc = Dismiss All, unless the user is typing or a modal owns the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      onDismissAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismissAll]);

  const sorted = items.slice().sort((a, b) => a.atMs - b.atMs);
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_ROWS);
  const hidden = sorted.length - visible.length;
  const renewable = items.filter((i) => canRenewInPlace(i.profile)).length;

  const extend = async () => {
    setBusy(true);
    try {
      await onExtendAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="toast-details toast-lease-matrix">
        {visible.map(({ profile, atMs }) => {
          const names = targets[profile.id];
          return (
            <div key={profile.id} className="toast-lease-row">
              <span className="toast-lease-account">
                <span className="toast-detail-value">{profile.label}</span>
                <span className="toast-detail-meta"> ({KIND_LABEL[leaseKind(profile)]})</span>
              </span>
              <span className="toast-lease-target" title={names?.join(", ")}>
                {names === undefined ? "…" : names.length > 0 ? names.join(", ") : "No connections"}
              </span>
              <span className="toast-lease-when">
                {mode === "expired"
                  ? `Expired ${formatAgo(atMs, now)}`
                  : `in ${formatLeft(atMs, now)}`}
              </span>
            </div>
          );
        })}
        {sorted.length > COLLAPSED_ROWS && (
          <button
            type="button"
            className="toast-lease-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded
              ? "Show less"
              : `+ ${hidden} more ${hidden === 1 ? "credential" : "credentials"}…`}
          </button>
        )}
      </div>

      <div className="toast-actions toast-lease-actions">
        {renewable > 0 && (
          <button
            type="button"
            className="toast-btn toast-btn-primary"
            onClick={extend}
            disabled={busy}
          >
            {busy
              ? "Extending…"
              : renewable === items.length
                ? "Extend All (JIT)"
                : `Extend ${renewable} JIT`}
          </button>
        )}
        <button type="button" className="toast-btn" onClick={onDismissAll} title="Esc">
          Dismiss All
        </button>
        <button type="button" className="toast-btn toast-lease-vault" onClick={onViewVault}>
          View Vault
        </button>
      </div>
    </>
  );
}
