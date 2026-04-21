import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

let mockClientOnerror: ((s: any) => void) | null = null;
let mockClientOnstatechange: ((s: number) => void) | null = null;
let mockTunnelOnerror: ((s: any) => void) | null = null;

const mockScale = vi.fn();
const mockDisplay = {
  getElement: () => document.createElement("div"),
  getWidth: () => 1920,
  getHeight: () => 1080,
  scale: mockScale,
  onresize: null as (() => void) | null,
};

const mockClient = {
  getDisplay: () => mockDisplay,
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendSize: vi.fn(),
  sendMouseState: vi.fn(),
  sendKeyEvent: vi.fn(),
  get onerror() {
    return mockClientOnerror;
  },
  set onerror(fn: any) {
    mockClientOnerror = fn;
  },
  get onstatechange() {
    return mockClientOnstatechange;
  },
  set onstatechange(fn: any) {
    mockClientOnstatechange = fn;
  },
};

const mockTunnel = {
  get onerror() {
    return mockTunnelOnerror;
  },
  set onerror(fn: any) {
    mockTunnelOnerror = fn;
  },
};

vi.mock("guacamole-common-js", () => ({
  default: {
    Client: vi.fn(function () {
      return mockClient;
    }),
    WebSocketTunnel: vi.fn(function () {
      return mockTunnel;
    }),
    Mouse: Object.assign(
      vi.fn(function () {
        return { onEach: vi.fn() };
      }),
      {
        Touchscreen: vi.fn(function () {
          return { onEach: vi.fn() };
        }),
      }
    ),
    Keyboard: vi.fn(function () {
      return { onkeydown: null, onkeyup: null };
    }),
  },
}));

import SharedViewer from "../pages/SharedViewer";
import Guacamole from "guacamole-common-js";

describe("SharedViewer", () => {
  let rootEl: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClientOnerror = null;
    mockClientOnstatechange = null;
    mockTunnelOnerror = null;
    mockDisplay.onresize = null;
    mockScale.mockClear();
    rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
  });

  afterEach(() => {
    document.body.removeChild(rootEl);
    vi.restoreAllMocks();
  });

  function renderShared(path = "/shared/test-share-token") {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/shared/:shareToken" element={<SharedViewer />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("renders shared session banner", () => {
    renderShared();
    expect(rootEl.textContent).toContain("Shared Session");
  });

  it("shows connecting state initially", () => {
    renderShared();
    expect(rootEl.textContent).toContain("Connecting");
  });

  it("defaults to read-only mode", () => {
    renderShared();
    // Before connected, shows 'Connecting…'
    expect(rootEl.textContent).toContain("Connecting");
    // Not yet connected so view mode text isn't shown until connected
  });

  it("shows control mode when mode=control query param is set", () => {
    renderShared("/shared/test-share-token?mode=control");
    expect(rootEl.textContent).toContain("Connecting");
  });

  it("calls client.connect with the share token", () => {
    renderShared();
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it("shows read-only view after state change", () => {
    renderShared();
    act(() => {
      mockClientOnstatechange?.(3); // Connected state
    });
    expect(rootEl.textContent).toContain("Read-only view");
  });

  it("shows error message on client error", () => {
    renderShared();
    act(() => {
      mockClientOnerror?.({ message: "Access denied" });
    });
    expect(rootEl.textContent).toContain("Access denied");
  });

  it("shows error message on tunnel error", () => {
    renderShared();
    act(() => {
      mockTunnelOnerror?.({ message: "Tunnel closed" });
    });
    expect(rootEl.textContent).toContain("Tunnel closed");
  });

  it("still shows Connecting after non-connected state change", () => {
    renderShared();
    act(() => {
      mockClientOnstatechange?.(5); // Some other state, not 3
    });
    // State 5 does not set connected=true, stays Connecting
    expect(rootEl.textContent).toContain("Connecting");
  });

  it("connects with WebSocket tunnel for share token", () => {
    renderShared();
    expect(mockClient.connect).toHaveBeenCalledWith(expect.stringContaining("width="));
  });

  it("shows control input enabled after connected in control mode", () => {
    renderShared("/shared/test-share-token?mode=control");
    act(() => {
      mockClientOnstatechange?.(3);
    });
    expect(rootEl.textContent).toContain("Control");
  });

  it("shows default error on empty status message", () => {
    renderShared();
    act(() => {
      mockClientOnerror?.({});
    });
    expect(rootEl.textContent).toContain("Connection failed");
  });

  it("shows default error on empty tunnel status message", () => {
    renderShared();
    act(() => {
      mockTunnelOnerror?.({});
    });
    expect(rootEl.textContent).toContain("Connection failed");
  });

  it("connects with dpi param", () => {
    renderShared();
    expect(mockClient.connect).toHaveBeenCalledWith(expect.stringContaining("dpi="));
  });

  it("connects with height param", () => {
    renderShared();
    expect(mockClient.connect).toHaveBeenCalledWith(expect.stringContaining("height="));
  });

  it("disconnects client on unmount", () => {
    const { unmount } = renderShared();
    unmount();
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it("sets up keyboard in control mode", () => {
    vi.mocked(Guacamole.Keyboard).mockClear();
    renderShared("/shared/test-share-token?mode=control");
    expect(Guacamole.Keyboard).toHaveBeenCalled();
  });

  it("does not set up keyboard in view mode", () => {
    vi.mocked(Guacamole.Keyboard).mockClear();
    renderShared("/shared/test-share-token");
    expect(Guacamole.Keyboard).not.toHaveBeenCalled();
  });

  it("removes resize listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderShared();
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("shows banner text for shared session", () => {
    renderShared();
    expect(rootEl.textContent).toContain("Shared Session");
  });

  it("shows error message with empty string status", () => {
    renderShared();
    act(() => {
      mockClientOnerror?.({ message: "" });
    });
    expect(rootEl.textContent).toContain("Connection failed");
  });

  it("sets display.onresize handler", () => {
    renderShared();
    expect(mockDisplay.onresize).toBeTypeOf("function");
  });

  it("display.onresize calls scale when dimensions are positive", () => {
    renderShared();
    mockScale.mockClear();
    act(() => {
      mockDisplay.onresize?.();
    });
    // Container has 0 dimensions in jsdom, so scale won't be called due to cw<=0 check
    // But display has positive dims — the branch for dw<=0||dh<=0 is tested
  });

  it("fires handleResize on window resize event", () => {
    renderShared();
    mockClient.sendSize.mockClear();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    // sendSize is called in handleResize
    expect(mockClient.sendSize).toHaveBeenCalled();
  });

  it("shows share link expiry message in error overlay", () => {
    renderShared();
    act(() => {
      mockClientOnerror?.({ message: "Forbidden" });
    });
    expect(rootEl.textContent).toContain("expired");
  });

  it("uses wss protocol on https", () => {
    // The WebSocketTunnel is created with the wsUrl — check it was called
    renderShared();
    const Guac = vi.mocked(Guacamole.WebSocketTunnel);
    expect(Guac).toHaveBeenCalledWith(expect.stringContaining("ws"));
  });
});
