import { render, screen, renderHook, act as rtlAct } from '@testing-library/react';
import { SessionManagerProvider, useSessionManager } from '../components/SessionManager';
import Guacamole from 'guacamole-common-js';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Polyfill ResizeObserver for jsdom
const resizeObserverMock = vi.fn(function() {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

// Mock api
vi.mock('../api', () => ({
  getMe: vi.fn().mockResolvedValue({ id: '1', username: 'admin', role: 'admin', client_ip: '127.0.0.1', watermark_enabled: false, vault_configured: false, can_manage_system: true, can_manage_users: true, can_manage_connections: true, can_view_audit_logs: true, can_create_users: true, can_create_user_groups: true, can_create_connections: true, can_create_connection_folders: true, can_create_sharing_profiles: true }),
  createTunnelTicket: vi.fn(),
}));

// Mock guacamole-common-js
vi.mock('guacamole-common-js', () => {
  const mockDisplay = {
    getElement: () => document.createElement('div'),
    getWidth: () => 1920,
    getHeight: () => 1080,
    scale: vi.fn(),
    onresize: null as any,
  };
  const mockClient = {
    getDisplay: () => mockDisplay,
    sendMouseState: vi.fn(),
    sendSize: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    createClipboardStream: vi.fn(() => ({})),
    sendKeyEvent: vi.fn(),
    onclipboard: null as any,
    onfilesystem: null as any,
    onfile: null as any,
    onstatechange: null as any,
    onerror: null as any,
    onrequired: null as any,
    createArgumentValueStream: vi.fn(() => ({})),
  };

  return {
    default: {
      Client: vi.fn().mockImplementation(function() { return mockClient; }),
      WebSocketTunnel: vi.fn().mockImplementation(function() {
        return {
          onerror: null,
          onstatechange: null,
          oninstruction: null,
        };
      }),
      Mouse: Object.assign(vi.fn().mockImplementation(function() {
        return {
          onEach: vi.fn(),
        };
      }), {
        Touchscreen: vi.fn().mockImplementation(function() {
          return {
            onEach: vi.fn(),
          };
        }),
        Event: vi.fn(),
      }),
      Keyboard: vi.fn().mockImplementation(function() {
        return {
          onkeydown: null,
          onkeyup: null,
          reset: vi.fn(),
        };
      }),
      StringReader: vi.fn().mockImplementation(function() { return {}; }),
      StringWriter: vi.fn().mockImplementation(function() {
        return {
          sendText: vi.fn(),
          sendEnd: vi.fn(),
        };
      }),
      BlobReader: vi.fn().mockImplementation(function() { return {}; }),
      GuacObject: vi.fn(),
      InputStream: vi.fn(),
      Status: vi.fn(),
    },
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <SessionManagerProvider>{children}</SessionManagerProvider>;
}

describe('SessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', resizeObserverMock);
  });
  afterEach(() => vi.restoreAllMocks());

  it('throws when useSessionManager is used outside provider', () => {
    const { result } = renderHook(() => {
      try {
        return useSessionManager();
      } catch (e) {
        return e;
      }
    });
    expect(result.current).toBeInstanceOf(Error);
    expect((result.current as Error).message).toContain('useSessionManager must be used within SessionManagerProvider');
  });

  it('provides default values when used inside provider', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    expect(result.current.sessions).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.tiledSessionIds).toEqual([]);
    expect(result.current.focusedSessionIds).toEqual([]);
    expect(typeof result.current.createSession).toBe('function');
    expect(typeof result.current.closeSession).toBe('function');
    expect(typeof result.current.getSession).toBe('function');
    expect(typeof result.current.setActiveSessionId).toBe('function');
  });

  it('renders children inside provider', () => {
    render(
      <SessionManagerProvider>
        <div data-testid="child">Hello</div>
      </SessionManagerProvider>,
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Hello');
  });

  it('creates a session and sets it as active', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1',
        name: 'Server A',
        protocol: 'rdp',
        containerEl: document.createElement('div'),
        connectParams: new URLSearchParams({ token: 'abc' }),
      });
    });

    expect(session).toBeDefined();
    expect(session.connectionId).toBe('c1');
    expect(session.name).toBe('Server A');
    expect(session.protocol).toBe('rdp');
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.activeSessionId).toBe(session.id);
  });

  it('returns existing session for same connectionId', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session1: any, session2: any;
    rtlAct(() => {
      session1 = result.current.createSession({
        connectionId: 'c1',
        name: 'Server A',
        protocol: 'rdp',
        containerEl: document.createElement('div'),
        connectParams: new URLSearchParams(),
      });
    });
    rtlAct(() => {
      session2 = result.current.createSession({
        connectionId: 'c1',
        name: 'Server A',
        protocol: 'rdp',
        containerEl: document.createElement('div'),
        connectParams: new URLSearchParams(),
      });
    });

    expect(session1.id).toBe(session2.id);
    expect(result.current.sessions).toHaveLength(1);
  });

  it('closes a session and removes it', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1',
        name: 'Server A',
        protocol: 'rdp',
        containerEl: document.createElement('div'),
        connectParams: new URLSearchParams(),
      });
    });

    rtlAct(() => {
      result.current.closeSession(session.id);
    });

    expect(result.current.sessions).toHaveLength(0);
    expect(result.current.activeSessionId).toBeNull();
  });

  it('switches active session when current is closed', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let sess1: any, sess2: any;
    rtlAct(() => {
      sess1 = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });
    rtlAct(() => {
      sess2 = result.current.createSession({
        connectionId: 'c2', name: 'B', protocol: 'ssh',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    expect(result.current.activeSessionId).toBe(sess2.id);

    rtlAct(() => {
      result.current.closeSession(sess2.id);
    });

    expect(result.current.activeSessionId).toBe(sess1.id);
  });

  it('does not switch active session if non-active is closed', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let sess1: any, sess2: any;
    rtlAct(() => {
      sess1 = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });
    rtlAct(() => {
      sess2 = result.current.createSession({
        connectionId: 'c2', name: 'B', protocol: 'ssh',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    expect(result.current.activeSessionId).toBe(sess2.id);

    rtlAct(() => {
      result.current.closeSession(sess1.id);
    });

    expect(result.current.activeSessionId).toBe(sess2.id);
    expect(result.current.sessions).toHaveLength(1);
  });

  it('creates multiple sessions for different connections', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    rtlAct(() => {
      result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });
    rtlAct(() => {
      result.current.createSession({
        connectionId: 'c2', name: 'B', protocol: 'ssh',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });
    rtlAct(() => {
      result.current.createSession({
        connectionId: 'c3', name: 'C', protocol: 'vnc',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    expect(result.current.sessions).toHaveLength(3);
  });

  it('file and filesystem handlers exist on new session', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    expect(session.client.onfilesystem).toBeTypeOf('function');
    expect(session.client.onfile).toBeTypeOf('function');
  });

  it('clipboard handler is set', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    expect(session.client.onclipboard).toBeTypeOf('function');
  });

  it('syncs clipboard from remote to local', async () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });
    
    // Mock navigator.clipboard
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: mockWriteText },
    });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    // Simulate remote clipboard instruction
    const mockStream = {} as any;
    let ontext: ((t: string) => void) = () => {};
    let onend: (() => void) = () => {};
    
    vi.mocked(Guacamole.StringReader).mockImplementation(function() {
      return {
        set ontext(fn: any) { ontext = fn; },
        set onend(fn: any) { onend = fn; },
      } as any;
    });

    rtlAct(() => {
      session.client.onclipboard(mockStream, 'text/plain');
    });

    rtlAct(() => {
      ontext('hello from remote');
      onend();
    });

    expect(session.remoteClipboard).toBe('hello from remote');
    expect(mockWriteText).toHaveBeenCalledWith('hello from remote');
  });

  it('triggers file download when server sends file', async () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    const mockBlob = new Blob(['data'], { type: 'application/octet-stream' });
    vi.mocked(Guacamole.BlobReader).mockImplementation(function() {
      return {
        set onend(fn: any) { 
          // Immediately trigger the callback for the test
          setTimeout(fn, 10);
        },
        getBlob: () => mockBlob,
      } as any;
    });

    // Mock DOM elements involved in download
    const mockA = { click: vi.fn(), setAttribute: vi.fn(), style: {} } as any;
    const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockA);
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation(() => ({} as any));
    const removeSpy = vi.spyOn(document.body, 'removeChild').mockImplementation(() => ({} as any));
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:url'), revokeObjectURL: vi.fn() });

    rtlAct(() => {
      session.client.onfile({} as any, 'text/plain', 'test.txt');
    });

    // Wait for the timeout in BlobReader mock
    await rtlAct(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(mockA.download).toBe('test.txt');
    expect(mockA.click).toHaveBeenCalled();

    createElementSpy.mockRestore();
    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('fetches sharing permissions on mount', async () => {
    localStorage.setItem('access_token', 'test-token');
    const { getMe } = await import('../api');
    vi.mocked(getMe).mockResolvedValue({ id: '1', username: 'admin', role: 'admin', client_ip: '127.0.0.1', watermark_enabled: false, vault_configured: false, can_manage_system: true, can_manage_users: true, can_manage_connections: true, can_view_audit_logs: true, can_create_users: true, can_create_user_groups: true, can_create_connections: true, can_create_connection_folders: true, can_create_sharing_profiles: true });

    renderHook(() => useSessionManager(), { wrapper });

    await rtlAct(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    expect(getMe).toHaveBeenCalled();
  });

  it('scales display on resize', async () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    const parent = document.createElement('div');
    Object.defineProperties(parent, {
      clientWidth: { value: 1000, configurable: true },
      clientHeight: { value: 500, configurable: true },
    });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: parent, connectParams: new URLSearchParams(),
      });
      // MANUALLY APPEND to simulate attachment for parentElement check
      parent.appendChild(session.displayEl);
    });

    const display = session.client.getDisplay();
    // Simulate resize callback
    rtlAct(() => {
      if (typeof display.onresize === 'function') {
        display.onresize();
      }
    });

    expect(display.scale).toHaveBeenCalled();
  });

  it('auto-removes session when tunnel closes', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    expect(result.current.sessions).toHaveLength(1);

    // Simulate tunnel close (state=2)
    rtlAct(() => {
      session.tunnel.onstatechange(2);
    });

    expect(result.current.sessions).toHaveLength(0);
    expect(result.current.activeSessionId).toBeNull();
  });

  it('switches active session on tunnel close when multiple sessions exist', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let sess1: any, sess2: any;
    rtlAct(() => {
      sess1 = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });
    rtlAct(() => {
      sess2 = result.current.createSession({
        connectionId: 'c2', name: 'B', protocol: 'ssh',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    expect(result.current.activeSessionId).toBe(sess2.id);

    // Close the active session via tunnel state
    rtlAct(() => {
      sess2.tunnel.onstatechange(2);
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.activeSessionId).toBe(sess1.id);
  });

  it('resizes on client connected state', () => {
    // Mock requestAnimationFrame to run synchronously
    vi.stubGlobal('requestAnimationFrame', (cb: any) => { cb(); return 0; });

    const { result } = renderHook(() => useSessionManager(), { wrapper });

    const parent = document.createElement('div');
    Object.defineProperties(parent, {
      clientWidth: { value: 1000, configurable: true },
      clientHeight: { value: 800, configurable: true },
    });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: parent, connectParams: new URLSearchParams(),
      });
      parent.appendChild(session.displayEl);
    });

    // Trigger client connected state (state=3)
    rtlAct(() => {
      session.client.onstatechange(3);
    });

    expect(session.client.sendSize).toHaveBeenCalledWith(1000, 800);
    const display = session.client.getDisplay();
    expect(display.scale).toHaveBeenCalled();
  });

  it('sets error on tunnel.onerror', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    rtlAct(() => {
      session.tunnel.onerror({ message: 'Network error' });
    });

    expect(session.error).toBe('Network error');
  });

  it('sets error on client.onerror', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    rtlAct(() => {
      session.client.onerror({ message: 'Client error' });
    });

    expect(session.error).toBe('Client error');
  });

  it('adds beforeunload listener when sessions exist and removes when empty', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    rtlAct(() => {
      result.current.closeSession(session.id);
    });

    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('ignores non-text/plain clipboard mimetype', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    // Call onclipboard with image mimetype — StringReader should NOT be constructed
    vi.mocked(Guacamole.StringReader).mockClear();
    rtlAct(() => {
      session.client.onclipboard({} as any, 'image/png');
    });

    expect(Guacamole.StringReader).not.toHaveBeenCalled();
  });

  it('registers filesystem when server sends one', () => {
    const { result } = renderHook(() => useSessionManager(), { wrapper });

    let session: any;
    rtlAct(() => {
      session = result.current.createSession({
        connectionId: 'c1', name: 'A', protocol: 'rdp',
        containerEl: document.createElement('div'), connectParams: new URLSearchParams(),
      });
    });

    const mockObject = {} as any;
    rtlAct(() => {
      session.client.onfilesystem(mockObject, 'Drive C:');
    });

    expect(session.filesystems).toHaveLength(1);
    expect(session.filesystems[0].name).toBe('Drive C:');
  });
});
