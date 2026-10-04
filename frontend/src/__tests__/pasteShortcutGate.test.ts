import { describe, it, expect, vi, afterEach } from "vitest";
import { createPasteShortcutGate, PASTE_GATE_TIMEOUT_MS } from "../utils/pasteShortcutGate";

const CTRL_L = 0xffe3;
const SHIFT_L = 0xffe1;
const V = 0x76;
const INSERT = 0xff63;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createPasteShortcutGate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards ordinary keys immediately without touching the clipboard", () => {
    const send = vi.fn();
    const sync = vi.fn(() => Promise.resolve());
    const gate = createPasteShortcutGate(send, sync);

    gate.send(1, V);
    gate.send(0, V);

    expect(send.mock.calls).toEqual([
      [1, V],
      [0, V],
    ]);
    expect(sync).not.toHaveBeenCalled();
  });

  it("holds Ctrl+V and everything after it until the clipboard is pushed", async () => {
    const send = vi.fn();
    const pushed = deferred();
    const gate = createPasteShortcutGate(send, () => pushed.promise);

    gate.send(1, CTRL_L);
    gate.send(1, V);
    gate.send(0, V);
    gate.send(0, CTRL_L);
    expect(send.mock.calls).toEqual([[1, CTRL_L]]);

    pushed.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    expect(send.mock.calls).toEqual([
      [1, CTRL_L],
      [1, V],
      [0, V],
      [0, CTRL_L],
    ]);
  });

  it("gates Shift+Insert too", () => {
    const send = vi.fn();
    const sync = vi.fn(() => new Promise<void>(() => {}));
    const gate = createPasteShortcutGate(send, sync);

    gate.send(1, SHIFT_L);
    gate.send(1, INSERT);

    expect(sync).toHaveBeenCalledTimes(1);
    expect(send.mock.calls).toEqual([[1, SHIFT_L]]);
  });

  it("releases the keystroke if the clipboard push never settles", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const gate = createPasteShortcutGate(send, () => new Promise<void>(() => {}));

    gate.send(1, CTRL_L);
    gate.send(1, V);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PASTE_GATE_TIMEOUT_MS);
    expect(send.mock.calls).toEqual([
      [1, CTRL_L],
      [1, V],
    ]);
  });

  it("still delivers the keystroke when the clipboard push fails", async () => {
    const send = vi.fn();
    const gate = createPasteShortcutGate(send, () => Promise.reject(new Error("denied")));

    gate.send(1, CTRL_L);
    gate.send(1, V);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(1, V));
  });
});
