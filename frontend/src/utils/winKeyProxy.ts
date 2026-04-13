/**
 * Right Ctrl → Windows key proxy.
 *
 * Browsers cannot capture the physical Windows key — the OS intercepts it.
 * This utility remaps Right Ctrl so it behaves like the Super (Win) key
 * inside a remote desktop session, following the VMware / VirtualBox
 * "host key" convention.
 *
 * Usage:
 *   Hold Right Ctrl + another key  → sends Super + that key  (e.g. Win+E)
 *   Tap Right Ctrl alone           → sends a Super tap        (Start menu)
 */

const CTRL_R  = 0xFFE4; // Right Control keysym
const SUPER_L = 0xFFEB; // Left Super (Win) keysym

type SendKey = (pressed: 0 | 1, keysym: number) => void;

export interface WinKeyProxy {
  onkeydown(keysym: number): boolean;
  onkeyup(keysym: number): void;
  /** Call when focus is lost or the handler is torn down. */
  reset(): void;
}

export function createWinKeyProxy(sendKey: SendKey): WinKeyProxy {
  let active    = false;
  let superSent = false;

  return {
    onkeydown(keysym: number): boolean {
      if (keysym === CTRL_R) {
        if (!active) {
          active    = true;
          superSent = false;
        }
        return true; // swallow — don't forward Control_R
      }

      if (active) {
        if (!superSent) {
          sendKey(1, SUPER_L);
          superSent = true;
        }
        sendKey(1, keysym);
        return true;
      }

      sendKey(1, keysym);
      return true;
    },

    onkeyup(keysym: number): void {
      if (keysym === CTRL_R) {
        if (!superSent) {
          // Tapped alone → open Start menu
          sendKey(1, SUPER_L);
          sendKey(0, SUPER_L);
        } else {
          sendKey(0, SUPER_L);
        }
        active    = false;
        superSent = false;
        return;
      }

      sendKey(0, keysym);
    },

    reset(): void {
      active    = false;
      superSent = false;
    },
  };
}
