import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSessionManager, GuacSession } from './SessionManager';

export default function SessionBar() {
  const { sessions, activeSessionId, setActiveSessionId, closeSession, tiledSessionIds, setTiledSessionIds } = useSessionManager();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const isTiledRoute = location.pathname === '/tiled';

  if (sessions.length === 0) return null;

  function handleSwitch(session: GuacSession) {
    setActiveSessionId(session.id);
    navigate(`/session/${session.connectionId}`);
  }

  function handleClose(e: React.MouseEvent, session: GuacSession) {
    e.stopPropagation();
    closeSession(session.id);
    if (sessions.length <= 1) {
      navigate('/');
    }
  }

  return (
    <div className={`session-bar ${collapsed ? 'h-9' : ''}`}>
      {/* Toggle grip */}
      <button
        className="flex items-center gap-1.5 px-3 py-2 bg-transparent border-0 self-stretch shrink-0 text-txt-secondary text-xs font-semibold cursor-pointer transition-colors duration-150 hover:text-txt-primary"
        style={{ borderRight: '1px solid var(--color-border)' }}
        onClick={() => setCollapsed(!collapsed)}
        title={collapsed ? 'Expand session bar' : 'Collapse session bar'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d={collapsed ? 'M4 10L8 6L12 10' : 'M4 6L8 10L12 6'}
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent-dim text-accent-light text-[0.65rem] font-bold">
          {sessions.length}
        </span>
      </button>

      {!collapsed && (
        <div className="flex gap-2 px-3 py-2 overflow-x-auto flex-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--color-border) transparent' }}>
          {isTiledRoute && tiledSessionIds.length > 0 && (
            <button
              className="shrink-0 text-[0.7rem] font-semibold px-3 py-1 rounded-sm cursor-pointer transition-all duration-150 self-center"
              style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)', border: '1px solid var(--color-accent)' }}
              onClick={() => { setTiledSessionIds([]); navigate('/'); }}
              title="Exit tiled view"
            >
              <span className="flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                </svg>
                Tiled ({tiledSessionIds.length})
              </span>
            </button>
          )}
          {sessions.map((session) => (
            <SessionThumbnail
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onSwitch={() => handleSwitch(session)}
              onClose={(e) => handleClose(e, session)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionThumbnail({
  session, isActive, onSwitch, onClose,
}: {
  session: GuacSession;
  isActive: boolean;
  onSwitch: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    function capture() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const sourceEl = session.displayEl;
      const sourceCanvas = sourceEl.querySelector('canvas');
      if (!sourceCanvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const sw = sourceCanvas.width;
      const sh = sourceCanvas.height;
      if (sw <= 0 || sh <= 0) return;

      const tw = canvas.width;
      const th = canvas.height;
      const scale = Math.min(tw / sw, th / sh);
      const dx = (tw - sw * scale) / 2;
      const dy = (th - sh * scale) / 2;

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(sourceCanvas, dx, dy, sw * scale, sh * scale);
    }

    capture();
    intervalRef.current = setInterval(capture, 2000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [session.id, session.displayEl]);

  return (
    <div
      className={`session-thumb ${isActive ? 'session-thumb-active' : ''} ${session.error ? 'session-thumb-error' : ''}`}
      onClick={onSwitch}
      title={session.name}
    >
      <canvas
        ref={canvasRef}
        width={192}
        height={108}
        className="block w-full h-[72px] object-cover bg-black"
      />
      <div className="flex items-center gap-1.5 px-2 py-1 min-w-0">
        <span className="text-[0.55rem] font-bold tracking-wide px-1.5 py-0.5 rounded bg-accent-dim text-accent-light shrink-0">
          {session.protocol.toUpperCase()}
        </span>
        <span className="text-[0.7rem] font-medium text-txt-primary whitespace-nowrap overflow-hidden text-ellipsis min-w-0">
          {session.name}
        </span>
      </div>
      <button
        className="absolute top-1 right-1 w-[22px] h-[22px] flex items-center justify-center rounded border-0 bg-danger text-white cursor-pointer opacity-85 p-0 transition-all duration-150 hover:opacity-100 hover:scale-110"
        style={{ background: 'var(--color-danger)' }}
        onClick={onClose}
        title="Disconnect"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {isActive && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t bg-accent" />
      )}
    </div>
  );
}
