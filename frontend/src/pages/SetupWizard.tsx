import { useState } from "react";
import { initialize, InitRequest } from "../api";

interface Props {
  onComplete: () => void;
}

type VaultMode = "local" | "external" | "skip";

export default function SetupWizard({ onComplete }: Props) {
  const [vaultMode, setVaultMode] = useState<VaultMode>("local");
  const [vaultAddr, setVaultAddr] = useState("");
  const [vaultToken, setVaultToken] = useState("");
  const [vaultKey, setVaultKey] = useState("guac-master-key");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    setError("");

    const req: InitRequest = {};

    if (vaultMode === "local") {
      req.vault_mode = "local";
      req.vault_transit_key = vaultKey || undefined;
    } else if (vaultMode === "external") {
      req.vault_mode = "external";
      req.vault_address = vaultAddr || undefined;
      req.vault_token = vaultToken || undefined;
      req.vault_transit_key = vaultKey || undefined;
    }

    try {
      await initialize(req);
      onComplete();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Initialization failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="card w-full max-w-[520px]">
        <h1>Strata Client Setup</h1>
        <p className="text-txt-secondary mb-6">
          The database is configured automatically via environment variables. Configure Vault for
          credential encryption below.
        </p>

        {error && (
          <div className="rounded-md mb-4 px-4 py-2 bg-danger-dim text-danger">{error}</div>
        )}

        <div className="form-group">
          <span id="setup-vault-mode-label" className="text-sm font-medium mb-2 block">
            Vault Mode
          </span>
          <div className="grid gap-2" role="radiogroup" aria-labelledby="setup-vault-mode-label">
            {[
              {
                value: "local" as VaultMode,
                label: "Bundled Vault",
                desc: "Auto-configured container — no setup required",
              },
              {
                value: "external" as VaultMode,
                label: "External Vault",
                desc: "Connect to your own HashiCorp Vault instance",
              },
              {
                value: "skip" as VaultMode,
                label: "Skip for Now",
                desc: "Use local encryption only — configure Vault later",
              },
            ].map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                  vaultMode === opt.value
                    ? "border-accent bg-accent/5"
                    : "border-border hover:border-border-hover"
                }`}
              >
                <input
                  type="radio"
                  name="vaultMode"
                  value={opt.value}
                  checked={vaultMode === opt.value}
                  onChange={() => setVaultMode(opt.value)}
                  className="!w-auto mt-0.5"
                />
                <div>
                  <div className="font-medium text-sm">{opt.label}</div>
                  <div className="text-txt-tertiary text-xs">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {vaultMode === "external" && (
          <>
            <div className="form-group">
              <label htmlFor="setup-vault-url">Vault URL</label>
              <input
                id="setup-vault-url"
                type="text"
                placeholder="http://vault:8200"
                value={vaultAddr}
                onChange={(e) => setVaultAddr(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label htmlFor="setup-vault-token">Vault Token / AppRole</label>
              <input
                id="setup-vault-token"
                type="password"
                placeholder="s.xxxxxxxxx"
                value={vaultToken}
                onChange={(e) => setVaultToken(e.target.value)}
              />
            </div>
          </>
        )}

        {vaultMode !== "skip" && (
          <div className="form-group">
            <label htmlFor="setup-vault-transit-key">Transit Key Name</label>
            <input
              id="setup-vault-transit-key"
              type="text"
              value={vaultKey}
              onChange={(e) => setVaultKey(e.target.value)}
            />
          </div>
        )}

        <button className="btn-primary" onClick={handleSubmit} disabled={loading}>
          {loading ? "Initializing…" : "Complete Setup"}
        </button>
      </div>
    </div>
  );
}
