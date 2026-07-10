import { useEffect, useState } from "react";
import Select from "../../components/Select";
import {
  listSafeguardAccounts,
  type CheckoutRequest,
  type CredentialProfile,
  type SafeguardEntitledAccount,
} from "../../api";

export interface EditingProfile {
  id?: string;
  label: string;
  username: string;
  password: string;
  ttl_hours: number;
  /**
   * Sub-hour component of the requested lifetime (0-59). Only applies
   * to the non-extended branch; the extended-expiry (days) branch
   * ignores this and stays days-only. Defaults to 0 for profiles
   * created before v1.12.14.
   */
  ttl_minutes: number;
  extended_expiry: boolean;
  managed_ad_dn?: string;
  friendly_name?: string;
  /** "local" (default) or "safeguard" (JIT). */
  kind?: "local" | "safeguard";
  /** Original kind when editing an existing profile. */
  original_kind?: "local" | "safeguard";
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
  const switchingFromSafeguardToLocal =
    !!editing.id && editing.original_kind === "safeguard" && !isSafeguard;

  // Safeguard entitlement picker: fetch the user's catalog when the
  // Safeguard branch is visible. Empty array means "no picker shown,
  // fall back to manual inputs". `signin_required` switches the
  // picker UI into a sign-in prompt.
  const [entitlements, setEntitlements] = useState<SafeguardEntitledAccount[] | null>(null);
  const [entitlementsError, setEntitlementsError] = useState<
    null | "signin_required" | "load_failed"
  >(null);
  const [entitlementsLoading, setEntitlementsLoading] = useState(false);
  useEffect(() => {
    if (!safeguardEnabled || !isSafeguard) return;
    let cancelled = false;
    // Fetch-loading pattern: flipping these state flags at the start of
    // an async fetch is correct and self-bounded.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntitlementsLoading(true);
    setEntitlementsError(null);
    listSafeguardAccounts()
      .then((rows) => {
        if (cancelled) return;
        setEntitlements(rows);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("safeguard.signin_required")) {
          setEntitlementsError("signin_required");
        } else {
          setEntitlementsError("load_failed");
        }
        setEntitlements([]);
      })
      .finally(() => {
        if (!cancelled) setEntitlementsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [safeguardEnabled, isSafeguard]);

  // Build the set of (account_id|asset_id-or-asset_name) keys for
  // Safeguard profiles that already exist for this user, so we can
  // hide their entitlement rows from the picker. The currently-edited
  // profile is intentionally excluded so its own row stays visible.
  const claimedKeys = new Set<string>();
  for (const p of profiles) {
    if (editing.id && p.id === editing.id) continue;
    if (p.kind !== "safeguard") continue;
    const acctId = p.safeguard_account_id?.trim();
    const asset = p.safeguard_asset?.trim();
    if (!acctId || !asset) continue;
    claimedKeys.add(`${acctId}|${asset}`);
  }
  const isRowClaimed = (row: SafeguardEntitledAccount) => {
    const acctId = row.account_id;
    // A stored profile may reference the asset by its numeric AssetId
    // or by its human-readable AssetName — check both forms.
    return (
      claimedKeys.has(`${acctId}|${row.asset_id}`) ||
      (!!row.asset_name && claimedKeys.has(`${acctId}|${row.asset_name}`))
    );
  };
  const availableEntitlements = (entitlements ?? []).filter((row) => !isRowClaimed(row));
  const entitlementOptions = availableEntitlements.map((row) => {
    const acct = row.account_name?.trim() || `account#${row.account_id}`;
    const asset = row.asset_name?.trim() || `asset#${row.asset_id}`;
    const domain = row.account_domain_name?.trim();
    const labelText = domain ? `${acct}@${domain} — ${asset}` : `${acct} — ${asset}`;
    return {
      value: `${row.account_id}|${row.asset_id}`,
      label: labelText,
    };
  });
  const allEntitlementsClaimed =
    entitlements !== null && entitlements.length > 0 && availableEntitlements.length === 0;
  const selectedEntitlementValue =
    editing.safeguard_account_id && editing.safeguard_asset
      ? availableEntitlements.find(
          (r) =>
            r.account_id === editing.safeguard_account_id &&
            (r.asset_id === editing.safeguard_asset || r.asset_name === editing.safeguard_asset)
        )
        ? `${editing.safeguard_account_id}|${availableEntitlements.find((r) => r.account_id === editing.safeguard_account_id)?.asset_id ?? editing.safeguard_asset}`
        : ""
      : "";

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
      {/* Kind selector — shown whenever Safeguard is configured, except managed profiles. */}
      {safeguardEnabled && !editing.managed_ad_dn ? (
        <div className="form-group">
          <label htmlFor="prof-kind">Credential Source</label>
          <Select
            value={kind}
            onChange={(val) => {
              const nextKind = val === "safeguard" ? "safeguard" : "local";
              // Safeguard appliance policy caps checkout duration at 12h, so
              // clamp ttl_hours and force-disable extended_expiry when
              // switching to the safeguard kind. Minute precision stays
              // available in both branches.
              const clamp = nextKind === "safeguard";
              setEditing({
                ...editing,
                kind: nextKind,
                extended_expiry: clamp ? false : editing.extended_expiry,
                ttl_hours: clamp ? Math.min(editing.ttl_hours, 12) : editing.ttl_hours,
                ttl_minutes: clamp
                  ? editing.ttl_hours >= 12
                    ? 0
                    : (editing.ttl_minutes ?? 0)
                  : (editing.ttl_minutes ?? 0),
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
            <>
              {/* Safeguard entitlement picker. Shown above the manual
                  inputs whenever the appliance returns a non-empty
                  catalog for the signed-in user. Selecting a row
                  autofills the AccountId/Asset fields (and the label,
                  if the user hasn't typed one yet). */}
              <div className="form-group">
                <label htmlFor="prof-sg-picker">Your Safeguard accounts</label>
                {entitlementsLoading ? (
                  <p className="text-txt-tertiary text-xs">Loading your Safeguard accounts…</p>
                ) : entitlementsError === "signin_required" ? (
                  <p className="text-txt-tertiary text-xs">
                    Sign in to Safeguard to pick from your assigned accounts. You can still enter
                    the AccountId and Asset manually below.
                  </p>
                ) : entitlementsError === "load_failed" ? (
                  <p className="text-txt-tertiary text-xs">
                    Could not load your Safeguard accounts. You can still enter the AccountId and
                    Asset manually below.
                  </p>
                ) : entitlements && entitlements.length === 0 ? (
                  <p className="text-txt-tertiary text-xs">
                    Safeguard did not return any entitled accounts for your user. Enter the
                    AccountId and Asset manually below.
                  </p>
                ) : allEntitlementsClaimed ? (
                  <p className="text-txt-tertiary text-xs">
                    Every Safeguard account you are entitled to already has a credential profile.
                    Edit an existing profile, or enter an AccountId and Asset manually below.
                  </p>
                ) : (
                  <>
                    <Select
                      value={selectedEntitlementValue}
                      onChange={(val) => {
                        if (!val) return;
                        const sep = val.indexOf("|");
                        if (sep < 0) return;
                        const accountId = val.slice(0, sep);
                        const assetId = val.slice(sep + 1);
                        const row = entitlements?.find(
                          (r) => r.account_id === accountId && r.asset_id === assetId
                        );
                        const acct = row?.account_name?.trim();
                        const asset = row?.asset_name?.trim();
                        const domain = row?.account_domain_name?.trim();
                        const suggestedLabel = acct
                          ? domain
                            ? `${acct}@${domain}`
                            : asset
                              ? `${acct} — ${asset}`
                              : acct
                          : "";
                        setEditing({
                          ...editing,
                          safeguard_account_id: accountId,
                          // Prefer the human-readable AssetName for the
                          // stored profile (matches the existing
                          // "AssetId or asset name" semantics). Fall
                          // back to the numeric AssetId.
                          safeguard_asset: asset || assetId,
                          label:
                            editing.label && editing.label.trim().length > 0
                              ? editing.label
                              : suggestedLabel,
                        });
                      }}
                      options={[
                        { value: "", label: "— Select a Safeguard account —" },
                        ...entitlementOptions,
                      ]}
                    />
                    <p className="text-txt-tertiary text-[0.6875rem] mt-1">
                      Picks an account/asset pair from Safeguard. You can still override the
                      AccountId or Asset manually below.
                    </p>
                  </>
                )}
              </div>
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
            </>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div className="form-group">
                <label htmlFor="prof-username">Username</label>
                <input
                  id="prof-username"
                  value={editing.username}
                  onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                  placeholder={
                    switchingFromSafeguardToLocal
                      ? "sAMAccountName (e.g. jsmith)"
                      : editing.id
                        ? "(unchanged)"
                        : "sAMAccountName (e.g. jsmith)"
                  }
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
                  placeholder={
                    switchingFromSafeguardToLocal
                      ? "Enter password"
                      : editing.id
                        ? "(unchanged)"
                        : "Enter password"
                  }
                  autoComplete="new-password"
                />
              </div>
            </div>
          )}
          <div className="form-group">
            <label htmlFor="prof-ttl">Password Expiry</label>
            {editing.extended_expiry && !isSafeguard ? (
              // Extended (up-to-90-days) branch stays days-only — the
              // wide range makes minute precision meaningless.
              <div className="flex items-center gap-3">
                {(() => {
                  const val = Math.max(1, Math.round(editing.ttl_hours / 24));
                  const pct = ((val - 1) / (90 - 1)) * 100;
                  return (
                    <input
                      id="prof-ttl"
                      type="range"
                      min={1}
                      max={90}
                      step={1}
                      value={val}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setEditing({
                          ...editing,
                          ttl_hours: n * 24,
                          ttl_minutes: 0,
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
                  {(() => {
                    const days = Math.max(1, Math.round(editing.ttl_hours / 24));
                    return `${days} ${days === 1 ? "day" : "days"}`;
                  })()}
                </span>
              </div>
            ) : (
              // Standard (≤12h) branch — two number inputs so operators
              // can pin a precise value like "1h 30m" or "45m" that a
              // long slider would make hard to hit.
              (() => {
                const hoursCap = isSafeguard ? 12 : 12;
                const totalMin = editing.ttl_hours * 60 + (editing.ttl_minutes ?? 0);
                const clampTotal = (h: number, m: number): { h: number; m: number } => {
                  // Normalise to [15 min, hoursCap * 60].
                  const raw = Math.max(0, h) * 60 + Math.max(0, m);
                  const capped = Math.min(hoursCap * 60, Math.max(15, raw));
                  return { h: Math.floor(capped / 60), m: capped % 60 };
                };
                return (
                  <>
                    <div className="flex items-end gap-3 flex-wrap">
                      <div>
                        <label htmlFor="prof-ttl" className="block text-xs text-txt-secondary mb-1">
                          Hours
                        </label>
                        <input
                          id="prof-ttl"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={hoursCap}
                          step={1}
                          value={editing.ttl_hours}
                          onChange={(e) => {
                            const raw = Number(e.target.value);
                            const h = Number.isFinite(raw) ? raw : 0;
                            const { h: nh, m: nm } = clampTotal(h, editing.ttl_minutes ?? 0);
                            setEditing({ ...editing, ttl_hours: nh, ttl_minutes: nm });
                          }}
                          className="input w-24 tabular-nums"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="prof-ttl-min"
                          className="block text-xs text-txt-secondary mb-1"
                        >
                          Minutes
                        </label>
                        <input
                          id="prof-ttl-min"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={59}
                          step={5}
                          value={editing.ttl_minutes ?? 0}
                          onChange={(e) => {
                            const raw = Number(e.target.value);
                            const m = Number.isFinite(raw) ? raw : 0;
                            const { h: nh, m: nm } = clampTotal(editing.ttl_hours, m);
                            setEditing({ ...editing, ttl_hours: nh, ttl_minutes: nm });
                          }}
                          className="input w-24 tabular-nums"
                        />
                      </div>
                      <div className="ml-auto text-right">
                        <div className="text-xs text-txt-tertiary">Total</div>
                        <div className="text-txt-primary font-semibold tabular-nums">
                          {(() => {
                            const h = editing.ttl_hours;
                            const m = editing.ttl_minutes ?? 0;
                            const parts: string[] = [];
                            if (h > 0) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
                            if (m > 0 || h === 0)
                              parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
                            return parts.join(" ");
                          })()}
                        </div>
                      </div>
                    </div>
                    {/* Quick-pick chips so common durations are one click away. */}
                    <div className="flex flex-wrap gap-2 mt-2">
                      {[
                        { label: "15 min", h: 0, m: 15 },
                        { label: "30 min", h: 0, m: 30 },
                        { label: "1 h", h: 1, m: 0 },
                        { label: "2 h", h: 2, m: 0 },
                        { label: "4 h", h: 4, m: 0 },
                        { label: "8 h", h: 8, m: 0 },
                        { label: "12 h", h: 12, m: 0 },
                      ].map((preset) => {
                        const active =
                          editing.ttl_hours === preset.h && (editing.ttl_minutes ?? 0) === preset.m;
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            className={`px-2 py-1 rounded text-xs border transition-colors ${
                              active
                                ? "bg-accent text-white border-accent"
                                : "border-border-subtle text-txt-secondary hover:text-txt-primary hover:border-border-strong"
                            }`}
                            onClick={() =>
                              setEditing({
                                ...editing,
                                ttl_hours: preset.h,
                                ttl_minutes: preset.m,
                              })
                            }
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                    {totalMin < 15 && (
                      <p className="text-warning text-xs mt-1">
                        Minimum lifetime is 15 minutes — the value will be rounded up on save.
                      </p>
                    )}
                  </>
                );
              })()
            )}
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
                      // Also zero the sub-hour component since extended is
                      // days-only and the standard default is a whole hour.
                      ttl_hours: next ? 720 : 12,
                      ttl_minutes: 0,
                    });
                  }}
                />
                Allow extended expiry (up to 90 days) — use only for service or break-glass
                accounts.
              </label>
            )}
            <p className="text-txt-tertiary text-xs mt-1">
              Credentials expire after this duration and must be updated.{" "}
              {isSafeguard
                ? "Minimum 15 minutes; maximum 12 hours (capped by Safeguard appliance policy)."
                : editing.extended_expiry
                  ? "Extended expiry enabled — maximum 90 days."
                  : "Minimum 15 minutes; maximum 12 hours."}
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
