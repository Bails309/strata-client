import { renderHook, act as rtlAct } from "@testing-library/react";
import { SessionManagerProvider, useSessionManager } from "../components/SessionManager";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Polyfill ResizeObserver
const resizeObserverMock = vi.fn(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});

// Stable display element + cursor canvas the production code is expected
// to detach. We construct them in-module and re-create per test in
// beforeEach (the mock factory below captures the *getters* so we can
// swap the underlying state).
let displayEl: HTMLDivElement;
let cursorCanvas: HTMLCanvasElement;
let mockDisplay: any;

vi.mock("../api", () => ({
  createTunnelTicket: vi.fn(),
}));

vi.mock("guacamole-common-js", () => {
  const mockClient = {
    getDisplay: () => mockDisplay,
    sendMouseState: vi.fn(),
    sendSize: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    createClipboardStream: vi.fn(() => ({})),
    sendKeyEvent: vi.fn(),
    onclipboard: null as any,
    onfilesystem: null as any,
    onfile: null as any,
    onstatechange: null as any,
    onerror: null as any,
    onrequired: null as any,
    createArgumentValueStream: vi.fn(() => ({})),
  };

  return {
    default: {
      Client: vi.fn().mockImplementation(function () {
        return mockClient;
      }),
      WebSocketTunnel: vi.fn().mockImplementation(function () {
        return { onerror: null, onstatechange: null, oninstruction: null };
      }),
      Mouse: Object.assign(
        vi.fn().mockImplementation(function () {
          return { onEach: vi.fn() };
        }),
        {
          Touchscreen: vi.fn().mockImplementation(function () {
            return { onEach: vi.fn() };
          }),
          Event: vi.fn(),
        }
      ),
      Keyboard: vi.fn().mockImplementation(function () {
        return { onkeydown: null, onkeyup: null, reset: vi.fn() };
      }),
      StringReader: vi.fn().mockImplementation(function () {
        return {};
      }),
      StringWriter: vi.fn().mockImplementation(function () {
        return { sendText: vi.fn(), sendEnd: vi.fn() };
      }),
      BlobReader: vi.fn().mockImplementation(function () {
        return {};
      }),
      GuacObject: vi.fn(),
      InputStream: vi.fn(),
      Status: vi.fn(),
    },
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <SessionManagerProvider>{children}</SessionManagerProvider>;
}

describe("SessionManager — cursor rendering (1.6.0 ghost-cursor fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", resizeObserverMock);

    // Fresh display element with the cursor canvas pre-attached, just
    // like the real Guacamole.Display constructor does.
    displayEl = document.createElement("div");
    cursorCanvas = document.createElement("canvas");
    displayEl.appendChild(cursorCanvas);

    // Stub canvas.toDataURL since jsdom returns a placeholder otherwise.
    cursorCanvas.toDataURL = () => "data:image/png;base64,AAAA";

    mockDisplay = {
      getElement: () => displayEl,
      getWidth: () => 1920,
      getHeight: () => 1080,
      scale: vi.fn(),
      onresize: null as any,
      oncursor: null as any,
      // Real Guacamole.Display.showCursor re-attaches the cursor canvas.
      // Our spy lets us verify the production code replaced it.
      showCursor: vi.fn((shown: boolean) => {
        if (shown !== false && cursorCanvas.parentNode !== displayEl) {
          displayEl.appendChild(cursorCanvas);
        } else if (shown === false) {
          cursorCanvas.parentNode?.removeChild(cursorCanvas);
        }
      }),
      getCursorLayer: () => ({
        getElement: () => cursorCanvas,
      }),
    };
  });

  afterEach(() => vi.restoreAllMocks());

  it("detaches the software cursor canvas on session creation", () => {
    expect(cursorCanvas.parentNode).toBe(displayEl);

    const { result } = renderHook(() => useSessionManager(), { wrapper });
    rtlAct(() => {
      result.current.createSession({
        connectionId: "c1",
        name: "Server A",
        protocol: "rdp",
        containerEl: document.createElement("div"),
        connectParams: new URLSearchParams(),
      });
    });

    expect(cursorCanvas.parentNode).toBeNull();
  });

  it("replaces showCursor with a no-op so server `mouse` instructions can't re-attach the canvas", () => {
    const originalShowCursor = mockDisplay.showCursor;

    const { result } = renderHook(() => useSessionManager(), { wrapper });
    rtlAct(() => {
      result.current.createSession({
        connectionId: "c1",
        name: "Server A",
        protocol: "rdp",
        containerEl: document.createElement("div"),
        connectParams: new URLSearchParams(),
      });
    });

    // Production code overrode the function reference.
    expect(mockDisplay.showCursor).not.toBe(originalShowCursor);

    // Calling the new showCursor does nothing — no cursor canvas in the DOM.
    mockDisplay.showCursor(true);
    mockDisplay.showCursor(true);
    mockDisplay.showCursor(true);
    expect(displayEl.querySelector("canvas")).toBeNull();
  });

  it("oncursor sets a CSS data-URL cursor on the display element", () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });
    rtlAct(() => {
      result.current.createSession({
        connectionId: "c1",
        name: "Server A",
        protocol: "rdp",
        containerEl: document.createElement("div"),
        connectParams: new URLSearchParams(),
      });
    });

    expect(typeof mockDisplay.oncursor).toBe("function");

    // Simulate the server pushing a cursor frame.
    mockDisplay.oncursor(cursorCanvas, 5, 7);

    expect(displayEl.style.cursor).toBe(
      "url(data:image/png;base64,AAAA) 5 7, default"
    );
  });
});
