import { useState } from 'react';
import { acceptTerms } from '../api';

/**
 * Bump this number whenever the terms / disclaimer text changes.
 * Users who accepted an older version will be prompted to re-accept.
 */
export const TERMS_VERSION = 1;

interface Props {
  onAccept: () => void;
  onDecline: () => void;
}

export default function DisclaimerModal({ onAccept, onDecline }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // Consider "at bottom" when within 20px of the end
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 20) {
      setScrolledToBottom(true);
    }
  };

  const handleAccept = async () => {
    setSubmitting(true);
    try {
      await acceptTerms(TERMS_VERSION);
      onAccept();
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-surface border border-border rounded-xl shadow-2xl max-w-2xl w-full mx-4 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-txt-primary">Session Recording Disclaimer</h2>
              <p className="text-xs text-txt-secondary">Please read and accept before continuing</p>
            </div>
          </div>
        </div>

        {/* Scrollable content */}
        <div
          className="px-6 py-4 overflow-y-auto flex-1 text-sm text-txt-secondary space-y-5"
          onScroll={handleScroll}
        >
          <p className="text-txt-primary font-medium">
            By using this RDP service, you agree to the following:
          </p>

          <section>
            <h3 className="text-txt-primary font-semibold mb-1.5 flex items-center gap-2">
              <svg className="w-4 h-4 text-red-400 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="6" />
              </svg>
              Session Recording
            </h3>
            <p>
              All sessions are fully recorded (screen, keyboard, and mouse activity) for
              legitimate business purposes, including:
            </p>
            <ul className="list-disc list-inside mt-1.5 space-y-0.5 ml-1">
              <li>Enforcing policies and acceptable use</li>
              <li>Detecting and investigating security incidents</li>
              <li>Troubleshooting issues</li>
              <li>Supporting audits and regulatory compliance</li>
              <li>Protecting systems and data integrity</li>
            </ul>
          </section>

          <section>
            <h3 className="text-txt-primary font-semibold mb-1.5 flex items-center gap-2">
              <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Consent
            </h3>
            <p>
              By logging in, you explicitly consent to full session recording.
              There is no expectation of privacy during recorded sessions.
            </p>
          </section>

          <section>
            <h3 className="text-txt-primary font-semibold mb-1.5 flex items-center gap-2">
              <svg className="w-4 h-4 text-yellow-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              Acceptable Use
            </h3>
            <p>
              You must use this service only for authorised, lawful business purposes.
              You must not:
            </p>
            <ul className="list-disc list-inside mt-1.5 space-y-0.5 ml-1">
              <li>Engage in illegal, harmful, or unethical activity</li>
              <li>Access or share inappropriate or prohibited content</li>
              <li>Bypass security controls or access restricted systems/data</li>
              <li>Use the service for unauthorised personal activity</li>
            </ul>
            <p className="mt-1.5 text-yellow-400/80 text-xs">
              Breaches may result in access removal, disciplinary action, or referral to authorities.
            </p>
          </section>

          <section>
            <h3 className="text-txt-primary font-semibold mb-1.5 flex items-center gap-2">
              <svg className="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              Data Protection
            </h3>
            <p>
              Recordings are treated as personal data under UK GDPR and the
              Data Protection Act 2018. They are securely stored, access-controlled, retained
              per policy, and then securely deleted. See the Privacy Notice for details.
            </p>
          </section>

          <section className="border-t border-border pt-4">
            <p className="text-txt-primary font-medium">
              By continuing, you confirm you have read and accepted these terms.
            </p>
          </section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex items-center justify-between gap-3">
          {!scrolledToBottom && (
            <p className="text-xs text-txt-secondary/60 italic">Scroll to the bottom to accept</p>
          )}
          <div className="flex items-center gap-3 ml-auto">
            <button
              onClick={onDecline}
              className="px-4 py-2 text-sm rounded-lg border border-border text-txt-secondary hover:text-txt-primary hover:bg-surface-elevated transition-colors"
            >
              Decline &amp; Logout
            </button>
            <button
              onClick={handleAccept}
              disabled={!scrolledToBottom || submitting}
              className="px-4 py-2 text-sm rounded-lg font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-accent hover:bg-accent/90"
            >
              {submitting ? 'Accepting…' : 'I Accept'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
