import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  requestFullscreenWithLock,
  exitFullscreenWithUnlock,
  installKeyboardLock,
} from "../utils/keyboardLock";

describe("keyboardLock", () => {
  let mockKeyboard: { lock: ReturnType<typeof vi.fn>; unlock: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockKeyboard = {
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up keyboard mock
    if ("keyboard" in navigator) {
      delete (navigator as any).keyboard;
    }
  });

  function installKeyboardMock() {
    Object.defineProperty(navigator, "keyboard", {
      value: mockKeyboard,
      writable: true,
      configurable: true,
    });
  }

  describe("requestFullscreenWithLock", () => {
    it("enters fullscreen and locks keyboard when API supported", async () => {
      installKeyboardMock();
      const el = {
        requestFullscreen: vi.fn().mockResolvedValue(undefined),
      } as unknown as Element;

      await requestFullscreenWithLock(el);

      expect(el.requestFullscreen).toHaveBeenCalled();
      expect(mockKeyboard.lock).toHaveBeenCalledWith([
        "MetaLeft",
        "MetaRight",
        "AltLeft",
        "AltRight",
        "Tab",
        "Escape",
      ]);
    });

    it("enters fullscreen without lock when API not supported", async () => {
      // No keyboard on navigator
      const el = {
        requestFullscreen: vi.fn().mockResolvedValue(undefined),
      } as unknown as Element;

      await requestFullscreenWithLock(el);

      expect(el.requestFullscreen).toHaveBeenCalled();
    });

    it("warns on non-HTTPS when API not supported", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Ensure no keyboard API
      const origProtocol = window.location.protocol;
      Object.defineProperty(window, "location", {
        value: { ...window.location, protocol: "http:" },
        writable: true,
        configurable: true,
      });

      const el = {
        requestFullscreen: vi.fn().mockResolvedValue(undefined),
      } as unknown as Element;

      await requestFullscreenWithLock(el);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Keyboard Lock API is unavailable")
      );
      // Restore
      Object.defineProperty(window, "location", {
        value: { ...window.location, protocol: origProtocol },
        writable: true,
        configurable: true,
      });
    });

    it("handles lock() rejection gracefully", async () => {
      installKeyboardMock();
      mockKeyboard.lock.mockRejectedValue(new DOMException("Not allowed"));

      const el = {
        requestFullscreen: vi.fn().mockResolvedValue(undefined),
      } as unknown as Element;

      // Should not throw
      await expect(requestFullscreenWithLock(el)).resolves.toBeUndefined();
    });
  });

  describe("exitFullscreenWithUnlock", () => {
    it("unlocks keyboard and exits fullscreen", async () => {
      installKeyboardMock();
      const mockDoc = {
        exitFullscreen: vi.fn().mockResolvedValue(undefined),
      } as unknown as Document;

      await exitFullscreenWithUnlock(mockDoc);

      expect(mockKeyboard.unlock).toHaveBeenCalled();
      expect(mockDoc.exitFullscreen).toHaveBeenCalled();
    });

    it("exits fullscreen even without keyboard API", async () => {
      const mockDoc = {
        exitFullscreen: vi.fn().mockResolvedValue(undefined),
      } as unknown as Document;

      await exitFullscreenWithUnlock(mockDoc);

      expect(mockDoc.exitFullscreen).toHaveBeenCalled();
    });

    it("handles unlock() error gracefully", async () => {
      installKeyboardMock();
      mockKeyboard.unlock.mockImplementation(() => {
        throw new Error("fail");
      });

      const mockDoc = {
        exitFullscreen: vi.fn().mockResolvedValue(undefined),
      } as unknown as Document;

      await exitFullscreenWithUnlock(mockDoc);
      expect(mockDoc.exitFullscreen).toHaveBeenCalled();
    });
  });

  describe("installKeyboardLock", () => {
    it("installs fullscreenchange listener and returns teardown", () => {
      installKeyboardMock();
      const listeners: Record<string, EventListener> = {};
      const mockDoc = {
        addEventListener: vi.fn((evt: string, fn: EventListener) => {
          listeners[evt] = fn;
        }),
        removeEventListener: vi.fn(),
        fullscreenElement: null,
      } as unknown as Document;

      const teardown = installKeyboardLock(mockDoc);

      expect(mockDoc.addEventListener).toHaveBeenCalledWith(
        "fullscreenchange",
        expect.any(Function)
      );
      expect(typeof teardown).toBe("function");

      // Trigger entering fullscreen
      (mockDoc as any).fullscreenElement = document.createElement("div");
      listeners["fullscreenchange"](new Event("fullscreenchange"));
      expect(mockKeyboard.lock).toHaveBeenCalled();

      // Trigger exiting fullscreen
      mockKeyboard.lock.mockClear();
      (mockDoc as any).fullscreenElement = null;
      listeners["fullscreenchange"](new Event("fullscreenchange"));
      expect(mockKeyboard.unlock).toHaveBeenCalled();

      // Teardown removes listener and unlocks
      mockKeyboard.unlock.mockClear();
      teardown();
      expect(mockDoc.removeEventListener).toHaveBeenCalledWith(
        "fullscreenchange",
        expect.any(Function)
      );
      expect(mockKeyboard.unlock).toHaveBeenCalled();
    });

    it("locks immediately if already in fullscreen when installed", () => {
      installKeyboardMock();
      const mockDoc = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        fullscreenElement: document.createElement("div"),
      } as unknown as Document;

      installKeyboardLock(mockDoc);

      expect(mockKeyboard.lock).toHaveBeenCalled();
    });

    it("returns no-op teardown when API not supported", () => {
      const mockDoc = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        fullscreenElement: null,
      } as unknown as Document;

      const teardown = installKeyboardLock(mockDoc);

      expect(mockDoc.addEventListener).not.toHaveBeenCalled();
      expect(typeof teardown).toBe("function");
      teardown(); // Should not throw
    });
  });
});
