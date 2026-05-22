/* eslint-disable react-hooks/set-state-in-effect, react-hooks/purity --
   prop->state sync + render-time time formatting are intentional. */
import { useEffect, useMemo, useState } from "react";
import {
  bulkSafeguardCheckout,
  getSafeguardSigninStatus,
  listSafeguardCached,
  safeguardCheckin,
  type BulkSafeguardCheckoutResult,
  type CredentialProfile,
  type SafeguardCachedStatus,
  type SafeguardSigninStatus,
} from "../../api";
import { useSettings } from "../../contexts/SettingsContext";

interface Props {
  profiles: CredentialProfile[];
  /** Pulled from the parent so we can hide when JIT is off entirely. */
  safeguardEnabled: boolean;
  /**
   * Bumped by the parent whenever the sibling sign-in card observes a
   * sign-in or sign-out, so this card can re-fetch its gating state
   * immediately rather than waiting for the 60s poll tick.
   */
  signinNonce?: number;
}

/**
 * Bulk pre-checkout card on the Credentials → Request Checkout tab.
 *
 * Lists every `kind === "safeguard"` profile the user owns, with
 * per-row "Cached — Xh left" badges, and lets the user check out a
 * batch of passwords up-front for the day. Each profile uses its own
 * `ttl_hours` (from the profile editor slider) as the requested
 * Safeguard checkout duration. When a row is already cached, the
 * backend checks the existing appliance request back in first so the
 * new checkout cleanly replaces it (no duplicate-open errors).
 */
export default function SafeguardBulkCheckoutCard(props: Props) {
  const { profiles, safeguardEnabled, signinNonce } = props;
  const { formatDateTime } = useSettings();

  const sgProfiles = useMemo(() => profiles.filter((p) => p.kind === "safeguard"), [profiles]);

  const [cached, setCached] = useState<SafeguardCachedStatus[]>([]);
  const [status, setStatus] = useState<SafeguardSigninStatus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [results, setResults] = useState<BulkSafeguardCheckoutResult[]>([]);

  const refresh = async () => {
    try {
      const [c, s] = await Promise.all([
        listSafeguardCached(),
        getSafeguardSigninStatus().catch(() => null),
      ]);
      setCached(c);
      setStatus(s);
    } catch {
      // best-effort
    }
  };

  useEffect(() => {
    if (!safeguardEnabled || sgProfiles.length === 0) return;
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [safeguardEnabled, sgProfiles.length, signinNonce]);

  if (!safeguardEnabled) return null;
  if (sgProfiles.length === 0) return null;

  const passwordCacheEnabled = !!status?.password_cache_enabled;
  // Sign-in gating: per_user_browser / hybrid modes need a live token
  // before we let the user select rows or submit. A2A mode has its
  // own appliance-trusted credentials, so we don't block it.
  const signinRequired = !!status && !status.signed_in && status.auth_mode !== "a2a";
  const selectionDisabled = !passwordCacheEnabled || signinRequired;

  const cacheByProfile = new Map(cached.map((c) => [c.profile_id, c]));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === sgProfiles.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sgProfiles.map((p) => p.id)));
    }
  };

  const handleCheckout = async () => {
    if (selected.size === 0) return;
    const trimmed = comment.trim();
    if (!trimmed) {
      setError("Safeguard requires a justification comment for password checkouts.");
      return;
    }
    setBusy(true);
    setError("");
    setResults([]);
    try {
      const ids = Array.from(selected);
      const res = await bulkSafeguardCheckout(ids, trimmed);
      setResults(res);
      // Clear selection for rows that succeeded so a retry only sends
      // the failed ones.
      const ok = new Set(res.filter((r) => r.ok).map((r) => r.profile_id));
      setSelected((prev) => {
        const next = new Set(prev);
        ok.forEach((id) => next.delete(id));
        return next;
      });
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Bulk checkout failed");
    } finally {
      setBusy(false);
    }
  };

  const hoursLeft = (expiresAt: string) => {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return 0;
    return Math.round((ms / 3_600_000) * 10) / 10;
  };

  /**
   * Release one (or all) cached Safeguard passwords back to the
   * appliance. Pass `null` to release everything currently cached.
   * Failures from the appliance are surfaced inline but we still
   * refresh the cache list so a stale-on-portal row doesn't keep
   * showing a phantom "Cached" badge.
   */
  const handleCheckin = async (profileId: string | null) => {
    setBusy(true);
    setError("");
    setResults([]);
    try {
      const ids = profileId ? [profileId] : [];
      const res = await safeguardCheckin(ids);
      const failed = res.filter((r) => !r.ok);
      if (failed.length > 0) {
        setError(failed.map((r) => r.error ?? `profile ${r.profile_id} failed`).join("; "));
      }
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Check-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card animate-fade-in mb-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="!mb-1">Safeguard bulk checkout</h3>
          <p className="text-xs text-txt-secondary !mb-0">
            Pre-fetch passwords for your Safeguard profiles in one go. Each password is sealed in
            Strata&apos;s vault for the duration set on that profile (the &quot;Password
            Expiry&quot; slider in the profile editor) so you only need to sign in to Safeguard once
            for the day.
          </p>
        </div>
      </div>

      {!passwordCacheEnabled && (
        <div className="rounded-sm mb-3 px-4 py-2 text-[0.8125rem] bg-warning-dim text-warning">
          Bulk checkout requires the administrator to enable Safeguard password caching (Admin →
          Safeguard → &quot;Cache checked-out passwords&quot;).
        </div>
      )}

      {status && !status.signed_in && status.auth_mode !== "a2a" && (
        <div className="rounded-sm mb-3 px-4 py-2 text-[0.8125rem] bg-warning-dim text-warning">
          You&apos;re currently signed out of Safeguard. Sign in above before attempting a bulk
          checkout.
        </div>
      )}

      {error && (
        <div className="rounded-sm mb-3 px-4 py-2 text-[0.8125rem] bg-danger-dim text-danger">
          {error}
        </div>
      )}

      <div className="mb-3">
        <label
          htmlFor="bulk-sg-comment"
          className="block text-xs font-medium text-txt-secondary mb-1"
        >
          Justification <span className="text-danger">*</span>
        </label>
        <textarea
          id="bulk-sg-comment"
          className="input w-full text-sm"
          rows={2}
          maxLength={500}
          placeholder="Why do you need these passwords? (Safeguard records this against every checkout)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          disabled={busy}
        />
        <p className="text-[0.6875rem] text-txt-tertiary mt-1">
          Sent to Safeguard as the ReasonComment for every selected profile.
        </p>
      </div>

      <div className="border border-border/50 rounded-md overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-bg-secondary/40 border-b border-border/50">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="checkbox"
              checked={selected.size === sgProfiles.length && sgProfiles.length > 0}
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && selected.size < sgProfiles.length;
              }}
              onChange={selectAll}
              aria-label="Select all Safeguard profiles"
              disabled={busy || selectionDisabled || sgProfiles.length === 0}
            />
            <span className="font-medium">
              {selected.size === 0 ? "Select all" : `${selected.size} selected`}
            </span>
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy || cached.length === 0 || signinRequired}
              onClick={() => handleCheckin(null)}
              title={
                signinRequired
                  ? "Sign in to Safeguard before checking passwords back in"
                  : "Release every Safeguard password currently cached for you"
              }
            >
              {busy ? "Working\u2026" : `Check in all (${cached.length})`}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={
                busy || selected.size === 0 || selectionDisabled || comment.trim().length === 0
              }
              onClick={handleCheckout}
            >
              {busy
                ? "Checking out…"
                : `Checkout selected${selected.size ? ` (${selected.size})` : ""}`}
            </button>
          </div>
        </div>
        <ul className="divide-y divide-border/50">
          {sgProfiles.map((p) => {
            const c = cacheByProfile.get(p.id);
            const result = results.find((r) => r.profile_id === p.id);
            const isCached = !!c;
            const left = c ? hoursLeft(c.expires_at) : 0;
            return (
              <li key={p.id} className="px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      className="checkbox flex-none"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                      disabled={busy || selectionDisabled}
                      aria-label={`Select ${p.label}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{p.label}</div>
                      <div className="text-xs text-txt-tertiary truncate">
                        Account {p.safeguard_account_id ?? "?"} · {p.safeguard_asset ?? "?"} ·
                        request {p.ttl_hours}h
                      </div>
                    </div>
                  </label>
                  <div className="flex-none flex items-center gap-2">
                    {isCached && (
                      <span
                        className="badge badge-success text-xs"
                        title={`Cached until ${formatDateTime(c!.expires_at)}`}
                      >
                        Cached · {left}h left
                      </span>
                    )}
                    {isCached && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        disabled={busy || signinRequired}
                        onClick={() => handleCheckin(p.id)}
                        title={
                          signinRequired
                            ? "Sign in to Safeguard before checking this password back in"
                            : "Release this cached password back to Safeguard"
                        }
                      >
                        Check in
                      </button>
                    )}
                    {result && (
                      <span
                        className={`badge text-xs ${result.ok ? "badge-success" : "badge-danger"}`}
                        title={result.error ?? undefined}
                      >
                        {result.ok
                          ? result.replaced_existing
                            ? "Refreshed"
                            : "Checked out"
                          : "Failed"}
                      </span>
                    )}
                  </div>
                </div>
                {result && !result.ok && result.error && (
                  <div className="text-[0.6875rem] text-danger mt-1 ml-8 break-words">
                    {result.error}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
