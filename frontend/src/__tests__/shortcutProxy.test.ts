import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installShortcutProxy, type SendKey } from "../utils/shortcutProxy";

// Keysym constants (must match shortcutProxy.ts)
const ALT_L = 0xffe9;
const CTRL_L = 0xffe3;
const SUPER_L = 0xffeb;
const TAB = 0xff09;

function fireKey(
  doc: Document,
  type: "keydown" | "keyup",
  opts: Partial<KeyboardEvent> & { code: string; key: string }
) {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  doc.dispatchEvent(event);
  return event;
}

describe("shortcutProxy", () => {
  let sendKey: ReturnType<typeof vi.fn<SendKey>>;
  let cleanup: () => void;

  beforeEach(() => {
    sendKey = vi.fn<SendKey>();
  });

  afterEach(() => {
    cleanup?.();
  });

  function install(isFocused?: () => boolean) {
    cleanup = installShortcutProxy(document, sendKey, isFocused);
  }

  // ── Ctrl+Alt+` → Win+Tab ───────────────────────────────────────

  it("maps Ctrl+Alt+` to Win+Tab", () => {
    install();
    fireKey(document, "keydown", {
      code: "Backquote",
      key: "`",
      ctrlKey: true,
      altKey: true,
    });
    expect(sendKey.mock.calls).toEqual([
      [0, CTRL_L],
      [0, ALT_L],
      [1, SUPER_L],
      [1, TAB],
      [0, TAB],
      [0, SUPER_L],
    ]);
  });

  // ── Keyup suppression ──────────────────────────────────────────

  it("swallows keyup for intercepted trigger keys", () => {
    install();
    // Intercept the keydown first
    fireKey(document, "keydown", {
      code: "Backquote",
      key: "`",
      ctrlKey: true,
      altKey: true,
    });
    sendKey.mockClear();

    // The keyup for Backquote should be swallowed (stopPropagation)
    fireKey(document, "keyup", {
      code: "Backquote",
      key: "`",
    });
    // No additional sendKey calls
    expect(sendKey).not.toHaveBeenCalled();
    // After consuming once, a second keyup should NOT be swallowed
    fireKey(document, "keyup", {
      code: "Backquote",
      key: "`",
    });
    expect(sendKey).not.toHaveBeenCalled();
  });

  // ── Focus gating ───────────────────────────────────────────────

  it("does nothing when isFocused returns false", () => {
    install(() => false);
    fireKey(document, "keydown", {
      code: "Backquote",
      key: "`",
      ctrlKey: true,
      altKey: true,
    });
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("intercepts when isFocused returns true", () => {
    install(() => true);
    fireKey(document, "keydown", {
      code: "Backquote",
      key: "`",
      ctrlKey: true,
      altKey: true,
    });
    expect(sendKey).toHaveBeenCalled();
  });

  // ── Non-matching combos pass through ───────────────────────────

  it("ignores plain Tab (no Ctrl+Alt)", () => {
    install();
    fireKey(document, "keydown", {
      code: "Tab",
      key: "Tab",
      ctrlKey: false,
      altKey: false,
    });
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("ignores Ctrl+Tab without Alt", () => {
    install();
    fireKey(document, "keydown", {
      code: "Tab",
      key: "Tab",
      ctrlKey: true,
      altKey: false,
    });
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("ignores Alt+Tab without Ctrl", () => {
    install();
    fireKey(document, "keydown", {
      code: "Tab",
      key: "Tab",
      ctrlKey: false,
      altKey: true,
    });
    expect(sendKey).not.toHaveBeenCalled();
  });

  // ── Cleanup ────────────────────────────────────────────────────

  it("stops intercepting after cleanup", () => {
    install();
    cleanup();
    fireKey(document, "keydown", {
      code: "Backquote",
      key: "`",
      ctrlKey: true,
      altKey: true,
    });
    expect(sendKey).not.toHaveBeenCalled();
  });
});
