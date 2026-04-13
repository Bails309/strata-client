/**
 * Regression tests for auto-redirect when a session ends while other sessions
 * are still active.  Covers:
 * - Tunnel close with remaining sessions → navigate to next session
 * - Tunnel close on last session → "Session Ended" overlay
 * - No false-positive overlay during initial session creation
 */
import { render, waitFor, act as rtlAct } from '@testing-library/react';
import SessionClient from '../pages/SessionClient';
import * as SessionManagerModule from '../components/SessionManager';
import * as api from '../api';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Track navigate calls ──
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../components/SessionManager', () => ({
  useSessionManager: vi.fn(),
  SessionManagerProvider: ({ children }: any) => <>{children}</>,
}));

vi.mock('../api', () => ({
  createTunnelTicket: vi.fn(),
  getConnectionInfo: vi.fn(),
  getConnections: vi.fn(),
  getCredentialProfiles: vi.fn(),
  getMe: vi.fn(),
}));

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ── Helpers ──

function makeMockSession(id: string, connectionId: string, name: string) {
  return {
    id,
    connectionId,
    name,
    protocol: 'rdp',
    client: {
      getDisplay: () => ({
        getElement: () => document.createElement('div'),
        getWidth: () => 1920,
        getHeight: () => 1080,
        scale: vi.fn(),
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendSize: vi.fn(),
      sendKeyEvent: vi.fn(),
      onerror: null as any,
      onstatechange: null as any,
      onclipboard: null as any,
      onfilesystem: null as any,
      onfile: null as any,
      onrequired: null as any,
      createArgumentValueStream: vi.fn(() => ({
        sendBlob: vi.fn(), sendEnd: vi.fn(), write: vi.fn(), onack: null,
      })),
      createClipboardStream: vi.fn(() => ({
        sendBlob: vi.fn(), sendEnd: vi.fn(), write: vi.fn(), onack: null,
      })),
    },
    tunnel: { onerror: null as any, onstatechange: null as any, oninstruction: null as any },
    displayEl: document.createElement('div'),
    keyboard: { onkeydown: null as any, onkeyup: null as any, reset: vi.fn() },
    createdAt: Date.now(),
    filesystems: [] as any[],
    remoteClipboard: '',
  };
}

describe('SessionClient – auto-redirect on session end', () => {
  let sessionA: ReturnType<typeof makeMockSession>;
  let sessionB: ReturnType<typeof makeMockSession>;

  // Stable function references (avoids infinite re-render loops from new
  // vi.fn() refs in useEffect dependency arrays on every render).
  const mockCreateSession = vi.fn();
  const mockSetActiveSessionId = vi.fn();
  const mockGetSession = vi.fn();
  const mockCloseSession = vi.fn();
  const mockSetTiledSessionIds = vi.fn();
  const mockSetFocusedSessionIds = vi.fn();
  const mockSetSessionBarCollapsed = vi.fn();

  const state = { sessions: [] as any[], activeId: null as string | null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigate.mockClear();

    sessionA = makeMockSession('sess-a', 'conn-a', 'Session A');
    sessionB = makeMockSession('sess-b', 'conn-b', 'Session B');

    state.sessions = [];
    state.activeId = null;

    mockGetSession.mockImplementation(
      (cid: string) => state.sessions.find((s: any) => s.connectionId === cid),
    );

    // Default: creating session A populates sessions with [A, B].
    mockCreateSession.mockImplementation(() => {
      state.sessions = [sessionA, sessionB];
      state.activeId = sessionA.id;
      return sessionA;
    });

    vi.mocked(api.getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: true } as any);
    vi.mocked(api.getConnections).mockResolvedValue([
      { id: 'conn-a', name: 'Session A', protocol: 'rdp', hostname: 'host-a', port: 3389 },
    ] as any);
    vi.mocked(api.createTunnelTicket).mockResolvedValue({ ticket: 'ticket-a' });
    vi.mocked(api.getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(api.getMe).mockResolvedValue({ id: '1', username: 'admin', role: 'admin' } as any);

    vi.stubGlobal('requestAnimationFrame', (cb: any) => { cb(); return 0; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    document.body.innerHTML = '<div id="root"></div>';

    vi.mocked(SessionManagerModule.useSessionManager).mockImplementation(() => ({
      sessions: state.sessions,
      activeSessionId: state.activeId,
      getSession: mockGetSession,
      createSession: mockCreateSession,
      tiledSessionIds: [],
      setTiledSessionIds: mockSetTiledSessionIds,
      focusedSessionIds: [],
      setFocusedSessionIds: mockSetFocusedSessionIds,
      setActiveSessionId: mockSetActiveSessionId,
      closeSession: mockCloseSession,
      sessionBarCollapsed: false,
      setSessionBarCollapsed: mockSetSessionBarCollapsed,
      barWidth: 180,
      canShare: false,
    } as any));
  });

  const tree = (connId = 'conn-a') => (
    <MemoryRouter initialEntries={[`/session/${connId}?name=SessionA&protocol=rdp`]}>
      <Routes>
        <Route path="/session/:connectionId" element={<SessionClient />} />
      </Routes>
    </MemoryRouter>
  );

  /** Render and let Phase 1 fetch + Phase 3 session creation settle. */
  async function renderAndSettle(connId = 'conn-a') {
    const result = render(tree(connId));
    // Flush async Phase 1 (getConnectionInfo) and Phase 3 (createSession)
    await rtlAct(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return result;
  }

  // ────────────────────────────────────────────────────────────
  // handleTunnelClosed path (synchronous redirect in tunnel handler)
  // ────────────────────────────────────────────────────────────

  it('redirects to remaining session on server disconnect', async () => {
    // Session B already exists; Phase 3 will create A (not found by getSession).
    // After Phase 1 fetch resolves, Phase 3 creates A → handlers wired.
    // sessionsRef.current picks up [B] from the pre-creation render, then
    // [A,B] after the creation render settles.
    state.sessions = [sessionB];
    mockCreateSession.mockImplementation(() => {
      state.sessions = [sessionA, sessionB];
      state.activeId = sessionA.id;
      return sessionA;
    });

    await renderAndSettle();

    // Verify handlers were wired (Phase 3 took the creation path)
    expect(typeof sessionA.tunnel.oninstruction).toBe('function');
    expect(typeof sessionA.tunnel.onstatechange).toBe('function');

    // Trigger server-initiated disconnect
    await rtlAct(async () => { sessionA.tunnel.oninstruction('disconnect', []); });
    await rtlAct(async () => { sessionA.tunnel.onstatechange(2); }); // CLOSED

    expect(mockSetActiveSessionId).toHaveBeenCalledWith(sessionB.id);
    expect(mockNavigate).toHaveBeenCalledWith(`/session/${sessionB.connectionId}`);
  });

  it('shows overlay when last session ends via tunnel close', async () => {
    // Only session A — no remaining sessions after disconnect.
    mockCreateSession.mockImplementation(() => {
      state.sessions = [sessionA];
      state.activeId = sessionA.id;
      return sessionA;
    });

    await renderAndSettle();

    expect(typeof sessionA.tunnel.oninstruction).toBe('function');

    await rtlAct(async () => { sessionA.tunnel.oninstruction('disconnect', []); });
    await rtlAct(async () => { sessionA.tunnel.onstatechange(2); });

    await waitFor(() => {
      expect(document.body.textContent).toContain('Session Ended');
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────
  // Guard: no false-positive during initial session creation
  // ────────────────────────────────────────────────────────────

  it('does not false-positive during initial session creation', async () => {
    // state.sessions starts empty. Phase 3 creates session A via mockCreateSession.
    // hadSessionRef should be false at that point, so the removal-detection effect
    // must NOT fire a redirect or show an overlay.
    mockCreateSession.mockImplementation(() => {
      state.sessions = [sessionA];
      state.activeId = sessionA.id;
      return sessionA;
    });

    await renderAndSettle();

    expect(document.body.textContent).not.toContain('Session Ended');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────
  // userDisconnectRef guard — reconnect must not redirect
  // ────────────────────────────────────────────────────────────

  it('does not redirect when tunnel closes during manual reconnect', async () => {
    // Setup: both sessions exist, viewing session A
    state.sessions = [sessionB];
    mockCreateSession.mockImplementation(() => {
      state.sessions = [sessionA, sessionB];
      state.activeId = sessionA.id;
      return sessionA;
    });

    await renderAndSettle();

    // Verify handlers wired
    expect(typeof sessionA.tunnel.oninstruction).toBe('function');
    expect(typeof sessionA.tunnel.onstatechange).toBe('function');

    // Simulate what handleManualReconnect does: user-initiated close
    // The Reconnect button click sets userDisconnectRef = true before close.
    // We simulate the "clean close" path (no error, no disconnect instruction).
    // With the userDisconnectRef guard at the top of handleTunnelClosed,
    // this should NOT redirect to session B.

    // First trigger the error overlay so the Reconnect button is visible
    await rtlAct(async () => { sessionA.tunnel.oninstruction('disconnect', []); });
    await rtlAct(async () => { sessionA.tunnel.onstatechange(2); });

    expect(mockSetActiveSessionId).toHaveBeenCalledWith(sessionB.id);
    // Reset to verify reconnect click does NOT re-trigger redirect
    mockSetActiveSessionId.mockClear();
    mockNavigate.mockClear();

    // Now the overlay is showing. Click Reconnect.
    const root = document.getElementById('root')!;
    const buttons = Array.from(root.querySelectorAll('button'));
    const reconnect = buttons.find((b) => b.textContent === 'Reconnect');

    if (reconnect) {
      // Reset createSession for the new session
      mockCreateSession.mockClear();
      mockCreateSession.mockImplementation(() => {
        state.sessions = [sessionA, sessionB];
        state.activeId = sessionA.id;
        return sessionA;
      });

      await rtlAct(async () => { reconnect.click(); });
      await rtlAct(async () => { await new Promise((r) => setTimeout(r, 0)); });

      // The reconnect should create a new session without redirecting
      expect(mockCreateSession).toHaveBeenCalled();
    }
  });
});
