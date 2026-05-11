/* Polls credential profiles and toasts on threshold crossings + expiry. */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { getCredentialProfiles, type CredentialProfile } from "../api";
import { useToast } from "./ToastProvider";

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
];
const EXTENDED_THRESHOLDS = [
  { secs: 7 * 24 * 3600, label: "7 days" },
  { secs: 24 * 3600, label: "1 day" },
  { secs: 3600, label: "1 hour" },
];

/** Sentinel threshold key recorded once a profile has expired so the
 *  "expired" toast fires exactly once per profile per browser. */
const EXPIRED_KEY = "expired";

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
    onRenew ?? (() => navigate("/credentials")),
  );
  useEffect(() => {
    renewRef.current = onRenew ?? (() => navigate("/credentials"));
  }, [onRenew, navigate]);

  useEffect(() => {
    let cancelled = false;

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

      const now = Date.now();
      const liveIds = new Set(profiles.map((p) => p.id));
      const fired = pruneFired(loadFired(), liveIds);
      let dirty = Object.keys(fired).length !== Object.keys(loadFired()).length;

      for (const profile of profiles) {
        // A checkout-bound profile has its expiry already capped on the
        // server side (the backend takes min(profile_ttl, checkout_ttl)),
        // so trusting `profile.expires_at` is correct in both cases.
        const expiresAtMs = Date.parse(profile.expires_at);
        if (!Number.isFinite(expiresAtMs)) continue;

        const secsLeft = Math.floor((expiresAtMs - now) / 1000);
        const thresholds = profile.extended_expiry
          ? EXTENDED_THRESHOLDS
          : STANDARD_THRESHOLDS;

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
            toast.error({
              title: `${profile.label} has expired`,
              description:
                "The stored credential will not be used until you renew it. " +
                "Renew now to keep this profile available for connections.",
              key: `cred-expiry:${profile.id}`,
              action: {
                label: "Renew now",
                onClick: () => renewRef.current(profile),
              },
            });
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
          toast.warning({
            title: `${profile.label} expires in ${toFire.label}`,
            description:
              "Renew the stored credential before it expires to avoid " +
              "interrupting connections that depend on this profile.",
            key: `cred-expiry:${profile.id}`,
            action: {
              label: "Renew now",
              onClick: () => renewRef.current(profile),
            },
          });
        }
      }

      if (dirty) saveFired(fired);
    }

    // Run once on mount, then on a steady cadence. The initial call lets a
    // freshly-opened tab discover an already-expired profile right away.
    void evaluate();
    const id = setInterval(() => void evaluate(), pollIntervalMs);

    // Re-evaluate immediately when the tab regains focus or visibility so
    // sleeping for hours doesn't suppress an "expired" toast that should
    // already have fired.
    function onWake() {
      void evaluate();
    }
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);

    // Cross-tab dedupe: when another tab writes to the storage key, reload
    // it on the next tick so this tab's in-memory view stays consistent
    // with the persisted record.
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) void evaluate();
    }
    window.addEventListener("storage", onStorage);

    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("storage", onStorage);
    };
  }, [toast, pollIntervalMs]);

  return null;
}
