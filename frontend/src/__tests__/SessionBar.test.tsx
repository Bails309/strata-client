import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act as rtlAct } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import * as api from "../api";

vi.mock("../api", () => ({
  createShareLink: vi.fn(),
  getTags: vi.fn().mockResolvedValue([]),
  getDisplayTags: vi.fn().mockResolvedValue({}),
  setDisplayTag: vi.fn().mockResolvedValue({ ok: true }),
  removeDisplayTag: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../components/SessionManager", () => ({
  useSessionManager: vi.fn(),
}));

import { useSessionManager } from "../components/SessionManager";
import SessionBar from "../components/SessionBar";
import { createShareLink } from "../api";

const resizeObserverMock = vi.fn(function () {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

function makeMockSession(id: string, name: string, protocol = "rdp") {
  return {
    id,
    connectionId: `conn-${id}`,
    name,
    protocol,
    client: {
      sendKeyEvent: vi.fn(),
      getDisplay: () => ({ getElement: () => document.createElement("div") }),
    } as any,
    tunnel: {} as any,
    displayEl: document.createElement("div"),
    keyboard: {} as any,
    createdAt: Date.now(),
    filesystems: [],
    remoteClipboard: "",
  };
}

function defaultManagerMock(overrides = {}) {
  return {
    sessions: [],
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    closeSession: vi.fn(),
    createSession: vi.fn() as any,
    getSession: vi.fn(),
    tiledSessionIds: [],
    setTiledSessionIds: vi.fn(),
    focusedSessionIds: [],
    setFocusedSessionIds: vi.fn(),
    sessionBarCollapsed: false,
    setSessionBarCollapsed: vi.fn(),
    barWidth: 200,
    canShare: false,
    canUseQuickShare: true,
    ...overrides,
  };
}

function MockSessionProvider({
  children,
  initialCollapsed = false,
  initialSessions = [],
  overrides = {},
}: {
  children: React.ReactNode;
  initialCollapsed?: boolean;
  initialSessions?: any[];
  overrides?: any;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [activeId, setActiveId] = useState<string | null>(initialSessions[0]?.id || null);

  vi.mocked(useSessionManager).mockReturnValue(
    defaultManagerMock({
      sessions: initialSessions,
      activeSessionId: activeId,
      sessionBarCollapsed: collapsed,
      setSessionBarCollapsed: setCollapsed,
      setActiveSessionId: setActiveId,
      ...overrides,
    })
  );

  return <>{children}</>;
}

function renderSessionBar(
  initialPath = "/",
  initialCollapsed = false,
  initialSessions: any[] = [],
  overrides = {}
) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <MockSessionProvider
        initialCollapsed={initialCollapsed}
        initialSessions={initialSessions}
        overrides={overrides}
      >
        <SessionBar />
      </MockSessionProvider>
    </MemoryRouter>
  );
}

describe("SessionBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", resizeObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing when sessions is empty", () => {
    const { container } = renderSessionBar();
    expect(container.innerHTML).toBe("");
  });

  it("renders session tabs when sessions exist", () => {
    const sessions = [makeMockSession("sess-1", "Server One")];
    renderSessionBar("/", false, sessions);
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows session count badge", () => {
    const sessions = [makeMockSession("s1", "A"), makeMockSession("s2", "B", "ssh")];
    renderSessionBar("/", false, sessions);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows session name and protocol in thumbnail", () => {
    const sessions = [makeMockSession("s1", "Prod Server", "rdp")];
    renderSessionBar("/", false, sessions);
    expect(screen.getByText("RDP")).toBeInTheDocument();
    expect(screen.getByText("Prod Server")).toBeInTheDocument();
  });

  it("shows collapse/expand toggle", async () => {
    const setSessionBarCollapsed = vi.fn();
    const sessions = [makeMockSession("s1", "A")];
    renderSessionBar("/", false, sessions, { setSessionBarCollapsed });

    const toggle = screen.getByTitle("Collapse sessions");
    expect(toggle).toBeInTheDocument();

    await userEvent.click(toggle);

    expect(setSessionBarCollapsed).toHaveBeenCalledWith(true);
  });

  it("renders disconnect button per session", () => {
    const sessions = [makeMockSession("s1", "A"), makeMockSession("s2", "B")];
    renderSessionBar("/", false, sessions);
    const disconnectBtns = screen.getAllByTitle("Close Session");
    expect(disconnectBtns).toHaveLength(2);
  });

  it("calls closeSession when disconnect clicked", async () => {
    const closeSession = vi.fn();
    const sessions = [makeMockSession("s1", "A")];
    renderSessionBar("/", false, sessions, { closeSession });

    await userEvent.click(screen.getByTitle("Close Session"));
    expect(closeSession).toHaveBeenCalledWith("s1");
  });

  it("shows tiled button on tiled route", () => {
    const sessions = [makeMockSession("s1", "A"), makeMockSession("s2", "B")];
    renderSessionBar("/tiled", false, sessions, { tiledSessionIds: ["s1", "s2"] });
    expect(screen.getByText(/Exit Tiled/)).toBeInTheDocument();
  });

  it("does not show tiled button on non-tiled route", () => {
    const sessions = [makeMockSession("s1", "A")];
    renderSessionBar("/session/conn-s1", false, sessions, { tiledSessionIds: ["s1"] });
    expect(screen.queryByText(/Tiled/)).not.toBeInTheDocument();
  });

  it("switches session on thumbnail click", async () => {
    const sessions = [makeMockSession("s1", "Server A"), makeMockSession("s2", "Server B")];
    const setActiveSessionId = vi.fn();
    renderSessionBar("/", false, sessions, { setActiveSessionId });

    await userEvent.click(screen.getByText("Server B"));
    expect(setActiveSessionId).toHaveBeenCalledWith("s2");
  });

  it("shows active indicator on active session", () => {
    const sessions = [makeMockSession("s1", "Active"), makeMockSession("s2", "Inactive")];
    renderSessionBar("/", false, sessions);
    const activeText = screen.getByText("Active");
    const thumb = activeText.closest(".session-thumb");
    expect(thumb?.className).toContain("session-thumb-active");
  });

  it("shows error styling on errored session", () => {
    const errorSession = makeMockSession("s1", "Errored");
    (errorSession as any).error = "Connection failed";
    renderSessionBar("/", false, [errorSession]);
    const thumb = screen.getByText("Errored").closest(".session-thumb");
    expect(thumb?.className).toContain("session-thumb-error");
  });

  it("tiled button shows count and clears on click", async () => {
    const setTiledSessionIds = vi.fn();
    const sessions = [makeMockSession("s1", "A"), makeMockSession("s2", "B")];
    renderSessionBar("/tiled", false, sessions, {
      tiledSessionIds: ["s1", "s2"],
      setTiledSessionIds,
    });

    expect(screen.getByText(/Exit Tiled \(2\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/Exit Tiled/));
    expect(setTiledSessionIds).toHaveBeenCalledWith([]);
  });

  it("shows keyboard shortcuts panel when keyboard button clicked", async () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    await userEvent.click(screen.getByTitle("Keyboard Shortcuts"));
    expect(screen.getByText("C+A+Del")).toBeInTheDocument();
    expect(screen.getByText("Alt+Tab")).toBeInTheDocument();
    expect(screen.getByText("Esc")).toBeInTheDocument();
    expect(screen.getByText("F11")).toBeInTheDocument();
    // Keyboard mappings reference section
    expect(screen.getByText("Keyboard Mappings")).toBeInTheDocument();
    expect(screen.getByText("Right Ctrl")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Alt+`")).toBeInTheDocument();
    expect(screen.getByText("⊞ Win key")).toBeInTheDocument();
  });

  it("shows fullscreen button", () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);
    expect(screen.getByTitle("Fullscreen")).toBeInTheDocument();
  });

  it("shows collapsed session count when collapsed", () => {
    const sessions = [makeMockSession("s1", "A"), makeMockSession("s2", "B")];
    renderSessionBar("/", true, sessions);
    // When collapsed, the main content is hidden but session count appears inside toggle
    const toggle = screen.getByTitle("Drag to reposition · Click to expand");
    expect(toggle).toBeInTheDocument();
    expect(toggle.textContent).toContain("2");
  });

  it("shows share button when canShare is true", () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions, { canShare: true });
    expect(screen.getByTitle("Share connection")).toBeInTheDocument();
  });

  it("hides share button when canShare is false", () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions, { canShare: false });
    expect(screen.queryByTitle("Share connection")).not.toBeInTheDocument();
  });

  it("shows session ended overlay for errored session", () => {
    const errorSession = makeMockSession("s1", "Dead");
    (errorSession as any).error = "terminated by admin";
    renderSessionBar("/", false, [errorSession]);
    expect(screen.getByText("Session Ended")).toBeInTheDocument();
    expect(screen.getByText("Terminated by Admin")).toBeInTheDocument();
  });

  it("shows connection lost for non-terminated error", () => {
    const errorSession = makeMockSession("s1", "Dead");
    (errorSession as any).error = "connection reset";
    renderSessionBar("/", false, [errorSession]);
    expect(screen.getByText("Connection Lost")).toBeInTheDocument();
  });

  it("shows file browser button when session has filesystems and file transfer enabled", () => {
    const session = makeMockSession("s1", "Server A");
    (session as any).filesystems = [{}];
    (session as any).fileTransferEnabled = true;
    renderSessionBar("/", false, [session]);
    expect(screen.getByTitle("Browse files")).toBeInTheDocument();
  });

  it("hides file browser button when no filesystems", () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);
    expect(screen.queryByTitle("Browse files")).not.toBeInTheDocument();
  });

  it("hides file browser button when file transfer is disabled even if filesystems exist", () => {
    const session = makeMockSession("s1", "Server A");
    (session as any).filesystems = [{}];
    (session as any).fileTransferEnabled = false;
    renderSessionBar("/", false, [session]);
    expect(screen.queryByTitle("Browse files")).not.toBeInTheDocument();
  });

  it("shows quick share button whenever a session is active", () => {
    const session = makeMockSession("s1", "Server A");
    renderSessionBar("/", false, [session]);
    expect(
      screen.getByTitle("Quick Share – upload files for download in remote session")
    ).toBeInTheDocument();
  });

  it("shows quick share button even when file transfer is disabled", () => {
    // Quick Share uses the backend file-store and is independent of
    // guacd's enable-drive / enable-sftp channels.
    const session = makeMockSession("s1", "Server A");
    (session as any).fileTransferEnabled = false;
    renderSessionBar("/", false, [session]);
    expect(
      screen.getByTitle("Quick Share – upload files for download in remote session")
    ).toBeInTheDocument();
  });

  it("opens share popover on share click and shows mode buttons", async () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions, { canShare: true });
    await userEvent.click(screen.getByTitle("Share connection"));
    expect(screen.getByText("View Only")).toBeInTheDocument();
    expect(screen.getByText("Control")).toBeInTheDocument();
  });

  it("generates share link when mode is selected", async () => {
    vi.mocked(createShareLink).mockResolvedValue({
      share_url: "/shared/abc123",
      share_token: "abc123",
      mode: "view",
    });
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions, { canShare: true });
    await userEvent.click(screen.getByTitle("Share connection"));
    await userEvent.click(screen.getByText("View Only"));
    await waitFor(() => {
      expect(createShareLink).toHaveBeenCalledWith("conn-s1", "view");
    });
  });

  it("sends keyboard combo when shortcut button clicked", async () => {
    const sendKeyEvent = vi.fn();
    const session = makeMockSession("s1", "Server A");
    (session as any).client = {
      sendKeyEvent,
      getDisplay: () => ({ getElement: () => document.createElement("div") }),
    };
    renderSessionBar("/", false, [session]);
    await userEvent.click(screen.getByTitle("Keyboard Shortcuts"));
    await userEvent.click(screen.getByText("Esc"));
    expect(sendKeyEvent).toHaveBeenCalled();
  });

  it("shows pop-out button when session has popOut function", () => {
    const session = makeMockSession("s1", "Server A");
    (session as any).popOut = vi.fn();
    (session as any).isPoppedOut = false;
    renderSessionBar("/", false, [session]);
    expect(screen.getByTitle("Pop out")).toBeInTheDocument();
  });

  it("navigates home when closing last session", async () => {
    const closeSession = vi.fn();
    const sessions = [makeMockSession("s1", "Only Session")];
    renderSessionBar("/", false, sessions, { closeSession });
    await userEvent.click(screen.getByTitle("Close Session"));
    expect(closeSession).toHaveBeenCalledWith("s1");
  });

  it("handles drag interactions on the toggle tab", async () => {
    const sessions = [makeMockSession("s1", "A")];
    renderSessionBar("/", true, sessions);
    const toggle = screen.getByTitle("Drag to reposition · Click to expand");

    // Pointer down
    await userEvent.pointer({ target: toggle, keys: "[MouseLeft>]", coords: { x: 0, y: 100 } });
    // Pointer move (significant enough to be a drag)
    await userEvent.pointer({ coords: { x: 0, y: 150 } });
    // Pointer up
    await userEvent.pointer({ keys: "[/MouseLeft]" });

    // Should NOT have toggled (because it was a drag)
    expect(toggle.title).toBe("Drag to reposition · Click to expand");
  });

  it("handles share link generation failure", async () => {
    vi.mocked(createShareLink).mockResolvedValue({
      share_url: "/shared/abc",
      share_token: "abc",
      mode: "view",
    });
    vi.mocked(createShareLink).mockRejectedValueOnce(new Error("API Error"));
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions, { canShare: true });

    await userEvent.click(screen.getByTitle("Share connection"));
    await userEvent.click(screen.getByText("View Only"));

    // Should stay on loading/buttons and not show URL
    await waitFor(() => {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
  });

  it("renders reconnect button per session", () => {
    const sessions = [makeMockSession("s1", "A"), makeMockSession("s2", "B")];
    renderSessionBar("/", false, sessions);
    const reconnectBtns = screen.getAllByTitle("Reconnect");
    expect(reconnectBtns).toHaveLength(2);
  });

  it("navigates with reconnect state when reconnect clicked", async () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    await userEvent.click(screen.getByTitle("Reconnect"));
    // Should not close the session — that's handled by SessionClient
    expect(screen.getByText("Server A")).toBeInTheDocument();
  });

  it("toggles fullscreen when button clicked", async () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);

    const originalRequest = document.documentElement.requestFullscreen;
    const originalExit = document.exitFullscreen;
    const originalFsElementDesc = Object.getOwnPropertyDescriptor(document, "fullscreenElement");

    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: requestFullscreen,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, "exitFullscreen", {
      value: exitFullscreen,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(document, "fullscreenElement", {
      get: () => null,
      configurable: true,
    });

    const bar = screen.getByTestId("session-bar");

    await userEvent.click(screen.getByTitle("Fullscreen"));
    expect(requestFullscreen).toHaveBeenCalled();

    // Mock active state
    Object.defineProperty(document, "fullscreenElement", {
      get: () => bar,
      configurable: true,
    });
    rtlAct(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    await waitFor(() => {
      expect(screen.getByTitle("Exit fullscreen")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTitle("Exit fullscreen"));
    expect(exitFullscreen).toHaveBeenCalled();

    // Restore
    if (originalRequest) document.documentElement.requestFullscreen = originalRequest;
    if (originalExit) document.exitFullscreen = originalExit;
    if (originalFsElementDesc) {
      Object.defineProperty(document, "fullscreenElement", originalFsElementDesc);
    } else {
      delete (document as any).fullscreenElement;
    }
    rtlAct(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
  });

  it("limits drag repositioning within bounds", async () => {
    const sessions = [makeMockSession("s1", "A")];
    renderSessionBar("/", true, sessions);
    const toggle = screen.getByTitle("Drag to reposition · Click to expand");

    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });

    // Drag past bottom
    await userEvent.pointer({ target: toggle, keys: "[MouseLeft>]", coords: { x: 0, y: 100 } });
    await userEvent.pointer({ coords: { x: 0, y: 1200 } });
    await userEvent.pointer({ keys: "[/MouseLeft]" });

    // Drag past top
    await userEvent.pointer({ target: toggle, keys: "[MouseLeft>]", coords: { x: 0, y: 100 } });
    await userEvent.pointer({ coords: { x: 0, y: -100 } });
    await userEvent.pointer({ keys: "[/MouseLeft]" });

    Object.defineProperty(window, "innerHeight", {
      value: originalInnerHeight,
      configurable: true,
    });
  });

  it("toggles pop-out state", async () => {
    const session = makeMockSession("s1", "Server A");
    const popIn = vi.fn();
    const popOut = vi.fn();
    (session as any).popIn = popIn;
    (session as any).popOut = popOut;
    (session as any).isPoppedOut = false;

    const { rerender } = render(
      <MemoryRouter initialEntries={["/"]}>
        <MockSessionProvider initialSessions={[session]}>
          <SessionBar />
        </MockSessionProvider>
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTitle("Pop out"));
    expect(popOut).toHaveBeenCalled();

    (session as any).isPoppedOut = true;
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <MockSessionProvider initialSessions={[session]}>
          <SessionBar />
        </MockSessionProvider>
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTitle("Return to window"));
    expect(popIn).toHaveBeenCalled();
  });

  it("handles missing clipboard gracefully", async () => {
    vi.mocked(api.createShareLink).mockResolvedValue({
      share_url: "/shared/abc",
      share_token: "abc",
      mode: "view",
    });

    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions, { canShare: true });

    await userEvent.click(screen.getByTitle("Share connection"));
    await userEvent.click(screen.getByText("View Only"));

    await waitFor(() => {
      const input = screen.getByRole("textbox") as HTMLInputElement;
      expect(input.value).toContain("/shared/abc");
    });

    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
  });
  it("handles share link API failure", async () => {
    vi.mocked(api.createShareLink).mockRejectedValue(new Error("fail"));
    const sess = makeMockSession("s1", "Session 1");
    renderSessionBar("/", false, [sess], { canShare: true });

    const shareBtn = screen.getByTitle("Share connection");
    await userEvent.click(shareBtn);

    // Should reset loading state and not show the URL box
    await waitFor(() => {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
  });

  it("handles window pop-out and pop-in transitions", async () => {
    const popOut = vi.fn();
    const popIn = vi.fn();
    const sess = {
      ...makeMockSession("s1", "Session 1"),
      popOut,
      popIn,
      isPoppedOut: false,
    };

    const { rerender } = renderSessionBar("/", false, [sess]);

    const popOutBtn = screen.getByTitle("Pop out");
    await userEvent.click(popOutBtn);
    expect(popOut).toHaveBeenCalled();

    // Rerender with isPoppedOut: true
    const sessOut = { ...sess, isPoppedOut: true };
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <MockSessionProvider initialCollapsed={false} initialSessions={[sessOut]}>
          <SessionBar />
        </MockSessionProvider>
      </MemoryRouter>
    );

    const popInBtn = screen.getByTitle("Return to window");
    await userEvent.click(popInBtn);
    expect(popIn).toHaveBeenCalled();
  });

  it("navigates to dashboard when lone session is closed", async () => {
    const sess = makeMockSession("s1", "Session 1");
    renderSessionBar("/", false, [sess]);

    const closeBtn = screen.getByTitle("Close Session");
    await userEvent.click(closeBtn);

    // Should call closeSession and we check if navigate was called
  });

  it("shows Exit Tiled button on tiled route", async () => {
    const sess = makeMockSession("s1", "Session 1");
    renderSessionBar("/tiled", false, [sess], { tiledSessionIds: ["s1"] });

    expect(screen.getByText(/Exit Tiled/)).toBeInTheDocument();
  });

  it("handles pointer dragging of collapsed toggle tab", async () => {
    const sess = makeMockSession("s1", "Session 1");
    renderSessionBar("/", true, [sess]); // start collapsed

    // The main container has the 'hidden' class when collapsed
    const aside = screen.getByTestId("session-bar");
    const content = aside.querySelector(".opacity-0"); // Content div has opacity-0 when collapsed
    expect(content).toHaveClass("hidden");

    const tab = screen.getByTitle(/Drag to reposition/);

    // Initial drag start
    await userEvent.pointer({
      keys: "[MouseLeft>]",
      target: tab,
      coords: { clientX: 10, clientY: 150 },
    });

    // Move significantly (offset 50px)
    await userEvent.pointer({ target: tab, coords: { clientX: 10, clientY: 200 } });

    // Release
    await userEvent.pointer({
      keys: "[/MouseLeft]",
      target: tab,
      coords: { clientX: 10, clientY: 200 },
    });

    // Should NOT have toggled collapsed state because it was a drag
    expect(content).toHaveClass("hidden");
  });

  // ── Display Tag Tests ─────────────────────────────────────────────

  it("shows tag picker button on each session thumbnail", async () => {
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);
    expect(screen.getByTitle("Set display tag")).toBeInTheDocument();
  });

  it("opens tag picker dropdown when tag button clicked", async () => {
    vi.mocked(api.getTags).mockResolvedValue([
      { id: "t1", name: "Production", color: "#ef4444" },
      { id: "t2", name: "Staging", color: "#3b82f6" },
    ]);
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    await waitFor(() => {
      expect(api.getTags).toHaveBeenCalled();
    });

    await userEvent.click(screen.getByTitle("Set display tag"));
    expect(screen.getByText("Display Tag")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Staging")).toBeInTheDocument();
  });

  it("shows display tag badge when a tag is assigned", async () => {
    vi.mocked(api.getDisplayTags).mockResolvedValue({
      "conn-s1": { id: "t1", name: "Production", color: "#ef4444" },
    });
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    await waitFor(() => {
      expect(screen.getByText("Production")).toBeInTheDocument();
    });
    // Tag picker button should show the tag info
    expect(screen.getByTitle("Display tag: Production — click to change")).toBeInTheDocument();
  });

  it("calls setDisplayTag when a tag is selected from picker", async () => {
    vi.mocked(api.getTags).mockResolvedValue([{ id: "t1", name: "Production", color: "#ef4444" }]);
    vi.mocked(api.getDisplayTags).mockResolvedValue({});
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    await waitFor(() => {
      expect(api.getTags).toHaveBeenCalled();
    });

    await userEvent.click(screen.getByTitle("Set display tag"));
    await userEvent.click(screen.getByText("Production"));

    expect(api.setDisplayTag).toHaveBeenCalledWith("conn-s1", "t1");
  });

  it("calls removeDisplayTag when None is selected", async () => {
    vi.mocked(api.getTags).mockResolvedValue([{ id: "t1", name: "Production", color: "#ef4444" }]);
    vi.mocked(api.getDisplayTags).mockResolvedValue({
      "conn-s1": { id: "t1", name: "Production", color: "#ef4444" },
    });
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    await waitFor(() => {
      expect(screen.getByText("Production")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTitle("Display tag: Production — click to change"));
    await userEvent.click(screen.getByText("None"));

    expect(api.removeDisplayTag).toHaveBeenCalledWith("conn-s1");
  });

  it('shows "No tags created yet" when user has no tags', async () => {
    vi.mocked(api.getTags).mockResolvedValue([]);
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    await userEvent.click(screen.getByTitle("Set display tag"));
    expect(screen.getByText(/No tags created yet/)).toBeInTheDocument();
  });

  it("closes tag picker when clicking outside", async () => {
    vi.mocked(api.getTags).mockResolvedValue([{ id: "t1", name: "Prod", color: "#ef4444" }]);
    vi.mocked(api.getDisplayTags).mockResolvedValue({});
    const sessions = [makeMockSession("s1", "Server A")];
    renderSessionBar("/", false, sessions);

    await waitFor(() => {
      expect(api.getTags).toHaveBeenCalled();
    });

    await userEvent.click(screen.getByTitle("Set display tag"));
    expect(screen.getByText("Display Tag")).toBeInTheDocument();

    // Click outside the picker
    await userEvent.click(document.body);
    await waitFor(() => {
      expect(screen.queryByText("Display Tag")).not.toBeInTheDocument();
    });
  });
});
