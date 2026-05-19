import { useEffect, useState } from "react";
import {
  getSsoProviders,
  createSsoProvider,
  updateSsoProvider,
  deleteSsoProvider,
  testSsoConnection,
  SsoProvider,
} from "../../api";

export default function SsoTab({
  onSave,
}: {
  settings: Record<string, string>;
  onSave: () => void;
}) {
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  useEffect(() => {
    loadProviders();
  }, []);

  async function loadProviders() {
    setLoading(true);
    try {
      const data = await getSsoProviders();
      setProviders(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }

  function handleAddNew() {
    setEditingId(null);
    setName("");
    setIssuer("");
    setClientId("");
    setClientSecret("");
    setTestResult(null);
    setShowForm(true);
  }

  function handleEdit(p: SsoProvider) {
    setEditingId(p.id);
    setName(p.name);
    setIssuer(p.issuer_url);
    setClientId(p.client_id);
    setClientSecret(""); // leave empty to avoid displaying it
    setTestResult(null);
    setShowForm(true);
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Are you sure you want to delete this SSO provider?")) return;
    try {
      await deleteSsoProvider(id);
      await loadProviders();
      onSave(); // Trigger status refresh in parent
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (editingId) {
        await updateSsoProvider(editingId, {
          name,
          issuer_url: issuer,
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        });
      } else {
        await createSsoProvider({
          name,
          issuer_url: issuer,
          client_id: clientId,
          client_secret: clientSecret,
        });
      }
      setShowForm(false);
      await loadProviders();
      onSave();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save provider");
    }
  }

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

  if (loading) {
    return (
      <div className="card text-center py-8">
        <div className="w-6 h-6 rounded-full animate-spin mx-auto mb-2 border-2 border-border border-t-accent" />
        <p className="text-sm text-txt-secondary">Loading providers...</p>
      </div>
    );
  }

  const callbackUrl = `${window.location.origin}/api/auth/sso/callback`;

  if (showForm) {
    return (
      <div className="card animate-fade-in">
        <div className="flex items-center justify-between mb-4">
          <h2 className="!mb-0">{editingId ? "Edit SSO Provider" : "Add SSO Provider"}</h2>
          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-wider text-txt-tertiary font-bold mb-1">
              Callback URL
            </span>
            <code className="text-[11px] bg-surface-tertiary px-2 py-1 rounded border border-border font-mono text-accent select-all">
              {callbackUrl}
            </code>
          </div>
        </div>

        {error && (
          <div className="rounded-md mb-4 px-4 py-2 text-sm bg-danger-dim text-danger">{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="sso-name">Provider Name</label>
            <input
              id="sso-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Azure AD, Okta, Keycloak"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="sso-issuer">Issuer URL</label>
            <input
              id="sso-issuer"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="https://keycloak.example.com/realms/strata"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="sso-client-id">Client ID</label>
            <input
              id="sso-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="sso-client-secret">Client Secret</label>
            <input
              id="sso-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={editingId ? "Leave blank to keep existing secret" : "Required"}
              required={!editingId}
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

          <div className="flex items-center gap-3 pt-2 border-t border-border/50">
            <button type="submit" className="btn-primary">
              {editingId ? "Save Changes" : "Add Provider"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleTest}
              disabled={testing || !issuer || !clientId || (!clientSecret && !editingId)}
            >
              {testing ? "Testing..." : "Test Connection"}
            </button>
            <button
              type="button"
              className="btn bg-transparent border-transparent hover:bg-surface-secondary"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="card animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="!mb-0">SSO / OIDC Providers</h2>
          <p className="text-xs text-txt-secondary mt-1">
            Configure authentication providers like Azure AD, Okta, or Keycloak.
          </p>
        </div>
        <button className="btn-primary text-sm px-3 py-1.5" onClick={handleAddNew}>
          <div className="flex items-center gap-1.5">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Provider
          </div>
        </button>
      </div>

      {error && (
        <div className="rounded-md mb-4 px-4 py-2 text-sm bg-danger-dim text-danger">{error}</div>
      )}

      {providers.length === 0 ? (
        <div className="text-center py-10 text-txt-secondary border border-dashed border-border rounded-lg">
          <svg
            className="w-10 h-10 mx-auto mb-3 text-txt-tertiary opacity-50"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <p className="font-medium text-txt-primary mb-1">No providers configured</p>
          <p className="text-sm">Add an SSO provider to enable enterprise login.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between p-4 border border-border rounded-lg bg-surface-secondary hover:border-accent/30 transition-colors"
            >
              <div>
                <h3 className="font-semibold text-txt-primary flex items-center gap-2">{p.name}</h3>
                <p
                  className="text-xs text-txt-tertiary truncate max-w-md mt-1"
                  title={p.issuer_url}
                >
                  {p.issuer_url}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  className="btn px-3 py-1 text-sm bg-surface-primary hover:bg-surface-tertiary"
                  onClick={() => handleEdit(p)}
                >
                  Edit
                </button>
                <button
                  className="btn px-3 py-1 text-sm text-danger hover:bg-danger-dim hover:border-danger/30 bg-surface-primary"
                  onClick={() => handleDelete(p.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
