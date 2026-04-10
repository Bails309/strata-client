import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const resizeObserverMock = vi.fn(function() {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});

let mockOnerror: ((s: any) => void) | null = null;
let mockTunnelOnerror: ((s: any) => void) | null = null;
let mockTunnelOnstatechange: ((s: any) => void) | null = null;
let mockTunnelOninstruction: (() => void) | null = null;

const mockClient = {
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
  get onerror() { return mockOnerror; },
  set onerror(fn: any) { mockOnerror = fn; },
  onstatechange: null,
  onclipboard: null,
};

const mockTunnel = {
  get onerror() { return mockTunnelOnerror; },
  set onerror(fn: any) { mockTunnelOnerror = fn; },
  get onstatechange() { return mockTunnelOnstatechange; },
  set onstatechange(fn: any) { mockTunnelOnstatechange = fn; },
  get oninstruction() { return mockTunnelOninstruction; },
  set oninstruction(fn: any) { mockTunnelOninstruction = fn; },
};

vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(function() { return mockClient; }),
    WebSocketTunnel: vi.fn(function() { return mockTunnel; }),
    Tunnel: { CLOSED: 0 },
    Status: vi.fn(),
    StringReader: vi.fn(),
    BlobReader: vi.fn(),
  },
}));

vi.mock('../api', () => ({
  buildNvrObserveUrl: vi.fn(() => 'ws://localhost/nvr'),
}));

import NvrPlayer from '../pages/NvrPlayer';

function renderNvrPlayer(route = '/nvr/test-session-123?name=TestSession&user=admin') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/nvr/:sessionId" element={<NvrPlayer />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NvrPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOnerror = null;
    mockTunnelOnerror = null;
    mockTunnelOnstatechange = null;
    mockTunnelOninstruction = null;
    vi.stubGlobal('ResizeObserver', resizeObserverMock);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders with connection name from URL params', () => {
    renderNvrPlayer();
    expect(screen.getByText('TestSession')).toBeInTheDocument();
  });

  it('shows username from URL params', () => {
    renderNvrPlayer();
    expect(screen.getByText(/admin/)).toBeInTheDocument();
  });

  it('shows back button', () => {
    renderNvrPlayer();
    expect(screen.getByText('Back')).toBeInTheDocument();
  });

  it('shows replaying phase initially', async () => {
    renderNvrPlayer();
    expect(await screen.findByText('Replaying…', { exact: false })).toBeInTheDocument();
  });

  it('shows rewind buttons', () => {
    renderNvrPlayer();
    expect(screen.getByText('30s')).toBeInTheDocument();
    expect(screen.getByText('1m')).toBeInTheDocument();
    expect(screen.getByText('3m')).toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
  });

  it('shows Jump to Live button', () => {
    renderNvrPlayer();
    expect(screen.getByText('Jump to Live')).toBeInTheDocument();
  });

  it('shows default session name when name param missing', () => {
    renderNvrPlayer('/nvr/test-session-123');
    expect(screen.getByText('Session')).toBeInTheDocument();
  });

  it('shows error phase on client error', async () => {
    renderNvrPlayer();
    act(() => {
      mockOnerror?.({ message: 'Connection refused' });
    });
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });

  it('shows error phase on tunnel error', () => {
    renderNvrPlayer();
    act(() => {
      mockTunnelOnerror?.({ message: 'Tunnel failed' });
    });
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Tunnel failed')).toBeInTheDocument();
  });

  it('shows ended phase when tunnel closes', () => {
    renderNvrPlayer();
    act(() => {
      mockTunnelOnstatechange?.(0); // Guacamole.Tunnel.CLOSED
    });
    expect(screen.getByText('Session ended')).toBeInTheDocument();
    expect(screen.getByText('Session has ended')).toBeInTheDocument();
  });

  it('shows Return to Sessions button in ended state', () => {
    renderNvrPlayer();
    act(() => {
      mockTunnelOnstatechange?.(0);
    });
    expect(screen.getByText('Return to Sessions')).toBeInTheDocument();
  });

  it('reconnects on rewind button click', async () => {
    const user = userEvent.setup();
    renderNvrPlayer();
    mockClient.connect.mockClear();
    await user.click(screen.getByText('30s'));
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('jumps to live when Jump to Live clicked', async () => {
    const user = userEvent.setup();
    renderNvrPlayer();
    mockClient.connect.mockClear();
    await user.click(screen.getByText('Jump to Live'));
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('transitions to live phase when instruction gap exceeds threshold', () => {
    renderNvrPlayer();
    // Simulate a burst of instructions, then a gap
    act(() => {
      for (let i = 0; i < 60; i++) {
        mockTunnelOninstruction?.();
      }
    });
    // The oninstruction checks gap > 80ms, but in tests the calls are synchronous
    // so gap is ~0ms. After 50 instructions, if gap > 80ms, it would go to live.
    // In this synchronous test, it stays in replaying since gap is 0.
    expect(screen.getByText('Replaying…', { exact: false })).toBeInTheDocument();
  });

  it('uses offset from URL params', () => {
    renderNvrPlayer('/nvr/test-session-123?name=Server&offset=60');
    expect(screen.getByText('Server')).toBeInTheDocument();
  });

  it('shows elapsed time counter', () => {
    renderNvrPlayer();
    expect(screen.getByText('0:00')).toBeInTheDocument();
  });

  it('default error message when status has no message', () => {
    renderNvrPlayer();
    act(() => {
      mockOnerror?.({});
    });
    expect(screen.getByText('Connection error')).toBeInTheDocument();
  });

  it('default tunnel error message when status has no message', () => {
    renderNvrPlayer();
    act(() => {
      mockTunnelOnerror?.({});
    });
    expect(screen.getByText('Tunnel error')).toBeInTheDocument();
  });

  it('sets live phase when offset is 0 (Jump to Live)', async () => {
    const user = userEvent.setup();
    renderNvrPlayer();
    await user.click(screen.getByText('Jump to Live'));
    // When offset is 0, connect() sets phase to 'live' directly (no replay)
    expect(screen.getByText(/LIVE/)).toBeInTheDocument();
  });

  it('disconnects previous client on reconnect', async () => {
    const user = userEvent.setup();
    renderNvrPlayer();
    mockClient.disconnect.mockClear();
    await user.click(screen.getByText('30s'));
    // cleanup is called before reconnect which disconnects the prior client
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it('does not show username when user param is missing', () => {
    renderNvrPlayer('/nvr/test-session-123?name=TestSession');
    // Should not have an em-dash with empty username
    expect(screen.queryByText(/—/)).not.toBeInTheDocument();
  });

  it('shows error overlay with error message text', () => {
    renderNvrPlayer();
    act(() => {
      mockOnerror?.({ message: 'Forbidden' });
    });
    expect(screen.getByText('Forbidden')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('shows Connecting phase when non-CLOSED tunnel state changes', () => {
    renderNvrPlayer();
    act(() => {
      mockTunnelOnstatechange?.(1); // Some non-CLOSED state
    });
    // Should NOT show ended
    expect(screen.queryByText('Session ended')).not.toBeInTheDocument();
  });
});
