import { useState, useEffect } from "react";
import Select from "../../components/Select";
import { getTimezones } from "../../utils/time";
import { getVdiImages, getTrustedCasForPicker, TrustedCaPickerEntry } from "../../api";
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

// ── RDP Parameter Sections ──────────────────────────────────────────

export function RdpSections({
  extra: _extra,
  setExtra: _setExtra,
  ex,
  setEx,
}: {
  extra: Record<string, string>;
  setExtra: (v: Record<string, string>) => void;
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The security mode to use for the RDP connection. 'Any' allows the server to choose. 'NLA' uses Network Level Authentication. 'TLS' uses TLS encryption. 'RDP' uses standard RDP encryption. 'VMConnect' uses Hyper-V's enhanced session mode.">
              Security Mode
            </label>
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
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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

      <Section title="Remote Desktop Gateway">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The hostname of the Remote Desktop Gateway to tunnel the RDP connection through.">
              Gateway Hostname
            </label>
            <input
              value={ex("gateway-hostname")}
              onChange={(e) => setEx("gateway-hostname", e.target.value)}
              placeholder="gw.example.com"
              title="The hostname of the Remote Desktop Gateway to tunnel the RDP connection through."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The port of the Remote Desktop Gateway. By default, this is 443.">
              Gateway Port
            </label>
            <input
              type="number"
              value={ex("gateway-port")}
              onChange={(e) => setEx("gateway-port", e.target.value)}
              placeholder="443"
              title="The port of the Remote Desktop Gateway. By default, this is 443."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The domain to use when authenticating with the Remote Desktop Gateway.">
              Gateway Domain
            </label>
            <input
              value={ex("gateway-domain")}
              onChange={(e) => setEx("gateway-domain", e.target.value)}
              title="The domain to use when authenticating with the Remote Desktop Gateway."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The username to use when authenticating with the Remote Desktop Gateway.">
              Gateway Username
            </label>
            <input
              value={ex("gateway-username")}
              onChange={(e) => setEx("gateway-username", e.target.value)}
              title="The username to use when authenticating with the Remote Desktop Gateway."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The password to use when authenticating with the Remote Desktop Gateway.">
              Gateway Password
            </label>
            <input
              type="password"
              value={ex("gateway-password")}
              onChange={(e) => setEx("gateway-password", e.target.value)}
              title="The password to use when authenticating with the Remote Desktop Gateway."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Basic Settings">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The server-side keyboard layout. This is the layout of the RDP server and determines how keystrokes are interpreted.">
              Keyboard Layout
            </label>
            <Select
              value={ex("server-layout")}
              onChange={(v) => setEx("server-layout", v)}
              placeholder="Default (US English)"
              options={RDP_KEYBOARD_LAYOUTS}
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The timezone that the client should send to the server for configuring the local time display, in IANA format (e.g. America/New_York).">
              Timezone
            </label>
            <Select
              value={ex("timezone")}
              onChange={(v) => setEx("timezone", v)}
              placeholder="System default"
              options={[
                { value: "", label: "System default" },
                ...getTimezones().map((tz) => ({ value: tz, label: tz })),
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the client to present to the RDP server. Typically not required.">
              Client Name
            </label>
            <input
              value={ex("client-name")}
              onChange={(e) => setEx("client-name", e.target.value)}
              placeholder="Strata"
              title="The name of the client to present to the RDP server. Typically not required."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The full path to the program to run immediately upon connecting. Not needed for normal desktop sessions.">
              Initial Program
            </label>
            <input
              value={ex("initial-program")}
              onChange={(e) => setEx("initial-program", e.target.value)}
              title="The full path to the program to run immediately upon connecting. Not needed for normal desktop sessions."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Connect to the administrator console (Session 0) of the RDP server. This is the physical console session."
            >
              <input
                type="checkbox"
                checked={ex("console") === "true"}
                onChange={(e) => setEx("console", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Administrator console
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enable multi-touch support, allowing touch events from the client to be forwarded to the remote desktop."
            >
              <input
                type="checkbox"
                checked={ex("enable-touch") === "true"}
                onChange={(e) => setEx("enable-touch", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable multi-touch
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The color depth to request from the RDP server, in bits per pixel. The default of 32-bit is REQUIRED for H.264 GFX negotiation; lower values silently disable AVC444 and force the RemoteFX codec.">
              Color Depth
            </label>
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
          </div>
          <div className="form-group !mb-0">
            <label title="The method to use to update the RDP session when the browser window is resized. 'Display Update' sends a display update command. 'Reconnect' disconnects and reconnects with the new resolution.">
              Resize Method
            </label>
            <Select
              value={ex("resize-method") || "display-update"}
              onChange={(v) => setEx("resize-method", v)}
              options={[
                { value: "display-update", label: "Display Update" },
                { value: "reconnect", label: "Reconnect" },
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0 col-span-2">
            <label>&nbsp;</label>
            <label
              className={`flex items-center gap-2 ${ex("disable-gfx") !== "false" ? "opacity-50" : ""}`}
              title="H.264 GFX passthrough sends raw H.264 NAL units to the browser's WebCodecs VideoDecoder, dramatically reducing bandwidth on modern RDP hosts. Off by default because it requires the Windows host to actually support H.264 — either a GPU is present, or AVC444 has been enabled in the registry (run docs/Configure-RdpAvc444.ps1 on the host). Enabling this on a host without H.264 capability causes RDPGFX to negotiate a codec it can't deliver, producing persistent ghost tiles. Requires the graphics pipeline (GFX) to be enabled."
            >
              <input
                type="checkbox"
                checked={ex("enable-h264") === "true"}
                disabled={ex("disable-gfx") !== "false"}
                onChange={(e) => {
                  if (e.target.checked) {
                    setEx("enable-h264", "true");
                    // H.264 requires GFX — ensure it's explicitly enabled.
                    if (ex("disable-gfx") !== "false") setEx("disable-gfx", "false");
                  } else {
                    setEx("enable-h264", "");
                  }
                }}
                className="checkbox"
              />
              Enable H.264 codec (browser-side passthrough, lower bandwidth)
            </label>
            {ex("enable-h264") === "true" && (
              <p className="text-xs text-amber-400/90 mt-1 ml-6">
                ⚠ Requires AVC444 to be configured on the Windows host (run{" "}
                <code className="font-mono">docs/Configure-RdpAvc444.ps1</code> on the server){" "}
                <strong>or</strong> a GPU available to the RDP session. Enabling this on a host that
                does not support H.264 will cause rendering corruption (ghost tiles bleeding across
                the desktop).
              </p>
            )}
            {ex("disable-gfx") !== "false" && (
              <p className="text-xs text-txt-tertiary mt-1 ml-6">
                Disabled because the graphics pipeline (GFX) is turned off in Performance — H.264
                only works inside GFX.
              </p>
            )}
          </div>
        </FieldGrid>
      </Section>

      <Section title="Clipboard">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="Controls how line endings in clipboard content are normalized. 'Preserve' keeps original line endings, 'Unix' converts to LF, 'Windows' converts to CRLF.">
              Normalize Clipboard
            </label>
            <Select
              value={ex("normalize-clipboard")}
              onChange={(v) => setEx("normalize-clipboard", v)}
              placeholder="Default (preserve)"
              options={[
                { value: "", label: "Default (preserve)" },
                { value: "preserve", label: "Preserve" },
                { value: "unix", label: "Unix (LF)" },
                { value: "windows", label: "Windows (CRLF)" },
              ]}
            />
          </div>
          <div className="form-group !mb-0" />
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables audio input (microphone) support, allowing the user's local microphone to be used within the remote desktop session."
            >
              <input
                type="checkbox"
                checked={ex("enable-audio-input") === "true"}
                onChange={(e) => setEx("enable-audio-input", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable audio input (microphone)
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables printer redirection. PDF documents sent to the redirected printer will be available for download via the Guacamole menu."
            >
              <input
                type="checkbox"
                checked={ex("enable-printing") === "true"}
                onChange={(e) => setEx("enable-printing", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable printing
            </label>
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the redirected printer device. This will be the name of the printer as it appears on the remote desktop.">
              Printer Name
            </label>
            <input
              value={ex("printer-name")}
              onChange={(e) => setEx("printer-name", e.target.value)}
              placeholder="Strata Printer"
              title="The name of the redirected printer device. This will be the name of the printer as it appears on the remote desktop."
            />
          </div>
        </FieldGrid>
        <hr className="border-0 border-t border-border my-3" />
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables file transfer over a virtual drive. Files can be transferred to/from the remote desktop using the Guacamole menu."
            >
              <input
                type="checkbox"
                checked={ex("enable-drive") === "true"}
                onChange={(e) => setEx("enable-drive", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Enable drive / file transfer
            </label>
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the filesystem used for transferred files. This is the name the virtual drive will have within the remote desktop.">
              Drive Name
            </label>
            <input
              value={ex("drive-name")}
              onChange={(e) => setEx("drive-name", e.target.value)}
              placeholder="Shared Drive"
              title="The name of the filesystem used for transferred files. This is the name the virtual drive will have within the remote desktop."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The directory on the guacd server in which transferred files should be stored.">
              Drive Path
            </label>
            <input
              value={ex("drive-path")}
              onChange={(e) => setEx("drive-path", e.target.value)}
              placeholder="/var/lib/guacamole/drive"
              title="The directory on the guacd server in which transferred files should be stored."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Automatically creates the drive path directory if it does not already exist on the guacd server."
            >
              <input
                type="checkbox"
                checked={ex("create-drive-path") === "true"}
                onChange={(e) => setEx("create-drive-path", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Auto-create drive path
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables file downloads from the remote desktop to the local browser."
            >
              <input
                type="checkbox"
                checked={ex("disable-download") === "true"}
                onChange={(e) => setEx("disable-download", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable file download
            </label>
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Disables file uploads from the local browser to the remote desktop."
            >
              <input
                type="checkbox"
                checked={ex("disable-upload") === "true"}
                onChange={(e) => setEx("disable-upload", e.target.checked ? "true" : "")}
                className="checkbox"
              />
              Disable file upload
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Performance">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
            <label
              className="flex items-center gap-2"
              title="Enables the Graphics Pipeline Extension (RDPGFX) — the modern surface-based rendering path used for RemoteFX progressive codec and H.264 passthrough. Off by default; the legacy bitmap pipeline is used instead, which is the safest choice for hosts without GPU/AVC444 support. Turn on for modern Windows Server hosts to get smoother rendering and (with H.264 also enabled) much lower bandwidth."
            >
              <input
                type="checkbox"
                checked={ex("disable-gfx") === "false"}
                onChange={(e) => {
                  if (e.target.checked) {
                    setEx("disable-gfx", "false");
                  } else {
                    setEx("disable-gfx", "true");
                    // H.264 lives inside GFX — turn it off too.
                    if (ex("enable-h264") === "true") setEx("enable-h264", "");
                  }
                }}
                className="checkbox"
              />
              Enable graphics pipeline (GFX)
            </label>
          </div>
        </FieldGrid>
      </Section>

      <Section title="RemoteApp">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The name of the RemoteApp to launch. Use '||' prefix for publishing (e.g. '||notepad'). The application must be registered as a RemoteApp on the server.">
              Program
            </label>
            <input
              value={ex("remote-app")}
              onChange={(e) => setEx("remote-app", e.target.value)}
              placeholder="||notepad"
              title="The name of the RemoteApp to launch. Use '||' prefix for publishing (e.g. '||notepad'). The application must be registered as a RemoteApp on the server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The working directory for the RemoteApp, if any.">
              Working Directory
            </label>
            <input
              value={ex("remote-app-dir")}
              onChange={(e) => setEx("remote-app-dir", e.target.value)}
              placeholder="C:\Users\user"
              title="The working directory for the RemoteApp, if any."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="Command-line parameters to pass to the RemoteApp.">Parameters</label>
            <input
              value={ex("remote-app-args")}
              onChange={(e) => setEx("remote-app-args", e.target.value)}
              title="Command-line parameters to pass to the RemoteApp."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Load Balancing / Preconnection">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The load balancing info or token to send to the RDP server. Used when connecting to a load-balanced RDS farm.">
              Load Balance Info
            </label>
            <input
              value={ex("load-balance-info")}
              onChange={(e) => setEx("load-balance-info", e.target.value)}
              title="The load balancing info or token to send to the RDP server. Used when connecting to a load-balanced RDS farm."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The numeric ID of the RDP source. Used with Hyper-V and other systems that support preconnection PDUs.">
              Preconnection ID
            </label>
            <input
              type="number"
              value={ex("preconnection-id")}
              onChange={(e) => setEx("preconnection-id", e.target.value)}
              title="The numeric ID of the RDP source. Used with Hyper-V and other systems that support preconnection PDUs."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="A text value identifying the RDP source to connect to. Used with Hyper-V or other systems supporting preconnection PDUs.">
              Preconnection BLOB
            </label>
            <input
              value={ex("preconnection-blob")}
              onChange={(e) => setEx("preconnection-blob", e.target.value)}
              title="A text value identifying the RDP source to connect to. Used with Hyper-V or other systems supporting preconnection PDUs."
            />
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0">
            <label title="The hostname of the SSH/SFTP server to use for file transfer. If omitted, the RDP server hostname is used.">
              SFTP Hostname
            </label>
            <input
              value={ex("sftp-hostname")}
              onChange={(e) => setEx("sftp-hostname", e.target.value)}
              placeholder="Same as RDP host"
              title="The hostname of the SSH/SFTP server to use for file transfer. If omitted, the RDP server hostname is used."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The port of the SSH/SFTP server. Defaults to 22.">SFTP Port</label>
            <input
              type="number"
              value={ex("sftp-port")}
              onChange={(e) => setEx("sftp-port", e.target.value)}
              placeholder="22"
              title="The port of the SSH/SFTP server. Defaults to 22."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The username to authenticate as when connecting to the SFTP server.">
              SFTP Username
            </label>
            <input
              value={ex("sftp-username")}
              onChange={(e) => setEx("sftp-username", e.target.value)}
              title="The username to authenticate as when connecting to the SFTP server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The password to use when authenticating with the SFTP server.">
              SFTP Password
            </label>
            <input
              type="password"
              value={ex("sftp-password")}
              onChange={(e) => setEx("sftp-password", e.target.value)}
              title="The password to use when authenticating with the SFTP server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The entire contents of the SSH private key to use when authenticating with the SFTP server, in OpenSSH format.">
              SFTP Private Key
            </label>
            <textarea
              value={ex("sftp-private-key")}
              onChange={(e) => setEx("sftp-private-key", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              title="The entire contents of the SSH private key to use when authenticating with the SFTP server, in OpenSSH format."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The passphrase to use to decrypt the SSH private key, if it is encrypted.">
              SFTP Passphrase
            </label>
            <input
              type="password"
              value={ex("sftp-passphrase")}
              onChange={(e) => setEx("sftp-passphrase", e.target.value)}
              title="The passphrase to use to decrypt the SSH private key, if it is encrypted."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The default location for file uploads. If not specified, the user's home directory will be used.">
              Default Upload Directory
            </label>
            <input
              value={ex("sftp-directory")}
              onChange={(e) => setEx("sftp-directory", e.target.value)}
              title="The default location for file uploads. If not specified, the user's home directory will be used."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The directory to expose to connected users via SFTP. If omitted, '/' will be used by default.">
              SFTP Root Directory
            </label>
            <input
              value={ex("sftp-root-directory")}
              onChange={(e) => setEx("sftp-root-directory", e.target.value)}
              placeholder="/"
              title="The directory to expose to connected users via SFTP. If omitted, '/' will be used by default."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Wake-on-LAN">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0">
            <label title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF.">
              MAC Address
            </label>
            <input
              value={ex("wol-mac-addr")}
              onChange={(e) => setEx("wol-mac-addr", e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The broadcast address to which the WoL magic packet should be sent. Defaults to 255.255.255.255 (local broadcast).">
              Broadcast Address
            </label>
            <input
              value={ex("wol-broadcast-addr")}
              onChange={(e) => setEx("wol-broadcast-addr", e.target.value)}
              placeholder="255.255.255.255"
              title="The broadcast address to which the WoL magic packet should be sent. Defaults to 255.255.255.255 (local broadcast)."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The UDP port to use when sending the WoL magic packet. Defaults to 9.">
              UDP Port
            </label>
            <input
              type="number"
              value={ex("wol-udp-port")}
              onChange={(e) => setEx("wol-udp-port", e.target.value)}
              placeholder="9"
              title="The UDP port to use when sending the WoL magic packet. Defaults to 9."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The number of seconds to wait after sending the WoL magic packet before attempting the connection.">
              Wait Time (seconds)
            </label>
            <input
              type="number"
              value={ex("wol-wait-time")}
              onChange={(e) => setEx("wol-wait-time", e.target.value)}
              placeholder="0"
              title="The number of seconds to wait after sending the WoL magic packet before attempting the connection."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Kerberos / NLA">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The authentication package to use for Network Level Authentication (NLA).">
              Auth Package
            </label>
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
          </div>
          {ex("auth-pkg") === "kerberos" && (
            <>
              <div className="form-group !mb-0">
                <label title="The URL of the Kerberos Key Distribution Center (KDC) to use for obtaining Kerberos tickets. Only needed if not using the global Kerberos realm configuration.">
                  KDC URL
                </label>
                <input
                  value={ex("kdc-url")}
                  onChange={(e) => setEx("kdc-url", e.target.value)}
                  placeholder="kdc.example.com"
                  title="The URL of the Kerberos Key Distribution Center (KDC). Leave blank to use the KDC from the matching Kerberos realm."
                />
              </div>
              <div className="form-group !mb-0">
                <label title="The file path for the Kerberos credential cache. The cache stores obtained tickets for reuse.">
                  Kerberos Cache Path
                </label>
                <input
                  value={ex("kerberos-cache")}
                  onChange={(e) => setEx("kerberos-cache", e.target.value)}
                  placeholder="/tmp/krb5cc_guacd"
                  title="The file path for the Kerberos credential cache. Leave blank for default."
                />
              </div>
            </>
          )}
        </FieldGrid>
        {(!ex("auth-pkg") || ex("auth-pkg") === "") && (
          <p className="text-xs text-zinc-400 mt-2">
            When set to <strong>Default (auto-detect)</strong>, the client and server negotiate the
            best authentication method via SPNEGO. Realms configured in the{" "}
            <strong>Kerberos</strong> tab are written to the shared{" "}
            <code className="text-zinc-300">krb5.conf</code> which guacd uses automatically —
            Kerberos-only servers will use Kerberos; servers that support NTLM will negotiate
            normally.
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
}: {
  ex: (k: string) => string;
  setEx: (k: string, v: string) => void;
}) {
  return (
    <>
      <Section title="Authentication" defaultOpen>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The entire contents of the SSH private key to use for public key authentication. Must be in OpenSSH format.">
              Private Key
            </label>
            <textarea
              value={ex("private-key")}
              onChange={(e) => setEx("private-key", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              title="The entire contents of the SSH private key to use for public key authentication. Must be in OpenSSH format."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The passphrase to use to decrypt the SSH private key, if it is encrypted.">
              Passphrase
            </label>
            <input
              type="password"
              value={ex("passphrase")}
              onChange={(e) => setEx("passphrase", e.target.value)}
              title="The passphrase to use to decrypt the SSH private key, if it is encrypted."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The known public key of the SSH server, in OpenSSH format. If provided, the server's identity will be verified against this key.">
              Host Key
            </label>
            <input
              value={ex("host-key")}
              onChange={(e) => setEx("host-key", e.target.value)}
              placeholder="Server public key (optional)"
              title="The known public key of the SSH server, in OpenSSH format. If provided, the server's identity will be verified against this key."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The color scheme to use for the terminal display.">Color Scheme</label>
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
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the font to use in the terminal. This must be a font available on the guacd server.">
              Font Name
            </label>
            <input
              value={ex("font-name")}
              onChange={(e) => setEx("font-name", e.target.value)}
              placeholder="monospace"
              title="The name of the font to use in the terminal. This must be a font available on the guacd server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The size of the font to use in the terminal, in points.">Font Size</label>
            <input
              type="number"
              value={ex("font-size")}
              onChange={(e) => setEx("font-size", e.target.value)}
              placeholder="12"
              title="The size of the font to use in the terminal, in points."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The maximum number of lines of terminal scrollback to allow. Each line requires additional memory. Defaults to 1000.">
              Scrollback (lines)
            </label>
            <input
              type="number"
              value={ex("scrollback")}
              onChange={(e) => setEx("scrollback", e.target.value)}
              placeholder="1000"
              title="The maximum number of lines of terminal scrollback to allow. Each line requires additional memory. Defaults to 1000."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0">
            <label title="The command to execute on the remote server upon connecting, instead of the default shell.">
              Command
            </label>
            <input
              value={ex("command")}
              onChange={(e) => setEx("command", e.target.value)}
              placeholder="Execute on connect"
              title="The command to execute on the remote server upon connecting, instead of the default shell."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The locale to use for the SSH session (e.g. en_US.UTF-8). Controls character encoding.">
              Locale
            </label>
            <input
              value={ex("locale")}
              onChange={(e) => setEx("locale", e.target.value)}
              placeholder="en_US.UTF-8"
              title="The locale to use for the SSH session (e.g. en_US.UTF-8). Controls character encoding."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The timezone to pass to the SSH server via the TZ environment variable, in IANA format (e.g. America/New_York).">
              Timezone
            </label>
            <Select
              value={ex("timezone")}
              onChange={(v) => setEx("timezone", v)}
              placeholder="System default"
              options={[
                { value: "", label: "System default" },
                ...getTimezones().map((tz) => ({ value: tz, label: tz })),
              ]}
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The terminal emulator type string to send to the SSH server (e.g. xterm-256color, vt100). This determines which escape sequences are supported.">
              Terminal Type
            </label>
            <input
              value={ex("terminal-type")}
              onChange={(e) => setEx("terminal-type", e.target.value)}
              placeholder="xterm-256color"
              title="The terminal emulator type string to send to the SSH server (e.g. xterm-256color, vt100). This determines which escape sequences are supported."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The interval in seconds at which to send keepalive packets to the SSH server. Set to 0 to disable. Useful for preventing idle timeouts.">
              Server Alive Interval
            </label>
            <input
              type="number"
              value={ex("server-alive-interval")}
              onChange={(e) => setEx("server-alive-interval", e.target.value)}
              placeholder="0"
              title="The interval in seconds at which to send keepalive packets to the SSH server. Set to 0 to disable. Useful for preventing idle timeouts."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="SFTP">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0">
            <label title="The root directory to expose to connected users via SFTP. If omitted, '/' will be used.">
              SFTP Root Directory
            </label>
            <input
              value={ex("sftp-root-directory")}
              onChange={(e) => setEx("sftp-root-directory", e.target.value)}
              placeholder="/"
              title="The root directory to expose to connected users via SFTP. If omitted, '/' will be used."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0">
            <label title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF.">
              MAC Address
            </label>
            <input
              value={ex("wol-mac-addr")}
              onChange={(e) => setEx("wol-mac-addr", e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              title="The MAC address of the remote host to wake, in the format AA:BB:CC:DD:EE:FF."
            />
          </div>
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
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label title="The password to use when connecting to the VNC server.">Password</label>
            <input
              type="password"
              value={ex("password")}
              onChange={(e) => setEx("password", e.target.value)}
              title="The password to use when connecting to the VNC server."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label title="The color depth to request from the VNC server, in bits per pixel.">
              Color Depth
            </label>
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
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label title="Controls how the mouse cursor is displayed. 'Local' renders the cursor on the client for performance. 'Remote' shows the VNC server's cursor.">
              Cursor
            </label>
            <Select
              value={ex("cursor")}
              onChange={(v) => setEx("cursor", v)}
              placeholder="Local"
              options={[
                { value: "", label: "Local" },
                { value: "remote", label: "Remote" },
              ]}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
// Xvnc display and tunnels it through guacd as a standard VNC
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

  // Trusted CA picker — populated lazily so the widget shows up
  // even if the user lacks Manage System (the slim picker route is
  // open to any authenticated user). Failures are silenced because
  // an empty list simply hides the dropdown.
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

  return (
    <>
      <Section title="Target URL" defaultOpen>
        <FieldGrid>
          <div className="form-group !mb-0 col-span-2">
            <label title="The URL the kiosk Chromium instance navigates to when the session starts. Must include the scheme (https://...). Subject to the allowed-domains and server-side egress allow-list (system_settings.web_allowed_networks).">
              Initial URL
            </label>
            <input
              value={ex("url")}
              onChange={(e) => setEx("url", e.target.value)}
              placeholder="https://app.example.com/login"
              type="url"
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Domain Allow-list">
        <p className="text-xs opacity-60 mb-2">
          Hostnames the kiosk Chromium is permitted to resolve. Leave empty to allow any host that
          passes the server-side egress check. Wildcards like <code>*.example.com</code>
          are honoured by Chromium&apos;s <code>--host-rules</code>.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0 col-span-2">
            <label>Allowed Domains (one per line or comma-separated)</label>
            <textarea
              value={allowedDomains.join("\n")}
              onChange={(e) =>
                setAllowedDomains(e.target.value.split(/[\n,]/).map((s) => s.trim()))
              }
              rows={4}
              placeholder={"example.com\n*.example.com\nauth.okta.com"}
              className="font-mono text-sm"
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Login Automation">
        <p className="text-xs opacity-60 mb-2">
          Optionally run a registered server-side script over Chrome DevTools Protocol after the
          page loads. Scripts are administered separately and reference by name to keep connection
          rows compact and auditable.
        </p>
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="Identifier of a registered login script. Leave blank for no automation.">
              Login Script
            </label>
            <input
              value={ex("login_script")}
              onChange={(e) => setEx("login_script", e.target.value)}
              placeholder="okta-saml"
            />
          </div>
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
          <div className="form-group !mb-0 col-span-2">
            <label>Trusted CA</label>
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
          </div>
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
// xrdp on port 3389 and tunnels it through guacd as a standard RDP
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
          <div className="form-group !mb-0 col-span-2">
            <label title="The Docker image used to spawn the desktop container. The list is restricted to images whitelisted by the operator under Admin → System Settings.">
              Image
            </label>
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
          </div>
        </FieldGrid>
      </Section>

      <Section title="Resource Limits">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="Maximum CPU cores the container can use (Docker --cpus). Leave blank for unbounded.">
              CPU Limit (cores)
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={ex("cpu_limit")}
              onChange={(e) => setEx("cpu_limit", e.target.value)}
              placeholder="2.0"
            />
          </div>
          <div className="form-group !mb-0">
            <label title="Maximum memory the container can use, in megabytes (Docker --memory). Leave blank for unbounded.">
              Memory Limit (MB)
            </label>
            <input
              type="number"
              min="0"
              value={ex("memory_limit_mb")}
              onChange={(e) => setEx("memory_limit_mb", e.target.value)}
              placeholder="4096"
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="Lifecycle">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="Minutes of inactivity after which the reaper destroys the container. Defaults to 30 when blank.">
              Idle Timeout (minutes)
            </label>
            <input
              type="number"
              min="1"
              value={ex("idle_timeout_mins")}
              onChange={(e) => setEx("idle_timeout_mins", e.target.value)}
              placeholder="30"
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0">
            <label title="The name of the pod to attach or exec into. Required.">
              Pod Name <span className="text-red-500">*</span>
            </label>
            <input
              value={ex("pod")}
              onChange={(e) => setEx("pod", e.target.value)}
              placeholder="my-pod-abc123"
              title="The name of the pod to attach or exec into. Required."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The Kubernetes namespace containing the pod. Defaults to 'default'.">
              Namespace
            </label>
            <input
              value={ex("namespace")}
              onChange={(e) => setEx("namespace", e.target.value)}
              placeholder="default"
              title="The Kubernetes namespace containing the pod. Defaults to 'default'."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The container within the pod to attach to. Required only if the pod has more than one container.">
              Container
            </label>
            <input
              value={ex("container")}
              onChange={(e) => setEx("container", e.target.value)}
              placeholder="(default container)"
              title="The container within the pod to attach to. Required only if the pod has more than one container."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="If set, runs `kubectl exec` with this command instead of `kubectl attach`. Leave blank to attach to the container's existing console.">
              Exec Command
            </label>
            <input
              value={ex("exec-command")}
              onChange={(e) => setEx("exec-command", e.target.value)}
              placeholder="(blank = attach)"
              title="If set, runs `kubectl exec` with this command instead of `kubectl attach`. Leave blank to attach to the container's existing console."
            />
          </div>
        </FieldGrid>
      </Section>

      <Section title="TLS">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
          <div className="form-group !mb-0 col-span-full">
            <label title="PEM-encoded CA certificate the API server's certificate chains to. Paste the contents of your kubeconfig's certificate-authority-data (base64-decoded) or the cluster CA file.">
              Cluster CA Certificate (PEM)
            </label>
            <textarea
              value={ex("ca-cert")}
              onChange={(e) => setEx("ca-cert", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              placeholder="-----BEGIN CERTIFICATE-----"
              title="PEM-encoded CA certificate the API server's certificate chains to."
            />
          </div>
          <div className="form-group !mb-0 col-span-full">
            <label title="PEM-encoded client certificate for mTLS authentication. Paired with the client-key stored in the connection's credential profile.">
              Client Certificate (PEM)
            </label>
            <textarea
              value={ex("client-cert")}
              onChange={(e) => setEx("client-cert", e.target.value)}
              rows={3}
              className="font-mono text-[0.8rem]"
              placeholder="-----BEGIN CERTIFICATE-----"
              title="PEM-encoded client certificate. The matching private key is stored in the credential profile."
            />
          </div>
        </FieldGrid>
        <p className="text-xs text-txt-tertiary mt-2">
          The client <em>private key</em> is stored separately in this connection's credential
          profile (encrypted via Vault Transit) and is never written to the connections table.
        </p>
      </Section>

      <Section title="Display">
        <FieldGrid>
          <div className="form-group !mb-0">
            <label title="The color scheme to use for the terminal display.">Color Scheme</label>
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
          </div>
          <div className="form-group !mb-0">
            <label title="The name of the font to use in the terminal. Must be available on the guacd server.">
              Font Name
            </label>
            <input
              value={ex("font-name")}
              onChange={(e) => setEx("font-name", e.target.value)}
              placeholder="monospace"
              title="The name of the font to use in the terminal. Must be available on the guacd server."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The size of the font to use in the terminal, in points.">Font Size</label>
            <input
              type="number"
              value={ex("font-size")}
              onChange={(e) => setEx("font-size", e.target.value)}
              placeholder="12"
              title="The size of the font to use in the terminal, in points."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The maximum number of lines of terminal scrollback. Defaults to 1000.">
              Scrollback (lines)
            </label>
            <input
              type="number"
              value={ex("scrollback")}
              onChange={(e) => setEx("scrollback", e.target.value)}
              placeholder="1000"
              title="The maximum number of lines of terminal scrollback. Defaults to 1000."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="The terminal emulator type string passed to the pod via the TERM environment variable. Defaults to xterm-256color.">
              Terminal Type
            </label>
            <input
              value={ex("terminal-type")}
              onChange={(e) => setEx("terminal-type", e.target.value)}
              placeholder="xterm-256color"
              title="The terminal emulator type string passed to the pod via the TERM environment variable. Defaults to xterm-256color."
            />
          </div>
          <div className="form-group !mb-0">
            <label title="ASCII code sent when the Backspace key is pressed. 127 = Delete (default), 8 = Backspace. Change only if Backspace produces ^? or ^H instead of erasing.">
              Backspace Key Code
            </label>
            <input
              type="number"
              value={ex("backspace")}
              onChange={(e) => setEx("backspace", e.target.value)}
              placeholder="127"
              title="ASCII code sent when the Backspace key is pressed. 127 = Delete (default), 8 = Backspace."
            />
          </div>
          <div className="form-group !mb-0">
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
            <label>&nbsp;</label>
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
