import { useEffect, useState } from "react";
import ConfirmModal from "../../components/ConfirmModal";
import { updateAuthMethods, updateSettings } from "../../api";

export default function SecurityTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    isDangerous?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [watermarkEnabled, setWatermarkEnabled] = useState(settings.watermark_enabled === "true");
  const [ssoEnabled, setSsoEnabled] = useState(settings.sso_enabled === "true");
  const [localAuthEnabled, setLocalAuthEnabled] = useState(
    settings.local_auth_enabled === undefined ? true : settings.local_auth_enabled === "true"
  );
  const [userHardDeleteDays, setUserHardDeleteDays] = useState(
    settings.user_hard_delete_days || "90"
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWatermarkEnabled(settings.watermark_enabled === "true");
    setSsoEnabled(settings.sso_enabled === "true");
    setLocalAuthEnabled(
      settings.local_auth_enabled === undefined ? true : settings.local_auth_enabled === "true"
    );
    setUserHardDeleteDays(settings.user_hard_delete_days || "90");
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    try {
      // Validate hard-delete window: positive integer, 1..3650 (10 years).
      const parsedDays = parseInt(userHardDeleteDays, 10);
      if (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > 3650) {
        throw new Error("User hard-delete window must be between 1 and 3650 days.");
      }

      // Update general security settings
      await updateSettings([
        { key: "watermark_enabled", value: String(watermarkEnabled) },
        { key: "user_hard_delete_days", value: String(parsedDays) },
      ]);

      // Update authentication methods (dedicated endpoint with validation)
      await updateAuthMethods({
        sso_enabled: ssoEnabled,
        local_auth_enabled: localAuthEnabled,
      });

      onSave();
    } catch {
      /* handled by parent */
    }
    setSaving(false);
  }

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">Security Settings</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Configure global security policies and authentication methods.
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Authentication Methods
          </h4>
          <div className="space-y-5">
            <div className="form-group">
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={localAuthEnabled}
                  onChange={(e) => {
                    const val = e.target.checked;
                    if (!val && !ssoEnabled) return; // Prevent disabling both
                    setLocalAuthEnabled(val);
                  }}
                  className="checkbox"
                />
                <div>
                  <span className="font-medium group-hover:text-txt-primary transition-colors">
                    Local Authentication
                  </span>
                  <p className="text-txt-secondary text-sm mt-0.5">
                    Allow users to log in with a username and password stored in the local database.
                  </p>
                </div>
              </label>
            </div>

            <div className="form-group">
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={ssoEnabled}
                  onChange={(e) => {
                    const val = e.target.checked;
                    if (!val && !localAuthEnabled) return; // Prevent disabling both
                    setSsoEnabled(val);
                  }}
                  className="checkbox"
                />
                <div>
                  <span className="font-medium group-hover:text-txt-primary transition-colors">
                    SSO / OIDC (Keycloak)
                  </span>
                  <p className="text-txt-secondary text-sm mt-0.5">
                    Enable Single Sign-On via OpenID Connect. Ensure you have configured the
                    provider settings in the SSO tab.
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-border/10">
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Session Protection
          </h4>
          <div className="form-group">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={watermarkEnabled}
                onChange={(e) => setWatermarkEnabled(e.target.checked)}
                className="checkbox"
              />
              <div>
                <span className="font-medium group-hover:text-txt-primary transition-colors">
                  Session Watermark
                </span>
                <p className="text-txt-secondary text-sm mt-0.5">
                  Overlay a semi-transparent watermark on all active sessions showing the user&apos;s
                  name, IP address, and timestamp. Helps deter unauthorized screen capture.
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="pt-6 border-t border-border/10">
          <h4 className="text-sm font-semibold text-txt-primary uppercase tracking-wider mb-4">
            Data Retention
          </h4>
          <div className="form-group">
            <label htmlFor="user-hard-delete-days" className="block font-medium mb-1">
              User hard-delete window (days)
            </label>
            <input
              id="user-hard-delete-days"
              type="number"
              min={1}
              max={3650}
              value={userHardDeleteDays}
              onChange={(e) => setUserHardDeleteDays(e.target.value)}
              className="w-32"
            />
            <p className="text-txt-secondary text-sm mt-1">
              Number of days a soft-deleted user remains recoverable before the background cleanup
              task permanently removes their record and any associated session recordings. Defaults
              to 90 days. Must be between 1 and 3650.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-border/10">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Security Settings"}
        </button>
      </div>
      <ConfirmModal
        isOpen={!!confirmModal}
        title={confirmModal?.title || ""}
        message={confirmModal?.message || ""}
        confirmLabel={confirmModal?.confirmLabel}
        isDangerous={confirmModal?.isDangerous}
        onConfirm={() => confirmModal?.onConfirm()}
        onCancel={() => setConfirmModal(null)}
      />
    </div>
  );
}
