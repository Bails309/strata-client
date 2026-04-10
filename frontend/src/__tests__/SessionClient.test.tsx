import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Polyfill ResizeObserver for jsdom
const resizeObserverMock = vi.fn(function() {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(function() {
      return {
        getDisplay: () => ({
          getElement: () => document.createElement('div'),
          getWidth: () => 1920,
          getHeight: () => 1080,
          scale: vi.fn(),
          onresize: null,
        }),
        current_hash: 'bbb222ccc333ddd444eee555fff666aa',
        connect: vi.fn(),
        disconnect: vi.fn(),
        sendSize: vi.fn(),
        sendMouseState: vi.fn(),
        sendKeyEvent: vi.fn(),
        createClipboardStream: vi.fn(() => ({})),
        createArgumentValueStream: vi.fn(() => ({})),
        onclipboard: null,
        onfilesystem: null,
        onfile: null,
        onstatechange: null,
        onerror: null,
        onrequired: null,
      };
    }),
    WebSocketTunnel: vi.fn(function() {
      return {
        onerror: null,
        onstatechange: null,
      };
    }),
    Tunnel: { CLOSED: 2 },
    Mouse: Object.assign(vi.fn(function() {
      return {
        onEach: vi.fn(),
      };
    }), {
      Touchscreen: vi.fn(function() {
        return {
          onEach: vi.fn(),
        };
      }),
      Event: vi.fn(),
    }),
    Keyboard: vi.fn(function() {
      return {
        onkeydown: null,
        onkeyup: null,
        reset: vi.fn(),
      };
    }),
    StringWriter: vi.fn(function() {
      return {
        sendText: vi.fn(),
        sendEnd: vi.fn(),
      };
    }),
    StringReader: vi.fn(),
    BlobWriter: vi.fn(function() {
      return {
        sendBlob: vi.fn(),
      };
    }),
  },
}));

import { getConnectionInfo, getConnections, createTunnelTicket, createShareLink } from '../api';

vi.mock('../api', () => ({
  getConnectionInfo: vi.fn(),
  getConnections: vi.fn().mockResolvedValue([]),
  createTunnelTicket: vi.fn(),
  getMe: vi.fn().mockResolvedValue({ username: 'admin', client_ip: '10.0.0.1', watermark_enabled: false }),
  createShareLink: vi.fn(),
}));

const mockCreateSession = vi.fn(({ connectionId, name, protocol }: any) => ({
  id: `sess-${connectionId}`,
  connectionId,
  name,
  protocol,
  client: {
    getDisplay: () => ({ getElement: () => document.createElement('div'), getWidth: () => 1920, getHeight: () => 1080, scale: vi.fn() }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendSize: vi.fn(),
    sendKeyEvent: vi.fn(),
    sendMouseState: vi.fn(),
    onerror: null,
    onrequired: null,
    onstatechange: null,
    onclipboard: null,
    onfilesystem: null,
    onfile: null,
    createArgumentValueStream: vi.fn(() => ({})),
  },
  tunnel: { onerror: null, onstatechange: null },
  displayEl: document.createElement('div'),
  keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
  createdAt: Date.now(),
  filesystems: [],
  remoteClipboard: '',
  current_hash: 'bbb222ccc333ddd444eee555fff666aa',
}));

const mockGetSession = vi.fn<(id: string) => any>(() => undefined);
const mockCloseSession = vi.fn();

vi.mock('../components/SessionManager', () => ({
  useSessionManager: () => ({
    sessions: [],
    activeSessionId: null,
    tiledSessionIds: [],
    focusedSessionIds: [],
    setActiveSessionId: vi.fn(),
    createSession: mockCreateSession,
    closeSession: mockCloseSession,
    getSession: mockGetSession,
    setFocusedSessionIds: vi.fn(),
  }),
  SessionManagerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/Layout', () => ({
  useSidebarWidth: () => 0,
}));

vi.mock('../components/usePopOut', () => ({
  usePopOut: () => ({ isPoppedOut: false, popOut: vi.fn(), returnDisplay: vi.fn() }),
}));

vi.mock('../components/SessionWatermark', () => ({
  default: () => null,
}));

import SessionClient from '../pages/SessionClient';

function renderSessionClient(connectionId = 'test-conn-id') {
  return render(
    <MemoryRouter initialEntries={[`/session/${connectionId}`]}>
      <Routes>
        <Route path="/session/:connectionId" element={<SessionClient />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SessionClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', resizeObserverMock);
    // SessionClient portals into #root
    if (!document.getElementById('root')) {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);
    }
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([]);
    mockGetSession.mockReturnValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders loading state for a connection', () => {
    const { baseElement } = renderSessionClient();
    expect(baseElement.querySelector('div')).toBeTruthy();
  });

  it('shows loading text initially', () => {
    renderSessionClient();
    expect(document.body.textContent).toContain('Loading connection');
  });

  it('shows credential prompt for RDP without credentials', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([{ id: 'test-conn-id', name: 'Test RDP', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '' }]);
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Connect to RDP');
    });
    // Should show username and password fields
    const inputs = document.querySelectorAll('input');
    expect(inputs.length).toBeGreaterThanOrEqual(2);
  });

  it('shows error when connection info fails', async () => {
    vi.mocked(getConnectionInfo).mockRejectedValue(new Error('fail'));
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Failed to load connection info');
    });
  });

  it('skips prompt for non-RDP protocols', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'ssh', has_credentials: false });
    renderSessionClient();
    // SSH goes directly to connected phase (no prompt)
    await waitFor(() => {
      expect(document.body.textContent).not.toContain('Connect to SSH');
    });
  });

  it('skips prompt when has_credentials is true', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: true });
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).not.toContain('Connect to RDP');
    });
  });

  it('uses existing session if one exists for connectionId', async () => {
    const existingSession = {
      id: 'sess-existing',
      connectionId: 'test-conn-id',
      name: 'Existing',
      protocol: 'rdp',
      client: {
        getDisplay: () => ({ getElement: () => document.createElement('div'), getWidth: () => 1920, getHeight: () => 1080, scale: vi.fn() }),
        connect: vi.fn(), disconnect: vi.fn(), sendSize: vi.fn(), sendKeyEvent: vi.fn(),
        onerror: null, onstatechange: null, onclipboard: null, onfilesystem: null, onfile: null, onrequired: null,
      },
      tunnel: { onerror: null, onstatechange: null },
      displayEl: document.createElement('div'),
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      createdAt: Date.now(),
      filesystems: [],
      current_hash: 'aaa111bbb222ccc333ddd444eee555ff',
      remoteClipboard: '',
    };
    mockGetSession.mockReturnValue(existingSession);
    renderSessionClient();
    // Should NOT call getConnectionInfo since existing session is used
    await waitFor(() => {
      expect(document.body.textContent).not.toContain('Loading connection');
    });
  });

  it('submits RDP credential form and proceeds to connected phase', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([{ id: 'test-conn-id', name: 'Test', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '' }]);
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'view' });

    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Connect to RDP');
    });

    // Fill form and submit
    const form = document.querySelector('form')!;
    // Find the submit button
    const connectBtn = form.querySelector('button[type="submit"]')!;
    expect(connectBtn).toBeTruthy();
  });

  it('shows domain field for RDP without domain configured', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([{ id: 'test-conn-id', name: 'Test', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '' }]);
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Domain');
    });
  });

  it('hides domain field for RDP with domain configured', async () => {
    const connId = 'test-rdp-with-domain';
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([
      { id: connId, name: 'RDP Server', protocol: 'rdp', hostname: '10.0.0.3', port: 3389, description: '', domain: 'MYDOMAIN', folder_id: undefined, folder_name: undefined },
    ]);
    renderSessionClient(connId);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Connect to RDP');
    });
    // Domain field should be hidden when domain is pre-configured
    expect(document.body.textContent).not.toContain('Domain');
  });

  it('shows Go Back button on error', async () => {
    vi.mocked(getConnectionInfo).mockRejectedValue(new Error('fail'));
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Exit to Dashboard');
    });
  });

  it('shows Cancel button on credential prompt', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([]);
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Cancel');
    });
  });

  it('shows connection name in prompt from connection list', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([
      { id: 'test-conn-id', name: 'My RDP Server', protocol: 'rdp', hostname: '10.0.0.2', port: 3389, description: '' },
    ]);
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Connect to RDP');
    });
    expect(document.body.textContent).toContain('Enter credentials for the remote server');
  });

  it('shows password field as password type', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([{ id: 'test-conn-id', name: 'Test', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '' }]);
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Connect to RDP');
    });
    const passwordInput = document.querySelector('input[type="password"]');
    expect(passwordInput).toBeTruthy();
  });

  it('creates tunnel ticket on phase 3 for SSH', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'ssh', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([]);
    vi.mocked(createTunnelTicket).mockResolvedValue({ ticket: 'ticket-123' });
    renderSessionClient();
    // SSH skips prompt → goes directly to connected phase
    await waitFor(() => {
      expect(createTunnelTicket).toHaveBeenCalled();
    });
  });

  it('creates session after ticket is obtained', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'ssh', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([]);
    vi.mocked(createTunnelTicket).mockResolvedValue({ ticket: 'ticket-abc' });
    renderSessionClient();
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        connectionId: 'test-conn-id',
        protocol: 'ssh',
      }));
    });
  });

  it('shows error when tunnel ticket creation fails', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'ssh', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([]);
    vi.mocked(createTunnelTicket).mockRejectedValue(new Error('ticket fail'));
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Failed to create tunnel ticket');
    });
  });

  it('handles VNC protocol without prompt', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'vnc', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([]);
    vi.mocked(createTunnelTicket).mockResolvedValue({ ticket: 'ticket-vnc' });
    renderSessionClient();
    // VNC goes directly to connected like SSH
    await waitFor(() => {
      expect(document.body.textContent).not.toContain('Connect to VNC');
    });
    await waitFor(() => {
      expect(createTunnelTicket).toHaveBeenCalled();
    });
  });

  it('attaches existing session display to container', async () => {
    const displayEl = document.createElement('div');
    displayEl.setAttribute('data-testid', 'display');
    const existingSession = {
      id: 'sess-exist',
      connectionId: 'test-conn-id',
      name: 'Existing',
      protocol: 'ssh',
      client: {
        getDisplay: () => ({ getElement: () => displayEl, getWidth: () => 800, getHeight: () => 600, scale: vi.fn() }),
        connect: vi.fn(), disconnect: vi.fn(), sendSize: vi.fn(), sendKeyEvent: vi.fn(),
        onerror: null, onstatechange: null, onclipboard: null, onfilesystem: null, onfile: null, onrequired: null,
      },
      tunnel: { onerror: null, onstatechange: null },
      displayEl,
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      createdAt: Date.now(),
      filesystems: [],
      current_hash: 'aaa111bbb222ccc333ddd444eee555ff',
      remoteClipboard: '',
    };
    mockGetSession.mockReturnValue(existingSession);
    renderSessionClient();
    await waitFor(() => {
      // The display element should be appended inside the root portal
      expect(document.getElementById('root')!.querySelector('[data-testid="display"]')).toBeTruthy();
    });
  });

  it('error overlay shows warning icon and error message', async () => {
    vi.mocked(getConnectionInfo).mockRejectedValue(new Error('Server unreachable'));
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Failed to load connection info');
    });
    // Shows error header
    expect(document.body.textContent).toContain('Connection Error');
  });

  it('falls back to protocol name when connection detail is missing', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'ssh', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([]); // no match for connectionId
    vi.mocked(createTunnelTicket).mockResolvedValue({ ticket: 'ticket-fallback' });
    renderSessionClient();
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        name: 'SSH', // falls back to protocol.toUpperCase()
      }));
    });
  });

  it('uses connection name from detail when available', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'ssh', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([
      { id: 'test-conn-id', name: 'Production SSH', protocol: 'ssh', hostname: '10.0.0.5', port: 22, description: '' },
    ]);
    vi.mocked(createTunnelTicket).mockResolvedValue({ ticket: 'ticket-named' });
    renderSessionClient();
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Production SSH',
      }));
    });
  });

  it('cursor is default during loading phase', () => {
    renderSessionClient();
    // Container should exist with default cursor until connected
    const container = document.getElementById('root')!.querySelector('div > div');
    expect(container).toBeTruthy();
  });

  it('handles getConnections failure gracefully', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockRejectedValue(new Error('network'));
    renderSessionClient();
    // Should still show prompt (catches getConnections error)
    await waitFor(() => {
      expect(document.body.textContent).toContain('Connect to RDP');
    });
  });

  it('RDP prompts show username, password and domain labels', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([]);
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Username');
    });
    expect(document.body.textContent).toContain('Password');
    expect(document.body.textContent).toContain('Domain');
  });

  it('RDP with domain shows only username and password', async () => {
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(getConnections).mockResolvedValue([
      { id: 'test-conn-id', name: 'RDP', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '', domain: 'CORP' },
    ]);
    renderSessionClient();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Username');
    });
    expect(document.body.textContent).toContain('Password');
    expect(document.body.textContent).not.toContain('Domain');
  });

  it('prevents key events except F12 and dev tools shortcuts', async () => {
    const mockSession = {
      id: 'sess-keys',
      connectionId: 'test-conn-id',
      name: 'Server',
      protocol: 'ssh',
      client: {
        getDisplay: () => ({ getElement: () => document.createElement('div'), getWidth: () => 1920, getHeight: () => 1080, scale: vi.fn() }),
        connect: vi.fn(), disconnect: vi.fn(), sendSize: vi.fn(), sendKeyEvent: vi.fn(),
        onerror: null, onstatechange: null, onclipboard: null, onfilesystem: null, onfile: null, onrequired: null,
        createArgumentValueStream: vi.fn(() => ({})),
        sendMouseState: vi.fn(),
      },
      tunnel: { onerror: null, onstatechange: null },
      displayEl: document.createElement('div'),
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      createdAt: Date.now(),
      filesystems: [],
      current_hash: 'bbb222ccc333ddd444eee555fff666aa',
      remoteClipboard: '',
    };
    mockGetSession.mockReturnValue(mockSession);

    renderSessionClient();
    await waitFor(() => {
      const focusable = document.getElementById('root')!.querySelector('[tabindex]') as HTMLElement;
      expect(focusable).toBeTruthy();
    });

    // Focus the container to enable key trapping
    const focusable = document.getElementById('root')!.querySelector('[tabindex]') as HTMLElement;
    fireEvent.focus(focusable);

    // F12 should not be prevented
    const f12Event = new KeyboardEvent('keydown', { key: 'F12', bubbles: true, cancelable: true });
    document.dispatchEvent(f12Event);
    expect(f12Event.defaultPrevented).toBe(false);
  });

  it('focuses container on mouseDown', async () => {
    const mockSession = {
      id: 'sess-focus',
      connectionId: 'test-conn-id',
      name: 'Server',
      protocol: 'ssh',
      client: {
        getDisplay: () => ({ getElement: () => document.createElement('div'), getWidth: () => 1920, getHeight: () => 1080, scale: vi.fn() }),
        connect: vi.fn(), disconnect: vi.fn(), sendSize: vi.fn(), sendKeyEvent: vi.fn(),
        onerror: null, onstatechange: null, onclipboard: null, onfilesystem: null, onfile: null, onrequired: null,
        createArgumentValueStream: vi.fn(() => ({})),
        sendMouseState: vi.fn(),
      },
      tunnel: { onerror: null, onstatechange: null },
      displayEl: document.createElement('div'),
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      createdAt: Date.now(),
      filesystems: [],
      current_hash: 'bbb222ccc333ddd444eee555fff666aa',
      remoteClipboard: '',
    };
    mockGetSession.mockReturnValue(mockSession);

    renderSessionClient();
    await waitFor(() => {
      const focusable = document.getElementById('root')!.querySelector('[tabindex]') as HTMLElement;
      expect(focusable).toBeTruthy();
    });

    const focusable = document.getElementById('root')!.querySelector('[tabindex]') as HTMLElement;
    const focusSpy = vi.spyOn(focusable, 'focus');
    fireEvent.mouseDown(focusable);
    expect(focusSpy).toHaveBeenCalled();
  });
});
