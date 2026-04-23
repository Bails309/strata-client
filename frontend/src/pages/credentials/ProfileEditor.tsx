import Select from "../../components/Select";
import type { CheckoutRequest, CredentialProfile } from "../../api";

export interface EditingProfile {
  id?: string;
  label: string;
  username: string;
  password: string;
  ttl_hours: number;
  managed_ad_dn?: string;
  friendly_name?: string;
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
  } = props;

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
        <label>Label</label>
        <input
          value={editing.label}
          onChange={(e) => setEditing({ ...editing, label: e.target.value })}
          placeholder="e.g. Domain Admin, SSH Dev Server"
          autoFocus
        />
      </div>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div className="form-group">
              <label>Username</label>
              <input
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
              <label>Password</label>
              <input
                type="password"
                value={editing.password}
                onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                placeholder={editing.id ? "(unchanged)" : "Enter password"}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="form-group">
            <label>Password Expiry</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={12}
                step={1}
                value={editing.ttl_hours}
                onChange={(e) => setEditing({ ...editing, ttl_hours: Number(e.target.value) })}
                className="flex-1"
                style={{ accentColor: "var(--color-accent)" }}
              />
              <span className="text-txt-primary font-semibold tabular-nums w-16 text-right">
                {editing.ttl_hours} {editing.ttl_hours === 1 ? "hour" : "hours"}
              </span>
            </div>
            <p className="text-txt-tertiary text-xs mt-1">
              Credentials expire after this duration and must be updated. Maximum 12 hours.
            </p>
          </div>
        </>
      )}

      {/* Checkout linking */}
      {editing.id &&
        (activeCheckouts.filter((c) => isCheckoutLive(c)).length > 0 ||
          currentProfile?.checkout_id) && (
          <div className="form-group">
            <label>Link Checked-Out Account</label>
            <p className="text-txt-tertiary text-xs mb-2">
              Populate this profile with credentials from an active password checkout. The profile's
              expiry will match the checkout duration.
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
