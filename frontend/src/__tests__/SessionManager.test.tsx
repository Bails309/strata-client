import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, renderHook } from '@testing-library/react';
import { SessionManagerProvider, useSessionManager } from '../components/SessionManager';

// Mock guacamole-common-js
vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(() => ({
      getDisplay: () => ({
        getElement: () => document.createElement('div'),
        getWidth: () => 1920,
        getHeight: () => 1080,
        scale: vi.fn(),
        onresize: null,
      }),
      sendMouseState: vi.fn(),
      sendSize: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      createClipboardStream: vi.fn(() => ({})),
      onclipboard: null,
      onfilesystem: null,
      onfile: null,
      onstatechange: null,
      onerror: null,
    })),
    WebSocketTunnel: vi.fn(() => ({
      onerror: null,
    })),
    Mouse: Object.assign(vi.fn(() => ({
      onEach: vi.fn(),
    })), {
      Touchscreen: vi.fn(() => ({
        onEach: vi.fn(),
      })),
      Event: vi.fn(),
    }),
    Keyboard: vi.fn(() => ({
      onkeydown: null,
      onkeyup: null,
    })),
    StringReader: vi.fn(),
    StringWriter: vi.fn(() => ({
      sendText: vi.fn(),
      sendEnd: vi.fn(),
    })),
    BlobReader: vi.fn(),
    GuacObject: vi.fn(),
    InputStream: vi.fn(),
    Status: vi.fn(),
  },
}));

describe('SessionManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when useSessionManager is used outside provider', () => {
    // renderHook will catch the error
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
    const { result } = renderHook(() => useSessionManager(), {
      wrapper: ({ children }) => (
        <SessionManagerProvider>{children}</SessionManagerProvider>
      ),
    });

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
});
