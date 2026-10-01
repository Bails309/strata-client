/* Polls credential profiles and toasts on threshold crossings + expiry. */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { bulkSafeguardCheckout, getCredentialProfiles, type CredentialProfile } from "../api";
import { useToast } from "./ToastProvider";
import { pollWhileVisible } from "./pollWhileVisible";
import LeaseBatchBody, { type LeaseItem } from "./LeaseBatchBody";
import {
  canRenewInPlace,
  EXPIRED_TOAST,
  formatRemaining,
  isLeaseExpired,
  publishLeases,
  registerLeaseRefresher,
  WARNING_TOAST,
} from "./leaseStore";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Tunables                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** Poll interval. The endpoint is a single-row-per-profile SELECT so 60 s is
 *  cheap; the timer is anchored on absolute timestamps so a sleeping tab
 *  re-syncs on wake without firing stale toasts. */
const POLL_INTERVAL_MS = 60_000;

/** localStorage namespace for fired-threshold tracking. Keyed on
 *  `profileId:thresholdSecs` so that closing a tab and re-opening it does
 *  not re-fire the same warning, and so that two tabs do not double-up. */
const STORAGE_KEY = "strata.credExpiryFired.v1";

/** Per-mode warning thresholds (seconds before expiry). Picked to match the
 *  TTL — a 12-hour profile must not get a 7-day warning, and a 90-day
 *  profile must not get a 10-minute warning. */
const STANDARD_THRESHOLDS = [
  { secs: 24 * 3600, label: "1 day" },
  { secs: 3600, label: "1 hour" },
  { secs: 600, label: "10 minutes" },
  { secs: 300, label: "5 minutes" },
];
const EXTENDED_THRESHOLDS = [
  { secs: 7 * 24 * 3600, label: "7 days" },
  { secs: 24 * 3600, label: "1 day" },
  { secs: 3600, label: "1 hour" },
  { secs: 300, label: "5 minutes" },
];

/** Sentinel threshold key recorded once a profile has expired so the
 *  "expired" toast fires exactly once per profile per browser. */
const EXPIRED_KEY = "expired";

/** Every expiry lands in one toast and every pre-expiry warning in another;
 *  a second item arriving while the toast is unread turns it into a batch. */
const BATCH_WARNING_MS = 20_000;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Storage helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/** A fired-threshold record is `{ "<profileId>:<thresholdSecs>": <expiresAtMs> }`.
 *  Storing the expiry millis means we can detect a TTL re-issue (the
 *  `expires_at` jumps to a different absolute timestamp) and re-arm every
 *  threshold for the new window. */
type FiredMap = Record<string, number>;

function loadFired(): FiredMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as FiredMap;
  } catch {
    return {};
  }
}

function saveFired(map: FiredMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / privacy mode — best-effort */
  }
}

/** Drop tracker entries for profiles that no longer exist on the server.
 *  Keeps the storage record from growing without bound across deletes. */
function pruneFired(map: FiredMap, liveProfileIds: Set<string>): FiredMap {
  const next: FiredMap = {};
  for (const [k, v] of Object.entries(map)) {
    const profileId = k.split(":", 1)[0];
    if (liveProfileIds.has(profileId)) next[k] = v;
  }
  return next;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Component                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export interface CredentialProfileExpiryWatcherProps {
  /** Called when the user clicks the "Renew now" action. Defaults to
   *  navigating to `/credentials`. Provided as a hook so tests (and a
   *  future deep-link to a specific profile editor) can intercept. */
  onRenew?: (profile: CredentialProfile) => void;
  /** Override for the poll interval (used by tests to compress time). */
  pollIntervalMs?: number;
}

export default function CredentialProfileExpiryWatcher({
  onRenew,
  pollIntervalMs = POLL_INTERVAL_MS,
}: CredentialProfileExpiryWatcherProps = {}) {
  const toast = useToast();
  const navigate = useNavigate();

  // Hold the latest renew callback in a ref so the polling effect doesn't
  // re-arm its setInterval on every parent re-render.
  const renewRef = useRef<(p: CredentialProfile) => void>(
    onRenew ?? (() => navigate("/credentials"))
  );
  const navigateRef = useRef(navigate);
  useEffect(() => {
    renewRef.current = onRenew ?? (() => navigate("/credentials"));
    navigateRef.current = navigate;
  }, [onRenew, navigate]);

  // Unread items per toast, keyed by profile id. Cleared when the toast is
  // dismissed; pruned when a lease is renewed or deleted.
  const unreadExpiredRef = useRef(new Map<string, LeaseItem>());
  const unreadWarningRef = useRef(new Map<string, LeaseItem & { secs: number }>());

  useEffect(() => {
    let cancelled = false;

    const extendAll = async (items: LeaseItem[]) => {
      const ids = items.filter((i) => canRenewInPlace(i.profile)).map((i) => i.profile.id);
      if (ids.length === 0) return;
      try {
        const results = await bulkSafeguardCheckout(ids, "Extended from lease notification");
        const ok = results.filter((r) => r.ok).length;
        const pending = results.filter((r) => r.state === "pending").length;
        if (ok > 0) toast.success({ title: `${ok} JIT ${ok === 1 ? "lease" : "leases"} extended` });
        if (pending > 0)
          toast.info({
            title: `${pending} JIT ${pending === 1 ? "request is" : "requests are"} awaiting approval`,
          });
        if (ok + pending < results.length)
          toast.error({
            title: "Some leases could not be extended",
            description: results
              .filter((r) => !r.ok && r.state !== "pending")
              .map((r) => `${r.label}: ${r.error ?? "failed"}`)
              .join("; "),
          });
      } catch (e) {
        toast.error({
          title: "Extend failed",
          description: e instanceof Error ? e.message : "Unable to extend leases",
        });
      }
      await evaluate();
    };

    const publishExpired = () => {
      const items = [...unreadExpiredRef.current.values()];
      const clear = () => unreadExpiredRef.current.clear();
      if (items.length === 0) {
        toast.dismiss(EXPIRED_TOAST);
        return;
      }
      if (items.length === 1) {
        const { profile, atMs } = items[0];
        toast.error({
          key: EXPIRED_TOAST,
          title: `${profile.label} has expired`,
          description:
            "The stored credential will not be used until you renew it. " +
            "Renew now to keep this profile available for connections.",
          details: [{ label: "Expired", value: new Date(atMs).toLocaleString() }],
          action: { label: "Renew now", onClick: () => renewRef.current(profile) },
          onDismiss: clear,
        });
        return;
      }
      toast.error({
        key: EXPIRED_TOAST,
        title: `${items.length} Privileged Credentials Expired`,
        description:
          "These credential leases have ended. Connections that use them will fail until they are renewed.",
        content: (
          <LeaseBatchBody
            mode="expired"
            items={items}
            onDismissAll={() => toast.dismiss(EXPIRED_TOAST)}
            onExtendAll={() => extendAll(items)}
            onViewVault={() => {
              toast.dismiss(EXPIRED_TOAST);
              navigateRef.current("/credentials");
            }}
          />
        ),
        onDismiss: clear,
      });
    };

    const publishWarnings = () => {
      const items = [...unreadWarningRef.current.values()];
      const clear = () => unreadWarningRef.current.clear();
      if (items.length === 0) {
        toast.dismiss(WARNING_TOAST);
        return;
      }
      const soonest = Math.min(...items.map((i) => i.atMs));
      if (items.length === 1) {
        const { profile, atMs } = items[0];
        toast.warning({
          key: WARNING_TOAST,
          title: `${profile.label} expires in ${formatRemaining(atMs)}`,
          description:
            "Renew the stored credential before it expires to avoid " +
            "interrupting connections that depend on this profile.",
          details: [{ label: "Expires", value: new Date(atMs).toLocaleString() }],
          action: { label: "Renew now", onClick: () => renewRef.current(profile) },
          onDismiss: clear,
        });
        return;
      }
      toast.warning({
        key: WARNING_TOAST,
        title: `${items.length} credential leases expiring, the first in ${formatRemaining(soonest)}`,
        description: "Extend or renew them now to avoid interrupting connections.",
        duration: BATCH_WARNING_MS,
        content: (
          <LeaseBatchBody
            mode="warning"
            items={items}
            onDismissAll={() => toast.dismiss(WARNING_TOAST)}
            onExtendAll={() => extendAll(items)}
            onViewVault={() => {
              toast.dismiss(WARNING_TOAST);
              navigateRef.current("/credentials");
            }}
          />
        ),
        onDismiss: clear,
      });
    };

    async function evaluate(): Promise<void> {
      let profiles: CredentialProfile[];
      try {
        profiles = await getCredentialProfiles();
      } catch {
        // Network errors / 401s are surfaced elsewhere; the watcher stays
        // silent rather than spamming an unrelated toast.
        return;
      }
      if (cancelled) return;
      publishLeases(profiles);

      const now = Date.now();
      const liveIds = new Set(profiles.map((p) => p.id));
      const fired = pruneFired(loadFired(), liveIds);
      let dirty = Object.keys(fired).length !== Object.keys(loadFired()).length;
      const newExpired: LeaseItem[] = [];
      const newWarnings: (LeaseItem & { secs: number })[] = [];

      for (const profile of profiles) {
        // A checkout-bound profile has its expiry already capped on the
        // server side (the backend takes min(profile_ttl, checkout_ttl)),
        // so trusting `profile.expires_at` is correct in both cases.
        const expiresAtMs = Date.parse(profile.expires_at);
        if (!Number.isFinite(expiresAtMs)) continue;

        const secsLeft = Math.floor((expiresAtMs - now) / 1000);
        const allThresholds = profile.extended_expiry ? EXTENDED_THRESHOLDS : STANDARD_THRESHOLDS;

        // Drop thresholds that are wider than (or equal to) the profile's
        // own TTL window — those would be "crossed" the moment the profile
        // is created, which is not what the user means by a pre-expiry
        // warning. e.g. a freshly-created 12-hour standard profile must
        // not get a 1-day toast on first poll; the 1-hour and 10-minute
        // warnings still fire as the deadline approaches.
        const ttlSecs = (profile.ttl_hours * 60 + (profile.ttl_minutes ?? 0)) * 60;
        const thresholds = allThresholds.filter((t) => t.secs < ttlSecs);

        // Re-arm: if the profile's expires_at has shifted (TTL re-issued,
        // extended_expiry toggled, password rotated) drop every prior
        // record for this profile so the new window can fire fresh
        // warnings. Compare with a 2 s slack to absorb clock skew.
        for (const key of Object.keys(fired)) {
          if (!key.startsWith(`${profile.id}:`)) continue;
          if (Math.abs(fired[key] - expiresAtMs) > 2000) {
            delete fired[key];
            dirty = true;
          }
        }

        // Expired branch — fire once, then the entry sits in the map until
        // the profile is deleted or its expiry is renewed.
        if (profile.expired || secsLeft <= 0) {
          const k = `${profile.id}:${EXPIRED_KEY}`;
          if (!(k in fired)) {
            fired[k] = expiresAtMs;
            dirty = true;
            newExpired.push({ profile, atMs: expiresAtMs });
          }
          continue;
        }

        // Pre-expiry warnings — fire only the **tightest** threshold the
        // user has currently crossed. If a freshly-opened tab is already
        // inside the 1-hour window we don't want the wider 1-day toast to
        // appear first; and once a tighter threshold has fired, the wider
        // ones must stay silent for the rest of this expiry window.
        // Iterate tightest-first; mark every crossed threshold as fired
        // (so wider ones never publish later) but only emit a toast for
        // the tightest previously-unfired one.
        const sorted = thresholds.slice().sort((a, b) => a.secs - b.secs);
        let toFire: (typeof sorted)[number] | null = null;
        for (const t of sorted) {
          if (secsLeft > t.secs) continue; // window not entered yet
          const k = `${profile.id}:${t.secs}`;
          if (k in fired) continue;
          if (toFire === null) toFire = t; // tightest unfired
          fired[k] = expiresAtMs;
          dirty = true;
        }
        if (toFire) {
          newWarnings.push({
            profile,
            atMs: expiresAtMs,
            label: toFire.label,
            secs: toFire.secs,
          });
        }
      }

      if (dirty) saveFired(fired);

      // Drop unread items whose lease was renewed, re-issued or deleted.
      const byId = new Map(profiles.map((p) => [p.id, p]));
      let expiredChanged = newExpired.length > 0;
      for (const [id, item] of unreadExpiredRef.current) {
        const p = byId.get(id);
        if (!p || !isLeaseExpired(p, now)) {
          unreadExpiredRef.current.delete(id);
          expiredChanged = true;
        } else item.profile = p;
      }
      let warningsChanged = newWarnings.length > 0;
      for (const [id] of unreadWarningRef.current) {
        const p = byId.get(id);
        const shifted =
          !p || Math.abs(Date.parse(p.expires_at) - unreadWarningRef.current.get(id)!.atMs) > 2000;
        if (!p || shifted || isLeaseExpired(p, now)) {
          unreadWarningRef.current.delete(id);
          warningsChanged = true;
        }
      }
      for (const item of newExpired) unreadExpiredRef.current.set(item.profile.id, item);
      for (const item of newWarnings) unreadWarningRef.current.set(item.profile.id, item);

      if (expiredChanged) publishExpired();
      if (warningsChanged) publishWarnings();
    }

    const unregister = registerLeaseRefresher(evaluate);

    // Runs at once, so a freshly-opened tab discovers an already-expired
    // profile; pauses while hidden and catches up when shown, so a tab that
    // slept for hours still raises the "expired" toast.
    const stopPolling = pollWhileVisible(evaluate, pollIntervalMs);

    // Cross-tab dedupe: when another tab writes to the storage key, reload
    // it on the next tick so this tab's in-memory view stays consistent
    // with the persisted record.
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) void evaluate();
    }
    window.addEventListener("storage", onStorage);

    return () => {
      cancelled = true;
      unregister();
      stopPolling();
      window.removeEventListener("storage", onStorage);
    };
  }, [toast, pollIntervalMs]);

  return null;
}
