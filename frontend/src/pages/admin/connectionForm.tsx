import { useState, useEffect } from "react";
import Select from "../../components/Select";
import { Field } from "../../components/Field";
import { getTimezones } from "../../utils/time";
import {
  getVdiImages,
  getTrustedCasForPicker,
  TrustedCaPickerEntry,
  discoverHostKey,
  DiscoveredHostKey,
  discoverCertificate,
  DiscoveredCertificate,
} from "../../api";
import { RDP_KEYBOARD_LAYOUTS } from "./rdpKeyboardLayouts";

// ── Helper: Collapsible Section ─────────────────────────────────────

export function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border rounded-md mb-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full text-left px-3 py-2 bg-surface-secondary border-0 cursor-pointer font-semibold text-sm text-txt-primary ${open ? "rounded-t-md" : "rounded-md"}`}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && <div className="p-3">{children}</div>}
    </div>
  );
}

// ── Helper: 2-column grid of form fields ────────────────────────────

export function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-4 gap-y-2">{children}</div>;
}

// ── Helper: stored CA bundles for the trust pickers ─────────────────

/**
 * Populated lazily so the widget shows up even if the user lacks Manage
 * System — the slim picker route is open to any authenticated user.
 * Failures are silenced because an empty list simply hides the dropdown.
 */
function useTrustedCas(): TrustedCaPickerEntry[] {
  const [trustedCas, setTrustedCas] = useState<TrustedCaPickerEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    getTrustedCasForPicker()
      .then((rows) => {
        if (!cancelled) setTrustedCas(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return trustedCas;
}

// ── RDP Parameter Sections ──────────────────────────────────────────

export function RdpSections({
  extra: _extra,
  setExtra: _setExtra,
  ex,
  setEx,
  connectionId,
}: {
  extra: Record<string, string>;
  setExtra: (v: Record<string, string>) => void;
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
  /** Null while adding: there is no saved host to read a certificate from yet. */
  connectionId?: string | null;
}) {
  const trustedCas = useTrustedCas();
  const [certProbe, setCertProbe] = useState<DiscoveredCertificate | null>(null);
  const [certProbing, setCertProbing] = useState(false);
  const [certProbeError, setCertProbeError] = useState("");

  async function fetchCertificate() {
    if (!connectionId) return;
    setCertProbing(true);
    setCertProbeError("");
    setCertProbe(null);
    try {
      setCertProbe(await discoverCertificate(connectionId));
    } catch (e) {
      setCertProbeError(e instanceof Error ? e.message : "Could not read the certificate");
    } finally {
      setCertProbing(false);
    }
  }

  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <Field
            label="Security Mode"
            title="The security mode to use for the RDP connection. 'Any' allows the server to choose. 'NLA' uses Network Level Authentication. 'TLS' uses TLS encryption. 'RDP' uses standard RDP encryption. 'VMConnect' uses Hyper-V's enhanced session mode."
          >
            <Select
              value={ex("security") || "any"}
              onChange={(v) => setEx("security", v)}
              options={[
                { value: "any", label: "Any" },
                { value: "nla", label: "NLA" },
                { value: "nla-ext", label: "NLA + Extended" },
                { value: "tls", label: "TLS" },
                { value: "rdp", label: "RDP Encryption" },
                { value: "vmconnect", label: "Hyper-V / VMConnect" },
              ]}
            />
          </Field>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2 mt-1"
              title="Ignore the certificate returned by the server, even if it cannot be validated. Useful when connecting to servers with self-signed certificates."
            >
              <input
                type="checkbox"
                checked={ex("ignore-cert") === "true"}
                onChange={(e) => setEx("ignore-cert", e.target.checked ? "true" : "false")}
                className="checkbox"
              />
              Ignore server certificate
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Certificate Trust">
        <p className="text-xs opacity-60 mb-2">
          Most RDP hosts present a self-signed certificate that the public trust store cannot
          validate. Rather than ignoring it, identify the host by attaching the CA that issued its
          certificate, or by pinning the certificate itself. Either takes precedence over{" "}
          <strong>Ignore server certificate</strong> above.
        </p>
        <FieldGrid>
          <Field
            className="form-group !mb-0 col-span-2"
            label="Trusted CA"
            title="A stored CA bundle to trust in addition to the system store, for hosts whose certificate chains to a private root. Manage entries under Admin → Trusted CAs."
          >
            <Select
              value={ex("trusted_ca_id")}
              onChange={(v) => setEx("trusted_ca_id", v)}
              options={[
                { value: "", label: "— Use system default trust store —" },
                ...trustedCas.map((c) => ({
                  value: c.id,
                  label: c.subject ? `${c.name} (${c.subject})` : c.name,
                })),
              ]}
            />
          </Field>
          <Field
            className="form-group !mb-0 col-span-2"
            label="Pinned certificate fingerprints (one per line)"
            title="SHA-256 fingerprints of the exact certificates this connection will accept. When set, the certificate chain is not consulted — this is how a self-signed host is identified, and it is the same trust model as the SSH host keys pinned on SSH connections."
          >
            <textarea
              value={ex("cert-fingerprints")}
              onChange={(e) => setEx("cert-fingerprints", e.target.value)}
              rows={3}
              placeholder={"AA:BB:CC:…  (openssl x509 -fingerprint -sha256)"}
              className="font-mono text-xs"
            />
          </Field>
        </FieldGrid>
        <p className="text-xs opacity-60 mt-2">
          Hex or <code>SHA256:</code> base64 are both accepted. A value that is not a whole SHA-256
          digest is rejected when the session starts, rather than silently pinning nothing.
        </p>
        <div className="mt-3">
          <button
            type="button"
            className="btn-secondary"
            disabled={!connectionId || certProbing}
            onClick={fetchCertificate}
            title={
              connectionId
                ? "Connect to the target and read the certificate it presents."
                : "Save the connection first — there is no host to read a certificate from yet."
            }
          >
            {certProbing ? "Reading…" : "Read certificate from target"}
          </button>
          {certProbeError && <div className="text-xs text-danger mt-2">{certProbeError}</div>}
          {certProbe && (
            <div className="mt-2 text-xs space-y-1">
              <div>
                <span className="opacity-60">Subject </span>
                <span className="font-mono break-all">{certProbe.subject}</span>
              </div>
              <div>
                <span className="opacity-60">Issuer </span>
                <span className="font-mono break-all">{certProbe.issuer}</span>
                {certProbe.self_signed && <span className="opacity-60"> (self-signed)</span>}
              </div>
              <div>
                <span className="opacity-60">Expires </span>
                <span className="font-mono">{certProbe.not_after}</span>
              </div>
              <div>
                <span className="opacity-60">SHA-256 </span>
                <span className="font-mono break-all">{certProbe.fingerprint}</span>
              </div>
              <p className="opacity-60">
                Read over the same unverified connection it would protect, so check it against the
                host before pinning it.
              </p>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  const existing = ex("cert-fingerprints").trim();
                  setEx(
                    "cert-fingerprints",
                    existing ? `${existing}\n${certProbe.fingerprint}` : certProbe.fingerprint
                  );
                }}
              >
                Pin this fingerprint
              </button>
            </div>
          )}
        </div>
      </Section>

      <Section title="Basic Settings">
        <FieldGrid>
          <Field
            label="Keyboard Layout"
            title="The server-side keyboard layout. This is the layout of the RDP server and determines how keystrokes are interpreted."
          >
            <Select
              value={ex("server-layout")}
              onChange={(v) => setEx("server-layout", v)}
              placeholder="Default (US English)"
              options={RDP_KEYBOARD_LAYOUTS}
            />
          </Field>
          <Field
            label="Client Name"
            title="The name of the client to present to the RDP server. Typically not required."
          >
            <input
              value={ex("client-name")}
              onChange={(e) => setEx("client-name", e.target.value)}
              placeholder="Strata"
              title="The name of the client to present to the RDP server. Typically not required."
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <Field
            label="Color Depth"
            title="The color depth to request from the RDP server, in bits per pixel. The default of 32-bit is REQUIRED for H.264 GFX negotiation; lower values silently disable AVC444 and force the RemoteFX codec."
          >
            <Select
              value={ex("color-depth")}
              onChange={(v) => setEx("color-depth", v)}
              placeholder="Default (32-bit, required for H.264)"
              options={[
                { value: "", label: "Default (32-bit, required for H.264)" },
                { value: "8", label: "8-bit (256 colors) — disables H.264" },
                { value: "16", label: "16-bit (High color) — disables H.264" },
                { value: "24", label: "24-bit (True color) — disables H.264" },
                { value: "32", label: "32-bit (True color + H.264)" },
              ]}
            />
          </Field>
          <Field
            label="Resize Method"
            title="The method to use to update the RDP session when the browser window is resized. 'Display Update' sends a display update command. 'Reconnect' disconnects and reconnects with the new resolution."
          >
            <Select
              value={ex("resize-method") || "display-update"}
              onChange={(v) => setEx("resize-method", v)}
              options={[
                { value: "display-update", label: "Display Update" },
                { value: "reconnect", label: "Reconnect" },
              ]}
            />
          </Field>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Forces lossless image compression for all graphical updates. Increases quality but uses more bandwidth."
            >
              <input
                type="checkbox"
                checked={ex("force-lossless") === "true"}
                onChange={(e) => setEx("force-lossless", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Force lossless compression
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Prevents any user input from being sent to the remote desktop. The session is view-only."
            >
              <input
                type="checkbox"
                checked={ex("read-only") === "true"}
                onChange={(e) => setEx("read-only", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Read-only (view only)
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Clipboard">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Prevents text from being copied from the remote desktop to the local clipboard."
            >
              <input
                type="checkbox"
                checked={ex("disable-copy") === "true"}
                onChange={(e) => setEx("disable-copy", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable copy from remote
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Prevents text from being pasted from the local clipboard to the remote desktop."
            >
              <input
                type="checkbox"
                checked={ex("disable-paste") === "true"}
                onChange={(e) => setEx("disable-paste", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable paste to remote
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Device Redirection">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Disables audio playback from the remote desktop. Audio is enabled by default."
            >
              <input
                type="checkbox"
                checked={ex("disable-audio") === "true"}
                onChange={(e) => setEx("disable-audio", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable audio playback
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Performance">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Enables rendering of the desktop wallpaper. By default wallpaper is disabled to reduce bandwidth usage."
            >
              <input
                type="checkbox"
                checked={ex("enable-wallpaper") === "true"}
                onChange={(e) => setEx("enable-wallpaper", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable wallpaper
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Enables use of theming of windows and controls. By default theming within RDP sessions is disabled."
            >
              <input
                type="checkbox"
                checked={ex("enable-theming") === "true"}
                onChange={(e) => setEx("enable-theming", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable theming
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Renders text with smooth edges (ClearType). By default text is rendered with rough edges to reduce bandwidth."
            >
              <input
                type="checkbox"
                checked={ex("enable-font-smoothing") === "true"}
                onChange={(e) => setEx("enable-font-smoothing", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable font smoothing (ClearType)
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Displays window contents as windows are moved. By default only the window border is drawn while dragging."
            >
              <input
                type="checkbox"
                checked={ex("enable-full-window-drag") === "true"}
                onChange={(e) => setEx("enable-full-window-drag", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable full-window drag
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Allows graphical effects such as transparent windows and shadows (Aero). Disabled by default."
            >
              <input
                type="checkbox"
                checked={ex("enable-desktop-composition") === "true"}
                onChange={(e) =>
                  setEx("enable-desktop-composition", e.target.checked ? "true" : "")
                }
                className="checkbox"
              />
              Enable desktop composition (Aero)
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Allows menu open and close animations. Disabled by default."
            >
              <input
                type="checkbox"
                checked={ex("enable-menu-animations") === "true"}
                onChange={(e) => setEx("enable-menu-animations", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable menu animations
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Disables RDP's built-in bitmap caching. Usually only needed to work around bugs in specific RDP server implementations."
            >
              <input
                type="checkbox"
                checked={ex("disable-bitmap-caching") === "true"}
                onChange={(e) => setEx("disable-bitmap-caching", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable bitmap caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Disables caching of off-screen regions. RDP normally caches regions not currently visible to accelerate retrieval when they come into view."
            >
              <input
                type="checkbox"
                checked={ex("disable-offscreen-caching") === "true"}
                onChange={(e) => setEx("disable-offscreen-caching", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable offscreen caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Disables caching of frequently used symbols and fonts (glyphs). Usually only needed to work around bugs in specific RDP implementations."
            >
              <input
                type="checkbox"
                checked={ex("disable-glyph-caching") === "true"}
                onChange={(e) => setEx("disable-glyph-caching", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable glyph caching
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Enables the Graphics Pipeline Extension (RDPGFX) — the modern surface-based rendering path used for RemoteFX progressive codec and H.264 passthrough. Off by default; the legacy bitmap pipeline is used instead, which is the safest choice for hosts without GPU/AVC444 support. Turn on for modern Windows Server hosts to get smoother rendering and (with H.264 also enabled) much lower bandwidth."
            >
              <input
                type="checkbox"
                checked={ex("disable-gfx") === "false"}
                onChange={(e) => {
                  setEx("disable-gfx", e.target.checked ? "false" : "true");
                }}
                className="checkbox"
              />
              Enable graphics pipeline (GFX)
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Load Balancing">
        <FieldGrid>
          <Field
            label="Load Balance Info"
            title="The load balancing info or token to send to the RDP server. Used when connecting to a load-balanced RDS farm."
          >
            <input
              value={ex("load-balance-info")}
              onChange={(e) => setEx("load-balance-info", e.target.value)}
              title="The load balancing info or token to send to the RDP server. Used when connecting to a load-balanced RDS farm."
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <p className="text-xs text-txt-tertiary mb-3">
          Recording path and filename are managed automatically by the system. Use the Recordings
          tab to enable/disable recording globally.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Exclude graphical output from the recording, producing a recording that contains only user input events."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-output") === "true"}
                onChange={(e) => setEx("recording-exclude-output", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude graphical output
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Exclude user mouse events from the recording, producing a recording without a visible mouse cursor."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-mouse") === "true"}
                onChange={(e) => setEx("recording-exclude-mouse", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude mouse events
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Exclude user touch events from the recording."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-touch") === "true"}
                onChange={(e) => setEx("recording-exclude-touch", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude touch events
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Include user key events in the recording. Can be interpreted with the guaclog utility to produce a human-readable log of keys pressed."
            >
              <input
                type="checkbox"
                checked={ex("recording-include-keys") === "true"}
                onChange={(e) => setEx("recording-include-keys", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="SFTP">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Enables SFTP-based file transfer. Files can be transferred to/from the RDP server using the Guacamole menu."
            >
              <input
                type="checkbox"
                checked={ex("enable-sftp") === "true"}
                onChange={(e) => setEx("enable-sftp", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable SFTP file transfer
            </label>
          </div>
          <div className="form-group !mb-0" />
          <Field
            label="SFTP Hostname"
            title="The hostname of the SSH/SFTP server to use for file transfer. If omitted, the RDP server hostname is used."
          >
            <input
              value={ex("sftp-hostname")}
              onChange={(e) => setEx("sftp-hostname", e.target.value)}
              placeholder="Same as RDP host"
              title="The hostname of the SSH/SFTP server to use for file transfer. If omitted, the RDP server hostname is used."
            />
          </Field>
          <Field label="SFTP Port" title="The port of the SSH/SFTP server. Defaults to 22.">
            <input
              type="number"
              value={ex("sftp-port")}
              onChange={(e) => setEx("sftp-port", e.target.value)}
              placeholder="22"
              title="The port of the SSH/SFTP server. Defaults to 22."
            />
          </Field>
          <Field
            label="SFTP Username"
            title="The username to authenticate as when connecting to the SFTP server."
          >
            <input
              value={ex("sftp-username")}
              onChange={(e) => setEx("sftp-username", e.target.value)}
              title="The username to authenticate as when connecting to the SFTP server."
            />
          </Field>
          <Field
            label="SFTP Password"
            title="The password to use when authenticating with the SFTP server."
          >
            <input
              type="password"
              value={ex("sftp-password")}
              onChange={(e) => setEx("sftp-password", e.target.value)}
              title="The password to use when authenticating with the SFTP server."
            />
          </Field>
          <Field
            label="SFTP Private Key"
            title="The entire contents of the SSH private key to use when authenticating with the SFTP server, in OpenSSH format."
          >
            <textarea
              value={ex("sftp-private-key")}
              onChange={(e) => setEx("sftp-private-key", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              title="The entire contents of the SSH private key to use when authenticating with the SFTP server, in OpenSSH format."
            />
          </Field>
          <Field
            label="SFTP Passphrase"
            title="The passphrase to use to decrypt the SSH private key, if it is encrypted."
          >
            <input
              type="password"
              value={ex("sftp-passphrase")}
              onChange={(e) => setEx("sftp-passphrase", e.target.value)}
              title="The passphrase to use to decrypt the SSH private key, if it is encrypted."
            />
          </Field>
          <Field
            label="Default Upload Directory"
            title="The default location for file uploads. If not specified, the user's home directory will be used."
          >
            <input
              value={ex("sftp-directory")}
              onChange={(e) => setEx("sftp-directory", e.target.value)}
              title="The default location for file uploads. If not specified, the user's home directory will be used."
            />
          </Field>
          <Field
            label="SFTP Root Directory"
            title="The directory to expose to connected users via SFTP. If omitted, '/' will be used by default."
          >
            <input
              value={ex("sftp-root-directory")}
              onChange={(e) => setEx("sftp-root-directory", e.target.value)}
              placeholder="/"
              title="The directory to expose to connected users via SFTP. If omitted, '/' will be used by default."
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Wake-on-LAN">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Send a Wake-on-LAN (WoL) magic packet to the remote host before attempting to connect. Useful for waking machines that are powered off."
            >
              <input
                type="checkbox"
                checked={ex("wol-send-packet") === "true"}
                onChange={(e) => setEx("wol-send-packet", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Send WoL packet before connecting
            </label>
          </div>
          <div className="form-group !mb-0" />
          <Field
            label="MAC Address"
            title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF."
          >
            <input
              value={ex("wol-mac-addr")}
              onChange={(e) => setEx("wol-mac-addr", e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF."
            />
          </Field>
          <Field
            label="Broadcast Address"
            title="The broadcast address to which the WoL magic packet should be sent. Defaults to 255.255.255.255 (local broadcast)."
          >
            <input
              value={ex("wol-broadcast-addr")}
              onChange={(e) => setEx("wol-broadcast-addr", e.target.value)}
              placeholder="255.255.255.255"
              title="The broadcast address to which the WoL magic packet should be sent. Defaults to 255.255.255.255 (local broadcast)."
            />
          </Field>
          <Field
            label="UDP Port"
            title="The UDP port to use when sending the WoL magic packet. Defaults to 9."
          >
            <input
              type="number"
              value={ex("wol-udp-port")}
              onChange={(e) => setEx("wol-udp-port", e.target.value)}
              placeholder="9"
              title="The UDP port to use when sending the WoL magic packet. Defaults to 9."
            />
          </Field>
          <Field
            label="Wait Time (seconds)"
            title="The number of seconds to wait after sending the WoL magic packet before attempting the connection."
          >
            <input
              type="number"
              value={ex("wol-wait-time")}
              onChange={(e) => setEx("wol-wait-time", e.target.value)}
              placeholder="0"
              title="The number of seconds to wait after sending the WoL magic packet before attempting the connection."
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Kerberos / NLA">
        <FieldGrid>
          <Field
            label="Auth Package"
            title="The authentication package to use for Network Level Authentication (NLA)."
          >
            <Select
              value={ex("auth-pkg")}
              onChange={(v) => setEx("auth-pkg", v)}
              placeholder="Default (auto-detect)"
              options={[
                { value: "", label: "Default (auto-detect)" },
                { value: "kerberos", label: "Kerberos only" },
                { value: "ntlm", label: "NTLM only" },
              ]}
            />
          </Field>
          {ex("auth-pkg") === "kerberos" && (
            <>
              <Field
                label="KDC URL"
                title="The URL of the Kerberos Key Distribution Center (KDC) to use for obtaining Kerberos tickets. Only needed if not using the global Kerberos realm configuration."
              >
                <input
                  value={ex("kdc-url")}
                  onChange={(e) => setEx("kdc-url", e.target.value)}
                  placeholder="tcp://kdc.example.com:88"
                  title="The URL of the Kerberos Key Distribution Center (KDC). Leave blank to use the KDC from the matching Kerberos realm."
                />
              </Field>
              <Field
                label="Kerberos Cache Path"
                title="The file path for the Kerberos credential cache. The cache stores obtained tickets for reuse."
              >
                <input
                  value={ex("kerberos-cache")}
                  onChange={(e) => setEx("kerberos-cache", e.target.value)}
                  placeholder="/tmp/krb5cc_strata"
                  title="The file path for the Kerberos credential cache. Leave blank for default."
                />
              </Field>
            </>
          )}
        </FieldGrid>
        {(!ex("auth-pkg") || ex("auth-pkg") === "") && (
          <p className="text-xs text-zinc-400 mt-2">
            When set to <strong>Default (auto-detect)</strong>, the client and server negotiate the
            best authentication method via SPNEGO. Realms configured in the{" "}
            <strong>Kerberos</strong> tab are written to the shared{" "}
            <code className="text-zinc-300">krb5.conf</code> which the session engine uses
            automatically — Kerberos-only servers will use Kerberos; servers that support NTLM will
            negotiate normally.
          </p>
        )}
      </Section>
    </>
  );
}

// ── SSH Parameter Sections ──────────────────────────────────────────

export function SshSections({
  ex,
  setEx,
  connectionId,
}: {
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
  /** Null while adding: there is no saved host to read a key from yet. */
  connectionId?: string | null;
}) {
  const [probe, setProbe] = useState<DiscoveredHostKey | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState("");

  async function fetchHostKey() {
    if (!connectionId) return;
    setProbing(true);
    setProbeError("");
    setProbe(null);
    try {
      setProbe(await discoverHostKey(connectionId));
    } catch (e) {
      setProbeError(e instanceof Error ? e.message : "Could not read the host key");
    } finally {
      setProbing(false);
    }
  }

  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <Field
            label="Private Key"
            title="The entire contents of the SSH private key to use for public key authentication. Must be in OpenSSH format."
          >
            <textarea
              value={ex("private-key")}
              onChange={(e) => setEx("private-key", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              title="The entire contents of the SSH private key to use for public key authentication. Must be in OpenSSH format."
            />
          </Field>
          <Field
            label="Passphrase"
            title="The passphrase to use to decrypt the SSH private key, if it is encrypted."
          >
            <input
              type="password"
              value={ex("passphrase")}
              onChange={(e) => setEx("passphrase", e.target.value)}
              title="The passphrase to use to decrypt the SSH private key, if it is encrypted."
            />
          </Field>
          <Field
            label="Host Key"
            title="The known public key of the SSH server, in OpenSSH format. If provided, the server's identity will be verified against this key."
          >
            <input
              value={ex("host-key")}
              onChange={(e) => setEx("host-key", e.target.value)}
              placeholder="Server public key (optional)"
              title="The known public key of the SSH server, in OpenSSH format. If provided, the server's identity will be verified against this key."
            />
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  className="btn text-xs"
                  onClick={fetchHostKey}
                  disabled={!connectionId || probing}
                  title={
                    connectionId
                      ? "Read the key this server currently presents, so it can be checked and approved."
                      : "Save the connection first, so there is a host to read a key from."
                  }
                >
                  {probing ? "Reading…" : "Fetch from server"}
                </button>
                <span className="text-[0.6rem] text-txt-tertiary italic">
                  Required by the native engine, which will not connect to an unverified host.
                </span>
              </div>
              {probeError && (
                <span className="text-[0.65rem]" style={{ color: "#ef4444" }}>
                  {probeError}
                </span>
              )}
              {probe && (
                <div
                  className="rounded-lg px-3 py-2 grid gap-1"
                  style={{ background: "var(--color-surface-tertiary)" }}
                >
                  <span className="text-[0.6rem] uppercase tracking-wider text-txt-tertiary font-semibold">
                    {probe.algorithm} — check this against the host before approving
                  </span>
                  <code className="text-[0.7rem] break-all text-txt-primary">
                    {probe.fingerprint}
                  </code>
                  <div className="flex gap-2 mt-1">
                    <button
                      type="button"
                      className="btn-primary text-xs"
                      onClick={() => {
                        setEx("host-key", probe.public_key);
                        setProbe(null);
                      }}
                    >
                      Approve
                    </button>
                    <button type="button" className="btn text-xs" onClick={() => setProbe(null)}>
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </div>
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <Field label="Color Scheme" title="The color scheme to use for the terminal display.">
            <Select
              value={ex("color-scheme")}
              onChange={(v) => setEx("color-scheme", v)}
              placeholder="Default (black on white)"
              options={[
                { value: "", label: "Default (black on white)" },
                { value: "green-black", label: "Green on black" },
                { value: "white-black", label: "White on black" },
                { value: "gray-black", label: "Gray on black" },
              ]}
            />
          </Field>
          <Field label="Font Size" title="The size of the font to use in the terminal, in points.">
            <input
              type="number"
              value={ex("font-size")}
              onChange={(e) => setEx("font-size", e.target.value)}
              placeholder="12"
              title="The size of the font to use in the terminal, in points."
            />
          </Field>
          <Field
            label="Scrollback (lines)"
            title="The maximum number of lines of terminal scrollback to allow. Each line requires additional memory. Defaults to 1000."
          >
            <input
              type="number"
              value={ex("scrollback")}
              onChange={(e) => setEx("scrollback", e.target.value)}
              placeholder="1000"
              title="The maximum number of lines of terminal scrollback to allow. Each line requires additional memory. Defaults to 1000."
            />
          </Field>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Prevents any user input from being sent to the SSH server. The session is view-only."
            >
              <input
                type="checkbox"
                checked={ex("read-only") === "true"}
                onChange={(e) => setEx("read-only", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Read-only
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Terminal Behavior">
        <FieldGrid>
          <Field
            label="Command"
            title="The command to execute on the remote server upon connecting, instead of the default shell."
          >
            <input
              value={ex("command")}
              onChange={(e) => setEx("command", e.target.value)}
              placeholder="Execute on connect"
              title="The command to execute on the remote server upon connecting, instead of the default shell."
            />
          </Field>
          <Field
            label="Locale"
            title="The locale to use for the SSH session (e.g. en_US.UTF-8). Controls character encoding."
          >
            <input
              value={ex("locale")}
              onChange={(e) => setEx("locale", e.target.value)}
              placeholder="en_US.UTF-8"
              title="The locale to use for the SSH session (e.g. en_US.UTF-8). Controls character encoding."
            />
          </Field>
          <Field
            label="Timezone"
            title="The timezone to pass to the SSH server via the TZ environment variable, in IANA format (e.g. America/New_York)."
          >
            <Select
              value={ex("timezone")}
              onChange={(v) => setEx("timezone", v)}
              placeholder="System default"
              options={[
                { value: "", label: "System default" },
                ...getTimezones().map((tz) => ({ value: tz, label: tz })),
              ]}
            />
          </Field>
          <Field
            label="Terminal Type"
            title="The terminal emulator type string to send to the SSH server (e.g. xterm-256color, vt100). This determines which escape sequences are supported."
          >
            <input
              value={ex("terminal-type")}
              onChange={(e) => setEx("terminal-type", e.target.value)}
              placeholder="xterm-256color"
              title="The terminal emulator type string to send to the SSH server (e.g. xterm-256color, vt100). This determines which escape sequences are supported."
            />
          </Field>
          <Field
            label="Server Alive Interval"
            title="The interval in seconds at which to send keepalive packets to the SSH server. Set to 0 to disable. Useful for preventing idle timeouts."
          >
            <input
              type="number"
              value={ex("server-alive-interval")}
              onChange={(e) => setEx("server-alive-interval", e.target.value)}
              placeholder="0"
              title="The interval in seconds at which to send keepalive packets to the SSH server. Set to 0 to disable. Useful for preventing idle timeouts."
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="SFTP">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Enables SFTP file transfer within the SSH connection. Files can be transferred using the Guacamole menu."
            >
              <input
                type="checkbox"
                checked={ex("enable-sftp") === "true"}
                onChange={(e) => setEx("enable-sftp", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable SFTP
            </label>
          </div>
          <Field
            label="SFTP Root Directory"
            title="The root directory to expose to connected users via SFTP. If omitted, '/' will be used."
          >
            <input
              value={ex("sftp-root-directory")}
              onChange={(e) => setEx("sftp-root-directory", e.target.value)}
              placeholder="/"
              title="The root directory to expose to connected users via SFTP. If omitted, '/' will be used."
            />
          </Field>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Disables file downloads from the remote server to the local browser."
            >
              <input
                type="checkbox"
                checked={ex("sftp-disable-download") === "true"}
                onChange={(e) => setEx("sftp-disable-download", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable file download
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Disables file uploads from the local browser to the remote server."
            >
              <input
                type="checkbox"
                checked={ex("sftp-disable-upload") === "true"}
                onChange={(e) => setEx("sftp-disable-upload", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable file upload
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <p className="text-xs text-txt-tertiary mb-3">
          Recording path and filename are managed automatically by the system. Use the Recordings
          tab to enable/disable recording globally.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Include user key events in the recording. Can be interpreted with the guaclog utility to produce a human-readable log of keys pressed."
            >
              <input
                type="checkbox"
                checked={ex("recording-include-keys") === "true"}
                onChange={(e) => setEx("recording-include-keys", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Wake-on-LAN">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Send a Wake-on-LAN (WoL) magic packet to the remote host before attempting to connect."
            >
              <input
                type="checkbox"
                checked={ex("wol-send-packet") === "true"}
                onChange={(e) => setEx("wol-send-packet", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Send WoL packet
            </label>
          </div>
          <Field
            label="MAC Address"
            title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF."
          >
            <input
              value={ex("wol-mac-addr")}
              onChange={(e) => setEx("wol-mac-addr", e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF."
            />
          </Field>
        </FieldGrid>
      </Section>
    </>
  );
}

// ── VNC Parameter Sections ──────────────────────────────────────────

export function VncSections({
  ex,
  setEx,
}: {
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <Field
            className="form-group"
            label="Password"
            title="The password to use when connecting to the VNC server."
          >
            <input
              type="password"
              value={ex("password")}
              onChange={(e) => setEx("password", e.target.value)}
              title="The password to use when connecting to the VNC server."
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <Field
            className="form-group"
            label="Color Depth"
            title="The color depth to request from the VNC server, in bits per pixel."
          >
            <Select
              value={ex("color-depth")}
              onChange={(v) => setEx("color-depth", v)}
              placeholder="Auto"
              options={[
                { value: "", label: "Auto" },
                { value: "8", label: "8-bit" },
                { value: "16", label: "16-bit" },
                { value: "24", label: "24-bit" },
                { value: "32", label: "32-bit" },
              ]}
            />
          </Field>
          <Field
            className="form-group"
            label="Cursor"
            title="Controls how the mouse cursor is displayed. 'Local' renders the cursor on the client for performance. 'Remote' shows the VNC server's cursor."
          >
            <Select
              value={ex("cursor")}
              onChange={(v) => setEx("cursor", v)}
              placeholder="Local"
              options={[
                { value: "", label: "Local" },
                { value: "remote", label: "Remote" },
              ]}
            />
          </Field>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              title="Prevents any user input from being sent to the VNC server. The session is view-only."
            >
              <input
                type="checkbox"
                checked={ex("read-only") === "true"}
                onChange={(e) => setEx("read-only", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Read-only
            </label>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              title="Swap the red and blue color components in the received image data. May be needed for certain VNC servers that report colors incorrectly."
            >
              <input
                type="checkbox"
                checked={ex("swap-red-blue") === "true"}
                onChange={(e) => setEx("swap-red-blue", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Swap red/blue
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Clipboard">
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              title="Prevents text from being copied from the remote desktop to the local clipboard."
            >
              <input
                type="checkbox"
                checked={ex("disable-copy") === "true"}
                onChange={(e) => setEx("disable-copy", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable copy from remote
            </label>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              title="Prevents text from being pasted from the local clipboard to the remote desktop."
            >
              <input
                type="checkbox"
                checked={ex("disable-paste") === "true"}
                onChange={(e) => setEx("disable-paste", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable paste to remote
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <p className="text-xs text-txt-tertiary mb-3">
          Recording path and filename are managed automatically by the system. Use the Recordings
          tab to enable/disable recording globally.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Exclude graphical output from the recording, producing a recording that contains only user input events."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-output") === "true"}
                onChange={(e) => setEx("recording-exclude-output", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude graphical output
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Exclude user mouse events from the recording, producing a recording without a visible mouse cursor."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-mouse") === "true"}
                onChange={(e) => setEx("recording-exclude-mouse", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude mouse events
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Exclude user touch events from the recording."
            >
              <input
                type="checkbox"
                checked={ex("recording-exclude-touch") === "true"}
                onChange={(e) => setEx("recording-exclude-touch", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Exclude touch events
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Include user key events in the recording. Can be interpreted with the guaclog utility to produce a human-readable log of keys pressed."
            >
              <input
                type="checkbox"
                checked={ex("recording-include-keys") === "true"}
                onChange={(e) => setEx("recording-include-keys", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>
    </>
  );
}

// ── Web Browser Session Sections ────────────────────────────────────
//
// Roadmap item `protocols-web-sessions` (shipped in v0.30.0). A
// `web` connection launches an ephemeral Chromium kiosk inside an
// Xvnc display and serves it through the session engine as a standard VNC
// session — the differences from a normal VNC connection are entirely
// server-side, but admins configure them through the fields below.
// All values land in `connections.extra` JSONB alongside the regular
// protocol params.

export function WebSections({
  ex,
  setEx,
}: {
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  // `allowed_domains` is stored as a JSON-encoded string array inside
  // `extra`. The chip editor below converts to/from a comma-separated
  // textarea representation so admins can paste a list verbatim.
  const allowedDomainsRaw = ex("allowed_domains");
  let allowedDomains: string[] = [];
  try {
    const parsed = allowedDomainsRaw ? JSON.parse(allowedDomainsRaw) : [];
    if (Array.isArray(parsed)) allowedDomains = parsed.filter((s) => typeof s === "string");
  } catch {
    /* tolerate legacy comma-separated values */
    allowedDomains = allowedDomainsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const setAllowedDomains = (next: string[]) => {
    const cleaned = next.map((s) => s.trim()).filter(Boolean);
    setEx("allowed_domains", cleaned.length ? JSON.stringify(cleaned) : "");
  };

  // Trusted CA picker — shared with the RDP form.
  const trustedCas = useTrustedCas();

  return (
    <>
      <Section title="Target URL" defaultOpen>
        <FieldGrid>
          <Field
            label="Initial URL"
            title="The URL the kiosk Chromium instance navigates to when the session starts. Must include the scheme (https://...). Subject to the allowed-domains and server-side egress allow-list (system_settings.web_allowed_networks)."
            className="form-group !mb-0 col-span-2"
          >
            <input
              value={ex("url")}
              onChange={(e) => setEx("url", e.target.value)}
              placeholder="https://app.example.com/login"
              type="url"
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Domain Allow-list">
        <p className="text-xs opacity-60 mb-2">
          Hostnames the kiosk Chromium is permitted to resolve. Leave empty to allow any host that
          passes the server-side egress check. Wildcards like <code>*.example.com</code>
          are honoured by Chromium&apos;s <code>--host-rules</code>.
        </p>
        <FieldGrid>
          <Field
            className="form-group !mb-0 col-span-2"
            label="Allowed Domains (one per line or comma-separated)"
          >
            <textarea
              value={allowedDomains.join("\n")}
              onChange={(e) =>
                setAllowedDomains(e.target.value.split(/[\n,]/).map((s) => s.trim()))
              }
              rows={4}
              placeholder={"example.com\n*.example.com\nauth.okta.com"}
              className="font-mono text-sm"
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Login Automation">
        <p className="text-xs opacity-60 mb-2">
          Optionally run a registered server-side script over Chrome DevTools Protocol after the
          page loads. Scripts are administered separately and reference by name to keep connection
          rows compact and auditable.
        </p>
        <FieldGrid>
          <Field
            label="Login Script"
            title="Identifier of a registered login script. Leave blank for no automation."
          >
            <input
              value={ex("login_script")}
              onChange={(e) => setEx("login_script", e.target.value)}
              placeholder="okta-saml"
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Trusted Certificate Authority">
        <p className="text-xs opacity-60 mb-2">
          Pick a stored CA bundle to inject into the kiosk Chromium&apos;s per-session NSS database.
          Use this when the target site&apos;s TLS certificate chains to a private root the public
          trust store doesn&apos;t recognise. Manage entries under{" "}
          <strong>Admin → Trusted CAs</strong>.
        </p>
        <FieldGrid>
          <Field className="form-group !mb-0 col-span-2" label="Trusted CA">
            <Select
              value={ex("trusted_ca_id")}
              onChange={(v) => setEx("trusted_ca_id", v)}
              options={[
                { value: "", label: "— Use system default trust store —" },
                ...trustedCas.map((c) => ({
                  value: c.id,
                  label: c.subject ? `${c.name} (${c.subject})` : c.name,
                })),
              ]}
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Egress Allow-list (read-only)">
        <p className="text-xs opacity-60">
          Outbound network access is bounded server-side by the
          <code className="mx-1">web_allowed_networks</code> system setting (CIDR list). Empty
          allow-list denies all outbound traffic — operators must opt in to
          <code className="mx-1">0.0.0.0/0</code> for public-internet access. Configure under
          <strong className="mx-1">Admin → Network</strong>.
        </p>
      </Section>
    </>
  );
}

// ── VDI Desktop Container Sections ──────────────────────────────────
//
// Roadmap item `protocols-vdi-containers` (shipped in v0.30.0). A
// `vdi` connection launches a Strata-managed Docker container running
// xrdp on port 3389 and serves it through the session engine as a standard RDP
// session. Operator constraints (image whitelist, CPU/memory caps,
// idle timeout, env injection, persistent home) all land in
// `connections.extra`.

export function VdiSections({
  ex,
  setEx,
}: {
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  const [images, setImages] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVdiImages()
      .then((res) => {
        if (!cancelled) setImages(res.images);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err?.message ?? String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // env_vars are stored in `extra.env_vars` as a JSON-encoded
  // {key:value} object. Reserved keys (VDI_USERNAME, VDI_PASSWORD) are
  // stripped server-side regardless of what the admin enters here.
  const envRaw = ex("env_vars");
  let envEntries: Array<[string, string]> = [];
  try {
    const parsed = envRaw ? JSON.parse(envRaw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      envEntries = Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]);
    }
  } catch {
    /* leave empty */
  }
  const setEnvEntries = (next: Array<[string, string]>) => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of next) {
      const key = k.trim();
      if (!key || key === "VDI_USERNAME" || key === "VDI_PASSWORD") continue;
      cleaned[key] = v;
    }
    setEx("env_vars", Object.keys(cleaned).length ? JSON.stringify(cleaned) : "");
  };

  return (
    <>
      <Section title="Container Image" defaultOpen>
        <FieldGrid>
          <Field
            label="Image"
            title="The Docker image used to spawn the desktop container. The list is restricted to images whitelisted by the operator under Admin → System Settings."
            className="form-group !mb-0 col-span-2"
          >
            <Select
              value={ex("image")}
              onChange={(v) => setEx("image", v)}
              placeholder={
                loadError
                  ? `Failed to load images: ${loadError}`
                  : images.length === 0
                    ? "No images whitelisted — configure under Admin → System Settings"
                    : "Select an image"
              }
              options={images.map((img) => ({ value: img, label: img }))}
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Resource Limits">
        <FieldGrid>
          <Field
            label="CPU Limit (cores)"
            title="Maximum CPU cores the container can use (Docker --cpus). Leave blank for unbounded."
          >
            <input
              type="number"
              step="0.1"
              min="0"
              value={ex("cpu_limit")}
              onChange={(e) => setEx("cpu_limit", e.target.value)}
              placeholder="2.0"
            />
          </Field>
          <Field
            label="Memory Limit (MB)"
            title="Maximum memory the container can use, in megabytes (Docker --memory). Leave blank for unbounded."
          >
            <input
              type="number"
              min="0"
              value={ex("memory_limit_mb")}
              onChange={(e) => setEx("memory_limit_mb", e.target.value)}
              placeholder="4096"
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Lifecycle">
        <FieldGrid>
          <Field
            label="Idle Timeout (minutes)"
            title="Minutes of inactivity after which the reaper destroys the container. Defaults to 30 when blank."
          >
            <input
              type="number"
              min="1"
              value={ex("idle_timeout_mins")}
              onChange={(e) => setEx("idle_timeout_mins", e.target.value)}
              placeholder="30"
            />
          </Field>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2 mt-1"
              title="Preserve the user's home directory between sessions on a bind mount. Disabled by default — every session starts from a fresh container."
            >
              <input
                type="checkbox"
                checked={ex("persistent_home") === "true"}
                onChange={(e) => setEx("persistent_home", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Persistent home directory
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Environment Variables">
        <p className="text-xs opacity-60 mb-2">
          Injected into the container at start-up. <code>VDI_USERNAME</code> and{" "}
          <code>VDI_PASSWORD</code> are reserved — Strata always supplies them at runtime and will
          silently drop any matching entries here.
        </p>
        <div className="space-y-2">
          {envEntries.map(([k, v], idx) => (
            <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-start">
              <input
                value={k}
                placeholder="KEY"
                onChange={(e) => {
                  const next = [...envEntries];
                  next[idx] = [e.target.value, v];
                  setEnvEntries(next);
                }}
                className="font-mono text-sm"
              />
              <input
                value={v}
                placeholder="value"
                onChange={(e) => {
                  const next = [...envEntries];
                  next[idx] = [k, e.target.value];
                  setEnvEntries(next);
                }}
                className="font-mono text-sm"
              />
              <button
                type="button"
                className="btn-sm"
                onClick={() => {
                  const next = envEntries.filter((_, i) => i !== idx);
                  setEnvEntries(next);
                }}
                title="Remove this variable"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-sm"
            onClick={() => setEnvEntries([...envEntries, ["", ""]])}
          >
            + Add Variable
          </button>
        </div>
      </Section>
    </>
  );
}

// ── Kubernetes Parameter Sections ──────────────────────────────────
//
// Renders the connection-form fields for the `kubernetes` protocol
// (guacd's pod-console client — `kubectl attach` / `kubectl exec`
// over the K8s API, projected through Guacamole's terminal protocol).
//
// Field layout intentionally mirrors SshSections so operators get a
// familiar terminal section. Authentication is split:
//   - **Bearer token / static credentials** are handled at the
//     connection level via Credential Profiles (the profile's
//     password slot carries either a bearer token *or* the PEM
//     `client-key` body — see `routes/tunnel.rs` for the remap).
//   - **Public PEM material** (CA cert, client cert) lives here
//     because it is non-sensitive and benefits from being editable
//     alongside the rest of the connection.
//
// We deliberately do NOT expose `client-key` as a form field — it
// must flow through the Vault-encrypted profile path so the private
// half is never written to the connections table.
export function KubernetesSections({
  ex,
  setEx,
}: {
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  return (
    <>
      <Section title="Pod Target" defaultOpen>
        <FieldGrid>
          <Field
            label={
              <>
                Pod Name <span className="text-red-500">*</span>
              </>
            }
            title="The name of the pod to attach or exec into. Required."
          >
            <input
              value={ex("pod")}
              onChange={(e) => setEx("pod", e.target.value)}
              placeholder="my-pod-abc123"
              title="The name of the pod to attach or exec into. Required."
            />
          </Field>
          <Field
            label="Namespace"
            title="The Kubernetes namespace containing the pod. Defaults to 'default'."
          >
            <input
              value={ex("namespace")}
              onChange={(e) => setEx("namespace", e.target.value)}
              placeholder="default"
              title="The Kubernetes namespace containing the pod. Defaults to 'default'."
            />
          </Field>
          <Field
            label="Container"
            title="The container within the pod to attach to. Required only if the pod has more than one container."
          >
            <input
              value={ex("container")}
              onChange={(e) => setEx("container", e.target.value)}
              placeholder="(default container)"
              title="The container within the pod to attach to. Required only if the pod has more than one container."
            />
          </Field>
          <Field
            label="Exec Command"
            title="If set, runs `kubectl exec` with this command instead of `kubectl attach`. Leave blank to attach to the container's existing console."
          >
            <input
              value={ex("exec-command")}
              onChange={(e) => setEx("exec-command", e.target.value)}
              placeholder="(blank = attach)"
              title="If set, runs `kubectl exec` with this command instead of `kubectl attach`. Leave blank to attach to the container's existing console."
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="TLS">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Connect to the API server using HTTPS. Almost always required — only disable for unsecured local dev clusters."
            >
              <input
                type="checkbox"
                checked={ex("use-ssl") !== "false"}
                onChange={(e) => setEx("use-ssl", e.target.checked ? "" : "false")}
                className="checkbox"
              />
              Use SSL/TLS
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Skip verification of the API server's TLS certificate. Insecure — prefer pasting the cluster CA below."
            >
              <input
                type="checkbox"
                checked={ex("ignore-cert") === "true"}
                onChange={(e) => setEx("ignore-cert", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Ignore certificate errors
            </label>
          </div>
          <Field
            label="Cluster CA Certificate (PEM)"
            title="PEM-encoded CA certificate the API server's certificate chains to. Paste the contents of your kubeconfig's certificate-authority-data (base64-decoded) or the cluster CA file."
            className="form-group !mb-0 col-span-full"
          >
            <textarea
              value={ex("ca-cert")}
              onChange={(e) => setEx("ca-cert", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              placeholder="-----BEGIN CERTIFICATE-----"
              title="PEM-encoded CA certificate the API server's certificate chains to."
            />
          </Field>
          <Field
            label="Client Certificate (PEM)"
            title="PEM-encoded client certificate for mTLS authentication. Paired with the client-key stored in the connection's credential profile."
            className="form-group !mb-0 col-span-full"
          >
            <textarea
              value={ex("client-cert")}
              onChange={(e) => setEx("client-cert", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              placeholder="-----BEGIN CERTIFICATE-----"
              title="PEM-encoded client certificate. The matching private key is stored in the credential profile."
            />
          </Field>
        </FieldGrid>
        <p className="text-xs text-txt-tertiary mt-2">
          The client <em>private key</em> is stored separately in this connection&apos;s credential
          profile (encrypted via Vault Transit) and is never written to the connections table.
        </p>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <Field label="Color Scheme" title="The color scheme to use for the terminal display.">
            <Select
              value={ex("color-scheme")}
              onChange={(v) => setEx("color-scheme", v)}
              placeholder="Gray on black (default)"
              options={[
                { value: "", label: "Gray on black (default)" },
                { value: "green-black", label: "Green on black" },
                { value: "white-black", label: "White on black" },
                { value: "black-white", label: "Black on white" },
              ]}
            />
          </Field>
          <Field label="Font Size" title="The size of the font to use in the terminal, in points.">
            <input
              type="number"
              value={ex("font-size")}
              onChange={(e) => setEx("font-size", e.target.value)}
              placeholder="12"
              title="The size of the font to use in the terminal, in points."
            />
          </Field>
          <Field
            label="Scrollback (lines)"
            title="The maximum number of lines of terminal scrollback. Defaults to 1000."
          >
            <input
              type="number"
              value={ex("scrollback")}
              onChange={(e) => setEx("scrollback", e.target.value)}
              placeholder="1000"
              title="The maximum number of lines of terminal scrollback. Defaults to 1000."
            />
          </Field>
          <Field
            label="Backspace Key Code"
            title="ASCII code sent when the Backspace key is pressed. 127 = Delete (default), 8 = Backspace. Change only if Backspace produces ^? or ^H instead of erasing."
          >
            <input
              type="number"
              value={ex("backspace")}
              onChange={(e) => setEx("backspace", e.target.value)}
              placeholder="127"
              title="ASCII code sent when the Backspace key is pressed. 127 = Delete (default), 8 = Backspace."
            />
          </Field>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Prevents any user input from being sent to the pod. The session is view-only."
            >
              <input
                type="checkbox"
                checked={ex("read-only") === "true"}
                onChange={(e) => setEx("read-only", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Read-only
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Clipboard">
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="If checked, text copied inside the pod terminal will not be exposed to the browser clipboard."
            >
              <input
                type="checkbox"
                checked={ex("disable-copy") === "true"}
                onChange={(e) => setEx("disable-copy", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable copy (pod → browser)
            </label>
          </div>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="If checked, text copied at the browser cannot be pasted into the pod terminal."
            >
              <input
                type="checkbox"
                checked={ex("disable-paste") === "true"}
                onChange={(e) => setEx("disable-paste", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable paste (browser → pod)
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Screen Recording">
        <p className="text-xs text-txt-tertiary mb-3">
          Recording path and filename are managed automatically by the system. Use the Recordings
          tab to enable/disable recording globally.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0">
            <span className="block" aria-hidden="true">
              &nbsp;
            </span>
            <label
              className="flex items-center gap-2"
              title="Include user key events in the recording. Can be interpreted with the guaclog utility."
            >
              <input
                type="checkbox"
                checked={ex("recording-include-keys") === "true"}
                onChange={(e) => setEx("recording-include-keys", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Include key events
            </label>
          </div>
        </FieldGrid>
      </Section>
    </>
  );
}
