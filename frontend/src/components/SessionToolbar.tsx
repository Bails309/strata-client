import { useState, useCallback, useRef, useEffect } from 'react';
import { createShareLink } from '../api';
import { GuacSession } from './SessionManager';
import FileBrowser from './FileBrowser';
import Select from './Select';

interface Props {
  session: GuacSession;
  connectionId: string;
  isPoppedOut?: boolean;
  onPopOut?: () => void;
  onPopIn?: () => void;
}

/**
 * Floating toolbar rendered over the session view.
 * Provides access to connection sharing and file browser.
 */
export default function SessionToolbar({ session, connectionId, isPoppedOut, onPopOut, onPopIn }: Props) {
  const [shareOpen, setShareOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareMode, setShareMode] = useState<'view' | 'control'>('view');
  const [shareLoading, setShareLoading] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [activeFsIndex, setActiveFsIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const shareAbortRef = useRef<AbortController | null>(null);

  const hasFilesystems = session.filesystems.length > 0;

  // Track fullscreen state changes (user can exit via Esc too)
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Close popovers on outside click
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
    // Abort any in-flight share request
    shareAbortRef.current?.abort();
    const controller = new AbortController();
    shareAbortRef.current = controller;

    setShareMode(mode);
    setShareLoading(true);
    setShareUrl(null);
    setCopied(false);
    try {
      const result = await createShareLink(connectionId, mode);
      if (controller.signal.aborted) return;
      const fullUrl = `${window.location.origin}${result.share_url}`;
      setShareUrl(fullUrl);
      setShareOpen(true);
    } catch {
      // Sharing not available or aborted
    } finally {
      if (!controller.signal.aborted) setShareLoading(false);
    }
  }, [connectionId]);

  const handleCopy = useCallback(() => {
    if (shareUrl) {
      navigator.clipboard?.writeText(shareUrl).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [shareUrl]);

  return (
    <>
      {/* Floating toolbar — top-right of session view */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 15,
          display: 'flex',
          gap: 4,
          opacity: 0.6,
          transition: 'opacity 0.15s',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.6'; }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Share button */}
        <button
          onClick={() => setShareOpen(!shareOpen)}
          disabled={shareLoading}
          title="Share this connection"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(0,0,0,0.65)',
            color: '#fff',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.85)';
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.65)';
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)';
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        </button>

        {/* File browser button — only shown when filesystems exist */}
        {hasFilesystems && (
          <button
            onClick={() => setFileBrowserOpen(!fileBrowserOpen)}
            title="Browse files"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 6,
              border: fileBrowserOpen ? '1px solid var(--color-accent)' : '1px solid rgba(255,255,255,0.15)',
              background: fileBrowserOpen ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.65)',
              color: '#fff',
              cursor: 'pointer',
              backdropFilter: 'blur(8px)',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.85)';
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)';
            }}
            onMouseLeave={(e) => {
              if (!fileBrowserOpen) {
                (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.65)';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)';
              }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          </button>
        )}

        {/* Fullscreen toggle — enables full keyboard capture (Ctrl+W, etc.) */}
        <button
          onClick={() => {
            if (document.fullscreenElement) {
              document.exitFullscreen().catch(() => {});
            } else {
              document.documentElement.requestFullscreen().catch(() => {});
            }
          }}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen — enables full keyboard capture (Ctrl+W, Ctrl+T, etc.)'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: 6,
            border: isFullscreen ? '1px solid var(--color-accent)' : '1px solid rgba(255,255,255,0.15)',
            background: isFullscreen ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.65)',
            color: '#fff',
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.85)';
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)';
          }}
          onMouseLeave={(e) => {
            if (!isFullscreen) {
              (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.65)';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)';
            }
          }}
        >
          {isFullscreen ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>

        {/* Pop-out / pop-in toggle */}
        {(onPopOut || onPopIn) && (
          <button
            onClick={() => isPoppedOut ? onPopIn?.() : onPopOut?.()}
            title={isPoppedOut ? 'Return to main window' : 'Pop out to separate window'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 6,
              border: isPoppedOut ? '1px solid var(--color-accent)' : '1px solid rgba(255,255,255,0.15)',
              background: isPoppedOut ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.65)',
              color: '#fff',
              cursor: 'pointer',
              backdropFilter: 'blur(8px)',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.85)';
              (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)';
            }}
            onMouseLeave={(e) => {
              if (!isPoppedOut) {
                (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.65)';
                (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)';
              }
            }}
          >
            {isPoppedOut ? (
              /* Arrow pointing inward (pop-in) */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 4 4 4 4 9" /><line x1="4" y1="4" x2="11" y2="11" />
                <rect x="10" y="10" width="11" height="11" rx="2" />
              </svg>
            ) : (
              /* Arrow pointing outward (pop-out) */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" /><line x1="21" y1="3" x2="13" y2="11" />
                <rect x="3" y="3" width="11" height="11" rx="2" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Share popover */}
      {shareOpen && (
        <div
          ref={popoverRef}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 52,
            right: 8,
            zIndex: 20,
            width: 340,
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'var(--color-surface)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            padding: 16,
            backdropFilter: 'blur(12px)',
          }}
        >
          <div className="text-[0.75rem] font-semibold text-txt-primary mb-1">Share Connection</div>
          {shareUrl ? (
            <>
              <p className="text-[0.7rem] text-txt-tertiary mb-3">
                {shareMode === 'control'
                  ? 'Share this link to grant temporary control access. The remote user can provide keyboard and mouse input.'
                  : 'Share this link to grant temporary read-only view access. The link expires when you disconnect.'}
              </p>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: '0.65rem',
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: shareMode === 'control' ? 'rgba(251,146,60,0.15)' : 'rgba(96,165,250,0.15)',
                    color: shareMode === 'control' ? '#fb923c' : '#60a5fa',
                    fontWeight: 600,
                  }}
                >
                  {shareMode === 'control' ? 'CONTROL' : 'VIEW ONLY'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
                <input
                  type="text"
                  readOnly
                  value={shareUrl}
                  style={{
                    flex: 1,
                    fontSize: '0.7rem',
                    fontFamily: 'monospace',
                    padding: '6px 10px',
                    borderRadius: 4,
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-input-bg)',
                    color: 'var(--color-txt-primary)',
                  }}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  className="btn-sm"
                  style={{ padding: '4px 10px', flexShrink: 0 }}
                  onClick={handleCopy}
                  title="Copy link"
                >
                  {copied ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                className="text-[0.65rem] text-txt-tertiary mt-2"
                style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                onClick={() => { setShareUrl(null); setCopied(false); }}
              >
                Generate new link
              </button>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <p className="text-[0.7rem] text-txt-tertiary mb-1">Choose share mode:</p>
              <button
                onClick={() => handleShare('view')}
                disabled={shareLoading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-surface-secondary)',
                  color: 'var(--color-txt-primary)',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                  textAlign: 'left',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                </svg>
                <div>
                  <div style={{ fontWeight: 600 }}>View Only</div>
                  <div className="text-txt-tertiary" style={{ fontSize: '0.65rem' }}>Observer can see but not interact</div>
                </div>
              </button>
              <button
                onClick={() => handleShare('control')}
                disabled={shareLoading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-surface-secondary)',
                  color: 'var(--color-txt-primary)',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                  textAlign: 'left',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <div>
                  <div style={{ fontWeight: 600 }}>Control</div>
                  <div className="text-txt-tertiary" style={{ fontSize: '0.65rem' }}>Guest can use keyboard and mouse</div>
                </div>
              </button>
              {shareLoading && <p className="text-[0.7rem] text-txt-tertiary">Generating…</p>}
            </div>
          )}
        </div>
      )}

      {/* File browser panel */}
      {fileBrowserOpen && hasFilesystems && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 320,
            zIndex: 18,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-surface)',
            borderLeft: '1px solid var(--color-border)',
            boxShadow: '-4px 0 16px rgba(0,0,0,0.3)',
            overflow: 'hidden',
          }}
        >
          {/* File browser header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              borderBottom: '1px solid var(--color-border)',
              background: 'var(--color-surface-secondary)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="text-[0.8125rem] font-semibold">Files</span>
              {session.filesystems.length > 1 && (
                <Select
                  value={String(activeFsIndex)}
                  onChange={(v) => setActiveFsIndex(Number(v))}
                  options={session.filesystems.map((fs, i) => ({ value: String(i), label: fs.name }))}
                />
              )}
            </div>
            <button
              onClick={() => setFileBrowserOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-txt-secondary)',
                padding: 2,
                lineHeight: 0,
              }}
              title="Close file browser"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* File browser content */}
          <div style={{ flex: 1, padding: 14, overflow: 'auto' }}>
            {session.filesystems[activeFsIndex] && (
              <FileBrowser
                filesystem={session.filesystems[activeFsIndex]}
                onClose={() => setFileBrowserOpen(false)}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
