import { render, fireEvent, waitFor, act as rtlAct, within } from "@testing-library/react";
import SessionClient from "../pages/SessionClient";
import * as SessionManagerModule from "../components/SessionManager";
import * as api from "../api";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the hooks and components
vi.mock("../components/SessionManager", () => ({
  useSessionManager: vi.fn(),
  SessionManagerProvider: ({ children }: any) => <>{children}</>,
  remoteDisplayMetrics: (w: number, h: number, dpr = 1) => ({
    width: Math.round(w * dpr),
    height: Math.round(h * dpr),
    dpi: 96,
  }),
  sendSizeFromCss: vi.fn(),
  sendSizeWithDpi: vi.fn(),
}));

vi.mock("../api", () => ({
  createTunnelTicket: vi.fn(),
  getConnectionInfo: vi.fn(),
  getConnections: vi.fn(),
  getCredentialProfiles: vi.fn(),
  getMe: vi.fn(),
  getMyConnections: vi.fn().mockResolvedValue([]),
  getTags: vi.fn().mockResolvedValue([]),
  getConnectionTags: vi.fn().mockResolvedValue([]),
  getConnectionFolders: vi.fn().mockResolvedValue([]),
  // v1.12.13 added a per-connection display-tag lookup in the
  // browser-tab-title effect. Default to an empty map so the title
  // effect falls back to the pre-v1.12.13 `${name} — Strata` format.
  getDisplayTags: vi.fn().mockResolvedValue({}),
  postCommandAudit: vi.fn().mockResolvedValue(undefined),
  BUILTIN_COMMANDS: ["reload", "disconnect", "fullscreen", "commands", "close", "explorer"],
  MAX_OPEN_PATH_LEN: 1024,
}));

// Mock ResizeObserver
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("SessionClient", () => {
  let mockSession: any;
  const mockCreateSession = vi.fn();
  const mockSetActiveSessionId = vi.fn();
  const mockCloseSession = vi.fn();
  const mockGetSession = vi.fn();

  // Mutable state that tracks what createSession produces, so the mock
  // returns the session in `sessions` on subsequent renders.
  const state = { sessions: [] as any[], activeId: null as string | null };

  beforeEach(() => {
    vi.clearAllMocks();
    state.sessions = [];
    state.activeId = null;

    mockSession = {
      id: "sess-test-conn-id",
      connectionId: "test-conn-id",
      name: "Test Session",
      protocol: "ssh",
      client: {
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
        onerror: null,
        onstatechange: null,
        onclipboard: null,
        onfilesystem: null,
        onfile: null,
        onrequired: null,
        createArgumentValueStream: vi.fn(() => ({
          sendBlob: vi.fn(),
          sendEnd: vi.fn(),
          write: vi.fn(),
          onack: null,
        })),
        createClipboardStream: vi.fn(() => ({
          sendBlob: vi.fn(),
          sendEnd: vi.fn(),
          write: vi.fn(),
          onack: null,
        })),
      },
      tunnel: { onerror: null, onstatechange: null, oninstruction: null },
      displayEl: document.createElement("div"),
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      createdAt: Date.now(),
      filesystems: [],
      current_hash: "hash-123",
      remoteClipboard: "",
    };

    // When createSession is called, put the session into mutable state
    // so subsequent useSessionManager calls see it.
    mockCreateSession.mockImplementation(() => {
      state.sessions = [mockSession];
      state.activeId = mockSession.id;
      return mockSession;
    });

    vi.mocked(api.getConnectionInfo).mockResolvedValue({ protocol: "ssh", has_credentials: true });
    vi.mocked(api.getConnections).mockResolvedValue([
      {
        id: "test-conn-id",
        name: "Test Session",
        protocol: "ssh",
        hostname: "localhost",
        port: 22,
      },
    ]);
    vi.mocked(api.createTunnelTicket).mockResolvedValue({ ticket: "test-ticket" });
    vi.mocked(api.getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(api.getMe).mockResolvedValue({ id: "1", username: "admin", role: "admin" } as any);

    vi.stubGlobal("requestAnimationFrame", (cb: any) => {
      cb();
      return 0;
    });

    document.body.innerHTML = '<div id="root"></div>';

    // useSessionManager reads from mutable `state` so sessions become
    // visible after createSession is called.
    mockGetSession.mockImplementation((id: string) =>
      state.sessions.find((s: any) => s.connectionId === id)
    );

    vi.mocked(SessionManagerModule.useSessionManager).mockImplementation(
      () =>
        ({
          sessions: state.sessions,
          activeSessionId: state.activeId,
          getSession: mockGetSession,
          createSession: mockCreateSession,
          tiledSessionIds: [],
          setTiledSessionIds: vi.fn(),
          focusedSessionIds: [],
          setFocusedSessionIds: vi.fn(),
          setActiveSessionId: mockSetActiveSessionId,
          closeSession: mockCloseSession,
          sessionBarCollapsed: false,
          setSessionBarCollapsed: vi.fn(),
          barWidth: 180,
          canShare: false,
        }) as any
    );
  });

  const renderSessionClient = async (id = "test-conn-id") => {
    await rtlAct(async () => {
      render(
        <MemoryRouter initialEntries={[`/session/${id}?name=Test&protocol=ssh`]}>
          <Routes>
            <Route path="/session/:connectionId" element={<SessionClient />} />
          </Routes>
        </MemoryRouter>
      );
    });
    // Let the async Phase 3 effect (createTunnelTicket â†’ createSession) complete
    await rtlAct(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it("attaches the session on mount", async () => {
    await renderSessionClient();
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  it("names the session from the connection info", async () => {
    vi.mocked(api.getConnectionInfo).mockResolvedValue({
      name: "Jump Host",
      protocol: "ssh",
      has_credentials: true,
    });
    await renderSessionClient();
    await waitFor(() =>
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({ name: "Jump Host" }))
    );
  });

  it("handles SSH credential requirement", async () => {
    await renderSessionClient();

    // wireSessionErrorHandlers sets onrequired on the newly created session
    await waitFor(() => {
      expect(typeof mockSession.client.onrequired).toBe("function");
    });

    await rtlAct(async () => {
      mockSession.client.onrequired(["password"]);
    });

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText(/Credentials Required/i)).toBeInTheDocument();
    });

    const passInput = document.querySelector('input[type="password"]');
    fireEvent.change(passInput!, { target: { value: "secret" } });

    const form = document.querySelector("form")!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockSession.client.createArgumentValueStream).toHaveBeenCalledWith(
        "text/plain",
        "password"
      );
    });
  });

  it("handles server-initiated disconnect instruction", async () => {
    await renderSessionClient();

    await waitFor(() => {
      expect(typeof mockSession.tunnel.oninstruction).toBe("function");
    });

    await rtlAct(async () => {
      mockSession.tunnel.oninstruction("disconnect", []);
    });

    await rtlAct(async () => {
      if (mockSession.tunnel.onstatechange) {
        mockSession.tunnel.onstatechange(2); // CLOSED
      }
    });

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText(/session has ended/i)).toBeInTheDocument();
    });
  });

  it("titles a remote sign-out by its status code, not as a connection error", async () => {
    await renderSessionClient();

    await waitFor(() => {
      expect(typeof mockSession.tunnel.oninstruction).toBe("function");
    });

    const message = "You signed out of the remote session.";
    await rtlAct(async () => {
      mockSession.tunnel.oninstruction("error", [message, "523"]);
      mockSession.client.onerror({ code: 0x020b, message });
    });
    await rtlAct(async () => {
      mockSession.tunnel.onstatechange(2);
    });

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText(message)).toBeInTheDocument();
    });
    expect(root.getByText("Session Ended")).toBeInTheDocument();
    expect(root.queryByText("Connection Error")).not.toBeInTheDocument();
  });

  it("focuses container on mouseDown", async () => {
    await renderSessionClient();

    await waitFor(() => {
      expect(document.querySelector('[tabindex="0"]')).toBeTruthy();
    });

    const container = document.querySelector('[tabindex="0"]') as HTMLElement;
    container.focus = vi.fn();
    fireEvent.mouseDown(container);

    expect(container.focus).toHaveBeenCalled();
  });

  it("handles drag-and-drop file upload", async () => {
    await renderSessionClient();

    // The real BlobWriter reads the file asynchronously and then writes to the
    // stream; a stream without sendBlob threw after the test had finished.
    const stream = { onack: null, sendBlob: vi.fn(), sendEnd: vi.fn() };
    mockSession.filesystems = [
      { object: { createOutputStream: vi.fn(() => stream) }, name: "Drive" },
    ];

    await waitFor(() => {
      expect(document.querySelector('[tabindex="0"]')).toBeTruthy();
    });

    const focusable = document.querySelector('[tabindex="0"]')!;
    const file = new File(["hello"], "test.txt", { type: "text/plain" });

    fireEvent.dragOver(focusable);
    fireEvent.drop(focusable, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(mockSession.filesystems[0].object.createOutputStream).toHaveBeenCalledWith(
        "text/plain",
        "/test.txt"
      );
    });
    await waitFor(() => expect(stream.sendBlob).toHaveBeenCalled());
  });

  it("shows Reconnect button on error overlay and reconnects on click", async () => {
    await renderSessionClient();

    await waitFor(() => {
      expect(typeof mockSession.tunnel.oninstruction).toBe("function");
    });
    await rtlAct(async () => {
      mockSession.tunnel.oninstruction("disconnect", []);
    });
    await rtlAct(async () => {
      mockSession.tunnel.onstatechange(2);
    });

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText(/session has ended/i)).toBeInTheDocument();
    });

    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(() => {
      state.sessions = [mockSession];
      state.activeId = mockSession.id;
      return mockSession;
    });

    await rtlAct(async () => {
      fireEvent.click(root.getByText("Reconnect"));
    });
    await rtlAct(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(api.createTunnelTicket).toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("stops reconnecting automatically when the connection keeps dropping", async () => {
    // Each reconnect yields a fresh session, as SessionManager does.
    let latest = mockSession;
    mockCreateSession.mockImplementation(() => {
      latest = {
        ...mockSession,
        id: `sess-${mockCreateSession.mock.calls.length}`,
        tunnel: { onerror: null, onstatechange: null, oninstruction: null },
        // Older than the 10 s backoff reset, like a session that ran a minute.
        createdAt: Date.now() - 60_000,
      };
      state.sessions = [latest];
      state.activeId = latest.id;
      return latest;
    });
    await renderSessionClient();
    await waitFor(() => expect(typeof latest.tunnel.onerror).toBe("function"));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(api.createTunnelTicket).mockClear();
      for (let drop = 1; drop <= 6; drop++) {
        const dropped = latest;
        await rtlAct(async () => {
          dropped.tunnel.onerror({ code: 0x0207, message: "" });
          dropped.tunnel.onstatechange(2);
        });
        await rtlAct(async () => {
          await vi.advanceTimersByTimeAsync(1100);
        });
      }
    } finally {
      vi.useRealTimers();
    }

    // Five automatic reconnects, then the sixth drop gives up.
    expect(api.createTunnelTicket).toHaveBeenCalledTimes(5);
    const root = within(document.getElementById("root")!);
    await waitFor(() =>
      expect(
        root.getByText(/kept dropping, so automatic reconnection has stopped/)
      ).toBeInTheDocument()
    );
    expect(root.getByText("Connection Lost")).toBeInTheDocument();
    expect(root.getByText("Reconnect")).toBeInTheDocument();
  });

  it("shows Reconnecting\u2026 text while reconnect is in progress", async () => {
    await renderSessionClient();

    await waitFor(() => {
      expect(typeof mockSession.tunnel.oninstruction).toBe("function");
    });
    await rtlAct(async () => {
      mockSession.tunnel.oninstruction("disconnect", []);
    });
    await rtlAct(async () => {
      mockSession.tunnel.onstatechange(2);
    });

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText("Reconnect")).toBeInTheDocument();
    });

    let resolveTicket!: (v: any) => void;
    vi.mocked(api.createTunnelTicket).mockReturnValue(
      new Promise((r) => {
        resolveTicket = r;
      })
    );

    await rtlAct(async () => {
      fireEvent.click(root.getByText("Reconnect"));
    });

    await waitFor(
      () => {
        expect(root.getByText("Reconnecting\u2026")).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
    await rtlAct(async () => {
      resolveTicket({ ticket: "new-ticket" });
    });
    await rtlAct(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  it("shows error message when reconnect fails", async () => {
    await renderSessionClient();

    await waitFor(() => {
      expect(typeof mockSession.tunnel.oninstruction).toBe("function");
    });
    await rtlAct(async () => {
      mockSession.tunnel.oninstruction("disconnect", []);
    });
    await rtlAct(async () => {
      mockSession.tunnel.onstatechange(2);
    });

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText("Reconnect")).toBeInTheDocument();
    });

    vi.mocked(api.createTunnelTicket).mockRejectedValueOnce(new Error("fail"));

    await rtlAct(async () => {
      fireEvent.click(root.getByText("Reconnect"));
    });
    await rtlAct(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => {
      expect(root.getByText(/Failed to reconnect/i)).toBeInTheDocument();
    });
  });

  it("closes existing live session before reconnecting", async () => {
    await renderSessionClient();
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(typeof mockSession.tunnel.oninstruction).toBe("function");
    });
    await rtlAct(async () => {
      mockSession.tunnel.oninstruction("disconnect", []);
    });
    await rtlAct(async () => {
      mockSession.tunnel.onstatechange(2);
    });

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText("Reconnect")).toBeInTheDocument();
    });

    state.sessions = [mockSession];
    mockGetSession.mockImplementation((id: string) =>
      state.sessions.find((s: any) => s.connectionId === id)
    );
    mockCloseSession.mockClear();

    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(() => {
      state.sessions = [mockSession];
      state.activeId = mockSession.id;
      return mockSession;
    });

    await rtlAct(async () => {
      fireEvent.click(root.getByText("Reconnect"));
    });
    await rtlAct(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockCloseSession).toHaveBeenCalledWith(mockSession.id);
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("shows Exit to Dashboard button on error overlay", async () => {
    await renderSessionClient();

    await waitFor(() => {
      expect(typeof mockSession.tunnel.oninstruction).toBe("function");
    });
    await rtlAct(async () => {
      mockSession.tunnel.oninstruction("disconnect", []);
    });
    await rtlAct(async () => {
      mockSession.tunnel.onstatechange(2);
    });

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText("Exit to Dashboard")).toBeInTheDocument();
    });
  });

  it("shows credential prompt with vault profiles", async () => {
    vi.mocked(api.getConnectionInfo).mockResolvedValue({
      protocol: "rdp",
      has_credentials: false,
      pre_connect_fields: ["username", "password"],
    } as any);
    vi.mocked(api.getCredentialProfiles).mockResolvedValue([
      { id: "p1", label: "My Profile", expires_at: null },
    ] as any);

    await renderSessionClient();

    const root = within(document.getElementById("root")!);
    await waitFor(() => {
      expect(root.getByText(/Connect to RDP/i)).toBeInTheDocument();
    });
    expect(root.getByText("Saved Credential Profile")).toBeInTheDocument();
  });

  it("sends the domain typed at the prompt", async () => {
    vi.mocked(api.getConnectionInfo).mockResolvedValue({ protocol: "rdp", has_credentials: false });
    vi.mocked(api.getCredentialProfiles).mockResolvedValue([]);
    await renderSessionClient();

    const root = within(document.getElementById("root")!);
    const input = async (label: string) =>
      (await root.findByText(label)).nextElementSibling as HTMLInputElement;
    fireEvent.change(await input("Username"), { target: { value: "alice" } });
    fireEvent.change(await input("Password"), { target: { value: "pw" } });
    fireEvent.change(await input("Domain"), { target: { value: " CORP " } });
    fireEvent.submit(root.getByRole("button", { name: "Connect" }).closest("form")!);

    await waitFor(() =>
      expect(api.createTunnelTicket).toHaveBeenCalledWith(
        expect.objectContaining({ username: "alice", password: "pw", domain: "CORP" })
      )
    );
  });

  it("does not ask for a domain the connection already sets", async () => {
    vi.mocked(api.getConnectionInfo).mockResolvedValue({
      protocol: "rdp",
      has_credentials: false,
      has_domain: true,
    });
    vi.mocked(api.getCredentialProfiles).mockResolvedValue([]);
    await renderSessionClient();

    const root = within(document.getElementById("root")!);
    expect(await root.findByText("Username")).toBeInTheDocument();
    expect(root.queryByText("Domain")).not.toBeInTheDocument();
  });

  it("does not prompt for credentials on a VDI connection", async () => {
    // VDI tunnels as RDP at the wire level but Strata auto-provisions
    // ephemeral credentials on the backend (the entrypoint creates
    // the local Linux account from VDI_USERNAME/VDI_PASSWORD), so the
    // operator should never see a credentials dialog.
    vi.mocked(api.getConnectionInfo).mockResolvedValue({
      protocol: "vdi",
      has_credentials: false,
    } as any);
    vi.mocked(api.getCredentialProfiles).mockResolvedValue([]);

    await renderSessionClient();

    // We should land in the "connected" phase, which means a session
    // was created without ever showing the credentials prompt.
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
    });
    const root = within(document.getElementById("root")!);
    expect(root.queryByText(/Connect to (RDP|VDI)/i)).not.toBeInTheDocument();
    expect(root.queryByText("Saved Credential Profile")).not.toBeInTheDocument();
  });
});
