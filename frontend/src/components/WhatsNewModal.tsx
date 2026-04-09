import { useState, useEffect } from 'react';

const STORAGE_KEY = 'strata-whats-new-dismissed';

/**
 * Bump this version string each release to re-show the modal.
 * The content below should be updated to match.
 */
export const WHATS_NEW_VERSION = '0.7.0';

interface WhatsNewModalProps {
  /** Only show when the user is authenticated */
  authenticated: boolean;
}

export default function WhatsNewModal({ authenticated }: WhatsNewModalProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!authenticated) return;
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (dismissed !== WHATS_NEW_VERSION) {
      setVisible(true);
    }
  }, [authenticated]);

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, WHATS_NEW_VERSION);
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
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">Granular Permissions</h3>
              <p>
                Roles now support 9 fine-grained permissions — control who can create users,
                connections, folders, sharing profiles, and more. Assign exactly the access each
                team needs.
              </p>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">Connection Folders</h3>
              <p>
                Connection groups have been renamed to <strong>Connection Folders</strong> with
                full CRUD support, collapsible views, and role-based folder access control.
              </p>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">Security Hardening</h3>
              <p>
                Docker containers now run as non-root users, sensitive settings are
                automatically redacted in API responses, and new input validation prevents
                path-traversal and injection attacks.
              </p>
            </section>

            <section>
              <h3 className="text-sm font-semibold text-txt-primary mb-1.5">Dependency Upgrades</h3>
              <p>
                sqlx upgraded to 0.8 and jsonwebtoken to v10, bringing improved performance
                and security.
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
