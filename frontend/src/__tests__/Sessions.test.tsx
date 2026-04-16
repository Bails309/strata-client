import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../api', () => ({
  getActiveSessions: vi.fn(),
  getMyActiveSessions: vi.fn(),
  killSessions: vi.fn(),
  getRecordings: vi.fn(),
  getMyRecordings: vi.fn(),
  buildRecordingStreamUrl: vi.fn((id: string) => `wss://localhost/api/admin/recordings/${id}/stream`),
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

vi.mock('../components/ConfirmModal', () => ({
  default: ({ isOpen, title, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div data-testid="confirm-modal">
        <span>{title}</span>
        <button onClick={onConfirm}>Confirm</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
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

import Sessions from '../pages/Sessions';
import {
  getActiveSessions, getMyActiveSessions, killSessions,
  getRecordings, getMyRecordings,
} from '../api';
import type { MeResponse, ActiveSession, HistoricalRecording } from '../api';

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    session_id: 's1',
    connection_id: 'c1',
    connection_name: 'Server A',
    protocol: 'rdp',
    user_id: 'u1-abcdef01',
    username: 'admin',
    started_at: new Date(Date.now() - 3600_000).toISOString(),
    buffer_depth_secs: 0,
    bytes_from_guacd: 10 * 1024 * 1024,
    bytes_to_guacd: 512 * 1024,
    remote_host: '10.0.0.5',
    client_ip: '192.168.1.10',
    ...overrides,
  };
}

function makeRecording(overrides: Partial<HistoricalRecording> = {}): HistoricalRecording {
  return {
    id: 'r1',
    session_id: 's1',
    connection_id: 'c1',
    connection_name: 'Server A',
    user_id: 'u1',
    username: 'admin',
    started_at: '2026-01-01T00:00:00Z',
    duration_secs: 3661,
    storage_path: '/recordings/r1',
    storage_type: 'local',
    ...overrides,
  };
}

const adminUser: MeResponse = {
  id: 'u1',
  username: 'admin',
  role: 'admin',
  client_ip: '127.0.0.1',
  watermark_enabled: false,
  vault_configured: false,
  can_manage_system: true,
  can_manage_users: true,
  can_manage_connections: true,
  can_view_audit_logs: true,
  can_create_users: true,
  can_create_user_groups: true,
  can_create_connections: true,
  can_create_connection_folders: true,
  can_create_sharing_profiles: true,
  can_view_sessions: true,
};

const regularUser: MeResponse = {
  ...adminUser,
  id: 'u2',
  username: 'user1',
  role: 'user',
  can_manage_system: false,
  can_manage_users: false,
  can_manage_connections: false,
  can_view_audit_logs: false,
  can_create_users: false,
  can_create_user_groups: false,
  can_create_connections: false,
  can_create_connection_folders: false,
  can_create_sharing_profiles: false,
  can_view_sessions: false,
};

function renderSessions(user: MeResponse | null = adminUser) {
  return render(
    <BrowserRouter>
      <Sessions user={user} />
    </BrowserRouter>,
  );
}

describe('Sessions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getActiveSessions).mockResolvedValue([makeSession()]);
    vi.mocked(getMyActiveSessions).mockResolvedValue([makeSession()]);
    vi.mocked(killSessions).mockResolvedValue({ status: 'ok', killed_count: 1 });
    vi.mocked(getRecordings).mockResolvedValue([makeRecording()]);
    vi.mocked(getMyRecordings).mockResolvedValue([makeRecording()]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockNavigate.mockReset();
  });

  // ── Heading and tabs ──────────────────────────────────────

  it('renders heading', async () => {
    await act(async () => { renderSessions(); });
    expect(screen.getByText('Sessions')).toBeInTheDocument();
  });

  it('renders Live and Recordings tabs', async () => {
    await act(async () => { renderSessions(); });
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('Recordings')).toBeInTheDocument();
  });

  it('shows admin description for admin user', async () => {
    await act(async () => { renderSessions(adminUser); });
    expect(screen.getByText(/Monitor all user sessions/)).toBeInTheDocument();
  });

  it('shows user description for regular user', async () => {
    await act(async () => { renderSessions(regularUser); });
    expect(screen.getByText(/View your active sessions/)).toBeInTheDocument();
  });

  // ── Live tab ──────────────────────────────────────────────

  it('calls getActiveSessions for admin', async () => {
    await act(async () => { renderSessions(adminUser); });
    await waitFor(() => expect(getActiveSessions).toHaveBeenCalled());
  });

  it('calls getMyActiveSessions for regular user', async () => {
    await act(async () => { renderSessions(regularUser); });
    await waitFor(() => expect(getMyActiveSessions).toHaveBeenCalled());
  });

  it('shows session rows', async () => {
    await act(async () => { renderSessions(); });
    expect(await screen.findByText('Server A')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5')).toBeInTheDocument();
  });

  it('shows protocol badge', async () => {
    await act(async () => { renderSessions(); });
    expect(await screen.findByText('rdp')).toBeInTheDocument();
  });

  it('shows empty state when no sessions', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([]);
    await act(async () => { renderSessions(); });
    expect(await screen.findByText('No active sessions found')).toBeInTheDocument();
  });

  it('shows refresh button', async () => {
    await act(async () => { renderSessions(); });
    expect(await screen.findByText('Refresh Now')).toBeInTheDocument();
  });

  it('renders username column for admin', async () => {
    await act(async () => { renderSessions(adminUser); });
    expect(await screen.findByText('admin')).toBeInTheDocument();
  });

  it('shows Live and Rewind buttons', async () => {
    await act(async () => { renderSessions(); });
    const liveButtons = await screen.findAllByText('Live', { exact: false });
    expect(liveButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('⏪ Rewind')).toBeInTheDocument();
  });

  it('navigates to observe on Live button click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    const liveBtn = await screen.findByTitle('Watch live');
    await user.click(liveBtn);
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining('/observe/'));
  });

  it('navigates to observe with offset on Rewind click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    const rewindBtn = await screen.findByTitle(/Rewind/);
    await user.click(rewindBtn);
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining('offset=300'));
  });

  // ── Admin kill sessions ───────────────────────────────────

  it('shows Kill Sessions button for admin', async () => {
    await act(async () => { renderSessions(adminUser); });
    expect(await screen.findByText(/Kill 0 Session/)).toBeInTheDocument();
  });

  it('selects a session via checkbox', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(adminUser); });
    const checkboxes = await screen.findAllByRole('checkbox');
    // First is select-all, second is the session row
    await user.click(checkboxes[1]);
    expect(screen.getByText(/Kill 1 Session/)).toBeInTheDocument();
  });

  it('select-all toggles all sessions', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ session_id: 's1' }),
      makeSession({ session_id: 's2', connection_name: 'Server B' }),
    ]);
    await act(async () => { renderSessions(adminUser); });
    await screen.findByText('Server A');
    const selectAll = screen.getAllByRole('checkbox')[0];
    await user.click(selectAll);
    expect(screen.getByText(/Kill 2 Session/)).toBeInTheDocument();
  });

  it('shows confirm modal and performs kill', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(adminUser); });
    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[1]);
    await user.click(screen.getByText(/Kill 1 Session/));
    // Confirm modal should appear
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();
    expect(screen.getByText('Terminate Sessions')).toBeInTheDocument();
    await user.click(screen.getByText('Confirm'));
    await waitFor(() => expect(killSessions).toHaveBeenCalledWith(['s1']));
  });

  it('cancels confirm modal', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(adminUser); });
    const checkboxes = await screen.findAllByRole('checkbox');
    await user.click(checkboxes[1]);
    await user.click(screen.getByText(/Kill 1 Session/));
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
  });

  // ── Recordings tab ────────────────────────────────────────

  it('switches to recordings tab', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    await waitFor(() => expect(getRecordings).toHaveBeenCalled());
  });

  it('shows recording rows', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('Server A')).toBeInTheDocument();
    expect(screen.getByText('1h 1m 1s')).toBeInTheDocument();
  });

  it('shows empty recordings state', async () => {
    vi.mocked(getRecordings).mockResolvedValue([]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('No recordings found')).toBeInTheDocument();
  });

  it('opens player on Play click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    const playBtn = await screen.findByText('Play');
    await user.click(playBtn);
    expect(screen.getByTestId('historical-player')).toBeInTheDocument();
  });

  it('closes player via Close button', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    await user.click(await screen.findByText('Play'));
    await user.click(screen.getByText('Close Player'));
    expect(screen.queryByTestId('historical-player')).not.toBeInTheDocument();
  });

  it('filters recordings by search', async () => {
    vi.mocked(getRecordings).mockResolvedValue([
      makeRecording({ id: 'r1', connection_name: 'Alpha' }),
      makeRecording({ id: 'r2', connection_name: 'Beta' }),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    await screen.findByText('Alpha');
    const searchInput = screen.getByPlaceholderText(/Filter by connection/);
    await user.type(searchInput, 'Alpha');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });

  it('shows recording error', async () => {
    vi.mocked(getRecordings).mockRejectedValue(new Error('fail'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('Failed to load recordings')).toBeInTheDocument();
  });

  it('shows storage type badge for admin', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(adminUser); });
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('local')).toBeInTheDocument();
  });

  // ── Regular user recordings ───────────────────────────────

  it('calls getMyRecordings for regular user', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(regularUser); });
    await user.click(screen.getByText('Recordings'));
    await waitFor(() => expect(getMyRecordings).toHaveBeenCalled());
  });

  // ── Duration formatting ───────────────────────────────────

  it('formats short durations correctly', async () => {
    vi.mocked(getRecordings).mockResolvedValue([
      makeRecording({ duration_secs: 45 }),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('45s')).toBeInTheDocument();
  });

  it('formats minutes-only durations', async () => {
    vi.mocked(getRecordings).mockResolvedValue([
      makeRecording({ duration_secs: 125 }),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('2m 5s')).toBeInTheDocument();
  });

  it('shows dash for null duration', async () => {
    vi.mocked(getRecordings).mockResolvedValue([
      makeRecording({ duration_secs: null }),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  // ── SSH / VNC protocol badges ─────────────────────────────

  it('shows ssh badge', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ protocol: 'ssh' }),
    ]);
    await act(async () => { renderSessions(); });
    expect(await screen.findByText('ssh')).toBeInTheDocument();
  });

  it('shows vnc badge', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ protocol: 'vnc' }),
    ]);
    await act(async () => { renderSessions(); });
    expect(await screen.findByText('vnc')).toBeInTheDocument();
  });

  it('shows unknown protocol badge', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ protocol: 'telnet' }),
    ]);
    await act(async () => { renderSessions(); });
    expect(await screen.findByText('telnet')).toBeInTheDocument();
  });

  // ── Refresh button ────────────────────────────────────────

  it('calls refresh on Refresh Now click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await screen.findByText('Server A');
    vi.mocked(getActiveSessions).mockClear();
    await user.click(screen.getByText('Refresh Now'));
    await waitFor(() => expect(getActiveSessions).toHaveBeenCalled());
  });

  it('shows recordings Refresh button', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await act(async () => { renderSessions(); });
    await user.click(screen.getByText('Recordings'));
    await screen.findByText('Server A');
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });
});
