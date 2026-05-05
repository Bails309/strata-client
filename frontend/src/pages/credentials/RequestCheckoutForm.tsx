/* eslint-disable react-hooks/purity --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import Select from "../../components/Select";
import type { CheckoutRequest, UserAccountMapping } from "../../api";

interface RequestCheckoutFormProps {
  managedAccounts: UserAccountMapping[];
  allCheckouts: CheckoutRequest[];
  selectedDn: string;
  setSelectedDn: (v: string) => void;
  duration: number;
  setDuration: (fn: number | ((d: number) => number)) => void;
  justification: string;
  setJustification: (v: string) => void;
  emergencyBypass: boolean;
  setEmergencyBypass: (v: boolean) => void;
  scheduleEnabled: boolean;
  setScheduleEnabled: (v: boolean) => void;
  scheduledStart: string;
  setScheduledStart: (v: string) => void;
  submitting: boolean;
  isCheckoutExpired: (c: CheckoutRequest) => boolean;
  onRequest: () => void;
}

/**
 * Form for requesting a new credential checkout. Pure presentational —
 * all state lives in the parent Credentials page.
 */
export default function RequestCheckoutForm(props: RequestCheckoutFormProps) {
  const {
    managedAccounts,
    allCheckouts,
    selectedDn,
    setSelectedDn,
    duration,
    setDuration,
    justification,
    setJustification,
    emergencyBypass,
    setEmergencyBypass,
    scheduleEnabled,
    setScheduleEnabled,
    scheduledStart,
    setScheduledStart,
    submitting,
    isCheckoutExpired,
    onRequest,
  } = props;

  const accountHasActiveCheckout = (dn: string) =>
    allCheckouts.some(
      (c) =>
        c.managed_ad_dn === dn &&
        !isCheckoutExpired(c) &&
        (c.status === "Active" ||
          c.status === "Approved" ||
          c.status === "Pending" ||
          c.status === "Scheduled")
    );

  if (managedAccounts.length === 0) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4">Request Password Checkout</h2>
        <p className="text-txt-secondary">
          No managed accounts assigned to you. Contact an administrator.
        </p>
      </div>
    );
  }

  const allBlocked = managedAccounts.every((a) => accountHasActiveCheckout(a.managed_ad_dn));
  if (allBlocked) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold mb-4">Request Password Checkout</h2>
        <p className="text-txt-secondary">
          All managed accounts already have active checkouts. Wait for current checkouts to expire
          before requesting new ones.
        </p>
      </div>
    );
  }

  const durationMax = emergencyBypass ? 30 : 720;
  const clampDuration = (n: number) => Math.min(durationMax, Math.max(1, Math.round(n || 0)));

  const acct = managedAccounts.find((a) => a.managed_ad_dn === selectedDn);
  const approvalRequired = !!acct && !acct.can_self_approve;
  const isEmergencyActive =
    emergencyBypass && !!acct && !acct.can_self_approve && !!acct.pm_allow_emergency_bypass;
  const justificationRequired = approvalRequired;
  const justificationTooShort = justificationRequired && justification.trim().length < 10;

  return (
    <div className="card p-6">
      <h2 className="text-lg font-semibold mb-4">Request Password Checkout</h2>

      <div className="mb-4">
        <label htmlFor="req-managed-account" className="block text-sm font-medium mb-1">
          Managed Account
        </label>
        <Select
          id="req-managed-account"
          value={selectedDn}
          onChange={setSelectedDn}
          placeholder="Select account..."
          options={managedAccounts
            .filter((a) => !accountHasActiveCheckout(a.managed_ad_dn))
            .map((a) => ({
              value: a.managed_ad_dn,
              label: a.managed_ad_dn + (a.can_self_approve ? " (self-approve)" : ""),
            }))}
        />
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">
          Duration (minutes, 1–{emergencyBypass ? 30 : 720})
        </label>
        <div className="inline-flex items-stretch rounded-md border border-border bg-bg-primary overflow-hidden focus-within:border-accent/60 transition-colors">
          <button
            type="button"
            className="px-3 text-lg leading-none text-txt-secondary hover:bg-border/30 hover:text-txt-primary active:bg-border/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            onClick={() => setDuration((d) => clampDuration(d - (d > 60 ? 15 : d > 10 ? 5 : 1)))}
            disabled={duration <= 1}
            aria-label="Decrease duration"
          >
            −
          </button>
          <input
            type="number"
            className="no-spinner w-20 text-center border-0 bg-transparent focus:shadow-none focus:border-0 tabular-nums"
            min={1}
            max={durationMax}
            value={duration}
            onChange={(e) => setDuration(clampDuration(Number(e.target.value)))}
            onBlur={(e) => setDuration(clampDuration(Number(e.target.value)))}
          />
          <button
            type="button"
            className="px-3 text-lg leading-none text-txt-secondary hover:bg-border/30 hover:text-txt-primary active:bg-border/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            onClick={() => setDuration((d) => clampDuration(d + (d >= 60 ? 15 : d >= 10 ? 5 : 1)))}
            disabled={duration >= durationMax}
            aria-label="Increase duration"
          >
            +
          </button>
          <span className="px-3 flex items-center text-xs text-txt-tertiary border-l border-border bg-bg-secondary/40 select-none">
            min
          </span>
        </div>
        {emergencyBypass && (
          <p className="text-xs text-warning mt-1">
            Emergency bypass checkouts are capped at 30 minutes.
          </p>
        )}
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">
          Justification{" "}
          {justificationRequired ? (
            <span className={isEmergencyActive ? "text-warning" : "text-danger"}>
              (required, min 10 characters)
            </span>
          ) : (
            <span className="text-txt-tertiary">(optional)</span>
          )}
        </label>
        <textarea
          className={`input w-full ${justificationTooShort ? (isEmergencyActive ? "border-warning/60" : "border-danger/60") : ""}`}
          rows={2}
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          placeholder={
            isEmergencyActive
              ? "Describe the incident and why approval cannot wait…"
              : justificationRequired
                ? "Explain why you need this account — approvers will see this…"
                : "Reason for checkout..."
          }
        />
        {justificationTooShort && (
          <p className={`text-xs mt-1 ${isEmergencyActive ? "text-warning" : "text-danger"}`}>
            {isEmergencyActive
              ? "Emergency bypass requires a justification of at least 10 characters."
              : "Approval-required checkouts need a justification of at least 10 characters."}
            {justification.trim().length > 0 && ` (${justification.trim().length}/10)`}
          </p>
        )}
      </div>

      <div className="mb-4">
        <label className="flex items-center gap-2 cursor-pointer text-sm font-medium mb-1">
          <input
            type="checkbox"
            className="checkbox"
            checked={scheduleEnabled}
            onChange={(e) => {
              setScheduleEnabled(e.target.checked);
              if (e.target.checked && !scheduledStart) {
                // Default to 15 minutes from now, rounded to next 5
                const d = new Date(Date.now() + 15 * 60 * 1000);
                d.setSeconds(0, 0);
                const pad = (n: number) => n.toString().padStart(2, "0");
                setScheduledStart(
                  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
                );
              }
            }}
          />
          Schedule release for a future time
        </label>
        {scheduleEnabled && (
          <div className="ml-6 mt-2">
            <input
              type="datetime-local"
              className="input w-64"
              value={scheduledStart}
              onChange={(e) => setScheduledStart(e.target.value)}
              min={(() => {
                const d = new Date(Date.now() + 60 * 1000);
                const pad = (n: number) => n.toString().padStart(2, "0");
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
              })()}
            />
            <p className="text-xs text-txt-tertiary mt-1">
              Password will be held until the chosen time, then released automatically. Max 14 days
              ahead.
            </p>
          </div>
        )}
      </div>

      {acct && !acct.can_self_approve && acct.pm_allow_emergency_bypass && !scheduleEnabled && (
        <div className="mb-4 p-3 rounded border border-warning/40 bg-warning/5">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="checkbox mt-1"
              checked={emergencyBypass}
              onChange={(e) => {
                setEmergencyBypass(e.target.checked);
                if (e.target.checked && duration > 30) setDuration(30);
              }}
            />
            <div>
              <div className="text-sm font-semibold text-warning">
                Emergency Approval Bypass (Break-Glass)
              </div>
              <div className="text-xs text-txt-secondary mt-0.5">
                Skip the approval workflow and release the password immediately. A justification of
                at least 10 characters is required, and every use is recorded in the audit log.
              </div>
            </div>
          </label>
        </div>
      )}

      <button
        className={`btn ${emergencyBypass ? "btn-warning" : "btn-primary"}`}
        onClick={onRequest}
        disabled={
          !selectedDn ||
          submitting ||
          (scheduleEnabled && !scheduledStart) ||
          (approvalRequired && justification.trim().length < 10)
        }
      >
        {submitting
          ? "Submitting..."
          : emergencyBypass
            ? "Emergency Checkout"
            : scheduleEnabled
              ? "Schedule Checkout"
              : "Request Checkout"}
      </button>
    </div>
  );
}
