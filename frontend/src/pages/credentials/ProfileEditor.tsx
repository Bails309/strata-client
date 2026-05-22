import Select from "../../components/Select";
import type { CheckoutRequest, CredentialProfile } from "../../api";

export interface EditingProfile {
  id?: string;
  label: string;
  username: string;
  password: string;
  ttl_hours: number;
  extended_expiry: boolean;
  managed_ad_dn?: string;
  friendly_name?: string;
  /** "local" (default) or "safeguard" (JIT). */
  kind?: "local" | "safeguard";
  safeguard_account_id?: string;
  safeguard_asset?: string;
}

interface ProfileEditorProps {
  editing: EditingProfile;
  setEditing: (p: EditingProfile | null) => void;
  saving: boolean;
  profiles: CredentialProfile[];
  activeCheckouts: CheckoutRequest[];
  allCheckouts: CheckoutRequest[];
  onSave: () => void;
  onLinkCheckout: (profileId: string, checkoutId: string | null) => Promise<void>;
  isCheckoutLive: (c: CheckoutRequest) => boolean;
  isCheckoutExpired: (c: CheckoutRequest) => boolean;
  getTimeRemaining: (expiresAt?: string) => string;
  formatDateTime: (d: string | null) => string;
  /** When true (Safeguard appliance is configured & enabled), allow choosing the Safeguard kind. */
  safeguardEnabled?: boolean;
}

/**
 * Modal card for creating/editing a credential profile. Pure presentational.
 */
export default function ProfileEditor(props: ProfileEditorProps) {
  const {
    editing,
    setEditing,
    saving,
    profiles,
    activeCheckouts,
    allCheckouts,
    onSave,
    onLinkCheckout,
    isCheckoutLive,
    isCheckoutExpired,
    getTimeRemaining,
    formatDateTime,
    safeguardEnabled,
  } = props;

  const kind = editing.kind ?? "local";
  const isSafeguard = kind === "safeguard";

  const currentProfile = editing.id ? profiles.find((p) => p.id === editing.id) : null;
  const editLinkedCheckout = currentProfile?.checkout_id
    ? allCheckouts.find((c) => c.id === currentProfile.checkout_id)
    : null;
  const hasLinkedCheckout = !!editLinkedCheckout;

  return (
    <div
      className="card mb-6"
      style={{ border: "1px solid var(--color-accent)", boxShadow: "var(--shadow-accent)" }}
    >
      <h2 className="!mb-4">{editing.id ? "Edit Profile" : "New Credential Profile"}</h2>
      <div className="form-group">
        <label htmlFor="prof-label">Label</label>
        <input
          id="prof-label"
          value={editing.label}
          onChange={(e) => setEditing({ ...editing, label: e.target.value })}
          placeholder="e.g. Domain Admin, SSH Dev Server"
          // Profile-editor modal just opened — focus-on-appear UX.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
      </div>
      {/* Kind selector — only shown for new profiles when Safeguard is configured. */}
      {!editing.id && safeguardEnabled && !editing.managed_ad_dn ? (
        <div className="form-group">
          <label htmlFor="prof-kind">Credential Source</label>
          <Select
            value={kind}
            onChange={(val) => {
              const nextKind = val === "safeguard" ? "safeguard" : "local";
              // Safeguard appliance policy caps checkout duration at 12h, so
              // clamp ttl_hours and force-disable extended_expiry when
              // switching to the safeguard kind.
              const clamp = nextKind === "safeguard";
              setEditing({
                ...editing,
                kind: nextKind,
                extended_expiry: clamp ? false : editing.extended_expiry,
                ttl_hours: clamp ? Math.min(editing.ttl_hours, 12) : editing.ttl_hours,
              });
            }}
            options={[
              { value: "local", label: "Local — username + password" },
              { value: "safeguard", label: "Safeguard JIT — checkout on connect" },
            ]}
          />
          <p className="text-txt-tertiary text-xs mt-1">
            {isSafeguard
              ? "Strata will request a just-in-time password from the Safeguard appliance whenever this profile is used, and check it back in when the session closes."
              : "Credentials are sealed locally in the vault."}
          </p>
        </div>
      ) : null}
      {editing.managed_ad_dn ? (
        <div className="bg-accent/5 border border-accent/20 rounded-lg px-4 py-3 mb-2">
          <div className="text-xs font-medium text-txt-secondary uppercase tracking-wider mb-1">
            Managed Account
          </div>
          <div className="text-sm font-medium text-accent">
            {editing.friendly_name || editing.managed_ad_dn}
          </div>
          <div className="text-xs text-txt-secondary mt-1">
            This profile is automatically managed by the password checkout system.
          </div>
        </div>
      ) : editing.label.startsWith("[managed]") ? (
        <div className="bg-accent/5 border border-accent/20 rounded-lg px-4 py-3 mb-2">
          <div className="text-xs font-medium text-txt-secondary uppercase tracking-wider mb-1">
            Managed Account
          </div>
          <div className="text-xs text-txt-secondary">Linked to system checkout</div>
          <div className="text-xs text-txt-secondary mt-1">
            This profile is automatically managed by the password checkout system. Username,
            password, and expiry are controlled by the active checkout.
          </div>
        </div>
      ) : null}

      {hasLinkedCheckout ? (
        <div className="form-group">
          <div className="bg-success/5 border border-success/20 rounded-lg px-4 py-3">
            <div className="text-xs font-medium text-txt-secondary uppercase tracking-wider mb-1">
              Managed Account Linked
            </div>
            <div className="text-sm font-medium">{editLinkedCheckout!.managed_ad_dn}</div>
            <div className="text-xs text-txt-secondary mt-1">
              Username and password are managed by the checked-out account.
              {isCheckoutLive(editLinkedCheckout!)
                ? ` Expires ${formatDateTime(editLinkedCheckout!.expires_at ?? null)} · ${getTimeRemaining(editLinkedCheckout!.expires_at)}`
                : editLinkedCheckout!.status === "CheckedIn"
                  ? " Checked in — password scrambled"
                  : editLinkedCheckout!.status === "Expired" ||
                      isCheckoutExpired(editLinkedCheckout!)
                    ? " Checkout expired"
                    : ` ${editLinkedCheckout!.status}`}
            </div>
          </div>
        </div>
      ) : (
        <>
          {isSafeguard ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group">
                <label htmlFor="prof-sg-account">Safeguard AccountId</label>
                <input
                  id="prof-sg-account"
                  value={editing.safeguard_account_id ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, safeguard_account_id: e.target.value })
                  }
                  placeholder="e.g. 42"
                  autoComplete="off"
                />
                <p className="text-txt-tertiary text-[0.6875rem] mt-1">
                  Numeric Safeguard AccountId from the appliance.
                </p>
              </div>
              <div className="form-group">
                <label htmlFor="prof-sg-asset">Safeguard Asset</label>
                <input
                  id="prof-sg-asset"
                  value={editing.safeguard_asset ?? ""}
                  onChange={(e) => setEditing({ ...editing, safeguard_asset: e.target.value })}
                  placeholder="AssetId or asset name"
                  autoComplete="off"
                />
                <p className="text-txt-tertiary text-[0.6875rem] mt-1">
                  Numeric AssetId or label as configured in Safeguard.
                </p>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div className="form-group">
              <label htmlFor="prof-username">Username</label>
              <input
                id="prof-username"
                value={editing.username}
                onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                placeholder={editing.id ? "(unchanged)" : "sAMAccountName (e.g. jsmith)"}
                autoComplete="off"
              />
              <p className="text-txt-tertiary text-[0.6875rem] mt-1">
                Note: Use sAMAccountName format (e.g. jsmith), not UPN or full email address.
              </p>
            </div>
            <div className="form-group">
              <label htmlFor="prof-password">Password</label>
              <input
                id="prof-password"
                type="password"
                value={editing.password}
                onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                placeholder={editing.id ? "(unchanged)" : "Enter password"}
                autoComplete="new-password"
              />
            </div>
          </div>
          )}
          <div className="form-group">
            <label htmlFor="prof-ttl">Password Expiry</label>
            <div className="flex items-center gap-3">
              {(() => {
                const extended = editing.extended_expiry && !isSafeguard;
                const max = extended ? 90 : 12;
                const val = extended
                  ? Math.max(1, Math.round(editing.ttl_hours / 24))
                  : editing.ttl_hours;
                const pct = max > 1 ? ((val - 1) / (max - 1)) * 100 : 0;
                return (
                  <input
                    id="prof-ttl"
                    type="range"
                    min={1}
                    max={max}
                    step={1}
                    value={val}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setEditing({
                        ...editing,
                        ttl_hours: extended ? n * 24 : n,
                      });
                    }}
                    className="range-slider flex-1"
                    style={
                      {
                        "--range-pct": `${pct}%`,
                      } as React.CSSProperties
                    }
                  />
                );
              })()}
              <span className="text-txt-primary font-semibold tabular-nums w-16 text-right">
                {editing.extended_expiry && !isSafeguard
                  ? (() => {
                      const days = Math.max(1, Math.round(editing.ttl_hours / 24));
                      return `${days} ${days === 1 ? "day" : "days"}`;
                    })()
                  : `${editing.ttl_hours} ${editing.ttl_hours === 1 ? "hour" : "hours"}`}
              </span>
            </div>
            {!isSafeguard && (
              <label
                className="flex items-center gap-2 mt-2 text-xs text-txt-secondary cursor-pointer select-none"
                htmlFor="prof-extended-expiry"
              >
                <input
                  id="prof-extended-expiry"
                  type="checkbox"
                  className="checkbox"
                  checked={editing.extended_expiry}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setEditing({
                      ...editing,
                      extended_expiry: next,
                      // Snap to a sensible default for the new mode: 12h when
                      // turning extended off, 30d (720h) when turning it on.
                      ttl_hours: next ? 720 : 12,
                    });
                  }}
                />
                Allow extended expiry (up to 90 days) — use only for service or break-glass accounts.
              </label>
            )}
            <p className="text-txt-tertiary text-xs mt-1">
              Credentials expire after this duration and must be updated.{" "}
              {isSafeguard
                ? "Maximum 12 hours (capped by Safeguard appliance policy)."
                : editing.extended_expiry
                  ? "Extended expiry enabled — maximum 90 days."
                  : "Maximum 12 hours."}
            </p>
          </div>
        </>
      )}

      {/* Checkout linking */}
      {editing.id &&
        (activeCheckouts.filter((c) => isCheckoutLive(c)).length > 0 ||
          currentProfile?.checkout_id) && (
          <div className="form-group">
            <label htmlFor="prof-link-checkout">Link Checked-Out Account</label>
            <p className="text-txt-tertiary text-xs mb-2">
              Populate this profile with credentials from an active password checkout. The
              profile&apos;s expiry will match the checkout duration.
            </p>
            {(() => {
              const linkedCheckout = currentProfile?.checkout_id
                ? allCheckouts.find((c) => c.id === currentProfile.checkout_id)
                : null;
              return linkedCheckout ? (
                <div className="flex items-center justify-between bg-success/5 border border-success/20 rounded-lg px-4 py-2.5">
                  <div>
                    <div className="text-sm font-medium">{linkedCheckout.managed_ad_dn}</div>
                    <div className="text-xs text-txt-secondary">
                      {isCheckoutLive(linkedCheckout)
                        ? `Expires ${formatDateTime(linkedCheckout.expires_at ?? null)} · ${getTimeRemaining(linkedCheckout.expires_at!)}`
                        : linkedCheckout.status === "CheckedIn"
                          ? "Checked in — password scrambled"
                          : linkedCheckout.status === "Expired" || isCheckoutExpired(linkedCheckout)
                            ? "Checkout expired"
                            : linkedCheckout.status}
                    </div>
                  </div>
                  <button
                    className="btn !px-2 !py-1 text-xs text-danger"
                    onClick={async () => {
                      await onLinkCheckout(editing.id!, null);
                    }}
                  >
                    Unlink
                  </button>
                </div>
              ) : (
                <Select
                  value=""
                  onChange={async (val) => {
                    if (val) await onLinkCheckout(editing.id!, val);
                  }}
                  placeholder="— Select a checked-out account —"
                  options={activeCheckouts
                    .filter((c) => isCheckoutLive(c))
                    .map((c) => ({
                      value: c.id,
                      label: `${c.managed_ad_dn} — ${getTimeRemaining(c.expires_at)}`,
                    }))}
                />
              );
            })()}
          </div>
        )}
      <div className="flex items-center gap-3 mt-2">
        <button className="btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : editing.id ? "Update" : "Create Profile"}
        </button>
        <button className="btn" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
