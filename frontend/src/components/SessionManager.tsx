import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import Guacamole from 'guacamole-common-js';
import { getMe } from '../api';

export interface GuacSession {
  id: string;                      // connection UUID
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
  /** Cleanup function for paste event listener */
  _cleanupPaste?: () => void;
  /** Pop-out state and actions */
  isPoppedOut?: boolean;
  popOut?: () => void;
  popIn?: () => void;
  /** Internal pop-out window refs — persists across SessionClient mount/unmount */
  _popout?: {
    window: Window;
    keyboard: Guacamole.Keyboard;
    mouse: Guacamole.Mouse;
    touch: Guacamole.Mouse.Touchscreen;
    cleanup: () => void;
  };
}

interface SessionManagerValue {
  sessions: GuacSession[];
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  createSession: (opts: CreateSessionOpts) => GuacSession;
  closeSession: (id: string) => void;
  getSession: (connectionId: string) => GuacSession | undefined;
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
}

interface CreateSessionOpts {
  connectionId: string;
  name: string;
  protocol: string;
  containerEl: HTMLElement;
  connectParams: URLSearchParams;
}

const SessionManagerContext = createContext<SessionManagerValue | null>(null);

export function useSessionManager() {
  const ctx = useContext(SessionManagerContext);
  if (!ctx) throw new Error('useSessionManager must be used within SessionManagerProvider');
  return ctx;
}

export function SessionManagerProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<GuacSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [tiledSessionIds, setTiledSessionIds] = useState<string[]>([]);
  const [focusedSessionIds, setFocusedSessionIds] = useState<string[]>([]);
  const [sessionBarCollapsed, setSessionBarCollapsed] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const sessionsRef = useRef<GuacSession[]>([]);
 
  const barWidth = 0; // Floating overlay doesn't reserve space

  // Fetch sharing permission from the user's own profile
  useEffect(() => {
    if (!localStorage.getItem('access_token')) return;
    getMe().then((me: any) => {
      setCanShare(me.can_manage_system || me.can_create_sharing_profiles);
    }).catch(() => {});
  }, []);

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
      try { po.window.close(); } catch { /* ignore */ }
    }
    session._popout = undefined;
    session.isPoppedOut = false;
  }, []);

  const getSession = useCallback((connectionId: string) => {
    return sessionsRef.current.find((s) => s.connectionId === connectionId);
  }, []);

  const createSession = useCallback((opts: CreateSessionOpts): GuacSession => {
    // If session already exists for this connection, return it
    const existing = sessionsRef.current.find((s) => s.connectionId === opts.connectionId);
    if (existing) return existing;

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/api/tunnel/${opts.connectionId}`;

    const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
    const client = new Guacamole.Client(tunnel);
    const display = client.getDisplay();
    const displayEl = display.getElement();
    displayEl.style.background = '#000';

    // Mouse
    const mouse = new Guacamole.Mouse(displayEl);
    mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
      client.sendMouseState(e.state, true);
    });

    // Touch
    const touch = new Guacamole.Mouse.Touchscreen(displayEl);
    touch.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
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
      remoteClipboard: '',
    };

    // ── Clipboard sync: remote → local ──
    client.onclipboard = (stream: Guacamole.InputStream, mimetype: string) => {
      if (mimetype !== 'text/plain') return;
      const reader = new Guacamole.StringReader(stream);
      let data = '';
      reader.ontext = (text: string) => { data += text; };
      reader.onend = () => {
        session.remoteClipboard = data;
        // Write to browser clipboard if permitted.
        // When the session is in a pop-out window the main window lacks focus
        // so navigator.clipboard.writeText() is denied by the browser.  Use
        // the popup window's clipboard API instead since it has focus.
        const clipNav = session._popout && !session._popout.window.closed
          ? session._popout.window.navigator
          : navigator;
        clipNav.clipboard?.writeText(data).catch(() => {});
        setSessions((prev) => [...prev]); // trigger re-render
      };
    };

    // ── Clipboard sync: local → remote (on focus) ──
    const pushClipboard = async () => {
      try {
        const text = await navigator.clipboard?.readText();
        if (text && text !== session.remoteClipboard) {
          const stream = client.createClipboardStream('text/plain');
          const writer = new Guacamole.StringWriter(stream);
          
          // Split text into chunks to avoid hitting Guacamole protocol 
          // instruction size limits (typically 8KB). 4096 is a safe chunk size.
          // Add a small delay between chunks to avoid overwhelming the tunnel.
          const CHUNK_SIZE = 4096;
          for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            writer.sendText(text.substring(i, i + CHUNK_SIZE));
            // Tiny delay to let the event loop process and allow guacd to 
            // handle the reassembly buffer without bursting.
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          
          writer.sendEnd();
          session.remoteClipboard = text; // Update local state to avoid echo
        }
      } catch (err) {
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
    displayEl.addEventListener('mouseenter', pushClipboard);
    displayEl.addEventListener('mousedown', pushClipboard);
    displayEl.addEventListener('focus', pushClipboard, true);

    // ── Clipboard sync: local → remote (on paste event) ──
    // This is more reliable than the Clipboard API readText() since
    // browsers always provide clipboardData on user-initiated paste events.
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text && text !== session.remoteClipboard) {
        const stream = client.createClipboardStream('text/plain');
        const writer = new Guacamole.StringWriter(stream);
        const CHUNK_SIZE = 4096;
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
          writer.sendText(text.substring(i, i + CHUNK_SIZE));
        }
        writer.sendEnd();
        session.remoteClipboard = text;
      }
    };
    window.addEventListener('paste', handlePaste as EventListener);
    session._cleanupPaste = () => window.removeEventListener('paste', handlePaste as EventListener);

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
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
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
      session.error = status.message || 'Connection failed';
      setSessions((prev) => [...prev]); // trigger re-render
    };

    client.onerror = (status: Guacamole.Status) => {
      session.error = status.message || 'Connection failed';
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
  }, []);

  const closeSession = useCallback((id: string) => {
    setSessions((prev) => {
      const session = prev.find((s) => s.id === id);
      if (session) {
        cleanupPopout(session);
        session._cleanupPaste?.();
        session.keyboard.onkeydown = null;
        session.keyboard.onkeyup = null;
        session.keyboard.reset();
        try { session.client.disconnect(); } catch { /* ignore */ }
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
  }, [cleanupPopout]);

  // Warn before closing the browser tab when sessions are active
  useEffect(() => {
    if (sessions.length === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [sessions.length]);

  return (
    <SessionManagerContext.Provider value={{
      sessions,
      activeSessionId,
      setActiveSessionId,
      createSession,
      closeSession,
      getSession,
      tiledSessionIds,
      setTiledSessionIds,
      focusedSessionIds,
      setFocusedSessionIds,
      sessionBarCollapsed,
      setSessionBarCollapsed,
      barWidth,
      canShare,
    }}>
      {children}
    </SessionManagerContext.Provider>
  );
}
