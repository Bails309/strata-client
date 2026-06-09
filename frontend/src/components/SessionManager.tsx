/* eslint-disable react-hooks/refs, react-hooks/immutability --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import Guacamole from "guacamole-common-js";
import { preparePastePayload } from "./pastePayload";
import { notifySessionActivity } from "./sessionActivity";
import { submitOutboundShare } from "../api";
import { useOptionalToast } from "./ToastProvider";
export interface GuacSession {
  id: string; // connection UUID
  connectionId: string;
  name: string;
  protocol: string;
  client: Guacamole.Client;
  tunnel: Guacamole.Tunnel;
  displayEl: HTMLElement;
  keyboard: Guacamole.Keyboard;
  /** Timestamp when the session was created */
  createdAt: number;
  /** Last known error, if any */
  error?: string;
  /** Filesystem objects exposed by guacd (RDP drive, SFTP, etc.) */
  filesystems: { object: Guacamole.GuacObject; name: string }[];
  /** Remote clipboard text (last received from the session) */
  remoteClipboard: string;
  /**
   * Justification text to attach to the *next* outbound-share file
   * intercepted from this session. Set by the user via the
   * QuickShareOutbound panel; consumed (and cleared) by
   * `client.onfile` when an outbound file arrives.
   */
  pendingOutboundJustification?: string;
  /** Cleanup function for paste event listener */
  _cleanupPaste?: () => void;
  /** Pop-out state and actions */
  isPoppedOut?: boolean;
  popOut?: () => void;
  popIn?: () => void;
  /** Whether multi-monitor mode is active */
  isMultiMonitor?: boolean;
  /** Whether drive/SFTP file transfer is enabled on the connection */
  fileTransferEnabled?: boolean;
  /** Number of screens detected by the Window Management API */
  screenCount?: number;
  enableMultiMonitor?: () => void | Promise<void>;
  disableMultiMonitor?: () => void;
  /** Internal pop-out window refs — persists across SessionClient mount/unmount */
  _popout?: {
    window: Window;
    keyboard: Guacamole.Keyboard;
    mouse: Guacamole.Mouse;
    touch: Guacamole.Mouse.Touchscreen;
    cleanup: () => void;
  };
  /** Internal multi-monitor state — persists across SessionClient mount/unmount */
  _multiMonitor?: {
    windows: Window[];
    cleanup: () => void;
  };
  // ── Multiplayer / co-pilot share state (v1.10.3+) ──────────────────
  // When the owner generates a multiplayer share via the SessionBar
  // popover, the share token and per-share toggles are stashed here so
  // SessionClient.tsx can mount the owner-side CoPilotOverlay over this
  // session's display. Cleared by revokeShareLink and on session close.
  /** Active multiplayer share token (the owner's own). `undefined` when no multiplayer share is live. */
  mpShareToken?: string;
  /** Mirror of the toggle that produced `mpShareToken`. Owner-side overlay only mounts when both this and `mpShareToken` are set. */
  mpEnabled?: boolean;
  /** Whether the share permits the in-room chat panel. */
  mpAllowChat?: boolean;
  /** Whether the share permits WebRTC audio (Commit C wires the actual mesh). */
  mpAllowAudio?: boolean;
  /** Max participants the room will accept (incl. the owner). 2..=6. */
  mpMaxParticipants?: number;
}

interface SessionManagerValue {
  sessions: GuacSession[];
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  createSession: (opts: CreateSessionOpts) => GuacSession;
  closeSession: (id: string) => void;
  getSession: (connectionId: string) => GuacSession | undefined;
  /**
   * Partially update fields on a session in-place. Mutates the existing
   * `GuacSession` object (so live `client`/`tunnel` refs stay valid) and
   * triggers a re-render via `setSessions(prev => [...prev])`. Used by
   * the SessionBar share popover to attach multiplayer share metadata
   * to the owning session, and by future cleanup paths to clear it.
   */
  updateSession: (id: string, partial: Partial<GuacSession>) => void;
  /** IDs of sessions displayed in the tiled view (empty = single-session mode) */
  tiledSessionIds: string[];
  setTiledSessionIds: (ids: string[]) => void;
  /** IDs of sessions that currently receive keyboard input */
  focusedSessionIds: string[];
  setFocusedSessionIds: (ids: string[]) => void;
  /** Session bar (right sidebar) layout state */
  sessionBarCollapsed: boolean;
  setSessionBarCollapsed: (collapsed: boolean) => void;
  barWidth: number;
  canShare: boolean;
  canUseQuickShare: boolean;
  canUseQuickShareOutbound: boolean;
  /** Per-user outbound Quick-Share approval-bypass flag.
   *  `true` → user has the bypass (auto-approved, no justification
   *  needed). `false` → user must include a justification on every
   *  outbound submission. Mirrors `MeResponse.outbound_share_requires_approval === false`
   *  in `App.tsx`. */
  outboundShareBypass: boolean;
}

interface CreateSessionOpts {
  connectionId: string;
  name: string;
  protocol: string;
  containerEl: HTMLElement;
  connectParams: URLSearchParams;
}

const SessionManagerContext = createContext<SessionManagerValue | null>(null);

// ── Module-level handler registry ──────────────────────────────────
// `App.tsx`'s handleLogout lives outside SessionManagerProvider but needs to
// tear down active sessions when the user logs out (manual or idle timeout).
// The provider registers `closeAllSessions` here on mount; non-React code
// can invoke it via `closeAllSessionsExternal()`.
let _closeAllSessionsHandler: (() => void) | null = null;

function setCloseAllSessionsHandler(handler: (() => void) | null): void {
  _closeAllSessionsHandler = handler;
}

export function closeAllSessionsExternal(): void {
  _closeAllSessionsHandler?.();
}

// ── Byte-size formatter for upload progress toasts ──────────────────
// Compact `1.2 MB` / `847 KB` style \u2014 not localised, because the
// numbers appear inline in English progress copy and we want a
// stable monospace-ish width. Negative / NaN safely fall back to
// `"0 B"` so a transient onprogress event with bogus values can't
// break the toast.
function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(mib < 10 ? 1 : 0)} MB`;
  const gib = mib / 1024;
  return `${gib.toFixed(gib < 10 ? 2 : 1)} GB`;
}

export function useSessionManager() {
  const ctx = useContext(SessionManagerContext);
  if (!ctx) throw new Error("useSessionManager must be used within SessionManagerProvider");
  return ctx;
}

export function SessionManagerProvider({
  children,
  canShare = false,
  canUseQuickShare = false,
  canUseQuickShareOutbound = false,
  outboundShareBypass = false,
}: {
  children: React.ReactNode;
  canShare?: boolean;
  canUseQuickShare?: boolean;
  canUseQuickShareOutbound?: boolean;
  outboundShareBypass?: boolean;
}) {
  const [sessions, setSessions] = useState<GuacSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [tiledSessionIds, setTiledSessionIds] = useState<string[]>([]);
  const [focusedSessionIds, setFocusedSessionIds] = useState<string[]>([]);
  // Default to collapsed so users get the maximum visible session canvas on
  // first load. The user can expand the bar by clicking the tab; the choice
  // is intentionally not persisted (re-collapses on every page load).
  const [sessionBarCollapsed, setSessionBarCollapsed] = useState(true);
  const sessionsRef = useRef<GuacSession[]>([]);
  const toast = useOptionalToast();

  // Keep a live ref so the `client.onfile` closure (captured at session
  // create-time) can read the *current* permission rather than the value
  // that was true when the session was opened.
  const canUseQuickShareOutboundRef = useRef<boolean>(canUseQuickShareOutbound);
  canUseQuickShareOutboundRef.current = canUseQuickShareOutbound;

  // Same pattern for the per-user approval bypass: the closure that
  // intercepts drive-redirected files needs to see today's value, not
  // the snapshot from when the session was opened. When the bypass is
  // off, the closure refuses to POST without a justification — the
  // backend rejects it too (`validate_outbound_justification`), but
  // catching it client-side gives the user an actionable toast instead
  // of a generic "upload failed".
  const outboundShareBypassRef = useRef<boolean>(outboundShareBypass);
  outboundShareBypassRef.current = outboundShareBypass;

  const barWidth = 0; // Floating overlay doesn't reserve space

  // Keep ref in sync
  sessionsRef.current = sessions;

  /** Tear down a session's pop-out window, if any. */
  const cleanupPopout = useCallback((session: GuacSession) => {
    if (!session._popout) return;
    const po = session._popout;
    po.cleanup();
    po.keyboard.onkeydown = null;
    po.keyboard.onkeyup = null;
    po.keyboard.reset();
    po.mouse.onmousedown = null;
    po.mouse.onmouseup = null;
    po.mouse.onmousemove = null;
    po.touch.onmousedown = null;
    po.touch.onmouseup = null;
    po.touch.onmousemove = null;
    if (!po.window.closed) {
      try {
        po.window.close();
      } catch {
        /* ignore */
      }
    }
    session._popout = undefined;
    session.isPoppedOut = false;
  }, []);

  /** Tear down a session's multi-monitor windows, if any. */
  const cleanupMultiMonitor = useCallback((session: GuacSession) => {
    if (!session._multiMonitor) return;
    session._multiMonitor.cleanup();
    session._multiMonitor = undefined;
    session.isMultiMonitor = false;
  }, []);

  const getSession = useCallback((connectionId: string) => {
    return sessionsRef.current.find((s) => s.connectionId === connectionId);
  }, []);

  const createSession = useCallback((opts: CreateSessionOpts): GuacSession => {
    // If session already exists for this connection, return it
    const existing = sessionsRef.current.find((s) => s.connectionId === opts.connectionId);
    if (existing) return existing;

    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/api/tunnel/${opts.connectionId}`;

    const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
    // Extend the client-side receive watchdog from the upstream default of
    // 15 s to 30 s. The vendored guacamole-common-js fires `socket.close()`
    // with no args when no inbound frame arrives within `receiveTimeout` ms,
    // which the backend logs as `WebSocket closed by client: None`. Brief
    // backend stalls (e.g. NVR ring-buffer lock contention when a guest joins
    // a multiplayer share) can exceed 15 s; 30 s gives the system room to
    // recover before tearing the host tunnel down. The Guacamole-level ping
    // (every 500 ms) is unchanged so a truly dead server is still detected
    // quickly by the keepalive on the backend side.
    tunnel.receiveTimeout = 30000;
    const client = new Guacamole.Client(tunnel);
    const display = client.getDisplay();
    const displayEl = display.getElement();
    displayEl.style.background = "#000";

    // ── Remote cursor rendering (1.6.0 compatibility) ──
    // guacamole-common-js 1.6.0 stopped setting CSS `cursor: url(...)` on the
    // display element and instead renders the cursor as a software canvas
    // layer that only becomes visible when the server pushes a "mouse"
    // instruction. RDP doesn't push that for the local user, so the cursor
    // would be invisible. Hook `oncursor` to convert the cursor canvas into a
    // CSS data-URL cursor — restores 1.5.0 behaviour, lets the OS pointer
    // render the remote cursor, and keeps the existing multi-monitor
    // MutationObserver-based cursor mirroring working.
    display.oncursor = (canvas: HTMLCanvasElement, hotspotX: number, hotspotY: number) => {
      try {
        const url = canvas.toDataURL("image/png");
        displayEl.style.cursor = `url(${url}) ${hotspotX} ${hotspotY}, default`;
      } catch {
        /* canvas may be tainted in unusual cases — fall back silently */
      }
    };

    // Suppress 1.6.0's software-rendered cursor canvas layer. It gets
    // appended to the display element on every server-side `mouse`
    // instruction (see vendor.js handleMouse → display.showCursor(true)),
    // which stacks on top of our CSS data-URL cursor and produces ghost
    // cursors. Force-detach the cursor element and no-op `showCursor`
    // so the only visible pointer is the OS/CSS one.
    try {
      const cursorLayer = display.getCursorLayer?.();
      const cursorEl = cursorLayer?.getElement?.();
      cursorEl?.parentNode?.removeChild(cursorEl);
    } catch {
      /* defensive — older builds may not expose getCursorLayer */
    }
    display.showCursor = () => {
      /* no-op: rendered via CSS in oncursor above */
    };

    // Mouse
    const mouse = new Guacamole.Mouse(displayEl);
    mouse.onEach(["mousedown", "mouseup", "mousemove"], (e: Guacamole.Mouse.Event) => {
      client.sendMouseState(e.state, true);
      // Mouse events on the Guacamole canvas are hijacked by the vendor
      // library (preventDefault + stopPropagation) and never bubble to
      // window-level "is the user active?" listeners. Notify the
      // activity bus directly so SessionTimeoutWarning's proactive
      // refresh fires while the user is actively using a session.
      notifySessionActivity();
    });

    // Release any held mouse buttons when the cursor leaves the canvas or
    // the window loses focus. Without this, a mousedown on the canvas
    // followed by a mouseup outside the document (on browser chrome, a
    // popped-out devtools window, or another tab during drag) is never
    // delivered to us — guacd then thinks the button is still held, and
    // the next mousemove (e.g. moving the cursor toward the tab strip)
    // extends a phantom text selection across the SSH terminal.
    const releaseMouseButtons = () => {
      const s = mouse.currentState;
      if (s.left || s.middle || s.right) {
        s.left = false;
        s.middle = false;
        s.right = false;
        client.sendMouseState(s, true);
      }
    };
    displayEl.addEventListener("mouseleave", releaseMouseButtons);
    window.addEventListener("blur", releaseMouseButtons);

    // Touch
    const touch = new Guacamole.Mouse.Touchscreen(displayEl);
    touch.onEach(["mousedown", "mouseup", "mousemove"], (e: Guacamole.Mouse.Event) => {
      client.sendMouseState(e.state, true);
    });

    // Keyboard
    const keyboard = new Guacamole.Keyboard(document);

    const sessionId = `${opts.connectionId}-${Date.now()}`;
    const session: GuacSession = {
      id: sessionId,
      connectionId: opts.connectionId,
      name: opts.name,
      protocol: opts.protocol,
      client,
      tunnel,
      displayEl,
      keyboard,
      createdAt: Date.now(),
      filesystems: [],
      remoteClipboard: "",
    };

    // ── Clipboard sync: remote → local ──
    client.onclipboard = (stream: Guacamole.InputStream, mimetype: string) => {
      if (mimetype !== "text/plain") return;
      const reader = new Guacamole.StringReader(stream);
      let data = "";
      reader.ontext = (text: string) => {
        data += text;
      };
      reader.onend = () => {
        session.remoteClipboard = data;
        // Write to browser clipboard if permitted.
        // When the session is in a pop-out window the main window lacks focus
        // so navigator.clipboard.writeText() is denied by the browser.  Use
        // the popup window's clipboard API instead since it has focus.
        const clipNav =
          session._popout && !session._popout.window.closed
            ? session._popout.window.navigator
            : navigator;
        clipNav.clipboard?.writeText(data).catch((err: unknown) => {
          // Best-effort copy — don't surface this to users (it spams on
          // every keystroke in the iframe), but log so devs can spot a
          // Permissions-Policy or cross-origin clipboard denial.
          console.warn("[session] clipboard write failed:", err);
        });
        setSessions((prev) => [...prev]); // trigger re-render
      };
    };

    // ── Clipboard sync: local → remote (on focus) ──
    const pushClipboard = async () => {
      try {
        const text = await navigator.clipboard?.readText();
        if (text && text !== session.remoteClipboard) {
          const payload = preparePastePayload(text, session.protocol);
          const stream = client.createClipboardStream("text/plain");
          const writer = new Guacamole.StringWriter(stream);

          // Split text into chunks to avoid hitting Guacamole protocol
          // instruction size limits (typically 8KB). 4096 is a safe chunk size.
          // Add a small delay between chunks to avoid overwhelming the tunnel.
          const CHUNK_SIZE = 4096;
          for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
            writer.sendText(payload.substring(i, i + CHUNK_SIZE));
            // Tiny delay to let the event loop process and allow guacd to
            // handle the reassembly buffer without bursting.
            await new Promise((resolve) => setTimeout(resolve, 5));
          }

          writer.sendEnd();
          session.remoteClipboard = text; // Update local state to avoid echo
        }
      } catch {
        // Silently fail if clipboard access is denied
      }
    };
    // Push local clipboard whenever the display gets focus or is clicked.
    // mouseenter works when the browser already has focus (tabbing between
    // page areas).  mousedown is critical for the case where the user copies
    // in another app and clicks directly into the session: mouseenter fires
    // *before* the click grants transient user-activation, so the Clipboard
    // API denies access.  mousedown IS the user gesture, so readText()
    // succeeds.
    displayEl.addEventListener("mouseenter", pushClipboard);
    displayEl.addEventListener("mousedown", pushClipboard);
    displayEl.addEventListener("focus", pushClipboard, true);

    // ── Clipboard sync: local → remote (on paste event) ──
    // This is more reliable than the Clipboard API readText() since
    // browsers always provide clipboardData on user-initiated paste events.
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text && text !== session.remoteClipboard) {
        const payload = preparePastePayload(text, session.protocol);
        const stream = client.createClipboardStream("text/plain");
        const writer = new Guacamole.StringWriter(stream);
        const CHUNK_SIZE = 4096;
        for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
          writer.sendText(payload.substring(i, i + CHUNK_SIZE));
        }
        writer.sendEnd();
        session.remoteClipboard = text;
      }
    };
    window.addEventListener("paste", handlePaste as EventListener);
    session._cleanupPaste = () => window.removeEventListener("paste", handlePaste as EventListener);

    // ── Filesystem objects (RDP drive, SFTP, etc.) ──
    client.onfilesystem = (object: Guacamole.GuacObject, name: string) => {
      session.filesystems.push({ object, name });
      setSessions((prev) => [...prev]); // trigger re-render
    };

    // ── File download (server-initiated) ──
    client.onfile = (stream: Guacamole.InputStream, mimetype: string, filename: string) => {
      const reader = new Guacamole.BlobReader(stream, mimetype);
      reader.onend = () => {
        const blob = reader.getBlob();

        // Outbound approval-gated interception: when the user has the
        // `can_use_quick_share_outbound` permission, every file the
        // remote session pushes out (via the mapped drive / SFTP) is
        // routed to the outbound-shares endpoint for DLP scan +
        // optional approver review instead of being auto-downloaded.
        // The per-user `outbound_share_requires_approval` flag is
        // enforced server-side (auto-approves when off).
        if (canUseQuickShareOutboundRef.current) {
          const live = sessionsRef.current.find((s) => s.id === sessionId);
          const justification = live?.pendingOutboundJustification?.trim() ?? "";

          // When the user is subject to the approval queue (no
          // per-user bypass), justification is mandatory and the
          // backend will reject anything shorter than 10 chars. Catch
          // it here so the user gets a clear, actionable toast that
          // points them at the panel instead of an opaque server
          // error — and so we don't burn an audit row or temp file on
          // a request we already know will fail.
          if (!outboundShareBypassRef.current && justification.length < 10) {
            toast?.warning({
              title: `Justification required: ${filename}`,
              description:
                "Open the Outbound Share panel, enter at least 10 characters explaining why this file needs to leave the session, then re-drop the file.",
            });
            return;
          }

          const file = new File([blob], filename, { type: mimetype });
          const fd = new FormData();
          fd.append("file", file, filename);
          if (live) {
            fd.append("session_id", live.id);
            fd.append("connection_id", live.connectionId);
          }
          if (justification) fd.append("justification", justification);

          // Sticky live-updating toast for the two phases of an outbound
          // upload. Phase 1 is byte-streaming to the backend (we get
          // real XHR progress events). Phase 2 is the server-side AV
          // scan + DLP scoring, which has no progress signal — we
          // switch to an indeterminate bar so a slow WAR/JAR scan
          // doesn't look like the UI has frozen. Same `key` across
          // all updates means the ToastProvider replaces in place.
          const toastKey = `outbound-share-${live?.id ?? "no-session"}-${filename}-${Date.now()}`;
          toast?.info({
            key: toastKey,
            title: `Uploading: ${filename}`,
            description: `Sending to server\u2026`,
            progress: 0,
            duration: null,
          });

          submitOutboundShare(fd, {
            onProgress: (loaded, total) => {
              const pct = total > 0 ? loaded / total : 0;
              const human =
                total > 0
                  ? `${formatBytesShort(loaded)} of ${formatBytesShort(total)}`
                  : `${formatBytesShort(loaded)} uploaded`;
              toast?.info({
                key: toastKey,
                title: `Uploading: ${filename}`,
                description: human,
                progress: pct,
                duration: null,
              });
            },
            onUploadComplete: () => {
              toast?.info({
                key: toastKey,
                title: `Scanning: ${filename}`,
                description:
                  "Running antivirus + DLP checks. Java WAR/JAR or deeply-nested " +
                  "archives can take a few minutes.",
                progress: "indeterminate",
                duration: null,
              });
            },
          })
            .then((res) => {
              if (live && live.pendingOutboundJustification) {
                live.pendingOutboundJustification = undefined;
                setSessions((prev) => [...prev]);
              }
              // Fire a window event so any open QuickShareOutbound panel
              // can refresh its submission history immediately.
              window.dispatchEvent(
                new CustomEvent("strata:outbound-share-submitted", { detail: res })
              );
              // Replace the progress toast in place with the final
              // verdict so the user never sees two toasts for one
              // upload.
              if (res.status === "approved") {
                toast?.success({
                  key: toastKey,
                  title: `Outbound share auto-approved: ${filename}`,
                  description: res.download_url
                    ? "Open the Outbound Share panel to download."
                    : undefined,
                });
              } else if (res.status === "pending") {
                toast?.info({
                  key: toastKey,
                  title: `Outbound share queued: ${filename}`,
                  description: `DLP score ${res.dlp_score}. Awaiting approver decision.`,
                });
              } else {
                toast?.warning({
                  key: toastKey,
                  title: `Outbound share ${res.status}: ${filename}`,
                });
              }
            })
            .catch((err: unknown) => {
              toast?.error({
                key: toastKey,
                title: `Outbound share failed: ${filename}`,
                description: err instanceof Error ? err.message : String(err),
              });
            });
          return;
        }

        // Default behaviour: stream straight to the browser as a download.
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
    };

    // Display scaling — update whenever guacd sends a new remote resolution
    display.onresize = () => {
      const parent = displayEl.parentElement;
      if (!parent) return;
      const dw = display.getWidth();
      const dh = display.getHeight();
      if (dw <= 0 || dh <= 0) return;
      const cw = parent.clientWidth;
      const ch = parent.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      display.scale(Math.min(cw / dw, ch / dh));
    };

    // Handle errors
    tunnel.onerror = (status: Guacamole.Status) => {
      session.error = status.message || "Connection failed";
      setSessions((prev) => [...prev]); // trigger re-render
    };

    client.onerror = (status: Guacamole.Status) => {
      session.error = status.message || "Connection failed";
      setSessions((prev) => [...prev]);
    };

    // ── Auto-remove dead sessions when the tunnel closes ──
    // This fires regardless of whether SessionClient is mounted, so zombie
    // sessions are always cleaned up from the sessions list and session bar.
    tunnel.onstatechange = (state: number) => {
      if (state === 2 /* Guacamole.Tunnel.State.CLOSED */) {
        setSessions((prev) => {
          const s = prev.find((x) => x.id === sessionId);
          if (s) {
            cleanupPopout(s);
            s.keyboard.onkeydown = null;
            s.keyboard.onkeyup = null;
            s.keyboard.reset();
          }
          return prev.filter((x) => x.id !== sessionId);
        });
        setTiledSessionIds((prev) => prev.filter((tid) => tid !== sessionId));
        setFocusedSessionIds((prev) => prev.filter((fid) => fid !== sessionId));
        setActiveSessionId((current) => {
          if (current === sessionId) {
            const remaining = sessionsRef.current.filter((x) => x.id !== sessionId);
            return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
          }
          return current;
        });
      }
    };

    // On connected, re-send the container size to ensure guacd matches the viewport
    client.onstatechange = (state: number) => {
      if (state === 3) {
        requestAnimationFrame(() => {
          const parent = displayEl.parentElement;
          if (parent) {
            const cw = parent.clientWidth;
            const ch = parent.clientHeight;
            if (cw > 0 && ch > 0) {
              client.sendSize(cw, ch);
            }
            const dw = display.getWidth();
            const dh = display.getHeight();
            if (dw > 0 && dh > 0 && cw > 0 && ch > 0) {
              display.scale(Math.min(cw / dw, ch / dh));
            }
          }
        });
      }
    };

    client.connect(opts.connectParams.toString());

    setSessions((prev) => [...prev, session]);
    setActiveSessionId(sessionId);
    return session;
    // openSession is intentionally stable; cleanupPopout is referenced via closure and is itself stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const session = prev.find((s) => s.id === id);
        if (session) {
          cleanupPopout(session);
          cleanupMultiMonitor(session);
          session._cleanupPaste?.();
          session.keyboard.onkeydown = null;
          session.keyboard.onkeyup = null;
          session.keyboard.reset();
          try {
            session.client.disconnect();
          } catch {
            /* ignore */
          }
        }
        const remaining = prev.filter((s) => s.id !== id);
        return remaining;
      });
      setTiledSessionIds((prev) => prev.filter((tid) => tid !== id));
      setFocusedSessionIds((prev) => prev.filter((fid) => fid !== id));
      setActiveSessionId((current) => {
        if (current === id) {
          const remaining = sessionsRef.current.filter((s) => s.id !== id);
          return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        }
        return current;
      });
    },
    [cleanupPopout, cleanupMultiMonitor]
  );

  // Partial-update a session in-place. Mutates the existing object so live
  // refs (`client`, `tunnel`, `keyboard`) keep working, then triggers a
  // shallow re-render with `setSessions(prev => [...prev])` — same pattern
  // used by the existing `createSession`/popout code paths above.
  const updateSession = useCallback((id: string, partial: Partial<GuacSession>) => {
    setSessions((prev) => {
      const target = prev.find((s) => s.id === id);
      if (!target) return prev;
      Object.assign(target, partial);
      return [...prev];
    });
  }, []);

  // Tear down every active session. Used by the logout flow (manual + idle
  // timeout) so backend tunnels close and the live-sessions list updates.
  const closeAllSessions = useCallback(() => {
    const all = sessionsRef.current;
    for (const session of all) {
      try {
        cleanupPopout(session);
        cleanupMultiMonitor(session);
        session._cleanupPaste?.();
        session.keyboard.onkeydown = null;
        session.keyboard.onkeyup = null;
        session.keyboard.reset();
        session.client.disconnect();
      } catch {
        /* best-effort */
      }
    }
    setSessions([]);
    setTiledSessionIds([]);
    setFocusedSessionIds([]);
    setActiveSessionId(null);
  }, [cleanupPopout, cleanupMultiMonitor]);

  // Expose closeAllSessions to non-React code (e.g. the logout flow in
  // App.tsx, which lives outside this provider). The registry is mounted on
  // first provider mount and cleared on unmount.
  useEffect(() => {
    setCloseAllSessionsHandler(closeAllSessions);
    return () => setCloseAllSessionsHandler(null);
  }, [closeAllSessions]);

  // Warn before closing the browser tab when sessions are active
  useEffect(() => {
    if (sessions.length === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [sessions.length]);

  return (
    <SessionManagerContext.Provider
      value={{
        sessions,
        activeSessionId,
        setActiveSessionId,
        createSession,
        closeSession,
        getSession,
        updateSession,
        tiledSessionIds,
        setTiledSessionIds,
        focusedSessionIds,
        setFocusedSessionIds,
        sessionBarCollapsed,
        setSessionBarCollapsed,
        barWidth,
        canShare,
        canUseQuickShare,
        canUseQuickShareOutbound,
        outboundShareBypass,
      }}
    >
      {children}
    </SessionManagerContext.Provider>
  );
}
