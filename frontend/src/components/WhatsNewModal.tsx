import { useState, useEffect } from 'react';

const STORAGE_KEY = 'strata-whats-new-dismissed';

/**
 * Bump this version string each release to re-show the modal.
 * The content below should be updated to match.
 */
export const WHATS_NEW_VERSION = '0.10.3';

interface WhatsNewModalProps {
  /** User ID — used to scope dismissal per-user */
  userId: string | undefined;
}

export default function WhatsNewModal({ userId }: WhatsNewModalProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!userId) return;
    const key = `${STORAGE_KEY}-${userId}`;
    const dismissed = localStorage.getItem(key);
    if (dismissed !== WHATS_NEW_VERSION) {
      setVisible(true);
    }
  }, [userId]);

  function dismiss() {
    if (userId) {
      localStorage.setItem(`${STORAGE_KEY}-${userId}`, WHATS_NEW_VERSION);
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
      onClick={dismiss}
    >
      <div
        className="relative w-full max-w-lg mx-4 rounded-xl overflow-hidden animate-fade-in"
        style={{
          background: 'var(--color-surface-secondary)',
          border: '1px solid var(--color-glass-border)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 24px 64px rgba(0,0,0,0.3), inset 0 1px 0 var(--color-glass-highlight-strong)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header accent bar */}
        <div
          className="h-1"
          style={{ background: 'linear-gradient(90deg, var(--color-accent), var(--color-accent-light))' }}
        />

        <div className="p-6 max-h-[70vh] overflow-y-auto">
          {/* Title */}
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xl">&#x1f680;</span>
            <h2 className="!mb-0 text-lg font-semibold">What's New in {WHATS_NEW_VERSION}</h2>
          </div>
          <p className="text-xs text-txt-tertiary mb-5">April 2026</p>

          <div className="space-y-4 text-[0.8125rem] leading-relaxed text-txt-secondary">
            <section>
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">Auto-Redirect on Session End</h3>
              <p>
                When you sign out of a remote session while other sessions are still active, you're
                now automatically redirected to the next active session instead of seeing a frozen
                screen. The "Session Ended" overlay only appears when your last session closes.
              </p>
            </section>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex justify-end">
          <button className="btn-primary" onClick={dismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
