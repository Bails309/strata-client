import { render, screen, fireEvent, waitFor, act as rtlAct } from '@testing-library/react';
import SessionClient from '../pages/SessionClient';
import * as SessionManagerModule from '../components/SessionManager';
import * as api from '../api';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

// Mock the hooks and components
vi.mock('../components/SessionManager', () => {
  return {
    useSessionManager: vi.fn(),
    SessionManagerProvider: ({ children }: any) => <div>{children}</div>,
  };
});

vi.mock('../api', () => ({
  createTunnelTicket: vi.fn(),
  getConnectionInfo: vi.fn(),
  getConnections: vi.fn(),
  getCredentialProfiles: vi.fn(),
  getMe: vi.fn(),
}));

// Mock ResizeObserver
global.ResizeObserver = vi.fn(function() {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
}) as any;

describe('SessionClient', () => {
  let mockSession: any;
  const mockCreateSession = vi.fn();
  const mockAttachSession = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Create a mock session object that will be returned by useSessionManager
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

    // Setup API mocks
    vi.mocked(api.getConnectionInfo).mockResolvedValue({ protocol: 'ssh', has_credentials: true });
    vi.mocked(api.getConnections).mockResolvedValue([{ id: 'test-conn-id', name: 'Test Session', protocol: 'ssh', hostname: 'localhost', port: 22 }]);
    vi.mocked(api.createTunnelTicket).mockResolvedValue({ ticket: 'test-ticket' });
    vi.mocked(api.getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(api.getMe).mockResolvedValue({ id: '1', username: 'admin', role: 'admin' } as any);

    // Mock window features
    vi.stubGlobal('requestAnimationFrame', (cb: any) => cb());
    
    // Ensure #root exists for the portal
    if (!document.getElementById('root')) {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);
    } else {
      document.getElementById('root')!.innerHTML = '';
    }

    // Default mock implementation
    vi.mocked(SessionManagerModule.useSessionManager).mockImplementation(() => ({
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
    }));
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
    // Use a longer timeout and waitFor for the attachment
    await waitFor(() => {
      expect(mockAttachSession).toHaveBeenCalledWith('sess-test-conn-id');
    }, { timeout: 3000 });
  });

  it('handles SSH credential requirement', async () => {
    await renderSessionClient();
    
    // Wait for the handler to be attached by the component
    await waitFor(() => {
      expect(mockSession.client.onrequired).toBeTypeOf('function');
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
      expect(mockSession.tunnel.oninstruction).toBeTypeOf('function');
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
    
    // Targeted find for the session container that has the listener
    // It's the one with the fixed position and z-index 5
    const containers = document.querySelectorAll('div');
    const target = Array.from(containers).find(c => c.style.zIndex === '5');
    expect(target).toBeTruthy();
    
    fireEvent.mouseEnter(target!);

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
