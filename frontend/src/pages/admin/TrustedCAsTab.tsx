import { useEffect, useState } from "react";
import { TrustedCaSummary, getTrustedCas, createTrustedCa, deleteTrustedCa } from "../../api";

/**
 * Admin tab for managing reusable Trusted CA bundles. Web kiosk
 * connections reference a row from this list by UUID; at session
 * launch the backend writes the PEM into the per-session NSS DB so
 * Chromium trusts the supplied roots without `--ignore-certificate-errors`.
 */
export default function TrustedCAsTab({ onSave }: { onSave: () => void }) {
  const [rows, setRows] = useState<TrustedCaSummary[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pem, setPem] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function reload() {
    getTrustedCas()
      .then(setRows)
      .catch((e) => setError(String(e?.message ?? e)));
  }
  useEffect(reload, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim() || !pem.trim()) {
      setError("Name and PEM are both required.");
      return;
    }
    setBusy(true);
    try {
      await createTrustedCa({ name: name.trim(), description: description.trim(), pem });
      setName("");
      setDescription("");
      setPem("");
      reload();
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(row: TrustedCaSummary) {
    if (!confirm(`Delete trusted CA "${row.name}"?`)) return;
    setError("");
    try {
      await deleteTrustedCa(row.id);
      reload();
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPem(text);
    if (!name) setName(file.name.replace(/\.(pem|crt|cer)$/i, ""));
  }

  return (
    <div className="card">
      <h2>Trusted Certificate Authorities</h2>
      <p className="text-sm text-muted mb-4">
        Upload a PEM bundle once; web connections can then attach it from a dropdown so the kiosk
        Chromium trusts your private CAs without disabling certificate validation.
      </p>

      {error && <div className="rounded-md mb-4 px-4 py-2 bg-danger/10 text-danger">{error}</div>}

      <form onSubmit={handleAdd} className="mb-6">
        <div className="form-group">
          <label htmlFor="trusted-ca-name">Name</label>
          <input
            id="trusted-ca-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Internal Corp Root CA"
          />
        </div>
        <div className="form-group">
          <label htmlFor="trusted-ca-description">Description (optional)</label>
          <input
            id="trusted-ca-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Issued 2024-03; expires 2034-03"
          />
        </div>
        <div className="form-group">
          <label htmlFor="trusted-ca-file">PEM file</label>
          <input id="trusted-ca-file" type="file" accept=".pem,.crt,.cer" onChange={handleFile} />
        </div>
        <div className="form-group">
          <label htmlFor="trusted-ca-pem">PEM contents</label>
          <textarea
            id="trusted-ca-pem"
            rows={8}
            value={pem}
            onChange={(e) => setPem(e.target.value)}
            placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
            className="font-mono text-xs"
          />
        </div>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Add Trusted CA"}
        </button>
      </form>

      <h3>Stored bundles ({rows.length})</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No trusted CAs configured yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">Name</th>
              <th className="text-left">Subject</th>
              <th className="text-left">Expires</th>
              <th className="text-left">Fingerprint (SHA-256)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="font-medium">{r.name}</div>
                  {r.description && <div className="text-xs text-muted">{r.description}</div>}
                </td>
                <td className="text-xs">{r.subject ?? "—"}</td>
                <td className="text-xs">
                  {r.not_after ? new Date(r.not_after).toLocaleDateString() : "—"}
                </td>
                <td className="text-xs font-mono break-all">
                  {r.fingerprint ? r.fingerprint.slice(0, 32) + "…" : "—"}
                </td>
                <td>
                  <button className="btn-danger-soft" onClick={() => handleDelete(r)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
