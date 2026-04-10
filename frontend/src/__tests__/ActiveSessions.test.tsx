import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../api', () => ({
  getActiveSessions: vi.fn(),
  killSessions: vi.fn(),
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

import ActiveSessions from '../pages/ActiveSessions';
import { getActiveSessions, killSessions } from '../api';

function makeSession(overrides: Partial<import('../api').ActiveSession> = {}): import('../api').ActiveSession {
  return {
    session_id: 's1',
    connection_id: 'c1',
    connection_name: 'Server A',
    protocol: 'rdp',
    user_id: 'u1-abcdef01-2345',
    username: 'admin',
    started_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    buffer_depth_secs: 0,
    bytes_from_guacd: 10 * 1024 * 1024,
    bytes_to_guacd: 512 * 1024,
    remote_host: '10.0.0.5',
    client_ip: '192.168.1.10',
    ...overrides,
  };
}

describe('ActiveSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getActiveSessions).mockResolvedValue([makeSession()]);
    vi.mocked(killSessions).mockResolvedValue({ status: 'ok', killed_count: 1 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders heading', async () => {
    render(<ActiveSessions />);
    expect(screen.getByText('Active Sessions')).toBeInTheDocument();
    await waitFor(() => expect(getActiveSessions).toHaveBeenCalled());
  });

  it('shows loading state initially', async () => {
    vi.mocked(getActiveSessions).mockReturnValue(new Promise(() => {}));
    render(<ActiveSessions />);
    expect(screen.getByText('Refreshing...')).toBeInTheDocument();
  });

  it('renders session rows', async () => {
    render(<ActiveSessions />);
    expect(await screen.findByText('Server A')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.10')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5')).toBeInTheDocument();
  });

  it('shows empty state when no sessions', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([]);
    render(<ActiveSessions />);
    expect(await screen.findByText('No active sessions found')).toBeInTheDocument();
  });

  it('shows rdp badge', async () => {
    render(<ActiveSessions />);
    expect(await screen.findByText('rdp')).toBeInTheDocument();
  });

  it('shows ssh badge', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([makeSession({ protocol: 'ssh' })]);
    render(<ActiveSessions />);
    expect(await screen.findByText('ssh')).toBeInTheDocument();
  });

  it('shows vnc badge', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([makeSession({ protocol: 'vnc' })]);
    render(<ActiveSessions />);
    expect(await screen.findByText('vnc')).toBeInTheDocument();
  });

  it('shows unknown protocol badge', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([makeSession({ protocol: 'telnet' })]);
    render(<ActiveSessions />);
    expect(await screen.findByText('telnet')).toBeInTheDocument();
  });

  it('shows traffic in MB and KB', async () => {
    render(<ActiveSessions />);
    expect(await screen.findByText('10.0 MB')).toBeInTheDocument();
    expect(screen.getByText('512.0 KB')).toBeInTheDocument();
  });

  it('shows user_id prefix', async () => {
    render(<ActiveSessions />);
    expect(await screen.findByText('u1-abcde')).toBeInTheDocument();
  });

  it('toggles individual session checkbox', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ActiveSessions />);
    await screen.findByText('Server A');

    const checkboxes = screen.getAllByRole('checkbox');
    // checkboxes[0] is select-all, checkboxes[1] is the row
    await user.click(checkboxes[1]);
    expect(screen.getByText('Kill 1 Session(s)')).toBeInTheDocument();

    // Uncheck
    await user.click(checkboxes[1]);
    expect(screen.getByText('Kill 0 Session(s)')).toBeInTheDocument();
  });

  it('toggles select-all checkbox', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession(),
      makeSession({ session_id: 's2', connection_name: 'Server B' }),
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ActiveSessions />);
    await screen.findByText('Server A');

    const selectAll = screen.getAllByRole('checkbox')[0];
    await user.click(selectAll);
    expect(screen.getByText('Kill 2 Session(s)')).toBeInTheDocument();

    // Deselect all
    await user.click(selectAll);
    expect(screen.getByText('Kill 0 Session(s)')).toBeInTheDocument();
  });

  it('kill button is disabled when nothing selected', async () => {
    render(<ActiveSessions />);
    await screen.findByText('Server A');
    const killBtn = screen.getByText('Kill 0 Session(s)');
    expect(killBtn).toBeDisabled();
  });

  it('shows confirm modal on kill click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ActiveSessions />);
    await screen.findByText('Server A');

    // Select session
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);

    // Click kill
    await user.click(screen.getByText('Kill 1 Session(s)'));

    // Modal appears
    expect(screen.getByText('Terminate Sessions')).toBeInTheDocument();
    expect(screen.getByText(/terminate 1 active session/i)).toBeInTheDocument();
  });

  it('terminates sessions on confirm', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ActiveSessions />);
    await screen.findByText('Server A');

    // Select and kill
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);
    await user.click(screen.getByText('Kill 1 Session(s)'));
    await user.click(screen.getByText('Terminate'));

    expect(killSessions).toHaveBeenCalledWith(['s1']);
  });

  it('cancels kill via modal cancel', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ActiveSessions />);
    await screen.findByText('Server A');

    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);
    await user.click(screen.getByText('Kill 1 Session(s)'));
    await user.click(screen.getByText('Cancel'));

    expect(killSessions).not.toHaveBeenCalled();
    // Selection should still be there
    expect(screen.getByText('Kill 1 Session(s)')).toBeInTheDocument();
  });

  it('refreshes on button click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ActiveSessions />);
    await screen.findByText('Server A');
    expect(getActiveSessions).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText('Refresh Now'));
    await waitFor(() => expect(getActiveSessions).toHaveBeenCalledTimes(2));
  });

  it('handles API error gracefully', async () => {
    vi.mocked(getActiveSessions).mockRejectedValue(new Error('fail'));
    render(<ActiveSessions />);
    await waitFor(() => {
      expect(screen.getByText('No active sessions found')).toBeInTheDocument();
    });
  });

  it('shows duration with hours and minutes', async () => {
    // Session started 2 hours 30 minutes ago
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ started_at: new Date(Date.now() - (2 * 3600 + 30 * 60) * 1000).toISOString() }),
    ]);
    render(<ActiveSessions />);
    await waitFor(() => {
      expect(screen.getByText(/2h 30m/)).toBeInTheDocument();
    });
  });

  it('shows duration with only seconds', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ started_at: new Date(Date.now() - 45 * 1000).toISOString() }),
    ]);
    render(<ActiveSessions />);
    await waitFor(() => {
      expect(screen.getByText(/45s/)).toBeInTheDocument();
    });
  });

  it('shows duration with minutes and seconds', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      makeSession({ started_at: new Date(Date.now() - (5 * 60 + 30) * 1000).toISOString() }),
    ]);
    render(<ActiveSessions />);
    await waitFor(() => {
      expect(screen.getByText(/5m 30s/)).toBeInTheDocument();
    });
  });

  it('shows selected row highlight', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ActiveSessions />);
    await screen.findByText('Server A');

    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);

    // The row should have bg-accent-dim class
    const row = screen.getByText('Server A').closest('tr');
    expect(row?.className).toContain('bg-accent-dim');
  });

  it('handles kill failure with alert', async () => {
    vi.mocked(killSessions).mockRejectedValue(new Error('fail'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ActiveSessions />);
    await screen.findByText('Server A');

    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);
    await user.click(screen.getByText('Kill 1 Session(s)'));
    await user.click(screen.getByText('Terminate'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Failed to terminate sessions');
    });
    alertSpy.mockRestore();
  });

  it('renders column headers', async () => {
    render(<ActiveSessions />);
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByText('Protocol')).toBeInTheDocument();
    expect(screen.getByText('Source IP')).toBeInTheDocument();
    expect(screen.getByText('Remote Host')).toBeInTheDocument();
    expect(screen.getByText('Active Since')).toBeInTheDocument();
    expect(screen.getByText('Traffic')).toBeInTheDocument();
  });
});
