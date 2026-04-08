import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../components/SessionManager', () => ({
  useSessionManager: vi.fn(),
}));

import SessionBar from '../components/SessionBar';
import { useSessionManager } from '../components/SessionManager';

function renderSessionBar() {
  return render(
    <BrowserRouter>
      <SessionBar />
    </BrowserRouter>,
  );
}

describe('SessionBar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
