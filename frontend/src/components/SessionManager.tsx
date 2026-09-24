/* eslint-disable react-hooks/refs, react-hooks/immutability --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import Guacamole from "guacamole-common-js";
import {
  clipboardDiag,
  clipboardFingerprint,
  installClipboardDiagnostics,
  resetRemoteClipboardEcho,
  sendClipboardToRemote,
  type ClipboardTxState,
} from "./clipboardSync";
import { notifySessionActivity } from "./sessionActivity";
import { submitOutboundShare } from "../api";
import { useOptionalToast } from "./ToastProvider";

installClipboardDiagnostics();
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
  /** Guacamole status code that came with `error`, when there was one */
  errorCode?: number;
  /** Filesystem objects exposed by guacd (RDP drive, SFTP, etc.) */
  filesystems: { object: Guacamole.GuacObject; name: string }[];
  /** Remote clipboard text (last received from, or last successfully sent to, the session) */
  remoteClipboard: string;
  /** Internal serialisation state for local → remote clipboard pushes. Owned by `clipboardSync`. */
  _clipboardTx?: ClipboardTxState;
  /**
   * Justification text to attach to the *next* outbound-share file
   * intercepted from this session. Set by the user via the
   * QuickShareOutbound panel; consumed (and cleared) by
   * `client.onfile` when an outbound file arrives.
   */
  pendingOutboundJustification?: string;
  /** Removes every clipboard listener this session registered (window + displayEl) */
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
  /** Target resolution: fixed { width, height } or "auto" to match window/display */
  targetResolution?: { width: number; height: number } | "auto";
  /** Display zoom scale factor: number like 1.0 (100%), 1.25, 1.5, or "fit" */
  zoomScale?: number | "fit";
  /** Apply resolution and zoom settings to the active display */
  applyDisplayConfig?: (
    res: { width: number; height: number } | "auto",
    zoom: number | "fit"
  ) => void;
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

const SCALE_PASSTHROUGH_KEY = "strata-display-scale-passthrough";

/**
 * Whether the local display scale is forwarded to the target as its DPI.
 *
 * Off by default: a remote desktop should look the same to everyone on a
 * given monitor size, and forwarding the scale means a user at 125% gets
 * a 1920×1080 desktop that Windows then draws 25% larger — the same
 * "zoomed in" session as sending the wrong size did. Users on a HiDPI
 * panel who want the remote UI to match their local text size can turn
 * it back on.
 */
export function isScalePassthroughEnabled(): boolean {
  try {
    return window.localStorage.getItem(SCALE_PASSTHROUGH_KEY) === "true";
  } catch {
    return false;
  }
}

export function setScalePassthroughEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SCALE_PASSTHROUGH_KEY, String(enabled));
  } catch {
    // Private-mode storage denial: fall back to the default for this tab.
  }
}

/**
 * The DPI to report to the target for a given local display scale.
 *
 * 96 is the unscaled desktop; the backend turns this into an MS-RDPEDISP
 * scale percentage, so 96 pins the remote UI to 100% regardless of local
 * zoom. Sizes are always sent as real pixels either way.
 */
export function remoteDpi(devicePixelRatio: number = window.devicePixelRatio || 1): number {
  const dpr = isScalePassthroughEnabled() ? devicePixelRatio || 1 : 1;
  return Math.round(96 * dpr);
}

/**
 * Real pixel size and reported DPI for a container measured in CSS pixels.
 *
 * Connect-time parameters and later resizes have to agree, so both go
 * through this.
 */
export function remoteDisplayMetrics(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number = window.devicePixelRatio || 1
): { width: number; height: number; dpi: number } {
  const dpr = devicePixelRatio || 1;
  return {
    width: Math.round(cssWidth * dpr),
    height: Math.round(cssHeight * dpr),
    dpi: remoteDpi(dpr),
  };
}

/**
 * Report the display size to the target, with the client's DPI.
 *
 * `Guacamole.Client.sendSize` emits only width and height, so this goes
 * to the tunnel directly to append a third argument. The backend treats
 * that argument as optional, so a client that never sends it still
 * resizes — and the target keeps its connect-time scale.
 *
 * Needed because a browser window dragged between monitors of different
 * scale keeps its pixel size: without this the remote desktop stays at
 * whichever DPI the session happened to start on. Pop-out windows pass
 * their own `devicePixelRatio`, which is the whole point — that window
 * is the one that moves between screens.
 */
export function sendSizeWithDpi(
  session: GuacSession,
  width: number,
  height: number,
  devicePixelRatio: number = window.devicePixelRatio || 1
): void {
  const dpi = remoteDpi(devicePixelRatio);
  // `Guacamole.Client` has no public isConnected(); the tunnel does.
  if (session.tunnel?.state === 2) return;
  if (typeof session.tunnel?.sendMessage === "function") {
    session.tunnel.sendMessage("size", Math.round(width), Math.round(height), dpi);
  } else if (typeof session.client?.sendSize === "function") {
    session.client.sendSize(Math.round(width), Math.round(height));
  }
}

/**
 * Resize from a container measured in CSS pixels.
 *
 * A display scaled above 100% reports fewer CSS pixels than it has, so
 * passing them straight through asks the target for a smaller desktop and
 * then tells it to draw the UI larger on top. Both effects compound: at
 * 125% a 1920-wide monitor requested a 1536-wide desktop at 125% scale,
 * which arrived zoomed in and soft. The target wants real pixels; the
 * `display.scale()` call that fits the canvas divides them back down.
 */
export function sendSizeFromCss(
  session: GuacSession,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number = window.devicePixelRatio || 1
): void {
  const dpr = devicePixelRatio || 1;
  sendSizeWithDpi(session, cssWidth * dpr, cssHeight * dpr, dpr);
}

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
    // guacd streams the clipboard as `clipboard,idx,mimetype;` followed by
    // one or more `blob,idx,base64;` instructions and finally `end,idx;`.
    // Under certain RDP CLIPRDR conditions (e.g. Windows returning delayed
    // format data after another copy interrupted the previous request, or
    // FreeRDP internal state getting wedged after N transfers), guacd can
    // open the stream and deliver zero or a partial set of blobs and never
    // emit `end`. The frontend's `StringReader.onend` then never fires, so
    // `navigator.clipboard.writeText()` is never called and the local
    // clipboard silently retains its previous value — visible to the user
    // as "copy just stopped working, but reconnecting fixes it".
    //
    // Guard the receive path with a per-stream watchdog: if we don't see
    // `end` within the applicable stall window, flush whatever we have to
    // the local clipboard and log a diagnostic. Getting *some* new text is
    // much better than silently leaving stale text sitting on the clipboard,
    // and the console warning gives us evidence to correlate with
    // server-side guacd logs.
    //
    // The window is deliberately asymmetric. A stream that opens and never
    // delivers a single blob is the wedged-CLIPRDR signature the watchdog
    // was written for, and 2 s is plenty to recognise it. A gap *between*
    // blobs is a completely different animal: guacd emits the whole
    // clipboard as one back-to-back burst of 4 KiB blobs out of a single
    // in-memory buffer, so a mid-transfer pause is transport backpressure,
    // not a wedge — and the odds of hitting one grow with payload size.
    // Treating those at 2 s truncated exactly the copies users care about
    // (a multi-thousand-line script) while leaving small ones intact.
    const CLIPBOARD_OPEN_STALL_MS = 2000;
    const CLIPBOARD_BLOB_STALL_MS = 10000;
    client.onclipboard = (stream: Guacamole.InputStream, mimetype: string) => {
      if (mimetype !== "text/plain") {
        clipboardDiag(sessionId, "in", "ignored-mimetype", { mimetype, index: stream.index });
        return;
      }
      const reader = new Guacamole.StringReader(stream);
      const openedAt = Date.now();
      let data = "";
      let blobCount = 0;
      /** Stream is finished or abandoned — no further writes. */
      let closed = false;
      /** Characters already pushed to the local clipboard. */
      let published = -1;
      /** `data.length` observed by the previous stall, to detect progress. */
      let charsAtLastStall = -1;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;

      clipboardDiag(sessionId, "in", "stream-open", { index: stream.index });

      const writeToLocalClipboard = (text: string): void => {
        // When the session is in a pop-out window the main window lacks focus
        // so navigator.clipboard.writeText() is denied by the browser. Use
        // the popup window's clipboard API instead since it has focus.
        const popout =
          session._popout && !session._popout.window.closed ? session._popout.window : undefined;
        const target = popout ?? window;
        const writer = target.navigator.clipboard;
        if (!writer) {
          // Optional chaining here would swallow the whole call, making a
          // skipped write indistinguishable from a successful one.
          clipboardDiag(sessionId, "in", "local-write-unavailable", {
            popout: popout !== undefined,
            secureContext: target.isSecureContext,
          });
          return;
        }
        const attempt = (retried: boolean): void => {
          target.navigator.clipboard?.writeText(text).then(
            () => {
              clipboardDiag(sessionId, "in", "local-write-ok", { chars: text.length, retried });
            },
            (err: unknown) => {
              // Best-effort copy — don't surface this to users (it spams on
              // every keystroke in the iframe), but log so devs can spot a
              // Permissions-Policy or cross-origin clipboard denial.
              clipboardDiag(sessionId, "in", "local-write-failed", { err: String(err), retried });
              console.warn("[session] clipboard write failed:", err);
              // A denial for lack of focus is recoverable — the document
              // owning the session usually regains focus moments later.
              const denied = (err as { name?: string } | null)?.name === "NotAllowedError";
              if (denied && !retried && !target.closed) {
                target.addEventListener("focus", () => attempt(true), { once: true });
              }
            }
          );
        };
        attempt(false);
      };

      const clearStallTimer = (): void => {
        if (stallTimer !== undefined) {
          clearTimeout(stallTimer);
          stallTimer = undefined;
        }
      };

      /**
       * Publish what has accumulated so far. Safe to call repeatedly: a
       * partial flush followed by more data is re-published in full, so a
       * transfer that merely paused still ends up complete on the clipboard.
       */
      const publish = (event: string): void => {
        clipboardDiag(sessionId, "in", event, {
          index: stream.index,
          blobs: blobCount,
          chars: data.length,
          ms: Date.now() - openedAt,
          fp: data.length > 0 ? clipboardFingerprint(data) : undefined,
        });
        if (data.length === published) return;
        published = data.length;
        // Only overwrite the local clipboard when we actually received
        // something. An empty flush from a stall with zero blobs would
        // wipe whatever the user had copied previously, making the bug
        // worse. Still update session.remoteClipboard so the local→remote
        // path doesn't echo an obsolete value.
        session.remoteClipboard = data;
        if (data.length > 0) {
          writeToLocalClipboard(data);
        }
        setSessions((prev) => [...prev]); // trigger re-render
      };

      const flush = (reason: "end" | "stall"): void => {
        if (closed) return;

        if (reason === "end") {
          closed = true;
          clearStallTimer();
          publish("stream-end");
          return;
        }

        // A stall that arrived after real progress is treated as a pause,
        // not a failure: publish the partial so the user is never left with
        // stale text, then keep listening. Only when a second window passes
        // with nothing new (or when nothing ever arrived) do we give up and
        // ack-close the index.
        const progressed = blobCount > 0 && data.length > charsAtLastStall;
        charsAtLastStall = data.length;
        if (progressed) {
          console.warn(
            `[session] clipboard stream ${stream.index} paused after ${blobCount} blob(s), ${data.length} chars — flushing partial data, still listening`
          );
          publish("stream-paused");
          armStallTimer();
          return;
        }

        closed = true;
        clearStallTimer();
        // Diagnostic only — helps correlate with guacd/FreeRDP CLIPRDR
        // hangs. Do NOT downgrade to console.debug; users pasting bug
        // reports need this visible without dev-tools filters.
        console.warn(
          `[session] clipboard stream ${stream.index} stalled after ${blobCount} blob(s), ${data.length} chars — abandoning transfer`
        );
        // Force-close the stalled stream so guacd sees an ack for the
        // orphaned index instead of leaking it forever.
        try {
          stream.sendAck("Stream stalled — flushed by client watchdog", 0x0200);
        } catch {
          /* stream may already be closed */
        }
        publish("stream-stalled");
      };

      const armStallTimer = (): void => {
        clearStallTimer();
        const delay = blobCount === 0 ? CLIPBOARD_OPEN_STALL_MS : CLIPBOARD_BLOB_STALL_MS;
        stallTimer = setTimeout(() => flush("stall"), delay);
      };

      reader.ontext = (text: string) => {
        if (closed) return;
        data += text;
        blobCount++;
        armStallTimer();
      };
      reader.onend = () => flush("end");
      armStallTimer();
    };

    // ── Clipboard sync: local → remote (on focus) ──
    const pushClipboard = async () => {
      try {
        const text = await navigator.clipboard?.readText();
        if (text) await sendClipboardToRemote(session, text, "focus");
      } catch (err) {
        // Denied (no transient activation, insecure context, blocked
        // permission). Recorded rather than swallowed — a permanently
        // denied read looks identical to "paste stopped working".
        clipboardDiag(sessionId, "out", "local-read-failed", { err: String(err) });
      }
    };
    // Push local clipboard whenever the display gets focus or is clicked.
    // mouseenter works when the browser already has focus (tabbing between
    // page areas).  mousedown is critical for the case where the user copies
    // in another app and clicks directly into the session: mouseenter fires
    // *before* the click grants transient user-activation, so the Clipboard
    // API denies access.  mousedown IS the user gesture, so readText()
    // succeeds.  All three funnel into the same serialised sender, so the
    // burst of events a single click produces cannot open concurrent
    // clipboard streams.
    displayEl.addEventListener("mouseenter", pushClipboard);
    displayEl.addEventListener("mousedown", pushClipboard);
    displayEl.addEventListener("focus", pushClipboard, true);

    // ── Clipboard sync: local → remote (on paste event) ──
    // This is more reliable than the Clipboard API readText() since
    // browsers always provide clipboardData on user-initiated paste events.
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text) void sendClipboardToRemote(session, text, "paste-event");
    };
    window.addEventListener("paste", handlePaste as EventListener);
    // Tears down every clipboard listener this session owns. MUST be called
    // on both close paths (explicit closeSession and the tunnel-CLOSED
    // handler below) — a missed call leaves a window-level `paste` listener
    // bound to a dead client for the lifetime of the page, and those
    // accumulate on every dropped connection and auto-reconnect.
    session._cleanupPaste = () => {
      window.removeEventListener("paste", handlePaste as EventListener);
      displayEl.removeEventListener("mouseenter", pushClipboard);
      displayEl.removeEventListener("mousedown", pushClipboard);
      displayEl.removeEventListener("focus", pushClipboard, true);
    };

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
      session.errorCode = status.code;
      setSessions((prev) => [...prev]); // trigger re-render
    };

    client.onerror = (status: Guacamole.Status) => {
      session.error = status.message || "Connection failed";
      session.errorCode = status.code;
      setSessions((prev) => [...prev]);
    };

    // ── Auto-remove dead sessions when the tunnel closes ──
    // This fires regardless of whether SessionClient is mounted, so zombie
    // sessions are always cleaned up from the sessions list and session bar.
    tunnel.onstatechange = (state: number) => {
      if (state === 2 /* Guacamole.Tunnel.State.CLOSED */) {
        clipboardDiag(sessionId, "out", "tunnel-closed", {});
        setSessions((prev) => {
          const s = prev.find((x) => x.id === sessionId);
          if (s) {
            cleanupPopout(s);
            // Without this, the window-level `paste` listener registered
            // above survives the dead session. Every network drop and every
            // auto-reconnect attempt then adds another, all firing on each
            // Ctrl+V against clients whose tunnels are gone.
            s._cleanupPaste?.();
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
        // A freshly-spawned guacd has an empty clipboard, and when RDP
        // reattaches to an already-logged-on Windows session the CLIPRDR
        // channel is renegotiated from scratch. Drop our belief about what
        // the remote holds so the next focus/paste re-primes it instead of
        // being suppressed as a duplicate.
        resetRemoteClipboardEcho(session, "client-connected");
        requestAnimationFrame(() => {
          const parent = displayEl.parentElement;
          if (parent) {
            const cw = parent.clientWidth;
            const ch = parent.clientHeight;
            if (cw > 0 && ch > 0) {
              sendSizeFromCss(session, cw, ch);
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
