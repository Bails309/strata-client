import { useEffect, useState } from "react";
import {
  getSafeguardConfig,
  updateSafeguardConfig,
  testSafeguardConnection,
  SafeguardConfig,
  SafeguardAuthMode,
  SafeguardTestOutcome,
  ApiError,
} from "../../api";
import Select from "../../components/Select";

/**
 * Admin → Safeguard JIT tab.
 *
 * One-row configurator for the OneIdentity Safeguard integration. The
 * page is the single source of truth: nothing about the appliance is
 * hard-coded server-side. Secret fields (A2A API key, client cert,
 * client key) round-trip with a `********` mask — leave them as-is to
 * keep, clear them to remove, or paste a new value to replace.
 *
 * Master kill-switch: when `enabled` is off, the credential-profile
 * kind selector hides the "Safeguard JIT" option throughout the rest
 * of the app (existing safeguard-backed profiles continue to behave
 * like an expired managed credential — same UX as a stale rotation).
 */
const AUTH_MODES: { value: SafeguardAuthMode; label: string; help: string }[] = [
  {
    value: "per_user_browser",
    label: "Per-user browser SSO (RSTS)",
    help: "Each user signs in to Safeguard via federation in their own browser using the Safeguard-PS helper (Connect-Safeguard -Browser -IdentityProvider <alias>), then submits the resulting API token to Strata. Strata stores it Vault-sealed and uses it for that user's JIT checkouts. Requires no Safeguard admin involvement.",
  },
  {
    value: "a2a",
    label: "Application-to-Application (A2A)",
    help: "Strata authenticates as a single registered identity. Safeguard's audit shows 'Strata' as the requester; Strata's own audit records which user triggered each checkout.",
  },
  {
    value: "hybrid",
    label: "Hybrid (per-user + A2A fallback)",
    help: "Per-user browser token when the user has signed in; A2A as a fallback for shared automation accounts or users who have not yet signed in.",
  },
];

export default function SafeguardTab({ onSave }: { onSave: () => void }) {
  const [cfg, setCfg] = useState<SafeguardConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SafeguardTestOutcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    getSafeguardConfig()
      .then((c) => {
        if (!cancelled) setCfg(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadError(
            e instanceof ApiError || e instanceof Error
              ? e.message
              : "Failed to load Safeguard config"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof SafeguardConfig>(key: K, value: SafeguardConfig[K]) {
    setCfg((c) => (c ? { ...c, [key]: value } : c));
  }

  async function handleSave() {
    if (!cfg) return;
    setSaving(true);
    setSaveError("");
    try {
      const updated = await updateSafeguardConfig(cfg);
      setCfg(updated);
      onSave();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!cfg) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testSafeguardConnection(cfg);
      setTestResult(r);
    } catch (e: unknown) {
      setTestResult({
        ok: false,
        message: e instanceof Error ? e.message : "Test failed",
        steps: [],
      });
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <div className="card animate-fade-in">Loading…</div>;
  if (loadError)
    return (
      <div className="card animate-fade-in">
        <div className="rounded-md px-4 py-2 bg-danger/10 text-danger">{loadError}</div>
      </div>
    );
  if (!cfg) return null;

  return (
    <div className="card animate-fade-in space-y-6">
      <div>
        <h2 className="!mb-1">Safeguard JIT</h2>
        <p className="text-xs text-txt-secondary">
          Automatically check out managed-account passwords from a OneIdentity Safeguard appliance
          at tunnel-open time. Passwords are never persisted in Strata.
        </p>
      </div>

      {/* ── Master toggle (justified row card) ── */}
      <section className="border border-border/50 rounded-md px-4 py-3 flex items-center justify-between gap-4">
        <div>
          <div className="font-semibold text-sm">Enable Safeguard JIT</div>
          <div className="text-xs text-txt-secondary mt-1">
            When off, the &quot;Safeguard JIT&quot; credential kind is hidden across the UI and any
            existing safeguard-backed profiles behave like an expired managed credential. When on,
            access is still gated <em>per user</em> by the &quot;Safeguard JIT&quot; checkbox on the
            Access tab — onboard users one at a time.
          </div>
        </div>
        <input
          type="checkbox"
          className="checkbox flex-none"
          checked={cfg.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
          aria-label="Enable Safeguard JIT"
        />
      </section>

      {/* ── Appliance ── */}
      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-txt-tertiary mb-3">
          Appliance
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1rem" }}>
          <div className="form-group !mb-0">
            <label htmlFor="sg-fqdn">FQDN</label>
            <input
              id="sg-fqdn"
              value={cfg.appliance_fqdn}
              onChange={(e) => update("appliance_fqdn", e.target.value)}
              placeholder="safeguard.corp.example.com"
            />
          </div>
          <div className="form-group !mb-0">
            <label htmlFor="sg-port">Port</label>
            <input
              id="sg-port"
              type="number"
              min={1}
              max={65535}
              value={cfg.appliance_port}
              onChange={(e) => update("appliance_port", Number(e.target.value) || 443)}
            />
          </div>
        </div>
        <div className="border border-border/50 rounded-md px-4 py-3 flex items-center justify-between gap-4 mt-4">
          <div>
            <div className="text-sm font-medium">Verify TLS certificate</div>
            <div className="text-xs text-txt-secondary mt-1">
              Disable only for lab appliances with self-signed certs; production deployments should
              pin a CA below.
            </div>
          </div>
          <input
            type="checkbox"
            className="checkbox flex-none"
            checked={cfg.verify_tls}
            onChange={(e) => update("verify_tls", e.target.checked)}
            aria-label="Verify TLS certificate"
          />
        </div>
        <div className="form-group mt-4">
          <label htmlFor="sg-ca">Pinned CA bundle (PEM, optional)</label>
          <textarea
            id="sg-ca"
            rows={5}
            value={cfg.ca_cert_pem}
            onChange={(e) => update("ca_cert_pem", e.target.value)}
            placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
            className="font-mono text-xs"
          />
        </div>
      </section>

      {/* ── Auth ── */}
      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-txt-tertiary mb-3">
          Authentication
        </h3>
        <div className="form-group">
          <label htmlFor="sg-auth-mode">Mode</label>
          <Select
            id="sg-auth-mode"
            value={cfg.auth_mode}
            onChange={(v) => update("auth_mode", v as SafeguardAuthMode)}
            options={AUTH_MODES.map((m) => ({ value: m.value, label: m.label }))}
          />
          <div className="text-xs text-txt-secondary mt-1">
            {AUTH_MODES.find((m) => m.value === cfg.auth_mode)?.help}
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="sg-idp">Identity Provider alias</label>
          <input
            id="sg-idp"
            value={cfg.idp_alias}
            onChange={(e) => update("idp_alias", e.target.value)}
            placeholder="extf161"
          />
          <div className="text-xs text-txt-secondary mt-1">
            The federation provider alias as configured on the Safeguard side. Required for per-user
            browser SSO / Hybrid modes; ignored in A2A-only mode.
          </div>
        </div>

        {/* A2A creds — shown for a2a / hybrid (skipped for per_user_browser, which uses
            the user's own RSTS-issued bearer instead of an A2A client cert). */}
        {cfg.auth_mode !== "per_user_browser" && (
          <div className="rounded-md border border-border/50 p-4 space-y-4">
            <div className="text-xs text-txt-secondary">
              A2A credentials are encrypted with Vault before storage. Leave a field as{" "}
              <code className="text-[10px]">********</code> to keep its existing value; clear it to
              remove.
            </div>
            <div className="form-group !mb-0">
              <label htmlFor="sg-apikey">A2A API key</label>
              <input
                id="sg-apikey"
                type="password"
                value={cfg.a2a_api_key}
                onChange={(e) => update("a2a_api_key", e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="form-group !mb-0">
              <label htmlFor="sg-cert">A2A client certificate (PEM)</label>
              <textarea
                id="sg-cert"
                rows={4}
                value={cfg.a2a_client_cert_pem}
                onChange={(e) => update("a2a_client_cert_pem", e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div className="form-group !mb-0">
              <label htmlFor="sg-key">A2A client private key (PEM)</label>
              <textarea
                id="sg-key"
                rows={4}
                value={cfg.a2a_client_key_pem}
                onChange={(e) => update("a2a_client_key_pem", e.target.value)}
                className="font-mono text-xs"
              />
            </div>
          </div>
        )}
      </section>

      {/* ── Defaults ── */}
      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-txt-tertiary mb-3">
          Defaults &amp; behaviour
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "1rem" }}>
          <div className="form-group !mb-0">
            <label htmlFor="sg-hours">Default duration (hours)</label>
            <input
              id="sg-hours"
              type="number"
              min={1}
              max={12}
              value={cfg.default_checkout_hours}
              onChange={(e) =>
                update(
                  "default_checkout_hours",
                  Math.max(1, Math.min(12, Number(e.target.value) || 1))
                )
              }
            />
          </div>
          <div className="form-group !mb-0">
            <label htmlFor="sg-reason">Reason template</label>
            <input
              id="sg-reason"
              value={cfg.request_reason_template}
              onChange={(e) => update("request_reason_template", e.target.value)}
            />
            <div className="text-xs text-txt-secondary mt-1">
              Tokens: <code>{"{session_id}"}</code>, <code>{"{user}"}</code>,{" "}
              <code>{"{connection}"}</code>.
            </div>
          </div>
        </div>
        <div className="border border-border/50 rounded-md px-4 py-3 flex items-center justify-between gap-4 mt-4">
          <div>
            <div className="text-sm font-medium">Auto check-in on session end</div>
            <div className="text-xs text-txt-secondary mt-1">
              When the tunnel closes, Strata calls Safeguard&apos;s Checkin endpoint so the upstream
              window matches actual usage.
            </div>
          </div>
          <input
            type="checkbox"
            className="checkbox flex-none"
            checked={cfg.auto_checkin_on_session_end}
            onChange={(e) => update("auto_checkin_on_session_end", e.target.checked)}
            aria-label="Auto check-in on session end"
          />
        </div>
        <div className="border border-border/50 rounded-md px-4 py-3 flex items-center justify-between gap-4 mt-4">
          <div>
            <div className="text-sm font-medium">Cache checked-out passwords</div>
            <div className="text-xs text-txt-secondary mt-1">
              Vault-seal the password for the duration above and reuse it for every tunnel until it
              expires. Users won&apos;t need to re-submit a fresh Safeguard token between sessions.
              <strong> Auto check-in is suppressed</strong> while this is on, so the appliance
              keeps the access request open until its own rotation policy fires.
            </div>
          </div>
          <input
            type="checkbox"
            className="checkbox flex-none"
            checked={cfg.password_cache_enabled}
            onChange={(e) => update("password_cache_enabled", e.target.checked)}
            aria-label="Cache checked-out passwords"
          />
        </div>
      </section>

      {/* ── Test result ── */}
      {testResult && (
        <div
          className={`rounded-md p-3 ${
            testResult.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
          }`}
        >
          <div className="font-semibold mb-1">{testResult.message}</div>
          {testResult.steps.length > 0 && (
            <ul className="text-xs space-y-1">
              {testResult.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span>{s.ok ? "✓" : "✗"}</span>
                  <span>
                    <span className="font-mono">{s.name}</span>
                    {s.detail ? ` — ${s.detail}` : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {saveError && (
        <div className="rounded-md px-4 py-2 bg-danger/10 text-danger">{saveError}</div>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center gap-3 pt-2 border-t border-border/50">
        <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleTest}
          disabled={testing || !cfg.appliance_fqdn}
        >
          {testing ? "Testing…" : "Test Connection"}
        </button>
      </div>
    </div>
  );
}
