import { useState, useEffect } from 'react';

const STORAGE_KEY = 'strata-whats-new-dismissed';
const WELCOME_KEY = 'strata-welcome-dismissed';

/** Current app version — sourced from package.json via Vite define. */
export const WHATS_NEW_VERSION = __APP_VERSION__;

interface WhatsNewModalProps {
  /** User ID — used to scope dismissal per-user */
  userId: string | undefined;
}

type ModalMode = 'welcome' | 'whats-new';

export default function WhatsNewModal({ userId }: WhatsNewModalProps) {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<ModalMode | null>(null);

  useEffect(() => {
    if (!userId) {
      if (visible) setVisible(false);
      return;
    }

    // 1. Check if welcome was ever seen
    const welcomeDismissed = localStorage.getItem(`${WELCOME_KEY}-${userId}`);
    if (!welcomeDismissed) {
      setMode('welcome');
      setVisible(true);
      return;
    }

    // 2. Fallback to what's new check
    const dismissedVersion = localStorage.getItem(`${STORAGE_KEY}-${userId}`);
    if (dismissedVersion !== WHATS_NEW_VERSION) {
      setMode('whats-new');
      setVisible(true);
    }
  }, [userId]);

  function dismiss() {
    if (!userId) {
      setVisible(false);
      return;
    }

    if (mode === 'welcome') {
      localStorage.setItem(`${WELCOME_KEY}-${userId}`, 'true');
      // Proactively dismiss current what's-new so they don't get double-popped
      localStorage.setItem(`${STORAGE_KEY}-${userId}`, WHATS_NEW_VERSION);
    } else {
      localStorage.setItem(`${STORAGE_KEY}-${userId}`, WHATS_NEW_VERSION);
    }

    setVisible(false);
  }

  if (!visible || !mode) return null;

  const isWelcome = mode === 'welcome';

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
      onClick={dismiss}
    >
      <div
        className="relative w-full max-w-lg rounded-xl overflow-hidden"
        style={{
          background: 'var(--color-surface-secondary)',
          border: '1px solid var(--color-glass-border)',
          boxShadow:
            '0 8px 32px rgba(0,0,0,0.4), 0 24px 64px rgba(0,0,0,0.3), inset 0 1px 0 var(--color-glass-highlight-strong)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header accent bar */}
        <div
          className="h-1"
          style={{ background: 'linear-gradient(90deg, var(--color-accent), var(--color-accent-light))' }}
        />

        <div className="p-6 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Title */}
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xl">{isWelcome ? '👋' : '🚀'}</span>
            <h2 className="!mb-0 text-xl font-semibold tracking-tight">
              {isWelcome ? 'Welcome to Strata Client!' : `What's New in ${WHATS_NEW_VERSION}`}
            </h2>
          </div>
          <p className="text-xs text-txt-tertiary mb-6 uppercase tracking-widest font-medium">
            {isWelcome ? 'The modern remote gateway' : 'April 2026 Update'}
          </p>

          <div className="space-y-5 text-[0.875rem] leading-relaxed text-txt-secondary">
            {isWelcome ? (
              <>
                <p>
                  We're excited to have you here! Strata is your unified gateway for high-performance remote access.
                </p>
                <div className="grid gap-4 mt-2">
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🖥️</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">Clientless Remotes</h4>
                      <p className="text-xs">Connect to RDP, SSH, and VNC directly in your browser with no plugins required.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🤝</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">Seamless Collaboration</h4>
                      <p className="text-xs">Share your active sessions via Control or View-only links for instant support.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">📂</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">Integrated File Browser</h4>
                      <p className="text-xs">Seamlessly transfer files between your local device and remote hosts.</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
                      <span className="text-sm">🎥</span>
                    </div>
                    <div>
                      <h4 className="font-semibold text-txt-primary text-sm mb-0.5">Admin Session Replay</h4>
                      <p className="text-xs">Review connection history with DVR-style NVR playback for full administrative auditing.</p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <section>
                  <h3 className="text-sm font-semibold text-txt-primary mb-1.5 flex items-center gap-2">
                    <span className="text-accent">•</span> Inline Role Management
                  </h3>
                  <p>
                    Admins can now change a user's role directly from the Users table via a sleek inline dropdown —
                    no more navigating to a separate edit screen. All role changes are audit-logged.
                  </p>
                </section>
                <section>
                  <h3 className="text-sm font-semibold text-txt-primary mb-1.5 flex items-center gap-2">
                    <span className="text-accent">•</span> Case-Insensitive Login
                  </h3>
                  <p>
                    SSO and local login now match emails and usernames case-insensitively, fixing sign-in
                    failures when the identity provider returns a differently-cased email than was originally stored.
                  </p>
                </section>
                <section>
                  <h3 className="text-sm font-semibold text-txt-primary mb-1.5 flex items-center gap-2">
                    <span className="text-accent">•</span> Improved Session Watermark
                  </h3>
                  <p>
                    The session watermark now renders with dual light/dark text passes and a fixed overlay,
                    ensuring it's always visible regardless of the remote desktop background.
                  </p>
                </section>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 pt-2 flex justify-end">
          <button
            className="btn-primary min-w-[100px] hover:scale-105 active:scale-95 transition-transform"
            onClick={dismiss}
          >
            {isWelcome ? "Let's Go!" : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}
