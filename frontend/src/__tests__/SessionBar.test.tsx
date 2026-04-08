import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../components/SessionManager', () => ({
  useSessionManager: vi.fn(),
  // GuacSession is an interface, no need to mock if only used as type
}));

import { useSessionManager } from '../components/SessionManager';
import SessionBar from '../components/SessionBar';

// Polyfill ResizeObserver for jsdom
const resizeObserverMock = vi.fn(function() {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

function renderSessionBar() {
  return render(
    <MemoryRouter>
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
    vi.mocked(useSessionManager).mockReturnValue({
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
    });
    const { container } = renderSessionBar();
    expect(container.innerHTML).toBe('');
  });

  it('renders session tabs when sessions exist', () => {
    vi.mocked(useSessionManager).mockReturnValue({
      sessions: [
        {
          id: 'sess-1',
          connectionId: 'conn-1',
          name: 'Server One',
          protocol: 'rdp',
          client: {} as any,
          tunnel: {} as any,
          displayEl: document.createElement('div'),
          keyboard: {} as any,
          createdAt: Date.now(),
          filesystems: [],
          remoteClipboard: '',
        },
      ],
      activeSessionId: 'sess-1',
      setActiveSessionId: vi.fn(),
      closeSession: vi.fn(),
      createSession: vi.fn() as any,
      getSession: vi.fn(),
      tiledSessionIds: [],
      setTiledSessionIds: vi.fn(),
      focusedSessionIds: [],
      setFocusedSessionIds: vi.fn(),
    });
    renderSessionBar();
    // Should render the collapse/expand button with session count badge
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows session count badge', () => {
    vi.mocked(useSessionManager).mockReturnValue({
      sessions: [
        { id: 's1', connectionId: 'c1', name: 'A', protocol: 'rdp', client: {} as any, tunnel: {} as any, displayEl: document.createElement('div'), keyboard: {} as any, createdAt: Date.now(), filesystems: [], remoteClipboard: '' },
        { id: 's2', connectionId: 'c2', name: 'B', protocol: 'ssh', client: {} as any, tunnel: {} as any, displayEl: document.createElement('div'), keyboard: {} as any, createdAt: Date.now(), filesystems: [], remoteClipboard: '' },
      ],
      activeSessionId: 's1',
      setActiveSessionId: vi.fn(),
      closeSession: vi.fn(),
      createSession: vi.fn() as any,
      getSession: vi.fn(),
      tiledSessionIds: [],
      setTiledSessionIds: vi.fn(),
      focusedSessionIds: [],
      setFocusedSessionIds: vi.fn(),
    });
    renderSessionBar();
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
