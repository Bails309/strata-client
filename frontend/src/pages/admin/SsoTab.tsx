import { useEffect, useState } from "react";
import { testSsoConnection, updateSso } from "../../api";

export default function SsoTab({
  settings,
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [issuer, setIssuer] = useState(settings.sso_issuer_url || "");
  const [clientId, setClientId] = useState(settings.sso_client_id || "");
  const [clientSecret, setClientSecret] = useState(settings.sso_client_secret || "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  useEffect(() => {
    setIssuer(settings.sso_issuer_url || "");
    setClientId(settings.sso_client_id || "");
    setClientSecret(settings.sso_client_secret || "");
  }, [settings]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testSsoConnection({
        issuer_url: issuer,
        client_id: clientId,
        client_secret: clientSecret,
      });
      setTestResult({ success: res.status === "success", msg: res.message });
    } catch (err: unknown) {
      setTestResult({ success: false, msg: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  const callbackUrl = `${window.location.origin}/api/auth/sso/callback`;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="!mb-0">SSO / OIDC (Keycloak)</h2>
        <div className="flex flex-col items-end">
          <span className="text-[10px] uppercase tracking-wider text-txt-tertiary font-bold mb-1">
            Callback URL
          </span>
          <code className="text-[11px] bg-surface-tertiary px-2 py-1 rounded border border-border font-mono text-accent">
            {callbackUrl}
          </code>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="sso-issuer">Issuer URL</label>
        <input
          id="sso-issuer"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          placeholder="https://keycloak.example.com/realms/strata"
        />
      </div>
      <div className="form-group">
        <label htmlFor="sso-client-id">Client ID</label>
        <input id="sso-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor="sso-client-secret">Client Secret</label>
        <input
          id="sso-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={settings.sso_client_secret ? "********" : ""}
        />
      </div>

      {testResult && (
        <div
          className={`rounded-md mb-4 px-4 py-2 text-sm ${testResult.success ? "bg-success-dim text-success" : "bg-danger-dim text-danger"}`}
        >
          <div className="flex items-center gap-2">
            {testResult.success ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
            {testResult.msg}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          className="btn-primary"
          onClick={async () => {
            await updateSso({
              issuer_url: issuer,
              client_id: clientId,
              client_secret: clientSecret,
            });
            onSave();
          }}
        >
          Save SSO Settings
        </button>
        <button
          className="btn"
          onClick={handleTest}
          disabled={testing || !issuer || !clientId || !clientSecret}
        >
          {testing ? "Testing..." : "Test Connection"}
        </button>
      </div>
    </div>
  );
}
