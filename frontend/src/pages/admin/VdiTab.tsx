import { useState } from "react";
import { updateSettings } from "../../api";

/**
 * VDI tab — operator-facing controls for the `vdi` protocol's two
 * `system_settings` keys:
 *
 *   - `vdi_image_whitelist`  (newline- or comma-separated; strict equality)
 *   - `max_vdi_containers`   (integer; blank ⇒ unbounded)
 *
 * Both are written through the generic `PUT /api/admin/settings` route
 * (neither key is on the restricted list). The runtime feature flag
 * `STRATA_VDI_ENABLED` is intentionally **not** editable here — it is
 * a deploy-time decision baked into `docker-compose.vdi.yml` because
 * enabling VDI requires mounting `/var/run/docker.sock` (= host root).
 */
export default function VdiTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [whitelist, setWhitelist] = useState(settings.vdi_image_whitelist || "");
  const [maxContainers, setMaxContainers] = useState(settings.max_vdi_containers || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const lineCount = whitelist
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#")).length;

  async function handleSave() {
    setError("");
    if (maxContainers.trim() !== "") {
      const n = Number(maxContainers);
      if (!Number.isInteger(n) || n < 0) {
        setError("Max containers must be a non-negative integer (or blank for unbounded).");
        return;
      }
    }
    setSaving(true);
    try {
      await updateSettings([
        { key: "vdi_image_whitelist", value: whitelist },
        { key: "max_vdi_containers", value: maxContainers.trim() },
      ]);
      onSave();
    } catch (e) {
      setError((e as Error).message || "Failed to save VDI settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mt-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/50 border-b border-border mb-6 -mx-7 -mt-7">
        <div>
          <h3 className="text-lg font-semibold text-txt-primary">VDI Desktop Containers</h3>
          <p className="text-sm text-txt-secondary mt-0.5">
            Image whitelist and concurrency cap for the <code>vdi</code> protocol. The runtime
            feature flag <code>STRATA_VDI_ENABLED</code> is set at deploy time via{" "}
            <code>docker-compose.vdi.yml</code>; this tab only controls per-tenant policy.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md mb-4 px-4 py-2 bg-danger/10 text-danger text-sm">{error}</div>
      )}

      <div className="space-y-6">
        <div className="form-group">
          <label htmlFor="vdi-whitelist" className="block text-sm font-medium mb-2">
            Image whitelist
          </label>
          <p className="text-xs text-txt-secondary mb-3">
            One image reference per line (or comma-separated). Strict equality — no glob, no
            <code> :latest</code> shortcut, no digest fuzziness. Lines starting with{" "}
            <code>#</code> are treated as comments. Currently <strong>{lineCount}</strong>{" "}
            image{lineCount === 1 ? "" : "s"} approved.
          </p>
          <textarea
            id="vdi-whitelist"
            className="input w-full font-mono text-sm"
            rows={8}
            placeholder={
              "# Approved Strata VDI images for 2026-Q2\n" +
              "strata/vdi-ubuntu:24.04-2026.04.01\n" +
              "strata/vdi-rocky:9-2026.04.01"
            }
            value={whitelist}
            onChange={(e) => setWhitelist(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="vdi-max-containers" className="block text-sm font-medium mb-2">
            Max concurrent containers
          </label>
          <p className="text-xs text-txt-secondary mb-3">
            Hard cap on simultaneously-running VDI containers across all users. Leave blank for
            unbounded (limited only by the host's resources).
          </p>
          <input
            id="vdi-max-containers"
            type="number"
            min={0}
            step={1}
            className="input w-32"
            placeholder="unbounded"
            value={maxContainers}
            onChange={(e) => setMaxContainers(e.target.value)}
          />
        </div>

        <div className="rounded-md p-4 bg-warning/10 border border-warning/30 text-sm">
          <strong className="text-warning">Reminder:</strong>{" "}
          Strata's <code>DockerVdiDriver</code> mounts <code>/var/run/docker.sock</code>, which
          gives the backend root on the host. Treat the backend container as a privileged
          service. See <code>docs/vdi.md</code> for the full threat model.
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-border/10 flex justify-end">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save VDI settings"}
        </button>
      </div>
    </div>
  );
}
