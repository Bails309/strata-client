import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import Guacamole from 'guacamole-common-js';
import { useSessionManager, GuacSession } from '../components/SessionManager';
import { useSidebarWidth } from '../components/Layout';

/**
 * Computes a grid layout (cols × rows) to best fill the available space
 * for `n` tiles, minimizing wasted area.
 */
function computeGrid(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

export default function TiledView() {
  const navigate = useNavigate();
  const sidebarWidth = useSidebarWidth();
  const {
    sessions,
    tiledSessionIds,
    focusedSessionIds,
    setFocusedSessionIds,
    setActiveSessionId,
    closeSession,
  } = useSessionManager();
  const [barHeight, setBarHeight] = useState(0);
  // Map of sessionId → list of required parameter names (for onrequired prompts)
  const [requiredCreds, setRequiredCreds] = useState<Record<string, string[]>>({});

  // The sessions that are currently tiled
  const tiledSessions = useMemo(
    () => tiledSessionIds
      .map((id) => sessions.find((s) => s.id === id))
      .filter(Boolean) as GuacSession[],
    [tiledSessionIds, sessions],
  );

  const { cols, rows } = useMemo(() => computeGrid(tiledSessions.length), [tiledSessions.length]);

  // Observe session bar height
  useEffect(() => {
    const barEl = document.querySelector('.session-bar') as HTMLElement | null;
    if (!barEl) { setBarHeight(0); return; }
    setBarHeight(barEl.offsetHeight);
    const ro = new ResizeObserver(([entry]) => {
      setBarHeight(entry.target instanceof HTMLElement ? entry.target.offsetHeight : 0);
    });
    ro.observe(barEl);
    return () => ro.disconnect();
  }, [sessions.length]);

  // If no tiled sessions, go home
  useEffect(() => {
    if (tiledSessions.length === 0) navigate('/');
  }, [tiledSessions.length, navigate]);

  // Listen for onrequired on each tiled session (guacd asking for credentials)
  useEffect(() => {
    for (const session of tiledSessions) {
      session.client.onrequired = (parameters: string[]) => {
        setRequiredCreds((prev) => ({ ...prev, [session.id]: parameters }));
      };
    }
    return () => {
      for (const session of tiledSessions) {
        session.client.onrequired = null;
      }
    };
  }, [tiledSessions]);

  // Submit credentials for a tile
  const submitTileCreds = useCallback((sessionId: string, creds: Record<string, string>) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const params = requiredCreds[sessionId] || [];
    for (const param of params) {
      const value = creds[param] || '';
      const stream = session.client.createArgumentValueStream('text/plain', param);
      const writer = new Guacamole.StringWriter(stream);
      writer.sendText(value);
      writer.sendEnd();
    }
    setRequiredCreds((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, [sessions, requiredCreds]);

  // Keyboard management — broadcast to all focused sessions
  useEffect(() => {
    const focusedSessions = sessions.filter((s) => focusedSessionIds.includes(s.id));

    // Wire up keyboards for focused sessions
    for (const s of focusedSessions) {
      s.keyboard.onkeydown = (keysym: number) => {
        s.client.sendKeyEvent(1, keysym);
        return true;
      };
      s.keyboard.onkeyup = (keysym: number) => {
        s.client.sendKeyEvent(0, keysym);
      };
    }

    // Disconnect keyboards for unfocused sessions
    for (const s of sessions) {
      if (!focusedSessionIds.includes(s.id)) {
        s.keyboard.onkeydown = null;
        s.keyboard.onkeyup = null;
      }
    }

    // Capture-phase trap — only prevent default when there are focused tiles
    const trapKeyDown = (e: KeyboardEvent) => {
      if (focusedSessions.length === 0) return;
      if (e.key === 'F12') return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) return;
      // Allow Ctrl+click modifiers to pass through for multi-focus
      if (e.key === 'Control' || e.key === 'Shift') return;
      e.preventDefault();
    };
    document.addEventListener('keydown', trapKeyDown, true);

    return () => {
      document.removeEventListener('keydown', trapKeyDown, true);
      for (const s of focusedSessions) {
        s.keyboard.onkeydown = null;
        s.keyboard.onkeyup = null;
      }
    };
  }, [focusedSessionIds, sessions]);

  // Handle closing a tile
  const handleCloseTile = useCallback((sessionId: string) => {
    closeSession(sessionId);
  }, [closeSession]);

  // Handle tile click for focus management
  const handleTileClick = useCallback((sessionId: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle this tile in/out of focus set
      setFocusedSessionIds(
        focusedSessionIds.includes(sessionId)
          ? focusedSessionIds.filter((id) => id !== sessionId)
          : [...focusedSessionIds, sessionId],
      );
    } else {
      // Normal click: focus only this tile
      setFocusedSessionIds([sessionId]);
      setActiveSessionId(sessionId);
    }
  }, [focusedSessionIds, setFocusedSessionIds, setActiveSessionId]);

  if (tiledSessions.length === 0) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: sidebarWidth,
        right: 0,
        bottom: barHeight,
        zIndex: 5,
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: 2,
        background: '#000',
        transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {tiledSessions.map((session) => (
        <TiledTile
          key={session.id}
          session={session}
          isFocused={focusedSessionIds.includes(session.id)}
          onClick={(e) => handleTileClick(session.id, e)}
          onClose={() => handleCloseTile(session.id)}
          requiredParams={requiredCreds[session.id] || null}
          onSubmitCreds={(creds) => submitTileCreds(session.id, creds)}
        />
      ))}
    </div>,
    document.getElementById('root')!,
  );
}

/* ── Individual tile ── */

function TiledTile({
  session,
  isFocused,
  onClick,
  onClose,
  requiredParams,
  onSubmitCreds,
}: {
  session: GuacSession;
  isFocused: boolean;
  onClick: (e: React.MouseEvent) => void;
  onClose: () => void;
  requiredParams: string[] | null;
  onSubmitCreds: (creds: Record<string, string>) => void;
}) {
  const tileRef = useRef<HTMLDivElement>(null);
  const [credForm, setCredForm] = useState<Record<string, string>>({});

  // Attach the display element
  useEffect(() => {
    const container = tileRef.current;
    if (!container) return;
    const el = session.displayEl;
    if (el.parentElement !== container) {
      container.appendChild(el);
    }
  }, [session]);

  // Scale display to fit tile
  useEffect(() => {
    const container = tileRef.current;
    if (!container) return;
    const display = session.client.getDisplay();

    function rescale() {
      const cw = container!.clientWidth;
      const ch = container!.clientHeight;
      const dw = display.getWidth();
      const dh = display.getHeight();
      if (cw <= 0 || ch <= 0 || dw <= 0 || dh <= 0) return;
      display.scale(Math.min(cw / dw, ch / dh));
    }

    rescale();
    const ro = new ResizeObserver(rescale);
    ro.observe(container);
    return () => ro.disconnect();
  }, [session]);

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        border: isFocused ? '2px solid var(--color-accent)' : '2px solid transparent',
        borderRadius: 2,
        transition: 'border-color 0.15s',
      }}
      onMouseDown={onClick}
    >
      {/* Title bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '3px 8px',
          background: isFocused ? 'var(--color-accent)' : 'var(--color-surface-tertiary)',
          color: isFocused ? '#fff' : 'var(--color-txt-secondary)',
          fontSize: '0.7rem',
          fontWeight: 600,
          letterSpacing: '0.01em',
          userSelect: 'none',
          flexShrink: 0,
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <span style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: 3,
            background: isFocused ? 'rgba(255,255,255,0.2)' : 'var(--color-accent-dim)',
            color: isFocused ? '#fff' : 'var(--color-accent-light)',
          }}>
            {session.protocol.toUpperCase()}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.name}
          </span>
        </span>
        <button
          onMouseDown={(e) => { e.stopPropagation(); onClose(); }}
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: '2px',
            lineHeight: 0,
            opacity: 0.7,
            flexShrink: 0,
          }}
          title="Disconnect"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Session canvas container */}
      <div
        ref={tileRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          background: '#000',
          cursor: requiredParams ? 'default' : 'none',
        }}
      />

      {/* Per-tile credential prompt */}
      {requiredParams && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            inset: 0,
            top: 24, // below title bar
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.85)',
            zIndex: 2,
            padding: 12,
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmitCreds(credForm);
              setCredForm({});
            }}
            style={{
              width: '100%',
              maxWidth: 260,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#fff', marginBottom: 2 }}>
              Credentials Required
            </div>
            {requiredParams.map((param) => (
              <input
                key={param}
                type={param === 'password' ? 'password' : 'text'}
                placeholder={param.charAt(0).toUpperCase() + param.slice(1)}
                value={credForm[param] || ''}
                onChange={(e) => setCredForm((prev) => ({ ...prev, [param]: e.target.value }))}
                autoFocus={param === requiredParams[0]}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  fontSize: '0.75rem',
                  borderRadius: 4,
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-input-bg)',
                  color: 'var(--color-txt-primary)',
                }}
              />
            ))}
            <button
              type="submit"
              className="btn-sm-primary"
              style={{ justifyContent: 'center', width: '100%' }}
            >
              Connect
            </button>
          </form>
        </div>
      )}

      {session.error && !requiredParams && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.8)',
          color: 'var(--color-danger)',
          fontSize: '0.75rem',
          fontWeight: 500,
          padding: 16,
          textAlign: 'center',
        }}>
          {session.error}
        </div>
      )}
    </div>
  );
}
