import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../components/SessionManager', () => ({
  useSessionManager: vi.fn(),
}));

import { useSessionManager } from '../components/SessionManager';
import SessionBar from '../components/SessionBar';

const resizeObserverMock = vi.fn(function() {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

function makeMockSession(id: string, name: string, protocol = 'rdp') {
  return {
    id,
    connectionId: `conn-${id}`,
    name,
    protocol,
    client: {} as any,
    tunnel: {} as any,
    displayEl: document.createElement('div'),
    keyboard: {} as any,
    createdAt: Date.now(),
    filesystems: [],
    remoteClipboard: '',
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
    ...overrides,
  };
}

function renderSessionBar(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SessionBar />
    </MemoryRouter>,
  );
}

describe('SessionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', resizeObserverMock);
  });

  it('renders nothing when sessions is empty', () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock());
    const { container } = renderSessionBar();
    expect(container.innerHTML).toBe('');
  });

  it('renders session tabs when sessions exist', () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [makeMockSession('sess-1', 'Server One')],
      activeSessionId: 'sess-1',
    }));
    renderSessionBar();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows session count badge', () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [
        makeMockSession('s1', 'A'),
        makeMockSession('s2', 'B', 'ssh'),
      ],
      activeSessionId: 's1',
    }));
    renderSessionBar();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows session name and protocol in thumbnail', () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [makeMockSession('s1', 'Prod Server', 'rdp')],
      activeSessionId: 's1',
    }));
    renderSessionBar();
    expect(screen.getByText('RDP')).toBeInTheDocument();
    expect(screen.getByText('Prod Server')).toBeInTheDocument();
  });

  it('shows collapse/expand toggle', async () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [makeMockSession('s1', 'A')],
      activeSessionId: 's1',
    }));
    renderSessionBar();
    const toggle = screen.getByTitle('Collapse sessions');
    expect(toggle).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByTitle('Expand sessions')).toBeInTheDocument();
  });

  it('renders disconnect button per session', () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [
        makeMockSession('s1', 'A'),
        makeMockSession('s2', 'B'),
      ],
      activeSessionId: 's1',
    }));
    renderSessionBar();
    const disconnectBtns = screen.getAllByTitle('Disconnect');
    expect(disconnectBtns).toHaveLength(2);
  });

  it('calls closeSession when disconnect clicked', async () => {
    const closeSession = vi.fn();
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [makeMockSession('s1', 'A')],
      activeSessionId: 's1',
      closeSession,
    }));
    renderSessionBar();
    await userEvent.click(screen.getByTitle('Disconnect'));
    expect(closeSession).toHaveBeenCalledWith('s1');
  });

  it('shows tiled button on tiled route', () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [
        makeMockSession('s1', 'A'),
        makeMockSession('s2', 'B'),
      ],
      activeSessionId: 's1',
      tiledSessionIds: ['s1', 's2'],
    }));
    renderSessionBar('/tiled');
    expect(screen.getByText(/Exit Tiled/)).toBeInTheDocument();
  });

  it('does not show tiled button on non-tiled route', () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [makeMockSession('s1', 'A')],
      activeSessionId: 's1',
      tiledSessionIds: ['s1'],
    }));
    renderSessionBar('/session/conn-s1');
    expect(screen.queryByText(/Tiled/)).not.toBeInTheDocument();
  });

  it('switches session on thumbnail click', async () => {
    const setActiveSessionId = vi.fn();
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [
        makeMockSession('s1', 'Server A'),
        makeMockSession('s2', 'Server B'),
      ],
      activeSessionId: 's1',
      setActiveSessionId,
    }));
    renderSessionBar();
    await userEvent.click(screen.getByText('Server B'));
    expect(setActiveSessionId).toHaveBeenCalledWith('s2');
  });

  it('shows active indicator on active session', () => {
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [
        makeMockSession('s1', 'Active'),
        makeMockSession('s2', 'Inactive'),
      ],
      activeSessionId: 's1',
    }));
    renderSessionBar();
    // Active session thumb should have the active class
    const activeThumb = screen.getByTitle('Active').closest('.session-thumb');
    expect(activeThumb?.className).toContain('session-thumb-active');
  });

  it('shows error styling on errored session', () => {
    const errorSession = makeMockSession('s1', 'Errored');
    (errorSession as any).error = 'Connection failed';
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [errorSession],
      activeSessionId: 's1',
    }));
    renderSessionBar();
    const thumb = screen.getByTitle('Errored').closest('.session-thumb');
    expect(thumb?.className).toContain('session-thumb-error');
  });

  it('tiled button shows count and clears on click', async () => {
    const setTiledSessionIds = vi.fn();
    vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
      sessions: [
        makeMockSession('s1', 'A'),
        makeMockSession('s2', 'B'),
      ],
      activeSessionId: 's1',
      tiledSessionIds: ['s1', 's2'],
      setTiledSessionIds,
    }));
    renderSessionBar('/tiled');
    expect(screen.getByText(/Exit Tiled \(2\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/Exit Tiled/));
    expect(setTiledSessionIds).toHaveBeenCalledWith([]);
  });
});
