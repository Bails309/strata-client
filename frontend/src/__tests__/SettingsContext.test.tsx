import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

vi.mock('../api', () => ({
  getDisplaySettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { getDisplaySettings, updateSettings } from '../api';

function Consumer() {
  const { settings, timeSettings, loading, formatDateTime } = useSettings();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="timezone">{timeSettings.display_timezone}</span>
      <span data-testid="date-format">{timeSettings.display_date_format}</span>
      <span data-testid="time-format">{timeSettings.display_time_format}</span>
      <span data-testid="formatted">{formatDateTime('2026-01-01T12:00:00Z')}</span>
      <span data-testid="settings">{JSON.stringify(settings)}</span>
    </div>
  );
}

describe('SettingsContext', () => {
  beforeEach(() => {
    localStorage.setItem('access_token', 'test-token');
    vi.mocked(getDisplaySettings).mockResolvedValue({
      display_timezone: 'America/New_York',
      display_date_format: 'MM/DD/YYYY',
      display_time_format: 'hh:mm:ss A',
    });
    vi.mocked(updateSettings).mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('throws when useSettings is used outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow('useSettings must be used within a SettingsProvider');
    spy.mockRestore();
  });

  it('provides default time settings while loading', async () => {
    vi.mocked(getDisplaySettings).mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });
    expect(screen.getByTestId('timezone').textContent).toBe('UTC');
    expect(screen.getByTestId('date-format').textContent).toBe('YYYY-MM-DD');
    expect(screen.getByTestId('time-format').textContent).toBe('HH:mm:ss');
  });

  it('loads settings from API', async () => {
    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('timezone').textContent).toBe('America/New_York');
    });
    expect(getDisplaySettings).toHaveBeenCalled();
  });

  it('skips fetch when no access_token', async () => {
    localStorage.removeItem('access_token');
    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(getDisplaySettings).not.toHaveBeenCalled();
  });

  it('handles fetch error gracefully', async () => {
    vi.mocked(getDisplaySettings).mockRejectedValue(new Error('network'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    // Falls back to defaults
    expect(screen.getByTestId('timezone').textContent).toBe('UTC');
    spy.mockRestore();
  });

  it('formatDateTime formats a date string', async () => {
    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('formatted').textContent).not.toBe('');
    });
  });

  it('updateSettings calls API and refreshes', async () => {
    let contextRef: any;
    function Grabber() {
      contextRef = useSettings();
      return null;
    }
    await act(async () => {
      render(
        <SettingsProvider>
          <Grabber />
        </SettingsProvider>,
      );
    });
    await waitFor(() => expect(contextRef.loading).toBe(false));
    vi.mocked(getDisplaySettings).mockClear();
    await act(async () => {
      await contextRef.updateSettings([{ key: 'display_timezone', value: 'UTC' }]);
    });
    expect(updateSettings).toHaveBeenCalledWith([{ key: 'display_timezone', value: 'UTC' }]);
    expect(getDisplaySettings).toHaveBeenCalled();
  });

  it('formatDateTime returns dash for null', async () => {
    let formatted = '';
    function Grabber() {
      const { formatDateTime } = useSettings();
      formatted = formatDateTime(null);
      return null;
    }
    await act(async () => {
      render(
        <SettingsProvider>
          <Grabber />
        </SettingsProvider>,
      );
    });
    expect(formatted).toBe('\u2014');
  });
});
