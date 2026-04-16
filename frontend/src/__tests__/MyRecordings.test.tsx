import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../api', () => ({
  getMyRecordings: vi.fn(),
  buildMyRecordingStreamUrl: vi.fn((id: string) => `wss://localhost/api/user/recordings/${id}/stream`),
}));

vi.mock('../components/HistoricalPlayer', () => ({
  default: ({ recording, onClose }: any) => (
    <div data-testid="historical-player">
      <span>{recording.connection_name}</span>
      <button onClick={onClose}>Close Player</button>
    </div>
  ),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: {},
    timeSettings: {
      display_timezone: 'UTC',
      display_time_format: 'HH:mm:ss',
      display_date_format: 'YYYY-MM-DD',
    },
    loading: false,
    refreshSettings: vi.fn(),
    updateSettings: vi.fn(),
    formatDateTime: (date: any) => {
      if (!date) return '—';
      return new Date(date).toISOString();
    },
  }),
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import MyRecordings from '../pages/MyRecordings';
import { getMyRecordings } from '../api';
import type { HistoricalRecording } from '../api';

function makeRecording(overrides: Partial<HistoricalRecording> = {}): HistoricalRecording {
  return {
    id: 'r1',
    session_id: 's1',
    connection_id: 'c1',
    connection_name: 'Server A',
    user_id: 'u1',
    username: 'user1',
    started_at: '2026-01-01T00:00:00Z',
    duration_secs: 125,
    storage_path: '/recordings/r1',
    storage_type: 'local',
    ...overrides,
  };
}

describe('MyRecordings', () => {
  beforeEach(() => {
    vi.mocked(getMyRecordings).mockResolvedValue([makeRecording()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders heading', async () => {
    await act(async () => { render(<MyRecordings />); });
    expect(screen.getByText('My Recordings')).toBeInTheDocument();
  });

  it('shows loading state', async () => {
    vi.mocked(getMyRecordings).mockReturnValue(new Promise(() => {}));
    await act(async () => { render(<MyRecordings />); });
    expect(screen.getByText(/Loading recordings/)).toBeInTheDocument();
  });

  it('shows recording rows', async () => {
    await act(async () => { render(<MyRecordings />); });
    expect(await screen.findByText('Server A')).toBeInTheDocument();
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
  });

  it('shows empty state', async () => {
    vi.mocked(getMyRecordings).mockResolvedValue([]);
    await act(async () => { render(<MyRecordings />); });
    expect(await screen.findByText('No recordings found')).toBeInTheDocument();
  });

  it('shows error message', async () => {
    vi.mocked(getMyRecordings).mockRejectedValue(new Error('fail'));
    await act(async () => { render(<MyRecordings />); });
    expect(await screen.findByText('Failed to load recordings')).toBeInTheDocument();
  });

  it('opens player on Play click', async () => {
    const user = userEvent.setup();
    await act(async () => { render(<MyRecordings />); });
    await user.click(await screen.findByText('Play'));
    expect(screen.getByTestId('historical-player')).toBeInTheDocument();
  });

  it('closes player', async () => {
    const user = userEvent.setup();
    await act(async () => { render(<MyRecordings />); });
    await user.click(await screen.findByText('Play'));
    await user.click(screen.getByText('Close Player'));
    expect(screen.queryByTestId('historical-player')).not.toBeInTheDocument();
  });

  it('filters recordings by search', async () => {
    vi.mocked(getMyRecordings).mockResolvedValue([
      makeRecording({ id: 'r1', connection_name: 'Alpha' }),
      makeRecording({ id: 'r2', connection_name: 'Beta' }),
    ]);
    const user = userEvent.setup();
    await act(async () => { render(<MyRecordings />); });
    await screen.findByText('Alpha');
    const input = screen.getByPlaceholderText('Filter by connection name...');
    await user.type(input, 'Alpha');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('formats hours duration', async () => {
    vi.mocked(getMyRecordings).mockResolvedValue([
      makeRecording({ duration_secs: 3661 }),
    ]);
    await act(async () => { render(<MyRecordings />); });
    expect(await screen.findByText('1h 1m 1s')).toBeInTheDocument();
  });

  it('formats seconds-only duration', async () => {
    vi.mocked(getMyRecordings).mockResolvedValue([
      makeRecording({ duration_secs: 30 }),
    ]);
    await act(async () => { render(<MyRecordings />); });
    expect(await screen.findByText('30s')).toBeInTheDocument();
  });

  it('shows dash for null duration', async () => {
    vi.mocked(getMyRecordings).mockResolvedValue([
      makeRecording({ duration_secs: null }),
    ]);
    await act(async () => { render(<MyRecordings />); });
    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  it('shows table headers', async () => {
    await act(async () => { render(<MyRecordings />); });
    await screen.findByText('Server A');
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByText('Started At')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });
});
