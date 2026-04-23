import { useCallback, useEffect, useState } from "react";
import {
  createKerberosRealm,
  deleteKerberosRealm,
  getKerberosRealms,
  KerberosRealm,
  updateKerberosRealm,
} from "../../api";

export default function KerberosTab({ onSave }: { onSave: () => void }) {
  const [realms, setRealms] = useState<KerberosRealm[]>([]);
  const [editing, setEditing] = useState<{
    id?: string;
    realm: string;
    kdcs: string[];
    admin_server: string;
    ticket_lifetime: string;
    renew_lifetime: string;
    is_default: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await getKerberosRealms();
      setRealms(list);
    } catch {
      setError("Failed to load Kerberos realms");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateKdc = (i: number, val: string) => {
    if (!editing) return;
    const next = [...editing.kdcs];
    next[i] = val;
    setEditing({ ...editing, kdcs: next });
  };

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      if (editing.id) {
        await updateKerberosRealm(editing.id, {
          realm: editing.realm,
          kdc_servers: editing.kdcs.filter(Boolean),
          admin_server: editing.admin_server,
          ticket_lifetime: editing.ticket_lifetime,
          renew_lifetime: editing.renew_lifetime,
          is_default: editing.is_default,
        });
      } else {
        if (!editing.realm) {
          setError("Realm name is required");
          setSaving(false);
          return;
        }
        await createKerberosRealm({
          realm: editing.realm,
          kdc_servers: editing.kdcs.filter(Boolean),
          admin_server: editing.admin_server,
          ticket_lifetime: editing.ticket_lifetime,
          renew_lifetime: editing.renew_lifetime,
          is_default: editing.is_default,
        });
      }
      setEditing(null);
      await load();
      onSave();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError("");
    try {
      await deleteKerberosRealm(id);
      await load();
      onSave();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function openNew() {
    setEditing({
      realm: "",
      kdcs: [""],
      admin_server: "",
      ticket_lifetime: "10h",
      renew_lifetime: "7d",
      is_default: realms.length === 0,
    });
  }

  function openEdit(r: KerberosRealm) {
    setEditing({
      id: r.id,
      realm: r.realm,
      kdcs: r.kdc_servers.split(",").filter(Boolean),
      admin_server: r.admin_server,
      ticket_lifetime: r.ticket_lifetime,
      renew_lifetime: r.renew_lifetime,
      is_default: r.is_default,
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="!mb-0">Kerberos Realms</h2>
          <p className="text-txt-secondary text-sm mt-1">
            Configure one or more Active Directory domains / Kerberos realms. Each realm gets its
            own KDC configuration in the shared krb5.conf.
          </p>
        </div>
        <button className="btn-primary" onClick={openNew}>
          <span className="flex items-center gap-2">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Realm
          </span>
        </button>
      </div>

      {error && (
        <div className="rounded-sm mb-4 px-4 py-2 text-[0.8125rem] bg-danger-dim text-danger">
          {error}
        </div>
      )}

      {/* ── Create / Edit form ── */}
      {editing && (
        <div
          className="card mb-4"
          style={{ border: "1px solid var(--color-accent)", boxShadow: "var(--shadow-accent)" }}
        >
          <h3 className="!mb-4">{editing.id ? "Edit Realm" : "New Kerberos Realm"}</h3>
          <div className="form-group">
            <label htmlFor="krb-realm">Realm Name</label>
            <input
              id="krb-realm"
              value={editing.realm}
              onChange={(e) => setEditing({ ...editing, realm: e.target.value })}
              placeholder="EXAMPLE.COM"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>KDC Servers</label>
            {editing.kdcs.map((k, i) => (
              <div key={i} className="flex gap-2 mb-[0.4rem]">
                <input
                  id={`krb-kdc-${i}`}
                  value={k}
                  onChange={(e) => updateKdc(i, e.target.value)}
                  placeholder={`KDC ${i + 1} (e.g. dc${i + 1}.example.com)`}
                />
                {editing.kdcs.length > 1 && (
                  <button
                    type="button"
                    className="btn !w-auto px-[0.7rem] py-[0.4rem] shrink-0"
                    onClick={() =>
                      setEditing({ ...editing, kdcs: editing.kdcs.filter((_, j) => j !== i) })
                    }
                  >
                    X
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="btn !w-auto mt-1 text-[0.8rem]"
              onClick={() => setEditing({ ...editing, kdcs: [...editing.kdcs, ""] })}
            >
              + Add KDC
            </button>
          </div>
          <div className="form-group">
            <label htmlFor="krb-admin">Admin Server</label>
            <input
              id="krb-admin"
              value={editing.admin_server}
              onChange={(e) => setEditing({ ...editing, admin_server: e.target.value })}
              placeholder="dc1.example.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="form-group">
              <label htmlFor="krb-ticket">Ticket Lifetime</label>
              <input
                id="krb-ticket"
                value={editing.ticket_lifetime}
                onChange={(e) => setEditing({ ...editing, ticket_lifetime: e.target.value })}
                placeholder="10h"
              />
            </div>
            <div className="form-group">
              <label htmlFor="krb-renew">Renew Lifetime</label>
              <input
                id="krb-renew"
                value={editing.renew_lifetime}
                onChange={(e) => setEditing({ ...editing, renew_lifetime: e.target.value })}
                placeholder="7d"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer !mb-0">
              <input
                type="checkbox"
                className="checkbox"
                checked={editing.is_default}
                onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
              />
              <span className="text-sm">Default realm</span>
            </label>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : editing.id ? "Update Realm" : "Create Realm"}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Realms list ── */}
      {realms.length === 0 && !editing ? (
        <div className="card text-center py-12">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto mb-4 text-txt-tertiary"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20" />
            <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
          </svg>
          <p className="text-txt-secondary text-sm">
            No Kerberos realms configured. Add a realm to enable Kerberos / NLA authentication for
            your connections.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {realms.map((r) => (
            <div key={r.id} className="card !p-0 !overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                    style={{
                      background: "var(--color-accent-dim)",
                      color: "var(--color-accent-light)",
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M2 12h20" />
                      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                    </svg>
                  </div>
                  <div>
                    <span className="font-semibold text-[0.9rem] text-txt-primary">
                      {r.realm.toUpperCase()}
                    </span>
                    {r.is_default && (
                      <span
                        className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{
                          background: "var(--color-accent-dim)",
                          color: "var(--color-accent-light)",
                        }}
                      >
                        Default
                      </span>
                    )}
                    <div className="text-txt-tertiary text-xs mt-0.5">
                      {r.kdc_servers.split(",").filter(Boolean).length} KDC
                      {r.kdc_servers.split(",").filter(Boolean).length !== 1 ? "s" : ""}
                      {" · "}
                      {r.admin_server || "No admin server"}
                      {" · "}Ticket {r.ticket_lifetime} / Renew {r.renew_lifetime}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn !px-2 !py-1 text-xs" onClick={() => openEdit(r)}>
                    Edit
                  </button>
                  <button
                    className="btn !px-2 !py-1 text-xs text-danger"
                    onClick={() => handleDelete(r.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
