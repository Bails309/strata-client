/**
 * Activity bus — a single source of truth for "the user is doing something
 * with Strata" that survives Guacamole's keyboard/mouse event hijacking.
 *
 * Why this exists
 * ---------------
 * `SessionTimeoutWarning` proactively refreshes the access token when it
 * sees `mousedown` / `keydown` / `touchstart` / `scroll` on `window`.
 * That works for ordinary in-app navigation, but it does NOT work while
 * the user is interacting with a remote Guacamole session: the
 * `Guacamole.Keyboard` and `Guacamole.Mouse` constructors install
 * listeners on `document` and the canvas element that call
 * `event.preventDefault()` and (for some keys) `event.stopPropagation()`
 * — so the bubbled event never fires our window-level listener. The
 * symptom is that an actively-used RDP session "logs the user out of
 * Strata" after ~20 minutes even though they are clearly active.
 *
 * The fix is to have the session input handlers — which receive the
 * event before Guacamole hijacks it, OR receive the keysym/mouse-state
 * via Guacamole's own callbacks — explicitly notify the activity bus.
 * `SessionTimeoutWarning` listens for the bus event in addition to the
 * usual DOM events, so a user who is rapidly clicking inside an RDP
 * canvas with no other browser input still keeps their token alive.
 *
 * The bus is implemented as a custom `window` event so that listeners
 * in pop-out windows (which share `window.opener`) and the main app can
 * subscribe via the same primitive without introducing a React context
 * or a singleton module-state cell that would fight with HMR / strict
 * mode double-mount.
 */

export const SESSION_ACTIVITY_EVENT = "strata-session-activity";

/**
 * Throttle handle: avoid dispatching dozens of events per second on
 * `mousemove`. The downstream listener has its own cooldown but DOM
 * dispatch isn't free either.
 */
let lastNotifyMs = 0;
const NOTIFY_THROTTLE_MS = 1000;

/**
 * Notify the activity bus that the user has just done something inside
 * a remote session. Safe to call from a hot path (mousemove); throttled
 * to at most once per `NOTIFY_THROTTLE_MS`.
 */
export function notifySessionActivity(): void {
  const now = Date.now();
  if (now - lastNotifyMs < NOTIFY_THROTTLE_MS) return;
  lastNotifyMs = now;
  try {
    window.dispatchEvent(new Event(SESSION_ACTIVITY_EVENT));
  } catch {
    /* SSR / detached document — ignore */
  }
}
