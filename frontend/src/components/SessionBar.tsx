import { useRef, useEffect, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSessionManager, GuacSession } from './SessionManager';
import { createShareLink } from '../api';
import FileBrowser from './FileBrowser';

export default function SessionBar() {
  const { 
    sessions, 
    activeSessionId, 
    setActiveSessionId, 
    closeSession, 
    tiledSessionIds, 
    setTiledSessionIds,
    sessionBarCollapsed,
    setSessionBarCollapsed,
    canShare,
  } = useSessionManager();
  
  const navigate = useNavigate();
  const location = useLocation();
  const isTiledRoute = location.pathname === '/tiled';

  // Keyboard Shortcuts Constants
  const KEY_SYMS = {
    CTRL_L: 0xFFE3,
    ALT_L: 0xFFE9,
    DELETE: 0xFFFF,
    SUPER_L: 0xFFEB,
    TAB: 0xFF09,
    ESCAPE: 0xFF1B,
    F11: 0xFFC8,
  };

  const KEYBOARD_COMBOS = [
    { label: 'C+A+Del', title: 'Ctrl+Alt+Delete', keys: [KEY_SYMS.CTRL_L, KEY_SYMS.ALT_L, KEY_SYMS.DELETE] },
    { label: '⊞ Win', title: 'Windows key', keys: [KEY_SYMS.SUPER_L] },
    { label: 'Alt+Tab', title: 'Switch windows', keys: [KEY_SYMS.ALT_L, KEY_SYMS.TAB] },
    { label: 'Esc', title: 'Escape', keys: [KEY_SYMS.ESCAPE] },
    { label: 'F11', title: 'F11 (Fullscreen)', keys: [KEY_SYMS.F11] },
    { label: 'C+A+T', title: 'Ctrl+Alt+T (Terminal)', keys: [KEY_SYMS.CTRL_L, KEY_SYMS.ALT_L, 0x0074] },
  ];
  // Tools state
  const [shareOpen, setShareOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Draggable toggle-tab state (vertical offset from center, in px)
  const [tabOffsetY, setTabOffsetY] = useState(0);
  const dragRef = useRef<{ startY: number; startOffset: number } | null>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId);

  // Reset toggle-tab position to center when session count changes
  const sessionCount = sessions.length;
  useEffect(() => { setTabOffsetY(0); }, [sessionCount]);

  // Drag handlers for the collapsed toggle tab
  const tabButtonRef = useRef<HTMLButtonElement>(null);

  const onTabPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startY: e.clientY, startOffset: tabOffsetY };
    tabButtonRef.current?.setPointerCapture(e.pointerId);
  }, [tabOffsetY]);

  const onTabPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || !sessionBarCollapsed) return;
    const delta = e.clientY - dragRef.current.startY;
    const maxOffset = window.innerHeight / 2 - 48; // keep within viewport
    const newOffset = Math.max(-maxOffset, Math.min(maxOffset, dragRef.current.startOffset + delta));
    setTabOffsetY(newOffset);
  }, [sessionBarCollapsed]);

  const onTabPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const wasDrag = sessionBarCollapsed && Math.abs(e.clientY - dragRef.current.startY) >= 4;
    dragRef.current = null;
    // If it was a real drag, don't toggle — just reposition
    if (wasDrag) return;
    // Otherwise treat as a click: toggle the bar
    setSessionBarCollapsed(!sessionBarCollapsed);
  }, [sessionBarCollapsed, setSessionBarCollapsed]);

  // Sync fullscreen state
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Close share popover on outside click
  useEffect(() => {
    if (!shareOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [shareOpen]);

  const handleShare = useCallback(async (mode: 'view' | 'control' = 'view') => {
    if (!activeSession) return;
    setShareLoading(true);
    setShareUrl(null);
    setCopied(false);
    try {
      const result = await createShareLink(activeSession.connectionId, mode);
      const fullUrl = `${window.location.origin}${result.share_url}`;
      setShareUrl(fullUrl);
      setShareOpen(true);
    } catch {
      // ignore
    } finally {
      setShareLoading(false);
    }
  }, [activeSession]);

  const handleCopy = useCallback(() => {
    if (shareUrl) {
      navigator.clipboard?.writeText(shareUrl).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [shareUrl]);

  const sendCombo = useCallback((keys: number[]) => {
    if (!activeSession) return;
    const { client } = activeSession;
    // Press all keys
    for (const k of keys) client.sendKeyEvent(1, k);
    // Release in reverse order
    for (const k of [...keys].reverse()) client.sendKeyEvent(0, k);
  }, [activeSession]);
 
  if (sessions.length === 0) return null;
 
  const displayWidth = sessionBarCollapsed ? 0 : 220;
 
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
    <>
    <div className="session-bar" style={{ width: displayWidth }}>
      {/* Toggle Tab — draggable vertically when collapsed */}
      <button
        ref={tabButtonRef}
        className="absolute -left-8 w-8 h-24 flex flex-col items-center justify-center rounded-l-xl transition-all duration-200"
        style={{ 
          top: `calc(50% + ${tabOffsetY}px)`,
          transform: 'translateY(-50%)',
          background: 'rgba(15, 15, 20, 0.75)', 
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRight: 'none',
          cursor: sessionBarCollapsed ? 'grab' : 'pointer',
          touchAction: 'none',
        }}
        onPointerDown={onTabPointerDown}
        onPointerMove={onTabPointerMove}
        onPointerUp={onTabPointerUp}
        title={sessionBarCollapsed ? 'Drag to reposition · Click to expand' : 'Collapse sessions'}
      >
        <svg 
          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: sessionBarCollapsed ? 'none' : 'rotate(180deg)', transition: 'transform 0.3s' }}
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        {sessionBarCollapsed && sessions.length > 0 && (
          <div className="mt-2 text-[0.65rem] font-bold text-accent-light">
            {sessions.length}
          </div>
        )}
      </button>
 
      {/* Main Content (only visible when expanded or we can just hide it with overflow) */}
      <div className={`w-full h-full flex flex-col items-center transition-opacity duration-200 ${sessionBarCollapsed ? 'opacity-0 pointer-events-none hidden' : 'opacity-100'}`}>
        <div className="w-full flex items-center justify-between p-3 border-b border-white/5">
          <span className="text-[0.65rem] font-bold text-txt-secondary uppercase tracking-widest">Active Sessions</span>
          <div className="session-count-badge !mt-0">{sessions.length}</div>
        </div>

        {activeSession && (
          <div className="w-full p-3 border-b border-white/5 space-y-3">
            <div className="text-[0.65rem] font-bold text-txt-secondary uppercase tracking-widest mb-2">Quick Tools</div>
            <div className="flex items-center gap-2">
              {/* Share */}
              {canShare && (
                <button
                  className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${shareOpen ? 'bg-accent/20 border-accent/40 text-accent-light' : 'bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20'}`}
                  onClick={() => setShareOpen(!shareOpen)}
                  disabled={shareLoading}
                  title="Share connection"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                </button>
              )}

              {/* Files */}
              {activeSession.filesystems.length > 0 && (
                <button
                  className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${fileBrowserOpen ? 'bg-accent/20 border-accent/40 text-accent-light' : 'bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20'}`}
                  onClick={() => setFileBrowserOpen(!fileBrowserOpen)}
                  title="Browse files"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                  </svg>
                </button>
              )}

              {/* Fullscreen */}
              <button
                className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${isFullscreen ? 'bg-accent/20 border-accent/40 text-accent-light' : 'bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20'}`}
                onClick={() => {
                  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                  else document.documentElement.requestFullscreen().catch(() => {});
                }}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {isFullscreen ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                )}
              </button>

              {/* Pop-out */}
              {(activeSession.popOut || activeSession.popIn) && (
                <button
                  className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${activeSession.isPoppedOut ? 'bg-accent/20 border-accent/40 text-accent-light' : 'bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20'}`}
                  onClick={() => activeSession.isPoppedOut ? activeSession.popIn?.() : activeSession.popOut?.()}
                  title={activeSession.isPoppedOut ? 'Return to window' : 'Pop out'}
                >
                  {activeSession.isPoppedOut ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 4 4 4 4 9" /><line x1="4" y1="4" x2="11" y2="11" /><rect x="10" y="10" width="11" height="11" rx="2" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 3 21 3 21 9" /><line x1="21" y1="3" x2="13" y2="11" /><rect x="3" y="3" width="11" height="11" rx="2" />
                    </svg>
                  )}
                </button>
              )}

              {/* Keyboard */}
              <button
                className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${keyboardOpen ? 'bg-accent/20 border-accent/40 text-accent-light' : 'bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20'}`}
                onClick={() => setKeyboardOpen(!keyboardOpen)}
                title="Keyboard Shortcuts"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" /><line x1="6" y1="8" x2="6" y2="8" /><line x1="10" y1="8" x2="10" y2="8" /><line x1="14" y1="8" x2="14" y2="8" /><line x1="18" y1="8" x2="18" y2="8" /><line x1="6" y1="12" x2="6" y2="12" /><line x1="10" y1="12" x2="10" y2="12" /><line x1="14" y1="12" x2="14" y2="12" /><line x1="18" y1="12" x2="18" y2="12" /><line x1="7" y1="16" x2="17" y2="16" />
                </svg>
              </button>
            </div>

            {/* Keyboard Shortcuts List */}
            {keyboardOpen && (
              <div className="grid grid-cols-2 gap-2 mt-4 animate-in fade-in slide-in-from-top-2 duration-200">
                {KEYBOARD_COMBOS.map((combo) => (
                  <button
                    key={combo.label}
                    className="flex flex-col items-center justify-center gap-1 p-2 h-14 rounded border border-white/5 bg-white/5 hover:bg-white/10 transition-all active:scale-95"
                    onClick={() => sendCombo(combo.keys)}
                    title={combo.title}
                  >
                    <span className="text-[0.65rem] font-bold text-txt-primary">{combo.label}</span>
                    <span className="text-[0.5rem] text-txt-tertiary uppercase tracking-tighter truncate w-full text-center">{combo.title}</span>
                  </button>
                ))}
              </div>
            )}
            {/* Share Popover Implementation */}
            {shareOpen && (
              <div
                ref={popoverRef}
                className="mt-4 p-3 rounded-lg bg-surface border border-white/10 shadow-xl animate-in fade-in slide-in-from-top-2 duration-200"
              >
                <div className="text-[0.65rem] font-bold text-txt-secondary uppercase tracking-widest mb-3">Share Connection</div>
                
                {shareUrl ? (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={shareUrl}
                        className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[0.7rem] font-mono text-txt-primary"
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        className="px-2 rounded bg-accent/20 border border-accent/40 text-accent-light"
                        onClick={handleCopy}
                      >
                        {copied ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                          </svg>
                        )}
                      </button>
                    </div>
                    <button
                      className="text-[0.65rem] text-accent-light/60 hover:text-accent-light underline"
                      onClick={() => { setShareUrl(null); setCopied(false); }}
                    >
                      Generate new link
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      className="flex flex-col items-center gap-1.5 p-2 rounded border border-white/5 bg-white/5 hover:bg-white/10 transition-colors"
                      onClick={() => handleShare('view')}
                      disabled={shareLoading}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                      </svg>
                      <span className="text-[0.6rem] font-medium tracking-tight">View Only</span>
                    </button>
                    <button
                      className="flex flex-col items-center gap-1.5 p-2 rounded border border-white/5 bg-white/5 hover:bg-white/10 transition-colors"
                      onClick={() => handleShare('control')}
                      disabled={shareLoading}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                      <span className="text-[0.6rem] font-medium tracking-tight">Control</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="session-thumbs-container">
          {isTiledRoute && tiledSessionIds.length > 0 && (
            <button
              className="w-full shrink-0 text-[0.7rem] font-semibold px-3 py-2.5 rounded-sm cursor-pointer transition-all duration-150 mb-2"
              style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)', border: '1px solid var(--color-accent)' }}
              onClick={() => { setTiledSessionIds([]); navigate('/'); }}
              title="Exit tiled view"
            >
              <div className="flex items-center justify-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                </svg>
                <span>Exit Tiled ({tiledSessionIds.length})</span>
              </div>
            </button>
          )}
          
          <div className="flex flex-col gap-3">
            {sessions.map((session) => (
              <SessionThumbnail
                key={session.id}
                session={session}
                isActive={session.id === activeSessionId}
                onSwitch={() => handleSwitch(session)}
                sessionBarCollapsed={sessionBarCollapsed}
                onClose={(e) => handleClose(e, session)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>

    {/* File Browser Overlay Overlay (Full Height, next to the bar) */}
    {fileBrowserOpen && activeSession && (
      <div 
        className="fixed top-0 bottom-0 z-[101] w-[320px] bg-surface-secondary border-l border-white/10 shadow-2xl flex flex-col"
        style={{ right: sessionBarCollapsed ? 0 : 220 }}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/5 bg-black/20">
          <span className="text-sm font-bold tracking-tight">File Browser</span>
          <button 
            onClick={() => setFileBrowserOpen(false)}
            className="text-txt-secondary hover:text-txt-primary"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <FileBrowser 
            filesystem={activeSession.filesystems[0]} 
            onClose={() => setFileBrowserOpen(false)} 
          />
        </div>
      </div>
    )}
    </>
  );
}

function SessionThumbnail({
  session, isActive, onSwitch, onClose, sessionBarCollapsed,
}: {
  session: GuacSession;
  isActive: boolean;
  onSwitch: () => void;
  onClose: (e: React.MouseEvent) => void;
  sessionBarCollapsed: boolean;
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
      title={sessionBarCollapsed ? undefined : session.name}
    >
      <canvas
        ref={canvasRef}
        width={192}
        height={108}
        className="block w-full object-cover bg-black"
      />
      {!sessionBarCollapsed && (
        <>
          {/* Label Overlay */}
          <div className="absolute bottom-0 left-0 right-0 p-2 pt-6 bg-gradient-to-t from-black/90 via-black/40 to-transparent pointer-events-none flex items-center gap-2 min-w-0 z-10">
            <span className="text-[0.55rem] font-bold tracking-wide px-1.5 py-0.5 rounded bg-accent/30 text-accent-light shrink-0 border border-white/10 backdrop-blur-sm">
              {session.protocol.toUpperCase()}
            </span>
            <span className="text-[0.75rem] font-bold text-white whitespace-nowrap overflow-hidden text-ellipsis min-w-0 drop-shadow-md">
              {session.name}
            </span>
          </div>
          <button
            className="absolute top-1 right-1 w-[22px] h-[22px] flex items-center justify-center rounded border-0 bg-danger text-white cursor-pointer opacity-85 p-0 transition-all duration-150 hover:opacity-100 hover:scale-110"
            style={{ background: 'var(--color-danger)', zIndex: 10 }}
            onClick={onClose}
            title="Close Session"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </>
      )}
       {!sessionBarCollapsed && (
        <>
          {/* Error Overlay */}
          {session.error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-[1px] p-2 text-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="2" className="mb-1">
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-[0.6rem] font-bold text-danger leading-tight uppercase">Session Ended</span>
              <span className="text-[0.55rem] text-txt-secondary leading-tight mt-0.5 max-w-full truncate px-1">
                {session.error.includes('terminated') ? 'Terminated by Admin' : 'Connection Lost'}
              </span>
            </div>
          )}

          {isActive && !session.error && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t bg-accent" />
          )}
        </>
      )}

    </div>
  );
}
