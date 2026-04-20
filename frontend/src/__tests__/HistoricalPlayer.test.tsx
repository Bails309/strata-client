import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

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
  sendMessage: vi.fn(),
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
    // Check for spinner - updated to use class check correctly
    expect(document.querySelector('.spinner')).toBeTruthy();
  });

  it('handles nvrheader instruction to set duration', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['120000']); // 120s in ms
    });

    expect(screen.getByText('2:00')).toBeInTheDocument();
    expect(document.querySelector('.spinner')).toBeNull();
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

    expect(screen.getAllByText('1:00').length).toBeGreaterThan(0);
    expect(document.querySelector('.spinner')).toBeNull();
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
    
    act(() => {
      fireEvent.click(xButton!);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('retries connection when retry button clicked', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);
    
    act(() => {
      mockOnerror?.({ message: 'Fail' });
    });

    mockClient.connect.mockClear();
    const retryBtn = screen.getByText('Retry');
    act(() => {
      fireEvent.click(retryBtn);
    });
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('handles nvrseeked instruction', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['120000']);
      mockTunnelOninstruction?.('nvrseeked', ['30000']);
    });

    expect(screen.getByText('0:30')).toBeInTheDocument();
  });

  it('toggles play/pause on button click', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['60000']);
    });

    // Find the play/pause button (first button with the pause icon path)
    const pauseBtn = screen.getAllByRole('button').find(b => b.querySelector('svg path[d*="M6 4h4v16H6"]'));
    expect(pauseBtn).toBeTruthy();

    act(() => {
      fireEvent.click(pauseBtn!);
    });

    expect(mockTunnel.sendMessage).toHaveBeenCalledWith('nvrpause');
  });

  it('resumes playback when pause button clicked again', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['60000']);
    });

    const pauseBtn = screen.getAllByRole('button').find(b => b.querySelector('svg path[d*="M6 4h4v16H6"]'));
    act(() => { fireEvent.click(pauseBtn!); });
    // Now find the play button
    const playBtn = screen.getAllByRole('button').find(b => b.querySelector('svg path[d*="M8 5v14l11-7z"]'));
    expect(playBtn).toBeTruthy();
    act(() => { fireEvent.click(playBtn!); });
    expect(mockTunnel.sendMessage).toHaveBeenCalledWith('nvrresume');
  });

  it('changes playback speed', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['60000']);
    });

    const speed2Btn = screen.getByText('2x');
    act(() => { fireEvent.click(speed2Btn); });
    // Speed change reconnects with the new speed param
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('renders speed buttons with active state', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['60000']);
    });

    const speed1Btn = screen.getByText('1x');
    expect(speed1Btn.className).toContain('active');
    const speed4Btn = screen.getByText('4x');
    expect(speed4Btn.className).not.toContain('active');
  });

  it('skips forward by 30s', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['120000']);
      mockTunnelOninstruction?.('nvrprogress', ['10000']);
    });

    const fwdButtons = screen.getAllByTitle(/Skip forward/);
    act(() => { fireEvent.click(fwdButtons[0]); }); // Skip forward 30s
    // Should reconnect with seek param
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('skips backward by 30s', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['120000']);
      mockTunnelOninstruction?.('nvrprogress', ['45000']);
    });

    const backButtons = screen.getAllByTitle(/Skip back/);
    act(() => { fireEvent.click(backButtons[0]); }); // Skip back 30s
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('does not skip below 0', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['120000']);
      mockTunnelOninstruction?.('nvrprogress', ['5000']); // only 5s in
    });

    mockClient.connect.mockClear();
    const backButtons = screen.getAllByTitle(/Skip back/);
    act(() => { fireEvent.click(backButtons[3]); }); // Skip back 5m (would go below 0)
    // Should still reconnect (seeking to 0)
    expect(mockClient.connect).toHaveBeenCalled();
  });

  it('toggles fullscreen on button click', () => {
    const mockRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    // The card element needs requestFullscreen
    const card = document.querySelector('.player-card');
    if (card) {
      (card as any).requestFullscreen = mockRequestFullscreen;
    }

    const fullscreenBtn = screen.getByTitle('Fullscreen');
    act(() => { fireEvent.click(fullscreenBtn); });
    expect(mockRequestFullscreen).toHaveBeenCalled();
  });

  it('uses custom streamUrlBuilder when provided', () => {
    const customBuilder = vi.fn(() => 'ws://custom/stream');
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} streamUrlBuilder={customBuilder} />);
    expect(customBuilder).toHaveBeenCalledWith('rec-123');
  });

  it('shows correct time format for longer recordings', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['7200000']); // 2 hours
      mockTunnelOninstruction?.('nvrprogress', ['3661000']); // 61 min 1 sec
    });

    expect(screen.getByText('61:01')).toBeInTheDocument();
  });

  it('suppresses error after recording ended', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    act(() => {
      mockTunnelOninstruction?.('nvrheader', ['60000']);
      mockTunnelOninstruction?.('nvrend', []);
    });

    // After nvrend, client.onerror should be ignored
    act(() => {
      mockOnerror?.({ message: 'Late error after end' });
    });

    expect(screen.queryByText('Late error after end')).not.toBeInTheDocument();
  });

  it('stops propagation on card click to prevent onClose', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    const card = document.querySelector('.player-card');
    act(() => { fireEvent.click(card!); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when overlay background clicked', () => {
    render(<HistoricalPlayer recording={mockRecording as any} onClose={onClose} />);

    const overlay = document.querySelector('.player-overlay');
    act(() => { fireEvent.click(overlay!); });
    expect(onClose).toHaveBeenCalled();
  });
});
