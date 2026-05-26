/* eslint-disable react-hooks/set-state-in-effect, react-hooks/purity --
   prop->state sync + render-time time formatting are intentional. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../../contexts/SettingsContext";
import {
  clearSafeguardToken,
  getSafeguardSigninStatus,
  startSafeguardSignin,
  submitSafeguardToken,
  type SafeguardSigninStatus,
} from "../../api";

/**
 * Per-user Safeguard sign-in card, shown on the Credentials page when
 * the admin has enabled Safeguard JIT in browser/RSTS mode.
 *
 * Flow (auto-post, v1.10.2):
 *  1. User clicks **Sign in** — frontend mints a one-shot enrolment
 *     code via `POST /api/user/safeguard/signin/start`.
 *  2. Card renders a PowerShell snippet that runs
 *     `Connect-Safeguard -Browser`, then `Invoke-RestMethod`s
 *     `{ code, token }` to `POST /api/safeguard/enrol`.
 *  3. While the modal is open, the card polls
 *     `GET /api/user/safeguard/status` every 2s. As soon as
 *     `signed_in = true` the modal closes itself.
 *
 * Fallback (collapsed under "Having trouble?"): the user can still
 * paste the token by hand — same endpoint the v1.10.0 card used,
 * unchanged.
 */
export default function SafeguardSigninCard({
  onStatusChange,
}: {
  /**
   * Fired after every successful sign-in / sign-out / status refresh
   * so sibling cards (e.g. the bulk-checkout card) can re-fetch their
   * own state without waiting for the next 60s poll tick.
   */
  onStatusChange?: () => void;
} = {}) {
  const { formatDateTime } = useSettings();
  const [status, setStatus] = useState<SafeguardSigninStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSignin, setShowSignin] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [enrolment, setEnrolment] = useState<{
    code: string;
    expires_at: string;
  } | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Suppresses the auto-close path when the user has cancelled the
  // modal between two polling ticks.
  const cancelled = useRef(false);

  const refresh = async () => {
    try {
      const s = await getSafeguardSigninStatus();
      setStatus(s);
      return s;
    } catch {
      setStatus(null);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const refreshAndNotify = async () => {
    const s = await refresh();
    onStatusChange?.();
    return s;
  };

  useEffect(() => {
    refresh();
    // Re-check status every minute so the "expires in N min" pill stays
    // honest and we drop the user back to signed-out as soon as the
    // 15-minute appliance token lapses.
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, []);

  // Fast poll + countdown ticker, scoped to "modal open & waiting for
  // the PS snippet to POST the token back". Polls /status every 2s;
  // closes the modal as soon as the backend reports the token landed.
  useEffect(() => {
    if (!showSignin || !enrolment) return;
    cancelled.current = false;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      const s = await refresh();
      if (cancelled.current) return;
      if (s?.signed_in) {
        setShowSignin(false);
        setEnrolment(null);
        setTokenInput("");
        setShowFallback(false);
        onStatusChange?.();
      }
    }, 2000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [showSignin, enrolment, onStatusChange]);

  const handleStart = async () => {
    setBusy(true);
    setError("");
    try {
      const e = await startSafeguardSignin();
      setEnrolment(e);
      setTokenInput("");
      setShowFallback(false);
      setShowSignin(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start sign-in");
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    cancelled.current = true;
    setShowSignin(false);
    setEnrolment(null);
    setTokenInput("");
    setError("");
    setShowFallback(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setBusy(true);
    setError("");
    try {
      await submitSafeguardToken(tokenInput.trim());
      setTokenInput("");
      setShowSignin(false);
      setEnrolment(null);
      setShowFallback(false);
      await refreshAndNotify();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to submit token");
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    setBusy(true);
    try {
      await clearSafeguardToken();
      await refreshAndNotify();
    } finally {
      setBusy(false);
    }
  };

  const enrolEndpoint = useMemo(
    // Use the page origin so the rendered snippet works regardless
    // of subpath / custom port / split DNS.
    () => `${window.location.origin}/api/safeguard/enrol`,
    []
  );

  const psSnippet = useMemo(() => {
    if (!status) return "";
    const fqdn = status.appliance_fqdn || "<appliance-fqdn>";
    const idp = status.idp_alias || "<idp-alias>";
    const code = enrolment?.code ?? "<click Sign in to get a code>";
    // Backticks here are PowerShell line continuations, not JS template marks.
    return [
      "Set-ExecutionPolicy RemoteSigned -Scope CurrentUser",
      "if (-not (Get-Module -ListAvailable -Name Safeguard-PS)) {",
      "  Install-Module -Name Safeguard-PS -Scope CurrentUser -Force -AllowClobber",
      "}",
      `$SGToken = Connect-Safeguard ${fqdn} -Browser -IdentityProvider ${idp} -NoSessionVariable -NoWindowTitle`,
      "Invoke-RestMethod -Method POST `",
      `  -Uri '${enrolEndpoint}' \``,
      "  -ContentType 'application/json' `",
      `  -Body (@{ code = '${code}'; token = $SGToken } | ConvertTo-Json) | Out-Null`,
      "Write-Host '[OK] Strata sign-in complete. You can close this window.'",
    ].join("\n");
  }, [status, enrolment, enrolEndpoint]);

  // Hide entirely when JIT is disabled or admin chose A2A-only mode.
  if (loading) return null;
  if (!status?.enabled) return null;
  if (status.auth_mode === "a2a") return null;

  const minutesLeft = status.expires_at
    ? Math.max(0, Math.round((new Date(status.expires_at).getTime() - Date.now()) / 60_000))
    : 0;

  const codeSecondsLeft = enrolment
    ? Math.max(0, Math.round((new Date(enrolment.expires_at).getTime() - now) / 1000))
    : 0;
  const codeExpired = enrolment !== null && codeSecondsLeft <= 0;

  return (
    <section className="card animate-fade-in mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="!mb-1 flex items-center gap-2">
            Safeguard sign-in
            {status.signed_in ? (
              <span className="badge badge-success text-xs">
                Signed in · {minutesLeft} min left
              </span>
            ) : (
              <span className="badge badge-warning text-xs">Signed out</span>
            )}
          </h3>
          <p className="text-xs text-txt-secondary !mb-0">
            Safeguard JIT credentials check out as <strong>you</strong> against{" "}
            <code className="text-[11px]">{status.appliance_fqdn}</code>. Sign in with the
            PowerShell helper to mint a 15-minute API token; Strata stores it Vault-sealed and uses
            it for every JIT checkout you trigger during your session.
            {status.signed_in && status.expires_at && (
              <>
                {" "}
                Current token expires at <strong>{formatDateTime(status.expires_at)}</strong>.
              </>
            )}
          </p>
        </div>
        <div className="flex-none flex gap-2">
          {status.signed_in && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleSignOut}
              disabled={busy}
            >
              Sign out
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={handleStart} disabled={busy}>
            {status.signed_in ? "Refresh token" : "Sign in"}
          </button>
        </div>
      </div>

      {showSignin && enrolment && (
        <div className="mt-4 space-y-3">
          <div className="rounded-md border border-border/50 p-3 bg-bg-secondary/40 text-xs space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">Run this in PowerShell</div>
              {codeExpired ? (
                <span className="badge badge-danger text-xs">Code expired</span>
              ) : (
                <span className="badge badge-info text-xs">
                  Waiting for sign-in · {Math.floor(codeSecondsLeft / 60)}:
                  {String(codeSecondsLeft % 60).padStart(2, "0")} left
                </span>
              )}
            </div>
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-bg-tertiary/60 rounded p-2 m-0">
              {psSnippet}
            </pre>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => navigator.clipboard.writeText(psSnippet)}
              >
                Copy snippet
              </button>
              {codeExpired && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleStart}
                  disabled={busy}
                >
                  Get a new code
                </button>
              )}
            </div>
            <div className="text-txt-secondary">
              A browser window opens for federated sign-in. After it completes, PowerShell sends
              your token back to Strata automatically — this card will flip to{" "}
              <strong>Signed in</strong> within a couple of seconds.
            </div>
          </div>

          <div className="text-xs">
            <button
              type="button"
              className="text-txt-secondary underline decoration-dotted hover:text-txt-primary"
              onClick={() => setShowFallback((v) => !v)}
            >
              {showFallback ? "Hide manual paste" : "Having trouble? Paste the token manually"}
            </button>
          </div>

          {showFallback && (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="form-group !mb-0">
                <label htmlFor="sg-token-paste">
                  Paste the value of <code className="text-[11px]">$SGToken</code> from PowerShell
                </label>
                <textarea
                  id="sg-token-paste"
                  rows={3}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="eyJ... (long base64 string)"
                  className="font-mono text-[11px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy || !tokenInput.trim()}
                >
                  {busy ? "Submitting…" : "Submit token"}
                </button>
              </div>
            </form>
          )}

          {error && (
            <div className="rounded-md px-3 py-2 text-xs bg-danger/10 text-danger">{error}</div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleCancel}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && !showSignin && (
        <div className="rounded-md px-3 py-2 mt-3 text-xs bg-danger/10 text-danger">{error}</div>
      )}
    </section>
  );
}
