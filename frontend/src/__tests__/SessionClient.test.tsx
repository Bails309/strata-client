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
}));

vi.mock("../api", () => ({
  createTunnelTicket: vi.fn(),
  getConnectionInfo: vi.fn(),
  getConnections: vi.fn(),
  getCredentialProfiles: vi.fn(),
  getMe: vi.fn(),
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

    mockSession.filesystems = [
      { object: { createOutputStream: vi.fn(() => ({ onack: null })) }, name: "Drive" },
    ];

    await waitFor(() => {
      expect(document.querySelector('[tabindex="0"]')).toBeTruthy();
    });

    const focusable = document.querySelector('[tabindex="0"]')!;
    const file = new File(["hello"], "test.txt", { type: "text/plain" });

    fireEvent.dragOver(focusable);
    fireEvent.drop(focusable, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(mockSession.filesystems[0].object.createOutputStream).toHaveBeenCalled();
    });
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
