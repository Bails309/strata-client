import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const resizeObserverMock = vi.fn(function() {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});

let mockTunnelOninstruction: ((opcode: string, args: string[]) => void) | null = null;
let mockTunnelOnerror: ((s: any) => void) | null = null;
let mockTunnelOnstatechange: ((s: any) => void) | null = null;
let mockOnerror: ((s: any) => void) | null = null;

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
  get onerror() { return mockOnerror; },
  set onerror(fn: any) { mockOnerror = fn; },
};

const mockTunnel = {
  get oninstruction() { return mockTunnelOninstruction; },
  set oninstruction(fn: any) { mockTunnelOninstruction = fn; },
  get onerror() { return mockTunnelOnerror; },
  set onerror(fn: any) { mockTunnelOnerror = fn; },
  get onstatechange() { return mockTunnelOnstatechange; },
  set onstatechange(fn: any) { mockTunnelOnstatechange = fn; },
};

vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(function() { return mockClient; }),
    WebSocketTunnel: vi.fn(function() { return mockTunnel; }),
    Status: vi.fn(),
  },
}));

vi.mock('../api', () => ({
  buildRecordingStreamUrl: vi.fn(() => 'ws://localhost/recording'),
}));

import HistoricalPlayer from '../components/HistoricalPlayer';

const mockRecording = {
  id: 'rec-123',
  connection_id: 'conn-1',
  connection_name: 'Production Server',
  username: 'jdoe',
  started_at: '2026-04-10T10:00:00Z',
  duration_secs: 60,
  storage_type: 'local',
  file_path: '/path/to/rec',
};

describe('HistoricalPlayer', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockTunnelOninstruction = null;
    mockTunnelOnerror = null;
    mockTunnelOnstatechange = null;
    mockOnerror = null;
    vi.stubGlobal('ResizeObserver', resizeObserverMock);
  });

  afterEach(() => vi.restoreAllMocks());

  it('renders recording metadata', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    expect(screen.getByText('Production Server')).toBeInTheDocument();
    expect(screen.getByText(/Recorded Session — jdoe/)).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    expect(screen.getByClassName('spinner')).toBeTruthy();
  });

  it('handles nvrheader instruction to set duration', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['120000']); // 120s in ms
    });

    expect(screen.getByText('2:00')).toBeInTheDocument();
    expect(screen.queryByClassName('spinner')).toBeNull();
  });

  it('handles nvrprogress instruction to set current time', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['60000']);
      mockTunnelOninstruction?.('nvrprogress', ['15000']);
    });

    expect(screen.getByText('0:15')).toBeInTheDocument();
    expect(screen.getByText('1:00')).toBeInTheDocument();
  });

  it('handles nvrend instruction', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['60000']);
      mockTunnelOninstruction?.('nvrend', []);
    });

    expect(screen.getByText('1:00')).toBeInTheDocument();
    expect(screen.queryByClassName('spinner')).toBeNull();
  });

  it('shows error on client error', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockOnerror?.({ message: 'Stream failed' });
    });

    expect(screen.getByText('Stream failed')).toBeInTheDocument();
  });

  it('shows error on tunnel error', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockTunnelOnerror?.({ message: 'Tunnel failed' });
    });

    expect(screen.getByText('Tunnel failed')).toBeInTheDocument();
  });

  it('clears error on clean close after nvrend', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockTunnelOninstruction?.('nvrend', []);
      mockTunnelOnstatechange?.(2); // CLOSED
    });

    expect(screen.queryByText('Playback error')).toBeNull();
  });

  it('calls onClose when close button clicked', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    // The X button is the first button in the header
    const buttons = screen.getAllByRole('button');
    const xButton = buttons.find(b => b.innerHTML.includes('M18 6L6 18M6 6l12 12'));
    expect(xButton).toBeTruthy();
    
    fireEvent.click(xButton!);
    expect(onClose).toHaveBeenCalled();
  });

  it('retries connection when retry button clicked', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockOnerror?.({ message: 'Fail' });
    });

    mockClient.connect.mockClear();
    const retryBtn = screen.getByText('Retry');
    retryBtn.click();
    expect(mockClient.connect).toHaveBeenCalled();
  });
});
