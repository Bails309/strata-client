import { useEffect, useRef, useState } from "react";
import type { RemoteCursor, ChatMessage } from "./useCoPilotRoom";
import type { RosterEntry } from "./protocol";

interface CoPilotOverlayProps {
  roster: RosterEntry[];
  cursors: Map<string, RemoteCursor>;
  chat: ChatMessage[];
  allowChat: boolean;
  hasInput: boolean;
  selfPid: string | null;
  /**
   * `true` when the local participant is the session owner. Unlocks
   * the per-row force-grant control in the roster strip.
   */
  selfIsOwner?: boolean;
  onClaimInput: () => void;
  onReleaseInput: () => void;
  onSendChat: (text: string) => boolean;
  /**
   * Owner-only force-grant callback. Invoked with the target pid when
   * the owner clicks "Give control" on a roster row. Ignored when
   * `selfIsOwner` is `false`.
   */
  onForceGrant?: (pid: string) => void;
  /**
   * `true` once the room exposes a WebRTC audio mesh AND the local
   * user has opted in. When defined together with `onToggleAudio`,
   * the overlay renders a Join/Leave audio button next to the chat
   * toggle. Without `onToggleAudio` the audio button is hidden.
   */
  audioJoined?: boolean;
  /** Toggle handler for the Join/Leave audio button. */
  onToggleAudio?: () => void;
  /**
   * Pixel scale of the underlying display element. Cursors arrive in
   * display-space coordinates; we multiply by this scale to project
   * them onto the rendered canvas.
   */
  displayScale: number;
}

/**
 * Renders the multiplayer chrome: peer cursors layered over the
 * display, a roster strip with input-token affordance, and an
 * optional collapsible chat panel.
 */
export default function CoPilotOverlay({
  roster,
  cursors,
  chat,
  allowChat,
  hasInput,
  selfPid,
  selfIsOwner = false,
  onClaimInput,
  onReleaseInput,
  onSendChat,
  onForceGrant,
  audioJoined = false,
  onToggleAudio,
  displayScale,
}: CoPilotOverlayProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const rosterByPid = new Map(roster.map((r) => [r.pid, r]));

  useEffect(() => {
    if (chatOpen && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatOpen, chat.length]);

  const onChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSendChat(draft)) setDraft("");
  };

  return (
    <>
      {/* Remote cursors */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 8,
          overflow: "hidden",
        }}
      >
        {Array.from(cursors.values()).map((c) => {
          const peer = rosterByPid.get(c.pid);
          if (!peer) return null;
          return (
            <div
              key={c.pid}
              style={{
                position: "absolute",
                left: c.x * displayScale,
                top: c.y * displayScale,
                transform: "translate(-2px, -2px)",
                transition: "left 60ms linear, top 60ms linear",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill={peer.color}>
                <path d="M3 3l7 18 2.5-7.5L20 11z" />
              </svg>
              <div
                style={{
                  marginLeft: 14,
                  marginTop: -4,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: peer.color,
                  color: "#fff",
                  fontSize: "0.7rem",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  display: "inline-block",
                }}
              >
                {peer.display_name}
              </div>
            </div>
          );
        })}
      </div>

      {/* Roster strip */}
      <div
        style={{
          position: "absolute",
          top: 36,
          right: 12,
          zIndex: 11,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: 8,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(6px)",
          borderRadius: 8,
          maxWidth: 240,
          fontSize: "0.75rem",
          color: "#eee",
        }}
        aria-label="Multiplayer roster"
      >
        <div style={{ fontWeight: 600, letterSpacing: 0.5, opacity: 0.7 }}>
          PARTICIPANTS ({roster.length})
        </div>
        {roster.map((p) => (
          <div key={p.pid} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: p.color,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.display_name}
              {p.pid === selfPid ? " (you)" : ""}
              {p.is_owner ? " ★" : ""}
            </span>
            {p.has_input && (
              <span
                title="Currently controlling"
                style={{
                  fontSize: "0.65rem",
                  padding: "1px 4px",
                  borderRadius: 3,
                  background: "#10b981",
                  color: "#fff",
                }}
              >
                CTRL
              </span>
            )}
            {selfIsOwner && p.pid !== selfPid && !p.has_input && onForceGrant && (
              <button
                type="button"
                onClick={() => onForceGrant(p.pid)}
                title="Give input control to this participant"
                style={{
                  fontSize: "0.65rem",
                  padding: "1px 6px",
                  borderRadius: 3,
                  background: "#3b82f6",
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Give
              </button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          {hasInput ? (
            <button type="button" onClick={onReleaseInput} style={smallBtn("#ef4444")}>
              Release control
            </button>
          ) : (
            <button type="button" onClick={onClaimInput} style={smallBtn("#3b82f6")}>
              Take control
            </button>
          )}
          {allowChat && (
            <button
              type="button"
              onClick={() => setChatOpen((v) => !v)}
              style={smallBtn("#6b7280")}
            >
              {chatOpen ? "Hide chat" : "Chat"}
            </button>
          )}
          {onToggleAudio && (
            <button
              type="button"
              onClick={onToggleAudio}
              style={smallBtn(audioJoined ? "#ef4444" : "#10b981")}
              title={audioJoined ? "Leave voice chat" : "Join voice chat"}
            >
              {audioJoined ? "Leave audio" : "Join audio"}
            </button>
          )}
        </div>
      </div>

      {/* Chat panel */}
      {chatOpen && allowChat && (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            right: 12,
            zIndex: 11,
            width: 280,
            maxHeight: 320,
            display: "flex",
            flexDirection: "column",
            background: "rgba(0,0,0,0.65)",
            backdropFilter: "blur(6px)",
            borderRadius: 8,
            color: "#eee",
            fontSize: "0.8rem",
          }}
          aria-label="Multiplayer chat"
        >
          <div
            ref={chatScrollRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 8,
              minHeight: 80,
              maxHeight: 240,
            }}
          >
            {chat.length === 0 && (
              <div style={{ opacity: 0.6, textAlign: "center", padding: 12 }}>No messages yet.</div>
            )}
            {chat.map((m) => {
              const peer = rosterByPid.get(m.pid);
              return (
                <div key={m.id} style={{ marginBottom: 6 }}>
                  <span style={{ color: peer?.color ?? "#aaa", fontWeight: 600 }}>
                    {peer?.display_name ?? "?"}
                  </span>
                  <span style={{ opacity: 0.5, marginLeft: 6, fontSize: "0.7rem" }}>
                    {new Date(m.ts).toLocaleTimeString()}
                  </span>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text}</div>
                </div>
              );
            })}
          </div>
          <form
            onSubmit={onChatSubmit}
            style={{ display: "flex", gap: 4, padding: 6, borderTop: "1px solid #333" }}
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={500}
              placeholder="Type a message…"
              aria-label="Chat message"
              style={{
                flex: 1,
                padding: "4px 6px",
                fontSize: "0.8rem",
                background: "#111",
                border: "1px solid #333",
                borderRadius: 4,
                color: "#eee",
              }}
            />
            <button type="submit" style={smallBtn("#10b981")}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}

function smallBtn(bg: string): React.CSSProperties {
  return {
    padding: "3px 8px",
    fontSize: "0.7rem",
    fontWeight: 500,
    background: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
  };
}
