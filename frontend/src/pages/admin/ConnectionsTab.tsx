import { useEffect, useState, useRef } from "react";
import Select from "../../components/Select";
import ConfirmModal from "../../components/ConfirmModal";
import {
  Connection,
  ConnectionFolder,
  ConnectionRef,
  HostKeySurveyRow,
  MeResponse,
  createConnection,
  updateConnection,
  deleteConnection,
  surveySshHostKeys,
  approveSshHostKeys,
  getConnectionRefs,
  parseKubeconfig,
} from "../../api";
import {
  RdpSections,
  SshSections,
  VncSections,
  VdiSections,
  WebSections,
  KubernetesSections,
} from "./connectionForm";
import { PROTOCOLS, protocolDescriptor } from "./protocolFields";
import { orderFoldersByHierarchy, indentedFolderLabel } from "../../utils/folderTree";
import ConnectionFoldersView from "./ConnectionFoldersView";
import FleetManager from "./fleet/FleetManager";

interface ConnectionsTabProps {
  user: MeResponse;
  folders: ConnectionFolder[];
  onFoldersChanged: (folders: ConnectionFolder[]) => void;
}

export default function ConnectionsTab({ user, folders, onFoldersChanged }: ConnectionsTabProps) {
  /** Bumped after any change so the table and folder counts reload. */
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((n) => n + 1);
  const [refs, setRefs] = useState<ConnectionRef[]>([]);
  useEffect(() => {
    let cancelled = false;
    getConnectionRefs()
      .then((r) => !cancelled && setRefs(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
  const [formMode, setFormMode] = useState<"closed" | "add" | "edit">("closed");
  const [formId, setFormId] = useState<string | null>(null);
  const [formCore, setFormCore] = useState({
    name: "",
    protocol: "rdp",
    hostname: "",
    port: 3389,
    domain: "",
    description: "",
    folder_id: "",
    watermark: "inherit",
  });
  const [formExtra, setFormExtra] = useState<Record<string, string>>({});
  const connFormRef = useRef<HTMLDivElement>(null);

  // SSH host key survey; `surveyScope` limits the review to selected rows.
  const [survey, setSurvey] = useState<HostKeySurveyRow[] | null>(null);
  const [surveyScope, setSurveyScope] = useState<string[] | null>(null);
  const [surveying, setSurveying] = useState(false);
  const [surveyError, setSurveyError] = useState("");

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    isDangerous?: boolean;
    onConfirm: () => Promise<void> | void;
  } | null>(null);

  async function runHostKeySurvey(scope: string[] | null = surveyScope) {
    setSurveyScope(scope);
    setSurveying(true);
    setSurveyError("");
    try {
      const rows = await surveySshHostKeys();
      setSurvey(scope ? rows.filter((r) => scope.includes(r.id)) : rows);
    } catch (e) {
      setSurveyError(e instanceof Error ? e.message : "Could not read the host keys");
    } finally {
      setSurveying(false);
    }
  }

  /** Store the keys for the given rows, then refresh the list. */
  async function approveRows(rows: HostKeySurveyRow[]) {
    const keys = rows
      .filter((r) => r.public_key)
      .map((r) => ({ id: r.id, public_key: r.public_key as string }));
    if (keys.length === 0) return;
    try {
      await approveSshHostKeys(keys);
      reload();
      await runHostKeySurvey();
    } catch (e) {
      setSurveyError(e instanceof Error ? e.message : "Could not store the host keys");
    }
  }

  /** Review panel for the SSH host key survey. */
  function renderHostKeySurveyPanel() {
    if (!survey) return null;
    const missing = survey.filter((r) => r.status === "missing");
    const differs = survey.filter((r) => r.status === "differs");
    const badge = (status: HostKeySurveyRow["status"]) => {
      const colour = {
        matches: "#22c55e",
        missing: "#f59e0b",
        differs: "#ef4444",
        unreachable: "var(--color-txt-tertiary)",
      }[status];
      return (
        <span
          className="text-[0.6rem] font-bold uppercase tracking-wider"
          style={{ color: colour }}
        >
          {status}
        </span>
      );
    };

    return (
      <div
        className="rounded-xl p-4 mb-4 grid gap-3"
        style={{
          background: "var(--color-surface-secondary)",
          border: "1px solid var(--color-glass-border)",
        }}
      >
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-sm font-bold">SSH host keys</span>
          <div className="flex gap-2">
            {missing.length > 0 && (
              <button
                className="btn-primary text-[0.7rem] px-2 py-1"
                onClick={() => approveRows(missing)}
                title="Store the key for every connection that has none. Check the fingerprints below first."
              >
                Approve {missing.length} new
              </button>
            )}
            <button
              className="btn text-[0.7rem] px-2 py-1"
              onClick={() => {
                setSurvey(null);
                setSurveyScope(null);
              }}
            >
              Close
            </button>
          </div>
        </div>

        {differs.length > 0 && (
          <p className="text-[0.7rem]" style={{ color: "#ef4444" }}>
            {differs.length} host{differs.length === 1 ? "" : "s"} now present a different key from
            the one approved. That is a rebuilt host, or someone standing in front of it. Approve
            only if you know which.
          </p>
        )}
        {surveyError && (
          <p className="text-[0.7rem]" style={{ color: "#ef4444" }}>
            {surveyError}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-[0.7rem]">
            <thead>
              <tr className="text-txt-tertiary uppercase tracking-wider text-[0.6rem]">
                <th className="text-left py-1">Connection</th>
                <th className="text-left py-1">Host</th>
                <th className="text-left py-1">State</th>
                <th className="text-left py-1">Fingerprint</th>
                <th className="text-left py-1"></th>
              </tr>
            </thead>
            <tbody>
              {survey.map((row) => (
                <tr
                  key={row.id}
                  className="border-t"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <td className="py-1 pr-2">{row.name}</td>
                  <td className="py-1 pr-2 text-txt-secondary">
                    {row.hostname}:{row.port}
                  </td>
                  <td className="py-1 pr-2">{badge(row.status)}</td>
                  <td className="py-1 pr-2">
                    <code className="break-all text-txt-secondary">
                      {row.fingerprint ?? row.error ?? "—"}
                    </code>
                    {row.algorithm && <span className="text-txt-tertiary"> ({row.algorithm})</span>}
                  </td>
                  <td className="py-1">
                    {(row.status === "missing" || row.status === "differs") && (
                      <button
                        className="btn text-[0.65rem] px-2 py-0.5"
                        onClick={() => approveRows([row])}
                      >
                        Approve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  function openAdd() {
    setFormMode("add");
    setFormId(null);
    setFormCore({
      name: "",
      protocol: "rdp",
      hostname: "",
      port: 3389,
      domain: "",
      description: "",
      folder_id: "",
      watermark: "inherit",
    });
    setFormExtra({ "server-layout": "en-gb-qwerty", timezone: "Europe/London" });
    setTimeout(
      () => connFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50
    );
  }

  function openEdit(c: Connection) {
    fillForm(c);
    setFormMode("edit");
    setFormId(c.id);
  }

  /** Pre-fill the add form from an existing connection. */
  function openDuplicate(c: Connection) {
    fillForm({ ...c, name: `${c.name} (copy)` });
    setFormMode("add");
    setFormId(null);
  }

  function fillForm(c: Connection) {
    setFormCore({
      name: c.name,
      protocol: c.protocol,
      hostname: c.hostname,
      port: c.port,
      domain: c.domain || "",
      description: c.description || "",
      folder_id: c.folder_id || "",
      watermark: c.watermark || "inherit",
    });
    setFormExtra(c.extra ? { ...c.extra } : {});
    setTimeout(
      () => connFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      50
    );
  }

  function closeForm() {
    setFormMode("closed");
    setFormId(null);
  }

  const ex = (k: string) => formExtra[k] || "";
  const setEx = (k: string, v: string) => setFormExtra({ ...formExtra, [k]: v });

  const PRESERVE_FALSE_KEYS = new Set([
    "enable-sftp",
    "enable-wallpaper",
    "enable-theming",
    "enable-font-smoothing",
    "enable-full-window-drag",
    "enable-desktop-composition",
    "enable-menu-animations",
    "enable-audio",
    "disable-audio",
    "disable-copy",
    "disable-paste",
    "read-only",
    "ignore-cert",
    "disable-gfx",
  ]);

  function cleanExtra(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(formExtra)) {
      if (PRESERVE_FALSE_KEYS.has(k)) {
        out[k] = v === "true" ? "true" : "false";
        continue;
      }
      if (v !== "" && v !== "false") out[k] = v;
    }
    return out;
  }

  async function handleSave() {
    try {
      const payload = {
        ...formCore,
        folder_id: formCore.folder_id || undefined,
        extra: cleanExtra(),
      };
      let c;
      if (formMode === "add") {
        c = await createConnection(payload);
      } else if (formMode === "edit" && formId) {
        c = await updateConnection(formId, payload);
      }
      if (c) {
        setFormExtra(c.extra || {});
      }
      reload();
      closeForm();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save connection");
    }
  }

  const handleDelete = (id: string) => {
    setConfirmModal({
      title: "Delete Connection",
      message: "Are you sure you want to delete this connection? This action cannot be undone.",
      isDangerous: true,
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await deleteConnection(id);
          reload();
          if (id === formId) {
            closeForm();
          }
        } catch (err) {
          alert(err instanceof Error ? err.message : "Failed to delete connection");
        } finally {
          setConfirmModal(null);
        }
      },
    });
  };

  return (
    <div className="grid gap-6">
      {/* Connections */}
      {(user.can_manage_system || user.can_create_connections) && (
        <FleetManager
          user={user}
          folders={folders}
          reloadKey={reloadKey}
          activeFormId={formId}
          hostKeyPanel={renderHostKeySurveyPanel()}
          verifyingHostKeys={surveying}
          onVerifyHostKeys={(ids) => void runHostKeySurvey(ids ?? null)}
          onAdd={openAdd}
          onEdit={openEdit}
          onDuplicate={openDuplicate}
          onDelete={handleDelete}
          requestConfirm={setConfirmModal}
        />
      )}

      {/* Connection Editor Form */}
      {(user.can_manage_system || user.can_create_connections) && formMode !== "closed" && (
        <div className="card" ref={connFormRef}>
          <div className="flex justify-between items-center mb-4">
            <h2 className="!mb-0">{formMode === "add" ? "Add Connection" : "Edit Connection"}</h2>
            <button className="btn text-[0.8rem] px-2 py-1" onClick={closeForm}>
              Cancel
            </button>
          </div>
          <div
            className="mb-4"
            style={{
              display: "grid",
              gridTemplateColumns: (() => {
                const proto = protocolDescriptor(formCore.protocol);
                const cols = [
                  "1fr", // Name
                  "100px", // Protocol
                  proto.showHostname && "1fr",
                  proto.showPort && "80px",
                  proto.showDomain && "1fr",
                ].filter(Boolean) as string[];
                return cols.join(" ");
              })(),
              gap: "0.5rem",
            }}
          >
            <div className="form-group !mb-0">
              <label htmlFor="conn-name">Name</label>
              <input
                id="conn-name"
                value={formCore.name}
                onChange={(e) => setFormCore({ ...formCore, name: e.target.value })}
                placeholder="My Server"
              />
            </div>
            <div className="form-group !mb-0">
              <label htmlFor="conn-protocol">Protocol</label>
              <Select
                id="conn-protocol"
                value={formCore.protocol}
                onChange={(v) => {
                  const next = protocolDescriptor(v);
                  setFormCore({ ...formCore, protocol: v, port: next.defaultPort });
                }}
                options={PROTOCOLS.map((p) => ({ value: p.value, label: p.label }))}
              />
            </div>
            {protocolDescriptor(formCore.protocol).showHostname && (
              <div className="form-group !mb-0">
                <label htmlFor="conn-hostname">Hostname</label>
                <input
                  id="conn-hostname"
                  value={formCore.hostname}
                  onChange={(e) => setFormCore({ ...formCore, hostname: e.target.value })}
                  placeholder="10.0.0.10"
                />
              </div>
            )}
            {protocolDescriptor(formCore.protocol).showPort && (
              <div className="form-group !mb-0">
                <label htmlFor="conn-port">Port</label>
                <input
                  id="conn-port"
                  type="number"
                  value={formCore.port}
                  onChange={(e) =>
                    setFormCore({ ...formCore, port: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
            )}
            {protocolDescriptor(formCore.protocol).showDomain && (
              <div className="form-group !mb-0">
                <label htmlFor="conn-domain">Domain</label>
                <input
                  id="conn-domain"
                  value={formCore.domain}
                  onChange={(e) => setFormCore({ ...formCore, domain: e.target.value })}
                  placeholder="EXAMPLE.COM"
                />
              </div>
            )}
          </div>
          <div
            className="mb-4"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem" }}
          >
            <div className="form-group !mb-0">
              <label htmlFor="conn-description">Description</label>
              <input
                id="conn-description"
                value={formCore.description}
                onChange={(e) => setFormCore({ ...formCore, description: e.target.value })}
                placeholder="Optional description"
              />
            </div>
            <div className="form-group !mb-0">
              <label htmlFor="conn-folder">Folder</label>
              <Select
                id="conn-folder"
                value={formCore.folder_id}
                onChange={(v) => setFormCore({ ...formCore, folder_id: v })}
                placeholder="No folder"
                options={[
                  { value: "", label: "No folder" },
                  ...orderFoldersByHierarchy(folders).map(({ folder: f, depth }) => ({
                    value: f.id,
                    label: indentedFolderLabel(f.name, depth),
                  })),
                ]}
              />
            </div>
            <div className="form-group !mb-0">
              <label htmlFor="conn-watermark">Session Watermark</label>
              <Select
                id="conn-watermark"
                value={formCore.watermark}
                onChange={(v) => setFormCore({ ...formCore, watermark: v })}
                options={[
                  { value: "inherit", label: "Inherit (global setting)" },
                  { value: "on", label: "Always on" },
                  { value: "off", label: "Always off" },
                ]}
              />
            </div>
          </div>

          <div className="mt-6">
            <h4 className="text-sm font-bold uppercase tracking-widest text-txt-tertiary mb-3">
              Protocol Parameters
            </h4>
            {formCore.protocol === "rdp" && (
              <RdpSections
                extra={formExtra}
                setExtra={setFormExtra}
                ex={ex}
                setEx={setEx}
                connectionId={formId}
              />
            )}
            {formCore.protocol === "ssh" && (
              <SshSections ex={ex} setEx={setEx} connectionId={formId} />
            )}
            {formCore.protocol === "vnc" && <VncSections ex={ex} setEx={setEx} />}
            {formCore.protocol === "web" && <WebSections ex={ex} setEx={setEx} />}
            {formCore.protocol === "vdi" && <VdiSections ex={ex} setEx={setEx} />}
            {formCore.protocol === "kubernetes" && (
              <>
                <KubeconfigImporter
                  onParsed={(p) => {
                    if (p.server) {
                      try {
                        const u = new URL(p.server);
                        setFormCore((f) => ({
                          ...f,
                          hostname: u.hostname,
                          port: u.port ? parseInt(u.port, 10) : u.protocol === "http:" ? 80 : 443,
                        }));
                        setEx("use-ssl", u.protocol === "https:" ? "" : "false");
                      } catch {
                        // Not a parseable URL
                      }
                    }
                    if (p.namespace) setEx("namespace", p.namespace);
                    if (p.ca_cert_pem) setEx("ca-cert", p.ca_cert_pem);
                    if (p.client_cert_pem) setEx("client-cert", p.client_cert_pem);
                  }}
                />
                <KubernetesSections ex={ex} setEx={setEx} />
              </>
            )}
          </div>
          <div className="flex gap-2 mt-4">
            <button className="btn-primary" onClick={handleSave}>
              {formMode === "add" ? "Create Connection" : "Save Changes"}
            </button>
            <button className="btn" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Connection Folders */}
      {(user.can_manage_system || user.can_create_connections) && (
        <ConnectionFoldersView
          folders={folders}
          connections={refs}
          onFoldersChanged={onFoldersChanged}
        />
      )}

      {confirmModal && (
        <ConfirmModal
          isOpen={true}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          isDangerous={confirmModal.isDangerous}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
}

// ── Kubeconfig importer (v1.4.0) ───────────────────────────────────
//
// Compact textarea + parse button rendered above the Kubernetes
// protocol sections. The backend extracts cluster server, namespace,
// CA cert and client cert into the form; the client *private key*
// is shown to the operator exactly once with a copy-to-clipboard
// affordance. The operator is expected to immediately paste it into
// a credential profile (Vault-encrypted) — we deliberately never
// auto-create the profile from this endpoint because the credential-
// profile UX has its own auditing and naming requirements that don't
// fit a one-shot import.
function KubeconfigImporter({
  onParsed,
}: {
  onParsed: (p: import("../../api").ParsedKubeconfig) => void;
}) {
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [keyPem, setKeyPem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleParse = async () => {
    setBusy(true);
    setError(null);
    setWarnings([]);
    setKeyPem(null);
    setCopied(false);
    try {
      const parsed = await parseKubeconfig(yaml);
      onParsed(parsed);
      setWarnings(parsed.warnings ?? []);
      setKeyPem(parsed.client_key_pem ?? null);
      // Wipe the YAML once parsed — there's no reason to keep it
      // sitting in DOM state after the fields have been broken out.
      setYaml("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 rounded border border-border-default p-3 bg-bg-secondary">
      <div className="flex items-center justify-between mb-2">
        <h5 className="text-xs font-bold uppercase tracking-widest text-txt-tertiary">
          Import kubeconfig
        </h5>
        <span className="text-[0.7rem] text-txt-tertiary">
          Paste your <code>~/.kube/config</code> to auto-fill cluster fields.
        </span>
      </div>
      <textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        rows={4}
        className="font-mono text-[0.75rem] w-full"
        placeholder="apiVersion: v1&#10;kind: Config&#10;…"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          className="btn-secondary text-sm"
          onClick={handleParse}
          disabled={busy || !yaml.trim()}
        >
          {busy ? "Parsing…" : "Parse and fill form"}
        </button>
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
      {warnings.length > 0 && (
        <ul className="mt-2 text-xs text-amber-500 list-disc pl-4">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {keyPem && (
        <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <div className="flex items-center justify-between mb-1">
            <strong className="text-xs uppercase text-amber-400">
              Client private key — copy now
            </strong>
            <button
              type="button"
              className="btn-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(keyPem);
                  setCopied(true);
                } catch {
                  /* ignore clipboard errors */
                }
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-[0.7rem] text-txt-tertiary mb-1">
            This key is shown <strong>once</strong>. Paste it into the password slot of the
            credential profile you assign to this connection. Strata never persists it on this page.
          </p>
          <textarea value={keyPem} readOnly rows={3} className="font-mono text-[0.75rem] w-full" />
        </div>
      )}
    </div>
  );
}
