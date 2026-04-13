import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Guacamole from 'guacamole-common-js';
import { getConnectionInfo, getConnections, createTunnelTicket, getCredentialProfiles, CredentialProfile } from '../api';
import { useSessionManager, GuacSession } from '../components/SessionManager';
import { useSidebarWidth } from '../components/Layout';
import { usePopOut } from '../components/usePopOut';
import SessionWatermark from '../components/SessionWatermark';
import Select from '../components/Select';
import { createWinKeyProxy } from '../utils/winKeyProxy';

/*
 * Phases:
 *  1. "loading"   – fetching connection info from the backend
 *  2. "prompt"    – no stored credentials; show pre-connect credential form
 *  3. "connected" – WebSocket tunnel open, Guacamole session running
 */
type Phase = 'loading' | 'prompt' | 'connected';

/** Reconnection state (null = not reconnecting) */
interface ReconnectState {
  attempt: number;
  maxAttempts: number;
}

const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000; // 1 second
const RECONNECT_MAX_DELAY = 30000; // 30 seconds

export default function SessionClient() {
  const { connectionId } = useParams<{ connectionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const { sessions, activeSessionId, setActiveSessionId, createSession, closeSession, getSession, barWidth } = useSessionManager();
  const sidebarWidth = useSidebarWidth();

  const [phase, setPhase] = useState<Phase>('loading');
  const [protocol, setProtocol] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [credForm, setCredForm] = useState<Record<string, string>>({ username: '', password: '', domain: '' });
  const [error, setError] = useState('');
  const [sshRequired, setSshRequired] = useState<string[] | null>(null);
  const [hasDomain, setHasDomain] = useState(false);
  const [ignoreCert, setIgnoreCert] = useState(false);
  const [vaultProfiles, setVaultProfiles] = useState<CredentialProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const pendingCredsRef = useRef<{ username: string; password: string; credential_profile_id?: string }>({ username: '', password: '' });

  const containerFocusedRef = useRef(false);
  const [reconnecting, setReconnecting] = useState<ReconnectState | null>(null);
  const [reconnectLoading, setReconnectLoading] = useState(false);
  const userDisconnectRef = useRef(false);
  const serverDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wireHandlersRef = useRef<(session: GuacSession, attempt: number) => void>();
  /** Ref mirror of `error` so effects always read the latest value. */
  const errorRef = useRef('');
  /** Ref mirror of sessions for stable access inside tunnel-close callbacks. */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // Find the session for this connection
  const currentSession = sessions.find(
    (s) => s.connectionId === connectionId && s.id === activeSessionId
  ) || sessions.find((s) => s.connectionId === connectionId);

  const { isPoppedOut, popOut, returnDisplay } = usePopOut(currentSession, containerRef);

  // Keep errorRef in sync with the error state.
  errorRef.current = error;

  // ── Reset stale state when switching to a different connection ──
  const prevConnectionIdRef = useRef(connectionId);
  useEffect(() => {
    if (connectionId !== prevConnectionIdRef.current) {
      prevConnectionIdRef.current = connectionId;
      setError('');
      setReconnecting(null);
      setSshRequired(null);
      setPhase('loading');
      serverDisconnectRef.current = false;
      userDisconnectRef.current = false;
    }
  }, [connectionId]);

  // ── Phase 1: Check for existing session or fetch connection info ──
  useEffect(() => {
    if (!connectionId) return;

    const existing = getSession(connectionId);
    if (existing) {
      setActiveSessionId(existing.id);
      setPhase('connected');
      setProtocol(existing.protocol);
      setConnectionName(existing.name);
      return;
    }

    // Don't re-fetch connection info if the session just ended with an error
    // (e.g. server disconnected).  Without this guard, removing the dead session
    // from SessionManager causes getSession to change → this effect re-runs →
    // fetches info → sets phase to 'connected' → Phase 3 creates a new session.
    if (errorRef.current) return;

    let cancelled = false;
    Promise.all([
      getConnectionInfo(connectionId),
      getConnections().then((conns) => conns.find((c) => c.id === connectionId)).catch(() => undefined),
    ])
      .then(([info, connDetail]) => {
        if (cancelled) return;
        setProtocol(info.protocol);
        setConnectionName(connDetail?.name || info.protocol.toUpperCase());
        setHasDomain(!!connDetail?.domain);
        setIgnoreCert(!!info.ignore_cert);
        if (info.has_credentials) {
          setPhase('connected');
        } else if (info.protocol === 'rdp') {
          setPhase('prompt');
        } else {
          setPhase('connected');
        }
      })
      .catch(() => { if (!cancelled) setError('Failed to load connection info'); });
    return () => { cancelled = true; };
  }, [connectionId, getSession, setActiveSessionId]);

  // Fetch vault credential profiles when the prompt is shown
  useEffect(() => {
    if (phase !== 'prompt') return;
    getCredentialProfiles()
      .then((profiles) => setVaultProfiles(profiles.filter((p) => !p.expired)))
      .catch(() => {}); // Vault may not be configured
  }, [phase]);

  // ── Phase 2 → 3: user submits credentials ──
  const handlePreConnectSubmit = useCallback(() => {
    pendingCredsRef.current = selectedProfileId
      ? { username: '', password: '', credential_profile_id: selectedProfileId }
      : { username: credForm.username || '', password: credForm.password || '' };
    setPhase('connected');
  }, [credForm, selectedProfileId]);

  // ── Auto-reconnect: attempt to re-establish a dropped session ──
  const attemptReconnect = useCallback((attempt: number): void => {
    if (!connectionId || !containerRef.current || userDisconnectRef.current) return;

    setReconnecting({ attempt, maxAttempts: RECONNECT_MAX_ATTEMPTS });
    setError('');
    serverDisconnectRef.current = false;

    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt - 1), RECONNECT_MAX_DELAY);

    reconnectTimerRef.current = setTimeout(async () => {
      if (userDisconnectRef.current) return;
      const container = containerRef.current;
      if (!container) return;

      try {
        const token = localStorage.getItem('access_token') || '';
        const dpr = window.devicePixelRatio || 1;

        const resp = await createTunnelTicket({
          connection_id: connectionId,
          width: container.clientWidth,
          height: container.clientHeight,
          dpi: Math.round(96 * dpr),
          ignore_cert: ignoreCert,
        });

        if (userDisconnectRef.current) return;

        const connectParams = new URLSearchParams();
        connectParams.set('token', token);
        connectParams.set('ticket', resp.ticket);
        connectParams.set('width', String(container.clientWidth));
        connectParams.set('height', String(container.clientHeight));
        connectParams.set('dpi', String(Math.round(96 * dpr)));

        const session = createSession({
          connectionId,
          name: connectionName || protocol.toUpperCase(),
          protocol,
          containerEl: container,
          connectParams,
        });

        wireHandlersRef.current?.(session, attempt);
        attachSession(session, container);
        setReconnecting(null);
      } catch {
        if (attempt >= RECONNECT_MAX_ATTEMPTS) {
          setReconnecting(null);
          setError('Connection lost. Automatic reconnection failed after multiple attempts.');
        } else {
          attemptReconnect(attempt + 1);
        }
      }
    }, delay);
  }, [connectionId, connectionName, protocol, ignoreCert, createSession]);

  // ── Wire error/close handlers onto a session for UI feedback ──
  // Session cleanup (removing from SessionManager) is handled by the
  // tunnel.onstatechange in SessionManager.createSession.  This handler
  // only manages UI: showing the "Session Ended" overlay or triggering
  // reconnection.
  const wireSessionErrorHandlers = useCallback((session: GuacSession, attempt = 0): void => {
    // Tracks whether tunnel.onerror fired BEFORE the tunnel reached CLOSED.
    let tunnelHadError = false;

    const handleTunnelClosed = () => {
      // If the caller explicitly marked this as user-initiated (e.g. manual
      // reconnect), skip all UI side-effects — the caller handles what's next.
      if (userDisconnectRef.current) return;

      // ── Check for remaining sessions ──
      // Redirecting to a live session is safe regardless of how this tunnel
      // closed (server disconnect or clean close without prior error).
      if (serverDisconnectRef.current || !tunnelHadError) {
        const remaining = sessionsRef.current.filter(
          (s) => s.id !== session.id && !s.error
        );
        if (remaining.length > 0) {
          const next = remaining[remaining.length - 1];
          setActiveSessionId(next.id);

          // Attach the next session's display immediately — unless it's in a
          // pop-out window (stealing its displayEl would black-out the popup).
          const container = containerRef.current;
          if (container && !(next._popout && !next._popout.window.closed)) {
            container.innerHTML = '';
            container.appendChild(next.displayEl);
            const display = next.client.getDisplay();
            const dw = display.getWidth();
            const dh = display.getHeight();
            if (dw > 0 && dh > 0) {
              display.scale(Math.min(container.clientWidth / dw, container.clientHeight / dh));
            }
          }

          navigateRef.current(`/session/${next.connectionId}`);
          return;
        }

        // Last session — always show the "Session Ended" overlay even if
        // userDisconnectRef is stale from prior session switches.
        setReconnecting(null);
        setError('The remote session has ended. You may have logged out of the server.');
        return;
      }

      // Error-based closure (network drop, timeout) → attempt reconnection.
      const elapsed = Date.now() - session.createdAt;
      const nextAttempt = elapsed > 10000 ? 1 : attempt + 1;

      if (nextAttempt > RECONNECT_MAX_ATTEMPTS) {
        setReconnecting(null);
        setError('Connection lost. Automatic reconnection failed after multiple attempts.');
      } else {
        attemptReconnect(nextAttempt);
      }
    };

    // ── Intercept guacd instructions to detect server-initiated disconnects ──
    const clientInstructionHandler = session.tunnel.oninstruction;
    session.tunnel.oninstruction = function (opcode: string, args: string[]) {
      if (opcode === 'disconnect' || opcode === 'error') {
        serverDisconnectRef.current = true;
      }
      if (clientInstructionHandler) {
        clientInstructionHandler.call(this, opcode, args);
      }
    };

    // ── Wrap tunnel.onstatechange (preserve the SessionManager handler) ──
    const managerTunnelStateHandler = session.tunnel.onstatechange;
    session.tunnel.onstatechange = (state: number) => {
      // Let SessionManager clean up the session from its list first.
      if (managerTunnelStateHandler) {
        managerTunnelStateHandler(state);
      }
      // Then handle UI (overlay / reconnection).
      if (state === 2 /* CLOSED */) {
        handleTunnelClosed();
      }
    };

    // ── Wrap tunnel.onerror (preserve SessionManager handler) ──
    const managerTunnelErrorHandler = session.tunnel.onerror;
    session.tunnel.onerror = (status: Guacamole.Status) => {
      tunnelHadError = true;
      session.error = status.message || 'Connection failed';
      if (managerTunnelErrorHandler) {
        managerTunnelErrorHandler(status);
      }
    };

    // ── Wrap client.onerror ──
    const managerClientErrorHandler = session.client.onerror;
    session.client.onerror = (status: Guacamole.Status) => {
      session.error = status.message || 'Connection failed';
      if (managerClientErrorHandler) {
        managerClientErrorHandler(status);
      }
    };

    session.client.onrequired = (parameters: string[]) => {
      setSshRequired(parameters);
    };
  }, [attemptReconnect]);

  wireHandlersRef.current = wireSessionErrorHandlers;

  // ── Manual reconnect (imperative — bypasses effect dependency chains) ──
  const handleManualReconnect = useCallback(async () => {
    if (!connectionId || !containerRef.current) return;

    // Keep the error overlay visible during the async reconnect to avoid a
    // black screen flash.  Only clear error after the session is attached.
    setReconnectLoading(true);
    errorRef.current = '';
    setReconnecting(null);
    serverDisconnectRef.current = false;

    // Mark user-initiated so tunnel-close handlers don't fire error overlays
    // or redirect to other sessions.
    userDisconnectRef.current = true;

    // Close any existing live session for this connection first.
    // Capture the session's name before closing — component state may still
    // hold a stale name from a different connection when triggered via the
    // SessionBar reconnect navigate.
    const existing = getSession(connectionId);
    const sessionName = existing?.name || connectionName || protocol.toUpperCase();
    const sessionProtocol = existing?.protocol || protocol;
    if (existing) {
      closeSession(existing.id);
    }

    // Now allow the new session to set up its own error handlers
    userDisconnectRef.current = false;

    const container = containerRef.current;
    const token = localStorage.getItem('access_token') || '';
    const dpr = window.devicePixelRatio || 1;

    try {
      const resp = await createTunnelTicket({
        connection_id: connectionId,
        width: container.clientWidth,
        height: container.clientHeight,
        dpi: Math.round(96 * dpr),
        ignore_cert: ignoreCert,
      });

      const connectParams = new URLSearchParams();
      connectParams.set('token', token);
      connectParams.set('ticket', resp.ticket);
      connectParams.set('width', String(container.clientWidth));
      connectParams.set('height', String(container.clientHeight));
      connectParams.set('dpi', String(Math.round(96 * dpr)));

      const session = createSession({
        connectionId,
        name: sessionName,
        protocol: sessionProtocol,
        containerEl: container,
        connectParams,
      });

      wireHandlersRef.current?.(session, 0);
      attachSession(session, container);

      // Session is created & display attached — now clear the overlay
      setError('');
      errorRef.current = '';
      // Sync component state with the session we just created
      setConnectionName(sessionName);
      setProtocol(sessionProtocol);
      setPhase('connected');
    } catch {
      setError('Failed to reconnect. Please try again.');
    } finally {
      setReconnectLoading(false);
    }
  }, [connectionId, connectionName, protocol, ignoreCert, createSession, closeSession, getSession]);

  // ── Handle reconnect signal from SessionBar ──
  const reconnectStampRef = useRef<number>(0);
  useEffect(() => {
    const stamp = (location.state as any)?.reconnect;
    if (stamp && stamp !== reconnectStampRef.current) {
      reconnectStampRef.current = stamp;
      // Clear router state so a page refresh doesn't re-trigger
      navigate(location.pathname, { replace: true, state: {} });
      handleManualReconnect();
    }
  }, [location.state, location.pathname, navigate, handleManualReconnect]);

  // ── Phase 3: Create or attach session ──
  useEffect(() => {
    if (phase !== 'connected' || !connectionId || !containerRef.current) return;

    // Don't create a new session if the previous one ended in an error.
    // Without this guard, cleaning up the dead session triggers a re-render
    // that re-runs this effect and auto-connects to the same (dead) server.
    if (errorRef.current) return;

    const existing = getSession(connectionId);
    if (existing) {
      attachSession(existing, containerRef.current);
      return;
    }

    const container = containerRef.current;

    // Defer to next frame so the fixed-position portal container has its final layout dimensions.
    let cancelled = false;
    const raf = requestAnimationFrame(async () => {
      const token = localStorage.getItem('access_token') || '';
      const dpr = window.devicePixelRatio || 1;
      const creds = pendingCredsRef.current;

      // Obtain a one-time tunnel ticket so credentials never appear in the WebSocket URL
      let ticketId: string | undefined;
      try {
        const resp = await createTunnelTicket({
          connection_id: connectionId,
          username: creds.username || undefined,
          password: creds.password || undefined,
          credential_profile_id: creds.credential_profile_id || undefined,
          width: container.clientWidth,
          height: container.clientHeight,
          dpi: Math.round(96 * dpr),
          ignore_cert: ignoreCert,
        });
        ticketId = resp.ticket;
      } catch {
        if (!cancelled) setError('Failed to create tunnel ticket');
        return;
      }

      if (cancelled) return;

      const connectParams = new URLSearchParams();
      connectParams.set('token', token);
      connectParams.set('ticket', ticketId);
      connectParams.set('width', String(container.clientWidth));
      connectParams.set('height', String(container.clientHeight));
      connectParams.set('dpi', String(Math.round(96 * dpr)));

      const session = createSession({
        connectionId,
        name: connectionName || protocol.toUpperCase(),
        protocol,
        containerEl: container,
        connectParams,
      });

      wireSessionErrorHandlers(session);

      pendingCredsRef.current = { username: '', password: '' };
      setCredForm({ username: '', password: '', domain: '' });

      attachSession(session, container);
    });

    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [phase, connectionId, protocol, connectionName, createSession, getSession, wireSessionErrorHandlers, ignoreCert]);

  // Re-attach when switching back to an existing session
  useEffect(() => {
    if (!currentSession || !containerRef.current || phase !== 'connected') return;
    attachSession(currentSession, containerRef.current);
  }, [activeSessionId, currentSession, phase]);

  // Handle resize
  useEffect(() => {
    if (!currentSession || !containerRef.current) return;
    const container = containerRef.current!;
    const client = currentSession.client;
    const display = client.getDisplay();


    function handleResize() {
      const cw = container!.clientWidth;
      const ch = container!.clientHeight;
      if (cw <= 0 || ch <= 0) return;

      const dw = display.getWidth();
      const dh = display.getHeight();
      if (dw > 0 && dh > 0) {
        display.scale(Math.min(cw / dw, ch / dh));
      }
      client.sendSize(cw, ch);
    }

    const observer = new ResizeObserver(() => {
      handleResize();
    });

    observer.observe(container);
    
    // Fallback for window resize too
    window.addEventListener('resize', handleResize);
    
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [currentSession]);

  // Keyboard management — focus-scoped with capture-phase key trap
  useEffect(() => {
    if (!currentSession) return;
    const kb = currentSession.keyboard;
    const client = currentSession.client;
    const dialogOpen = phase === 'prompt' || sshRequired !== null;

    if (dialogOpen || currentSession.id !== activeSessionId) {
      kb.onkeydown = null;
      kb.onkeyup = null;
      return () => { kb.onkeydown = null; kb.onkeyup = null; };
    }

    const winProxy = createWinKeyProxy((p, k) => client.sendKeyEvent(p, k));
    kb.onkeydown = (keysym: number) => {
      if (!containerFocusedRef.current) { winProxy.reset(); return false; }
      return winProxy.onkeydown(keysym);
    };
    kb.onkeyup = (keysym: number) => {
      if (!containerFocusedRef.current) { winProxy.reset(); return; }
      winProxy.onkeyup(keysym);
    };

    // Capture-phase listener intercepts keys BEFORE the browser can act on
    // them (Tab focus-navigation, F5 refresh, Alt+Left back-navigation, etc.).
    // Guacamole.Keyboard uses the bubbling phase with delayed key
    // identification, so by the time it calls preventDefault() the browser
    // has already processed certain default actions.
    const trapKeyDown = (e: KeyboardEvent) => {
      if (!containerFocusedRef.current) return;
      // Allow browser dev-tools shortcuts through
      if (e.key === 'F12') return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) return;
      e.preventDefault();
    };
    document.addEventListener('keydown', trapKeyDown, true);

    return () => {
      kb.onkeydown = null;
      kb.onkeyup = null;
      document.removeEventListener('keydown', trapKeyDown, true);
    };
  }, [currentSession, activeSessionId, phase, sshRequired]);

  // Auto-focus the session container when a session becomes active
  useEffect(() => {
    if (phase === 'connected' && containerRef.current) {
      containerRef.current.focus();
    }
  }, [phase, activeSessionId]);

  // ── Drag-and-drop file upload ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !currentSession) return;

    const handleDragOver = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0 || currentSession.filesystems.length === 0) return;
      const fs = currentSession.filesystems[0];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const stream = fs.object.createOutputStream(file.type || 'application/octet-stream', '/' + file.name);
        const writer = new Guacamole.BlobWriter(stream);
        writer.sendBlob(file);
      }
    };
    container.addEventListener('dragover', handleDragOver);
    container.addEventListener('drop', handleDrop);
    return () => {
      container.removeEventListener('dragover', handleDragOver);
      container.removeEventListener('drop', handleDrop);
    };
  }, [currentSession]);

  // Cleanup reconnect timer on unmount and mark user-initiated disconnect
  useEffect(() => {
    return () => {
      userDisconnectRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, []);

  // ── Detect when our session is removed and redirect to next active session ──
  // This handles the case where tunnel handlers reference stale refs from a
  // prior component instance (React Router may unmount/remount SessionClient
  // when navigating between /session/:connectionId routes).
  const hadSessionRef = useRef(false);
  if (currentSession) hadSessionRef.current = true;
  useEffect(() => {
    // Reset only when switching to a different connection
    hadSessionRef.current = false;
  }, [connectionId]);
  useEffect(() => {
    if (!connectionId || error || reconnecting || reconnectLoading) return;
    if (phase !== 'connected') return;
    // Only act if we previously had a session that has now disappeared.
    // This avoids false-positives during initial session creation.
    if (!hadSessionRef.current) return;

    // Check if our session still exists in the session list
    const ourSession = sessions.find((s) => s.connectionId === connectionId);
    if (ourSession) return; // still alive

    // Session was removed by SessionManager. Redirect to remaining healthy session.
    const remaining = sessions.filter((s) => !s.error);
    if (remaining.length > 0) {
      const next = remaining.find((s) => s.id === activeSessionId) || remaining[remaining.length - 1];
      setActiveSessionId(next.id);

      // Attach display — unless the next session is in a pop-out window.
      const container = containerRef.current;
      if (container && !(next._popout && !next._popout.window.closed)) {
        container.innerHTML = '';
        container.appendChild(next.displayEl);
        const display = next.client.getDisplay();
        const dw = display.getWidth();
        const dh = display.getHeight();
        if (dw > 0 && dh > 0) {
          display.scale(Math.min(container.clientWidth / dw, container.clientHeight / dh));
        }
      }

      navigate(`/session/${next.connectionId}`);
    } else {
      // Last session ended — show overlay.
      setError('The remote session has ended. You may have logged out of the server.');
    }
  }, [sessions, connectionId, activeSessionId, error, reconnecting, phase, setActiveSessionId, navigate]);

  // SSH runtime credentials
  const submitSshCredentials = useCallback(() => {
    if (!currentSession || !sshRequired) return;
    for (const param of sshRequired) {
      const value = credForm[param] || '';
      const stream = currentSession.client.createArgumentValueStream('text/plain', param);
      const writer = new Guacamole.StringWriter(stream);
      writer.sendText(value);
      writer.sendEnd();
    }
    setSshRequired(null);
  }, [sshRequired, credForm, currentSession]);

  const paramLabels: Record<string, string> = { username: 'Username', password: 'Password', domain: 'Domain' };
  const preConnectFields = protocol === 'rdp'
    ? (hasDomain ? ['username', 'password'] : ['username', 'password', 'domain'])
    : ['username', 'password'];

  // Render via portal into document.body to escape the .main-content container.
  return createPortal(
    <div style={{
      position: 'fixed',
      top: 0,
      left: sidebarWidth,
      right: barWidth,
      bottom: 0,
      zIndex: 5,
      transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1), right 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    }}>
      <div
        ref={containerRef}
        tabIndex={0}
        onFocus={() => { containerFocusedRef.current = true; }}
        onBlur={() => {
          // Release any keys still held on the remote before disabling the trap
          currentSession?.keyboard.reset();
          containerFocusedRef.current = false;
        }}
        onMouseDown={() => { containerRef.current?.focus(); }}
        style={{
          width: '100%',
          height: '100%',
          background: '#000',
          overflow: 'hidden',
          cursor: phase === 'connected' ? 'none' : 'default',
          outline: 'none',
        }}
      />

      {/* Registration of pop-out actions with SessionManager */}
      {useEffect(() => {
        if (currentSession) {
          currentSession.isPoppedOut = isPoppedOut;
          currentSession.popOut = popOut;
          currentSession.popIn = returnDisplay;
        }
      }, [currentSession, isPoppedOut, popOut, returnDisplay]) as any}

      {/* Touch controls and watermark */}
      {currentSession && <SessionWatermark />}

      {/* Pop-out placeholder */}
      {isPoppedOut && (
        <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: 'rgba(0,0,0,0.9)' }}>
          <div className="card max-w-[400px] text-center !p-8">
            <div className="text-3xl mb-3">🖥️</div>
            <h3 className="text-lg font-semibold mb-2">Session Popped Out</h3>
            <p className="text-txt-secondary text-sm mb-4">
              This session is displayed in a separate window. Close that window or click below to return it here.
            </p>
            <button className="btn-primary" onClick={returnDisplay}>Return to Main Window</button>
          </div>
        </div>
      )}

      {phase === 'loading' && !error && !reconnecting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-10">
          <p className="text-gray-500">Loading connection…</p>
        </div>
      )}

      {/* Reconnecting overlay */}
      {reconnecting && (
        <div className="absolute inset-0 flex items-center justify-center z-20" style={{ background: 'rgba(0,0,0,0.85)' }}>
          <div className="card max-w-[400px] text-center !p-8">
            <div className="mb-4">
              <svg className="animate-spin h-10 w-10 mx-auto text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold mb-2">Reconnecting…</h3>
            <p className="text-txt-secondary text-sm mb-4">
              Connection lost. Attempting to reconnect ({reconnecting.attempt}/{reconnecting.maxAttempts})
            </p>
            <button className="btn text-sm" onClick={() => {
              userDisconnectRef.current = true;
              if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
              }
              setReconnecting(null);
              setError('Connection lost. Reconnection cancelled.');
            }}>Cancel</button>
          </div>
        </div>
      )}

      {error && !reconnecting && !sshRequired && phase !== 'prompt' && (
        <div className="absolute inset-0 flex items-center justify-center z-10 animate-in fade-in duration-300" style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}>
          <div className="card max-w-[400px] text-center !p-8 shadow-2xl scale-in-center">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-danger/10 text-danger mx-auto mb-6">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                <line x1="12" y1="2" x2="12" y2="12" />
              </svg>
            </div>
            <h3 className="text-xl font-bold mb-2">
              {error.toLowerCase().includes('terminated') ? 'Session Terminated'
                : error.toLowerCase().includes('session has ended') ? 'Session Ended'
                : 'Connection Error'}
            </h3>
            <p className="text-txt-secondary text-sm mb-8 leading-relaxed">
              {error.toLowerCase().includes('terminated') 
                ? 'Your session has been terminated by an administrator. Any unsaved work may be lost.'
                : error}
            </p>
            <div className="flex gap-3">
              <button className="btn flex-1" onClick={() => navigate('/')} disabled={reconnectLoading}>Exit to Dashboard</button>
              {!error.toLowerCase().includes('terminated') && (
                <button className="btn-primary flex-1" onClick={handleManualReconnect} disabled={reconnectLoading}>
                  {reconnectLoading ? 'Reconnecting…' : 'Reconnect'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'prompt' && (
        <div className="absolute inset-0 flex items-center justify-center z-10 overflow-auto p-4" style={{ background: 'var(--color-surface)' }}>
          <div className="card w-full max-w-[400px] m-auto">
            <h2 className="!mb-1">Connect to {protocol.toUpperCase()}</h2>
            <p className="text-txt-secondary text-sm mb-4">Enter credentials for the remote server.</p>
            <form onSubmit={(e) => { e.preventDefault(); handlePreConnectSubmit(); }}>
              {vaultProfiles.length > 0 && (
                <div className="form-group">
                  <label>Saved Credential Profile</label>
                  <Select
                    value={selectedProfileId}
                    onChange={(val) => {
                      setSelectedProfileId(val);
                      if (val) setCredForm({ username: '', password: '', domain: '' });
                    }}
                    options={[
                      { value: '', label: '— Enter manually —' },
                      ...vaultProfiles.map((p) => ({ value: p.id, label: p.label })),
                    ]}
                  />
                </div>
              )}
              {!selectedProfileId && preConnectFields.map((field) => (
                <div className="form-group" key={field}>
                  <label>{paramLabels[field] || field}</label>
                  <input type={field === 'password' ? 'password' : 'text'} value={credForm[field] || ''} onChange={(e) => setCredForm({ ...credForm, [field]: e.target.value })} autoFocus={field === preConnectFields[0]} />
                </div>
              ))}
              <button className="btn-primary w-full" type="submit">Connect</button>
              <button className="btn w-full mt-2" type="button" onClick={() => navigate('/')}>Cancel</button>
            </form>
          </div>
        </div>
      )}

      {sshRequired && (
        <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: 'rgba(0,0,0,0.85)' }}>
          <div className="card w-full max-w-[400px]">
            <h2 className="!mb-1">Credentials Required</h2>
            <p className="text-txt-secondary text-sm mb-4">The remote server requires authentication.</p>
            <form onSubmit={(e) => { e.preventDefault(); submitSshCredentials(); }}>
              {sshRequired.map((param) => (
                <div className="form-group" key={param}>
                  <label>{paramLabels[param] || param}</label>
                  <input type={param === 'password' ? 'password' : 'text'} value={credForm[param] || ''} onChange={(e) => setCredForm({ ...credForm, [param]: e.target.value })} autoFocus={param === sshRequired[0]} />
                </div>
              ))}
              <button className="btn-primary w-full" type="submit">Connect</button>
            </form>
          </div>
        </div>
      )}
    </div>,
    document.getElementById('root')!
  );
}

/** Attach a session's display element into a container and scale to fit. */
function attachSession(session: GuacSession, container: HTMLElement) {
  // Don't steal the display element from an open popup window
  if (session._popout && !session._popout.window.closed) return;

  const display = session.client.getDisplay();
  const el = session.displayEl;

  if (el.parentElement !== container) {
    container.innerHTML = '';
    container.appendChild(el);
  }

  const dw = display.getWidth();
  const dh = display.getHeight();
  if (dw > 0 && dh > 0) {
    display.scale(Math.min(container.clientWidth / dw, container.clientHeight / dh));
  }

  container.focus();
}
