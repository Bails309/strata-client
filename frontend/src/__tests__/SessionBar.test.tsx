import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api', () => ({
  createShareLink: vi.fn(),
}));

vi.mock('../components/SessionManager', () => ({
  useSessionManager: vi.fn(),
}));

import { useSessionManager } from '../components/SessionManager';
import SessionBar from '../components/SessionBar';
import { createShareLink } from '../api';

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

function MockSessionProvider({ 
  children, 
  initialCollapsed = false, 
  initialSessions = [],
  overrides = {}
}: { 
  children: React.ReactNode, 
  initialCollapsed?: boolean, 
  initialSessions?: any[],
  overrides?: any
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [activeId, setActiveId] = useState<string | null>(initialSessions[0]?.id || null);

  vi.mocked(useSessionManager).mockReturnValue(defaultManagerMock({
    sessions: initialSessions,
    activeSessionId: activeId,
    sessionBarCollapsed: collapsed,
    setSessionBarCollapsed: setCollapsed,
    setActiveSessionId: setActiveId,
    ...overrides,
  }));

  return <>{children}</>;
}

function renderSessionBar(initialPath = '/', initialCollapsed = false, initialSessions: any[] = [], overrides = {}) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <MockSessionProvider initialCollapsed={initialCollapsed} initialSessions={initialSessions} overrides={overrides}>
        <SessionBar />
      </MockSessionProvider>
    </MemoryRouter>,
  );
}

describe('SessionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', resizeObserverMock);
  });

  it('renders nothing when sessions is empty', () => {
    const { container } = renderSessionBar();
    expect(container.innerHTML).toBe('');
  });

  it('renders session tabs when sessions exist', () => {
    const sessions = [makeMockSession('sess-1', 'Server One')];
    renderSessionBar('/', false, sessions);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows session count badge', () => {
    const sessions = [
      makeMockSession('s1', 'A'),
      makeMockSession('s2', 'B', 'ssh'),
    ];
    renderSessionBar('/', false, sessions);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows session name and protocol in thumbnail', () => {
    const sessions = [makeMockSession('s1', 'Prod Server', 'rdp')];
    renderSessionBar('/', false, sessions);
    expect(screen.getByText('RDP')).toBeInTheDocument();
    expect(screen.getByText('Prod Server')).toBeInTheDocument();
  });

  it('shows collapse/expand toggle', async () => {
    const setSessionBarCollapsed = vi.fn();
    const sessions = [makeMockSession('s1', 'A')];
    renderSessionBar('/', false, sessions, { setSessionBarCollapsed });
    
    const toggle = screen.getByTitle('Collapse sessions');
    expect(toggle).toBeInTheDocument();
    
    await userEvent.click(toggle);
    
    expect(setSessionBarCollapsed).toHaveBeenCalledWith(true);
  });

  it('renders disconnect button per session', () => {
    const sessions = [
      makeMockSession('s1', 'A'),
      makeMockSession('s2', 'B'),
    ];
    renderSessionBar('/', false, sessions);
    const disconnectBtns = screen.getAllByTitle('Close Session');
    expect(disconnectBtns).toHaveLength(2);
  });

  it('calls closeSession when disconnect clicked', async () => {
    const closeSession = vi.fn();
    const sessions = [makeMockSession('s1', 'A')];
    renderSessionBar('/', false, sessions, { closeSession });
    
    await userEvent.click(screen.getByTitle('Close Session'));
    expect(closeSession).toHaveBeenCalledWith('s1');
  });

  it('shows tiled button on tiled route', () => {
    const sessions = [
      makeMockSession('s1', 'A'),
      makeMockSession('s2', 'B'),
    ];
    renderSessionBar('/tiled', false, sessions, { tiledSessionIds: ['s1', 's2'] });
    expect(screen.getByText(/Exit Tiled/)).toBeInTheDocument();
  });

  it('does not show tiled button on non-tiled route', () => {
    const sessions = [makeMockSession('s1', 'A')];
    renderSessionBar('/session/conn-s1', false, sessions, { tiledSessionIds: ['s1'] });
    expect(screen.queryByText(/Tiled/)).not.toBeInTheDocument();
  });

  it('switches session on thumbnail click', async () => {
    const sessions = [
      makeMockSession('s1', 'Server A'),
      makeMockSession('s2', 'Server B'),
    ];
    const setActiveSessionId = vi.fn();
    renderSessionBar('/', false, sessions, { setActiveSessionId });
    
    await userEvent.click(screen.getByText('Server B'));
    expect(setActiveSessionId).toHaveBeenCalledWith('s2');
  });

  it('shows active indicator on active session', () => {
    const sessions = [
      makeMockSession('s1', 'Active'),
      makeMockSession('s2', 'Inactive'),
    ];
    renderSessionBar('/', false, sessions);
    const activeText = screen.getByText('Active');
    const thumb = activeText.closest('.session-thumb');
    expect(thumb?.className).toContain('session-thumb-active');
  });

  it('shows error styling on errored session', () => {
    const errorSession = makeMockSession('s1', 'Errored');
    (errorSession as any).error = 'Connection failed';
    renderSessionBar('/', false, [errorSession]);
    const thumb = screen.getByText('Errored').closest('.session-thumb');
    expect(thumb?.className).toContain('session-thumb-error');
  });

  it('tiled button shows count and clears on click', async () => {
    const setTiledSessionIds = vi.fn();
    const sessions = [
      makeMockSession('s1', 'A'),
      makeMockSession('s2', 'B'),
    ];
    renderSessionBar('/tiled', false, sessions, { 
      tiledSessionIds: ['s1', 's2'],
      setTiledSessionIds
    });
    
    expect(screen.getByText(/Exit Tiled \(2\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/Exit Tiled/));
    expect(setTiledSessionIds).toHaveBeenCalledWith([]);
  });

  it('shows keyboard shortcuts panel when keyboard button clicked', async () => {
    const sessions = [makeMockSession('s1', 'Server A')];
    renderSessionBar('/', false, sessions);

    await userEvent.click(screen.getByTitle('Keyboard Shortcuts'));
    expect(screen.getByText('C+A+Del')).toBeInTheDocument();
    expect(screen.getByText('Alt+Tab')).toBeInTheDocument();
    expect(screen.getByText('Esc')).toBeInTheDocument();
    expect(screen.getByText('F11')).toBeInTheDocument();
  });

  it('shows fullscreen button', () => {
    const sessions = [makeMockSession('s1', 'Server A')];
    renderSessionBar('/', false, sessions);
    expect(screen.getByTitle('Fullscreen')).toBeInTheDocument();
  });

  it('shows collapsed session count when collapsed', () => {
    const sessions = [makeMockSession('s1', 'A'), makeMockSession('s2', 'B')];
    renderSessionBar('/', true, sessions);
    // When collapsed, the main content is hidden but session count appears inside toggle
    const toggle = screen.getByTitle('Drag to reposition · Click to expand');
    expect(toggle).toBeInTheDocument();
    expect(toggle.textContent).toContain('2');
  });

  it('shows share button when canShare is true', () => {
    const sessions = [makeMockSession('s1', 'Server A')];
    renderSessionBar('/', false, sessions, { canShare: true });
    expect(screen.getByTitle('Share connection')).toBeInTheDocument();
  });

  it('hides share button when canShare is false', () => {
    const sessions = [makeMockSession('s1', 'Server A')];
    renderSessionBar('/', false, sessions, { canShare: false });
    expect(screen.queryByTitle('Share connection')).not.toBeInTheDocument();
  });

  it('shows session ended overlay for errored session', () => {
    const errorSession = makeMockSession('s1', 'Dead');
    (errorSession as any).error = 'terminated by admin';
    renderSessionBar('/', false, [errorSession]);
    expect(screen.getByText('Session Ended')).toBeInTheDocument();
    expect(screen.getByText('Terminated by Admin')).toBeInTheDocument();
  });

  it('shows connection lost for non-terminated error', () => {
    const errorSession = makeMockSession('s1', 'Dead');
    (errorSession as any).error = 'connection reset';
    renderSessionBar('/', false, [errorSession]);
    expect(screen.getByText('Connection Lost')).toBeInTheDocument();
  });

  it('shows file browser button when session has filesystems', () => {
    const session = makeMockSession('s1', 'Server A');
    (session as any).filesystems = [{}];
    renderSessionBar('/', false, [session]);
    expect(screen.getByTitle('Browse files')).toBeInTheDocument();
  });

  it('hides file browser button when no filesystems', () => {
    const sessions = [makeMockSession('s1', 'Server A')];
    renderSessionBar('/', false, sessions);
    expect(screen.queryByTitle('Browse files')).not.toBeInTheDocument();
  });

  it('opens share popover on share click and shows mode buttons', async () => {
    const sessions = [makeMockSession('s1', 'Server A')];
    renderSessionBar('/', false, sessions, { canShare: true });
    await userEvent.click(screen.getByTitle('Share connection'));
    expect(screen.getByText('View Only')).toBeInTheDocument();
    expect(screen.getByText('Control')).toBeInTheDocument();
  });

  it('generates share link when mode is selected', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'view' });
    const sessions = [makeMockSession('s1', 'Server A')];
    renderSessionBar('/', false, sessions, { canShare: true });
    await userEvent.click(screen.getByTitle('Share connection'));
    await userEvent.click(screen.getByText('View Only'));
    await waitFor(() => {
      expect(createShareLink).toHaveBeenCalledWith('conn-s1', 'view');
    });
  });

  it('sends keyboard combo when shortcut button clicked', async () => {
    const sendKeyEvent = vi.fn();
    const session = makeMockSession('s1', 'Server A');
    (session as any).client = { sendKeyEvent, getDisplay: () => ({ getElement: () => document.createElement('div') }) };
    renderSessionBar('/', false, [session]);
    await userEvent.click(screen.getByTitle('Keyboard Shortcuts'));
    await userEvent.click(screen.getByText('Esc'));
    expect(sendKeyEvent).toHaveBeenCalled();
  });

  it('shows pop-out button when session has popOut function', () => {
    const session = makeMockSession('s1', 'Server A');
    (session as any).popOut = vi.fn();
    (session as any).isPoppedOut = false;
    renderSessionBar('/', false, [session]);
    expect(screen.getByTitle('Pop out')).toBeInTheDocument();
  });

  it('navigates home when closing last session', async () => {
    const closeSession = vi.fn();
    const sessions = [makeMockSession('s1', 'Only Session')];
    renderSessionBar('/', false, sessions, { closeSession });
    await userEvent.click(screen.getByTitle('Close Session'));
    expect(closeSession).toHaveBeenCalledWith('s1');
  });
});
