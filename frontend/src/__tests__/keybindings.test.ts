import { describe, it, expect } from "vitest";
import {
  parseBinding,
  matchesBinding,
  bindingFromEvent,
  DEFAULT_COMMAND_PALETTE_BINDING,
} from "../utils/keybindings";

function ev(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...init,
  } as unknown as KeyboardEvent;
}

describe("keybindings", () => {
  describe("parseBinding", () => {
    it("parses Ctrl+K", () => {
      expect(parseBinding("Ctrl+K")).toEqual({
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
        key: "k",
      });
    });

    it("treats empty string as null (disabled)", () => {
      expect(parseBinding("")).toBeNull();
      expect(parseBinding("   ")).toBeNull();
    });

    it("accepts modifiers in any order, case-insensitive", () => {
      expect(parseBinding("shift+ALT+ctrl+P")?.key).toBe("p");
      const p = parseBinding("shift+ALT+ctrl+P")!;
      expect(p.ctrl && p.alt && p.shift).toBe(true);
    });

    it("treats Cmd / Meta / Win as meta", () => {
      expect(parseBinding("Cmd+P")?.meta).toBe(true);
      expect(parseBinding("Meta+P")?.meta).toBe(true);
      expect(parseBinding("Win+P")?.meta).toBe(true);
    });

    it("returns null when no non-modifier key is present", () => {
      expect(parseBinding("Ctrl+Shift")).toBeNull();
    });
  });

  describe("matchesBinding", () => {
    const ctrlK = parseBinding("Ctrl+K");

    it("matches Ctrl+K on Windows/Linux", () => {
      expect(matchesBinding(ev({ key: "k", ctrlKey: true }), ctrlK)).toBe(true);
    });

    it("matches ⌘K on macOS (Ctrl maps to either Ctrl or Meta)", () => {
      expect(matchesBinding(ev({ key: "k", metaKey: true }), ctrlK)).toBe(true);
    });

    it("does not match plain K", () => {
      expect(matchesBinding(ev({ key: "k" }), ctrlK)).toBe(false);
    });

    it("does not match Ctrl+Shift+K when binding is Ctrl+K", () => {
      expect(matchesBinding(ev({ key: "k", ctrlKey: true, shiftKey: true }), ctrlK)).toBe(false);
    });

    it("is case-insensitive on the event side", () => {
      expect(matchesBinding(ev({ key: "K", ctrlKey: true }), ctrlK)).toBe(true);
    });

    it("returns false for null binding (disabled shortcut)", () => {
      expect(matchesBinding(ev({ key: "k", ctrlKey: true }), null)).toBe(false);
    });
  });

  describe("bindingFromEvent", () => {
    it("returns null for modifier-only presses", () => {
      expect(bindingFromEvent(ev({ key: "Control", ctrlKey: true }))).toBeNull();
      expect(bindingFromEvent(ev({ key: "Shift", shiftKey: true }))).toBeNull();
    });

    it("normalises single letters to upper-case", () => {
      expect(bindingFromEvent(ev({ key: "k", ctrlKey: true }))).toBe("Ctrl+K");
    });

    it("preserves named keys verbatim", () => {
      expect(bindingFromEvent(ev({ key: "Enter", altKey: true }))).toBe("Alt+Enter");
      expect(bindingFromEvent(ev({ key: "F1", ctrlKey: true, shiftKey: true }))).toBe(
        "Ctrl+Shift+F1"
      );
    });

    it("treats meta-only as Ctrl for cross-platform consistency", () => {
      expect(bindingFromEvent(ev({ key: "k", metaKey: true }))).toBe("Ctrl+K");
    });
  });

  it("DEFAULT_COMMAND_PALETTE_BINDING is Ctrl+K", () => {
    expect(DEFAULT_COMMAND_PALETTE_BINDING).toBe("Ctrl+K");
  });
});
