import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        sendSize: vi.fn(),
        sendKeyEvent: vi.fn(),
        sendMouseState: vi.fn(),
        onclipboard: null,
        onfilesystem: null,
        onfile: null,
        onstatechange: null,
        onerror: null,
        onrequired: null,
        createArgumentValueStream: vi.fn(() => ({})),
      };
    }),
    WebSocketTunnel: vi.fn(function() {
      return { onerror: null };
    }),
    Mouse: Object.assign(vi.fn(function() { return { onEach: vi.fn() }; }), {
      Touchscreen: vi.fn(function() { return { onEach: vi.fn() }; }),
      Event: vi.fn(),
    }),
    Keyboard: vi.fn(function() {
      return { onkeydown: null, onkeyup: null, reset: vi.fn() };
    }),
    StringWriter: vi.fn(function() {
      return { sendText: vi.fn(), sendEnd: vi.fn() };
    }),
    StringReader: vi.fn(),
    BlobReader: vi.fn(),
    GuacObject: vi.fn(),
  },
}));

function makeMockSession(id: string, name: string, protocol = 'rdp') {
  return {
    id,
    connectionId: `conn-${id}`,
    name,
    protocol,
    client: {
      getDisplay: () => ({
        getElement: () => document.createElement('div'),
        getWidth: () => 800,
        getHeight: () => 600,
        scale: vi.fn(),
      }),
      sendKeyEvent: vi.fn(),
      sendMouseState: vi.fn(),
      onrequired: null as any,
      createArgumentValueStream: vi.fn(() => ({})),
    },
    tunnel: { onerror: null },
    displayEl: document.createElement('div'),
    keyboard: { onkeydown: null as any, onkeyup: null as any, reset: vi.fn() },
    createdAt: Date.now(),
    filesystems: [],
    remoteClipboard: '',
    current_hash: 'aaa111bbb222ccc333ddd444eee555ff',
  };
}

const mockSessions = [
  makeMockSession('s1', 'Server A', 'rdp'),
  makeMockSession('s2', 'Server B', 'ssh'),
];

const mockCloseSession = vi.fn();
const mockSetFocusedSessionIds = vi.fn();
const mockSetActiveSessionId = vi.fn();

vi.mock('../components/SessionManager', () => ({
  useSessionManager: () => ({
    sessions: mockSessions,
    activeSessionId: 's1',
    tiledSessionIds: ['s1', 's2'],
    focusedSessionIds: ['s1'],
    setActiveSessionId: mockSetActiveSessionId,
    createSession: vi.fn(),
    closeSession: mockCloseSession,
    getSession: vi.fn(),
    setTiledSessionIds: vi.fn(),
    setFocusedSessionIds: mockSetFocusedSessionIds,
  }),
  SessionManagerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/Layout', () => ({
  useSidebarWidth: () => 0,
}));

vi.mock('../components/SessionWatermark', () => ({
  default: () => null,
}));

vi.mock('../api', () => ({
  getMe: vi.fn().mockResolvedValue({ username: 'admin', client_ip: '10.0.0.1', watermark_enabled: false }),
}));

import TiledView from '../pages/TiledView';

function renderTiledView() {
  return render(
    <MemoryRouter initialEntries={['/tiled']}>
      <Routes>
        <Route path="/tiled" element={<TiledView />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TiledView component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', resizeObserverMock);
    if (!document.getElementById('root')) {
      const root = document.createElement('div');
      root.id = 'root';
      document.body.appendChild(root);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders tile for each tiled session', () => {
    renderTiledView();
    // Each tile shows session name
    expect(document.body.textContent).toContain('Server A');
    expect(document.body.textContent).toContain('Server B');
  });

  it('shows protocol badge for each tile', () => {
    renderTiledView();
    expect(document.body.textContent).toContain('RDP');
    expect(document.body.textContent).toContain('SSH');
  });

  it('shows disconnect button per tile', () => {
    renderTiledView();
    const disconnectBtns = document.querySelectorAll('[title="Disconnect"]');
    expect(disconnectBtns.length).toBe(2);
  });

  it('calls closeSession when tile disconnect clicked', async () => {
    renderTiledView();
    const disconnectBtns = document.querySelectorAll('[title="Disconnect"]');
    await userEvent.click(disconnectBtns[0] as HTMLElement);
    expect(mockCloseSession).toHaveBeenCalledWith('s1');
  });

  it('highlights focused tile with accent border', () => {
    renderTiledView();
    // The first tile (s1) should be focused — uses accent border
    // We rendered with focusedSessionIds: ['s1']
    // The tile container has inline style border
    const allTiles = document.querySelectorAll('[style*="border"]');
    expect(allTiles.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking tile calls setFocusedSessionIds with single session', async () => {
    renderTiledView();
    // Click on a tile (via mouseDown on the tile container)
    const tileHeaders = document.querySelectorAll('[style*="letter-spacing"]');
    expect(tileHeaders.length).toBe(2);
    await userEvent.click(tileHeaders[1] as HTMLElement);
    expect(mockSetFocusedSessionIds).toHaveBeenCalledWith(['s2']);
  });

  it('clicking tile calls setActiveSessionId', async () => {
    renderTiledView();
    const tileHeaders = document.querySelectorAll('[style*="letter-spacing"]');
    await userEvent.click(tileHeaders[1] as HTMLElement);
    expect(mockSetActiveSessionId).toHaveBeenCalledWith('s2');
  });

  it('renders grid layout with correct number of columns', () => {
    renderTiledView();
    const portal = document.getElementById('root')!;
    const grid = portal.querySelector('[style*="grid-template-columns"]') as HTMLElement;
    expect(grid).toBeTruthy();
    // 2 tiles → 2 columns (Math.ceil(sqrt(2)) = 2)
    expect(grid.style.gridTemplateColumns).toContain('repeat(2');
  });

  it('disconnect button stops event propagation', async () => {
    renderTiledView();
    const disconnectBtns = document.querySelectorAll('[title="Disconnect"]');
    // Clicking disconnect should NOT trigger focus change
    await userEvent.click(disconnectBtns[0] as HTMLElement);
    expect(mockCloseSession).toHaveBeenCalledWith('s1');
    // setFocusedSessionIds should not be called from disconnect
    expect(mockSetFocusedSessionIds).not.toHaveBeenCalled();
  });

  it('attaches display element to tile container', () => {
    renderTiledView();
    const portal = document.getElementById('root')!;
    // Each tile has a display container that should contain the displayEl
    const tileContainers = portal.querySelectorAll('[style*="overflow: hidden"]');
    expect(tileContainers.length).toBeGreaterThanOrEqual(2);
  });

  it('wires keyboard for focused sessions', () => {
    renderTiledView();
    // Session s1 is focused, so its keyboard should have handlers wired
    expect(mockSessions[0].keyboard.onkeydown).toBeTypeOf('function');
    expect(mockSessions[0].keyboard.onkeyup).toBeTypeOf('function');
  });

  it('does not wire keyboard for unfocused sessions', () => {
    renderTiledView();
    // Session s2 is NOT focused, so its keyboard handlers should be null
    expect(mockSessions[1].keyboard.onkeydown).toBeNull();
    expect(mockSessions[1].keyboard.onkeyup).toBeNull();
  });

  it('focused session keyboard sends key events', () => {
    renderTiledView();
    const kb = mockSessions[0].keyboard;
    // Simulate a keydown
    const result = kb.onkeydown(65); // 'A' keysym
    expect(result).toBe(true);
    expect(mockSessions[0].client.sendKeyEvent).toHaveBeenCalledWith(1, 65);
    // Simulate a keyup
    kb.onkeyup(65);
    expect(mockSessions[0].client.sendKeyEvent).toHaveBeenCalledWith(0, 65);
  });

  it('wires onrequired handler for each tiled session', () => {
    renderTiledView();
    // Each session should have onrequired set
    expect(mockSessions[0].client.onrequired).toBeTypeOf('function');
    expect(mockSessions[1].client.onrequired).toBeTypeOf('function');
  });

  it('shows credential prompt when onrequired is triggered', async () => {
    renderTiledView();
    // Trigger onrequired on first session
    const onrequired = mockSessions[0].client.onrequired;
    onrequired(['username', 'password']);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Credentials Required');
    });
  });

  it('submits credential form on enter', async () => {
    const user = userEvent.setup();
    renderTiledView();
    // Trigger onrequired on first session
    mockSessions[0].client.onrequired(['username', 'password']);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Credentials Required');
    });
    // Fill the form
    const inputs = document.querySelectorAll('input[placeholder]');
    const usernameInput = Array.from(inputs).find(i => (i as HTMLInputElement).placeholder === 'Username') as HTMLInputElement;
    const passwordInput = Array.from(inputs).find(i => (i as HTMLInputElement).placeholder === 'Password') as HTMLInputElement;
    expect(usernameInput).toBeTruthy();
    expect(passwordInput).toBeTruthy();
    await user.type(usernameInput, 'admin');
    await user.type(passwordInput, 'secret');
    // Submit the form
    const submitBtn = document.querySelector('button[type="submit"]') as HTMLElement;
    await user.click(submitBtn);
    // createArgumentValueStream should have been called
    expect(mockSessions[0].client.createArgumentValueStream).toHaveBeenCalled();
  });

  it('shows password input type for password field', async () => {
    renderTiledView();
    mockSessions[0].client.onrequired(['username', 'password']);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Credentials Required');
    });
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(passwordInput).toBeTruthy();
    expect(passwordInput.placeholder).toBe('Password');
  });

  it('text input type for non-password fields', async () => {
    renderTiledView();
    mockSessions[0].client.onrequired(['username', 'domain']);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Credentials Required');
    });
    const textInputs = document.querySelectorAll('input[type="text"]');
    expect(textInputs.length).toBeGreaterThanOrEqual(2);
  });

  it('renders session names in title bars', () => {
    renderTiledView();
    expect(document.body.textContent).toContain('Server A');
    expect(document.body.textContent).toContain('Server B');
  });

  it('ctrl+click toggles tile into focus set', () => {
    renderTiledView();
    // Find the tile containing "Server B" (s2, NOT currently focused)
    const portal = document.getElementById('root')!;
    const allText = portal.querySelectorAll('span');
    const serverB = Array.from(allText).find(s => s.textContent === 'Server B');
    // Walk up to the tile container (the one with onMouseDown)
    const tileContainer = serverB!.closest('[style*="overflow"]') as HTMLElement;
    fireEvent.mouseDown(tileContainer, { ctrlKey: true });
    expect(mockSetFocusedSessionIds).toHaveBeenCalledWith(['s1', 's2']);
  });

  it('ctrl+click removes already focused tile from set', () => {
    renderTiledView();
    const portal = document.getElementById('root')!;
    const allText = portal.querySelectorAll('span');
    const serverA = Array.from(allText).find(s => s.textContent === 'Server A');
    const tileContainer = serverA!.closest('[style*="overflow"]') as HTMLElement;
    fireEvent.mouseDown(tileContainer, { ctrlKey: true });
    expect(mockSetFocusedSessionIds).toHaveBeenCalledWith([]);
  });

  it('shows disconnect buttons with correct titles', () => {
    renderTiledView();
    const btns = document.querySelectorAll('[title="Disconnect"]');
    expect(btns.length).toBe(2);
  });
});
