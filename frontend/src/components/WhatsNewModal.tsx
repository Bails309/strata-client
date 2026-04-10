import { useState, useEffect } from 'react';

const STORAGE_KEY = 'strata-whats-new-dismissed';

/**
 * Bump this version string each release to re-show the modal.
 * The content below should be updated to match.
 */
export const WHATS_NEW_VERSION = '0.10.2';

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
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">One-Off Vault Credentials</h3>
              <p>
                You can now select a saved credential profile directly from the login prompt when
                connecting to a server — no need to permanently map credentials to each connection.
                Works for both single and tiled (multi-session) connections.
              </p>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">NVR Playback Controls</h3>
              <p>
                Session recordings now feature a progress bar, speed selector (1×, 2×, 4×, 8×), and
                server-paced replay that preserves original inter-frame timing for accurate playback.
              </p>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">Per-User Recent Connections</h3>
              <p>
                Your "Recent Connections" on the dashboard now track only your activity — no more
                seeing other users' recently accessed servers in your list.
              </p>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">Session Disconnect Handling</h3>
              <p>
                Logging out of a remote server now cleanly ends the session with a clear
                "Session Ended" message, instead of leaving you on a black screen with
                endless reconnection attempts.
              </p>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">Pop-Out Session Stability</h3>
              <p>
                Connecting to additional servers while a session is popped out no longer disrupts
                the popup window. Pop-out sessions now persist independently until you return them.
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
