import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Polyfill ResizeObserver for jsdom
const resizeObserverMock = vi.fn(function() {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

// Mock guacamole-common-js
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
        connect: vi.fn(),
        disconnect: vi.fn(),
        sendSize: vi.fn(),
        onerror: null,
        onstatechange: null,
        onclipboard: null,
      };
    }),
    WebSocketTunnel: vi.fn(function() {
      return {
        onerror: null,
        oninstruction: null,
        onstatechange: null,
      };
    }),
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

function renderNvrPlayer(sessionId = 'test-session-123') {
  return render(
    <MemoryRouter initialEntries={[`/nvr/${sessionId}?name=TestSession&user=admin`]}>
      <Routes>
        <Route path="/nvr/:sessionId" element={<NvrPlayer />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NvrPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', resizeObserverMock);
  });

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
});
