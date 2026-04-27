import { useRef, useEffect, useState, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useSessionManager, GuacSession } from "./SessionManager";
import {
  createShareLink,
  getTags,
  getDisplayTags,
  setDisplayTag,
  removeDisplayTag,
  UserTag,
} from "../api";
import FileBrowser from "./FileBrowser";
import QuickShare from "./QuickShare";
import { requestFullscreenWithLock, exitFullscreenWithUnlock } from "../utils/keyboardLock";

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
    canUseQuickShare,
  } = useSessionManager();

  const navigate = useNavigate();
  const location = useLocation();
  const isTiledRoute = location.pathname === "/tiled";

  // Keyboard Shortcuts Constants
  const KEY_SYMS = {
    CTRL_L: 0xffe3,
    ALT_L: 0xffe9,
    DELETE: 0xffff,
    SUPER_L: 0xffeb,
    TAB: 0xff09,
    ESCAPE: 0xff1b,
    F11: 0xffc8,
  };

  const KEYBOARD_COMBOS = [
    {
      label: "C+A+Del",
      title: "Ctrl+Alt+Delete",
      keys: [KEY_SYMS.CTRL_L, KEY_SYMS.ALT_L, KEY_SYMS.DELETE],
    },
    { label: "⊞ Win", title: "Windows key", keys: [KEY_SYMS.SUPER_L] },
    { label: "Alt+Tab", title: "Switch windows", keys: [KEY_SYMS.ALT_L, KEY_SYMS.TAB] },
    {
      label: "Win+Tab",
      title: "Task View (or Ctrl+Alt+`)",
      keys: [KEY_SYMS.SUPER_L, KEY_SYMS.TAB],
    },
    { label: "Esc", title: "Escape", keys: [KEY_SYMS.ESCAPE] },
    { label: "F11", title: "F11 (Fullscreen)", keys: [KEY_SYMS.F11] },
    {
      label: "C+A+T",
      title: "Ctrl+Alt+T (Terminal)",
      keys: [KEY_SYMS.CTRL_L, KEY_SYMS.ALT_L, 0x0074],
    },
  ];
  // Tools state
  const [shareOpen, setShareOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [quickShareOpen, setQuickShareOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Draggable toggle-tab state (vertical offset from center, in px)
  const [tabOffsetY, setTabOffsetY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startOffset: number } | null>(null);

  // Display tag state
  const [userTags, setUserTags] = useState<UserTag[]>([]);
  const [displayTagMap, setDisplayTagMap] = useState<Record<string, UserTag>>({});

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  // Reset toggle-tab position to center when session count changes
  const sessionCount = sessions.length;
  useEffect(() => {
    setTabOffsetY(0);
  }, [sessionCount]);

  // Drag handlers for the collapsed toggle tab
  const tabButtonRef = useRef<HTMLButtonElement>(null);

  const onTabPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      dragRef.current = { startY: e.clientY, startOffset: tabOffsetY };
      if (tabButtonRef.current?.setPointerCapture) {
        tabButtonRef.current.setPointerCapture(e.pointerId);
      }
    },
    [tabOffsetY]
  );

  const onTabPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current || !sessionBarCollapsed) return;
      if (!isDragging) setIsDragging(true);
      const delta = e.clientY - dragRef.current.startY;
      const maxOffset = window.innerHeight / 2 - 48; // keep within viewport
      const newOffset = Math.max(
        -maxOffset,
        Math.min(maxOffset, dragRef.current.startOffset + delta)
      );
      setTabOffsetY(newOffset);
    },
    [sessionBarCollapsed, isDragging]
  );

  const onTabPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const wasDrag = sessionBarCollapsed && Math.abs(e.clientY - dragRef.current.startY) >= 4;
      dragRef.current = null;
      setIsDragging(false);
      // If it was a real drag, don't toggle — just reposition
      if (wasDrag) return;
      // Otherwise treat as a click: toggle the bar
      setSessionBarCollapsed(!sessionBarCollapsed);
    },
    [sessionBarCollapsed, setSessionBarCollapsed]
  );

  // Sync fullscreen state
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Load user tags and display-tag map whenever sessions change
  useEffect(() => {
    if (sessions.length > 0) {
      getTags()
        .then(setUserTags)
        .catch(() => {});
      getDisplayTags()
        .then(setDisplayTagMap)
        .catch(() => {});
    }
  }, [sessions.length]);

  const handleSetDisplayTag = useCallback(
    async (connectionId: string, tagId: string) => {
      try {
        await setDisplayTag(connectionId, tagId);
        const tag = userTags.find((t) => t.id === tagId);
        if (tag) setDisplayTagMap((prev) => ({ ...prev, [connectionId]: tag }));
      } catch {
        /* ignore */
      }
    },
    [userTags]
  );

  const handleRemoveDisplayTag = useCallback(async (connectionId: string) => {
    try {
      await removeDisplayTag(connectionId);
      setDisplayTagMap((prev) => {
        const next = { ...prev };
        delete next[connectionId];
        return next;
      });
    } catch {
      /* ignore */
    }
  }, []);

  // Refresh tags list (called when any tag picker is opened)
  const refreshTags = useCallback(() => {
    getTags()
      .then(setUserTags)
      .catch(() => {});
  }, []);

  // Close share popover on outside click
  useEffect(() => {
    if (!shareOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [shareOpen]);

  const handleShare = useCallback(
    async (mode: "view" | "control" = "view") => {
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
    },
    [activeSession]
  );

  const handleCopy = useCallback(() => {
    if (shareUrl) {
      navigator.clipboard?.writeText(shareUrl).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [shareUrl]);

  const sendCombo = useCallback(
    (keys: number[]) => {
      if (!activeSession) return;
      const { client } = activeSession;
      // Press all keys
      for (const k of keys) client.sendKeyEvent(1, k);
      // Release in reverse order
      for (const k of [...keys].reverse()) client.sendKeyEvent(0, k);
    },
    [activeSession]
  );

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
      navigate("/");
    }
  }

  function handleReconnect(e: React.MouseEvent, session: GuacSession) {
    e.stopPropagation();
    const connId = session.connectionId;
    // Signal SessionClient to handle the reconnect (close + recreate) so that
    // userDisconnectRef is set before the tunnel closes — preventing the
    // tunnel-close handler from redirecting to another session.
    navigate(`/session/${connId}`, { state: { reconnect: Date.now() } });
  }

  return (
    <>
      <div className="session-bar" style={{ width: displayWidth }} data-testid="session-bar">
        {/* Toggle Tab — draggable vertically when collapsed */}
        <button
          ref={tabButtonRef}
          className={`absolute -left-8 w-8 h-24 flex flex-col items-center justify-center rounded-l-xl ${isDragging ? "" : "transition-all duration-200"}`}
          style={{
            top: `calc(50% + ${tabOffsetY}px)`,
            transform: "translateY(-50%)",
            background: "rgba(15, 15, 20, 0.75)",
            backdropFilter: "blur(16px)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRight: "none",
            cursor: sessionBarCollapsed ? "grab" : "pointer",
            touchAction: "none",
          }}
          onPointerDown={onTabPointerDown}
          onPointerMove={onTabPointerMove}
          onPointerUp={onTabPointerUp}
          title={sessionBarCollapsed ? "Drag to reposition · Click to expand" : "Collapse sessions"}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: sessionBarCollapsed ? "none" : "rotate(180deg)",
              transition: "transform 0.3s",
            }}
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {sessionBarCollapsed && sessions.length > 0 && (
            <div className="mt-2 text-[0.65rem] font-bold text-accent-light">{sessions.length}</div>
          )}
        </button>

        {/* Main Content (only visible when expanded or we can just hide it with overflow) */}
        <div
          className={`w-full h-full flex flex-col items-center transition-opacity duration-200 ${sessionBarCollapsed ? "opacity-0 pointer-events-none hidden" : "opacity-100"}`}
        >
          <div className="w-full flex items-center justify-between p-3 border-b border-white/5">
            <span className="text-[0.65rem] font-bold text-txt-secondary uppercase tracking-widest">
              Active Sessions
            </span>
            <div className="session-count-badge !mt-0">{sessions.length}</div>
          </div>

          {activeSession && (
            <div className="w-full p-3 border-b border-white/5 space-y-3">
              <div className="text-[0.65rem] font-bold text-txt-secondary uppercase tracking-widest mb-2">
                Quick Tools
              </div>
              <div className="flex items-center gap-2">
                {/* Share */}
                {canShare && (
                  <button
                    className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${shareOpen ? "bg-accent/20 border-accent/40 text-accent-light" : "bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20"}`}
                    onClick={() => setShareOpen(!shareOpen)}
                    disabled={shareLoading}
                    title="Share connection"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="18" cy="5" r="3" />
                      <circle cx="6" cy="12" r="3" />
                      <circle cx="18" cy="19" r="3" />
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                    </svg>
                  </button>
                )}

                {/* Files — only when file transfer is enabled AND guacd exposed a filesystem */}
                {activeSession.fileTransferEnabled && activeSession.filesystems.length > 0 && (
                  <button
                    className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${fileBrowserOpen ? "bg-accent/20 border-accent/40 text-accent-light" : "bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20"}`}
                    onClick={() => setFileBrowserOpen(!fileBrowserOpen)}
                    title="Browse files"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    </svg>
                  </button>
                )}

                {/* Quick Share — gated by the role permission `can_use_quick_share`.
                    Uses the backend file-store, independent of guacd drive/SFTP. */}
                {canUseQuickShare && (
                  <button
                    className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${quickShareOpen ? "bg-accent/20 border-accent/40 text-accent-light" : "bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20"}`}
                    onClick={() => setQuickShareOpen(!quickShareOpen)}
                    title="Quick Share – upload files for download in remote session"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </button>
                )}

                {/* Fullscreen */}
                <button
                  className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${isFullscreen ? "bg-accent/20 border-accent/40 text-accent-light" : "bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20"}`}
                  onClick={() => {
                    if (document.fullscreenElement)
                      exitFullscreenWithUnlock(document).catch(() => {});
                    else requestFullscreenWithLock(document.documentElement).catch(() => {});
                  }}
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="4 14 10 14 10 20" />
                      <polyline points="20 10 14 10 14 4" />
                      <line x1="14" y1="10" x2="21" y2="3" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  )}
                </button>

                {/* Pop-out */}
                {(activeSession.popOut || activeSession.popIn) && (
                  <button
                    className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${activeSession.isPoppedOut ? "bg-accent/20 border-accent/40 text-accent-light" : "bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20"}`}
                    onClick={() =>
                      activeSession.isPoppedOut ? activeSession.popIn?.() : activeSession.popOut?.()
                    }
                    title={activeSession.isPoppedOut ? "Return to window" : "Pop out"}
                  >
                    {activeSession.isPoppedOut ? (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="9 4 4 4 4 9" />
                        <line x1="4" y1="4" x2="11" y2="11" />
                        <rect x="10" y="10" width="11" height="11" rx="2" />
                      </svg>
                    ) : (
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="21" y1="3" x2="13" y2="11" />
                        <rect x="3" y="3" width="11" height="11" rx="2" />
                      </svg>
                    )}
                  </button>
                )}

                {/* Multi-Monitor */}
                {(activeSession.enableMultiMonitor || activeSession.disableMultiMonitor) && (
                  <button
                    className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${activeSession.isMultiMonitor ? "bg-accent/20 border-accent/40 text-accent-light" : "bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20"}`}
                    onClick={() =>
                      activeSession.isMultiMonitor
                        ? activeSession.disableMultiMonitor?.()
                        : activeSession.enableMultiMonitor?.()
                    }
                    title={
                      activeSession.isMultiMonitor
                        ? "Exit multi-monitor"
                        : `Multi-monitor${activeSession.screenCount ? ` (${activeSession.screenCount} screens detected)` : ""}`
                    }
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="1" y="3" width="9" height="7" rx="1" />
                      <rect x="14" y="3" width="9" height="7" rx="1" />
                      <line x1="7" y1="17" x2="17" y2="17" />
                      <line x1="12" y1="10" x2="12" y2="17" />
                    </svg>
                  </button>
                )}

                {/* Keyboard */}
                <button
                  className={`flex-1 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${keyboardOpen ? "bg-accent/20 border-accent/40 text-accent-light" : "bg-white/5 border-white/10 text-txt-secondary hover:bg-white/10 hover:border-white/20"}`}
                  onClick={() => setKeyboardOpen(!keyboardOpen)}
                  title="Keyboard Shortcuts"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <line x1="6" y1="8" x2="6" y2="8" />
                    <line x1="10" y1="8" x2="10" y2="8" />
                    <line x1="14" y1="8" x2="14" y2="8" />
                    <line x1="18" y1="8" x2="18" y2="8" />
                    <line x1="6" y1="12" x2="6" y2="12" />
                    <line x1="10" y1="12" x2="10" y2="12" />
                    <line x1="14" y1="12" x2="14" y2="12" />
                    <line x1="18" y1="12" x2="18" y2="12" />
                    <line x1="7" y1="16" x2="17" y2="16" />
                  </svg>
                </button>
              </div>

              {/* Keyboard Shortcuts List */}
              {keyboardOpen && (
                <div className="mt-4 animate-in fade-in slide-in-from-top-2 duration-200">
                  <div className="grid grid-cols-2 gap-2">
                    {KEYBOARD_COMBOS.map((combo) => (
                      <button
                        key={combo.label}
                        className="flex flex-col items-center justify-center gap-1 p-2 h-14 rounded border border-white/5 bg-white/5 hover:bg-white/10 transition-all active:scale-95"
                        onClick={() => sendCombo(combo.keys)}
                        title={combo.title}
                      >
                        <span className="text-[0.65rem] font-bold text-txt-primary">
                          {combo.label}
                        </span>
                        <span className="text-[0.5rem] text-txt-tertiary uppercase tracking-tighter truncate w-full text-center">
                          {combo.title}
                        </span>
                      </button>
                    ))}
                  </div>
                  {/* Keyboard shortcut reference */}
                  <div className="mt-3 pt-3 border-t border-white/5">
                    <div className="text-[0.55rem] font-bold text-txt-tertiary uppercase tracking-widest mb-2">
                      Keyboard Mappings
                    </div>
                    <div className="space-y-1.5 text-[0.6rem] text-txt-secondary">
                      <div className="flex justify-between">
                        <kbd className="text-txt-primary font-mono bg-white/5 px-1 rounded">
                          Right Ctrl
                        </kbd>
                        <span className="text-txt-tertiary">⊞ Win key</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <kbd className="text-txt-primary font-mono bg-white/5 px-1 rounded whitespace-nowrap">
                          Right Ctrl + key
                        </kbd>
                        <span className="text-txt-tertiary">Win+key</span>
                      </div>
                      <div className="flex justify-between">
                        <kbd className="text-txt-primary font-mono bg-white/5 px-1 rounded">
                          Ctrl+Alt+`
                        </kbd>
                        <span className="text-txt-tertiary">Win+Tab</span>
                      </div>
                      <div className="flex justify-between">
                        <kbd className="text-txt-primary font-mono bg-white/5 px-1 rounded">
                          Ctrl+K
                        </kbd>
                        <span className="text-txt-tertiary">Quick Launch</span>
                      </div>
                    </div>
                    <p className="mt-2 text-[0.5rem] text-txt-tertiary leading-relaxed">
                      Right Ctrl acts as the Win key for most combos (e.g. Win+E, Win+R). Right
                      Ctrl+Tab cannot send Win+Tab because the browser intercepts Ctrl+Tab — use
                      Ctrl+Alt+` instead.
                    </p>
                    <p className="mt-1 text-[0.5rem] text-accent-light/70 leading-relaxed">
                      Tip: In fullscreen mode over HTTPS, Win, Alt+Tab, and other OS shortcuts are
                      captured directly — no proxy keys needed.
                    </p>
                  </div>
                </div>
              )}
              {/* Share Popover Implementation */}
              {shareOpen && (
                <div
                  ref={popoverRef}
                  className="mt-4 p-3 rounded-lg bg-surface border border-white/10 shadow-xl animate-in fade-in slide-in-from-top-2 duration-200"
                >
                  <div className="text-[0.65rem] font-bold text-txt-secondary uppercase tracking-widest mb-3">
                    Share Connection
                  </div>

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
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <rect x="9" y="9" width="13" height="13" rx="2" />
                              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                            </svg>
                          )}
                        </button>
                      </div>
                      <button
                        className="text-[0.65rem] text-accent-light/60 hover:text-accent-light underline"
                        onClick={() => {
                          setShareUrl(null);
                          setCopied(false);
                        }}
                      >
                        Generate new link
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        className="flex flex-col items-center gap-1.5 p-2 rounded border border-white/5 bg-white/5 hover:bg-white/10 transition-colors"
                        onClick={() => handleShare("view")}
                        disabled={shareLoading}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#60a5fa"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        <span className="text-[0.6rem] font-medium tracking-tight">View Only</span>
                      </button>
                      <button
                        className="flex flex-col items-center gap-1.5 p-2 rounded border border-white/5 bg-white/5 hover:bg-white/10 transition-colors"
                        onClick={() => handleShare("control")}
                        disabled={shareLoading}
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#fb923c"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="2" y="3" width="20" height="14" rx="2" />
                          <line x1="8" y1="21" x2="16" y2="21" />
                          <line x1="12" y1="17" x2="12" y2="21" />
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
                style={{
                  background: "var(--color-accent-dim)",
                  color: "var(--color-accent-light)",
                  border: "1px solid var(--color-accent)",
                }}
                onClick={() => {
                  setTiledSessionIds([]);
                  navigate("/");
                }}
                title="Exit tiled view"
              >
                <div className="flex items-center justify-center gap-2">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="7" height="7" rx="1" />
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
                  onReconnect={(e) => handleReconnect(e, session)}
                  displayTag={displayTagMap[session.connectionId]}
                  userTags={userTags}
                  onSetDisplayTag={handleSetDisplayTag}
                  onRemoveDisplayTag={handleRemoveDisplayTag}
                  onTagPickerOpen={refreshTags}
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
              <svg
                width="18"
                height="18"
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
          <div className="flex-1 overflow-auto p-4">
            <FileBrowser
              filesystem={activeSession.filesystems[0]}
              onClose={() => setFileBrowserOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Quick Share Overlay (Full Height, next to the bar) */}
      {quickShareOpen && activeSession && (
        <QuickShare
          connectionId={activeSession.connectionId}
          onClose={() => setQuickShareOpen(false)}
          sidebarWidth={220}
          sessionBarCollapsed={sessionBarCollapsed}
        />
      )}
    </>
  );
}

function SessionThumbnail({
  session,
  isActive,
  onSwitch,
  onClose,
  onReconnect,
  sessionBarCollapsed,
  displayTag,
  userTags,
  onSetDisplayTag,
  onRemoveDisplayTag,
  onTagPickerOpen,
}: {
  session: GuacSession;
  isActive: boolean;
  onSwitch: () => void;
  onClose: (e: React.MouseEvent) => void;
  onReconnect: (e: React.MouseEvent) => void;
  sessionBarCollapsed: boolean;
  displayTag?: UserTag;
  userTags: UserTag[];
  onSetDisplayTag: (connectionId: string, tagId: string) => void;
  onRemoveDisplayTag: (connectionId: string) => void;
  onTagPickerOpen: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const tagPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function capture() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const sourceEl = session.displayEl;
      const sourceCanvas = sourceEl.querySelector("canvas");
      if (!sourceCanvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const sw = sourceCanvas.width;
      const sh = sourceCanvas.height;
      if (sw <= 0 || sh <= 0) return;

      const tw = canvas.width;
      const th = canvas.height;
      const scale = Math.min(tw / sw, th / sh);
      const dx = (tw - sw * scale) / 2;
      const dy = (th - sh * scale) / 2;

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(sourceCanvas, dx, dy, sw * scale, sh * scale);
    }

    capture();
    intervalRef.current = setInterval(capture, 2000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [session.id, session.displayEl]);

  // Close tag picker on outside click
  useEffect(() => {
    if (!tagPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (tagPickerRef.current && !tagPickerRef.current.contains(e.target as Node)) {
        setTagPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tagPickerOpen]);

  // Close tag picker on Esc
  useEffect(() => {
    if (!tagPickerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTagPickerOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [tagPickerOpen]);

  // Reset filter when picker closes
  const [tagFilter, setTagFilter] = useState("");
  useEffect(() => {
    if (!tagPickerOpen) setTagFilter("");
  }, [tagPickerOpen]);

  const filteredTags = tagFilter.trim()
    ? userTags.filter((t) => t.name.toLowerCase().includes(tagFilter.trim().toLowerCase()))
    : userTags;

  return (
    <div
      className={`session-thumb ${isActive ? "session-thumb-active" : ""} ${session.error ? "session-thumb-error" : ""}`}
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
          {/* Tag Picker Button */}
          <button
            className="absolute top-1 left-1 w-[22px] h-[22px] flex items-center justify-center rounded border-0 text-white cursor-pointer opacity-60 p-0 transition-all duration-150 hover:opacity-100 hover:scale-110"
            style={{
              background: displayTag ? displayTag.color : "rgba(255,255,255,0.15)",
              zIndex: 10,
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (!tagPickerOpen) onTagPickerOpen();
              setTagPickerOpen(!tagPickerOpen);
            }}
            title={
              displayTag ? `Display tag: ${displayTag.name} — click to change` : "Set display tag"
            }
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
          </button>

          {/* Tag Picker Modal Overlay */}
          {tagPickerOpen && (
            <div
              className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
              onClick={(e) => {
                e.stopPropagation();
                setTagPickerOpen(false);
              }}
            >
              <div
                ref={tagPickerRef}
                className="card w-full max-w-md shadow-2xl animate-in fade-in zoom-in duration-200 flex flex-col"
                style={{ maxHeight: "min(70vh, 600px)" }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <div className="text-[0.7rem] font-bold text-txt-tertiary uppercase tracking-widest">
                      Display Tag
                    </div>
                    <div
                      className="text-sm font-semibold text-txt-primary truncate mt-0.5"
                      title={session.name}
                    >
                      {session.name}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-txt-secondary hover:bg-white/10 hover:text-txt-primary transition-colors"
                    onClick={() => setTagPickerOpen(false)}
                    title="Close (Esc)"
                    aria-label="Close"
                  >
                    <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M2 2L10 10M10 2L2 10"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>

                {/* Search filter (only when there are enough tags to need it) */}
                {userTags.length > 6 && (
                  <input
                    type="text"
                    autoFocus
                    value={tagFilter}
                    onChange={(e) => setTagFilter(e.target.value)}
                    placeholder="Filter tags…"
                    className="w-full px-3 py-2 mb-2 rounded-lg bg-bg-secondary border border-white/10 text-sm text-txt-primary placeholder:text-txt-tertiary focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/30"
                  />
                )}

                {/* Tag list */}
                <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1">
                  {/* None option */}
                  <button
                    type="button"
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm transition-colors ${
                      !displayTag
                        ? "bg-white/10 text-txt-primary"
                        : "text-txt-secondary hover:bg-white/5"
                    }`}
                    onClick={() => {
                      onRemoveDisplayTag(session.connectionId);
                      setTagPickerOpen(false);
                    }}
                  >
                    <span className="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0" />
                    <span className="flex-1">None</span>
                    {!displayTag && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        className="text-accent shrink-0"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>

                  {filteredTags.map((tag) => {
                    const selected = displayTag?.id === tag.id;
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm transition-colors ${
                          selected
                            ? "bg-white/10 text-txt-primary"
                            : "text-txt-secondary hover:bg-white/5"
                        }`}
                        onClick={() => {
                          onSetDisplayTag(session.connectionId, tag.id);
                          setTagPickerOpen(false);
                        }}
                      >
                        <span
                          className="w-3.5 h-3.5 rounded-full shrink-0 border border-white/10"
                          style={{ background: tag.color }}
                        />
                        <span className="flex-1 truncate">{tag.name}</span>
                        {selected && (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            className="text-accent shrink-0"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    );
                  })}

                  {userTags.length === 0 && (
                    <div className="px-3 py-6 text-center text-sm text-txt-tertiary">
                      No tags created yet. Create tags from your Profile or Tags page first.
                    </div>
                  )}
                  {userTags.length > 0 && filteredTags.length === 0 && (
                    <div className="px-3 py-6 text-center text-sm text-txt-tertiary">
                      No tags match "{tagFilter}".
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Label Overlay */}
          <div className="absolute bottom-0 left-0 right-0 p-2 pt-6 bg-gradient-to-t from-black/90 via-black/40 to-transparent pointer-events-none flex flex-col gap-1 min-w-0 z-10">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[0.55rem] font-bold tracking-wide px-1.5 py-0.5 rounded bg-accent/30 text-accent-light shrink-0 border border-white/10 backdrop-blur-sm">
                {session.protocol.toUpperCase()}
              </span>
              {displayTag && (
                <span
                  className="text-[0.55rem] font-bold tracking-wide px-1.5 py-0.5 rounded border border-white/10 backdrop-blur-sm truncate min-w-0"
                  style={{ background: `${displayTag.color}40`, color: displayTag.color }}
                  title={displayTag.name}
                >
                  {displayTag.name}
                </span>
              )}
            </div>
            <span
              className="text-[0.75rem] font-bold text-white whitespace-nowrap overflow-hidden text-ellipsis min-w-0 drop-shadow-md"
              title={session.name}
            >
              {session.name}
            </span>
          </div>
          <button
            className="absolute top-1 right-7 w-[22px] h-[22px] flex items-center justify-center rounded border-0 text-white cursor-pointer opacity-85 p-0 transition-all duration-150 hover:opacity-100 hover:scale-110"
            style={{ background: "var(--color-accent)", zIndex: 10 }}
            onClick={onReconnect}
            title="Reconnect"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button
            className="absolute top-1 right-1 w-[22px] h-[22px] flex items-center justify-center rounded border-0 bg-danger text-white cursor-pointer opacity-85 p-0 transition-all duration-150 hover:opacity-100 hover:scale-110"
            style={{ background: "var(--color-danger)", zIndex: 10 }}
            onClick={onClose}
            title="Close Session"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M2 2L10 10M10 2L2 10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </>
      )}
      {!sessionBarCollapsed && (
        <>
          {/* Error Overlay */}
          {session.error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-[1px] p-2 text-center">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-danger)"
                strokeWidth="2"
                className="mb-1"
              >
                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-[0.6rem] font-bold text-danger leading-tight uppercase">
                Session Ended
              </span>
              <span className="text-[0.55rem] text-txt-secondary leading-tight mt-0.5 max-w-full truncate px-1">
                {session.error.includes("terminated") ? "Terminated by Admin" : "Connection Lost"}
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
