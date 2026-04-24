import { useState, useCallback, useEffect, useRef } from "react";
import Guacamole from "guacamole-common-js";
import { GuacSession } from "./SessionManager";
import FileBrowser from "./FileBrowser";

interface Props {
  session: GuacSession;
  isOpen: boolean;
  onClose: () => void;
  shareUrl: string | null;
  onShare: () => void;
  sharingEnabled: boolean;
}

type Panel = "menu" | "filebrowser";

/**
 * Slide-out session menu panel (Ctrl+Alt+Shift).
 * Contains: clipboard sync, file browser, sharing, disconnect.
 */
export default function SessionMenu({
  session,
  isOpen,
  onClose,
  shareUrl,
  onShare,
  sharingEnabled,
}: Props) {
  const [panel, setPanel] = useState<Panel>("menu");
  const [activeFsIndex, setActiveFsIndex] = useState<number | null>(null);
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardVisible, setClipboardVisible] = useState(false);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Sync remote clipboard text when menu opens
  useEffect(() => {
    if (isOpen) {
      setClipboardText(session.remoteClipboard || "");
      setClipboardVisible(false);
      setPanel("menu");
    }
  }, [isOpen, session.remoteClipboard]);

  // Push clipboard changes to remote
  const handleClipboardChange = useCallback(
    (text: string) => {
      setClipboardText(text);
      // Debounce the send
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = setTimeout(() => {
        const stream = session.client.createClipboardStream("text/plain");
        const writer = new Guacamole.StringWriter(stream);
        writer.sendText(text);
        writer.sendEnd();
        session.remoteClipboard = text;
      }, 300);
    },
    [session]
  );

  const copyShareUrl = useCallback(() => {
    if (shareUrl) {
      navigator.clipboard?.writeText(shareUrl).catch(() => {});
    }
  }, [shareUrl]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        bottom: 0,
        width: 300,
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        background: "var(--color-surface)",
        borderRight: "1px solid var(--color-border)",
        boxShadow: "4px 0 16px rgba(0,0,0,0.3)",
        overflow: "hidden",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface-secondary)",
          flexShrink: 0,
        }}
      >
        <span className="text-[0.8125rem] font-semibold">{session.name}</span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--color-txt-secondary)",
            padding: 2,
            lineHeight: 0,
          }}
          title="Close menu (Ctrl+Alt+Shift)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content area */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {panel === "menu" ? (
          <>
            {/* ── Clipboard ── */}
            <section>
              <div className="text-[0.7rem] uppercase text-txt-tertiary font-semibold tracking-wide mb-1">
                Clipboard
              </div>
              <p className="text-[0.7rem] text-txt-tertiary mb-2">
                Text copied within the remote session appears here. Changes below will affect the
                remote clipboard.
              </p>
              {!clipboardVisible ? (
                <button
                  className="btn-sm w-full"
                  style={{ justifyContent: "center", fontSize: "0.75rem" }}
                  onClick={() => {
                    setClipboardVisible(true);
                    // Also read local clipboard
                    navigator.clipboard
                      ?.readText()
                      .then((t) => {
                        if (t) setClipboardText(t);
                      })
                      .catch(() => {});
                  }}
                >
                  Click to view clipboard contents
                </button>
              ) : (
                <textarea
                  value={clipboardText}
                  onChange={(e) => handleClipboardChange(e.target.value)}
                  rows={4}
                  style={{
                    width: "100%",
                    resize: "vertical",
                    fontSize: "0.75rem",
                    fontFamily: "monospace",
                    padding: 8,
                    borderRadius: 4,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-input-bg)",
                    color: "var(--color-txt-primary)",
                  }}
                />
              )}
            </section>

            {/* ── File Transfer ── */}
            {session.fileTransferEnabled && session.filesystems.length > 0 && (
              <section>
                <div className="text-[0.7rem] uppercase text-txt-tertiary font-semibold tracking-wide mb-1">
                  File Transfer
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {session.filesystems.map((fs, i) => (
                    <button
                      key={i}
                      className="btn-sm w-full"
                      style={{ justifyContent: "flex-start", fontSize: "0.75rem" }}
                      onClick={() => {
                        setActiveFsIndex(i);
                        setPanel("filebrowser");
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                      </svg>
                      {fs.name}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* ── Drag/drop hint ── */}
            <section>
              <p className="text-[0.7rem] text-txt-tertiary">
                You can also drag and drop files onto the session view to upload them.
              </p>
            </section>

            {/* ── Share ── */}
            {sharingEnabled && (
              <section>
                <div className="text-[0.7rem] uppercase text-txt-tertiary font-semibold tracking-wide mb-1">
                  Sharing
                </div>
                {shareUrl ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <p className="text-[0.7rem] text-txt-tertiary">
                      Share this link to grant temporary view access. The link expires when you
                      disconnect.
                    </p>
                    <div
                      style={{
                        display: "flex",
                        gap: 4,
                        alignItems: "stretch",
                      }}
                    >
                      <input
                        type="text"
                        readOnly
                        value={shareUrl}
                        style={{
                          flex: 1,
                          fontSize: "0.7rem",
                          fontFamily: "monospace",
                          padding: "4px 8px",
                          borderRadius: 4,
                          border: "1px solid var(--color-border)",
                          background: "var(--color-input-bg)",
                          color: "var(--color-txt-primary)",
                        }}
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        className="btn-sm"
                        style={{ padding: "4px 8px", flexShrink: 0 }}
                        onClick={copyShareUrl}
                        title="Copy link"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="btn-sm-primary w-full"
                    style={{ justifyContent: "center", fontSize: "0.75rem" }}
                    onClick={onShare}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="18" cy="5" r="3" />
                      <circle cx="6" cy="12" r="3" />
                      <circle cx="18" cy="19" r="3" />
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                    </svg>
                    Share this Connection
                  </button>
                )}
              </section>
            )}

            {/* ── Keyboard shortcut hint ── */}
            <div
              className="text-[0.65rem] text-txt-tertiary mt-auto pt-4 text-center"
              style={{ opacity: 0.6 }}
            >
              Press{" "}
              <kbd
                style={{
                  padding: "1px 5px",
                  borderRadius: 3,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface-secondary)",
                  fontSize: "0.6rem",
                }}
              >
                Ctrl+Alt+Shift
              </kbd>{" "}
              to toggle this menu
            </div>
          </>
        ) : (
          /* ── File Browser Panel ── */
          activeFsIndex !== null &&
          session.filesystems[activeFsIndex] && (
            <FileBrowser
              filesystem={session.filesystems[activeFsIndex]}
              onClose={() => setPanel("menu")}
            />
          )
        )}
      </div>
    </div>
  );
}
