/**
 * Keyboard Lock API helper for fullscreen sessions.
 *
 * When the browser is in fullscreen mode, `navigator.keyboard.lock()`
 * captures OS-level shortcuts (Alt+Tab, Win+Tab, Win+key combos, etc.)
 * and forwards them to the page as regular key events.
 *
 * This module provides two mechanisms:
 *   1. `requestFullscreenWithLock(el)` — enters fullscreen and immediately
 *      locks system keys.  This is the most reliable path because the lock
 *      is acquired right after the fullscreen promise resolves.
 *   2. `installKeyboardLock(doc)` — fallback listener that auto-locks on
 *      any fullscreen transition (e.g. multi-monitor popups that enter
 *      fullscreen on their own).
 *
 * It is a progressive enhancement — if the API is unavailable
 * (Firefox, Safari, or non-secure contexts) it silently does nothing.
 */

/** System key codes to lock — explicit list is more reliable than
 *  the "lock everything" overload on Windows/Chromium. */
const SYSTEM_KEYS = [
  "MetaLeft",
  "MetaRight", // Win keys
  "AltLeft",
  "AltRight", // Alt keys (for Alt+Tab)
  "Tab", // Tab (for Alt+Tab, Win+Tab)
  "Escape", // Esc (for Ctrl+Esc → Start)
];

function isKeyboardLockSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "keyboard" in navigator &&
    typeof (navigator as NavigatorWithKeyboard).keyboard?.lock === "function"
  );
}

interface NavigatorKeyboard {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

interface NavigatorWithKeyboard extends Navigator {
  keyboard: NavigatorKeyboard;
}

function getKeyboard(): NavigatorKeyboard | null {
  if (!isKeyboardLockSupported()) return null;
  return (navigator as NavigatorWithKeyboard).keyboard;
}

/**
 * Request keyboard lock with explicit system key codes.
 */
async function lockKeyboard(): Promise<void> {
  try {
    await getKeyboard()?.lock(SYSTEM_KEYS);
  } catch {
    // DOMException if not in fullscreen, or user denied permission.
  }
}

/**
 * Release the keyboard lock.
 */
function unlockKeyboard(): void {
  try {
    getKeyboard()?.unlock();
  } catch {
    // Silently ignore — may already be unlocked.
  }
}

/**
 * Enter fullscreen on `el` and immediately lock system keys.
 * Falls back to plain `requestFullscreen()` if the lock API is unavailable.
 */
export async function requestFullscreenWithLock(el: Element): Promise<void> {
  await el.requestFullscreen();
  if (isKeyboardLockSupported()) {
    await lockKeyboard();
  } else if (typeof window !== "undefined" && window.location.protocol !== "https:") {
    console.warn(
      "[Strata] Keyboard Lock API is unavailable — system keys (Win, Alt+Tab) " +
        "cannot be captured in fullscreen. Enable HTTPS or use http://localhost " +
        "to unlock this feature."
    );
  }
}

/**
 * Exit fullscreen and release system keys.
 */
export async function exitFullscreenWithUnlock(doc: Document): Promise<void> {
  unlockKeyboard();
  await doc.exitFullscreen();
}

/**
 * Install a fullscreen-change listener on `doc` that automatically
 * locks the keyboard on entering fullscreen and unlocks on exit.
 * This acts as a safety net for fullscreen transitions not triggered
 * by `requestFullscreenWithLock` (e.g. multi-monitor popups).
 *
 * @returns A teardown function that removes the listener and unlocks.
 */
export function installKeyboardLock(doc: Document): () => void {
  if (!isKeyboardLockSupported()) return () => {};

  const onFullscreenChange = () => {
    if (doc.fullscreenElement) {
      lockKeyboard();
    } else {
      unlockKeyboard();
    }
  };

  doc.addEventListener("fullscreenchange", onFullscreenChange);

  // If already fullscreen when installed, lock immediately.
  if (doc.fullscreenElement) {
    lockKeyboard();
  }

  return () => {
    doc.removeEventListener("fullscreenchange", onFullscreenChange);
    unlockKeyboard();
  };
}
