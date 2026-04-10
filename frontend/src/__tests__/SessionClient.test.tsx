import { render, screen, fireEvent, waitFor, act as rtlAct } from '@testing-library/react';
import SessionClient from '../pages/SessionClient';
import * as SessionManagerModule from '../components/SessionManager';
import * as api from '../api';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the hooks and components
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

// Mock ResizeObserver properly
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('SessionClient', () => {
  let mockSession: any;
  const mockAttachSession = vi.fn();
  const mockCreateSession = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSession = {
      id: 'sess-test-conn-id',
      connectionId: 'test-conn-id',
      name: 'Test Session',
      protocol: 'ssh',
      client: {
        getDisplay: () => ({ 
          getElement: () => document.createElement('div'), 
          getWidth: () => 1920, 
          getHeight: () => 1080, 
          scale: vi.fn() 
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
          write: vi.fn(),
          onack: null,
        })),
      },
      tunnel: { onerror: null, onstatechange: null, oninstruction: null },
      displayEl: document.createElement('div'),
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      createdAt: Date.now(),
      filesystems: [],
      current_hash: 'hash-123',
      remoteClipboard: '',
    };

    vi.mocked(api.getConnectionInfo).mockResolvedValue({ protocol: 'ssh', has_credentials: true });
    vi.mocked(api.getConnections).mockResolvedValue([{ id: 'test-conn-id', name: 'Test Session', protocol: 'ssh', hostname: 'localhost', port: 22 }]);
    vi.mocked(api.createTunnelTicket).mockResolvedValue({ ticket: 'test-ticket' });
    vi.mocked(api.getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(api.getMe).mockResolvedValue({ id: '1', username: 'admin', role: 'admin' } as any);

    vi.stubGlobal('requestAnimationFrame', (cb: any) => cb());
    
    if (!document.getElementById('root')) {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);
    } else {
      document.getElementById('root')!.innerHTML = '';
    }

    vi.mocked(SessionManagerModule.useSessionManager).mockReturnValue({
      sessions: [mockSession],
      activeSessionId: mockSession.id,
      getSession: vi.fn(() => mockSession),
      createSession: mockCreateSession.mockReturnValue(mockSession),
      attachSession: mockAttachSession,
      tiledSessionIds: [],
      setTiledSessionIds: vi.fn(),
      focusedSessionIds: [],
      setFocusedSessionIds: vi.fn(),
      setActiveSessionId: vi.fn(),
      closeSession: vi.fn(),
      sessionBarCollapsed: false,
      setSessionBarCollapsed: vi.fn(),
      barWidth: 180,
      canShare: false,
    } as any);
  });

  const renderSessionClient = async (id = 'test-conn-id', name = 'Test Session', protocol = 'ssh') => {
    let result: any;
    await rtlAct(async () => {
      result = render(
        <MemoryRouter initialEntries={[`/session/${id}?name=${name}&protocol=${protocol}`]}>
          <Routes>
            <Route path="/session/:connectionId" element={<SessionClient />} />
          </Routes>
        </MemoryRouter>
      );
    });
    return result;
  };

  it('attaches the session on mount', async () => {
    await renderSessionClient();
    await waitFor(() => {
      expect(mockAttachSession).toHaveBeenCalled();
    }, { timeout: 2000 });
  });

  it('handles SSH credential requirement', async () => {
    await renderSessionClient();
    
    await waitFor(() => {
      expect(typeof mockSession.client.onrequired).toBe('function');
    });
    
    await rtlAct(async () => {
      mockSession.client.onrequired(['password']);
    });

    await waitFor(() => {
      expect(screen.getByText(/Credentials Required/i)).toBeInTheDocument();
    });

    const passInput = document.querySelector('input[type="password"]');
    fireEvent.change(passInput!, { target: { value: 'secret' } });
    
    const submitBtn = screen.getByRole('button', { name: /Connect/i });
    fireEvent.click(submitBtn);

    expect(mockSession.client.createArgumentValueStream).toHaveBeenCalledWith('text/plain', 'password');
  });

  it('handles server-initiated disconnect instruction', async () => {
    await renderSessionClient();
    
    await waitFor(() => {
      expect(typeof mockSession.tunnel.oninstruction).toBe('function');
    });

    await rtlAct(async () => {
      mockSession.tunnel.oninstruction('disconnect', []);
    });

    await rtlAct(async () => {
      if (mockSession.tunnel.onstatechange) {
        mockSession.tunnel.onstatechange(2); // CLOSED
      }
    });

    await waitFor(() => {
      expect(screen.getByText(/session has ended/i)).toBeInTheDocument();
    });
  });

  it('triggers clipboard sync on mouse enter', async () => {
    const mockReadText = vi.fn().mockResolvedValue('new-from-local');
    Object.assign(navigator, {
      clipboard: { readText: mockReadText },
    });

    await renderSessionClient();
    
    // Fire on the fixed container that carries the onMouseEnter
    const root = document.getElementById('root')!;
    const container = root.querySelector('.fixed') as HTMLElement;
    expect(container).toBeTruthy();
    
    fireEvent.mouseEnter(container);

    await waitFor(() => {
      expect(mockReadText).toHaveBeenCalled();
    });
  });

  it('handles drag-and-drop file upload', async () => {
    await renderSessionClient();
    
    mockSession.filesystems = [
      { object: { createOutputStream: vi.fn(() => ({ onack: null })) }, name: 'Drive' }
    ];
    
    const focusable = document.querySelector('[tabindex="0"]')!;
    const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
    
    fireEvent.dragOver(focusable);
    fireEvent.drop(focusable, {
      dataTransfer: {
        files: [file],
      },
    });

    await waitFor(() => {
      expect(mockSession.filesystems[0].object.createOutputStream).toHaveBeenCalled();
    });
  });
});
