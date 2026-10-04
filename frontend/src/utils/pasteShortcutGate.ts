/**
 * Holds a paste shortcut back until the remote clipboard has caught up.
 *
 * Local text only reaches the remote when something pushes it, and the
 * pushes are pointer- and focus-driven. Returning to the browser with
 * Alt+Tab and pressing Ctrl+V fires none of them, so the remote pasted
 * whatever it held before. This wraps a key sender: on Ctrl+V or
 * Shift+Insert it runs `syncClipboard` first, buffering that key and
 * every key after it, then replays them in order.
 */

type SendKey = (pressed: 0 | 1, keysym: number) => void;

const CONTROL = [0xffe3, 0xffe4];
const SHIFT = [0xffe1, 0xffe2];
const V = [0x76, 0x56];
const INSERT = 0xff63;

/** Longest a keystroke waits, e.g. behind a clipboard permission prompt. */
export const PASTE_GATE_TIMEOUT_MS = 1000;

export interface PasteShortcutGate {
  send: SendKey;
}

export function createPasteShortcutGate(
  send: SendKey,
  syncClipboard: () => Promise<unknown>,
  timeoutMs = PASTE_GATE_TIMEOUT_MS
): PasteShortcutGate {
  const held = new Set<number>();
  let queue: [0 | 1, number][] | null = null;

  const flush = () => {
    const pending = queue;
    queue = null;
    pending?.forEach(([pressed, keysym]) => send(pressed, keysym));
  };

  const isPaste = (keysym: number) =>
    (V.includes(keysym) && CONTROL.some((k) => held.has(k))) ||
    (keysym === INSERT && SHIFT.some((k) => held.has(k)));

  return {
    send(pressed, keysym) {
      if (pressed) held.add(keysym);
      else held.delete(keysym);

      if (queue) {
        queue.push([pressed, keysym]);
        return;
      }
      if (pressed && isPaste(keysym)) {
        queue = [[pressed, keysym]];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        void Promise.race([syncClipboard().catch(() => undefined), timeout]).then(() => {
          clearTimeout(timer);
          flush();
        });
        return;
      }
      send(pressed, keysym);
    },
  };
}
