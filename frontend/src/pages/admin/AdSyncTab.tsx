import { useCallback, useEffect, useRef, useState } from "react";
import Select from "../../components/Select";
import { useSettings } from "../../contexts/SettingsContext";
import { getTimezones } from "../../utils/time";
import {
  AdSyncConfig,
  AdSyncRun,
  ConnectionFolder,
  createAdSyncConfig,
  deleteAdSyncConfig,
  getAdSyncConfigs,
  getAdSyncRuns,
  testAdSyncConnection,
  testPmTargetFilter,
  testRotation,
  triggerAdSync,
  updateAdSyncConfig,
} from "../../api";
import { RDP_KEYBOARD_LAYOUTS } from "./rdpKeyboardLayouts";

export default function AdSyncTab({
  folders,
  onSave,
}: {
  folders: ConnectionFolder[];
  onSave: () => void;
}) {
  const { formatDateTime } = useSettings();
  const [configs, setConfigs] = useState<AdSyncConfig[]>([]);
  const [editing, setEditing] = useState<Partial<AdSyncConfig> | null>(null);
  const [selectedRuns, setSelectedRuns] = useState<{ configId: string; runs: AdSyncRun[] } | null>(
    null
  );
  const [syncing, setSyncing] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    status: string;
    message: string;
    sample?: string[];
    count?: number;
  } | null>(null);
  const [rotationTesting, setRotationTesting] = useState(false);
  const [rotationResult, setRotationResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [filterTesting, setFilterTesting] = useState(false);
  const [filterResult, setFilterResult] = useState<{
    status: string;
    message: string;
    hint?: string;
    count?: number;
    sample?: { dn: string; name: string; description?: string }[];
  } | null>(null);
  const certFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    getAdSyncConfigs()
      .then(setConfigs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!editing) return;
    try {
      // When 'Use AD source's bind credentials' is selected, pm_bind_user is null/undefined.
      // Send explicit empty strings so the backend clears them in the database.
      const payload = {
        ...editing,
        pm_bind_user: editing.pm_bind_user ?? "",
        pm_bind_password: editing.pm_bind_password ?? "",
      };
      if (editing.id) {
        await updateAdSyncConfig(editing.id, payload);
      } else {
        await createAdSyncConfig(payload);
      }
      setEditing(null);
      load();
      onSave();
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (id: string) => {
    if (
      !confirm(
        "Delete this AD sync source? Imported connections will remain but will no longer sync."
      )
    )
      return;
    await deleteAdSyncConfig(id);
    load();
  };

  const handleClone = (c: AdSyncConfig) => {
    setEditing({
      ...c,
      id: undefined,
      label: `${c.label} (Copy)`,
      clone_from: c.id,
      bind_password: "••••••••",
    });
  };

  const handleSync = async (id: string) => {
    setSyncing(id);
    try {
      await triggerAdSync(id);
      load();
      onSave();
    } finally {
      setSyncing(null);
    }
  };

  const handleViewRuns = async (configId: string) => {
    const runs = await getAdSyncRuns(configId);
    setSelectedRuns({ configId, runs });
  };

  const handleTestConnection = async (config: Partial<AdSyncConfig>) => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAdSyncConnection(config);
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ status: "error", message: e.message || "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleRotationTest = async () => {
    if (!editing?.id) return;
    setRotationTesting(true);
    setRotationResult(null);
    try {
      const res = await testRotation(editing.id);
      setRotationResult(res);
    } catch (e: any) {
      setRotationResult({ success: false, message: e.message || "Rotation test failed" });
    } finally {
      setRotationTesting(false);
    }
  };

  const handleTestFilter = async () => {
    if (!editing) return;
    setFilterTesting(true);
    setFilterResult(null);
    try {
      const res = await testPmTargetFilter(editing);
      setFilterResult(res);
    } catch (e: any) {
      setFilterResult({ status: "error", message: e.message || "Filter test failed" });
    } finally {
      setFilterTesting(false);
    }
  };

  const folderOptions = [
    { value: "", label: "— No folder —" },
    ...folders.map((f) => ({ value: f.id, label: f.name })),
  ];

  const presetFilters = [
    "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
    "(&(objectClass=computer)(operatingSystem=*Server*)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
    "(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
    "(&(objectClass=computer)(operatingSystem=*Server*)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
  ];

  const isPresetFilter = (f: string) => presetFilters.includes(f);

  // ── Edit / Create form ──
  if (editing) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">
          {editing.id ? "Edit AD Source" : "Add AD Source"}
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium">Label</span>
            <input
              className="input mt-1"
              value={editing.label || ""}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              placeholder="Production AD"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">LDAP URL</span>
            <input
              className="input mt-1"
              value={editing.ldap_url || ""}
              onChange={(e) => setEditing({ ...editing, ldap_url: e.target.value })}
              placeholder="ldaps://dc1.contoso.com:636"
            />
          </label>
          <label className="block col-span-2">
            <span className="text-sm font-medium">Authentication Method</span>
            <Select
              value={editing.auth_method || "simple"}
              onChange={(v) => setEditing({ ...editing, auth_method: v })}
              options={[
                { value: "simple", label: "Simple Bind (DN + Password)" },
                { value: "kerberos", label: "Kerberos Keytab" },
              ]}
            />
          </label>
          {(editing.auth_method || "simple") === "simple" ? (
            <>
              <label className="block">
                <span className="text-sm font-medium">Bind DN</span>
                <input
                  className="input mt-1"
                  value={editing.bind_dn || ""}
                  onChange={(e) => setEditing({ ...editing, bind_dn: e.target.value })}
                  placeholder="CN=svc-strata,OU=Service Accounts,DC=contoso,DC=com"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium">Bind Password</span>
                <input
                  type="password"
                  className="input mt-1"
                  value={editing.bind_password || ""}
                  onChange={(e) => setEditing({ ...editing, bind_password: e.target.value })}
                />
              </label>
            </>
          ) : (
            <>
              <label className="block">
                <span className="text-sm font-medium">Keytab Path</span>
                <input
                  className="input mt-1"
                  value={editing.keytab_path || ""}
                  onChange={(e) => setEditing({ ...editing, keytab_path: e.target.value })}
                  placeholder="/etc/krb5/strata.keytab"
                />
                <span className="text-xs opacity-50">
                  Path inside the container — mount via Docker volume
                </span>
              </label>
              <label className="block">
                <span className="text-sm font-medium">Kerberos Principal</span>
                <input
                  className="input mt-1"
                  value={editing.krb5_principal || ""}
                  onChange={(e) => setEditing({ ...editing, krb5_principal: e.target.value })}
                  placeholder="svc-strata@CONTOSO.COM"
                />
              </label>
            </>
          )}
          <div className="block col-span-2">
            <span className="text-sm font-medium">Search Bases (OU scopes)</span>
            {(editing.search_bases || [""]).map((base, i) => (
              <div key={i} className="flex items-center gap-2 mt-1">
                <input
                  className="input flex-1"
                  value={base}
                  onChange={(e) => {
                    const next = [...(editing.search_bases || [""])];
                    next[i] = e.target.value;
                    setEditing({ ...editing, search_bases: next });
                  }}
                  placeholder="OU=Servers,DC=contoso,DC=com"
                />
                {(editing.search_bases || [""]).length > 1 && (
                  <button
                    type="button"
                    className="text-red-400 hover:text-red-300 text-sm px-1"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        search_bases: (editing.search_bases || [""]).filter((_, j) => j !== i),
                      })
                    }
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="text-xs text-blue-400 hover:underline mt-1"
              onClick={() =>
                setEditing({ ...editing, search_bases: [...(editing.search_bases || [""]), ""] })
              }
            >
              + Add Search Base
            </button>
          </div>
          <label className="block">
            <span className="text-sm font-medium">Search Filter</span>
            <Select
              value={
                isPresetFilter(editing.search_filter || "")
                  ? editing.search_filter || "(objectClass=computer)"
                  : "_custom"
              }
              onChange={(v) => {
                if (v === "_custom") {
                  setEditing({ ...editing, search_filter: editing.search_filter || "" });
                } else {
                  setEditing({ ...editing, search_filter: v });
                }
              }}
              options={[
                {
                  value:
                    "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
                  label: "All Computers",
                },
                {
                  value:
                    "(&(objectClass=computer)(operatingSystem=*Server*)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
                  label: "Servers Only",
                },
                {
                  value:
                    "(&(objectClass=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
                  label: "Enabled Computers Only",
                },
                {
                  value:
                    "(&(objectClass=computer)(operatingSystem=*Server*)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
                  label: "Enabled Servers Only",
                },
                { value: "_custom", label: "Custom Filter..." },
              ]}
            />
            {!isPresetFilter(editing.search_filter || "") && (
              <input
                className="input mt-1"
                value={editing.search_filter || ""}
                onChange={(e) => setEditing({ ...editing, search_filter: e.target.value })}
                placeholder="(&(objectClass=computer)(name=SRV*))"
              />
            )}
          </label>
          <label className="block">
            <span className="text-sm font-medium">Search Scope</span>
            <Select
              value={editing.search_scope || "subtree"}
              onChange={(v) => setEditing({ ...editing, search_scope: v })}
              options={[
                { value: "subtree", label: "Subtree" },
                { value: "onelevel", label: "One Level" },
                { value: "base", label: "Base" },
              ]}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Protocol</span>
            <Select
              value={editing.protocol || "rdp"}
              onChange={(v) => setEditing({ ...editing, protocol: v })}
              options={[
                { value: "rdp", label: "RDP" },
                { value: "ssh", label: "SSH" },
                { value: "vnc", label: "VNC" },
              ]}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Default Port</span>
            <input
              type="number"
              className="input mt-1"
              value={editing.default_port ?? 3389}
              onChange={(e) => setEditing({ ...editing, default_port: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Domain Override</span>
            <input
              className="input mt-1"
              value={editing.domain_override || ""}
              onChange={(e) =>
                setEditing({ ...editing, domain_override: e.target.value || undefined })
              }
              placeholder="Optional — force domain on connections"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Connection Folder</span>
            <Select
              value={editing.folder_id || ""}
              onChange={(v) => setEditing({ ...editing, folder_id: v || undefined })}
              options={folderOptions}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Sync Interval (minutes)</span>
            <input
              type="number"
              className="input mt-1"
              min={5}
              value={editing.sync_interval_minutes ?? 60}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  sync_interval_minutes: Math.max(5, Number(e.target.value)),
                })
              }
            />
          </label>
          <label className="flex items-center gap-2 mt-6">
            <input
              type="checkbox"
              className="checkbox"
              checked={editing.tls_skip_verify ?? false}
              onChange={(e) => setEditing({ ...editing, tls_skip_verify: e.target.checked })}
            />
            <span className="text-sm">Skip TLS verification</span>
          </label>
          <label className="flex items-center gap-2 mt-6">
            <input
              type="checkbox"
              className="checkbox"
              checked={editing.enabled ?? true}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            <span className="text-sm">Enabled</span>
          </label>
          {!editing.tls_skip_verify && (
            <div className="block col-span-2">
              <span className="text-sm font-medium">CA Certificate (PEM)</span>
              <div className="flex items-center gap-2 mt-1">
                <input
                  ref={certFileRef}
                  type="file"
                  accept=".pem,.crt,.cer"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onload = () =>
                        setEditing({ ...editing, ca_cert_pem: reader.result as string });
                      reader.readAsText(file);
                    }
                    if (certFileRef.current) certFileRef.current.value = "";
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => certFileRef.current?.click()}
                >
                  {editing.ca_cert_pem ? "↻ Replace Certificate" : "Upload Certificate"}
                </button>
                {editing.ca_cert_pem && (
                  <>
                    <span className="text-sm text-green-400">✓ Certificate loaded</span>
                    <button
                      type="button"
                      className="text-sm text-red-400 hover:underline"
                      onClick={() => setEditing({ ...editing, ca_cert_pem: "" })}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              <span className="text-xs opacity-50">
                Optional — upload your internal CA certificate for LDAPS with self-signed
                certificates
              </span>
            </div>
          )}
        </div>

        {/* ── Connection Defaults ── */}
        <div className="mt-6 border-t border-border/20 pt-4">
          <h4 className="text-sm font-semibold uppercase tracking-wider mb-3">
            Connection Defaults
          </h4>
          <p className="text-xs opacity-50 mb-4">
            These settings are applied to every connection created or updated by this sync source.
          </p>

          {(editing.protocol || "rdp") === "rdp" && (
            <>
              <div className="text-xs font-semibold uppercase tracking-wider opacity-60 mb-2">
                RDP Basic Settings
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-4">
                <div className="form-group !mb-0">
                  <label title="The server-side keyboard layout. This is the layout of the RDP server and determines how keystrokes are interpreted.">
                    Keyboard Layout
                  </label>
                  <Select
                    value={(editing.connection_defaults ?? {})["server-layout"] || ""}
                    onChange={(v) => {
                      const cd = { ...(editing.connection_defaults ?? {}) };
                      if (v) cd["server-layout"] = v;
                      else delete cd["server-layout"];
                      setEditing({ ...editing, connection_defaults: cd });
                    }}
                    placeholder="Default (US English)"
                    options={RDP_KEYBOARD_LAYOUTS}
                  />
                </div>
                <div className="form-group !mb-0">
                  <label title="The timezone that the client should send to the server for configuring the local time display, in IANA format (e.g. America/New_York).">
                    Timezone
                  </label>
                  <Select
                    value={(editing.connection_defaults ?? {})["timezone"] || ""}
                    onChange={(v) => {
                      const cd = { ...(editing.connection_defaults ?? {}) };
                      if (v) cd["timezone"] = v;
                      else delete cd["timezone"];
                      setEditing({ ...editing, connection_defaults: cd });
                    }}
                    placeholder="System default"
                    options={[
                      { value: "", label: "System default" },
                      ...getTimezones().map((tz) => ({ value: tz, label: tz })),
                    ]}
                  />
                </div>
              </div>

              <div className="text-xs font-semibold uppercase tracking-wider opacity-60 mb-2">
                RDP Display &amp; Performance
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-4">
                {(
                  [
                    [
                      "ignore-cert",
                      "Ignore server certificate",
                      "Ignore the certificate returned by the server, even if it cannot be validated. Useful when connecting to servers with self-signed certificates.",
                    ],
                    [
                      "enable-wallpaper",
                      "Enable wallpaper",
                      "Enables rendering of the desktop wallpaper. By default wallpaper is disabled to reduce bandwidth usage.",
                    ],
                    [
                      "enable-font-smoothing",
                      "Enable font smoothing",
                      "Renders text with smooth edges (ClearType). By default text is rendered with rough edges to reduce bandwidth.",
                    ],
                    [
                      "enable-desktop-composition",
                      "Enable desktop composition",
                      "Allows graphical effects such as transparent windows and shadows (Aero). Disabled by default.",
                    ],
                    [
                      "enable-theming",
                      "Enable theming",
                      "Enables use of theming of windows and controls. By default theming within RDP sessions is disabled.",
                    ],
                    [
                      "enable-full-window-drag",
                      "Enable full-window drag",
                      "Displays window contents as windows are moved. By default only the window border is drawn while dragging.",
                    ],
                    [
                      "enable-menu-animations",
                      "Enable menu animations",
                      "Allows menu open and close animations. Disabled by default.",
                    ],
                    [
                      "disable-bitmap-caching",
                      "Disable bitmap caching",
                      "Disables RDP's built-in bitmap caching. Usually only needed to work around bugs in specific RDP server implementations.",
                    ],
                    [
                      "disable-glyph-caching",
                      "Disable glyph caching",
                      "Disables caching of frequently used symbols and fonts (glyphs). Usually only needed to work around bugs in specific RDP implementations.",
                    ],
                    [
                      "disable-offscreen-caching",
                      "Disable offscreen caching",
                      "Disables caching of off-screen regions. RDP normally caches regions not currently visible to accelerate retrieval when they come into view.",
                    ],
                    [
                      "disable-gfx",
                      "Enable graphics pipeline (GFX)",
                      "Enables the Graphics Pipeline Extension (RDPGFX) \u2014 the modern surface-based rendering path used for the RemoteFX progressive codec and H.264 passthrough. Off by default; the legacy bitmap pipeline is used instead, which is the safest choice for hosts without GPU/AVC444 support. Tick to force GFX on for AD-synced connections.",
                    ],
                    [
                      "enable-h264",
                      "Enable H.264 codec",
                      "Enables H.264 passthrough to the browser's WebCodecs decoder. Requires the host to support H.264 \u2014 either a GPU is present, or AVC444 has been enabled in the registry (run docs/Configure-RdpAvc444.ps1 on the host). Ticking this also forces GFX on.",
                    ],
                  ] as [string, string, string][]
                ).map(([param, label, tooltip]) => {
                  const cdMap = editing.connection_defaults ?? {};
                  // disable-gfx uses inverted semantics: positive label ("Enable GFX"),
                  // checked === "false" means GFX explicitly enabled, "true" means disabled.
                  const isGfx = param === "disable-gfx";
                  const isH264 = param === "enable-h264";
                  const gfxEnabled = cdMap["disable-gfx"] === "false";
                  const checked = isGfx ? gfxEnabled : cdMap[param] === "true";
                  const disabled = isH264 && !gfxEnabled;
                  return (
                    <label
                      key={param}
                      className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`}
                      title={tooltip}
                    >
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={(e) => {
                          const cd = { ...(editing.connection_defaults ?? {}) };
                          if (isGfx) {
                            if (e.target.checked) {
                              cd["disable-gfx"] = "false";
                            } else {
                              cd["disable-gfx"] = "true";
                              // H.264 lives inside GFX — turn it off too.
                              delete cd["enable-h264"];
                            }
                          } else if (isH264) {
                            if (e.target.checked) {
                              cd["enable-h264"] = "true";
                              // H.264 requires GFX — force it on.
                              cd["disable-gfx"] = "false";
                            } else {
                              delete cd["enable-h264"];
                            }
                          } else if (e.target.checked) {
                            cd[param] = "true";
                          } else {
                            delete cd[param];
                          }
                          setEditing({ ...editing, connection_defaults: cd });
                        }}
                      />
                      <span className="text-sm">{label}</span>
                      <svg
                        className="w-3.5 h-3.5 opacity-40 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <circle cx="12" cy="12" r="10" strokeWidth="2" />
                        <path strokeLinecap="round" strokeWidth="2" d="M12 16v-4m0-4h.01" />
                      </svg>
                    </label>
                  );
                })}
              </div>

              <div className="text-xs font-semibold uppercase tracking-wider opacity-60 mb-2 mt-4">
                Session Recording
              </div>
              <p className="text-xs opacity-50 mb-2">
                Recording path and filename are managed automatically by the system.
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                {(
                  [
                    [
                      "recording-include-keys",
                      "Include key events",
                      "Include user key events in the recording. Can be interpreted with the guaclog utility to produce a human-readable log of keys pressed.",
                    ],
                    [
                      "recording-exclude-mouse",
                      "Exclude mouse events",
                      "Exclude user mouse events from the recording, producing a recording without a visible mouse cursor.",
                    ],
                    [
                      "recording-exclude-touch",
                      "Exclude touch events",
                      "Exclude user touch events from the recording.",
                    ],
                    [
                      "recording-exclude-output",
                      "Exclude graphical output",
                      "Exclude graphical output from the recording, producing a recording that contains only user input events.",
                    ],
                  ] as [string, string, string][]
                ).map(([param, label, tooltip]) => (
                  <label key={param} className="flex items-center gap-2" title={tooltip}>
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={(editing.connection_defaults ?? {})[param] === "true"}
                      onChange={(e) => {
                        const cd = { ...(editing.connection_defaults ?? {}) };
                        if (e.target.checked) {
                          cd[param] = "true";
                        } else {
                          delete cd[param];
                        }
                        setEditing({ ...editing, connection_defaults: cd });
                      }}
                    />
                    <span className="text-sm">{label}</span>
                    <svg
                      className="w-3.5 h-3.5 opacity-40 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="12" cy="12" r="10" strokeWidth="2" />
                      <path strokeLinecap="round" strokeWidth="2" d="M12 16v-4m0-4h.01" />
                    </svg>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Password Management ── */}
        <div className="mt-6 border-t border-border/20 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold uppercase tracking-wider">Password Management</h4>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="checkbox"
                checked={editing.pm_enabled ?? false}
                onChange={(e) => setEditing({ ...editing, pm_enabled: e.target.checked })}
              />
              Enable
            </label>
          </div>

          {editing.pm_enabled && (
            <div className="space-y-4">
              {/* Credential source */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Service Account Credentials
                </span>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      className="radio"
                      name="pm_cred_source"
                      checked={!editing.pm_bind_user}
                      onChange={() =>
                        setEditing({
                          ...editing,
                          pm_bind_user: undefined,
                          pm_bind_password: undefined,
                        })
                      }
                    />
                    Use this AD source&apos;s bind credentials
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      className="radio"
                      name="pm_cred_source"
                      checked={editing.pm_bind_user !== null && editing.pm_bind_user !== undefined}
                      onChange={() =>
                        setEditing({
                          ...editing,
                          pm_bind_user: editing.pm_bind_user || "",
                          pm_bind_password: editing.pm_bind_password || "",
                        })
                      }
                    />
                    Use separate credentials for password management
                  </label>
                </div>
                {editing.pm_bind_user !== null && editing.pm_bind_user !== undefined && (
                  <div className="grid grid-cols-2 gap-4 mt-2 ml-6">
                    <label className="block">
                      <span className="text-xs font-medium">PM Bind DN</span>
                      <input
                        className="input mt-1"
                        value={editing.pm_bind_user || ""}
                        onChange={(e) => setEditing({ ...editing, pm_bind_user: e.target.value })}
                        placeholder="CN=PMServiceAcct,OU=Service Accounts,DC=contoso,DC=com"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium">PM Bind Password</span>
                      <input
                        className="input mt-1"
                        type="password"
                        value={editing.pm_bind_password || ""}
                        onChange={(e) =>
                          setEditing({ ...editing, pm_bind_password: e.target.value })
                        }
                        placeholder="••••••••"
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* PM Search Bases */}
              <div className="block">
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Search Base OUs (Optional)
                </span>
                <p className="text-xs opacity-50 mb-2">
                  If specified, user discovery for password management will be restricted to these
                  OUs. Otherwise, the main AD sync search bases are used.
                </p>
                {(editing.pm_search_bases || [""]).map((base: string, i: number) => (
                  <div key={i} className="flex items-center gap-2 mt-1">
                    <input
                      className="input flex-1"
                      value={base}
                      onChange={(e) => {
                        const next = [...(editing.pm_search_bases || [""])];
                        next[i] = e.target.value;
                        setEditing({ ...editing, pm_search_bases: next });
                      }}
                      placeholder="OU=Managed Users,DC=example,DC=local"
                    />
                    {(editing.pm_search_bases || [""]).length > 1 && (
                      <button
                        type="button"
                        className="text-red-400 hover:text-red-300 text-sm px-1 font-bold"
                        onClick={() =>
                          setEditing({
                            ...editing,
                            pm_search_bases: (editing.pm_search_bases || [""]).filter(
                              (_: string, j: number) => j !== i
                            ),
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="text-xs text-blue-400 hover:underline mt-1"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      pm_search_bases: [...(editing.pm_search_bases || [""]), ""],
                    })
                  }
                >
                  + Add PM Search Base
                </button>
              </div>

              {/* Target filter */}
              <div>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider opacity-60">
                    Target Account Filter
                  </span>
                  <div className="flex gap-2 mt-1">
                    <input
                      className="input flex-1"
                      value={
                        editing.pm_target_filter || "(&(objectCategory=person)(objectClass=user))"
                      }
                      onChange={(e) => setEditing({ ...editing, pm_target_filter: e.target.value })}
                      placeholder="(&(objectCategory=person)(objectClass=user))"
                    />
                    <button
                      className="btn btn-sm btn-secondary whitespace-nowrap"
                      disabled={filterTesting}
                      onClick={(e) => {
                        e.preventDefault();
                        handleTestFilter();
                      }}
                    >
                      {filterTesting ? "Searching..." : "🔍 Preview"}
                    </button>
                  </div>
                  <span className="text-xs opacity-50">
                    LDAP filter to discover managed accounts for password checkout
                  </span>
                </label>
                {filterResult && (
                  <div
                    className={`mt-2 p-3 rounded-lg border text-sm ${filterResult.status === "success" ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span>{filterResult.status === "success" ? "✅" : "❌"}</span>
                      <span className="font-medium">{filterResult.message}</span>
                    </div>
                    {filterResult.hint && (
                      <div className="mt-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/20 text-yellow-200/90 text-xs leading-relaxed">
                        <span className="font-semibold">💡 </span>
                        {filterResult.hint}
                      </div>
                    )}
                    {filterResult.sample && filterResult.sample.length > 0 && (
                      <div className="mt-2 max-h-48 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left opacity-60">
                              <th className="pb-1 pr-4">Account Name</th>
                              <th className="pb-1 pr-4">Distinguished Name</th>
                              <th className="pb-1">Description</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filterResult.sample.map((u, i) => (
                              <tr key={i} className="border-t border-border/10">
                                <td className="py-1 pr-4 font-medium">{u.name}</td>
                                <td className="py-1 pr-4 opacity-70 break-all">{u.dn}</td>
                                <td className="py-1 opacity-50">{u.description || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {(filterResult.count ?? 0) > 25 && (
                          <p className="mt-1 text-xs opacity-50">
                            Showing first 25 of {filterResult.count} accounts
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Password policy */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Password Generation Policy
                </span>
                <p className="text-xs opacity-50 mb-2">
                  Generated passwords will comply with these rules so they are accepted by Active
                  Directory.
                </p>
                <div className="flex items-center gap-4 mb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <span className="text-xs font-medium">Minimum Length</span>
                    <input
                      type="number"
                      className="input w-20"
                      min={8}
                      max={128}
                      value={editing.pm_pwd_min_length ?? 16}
                      onChange={(e) =>
                        setEditing({ ...editing, pm_pwd_min_length: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  {(
                    [
                      ["pm_pwd_require_uppercase", "Require uppercase (A-Z)"],
                      ["pm_pwd_require_lowercase", "Require lowercase (a-z)"],
                      ["pm_pwd_require_numbers", "Require numbers (0-9)"],
                      ["pm_pwd_require_symbols", "Require special characters (!@#$...)"],
                    ] as [keyof AdSyncConfig, string][]
                  ).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={(editing[key] as boolean) ?? true}
                        onChange={(e) => setEditing({ ...editing, [key]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Auto-rotation */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Service Account Auto-Rotation (Zero-Knowledge)
                </span>
                <p className="text-xs opacity-50 mb-2">
                  When enabled, the service account will automatically rotate its own password on a
                  schedule. The new password is sealed in Vault — no human ever sees it.
                </p>
                <label className="flex items-center gap-2 text-sm mb-2">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={editing.pm_auto_rotate_enabled ?? false}
                    onChange={(e) =>
                      setEditing({ ...editing, pm_auto_rotate_enabled: e.target.checked })
                    }
                  />
                  Enable automatic rotation
                </label>
                {editing.pm_auto_rotate_enabled && (
                  <div className="flex items-center gap-4 ml-6 mb-2">
                    <label className="flex items-center gap-2 text-sm">
                      <span className="text-xs font-medium">Rotation interval (days)</span>
                      <input
                        type="number"
                        className="input w-20"
                        min={1}
                        max={365}
                        value={editing.pm_auto_rotate_interval_days ?? 30}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            pm_auto_rotate_interval_days: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                {editing.id && (
                  <div className="flex items-center gap-3 mt-3">
                    <button
                      className="btn btn-sm btn-secondary"
                      disabled={rotationTesting}
                      onClick={handleRotationTest}
                    >
                      {rotationTesting ? "Testing..." : "🔄 Test Rotation & Capabilities"}
                    </button>
                    {editing.pm_last_rotated_at && (
                      <span className="text-xs text-txt-secondary">
                        Last rotated: {formatDateTime(editing.pm_last_rotated_at)}
                      </span>
                    )}
                  </div>
                )}
                {rotationResult && (
                  <div
                    className={`mt-2 p-3 rounded text-sm ${rotationResult.success ? "bg-green-500/10 text-green-400 border border-green-500/30" : "bg-red-500/10 text-red-400 border border-red-500/30"}`}
                  >
                    {rotationResult.message}
                  </div>
                )}
              </div>

              {/* Emergency Approval Bypass */}
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider opacity-60 block mb-2">
                  Emergency Approval Bypass (Break-Glass)
                </span>
                <p className="text-xs opacity-50 mb-2">
                  When enabled, users who normally require approval may flag a checkout request as
                  an emergency to receive the password immediately without waiting for an approver.
                  Every use is recorded in the audit log and requires a justification.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={editing.pm_allow_emergency_bypass ?? false}
                    onChange={(e) =>
                      setEditing({ ...editing, pm_allow_emergency_bypass: e.target.checked })
                    }
                  />
                  Allow emergency bypass on password checkout requests
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-6">
          <button className="btn btn-primary" onClick={handleSave}>
            Save
          </button>
          <button
            className="btn btn-secondary"
            disabled={testing}
            onClick={() => handleTestConnection(editing)}
          >
            {testing ? "Testing..." : "⚡ Test Connection"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setEditing(null);
              setTestResult(null);
            }}
          >
            Cancel
          </button>
        </div>
        {testResult && (
          <div
            className={`mt-3 p-3 rounded text-sm ${testResult.status === "success" ? "bg-green-500/10 text-green-400 border border-green-500/30" : "bg-red-500/10 text-red-400 border border-red-500/30"}`}
          >
            <div>{testResult.message}</div>
            {testResult.sample && testResult.sample.length > 0 && (
              <div className="mt-2 text-xs opacity-80">
                <div className="font-medium mb-1">
                  Preview (first {testResult.sample.length}
                  {testResult.count && testResult.count > testResult.sample.length
                    ? ` of ${testResult.count}`
                    : ""}
                  ):
                </div>
                <ul className="list-disc list-inside space-y-0.5">
                  {testResult.sample.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Sync history overlay ──
  if (selectedRuns) {
    const cfg = configs.find((c) => c.id === selectedRuns.configId);
    return (
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Sync History — {cfg?.label}</h3>
          <button className="btn btn-secondary btn-sm" onClick={() => setSelectedRuns(null)}>
            ← Back
          </button>
        </div>
        {selectedRuns.runs.length === 0 ? (
          <p className="text-sm opacity-60">No sync runs yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Updated</th>
                  <th>Soft-Deleted</th>
                  <th>Hard-Deleted</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {selectedRuns.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateTime(r.started_at)}</td>
                    <td>
                      <span
                        className={`badge ${r.status === "success" ? "badge-success" : r.status === "error" ? "badge-error" : "badge-warning"}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td>{r.created}</td>
                    <td>{r.updated}</td>
                    <td>{r.soft_deleted}</td>
                    <td>{r.hard_deleted}</td>
                    <td className="max-w-xs truncate">{r.error_message || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ── Config list ──
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between p-4 bg-surface-secondary/30 border border-border/50 rounded-lg">
        <div>
          <h3 className="text-base font-semibold text-txt-primary">AD Sync Sources</h3>
          <p className="text-sm text-txt-secondary mt-1 max-w-2xl">
            Import connections from Active Directory via LDAP. Objects that disappear are
            soft-deleted for 7 days.
          </p>
        </div>
        <button
          className="btn-sm-primary"
          onClick={() =>
            setEditing({
              search_bases: [""],
              search_filter:
                "(&(objectClass=computer)(!(objectClass=msDS-GroupManagedServiceAccount))(!(objectClass=msDS-ManagedServiceAccount)))",
              search_scope: "subtree",
              protocol: "rdp",
              default_port: 3389,
              sync_interval_minutes: 60,
              enabled: true,
              auth_method: "simple",
            })
          }
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Source
        </button>
      </div>

      {configs.length === 0 ? (
        <div className="card text-center py-12 opacity-60">
          <p className="text-lg mb-2">No AD sync sources configured</p>
          <p className="text-sm">
            Add an Active Directory source to start importing connections automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((c) => (
            <div key={c.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold">{c.label}</h4>
                    <span
                      className={`badge text-xs ${c.enabled ? "badge-success" : "badge-error"}`}
                    >
                      {c.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <p className="text-sm opacity-70 mt-1">{c.ldap_url}</p>
                  <p className="text-xs opacity-50 mt-1">
                    Auth: {c.auth_method === "kerberos" ? "Kerberos Keytab" : "Simple Bind"}
                    {c.ca_cert_pem
                      ? " · CA Cert ✓"
                      : c.tls_skip_verify
                        ? " · TLS Skip Verify"
                        : ""}{" "}
                    · Base: <code>{(c.search_bases || []).join(", ") || "—"}</code> · Filter:{" "}
                    <code>{c.search_filter}</code> · Protocol: {c.protocol.toUpperCase()} · Every{" "}
                    {c.sync_interval_minutes}m
                  </p>
                </div>
                <div className="flex gap-2 shrink-0 ml-4">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={syncing === c.id}
                    onClick={() => handleSync(c.id)}
                  >
                    {syncing === c.id ? "Syncing..." : "⟳ Sync Now"}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleViewRuns(c.id)}>
                    History
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleClone(c)}>
                    Clone
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(c)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-secondary btn-sm text-red-500"
                    onClick={() => handleDelete(c.id)}
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
