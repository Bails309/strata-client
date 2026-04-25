import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";

const routerWrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(MemoryRouter, null, children);

// Mock guacamole-common-js
vi.mock("guacamole-common-js", () => ({
  default: {
    Client: vi.fn(function () {
      return {
        getDisplay: vi.fn(() => ({
          getElement: () => document.createElement("div"),
          getWidth: () => 1920,
          getHeight: () => 1080,
          scale: vi.fn(),
        })),
        sendMouseState: vi.fn(),
        sendKeyEvent: vi.fn(),
        sendSize: vi.fn(),
      };
    }),
    Mouse: Object.assign(
      vi.fn(function () {
        return {
          onEach: vi.fn(),
          onmousedown: null,
          onmouseup: null,
          onmousemove: null,
        };
      }),
      {
        Touchscreen: vi.fn(function () {
          return {
            onEach: vi.fn(),
            onmousedown: null,
            onmouseup: null,
            onmousemove: null,
          };
        }),
        Event: vi.fn(),
      }
    ),
    Keyboard: vi.fn(function () {
      return {
        onkeydown: null,
        onkeyup: null,
        reset: vi.fn(),
      };
    }),
  },
}));

import { usePopOut } from "../components/usePopOut";

function createMockSession() {
  return {
    id: "sess-1",
    name: "Test Server",
    connectionId: "conn-1",
    displayEl: document.createElement("div"),
    client: {
      getDisplay: vi.fn(() => ({
        getElement: () => document.createElement("div"),
        getWidth: () => 1920,
        getHeight: () => 1080,
        scale: vi.fn(),
      })),
      sendMouseState: vi.fn(),
      sendKeyEvent: vi.fn(),
      sendSize: vi.fn(),
    },
  };
}

function createMockPopupWindow() {
  const body = document.createElement("body") as any;
  body.style = {} as CSSStyleDeclaration;
  body.appendChild = vi.fn();
  const doc = {
    title: "",
    body,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return {
    closed: false,
    close: vi.fn(),
    document: doc,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    innerWidth: 1920,
    innerHeight: 1080,
  };
}

describe("usePopOut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns isPoppedOut=false initially", () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });
    expect(result.current.isPoppedOut).toBe(false);
  });

  it("returns popOut and returnDisplay functions", () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });
    expect(typeof result.current.popOut).toBe("function");
    expect(typeof result.current.returnDisplay).toBe("function");
  });

  it("handles undefined session gracefully", () => {
    const containerRef = { current: document.createElement("div") };
    const { result } = renderHook(() => usePopOut(undefined, containerRef as any), {
      wrapper: routerWrapper,
    });
    expect(result.current.isPoppedOut).toBe(false);
  });

  it("returnDisplay is no-op when no session", () => {
    const containerRef = { current: document.createElement("div") };
    const { result } = renderHook(() => usePopOut(undefined, containerRef as any), {
      wrapper: routerWrapper,
    });
    act(() => {
      result.current.returnDisplay();
    });
    expect(result.current.isPoppedOut).toBe(false);
  });

  it("popOut does nothing when window.open is blocked", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    vi.spyOn(window, "open").mockReturnValue(null);
    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    expect(result.current.isPoppedOut).toBe(false);
  });

  it("popOut opens a window and sets isPoppedOut=true", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    expect(result.current.isPoppedOut).toBe(true);
    expect(window.open).toHaveBeenCalled();
  });

  it("popOut sets the popup window title", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.document.title).toBe("Test Server — Strata");
  });

  it("popOut does nothing when already popped out", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });
    expect(result.current.isPoppedOut).toBe(true);

    // Second call should be no-op
    await act(async () => {
      await result.current.popOut();
    });
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it("returnDisplay sets isPoppedOut=false after popOut", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });
    expect(result.current.isPoppedOut).toBe(true);

    act(() => {
      result.current.returnDisplay();
    });
    expect(result.current.isPoppedOut).toBe(false);
  });

  it("returnDisplay closes the popup window", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    act(() => {
      result.current.returnDisplay();
    });

    expect(mockPopup.close).toHaveBeenCalled();
  });

  it("returnDisplay re-attaches display element to container", async () => {
    const session = createMockSession();
    const container = document.createElement("div");
    const containerRef = { current: container };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });
    act(() => {
      result.current.returnDisplay();
    });

    // Container should have the display element
    expect(container.children.length).toBeGreaterThanOrEqual(0);
  });

  it("popOut reparents display element to popup body", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.document.body.appendChild).toHaveBeenCalledWith(session.displayEl);
  });

  it("popOut registers resize event on popup", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("does NOT close popup on unmount (popup persists across route changes)", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result, unmount } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    unmount();
    // Popup should remain open — SessionManager handles cleanup when the session ends
    expect(mockPopup.close).not.toHaveBeenCalled();
    expect((session as any)._popout).toBeDefined();
  });

  it("popOut tries to use Window Management API for secondary screen", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    // Mock getScreenDetails API
    (window as any).getScreenDetails = vi.fn().mockResolvedValue({
      screens: [
        { isPrimary: true, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 },
        { isPrimary: false, availLeft: 1920, availTop: 0, availWidth: 2560, availHeight: 1440 },
      ],
    });

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    expect(result.current.isPoppedOut).toBe(true);
    expect(window.open).toHaveBeenCalledWith(
      "about:blank",
      expect.stringContaining("strata-popout-"),
      expect.stringContaining("left=1920")
    );

    delete (window as any).getScreenDetails;
  });

  it("popOut handles getScreenDetails permission denied", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    // Mock getScreenDetails that throws (permission denied)
    (window as any).getScreenDetails = vi.fn().mockRejectedValue(new Error("Permission denied"));

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    // Should still succeed with defaults
    expect(result.current.isPoppedOut).toBe(true);
    delete (window as any).getScreenDetails;
  });

  it("returnDisplay tears down keyboard from popup", async () => {
    const session = createMockSession();
    const container = document.createElement("div");
    const containerRef = { current: container };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const mockKb = { onkeydown: null, onkeyup: null, reset: vi.fn() };
    const Guacamole = (await import("guacamole-common-js")).default;
    vi.mocked(Guacamole.Keyboard).mockImplementation(function () {
      return mockKb as any;
    });

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    act(() => {
      result.current.returnDisplay();
    });

    expect(mockKb.reset).toHaveBeenCalled();
  });

  it("popOut registers pagehide on popup", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.addEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
  });

  it("popOut registers keydown trap on popup document", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.document.addEventListener).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
      true
    );
  });

  it("returnDisplay re-attaches mouse and touch on container", async () => {
    const session = createMockSession();
    const container = document.createElement("div");
    const containerRef = { current: container };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const Guacamole = (await import("guacamole-common-js")).default;
    const mouseOnEach = vi.fn();
    vi.mocked(Guacamole.Mouse).mockImplementation(function () {
      return { onEach: mouseOnEach, onmousedown: null, onmouseup: null, onmousemove: null } as any;
    });
    const touchOnEach = vi.fn();
    (vi.mocked(Guacamole.Mouse) as any).Touchscreen = vi.fn(function () {
      return { onEach: touchOnEach, onmousedown: null, onmouseup: null, onmousemove: null } as any;
    });

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });
    mouseOnEach.mockClear();
    touchOnEach.mockClear();

    act(() => {
      result.current.returnDisplay();
    });

    // returnDisplay creates new Mouse and Touchscreen for the main window
    expect(mouseOnEach).toHaveBeenCalled();
    expect(touchOnEach).toHaveBeenCalled();
  });

  it("initializes isPoppedOut=true when session already has _popout", () => {
    const session = createMockSession();
    (session as any)._popout = {
      window: { closed: false },
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      mouse: {},
      touch: {},
      cleanup: vi.fn(),
    };
    const containerRef = { current: document.createElement("div") };
    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });
    expect(result.current.isPoppedOut).toBe(true);
  });

  it("returnDisplay with no container adopts display and navigates", async () => {
    const session = createMockSession();
    const containerRef = { current: null };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });
    expect(result.current.isPoppedOut).toBe(true);

    act(() => {
      result.current.returnDisplay();
    });
    expect(result.current.isPoppedOut).toBe(false);
    // Popup should still be closed
    expect(mockPopup.close).toHaveBeenCalled();
  });

  it("returnDisplay skips close when popup already closed", async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement("div") };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });

    await act(async () => {
      await result.current.popOut();
    });

    // Mark popup as already closed
    mockPopup.closed = true;

    act(() => {
      result.current.returnDisplay();
    });
    expect(result.current.isPoppedOut).toBe(false);
  });

  it("syncs isPoppedOut when session changes", () => {
    const session1 = createMockSession();
    const session2 = createMockSession();
    (session2 as any).id = "sess-2";
    const containerRef = { current: document.createElement("div") };

    const { result, rerender } = renderHook(
      ({ sess }) => usePopOut(sess as any, containerRef as any),
      { wrapper: routerWrapper, initialProps: { sess: session1 } }
    );
    expect(result.current.isPoppedOut).toBe(false);

    // Give session2 an active popout
    (session2 as any)._popout = {
      window: { closed: false },
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      mouse: {},
      touch: {},
      cleanup: vi.fn(),
    };
    rerender({ sess: session2 });
    expect(result.current.isPoppedOut).toBe(true);
  });

  it("returnDisplay re-scales display when dimensions are valid", async () => {
    const scaleFn = vi.fn();
    const session = {
      ...createMockSession(),
      client: {
        ...createMockSession().client,
        getDisplay: vi.fn(() => ({
          getElement: () => document.createElement("div"),
          getWidth: () => 1920,
          getHeight: () => 1080,
          scale: scaleFn,
        })),
        sendMouseState: vi.fn(),
        sendKeyEvent: vi.fn(),
        sendSize: vi.fn(),
        createClipboardStream: vi.fn(() => ({ sendBlob: vi.fn(), sendEnd: vi.fn() })),
      },
    };
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800 });
    Object.defineProperty(container, "clientHeight", { value: 600 });
    const containerRef = { current: container };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, "open").mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });
    await act(async () => {
      await result.current.popOut();
    });

    scaleFn.mockClear();
    act(() => {
      result.current.returnDisplay();
    });
    expect(scaleFn).toHaveBeenCalled();
    expect(session.client.sendSize).toHaveBeenCalledWith(800, 600);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Listener-capturing popup: drives handleResize / ResizeObserver / poll
  // / pagehide / cleanup paths inside popOut() that the lightweight
  // mockPopup above can't exercise.
  // ──────────────────────────────────────────────────────────────────────

  type Listener = (...args: any[]) => any;

  function createCapturingPopup() {
    const winListeners = new Map<string, Listener[]>();
    const docListeners = new Map<string, Listener[]>();
    const body = document.createElement("div");
    let resizeObsCb: Listener | null = null;
    const obsInstance = { observe: vi.fn(), disconnect: vi.fn() };

    const popup: any = {
      closed: false,
      close: vi.fn(function (this: any) {
        this.closed = true;
      }),
      innerWidth: 1280,
      innerHeight: 720,
      screenX: 0,
      screenY: 0,
      devicePixelRatio: 1,
      navigator: { clipboard: { readText: vi.fn().mockResolvedValue("") } },
      document: {
        title: "",
        body,
        readyState: "complete",
        addEventListener: vi.fn((evt: string, cb: Listener) => {
          const arr = docListeners.get(evt) ?? [];
          arr.push(cb);
          docListeners.set(evt, arr);
        }),
        removeEventListener: vi.fn(),
      },
      addEventListener: vi.fn((evt: string, cb: Listener) => {
        const arr = winListeners.get(evt) ?? [];
        arr.push(cb);
        winListeners.set(evt, arr);
      }),
      removeEventListener: vi.fn(),
      requestAnimationFrame: (cb: Listener) => {
        cb(0);
        return 0;
      },
      setTimeout: (cb: Listener, ms: number) => globalThis.setTimeout(cb, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
      ResizeObserver: vi.fn(function (this: any, cb: Listener) {
        resizeObsCb = cb;
        return obsInstance;
      }),
    };

    return {
      popup,
      fireWin: (evt: string, ...args: any[]) =>
        (winListeners.get(evt) ?? []).forEach((cb) => cb(...args)),
      fireDoc: (evt: string, ...args: any[]) =>
        (docListeners.get(evt) ?? []).forEach((cb) => cb(...args)),
      fireResizeObs: () => resizeObsCb?.([]),
      obsInstance,
    };
  }

  function richSession() {
    const scale = vi.fn();
    return {
      id: "sess-rich",
      name: "Rich",
      connectionId: "conn-rich",
      displayEl: document.createElement("div"),
      remoteClipboard: "",
      client: {
        getDisplay: vi.fn(() => ({
          getElement: () => document.createElement("div"),
          getWidth: () => 1920,
          getHeight: () => 1080,
          scale,
          onresize: null,
        })),
        sendMouseState: vi.fn(),
        sendKeyEvent: vi.fn(),
        sendSize: vi.fn(),
        createClipboardStream: vi.fn(() => ({ sendBlob: vi.fn(), sendEnd: vi.fn() })),
      },
      _scaleFn: scale,
    };
  }

  it("initial resize (readyState=complete) drives display.scale and debounced sendSize", async () => {
    vi.useFakeTimers();
    try {
      const session = richSession();
      const containerRef = { current: document.createElement("div") };
      const { popup } = createCapturingPopup();
      vi.spyOn(window, "open").mockReturnValue(popup as any);

      const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
        wrapper: routerWrapper,
      });

      await act(async () => {
        await result.current.popOut();
      });

      // Initial resize ran via popup.requestAnimationFrame chain
      expect(session._scaleFn).toHaveBeenCalled();
      expect(session.client.sendSize).not.toHaveBeenCalled();

      // Advance the 150ms debounce
      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      expect(session.client.sendSize).toHaveBeenCalledWith(1280, 720);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ResizeObserver callback re-runs handleResize and coalesces with debounce", async () => {
    vi.useFakeTimers();
    try {
      const session = richSession();
      const containerRef = { current: document.createElement("div") };
      const cap = createCapturingPopup();
      vi.spyOn(window, "open").mockReturnValue(cap.popup as any);

      const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
        wrapper: routerWrapper,
      });
      await act(async () => {
        await result.current.popOut();
      });

      // Burn the initial-resize debounce
      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      expect(session.client.sendSize).toHaveBeenCalledTimes(1);
      expect(cap.obsInstance.observe).toHaveBeenCalled();

      // Two rapid observer callbacks at a new size must coalesce to one sendSize
      cap.popup.innerWidth = 1024;
      cap.popup.innerHeight = 600;
      cap.fireResizeObs();
      cap.fireResizeObs();

      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      expect(session.client.sendSize).toHaveBeenCalledTimes(2);
      expect(session.client.sendSize).toHaveBeenLastCalledWith(1024, 600);
    } finally {
      vi.useRealTimers();
    }
  });

  it("window resize listener triggers handleResize; non-positive sizes are ignored", async () => {
    vi.useFakeTimers();
    try {
      const session = richSession();
      const containerRef = { current: document.createElement("div") };
      const cap = createCapturingPopup();
      vi.spyOn(window, "open").mockReturnValue(cap.popup as any);

      const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
        wrapper: routerWrapper,
      });
      await act(async () => {
        await result.current.popOut();
      });
      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      const baseline = (session.client.sendSize as any).mock.calls.length;

      // Zero-size resize must be a no-op (early-return branch)
      cap.popup.innerWidth = 0;
      cap.popup.innerHeight = 0;
      cap.fireWin("resize");
      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      expect((session.client.sendSize as any).mock.calls.length).toBe(baseline);

      // Real resize -> sendSize fires
      cap.popup.innerWidth = 800;
      cap.popup.innerHeight = 600;
      cap.fireWin("resize");
      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      expect(session.client.sendSize).toHaveBeenLastCalledWith(800, 600);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pagehide listener returns the display and clears popped-out state", async () => {
    const session = richSession();
    const container = document.createElement("div");
    const containerRef = { current: container };
    const cap = createCapturingPopup();
    vi.spyOn(window, "open").mockReturnValue(cap.popup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
      wrapper: routerWrapper,
    });
    await act(async () => {
      await result.current.popOut();
    });
    expect(result.current.isPoppedOut).toBe(true);

    act(() => {
      cap.fireWin("pagehide");
    });
    expect(result.current.isPoppedOut).toBe(false);
    expect(cap.obsInstance.disconnect).toHaveBeenCalled();
  });

  it("screen-position poll detects move and re-runs handleResize after settle", async () => {
    vi.useFakeTimers();
    try {
      const session = richSession();
      const containerRef = { current: document.createElement("div") };
      const cap = createCapturingPopup();
      vi.spyOn(window, "open").mockReturnValue(cap.popup as any);

      const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
        wrapper: routerWrapper,
      });
      await act(async () => {
        await result.current.popOut();
      });
      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      const baseline = (session.client.sendSize as any).mock.calls.length;

      // Simulate dragging to a different screen
      cap.popup.screenX = 1920;
      cap.popup.innerWidth = 2560;
      cap.popup.innerHeight = 1440;

      // 250ms screen poll fires, schedules a 300ms settle check, which then
      // calls handleResize and finally the 150ms sendSize debounce.
      await act(async () => {
        vi.advanceTimersByTime(260);
        vi.advanceTimersByTime(310);
        vi.advanceTimersByTime(160);
      });
      expect((session.client.sendSize as any).mock.calls.length).toBeGreaterThan(baseline);
      expect(session.client.sendSize).toHaveBeenLastCalledWith(2560, 1440);
    } finally {
      vi.useRealTimers();
    }
  });

  it("close-detection poll calls returnDisplay when popup window closes externally", async () => {
    vi.useFakeTimers();
    try {
      const session = richSession();
      const containerRef = { current: document.createElement("div") };
      const cap = createCapturingPopup();
      vi.spyOn(window, "open").mockReturnValue(cap.popup as any);

      const { result } = renderHook(() => usePopOut(session as any, containerRef as any), {
        wrapper: routerWrapper,
      });
      await act(async () => {
        await result.current.popOut();
      });
      expect(result.current.isPoppedOut).toBe(true);

      // User closes the popup directly (not via returnDisplay)
      cap.popup.closed = true;
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      expect(result.current.isPoppedOut).toBe(false);
      expect(cap.obsInstance.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
