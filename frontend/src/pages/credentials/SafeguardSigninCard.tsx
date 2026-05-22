/* eslint-disable react-hooks/set-state-in-effect, react-hooks/purity --
   prop->state sync + render-time time formatting are intentional. */
import { useEffect, useMemo, useState } from "react";
import { useSettings } from "../../contexts/SettingsContext";
import {
  clearSafeguardToken,
  getSafeguardSigninStatus,
  submitSafeguardToken,
  type SafeguardSigninStatus,
} from "../../api";

/**
 * Per-user Safeguard sign-in card, shown on the Credentials page when
 * the admin has enabled Safeguard JIT in browser/RSTS mode.
 *
 * Flow (mirrors the existing PowerShell helper users already run for
 * Royal TS at Capita):
 *  1. User runs `Connect-Safeguard <fqdn> -Browser -IdentityProvider <alias>`
 *     in PowerShell, which opens a federated SSO browser window.
 *  2. After successful login, `$SGToken` holds a 15-minute Safeguard
 *     API access token.
 *  3. User pastes that token into Strata; we Vault-seal it server-side.
 *
 * No A2A registration on the Safeguard appliance is required — we
 * piggy-back on the same browser-SSO flow the Safeguard-PS module
 * uses.
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

  const refresh = async () => {
    try {
      const s = await getSafeguardSigninStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  const refreshAndNotify = async () => {
    await refresh();
    onStatusChange?.();
  };

  useEffect(() => {
    refresh();
    // Re-check status every minute so the "expires in N min" pill stays
    // honest and we drop the user back to signed-out as soon as the
    // 15-minute appliance token lapses.
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setBusy(true);
    setError("");
    try {
      await submitSafeguardToken(tokenInput.trim());
      setTokenInput("");
      setShowSignin(false);
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

  const psSnippet = useMemo(() => {
    if (!status) return "";
    const fqdn = status.appliance_fqdn || "<appliance-fqdn>";
    const idp = status.idp_alias || "<idp-alias>";
    // Safeguard-PS one-liner the user already has installed for the
    // existing Royal TS workflow at Capita. `-NoSessionVariable` skips
    // the module's global state pollution; `-NoWindowTitle` keeps the
    // launcher quiet.
    return `Install-Module -Name Safeguard-PS -Scope CurrentUser -Force -AllowClobber\n$SGToken = Connect-Safeguard ${fqdn} -Browser -IdentityProvider ${idp} -NoSessionVariable -NoWindowTitle\nSet-Clipboard $SGToken`;
  }, [status]);

  // Hide entirely when JIT is disabled or admin chose A2A-only mode.
  if (loading) return null;
  if (!status?.enabled) return null;
  if (status.auth_mode === "a2a") return null;

  const minutesLeft = status.expires_at
    ? Math.max(0, Math.round((new Date(status.expires_at).getTime() - Date.now()) / 60_000))
    : 0;

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
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setError("");
              setTokenInput("");
              setShowSignin(true);
            }}
            disabled={busy}
          >
            {status.signed_in ? "Refresh token" : "Sign in"}
          </button>
        </div>
      </div>

      {showSignin && (
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <div className="rounded-md border border-border/50 p-3 bg-bg-secondary/40 text-xs space-y-2">
            <div className="font-semibold">1. Run this in PowerShell</div>
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-all bg-bg-tertiary/60 rounded p-2 m-0">
              {psSnippet}
            </pre>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => navigator.clipboard.writeText(psSnippet)}
            >
              Copy snippet
            </button>
            <div className="text-txt-secondary">
              A browser window opens for federated sign-in. After it completes, your Safeguard API
              token is copied to the clipboard.
            </div>
          </div>

          <div className="form-group !mb-0">
            <label htmlFor="sg-token-paste">2. Paste the token from PowerShell ($SGToken)</label>
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

          {error && (
            <div className="rounded-md px-3 py-2 text-xs bg-danger/10 text-danger">{error}</div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowSignin(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !tokenInput.trim()}>
              {busy ? "Submitting…" : "Submit token"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
