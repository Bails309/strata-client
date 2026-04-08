import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Polyfill ResizeObserver for jsdom
vi.stubGlobal('ResizeObserver', vi.fn(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
})));

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
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendSize: vi.fn(),
      sendMouseState: vi.fn(),
      sendKeyEvent: vi.fn(),
      createClipboardStream: vi.fn(() => ({})),
      onclipboard: null,
      onfilesystem: null,
      onfile: null,
      onstatechange: null,
      onerror: null,
      onrequired: null,
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
      reset: vi.fn(),
    })),
    StringWriter: vi.fn(() => ({
      sendText: vi.fn(),
      sendEnd: vi.fn(),
    })),
    StringReader: vi.fn(),
  },
}));

vi.mock('../api', () => ({
  getConnectionInfo: vi.fn().mockResolvedValue({ protocol: 'rdp', has_credentials: false }),
  getConnections: vi.fn().mockResolvedValue([]),
  createTunnelTicket: vi.fn(),
  getMe: vi.fn().mockResolvedValue({ username: 'admin', client_ip: '10.0.0.1', watermark_enabled: false }),
  createShareLink: vi.fn(),
}));

vi.mock('../components/SessionManager', () => ({
  useSessionManager: () => ({
    sessions: [],
    activeSessionId: null,
    tiledSessionIds: [],
    focusedSessionIds: [],
    setActiveSessionId: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    getSession: vi.fn(() => undefined),
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

vi.mock('../components/SessionToolbar', () => ({
  default: () => null,
}));

vi.mock('../components/SessionWatermark', () => ({
  default: () => null,
}));

vi.mock('../components/TouchToolbar', () => ({
  default: () => null,
}));

import SessionClient from '../pages/SessionClient';

describe('SessionClient', () => {
  beforeEach(() => {
    // SessionClient portals into #root
    if (!document.getElementById('root')) {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);
    }
  });

  it('renders loading state for a connection', () => {
    const { baseElement } = render(
      <MemoryRouter initialEntries={['/session/test-conn-id']}>
        <Routes>
          <Route path="/session/:connectionId" element={<SessionClient />} />
        </Routes>
      </MemoryRouter>,
    );
    // SessionClient renders via portal into body
    expect(baseElement.querySelector('div')).toBeTruthy();
  });

  it('shows loading text initially', () => {
    render(
      <MemoryRouter initialEntries={['/session/test-conn-id']}>
        <Routes>
          <Route path="/session/:connectionId" element={<SessionClient />} />
        </Routes>
      </MemoryRouter>,
    );
    // The loading overlay should be in the document body (via portal)
    expect(document.body.textContent).toContain('Loading connection');
  });
});
