import { useEffect, useState } from "react";
import Select from "../../components/Select";
import {
  getSmtpConfig,
  updateSmtpConfig,
  testSmtpSend,
  listEmailDeliveries,
  SmtpConfig,
  EmailDelivery,
  ApiError,
} from "../../api";

/**
 * Admin → Notifications tab.
 *
 * Surfaces the v0.25.0 transactional-email pipeline:
 *   - SMTP relay config (host / port / TLS / credentials / from address)
 *   - Test-send button (round-trips through the live transport)
 *   - Recent deliveries audit view (last 50 rows of `email_deliveries`)
 *
 * Notes:
 *   - SMTP password is Vault-sealed server-side. The backend refuses to save
 *     a password when Vault is sealed or running in stub mode.
 *   - `password_set` tells us whether a sealed value already exists so we
 *     can show a "•••• (set)" placeholder instead of an empty input.
 *   - Sending `password: undefined` leaves the existing value; `""` clears it;
 *     any non-empty string replaces it.
 */

/**
 * Options surfaced in the "Send test email" template picker.  Values must
 * match the server-side `TemplateKey::as_str()` mapping in
 * `backend/src/services/email/templates.rs`.  The empty-string value is the
 * generic SMTP probe (no template rendering, just a connectivity check).
 */
const TEST_TEMPLATES = [
  { value: "", label: "Generic probe (connectivity only)" },
  { value: "checkout_pending", label: "Checkout pending — awaiting approval" },
  { value: "checkout_approved", label: "Checkout approved" },
  { value: "checkout_rejected", label: "Checkout rejected" },
  { value: "checkout_self_approved", label: "Checkout self-approved (audit)" },
];

export default function NotificationsTab({ onSave }: { onSave: () => void }) {
  const [cfg, setCfg] = useState<SmtpConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Form state (mirrors SmtpConfig but with a nullable password sentinel).
  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [username, setUsername] = useState("");
  const [tlsMode, setTlsMode] = useState("starttls");
  const [fromAddress, setFromAddress] = useState("");
  const [fromName, setFromName] = useState("Strata Client");
  const [accent, setAccent] = useState("#2563eb");
  // `null` → leave existing sealed value; string → change it (empty = clear)
  const [newPassword, setNewPassword] = useState<string | null>(null);

  // Port is chosen via a preset dropdown tied to the TLS mode; `custom` unlocks the number input.
  const [portMode, setPortMode] = useState<"25" | "465" | "587" | "custom">("587");

  function defaultPortForTls(mode: string): number {
    if (mode === "implicit") return 465;
    if (mode === "none") return 25;
    return 587; // starttls
  }

  function presetForPort(p: number): "25" | "465" | "587" | "custom" {
    if (p === 25) return "25";
    if (p === 465) return "465";
    if (p === 587) return "587";
    return "custom";
  }

  function handleTlsModeChange(mode: string) {
    setTlsMode(mode);
    // Snap to the canonical port for that TLS mode unless the user explicitly
    // chose a custom port (in which case we leave their value alone).
    if (portMode !== "custom") {
      const next = defaultPortForTls(mode);
      setPort(next);
      setPortMode(presetForPort(next));
    }
  }

  function handlePortModeChange(next: string) {
    const mode = next as "25" | "465" | "587" | "custom";
    setPortMode(mode);
    if (mode !== "custom") setPort(Number(mode));
  }

  // Test-send state
  const [testRecipient, setTestRecipient] = useState("");
  const [testTemplate, setTestTemplate] = useState<string>(""); // "" = generic probe
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Deliveries state
  const [deliveries, setDeliveries] = useState<EmailDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");

  // ─── Load ──────────────────────────────────────────────────────────
  async function reload() {
    setLoadError("");
    try {
      const c = await getSmtpConfig();
      setCfg(c);
      setEnabled(c.enabled);
      setHost(c.host);
      setPort(c.port);
      setUsername(c.username);
      setTlsMode(c.tls_mode || "starttls");
      setPortMode(presetForPort(c.port));
      setFromAddress(c.from_address);
      setFromName(c.from_name || "Strata Client");
      setAccent(c.branding_accent_color || "#2563eb");
      setNewPassword(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : "Failed to load SMTP settings");
    }
  }

  async function reloadDeliveries() {
    setDeliveriesLoading(true);
    try {
      const rows = await listEmailDeliveries(statusFilter || undefined, 50);
      setDeliveries(rows);
    } catch {
      /* swallow — a banner is overkill for the deliveries table */
    }
    setDeliveriesLoading(false);
  }

  useEffect(() => {
    reload();
    reloadDeliveries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    reloadDeliveries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  // ─── Validation ────────────────────────────────────────────────────
  function validate(): string | null {
    if (!enabled) return null;
    if (!host.trim()) return "Host is required when SMTP is enabled.";
    if (!fromAddress.trim()) return "From address is required when SMTP is enabled.";
    if (!fromAddress.includes("@")) return "From address must be a valid email.";
    if (port < 1 || port > 65535) return "Port must be between 1 and 65535.";
    return null;
  }

  const validationError = validate();

  // ─── Save ──────────────────────────────────────────────────────────
  async function handleSave() {
    if (validationError) return;
    setSaving(true);
    setSaveError("");
    try {
      await updateSmtpConfig({
        enabled,
        host: host.trim(),
        port,
        username: username.trim(),
        password: newPassword === null ? undefined : newPassword,
        tls_mode: tlsMode,
        from_address: fromAddress.trim(),
        from_name: fromName.trim(),
        branding_accent_color: accent.trim(),
      });
      onSave();
      await reload();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "Failed to save SMTP settings");
    }
    setSaving(false);
  }

  // ─── Test send ─────────────────────────────────────────────────────
  async function handleTestSend() {
    const recipient = testRecipient.trim();
    if (!recipient || !recipient.includes("@")) {
      setTestResult({ ok: false, msg: "Enter a valid recipient address." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      await testSmtpSend(recipient, testTemplate || undefined);
      const label = TEST_TEMPLATES.find((t) => t.value === testTemplate)?.label ?? "Generic probe";
      setTestResult({
        ok: true,
        msg: `Test message (${label}) accepted by the relay for ${recipient}.`,
      });
      reloadDeliveries();
    } catch (e) {
      setTestResult({
        ok: false,
        msg: e instanceof ApiError ? e.message : "Test send failed.",
      });
    }
    setTesting(false);
  }

  if (loadError) {
    return (
      <div className="card mt-6 p-6">
        <p className="text-danger">{loadError}</p>
      </div>
    );
  }
  if (!cfg) {
    return (
      <div className="card mt-6 p-6">
        <p className="text-txt-secondary">Loading SMTP settings…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 mt-6">
      {/* ── SMTP relay config ───────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
          <div>
            <h3 className="text-lg font-semibold text-txt-primary">Notification Email (SMTP)</h3>
            <p className="text-sm text-txt-secondary mt-0.5">
              Configure the outbound relay Strata uses to send managed-account checkout
              notifications (pending approval, approved, rejected, self-approved audit).
            </p>
          </div>
        </div>

        <div className="space-y-6">
          <div className="form-group">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="checkbox"
              />
              <div>
                <span className="font-medium group-hover:text-txt-primary transition-colors">
                  Enable notification emails
                </span>
                <p className="text-txt-secondary text-sm mt-0.5">
                  When off, the dispatcher silently suppresses every checkout email and no SMTP
                  connection is opened.
                </p>
              </div>
            </label>
          </div>

          {enabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 border-t border-border/10">
              <div className="form-group">
                <label className="form-label">SMTP host</label>
                <input
                  className="input"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="smtp.corp.example.com"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Port</label>
                <Select
                  value={portMode}
                  onChange={handlePortModeChange}
                  options={[
                    { value: "25", label: "25 — SMTP (unauthenticated relay)" },
                    { value: "587", label: "587 — submission (STARTTLS)" },
                    { value: "465", label: "465 — SMTPS (implicit TLS)" },
                    { value: "custom", label: "Other — custom port…" },
                  ]}
                />
                {portMode === "custom" && (
                  <input
                    type="number"
                    className="input mt-2"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    placeholder="e.g. 2525"
                  />
                )}
              </div>

              <div className="form-group">
                <label className="form-label">TLS mode</label>
                <Select
                  value={tlsMode}
                  onChange={handleTlsModeChange}
                  options={[
                    { value: "starttls", label: "STARTTLS (port 587)" },
                    { value: "implicit", label: "Implicit TLS (port 465)" },
                    { value: "none", label: "None — plaintext port 25 (internal relays only)" },
                  ]}
                />
                <p className="text-sm text-txt-secondary mt-1">
                  Use <code>STARTTLS</code> for most corporate relays, <code>Implicit TLS</code> for
                  legacy "SMTPS" on port 465, or <code>None</code> for unauthenticated in-VPC relays
                  on port 25. The port auto-syncs unless you pick <code>Other</code>.
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">Username</label>
                <input
                  className="input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="service-account@corp.example.com"
                  autoComplete="off"
                />
              </div>

              <div className="form-group md:col-span-2">
                <label className="form-label">Password</label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    className="input flex-1"
                    value={newPassword ?? ""}
                    placeholder={cfg.password_set ? "•••••••• (sealed in Vault)" : "Not set"}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  {cfg.password_set && newPassword === null && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setNewPassword("")}
                      title="Clear the stored password on save"
                    >
                      Clear
                    </button>
                  )}
                  {newPassword !== null && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setNewPassword(null)}
                      title="Discard the change and keep the existing sealed password"
                    >
                      Keep existing
                    </button>
                  )}
                </div>
                <p className="text-sm text-txt-secondary mt-1">
                  The SMTP password is <strong>sealed in Vault before storage</strong>. If Vault is
                  sealed or running in stub mode, saving will be rejected. Leave blank to keep the
                  existing sealed value.
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">From address</label>
                <input
                  className="input"
                  value={fromAddress}
                  onChange={(e) => setFromAddress(e.target.value)}
                  placeholder="strata-notifications@corp.example.com"
                />
                <p className="text-sm text-txt-secondary mt-1">
                  Required when SMTP is enabled. Must be a valid email.
                </p>
              </div>

              <div className="form-group">
                <label className="form-label">From name</label>
                <input
                  className="input"
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  placeholder="Strata Client"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Brand accent colour</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={accent}
                    onChange={(e) => setAccent(e.target.value)}
                    className="h-10 w-14 rounded border border-border bg-surface"
                  />
                  <input
                    className="input flex-1"
                    value={accent}
                    onChange={(e) => setAccent(e.target.value)}
                    placeholder="#2563eb"
                  />
                </div>
                <p className="text-sm text-txt-secondary mt-1">
                  Used for the button colour in the HTML templates.
                </p>
              </div>
            </div>
          )}
        </div>

        {validationError && (
          <div className="mt-4 rounded-md px-4 py-3 bg-warning/10 border border-warning/30">
            <p className="text-sm text-warning">{validationError}</p>
          </div>
        )}

        {saveError && (
          <div className="mt-4 rounded-md px-4 py-3 bg-danger/10 border border-danger/30">
            <p className="text-sm text-danger">{saveError}</p>
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-border/10">
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !!validationError}
          >
            {saving ? "Saving…" : "Save SMTP Settings"}
          </button>
        </div>
      </div>

      {/* ── Test send ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
          <div>
            <h3 className="text-lg font-semibold text-txt-primary">Send test email</h3>
            <p className="text-sm text-txt-secondary mt-0.5">
              Delivers a probe message through the live relay using the saved settings. Errors
              surface the actual SMTP response for debugging.
            </p>
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-3">
          <input
            className="input flex-1"
            type="email"
            value={testRecipient}
            onChange={(e) => setTestRecipient(e.target.value)}
            placeholder="you@corp.example.com"
            disabled={!cfg.enabled}
          />
          <div className="md:w-72">
            <Select
              value={testTemplate}
              onChange={setTestTemplate}
              options={TEST_TEMPLATES}
              disabled={!cfg.enabled}
            />
          </div>
          <button
            className="btn btn-primary whitespace-nowrap"
            onClick={handleTestSend}
            disabled={testing || !cfg.enabled}
            title={
              cfg.enabled ? "Send a test email" : "Save the SMTP config with Enable ticked first"
            }
          >
            {testing ? "Sending…" : "Send test"}
          </button>
        </div>
        <p className="text-sm text-txt-secondary mt-2">
          Pick a template to preview the real rendered HTML with sample data, or leave on{" "}
          <em>Generic probe</em> to send a plain connectivity test.
        </p>
        {!cfg.enabled && (
          <p className="text-sm text-txt-secondary mt-2">
            Enable SMTP and save before running a test.
          </p>
        )}
        {testResult && (
          <div
            className={`mt-4 rounded-md px-4 py-3 border ${
              testResult.ok
                ? "bg-success-dim/30 border-success/30 text-success"
                : "bg-danger/10 border-danger/30 text-danger"
            }`}
          >
            <p className="text-sm">{testResult.msg}</p>
          </div>
        )}
      </div>

      {/* ── Recent deliveries ──────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
          <div>
            <h3 className="text-lg font-semibold text-txt-primary">Recent deliveries</h3>
            <p className="text-sm text-txt-secondary mt-0.5">
              Last 50 rows of <code>email_deliveries</code>, ordered newest first.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-44">
              <Select
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: "", label: "All statuses" },
                  { value: "queued", label: "Queued" },
                  { value: "sent", label: "Sent" },
                  { value: "failed", label: "Failed" },
                  { value: "bounced", label: "Bounced" },
                  { value: "suppressed", label: "Suppressed" },
                ]}
              />
            </div>
            <button
              className="btn btn-secondary"
              onClick={reloadDeliveries}
              disabled={deliveriesLoading}
            >
              {deliveriesLoading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        {deliveries.length === 0 ? (
          <p className="text-sm text-txt-secondary py-6 text-center">
            {deliveriesLoading ? "Loading…" : "No deliveries recorded yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-txt-secondary border-b border-border/30">
                  <th className="py-2 px-3 font-medium">Created</th>
                  <th className="py-2 px-3 font-medium">Template</th>
                  <th className="py-2 px-3 font-medium">Recipient</th>
                  <th className="py-2 px-3 font-medium">Subject</th>
                  <th className="py-2 px-3 font-medium">Status</th>
                  <th className="py-2 px-3 font-medium">Attempts</th>
                  <th className="py-2 px-3 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-border/10 hover:bg-surface-secondary/20"
                  >
                    <td className="py-2 px-3 font-mono text-xs text-txt-secondary">
                      {new Date(d.created_at).toLocaleString()}
                    </td>
                    <td className="py-2 px-3 font-mono text-xs">{d.template_key}</td>
                    <td className="py-2 px-3">{d.recipient_email}</td>
                    <td className="py-2 px-3 truncate max-w-xs" title={d.subject}>
                      {d.subject}
                    </td>
                    <td className="py-2 px-3">
                      <StatusPill status={d.status} />
                    </td>
                    <td className="py-2 px-3 text-center">{d.attempts}</td>
                    <td
                      className="py-2 px-3 text-xs text-danger truncate max-w-xs"
                      title={d.last_error ?? ""}
                    >
                      {d.last_error ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "sent"
      ? "bg-success-dim/40 text-success"
      : status === "failed" || status === "bounced"
        ? "bg-danger/10 text-danger"
        : status === "suppressed"
          ? "bg-surface-secondary text-txt-secondary"
          : "bg-warning/10 text-warning";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{status}</span>
  );
}
