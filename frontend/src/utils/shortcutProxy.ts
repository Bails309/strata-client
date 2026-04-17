/**
 * Keyboard shortcut proxy for OS-intercepted key combos.
 *
 * Alt+Tab and Win+Tab are intercepted by the operating system before the
 * browser ever sees them.  This proxy maps a browser-capturable combo to
 * the intended remote-desktop key sequence:
 *
 *   Ctrl+Alt+`  →  Win+Tab  (task view)
 *
 * Note: Ctrl+Alt+Tab cannot be used as a proxy for Alt+Tab because
 * Windows also intercepts Ctrl+Alt+Tab (persistent task switcher).
 * In fullscreen mode the Keyboard Lock API captures OS shortcuts
 * directly, so no proxy is needed.
 *
 * How it works
 * ────────────
 * By the time the trigger key (`) is pressed, Guacamole.Keyboard
 * has already forwarded the Ctrl and Alt key-down events to the remote.
 * The proxy therefore:
 *   1. Stops the trigger key from reaching Guacamole.Keyboard
 *      (capture-phase stopPropagation).
 *   2. Releases the extra modifiers on the remote (Ctrl + Alt) so the
 *      remote only sees the desired combo.
 *   3. Sends Win+Tab press+release.
 *
 * When the user physically releases Ctrl / Alt afterwards,
 * Guacamole.Keyboard will send redundant key-ups which the remote
 * handles as harmless no-ops.
 */

const ALT_L   = 0xFFE9;
const CTRL_L  = 0xFFE3;
const SUPER_L = 0xFFEB;
const TAB     = 0xFF09;

export type SendKey = (pressed: 0 | 1, keysym: number) => void;

/**
 * Install a capture-phase keyboard listener that intercepts shortcut
 * combos and translates them into remote key events.
 *
 * @param doc       The Document to listen on (main window or popup).
 * @param sendKey   Callback to send a key event to the remote session.
 * @param isFocused Optional guard — if provided the proxy only acts when
 *                  it returns `true`.
 * @returns A teardown function that removes all listeners.
 */
export function installShortcutProxy(
  doc: Document,
  sendKey: SendKey,
  isFocused?: () => boolean,
): () => void {
  // Track trigger keys we intercepted so we can also swallow their keyup.
  const interceptedCodes = new Set<string>();

  const onKeyDown = (e: KeyboardEvent) => {
    if (isFocused && !isFocused()) return;

    // ── Ctrl+Alt+` → Win+Tab ──
    if (e.ctrlKey && e.altKey && e.code === 'Backquote') {
      e.preventDefault();
      e.stopPropagation();
      interceptedCodes.add(e.code);

      // Release both trigger modifiers, then send Win+Tab.
      sendKey(0, CTRL_L);
      sendKey(0, ALT_L);
      sendKey(1, SUPER_L);
      sendKey(1, TAB);
      sendKey(0, TAB);
      sendKey(0, SUPER_L);
      return;
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (interceptedCodes.has(e.code)) {
      e.stopPropagation();
      interceptedCodes.delete(e.code);
    }
  };

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('keyup', onKeyUp, true);

  return () => {
    try {
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('keyup', onKeyUp, true);
    } catch { /* document may already be destroyed (e.g. popup closed) */ }
  };
}
