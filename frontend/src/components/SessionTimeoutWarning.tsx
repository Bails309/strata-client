import { useEffect, useState, useCallback, useRef } from "react";
import { refreshAccessToken, readCookie } from "../api";

/**
 * Read the access-token expiry timestamp.
 *
 * The backend sets a non-HttpOnly `session_expires` cookie alongside the
 * HttpOnly access token. Its value is the unix epoch (seconds) at which
 * the access token expires. Returning the value in milliseconds matches
 * `Date.now()` arithmetic.
 */
function readExpiryMs(): number | null {
  const value = readCookie("session_expires");
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/** Show a warning toast this many seconds before the access token expires. */
const WARNING_LEAD_SECS = 120;
/** How often (ms) to check the expiry timestamp. */
const CHECK_INTERVAL_MS = 1000;
/**
 * Proactive refresh: when the token has less than this many seconds remaining
 * AND the user is active, silently refresh in the background. Set to half the
 * 20-minute TTL so we refresh after ~10 minutes of activity instead of waiting
 * until 2 minutes remain.
 */
const PROACTIVE_REFRESH_THRESHOLD_SECS = 600;
/**
 * Minimum interval (ms) between proactive refresh attempts so we don't hammer
 * the endpoint on every keystroke.
 */
const PROACTIVE_COOLDOWN_MS = 30_000;

export default function SessionTimeoutWarning({ onExpired }: { onExpired?: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [extending, setExtending] = useState(false);

  // Track last proactive refresh attempt to enforce cooldown
  const lastProactiveRef = useRef(0);

  /* ── Proactive activity-based refresh ── */
  useEffect(() => {
    function onActivity() {
      const expiry = readExpiryMs();
      if (!expiry) return;

      const remaining = Math.floor((expiry - Date.now()) / 1000);
      if (remaining <= 0 || remaining > PROACTIVE_REFRESH_THRESHOLD_SECS) return;

      // Enforce cooldown
      const now = Date.now();
      if (now - lastProactiveRef.current < PROACTIVE_COOLDOWN_MS) return;
      lastProactiveRef.current = now;

      // Silent background refresh — no UI feedback needed
      refreshAccessToken().catch(() => {});
    }

    const events: (keyof WindowEventMap)[] = ["mousedown", "keydown", "touchstart", "scroll"];
    for (const e of events) window.addEventListener(e, onActivity, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, onActivity);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const expiry = readExpiryMs();
      if (!expiry) {
        setSecondsLeft(null);
        return;
      }
      const remaining = Math.max(0, Math.floor((expiry - Date.now()) / 1000));
      setSecondsLeft(remaining);

      // Reset dismissed state when a new token pushes expiry further out
      if (remaining > WARNING_LEAD_SECS) {
        setDismissed(false);
      }

      // Force logout when the timer reaches zero
      if (remaining === 0 && onExpired) {
        onExpired();
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(id);
  }, [onExpired]);

  const handleExtend = useCallback(async () => {
    setExtending(true);
    try {
      const ok = await refreshAccessToken();
      if (ok) {
        setDismissed(true);
      }
    } finally {
      setExtending(false);
    }
  }, []);

  // Don't render when there's no expiry, user dismissed it, or outside the warning window
  if (secondsLeft === null || dismissed || secondsLeft > WARNING_LEAD_SECS) {
    return null;
  }

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timeDisplay = mins > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${secs}s`;

  return (
    <div className="fixed bottom-4 right-4 z-[9999] animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div
        className="card flex items-start gap-3 shadow-2xl max-w-sm"
        style={{ border: "1px solid var(--color-warning-dim, rgba(245, 158, 11, 0.3))" }}
      >
        {/* Clock icon */}
        <div
          className="flex items-center justify-center w-8 h-8 rounded-full shrink-0"
          style={{ background: "var(--color-warning-dim, rgba(245, 158, 11, 0.1))" }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "var(--color-warning, #f59e0b)" }}
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold mb-1">Session expiring</p>
          <p className="text-xs text-txt-secondary mb-3">
            Your session will expire in{" "}
            <span className="font-mono font-bold text-txt-primary">{timeDisplay}</span>. Extend to
            stay logged in.
          </p>

          <div className="flex gap-2">
            <button
              onClick={handleExtend}
              disabled={extending}
              className="btn btn-sm"
              style={{
                background: "var(--color-accent)",
                color: "#fff",
                opacity: extending ? 0.6 : 1,
              }}
            >
              {extending ? "Extending…" : "Extend Session"}
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="btn btn-sm"
              style={{ background: "var(--color-surface-alt, var(--color-surface))" }}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
