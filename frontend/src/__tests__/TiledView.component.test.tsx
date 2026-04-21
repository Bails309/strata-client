import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import React from "react";

const resizeObserverMock = vi.fn(function () {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

vi.mock("guacamole-common-js", () => ({
  default: {
    Client: vi.fn(function () {
      return {
        getDisplay: () => ({
          getElement: () => document.createElement("div"),
          getWidth: () => 1920,
          getHeight: () => 1080,
          scale: vi.fn(),
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        sendSize: vi.fn(),
        sendKeyEvent: vi.fn(),
        sendMouseState: vi.fn(),
        onclipboard: null,
        onfilesystem: null,
        onfile: null,
        onstatechange: null,
        onerror: null,
        onrequired: null,
        createArgumentValueStream: vi.fn(() => ({})),
      };
    }),
    WebSocketTunnel: vi.fn(function () {
      return { onerror: null };
    }),
    Mouse: Object.assign(
      vi.fn(function () {
        return { onEach: vi.fn() };
      }),
      {
        Touchscreen: vi.fn(function () {
          return { onEach: vi.fn() };
        }),
        Event: vi.fn(),
      }
    ),
    Keyboard: vi.fn(function () {
      return { onkeydown: null, onkeyup: null, reset: vi.fn() };
    }),
    StringWriter: vi.fn(function () {
      return { sendText: vi.fn(), sendEnd: vi.fn() };
    }),
    StringReader: vi.fn(),
    BlobReader: vi.fn(),
    GuacObject: vi.fn(),
  },
}));

function makeMockSession(id: string, name: string, protocol = "rdp") {
  return {
    id,
    connectionId: `conn-${id}`,
    name,
    protocol,
    client: {
      getDisplay: () => ({
        getElement: () => document.createElement("div"),
        getWidth: () => 800,
        getHeight: () => 600,
        scale: vi.fn(),
      }),
      sendKeyEvent: vi.fn(),
      sendMouseState: vi.fn(),
      onrequired: null as any,
      createArgumentValueStream: vi.fn(() => ({})),
    },
    tunnel: { onerror: null },
    displayEl: document.createElement("div"),
    keyboard: { onkeydown: null as any, onkeyup: null as any, reset: vi.fn() },
    createdAt: Date.now(),
    filesystems: [],
    remoteClipboard: "",
    current_hash: "aaa111bbb222ccc333ddd444eee555ff",
  };
}

// These will be populated in beforeEach
let currentMockSessions: any[] = [];
const mockCloseSession = vi.fn();
const mockSetFocusedSessionIds = vi.fn();
const mockSetActiveSessionId = vi.fn();

vi.mock("../components/SessionManager", () => ({
  useSessionManager: () => ({
    sessions: currentMockSessions,
    activeSessionId: currentMockSessions.length > 0 ? currentMockSessions[0].id : null,
    tiledSessionIds: currentMockSessions.map((s) => s.id),
    focusedSessionIds: currentMockSessions.length > 0 ? [currentMockSessions[0].id] : [],
    setActiveSessionId: mockSetActiveSessionId,
    createSession: vi.fn(),
    closeSession: mockCloseSession,
    getSession: vi.fn((id) => currentMockSessions.find((s) => s.id === id)),
    setTiledSessionIds: vi.fn(),
    setFocusedSessionIds: mockSetFocusedSessionIds,
  }),
  SessionManagerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../components/Layout", () => ({
  useSidebarWidth: () => 0,
}));

vi.mock("../components/SessionWatermark", () => ({
  default: () => null,
}));

vi.mock("../api", () => ({
  getMe: vi
    .fn()
    .mockResolvedValue({ username: "admin", client_ip: "10.0.0.1", watermark_enabled: false }),
}));

import TiledView from "../pages/TiledView";

function renderTiledView() {
  return render(
    <MemoryRouter initialEntries={["/tiled"]}>
      <Routes>
        <Route path="/tiled" element={<TiledView />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("TiledView component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", resizeObserverMock);

    currentMockSessions = [
      makeMockSession("s1", "Server A", "rdp"),
      makeMockSession("s2", "Server B", "ssh"),
    ];

    if (!document.getElementById("root")) {
      const root = document.createElement("div");
      root.id = "root";
      document.body.appendChild(root);
    } else {
      document.getElementById("root")!.innerHTML = "";
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it("renders tile for each tiled session", () => {
    renderTiledView();
    expect(document.body.textContent).toContain("Server A");
    expect(document.body.textContent).toContain("Server B");
  });

  it("shows protocol badge for each tile", () => {
    renderTiledView();
    expect(document.body.textContent).toContain("RDP");
    expect(document.body.textContent).toContain("SSH");
  });

  it("shows disconnect button per tile", () => {
    renderTiledView();
    const disconnectBtns = document.querySelectorAll('[title="Disconnect"]');
    expect(disconnectBtns.length).toBe(2);
  });

  it("calls closeSession when tile disconnect clicked", async () => {
    renderTiledView();
    const disconnectBtns = document.querySelectorAll('[title="Disconnect"]');
    await userEvent.click(disconnectBtns[0] as HTMLElement);
    expect(mockCloseSession).toHaveBeenCalledWith("s1");
  });

  it("clicking tile calls setFocusedSessionIds with single session", async () => {
    renderTiledView();
    const tileHeaders = document.querySelectorAll('[style*="letter-spacing"]');
    await userEvent.click(tileHeaders[1] as HTMLElement);
    expect(mockSetFocusedSessionIds).toHaveBeenCalledWith(["s2"]);
  });

  it("focused session keyboard sends key events", () => {
    renderTiledView();
    const kb = currentMockSessions[0].keyboard;
    act(() => {
      kb.onkeydown(65);
    });
    expect(currentMockSessions[0].client.sendKeyEvent).toHaveBeenCalledWith(1, 65);
  });

  it("shows credential prompt when onrequired is triggered", async () => {
    renderTiledView();
    act(() => {
      currentMockSessions[0].client.onrequired(["username", "password"]);
    });
    await waitFor(() => {
      const root = document.getElementById("root")!;
      expect(root.textContent).toContain("Credentials Required");
    });
  });

  it("submits credential form on enter", async () => {
    const user = userEvent.setup();
    renderTiledView();
    act(() => {
      currentMockSessions[0].client.onrequired(["username", "password"]);
    });
    await waitFor(() => {
      const root = document.getElementById("root")!;
      expect(root.textContent).toContain("Credentials Required");
    });

    const root = document.getElementById("root")!;
    const usernameInput = root.querySelector('input[placeholder="Username"]') as HTMLInputElement;
    const passwordInput = root.querySelector('input[placeholder="Password"]') as HTMLInputElement;

    await user.type(usernameInput, "admin");
    await user.type(passwordInput, "secret");

    const submitBtn = root.querySelector('button[type="submit"]') as HTMLElement;
    await user.click(submitBtn);

    expect(currentMockSessions[0].client.createArgumentValueStream).toHaveBeenCalled();
  });

  it("renders session names in title bars", () => {
    renderTiledView();
    expect(document.body.textContent).toContain("Server A");
    expect(document.body.textContent).toContain("Server B");
  });

  it("ctrl+click toggles tile into focus set", () => {
    renderTiledView();
    const portal = document.getElementById("root")!;
    const serverB = Array.from(portal.querySelectorAll("span")).find(
      (s) => s.textContent === "Server B"
    );
    const tileContainer = serverB!.closest('[style*="overflow"]') as HTMLElement;
    fireEvent.mouseDown(tileContainer, { ctrlKey: true });
    expect(mockSetFocusedSessionIds).toHaveBeenCalledWith(["s1", "s2"]);
  });
});
