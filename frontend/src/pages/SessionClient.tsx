import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import Guacamole from 'guacamole-common-js';
import { getConnectionInfo, getConnections } from '../api';
import { useSessionManager, GuacSession } from '../components/SessionManager';
import { useSidebarWidth } from '../components/Layout';
import SessionToolbar from '../components/SessionToolbar';
import TouchToolbar from '../components/TouchToolbar';

/*
 * Phases:
 *  1. "loading"   – fetching connection info from the backend
 *  2. "prompt"    – no stored credentials; show pre-connect credential form
 *  3. "connected" – WebSocket tunnel open, Guacamole session running
 */
type Phase = 'loading' | 'prompt' | 'connected';

export default function SessionClient() {
  const { connectionId } = useParams<{ connectionId: string }>();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const { sessions, activeSessionId, setActiveSessionId, createSession, getSession } = useSessionManager();
  const sidebarWidth = useSidebarWidth();

  const [phase, setPhase] = useState<Phase>('loading');
  const [protocol, setProtocol] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [credForm, setCredForm] = useState<Record<string, string>>({ username: '', password: '', domain: '' });
  const [error, setError] = useState('');
  const [sshRequired, setSshRequired] = useState<string[] | null>(null);
  const [hasDomain, setHasDomain] = useState(false);
  const pendingCredsRef = useRef<{ username: string; password: string }>({ username: '', password: '' });
  const containerFocusedRef = useRef(false);

  const [barHeight, setBarHeight] = useState(0);

  // Find the session for this connection
  const currentSession = sessions.find(
    (s) => s.connectionId === connectionId && s.id === activeSessionId
  ) || sessions.find((s) => s.connectionId === connectionId);

  // ── Observe session bar height to offset the session container ──
  useEffect(() => {
    const barEl = document.querySelector('.session-bar') as HTMLElement | null;
    if (!barEl) {
      setBarHeight(0);
      return;
    }
    setBarHeight(barEl.offsetHeight);
    const ro = new ResizeObserver(([entry]) => {
      setBarHeight(entry.target instanceof HTMLElement ? entry.target.offsetHeight : 0);
    });
    ro.observe(barEl);
    return () => ro.disconnect();
  }, [sessions.length]); // re-run when sessions appear/disappear

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

  // ── Phase 2 → 3: user submits credentials ──
  const handlePreConnectSubmit = useCallback(() => {
    pendingCredsRef.current = {
      username: credForm.username || '',
      password: credForm.password || '',
    };
    setPhase('connected');
  }, [credForm]);

  // ── Phase 3: Create or attach session ──
  useEffect(() => {
    if (phase !== 'connected' || !connectionId || !containerRef.current) return;

    const existing = getSession(connectionId);
    if (existing) {
      attachSession(existing, containerRef.current);
      return;
    }

    const container = containerRef.current;

    // Defer to next frame so the fixed-position portal container has its final layout dimensions.
    const raf = requestAnimationFrame(() => {
      const token = localStorage.getItem('access_token') || '';
      const dpr = window.devicePixelRatio || 1;

      const connectParams = new URLSearchParams();
      connectParams.set('token', token);
      connectParams.set('width', String(container.clientWidth));
      connectParams.set('height', String(container.clientHeight));
      connectParams.set('dpi', String(Math.round(96 * dpr)));

      const creds = pendingCredsRef.current;
      if (creds.username) connectParams.set('username', creds.username);
      if (creds.password) connectParams.set('password', creds.password);

      const session = createSession({
        connectionId,
        name: connectionName || protocol.toUpperCase(),
        protocol,
        containerEl: container,
        connectParams,
      });

      session.tunnel.onerror = (status: Guacamole.Status) => {
        session.error = status.message || 'Connection failed';
        setError(`Tunnel error: ${session.error}`);
      };
      session.client.onerror = (status: Guacamole.Status) => {
        session.error = status.message || 'Connection failed';
        setError(`Error: ${session.error}`);
      };
      session.client.onrequired = (parameters: string[]) => {
        setSshRequired(parameters);
      };

      pendingCredsRef.current = { username: '', password: '' };
      setCredForm({ username: '', password: '', domain: '' });

      attachSession(session, container);
    });

    return () => cancelAnimationFrame(raf);
  }, [phase, connectionId, protocol, connectionName, createSession, getSession]);

  // Re-attach when switching back to an existing session
  useEffect(() => {
    if (!currentSession || !containerRef.current || phase !== 'connected') return;
    attachSession(currentSession, containerRef.current);
  }, [activeSessionId, currentSession, phase]);

  // Handle resize
  useEffect(() => {
    if (!currentSession || !containerRef.current) return;
    const container = containerRef.current;
    const client = currentSession.client;
    const display = client.getDisplay();

    function handleResize() {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw <= 0 || ch <= 0) return;

      const dw = display.getWidth();
      const dh = display.getHeight();
      if (dw > 0 && dh > 0) {
        display.scale(Math.min(cw / dw, ch / dh));
      }
      client.sendSize(cw, ch);
    }

    // Run once immediately to sync after attach
    handleResize();

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [currentSession, barHeight, sidebarWidth]);

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

    kb.onkeydown = (keysym: number) => {
      if (!containerFocusedRef.current) return false;
      client.sendKeyEvent(1, keysym);
      return true;
    };
    kb.onkeyup = (keysym: number) => {
      if (!containerFocusedRef.current) return;
      client.sendKeyEvent(0, keysym);
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
      right: 0,
      bottom: barHeight,
      zIndex: 5,
      transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
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

      {/* Session toolbar — share & file browser */}
      {currentSession && connectionId && (
        <>
          <SessionToolbar session={currentSession} connectionId={connectionId} />
          <TouchToolbar client={currentSession.client} />
        </>
      )}

      {phase === 'loading' && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black z-10">
          <p className="text-gray-500">Loading connection…</p>
        </div>
      )}

      {error && !sshRequired && phase !== 'prompt' && (
        <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: 'rgba(0,0,0,0.85)' }}>
          <div className="card max-w-[400px] text-center !p-8">
            <div className="text-3xl mb-2">⚠</div>
            <div className="text-red-500 text-base mb-6 break-words">{error}</div>
            <button className="btn-primary" onClick={() => navigate('/')}>Go Back</button>
          </div>
        </div>
      )}

      {phase === 'prompt' && (
        <div className="absolute inset-0 flex items-center justify-center z-10 overflow-auto p-4" style={{ background: 'var(--color-surface)' }}>
          <div className="card w-full max-w-[400px] m-auto">
            <h2 className="!mb-1">Connect to {protocol.toUpperCase()}</h2>
            <p className="text-txt-secondary text-sm mb-4">Enter credentials for the remote server.</p>
            <form onSubmit={(e) => { e.preventDefault(); handlePreConnectSubmit(); }}>
              {preConnectFields.map((field) => (
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
