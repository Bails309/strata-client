import { useEffect, useState } from "react";
import { getServiceHealth, updateSettings, updateVault, ServiceHealth } from "../../api";

export default function VaultTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [mode, setMode] = useState<"local" | "external">("local");
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [transitKey, setTransitKey] = useState("guac-master-key");
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [saving, setSaving] = useState(false);
  const [credTtl, setCredTtl] = useState(12);
  const [ttlSaving, setTtlSaving] = useState(false);

  useEffect(() => {
    getServiceHealth()
      .then((h) => {
        setHealth(h);
        if (h.vault.configured) {
          setMode(h.vault.mode === "local" ? "local" : "external");
          setAddress(h.vault.address);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const v = parseInt(settings.credential_ttl_hours || "12", 10);
    setCredTtl(Math.max(1, Math.min(12, isNaN(v) ? 12 : v)));
  }, [settings]);

  async function handleSave() {
    setSaving(true);
    try {
      if (mode === "local") {
        await updateVault({ mode: "local", transit_key: transitKey });
      } else {
        await updateVault({ mode: "external", address, token, transit_key: transitKey });
      }
      onSave();
    } catch {
      // handled by caller
    } finally {
      setSaving(false);
    }
  }

  const currentMode =
    health?.vault.mode === "local"
      ? "Bundled"
      : health?.vault.mode === "external"
        ? "External"
        : null;

  return (
    <div className="card">
      <h2>Vault Configuration</h2>
      {currentMode && (
        <p className="text-txt-secondary text-sm mb-4">
          Currently using <strong>{currentMode}</strong> vault at{" "}
          <code className="bg-surface-tertiary px-1.5 py-0.5 rounded text-xs">
            {health?.vault.address}
          </code>
          .
        </p>
      )}

      <div className="form-group">
        <span id="vault-mode-label" className="text-sm font-medium mb-2 block">Vault Mode</span>
        <div className="flex gap-2" role="group" aria-labelledby="vault-mode-label">
          <button
            className={`btn flex-1 ${mode === "local" ? "!bg-accent/10 !border-accent !text-accent" : ""}`}
            onClick={() => setMode("local")}
          >
            Bundled
          </button>
          <button
            className={`btn flex-1 ${mode === "external" ? "!bg-accent/10 !border-accent !text-accent" : ""}`}
            onClick={() => setMode("external")}
          >
            External
          </button>
        </div>
      </div>

      {mode === "local" && (
        <p className="text-txt-secondary text-sm mb-4">
          Uses the bundled Vault container. It will be automatically initialized, unsealed, and
          configured.
        </p>
      )}

      {mode === "external" && (
        <>
          <div className="form-group">
            <label htmlFor="vault-url">Vault URL</label>
            <input
              id="vault-url"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="http://vault:8200"
            />
          </div>
          <div className="form-group">
            <label htmlFor="vault-token">Vault Token / AppRole</label>
            <input
              id="vault-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="s.xxxxxxxxx"
            />
          </div>
        </>
      )}

      <div className="form-group">
        <label htmlFor="vault-transit-key">Transit Key Name</label>
        <input id="vault-transit-key" value={transitKey} onChange={(e) => setTransitKey(e.target.value)} />
      </div>

      <button className="btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save Vault Settings"}
      </button>

      {/* ── Credential Password Expiry ── */}
      <div
        style={{
          borderTop: "1px solid var(--color-border)",
          marginTop: "2rem",
          paddingTop: "1.5rem",
        }}
      >
        <h3 className="!mb-1">Credential Password Expiry</h3>
        <p className="text-txt-secondary text-sm mb-4">
          Stored credentials automatically expire after this duration. Users must update their
          password before expired credentials will be used. Maximum allowed TTL is 12 hours.
        </p>
        <div className="form-group">
          <label htmlFor="vault-cred-ttl">Time-to-Live (hours)</label>
          <div className="flex items-center gap-3">
            <input
              id="vault-cred-ttl"
              type="range"
              min={1}
              max={12}
              step={1}
              value={credTtl}
              onChange={(e) => setCredTtl(Number(e.target.value))}
              className="flex-1"
              style={{ accentColor: "var(--color-accent)" }}
            />
            <span className="text-txt-primary font-semibold tabular-nums w-10 text-right">
              {credTtl}h
            </span>
          </div>
        </div>
        <button
          className="btn-primary"
          disabled={ttlSaving}
          onClick={async () => {
            setTtlSaving(true);
            try {
              await updateSettings([{ key: "credential_ttl_hours", value: String(credTtl) }]);
              onSave();
            } catch {
              /* ignore */
            } finally {
              setTtlSaving(false);
            }
          }}
        >
          {ttlSaving ? "Saving..." : "Save Expiry Setting"}
        </button>
      </div>
    </div>
  );
}
