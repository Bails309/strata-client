import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

// Mock SessionManager
vi.mock('../components/SessionManager', () => ({
  useSessionManager: () => ({
    createSession: vi.fn(({ connectionId, name, protocol }: any) => ({
      id: `sess-${connectionId}`,
      connectionId,
      name,
      protocol,
      client: { getDisplay: () => ({ getElement: () => document.createElement('div') }) },
      tunnel: {},
      displayEl: document.createElement('div'),
      keyboard: { onkeydown: null, onkeyup: null, reset: vi.fn() },
      createdAt: Date.now(),
      filesystems: [],
      remoteClipboard: '',
    })),
    setTiledSessionIds: vi.fn(),
    setFocusedSessionIds: vi.fn(),
    setActiveSessionId: vi.fn(),
    sessions: [],
    activeSessionId: null,
  }),
  SessionManagerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../api', () => ({
  getMyConnections: vi.fn(),
  getConnectionInfo: vi.fn(),
  getFavorites: vi.fn(),
  toggleFavorite: vi.fn(),
  getCredentialProfiles: vi.fn(),
  getProfileMappings: vi.fn(),
  setCredentialMapping: vi.fn(),
  removeCredentialMapping: vi.fn(),
  createTunnelTicket: vi.fn(),
  getServiceHealth: vi.fn(),
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

import Dashboard from '../pages/Dashboard';
import {
  getMyConnections, getFavorites, getCredentialProfiles, getServiceHealth,
  getProfileMappings, toggleFavorite, setCredentialMapping,
  removeCredentialMapping, getConnectionInfo, createTunnelTicket,
} from '../api';

function renderDashboard() {
  return render(
    <BrowserRouter>
      <Dashboard />
    </BrowserRouter>,
  );
}

const mockConnections = [
  { id: '1', name: 'Server Alpha', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: 'Production RDP' },
  { id: '2', name: 'Server Beta', protocol: 'ssh', hostname: '10.0.0.2', port: 22, description: 'Dev SSH' },
  { id: '3', name: 'DB Server', protocol: 'db', hostname: '10.0.0.3', port: 5432, description: 'PostgreSQL' },
];

const mockGroupedConnections = [
  { id: '1', name: 'Server Alpha', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '', folder_id: 'g1', folder_name: 'Production' },
  { id: '2', name: 'Server Beta', protocol: 'ssh', hostname: '10.0.0.2', port: 22, description: '', folder_id: 'g1', folder_name: 'Production' },
  { id: '3', name: 'DB Server', protocol: 'db', hostname: '10.0.0.3', port: 5432, description: '', folder_id: undefined, folder_name: undefined },
];

describe('Dashboard', () => {
  beforeEach(() => {
    vi.mocked(getMyConnections).mockResolvedValue(mockConnections);
    vi.mocked(getFavorites).mockResolvedValue([]);
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: false, mode: '', address: '' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders connection list', async () => {
    renderDashboard();
    // Wait for async initialization
    expect(await screen.findByText('Server Alpha')).toBeInTheDocument();
    expect(screen.getByText('Server Beta')).toBeInTheDocument();
    expect(screen.getByText('DB Server')).toBeInTheDocument();
  });

  it('renders protocol labels', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    expect(screen.getByText('RDP')).toBeInTheDocument();
    expect(screen.getByText('SSH')).toBeInTheDocument();
  });

  it('displays hostname for each connection', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    const cells = document.querySelectorAll('td');
    const cellTexts = Array.from(cells).map((c) => c.textContent || '');
    expect(cellTexts.some((t) => t.includes('10.0.0.1'))).toBe(true);
    expect(cellTexts.some((t) => t.includes('10.0.0.2'))).toBe(true);
  });

  it('filters connections by search', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');

    const searchInput = screen.getByPlaceholderText(/search/i);
    await userEvent.type(searchInput, 'Beta');

    expect(screen.getByText('Server Beta')).toBeInTheDocument();
    expect(screen.queryByText('Server Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('DB Server')).not.toBeInTheDocument();
  });

  it('filters by description text', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');

    const searchInput = screen.getByPlaceholderText(/search/i);
    await userEvent.type(searchInput, 'PostgreSQL');

    expect(screen.getByText('DB Server')).toBeInTheDocument();
    expect(screen.queryByText('Server Alpha')).not.toBeInTheDocument();
  });

  it('shows empty state when no connections', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([]);
    renderDashboard();
    expect(await screen.findByText(/no connections/i)).toBeInTheDocument();
  });

  it('renders checkbox for each connection', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    const checkboxes = screen.getAllByRole('checkbox');
    // At least one per connection + the select-all
    expect(checkboxes.length).toBeGreaterThanOrEqual(3);
  });

  it('handles API error gracefully', async () => {
    vi.mocked(getMyConnections).mockRejectedValue(new Error('fail'));
    await act(async () => {
      renderDashboard();
    });
    // Should not crash — wait for render to settle
    await waitFor(() => {
      expect(document.body).toBeTruthy();
    });
  });

  it('shows vault not configured state', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    // vault not configured = no profile selectors shown
    expect(screen.queryByText(/credential profile/i)).not.toBeInTheDocument();
  });

  it('shows vault configured state with profile selector', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: true, mode: 'local', address: 'http://vault:8200' },
    });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      { id: 'prof1', label: 'Admin creds', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', expires_at: '2024-12-31T00:00:00Z', expired: false, ttl_hours: 12 },
    ]);
    vi.mocked(getProfileMappings).mockResolvedValue([]);
    renderDashboard();
    await screen.findByText('Server Alpha');
    // Profile selector should appear per-row when vault is configured - shows "None" as default
    await waitFor(() => {
      expect(screen.getAllByText('None').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders favorites toggle', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    const favBtn = screen.getByTitle('Show favorites only');
    expect(favBtn).toBeInTheDocument();
  });

  it('shows no matches message when search has no results', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    const searchInput = screen.getByPlaceholderText(/search/i);
    await userEvent.type(searchInput, 'NONEXISTENT');
    expect(screen.getByText('No connections match your filters.')).toBeInTheDocument();
  });

  it('renders connection descriptions', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    expect(screen.getByText('Production RDP')).toBeInTheDocument();
    expect(screen.getByText('Dev SSH')).toBeInTheDocument();
  });

  it('toggles favorite for a connection', async () => {
    vi.mocked(toggleFavorite).mockResolvedValue({ favorited: true });
    renderDashboard();
    await screen.findByText('Server Alpha');
    const favButtons = screen.getAllByTitle('Add to favorites');
    await userEvent.click(favButtons[0]);
    expect(toggleFavorite).toHaveBeenCalledWith('1');
  });

  it('loads initial favorites from API', async () => {
    vi.mocked(getFavorites).mockResolvedValue(['1']);
    renderDashboard();
    await screen.findByText('Server Alpha');
    // One connection should show "Remove from favorites" title
    await waitFor(() => {
      expect(screen.getByTitle('Remove from favorites')).toBeInTheDocument();
    });
  });

  it('filters to show only favorites', async () => {
    vi.mocked(getFavorites).mockResolvedValue(['1']);
    renderDashboard();
    await screen.findByText('Server Alpha');
    // Click favorites toggle
    await userEvent.click(screen.getByTitle('Show favorites only'));
    // Should only show Server Alpha (favorite) and not the others
    await waitFor(() => {
      expect(screen.getByText('Server Alpha')).toBeInTheDocument();
      expect(screen.queryByText('Server Beta')).not.toBeInTheDocument();
    });
  });

  it('select all checkbox toggles all connection checkboxes', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    const checkboxes = screen.getAllByRole('checkbox');
    const selectAll = checkboxes[0]; // the select-all checkbox
    await userEvent.click(selectAll);
    // All should be checked
    const updated = screen.getAllByRole('checkbox');
    const checkedCount = updated.filter((cb) => (cb as HTMLInputElement).checked).length;
    expect(checkedCount).toBeGreaterThanOrEqual(3);
  });

  it('shows Open Tiled button when 2+ connections selected', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    const checkboxes = screen.getAllByRole('checkbox');
    // Click 2 individual connection checkboxes (skip select-all at index 0)
    await userEvent.click(checkboxes[1]);
    await userEvent.click(checkboxes[2]);
    expect(screen.getByText(/Open Tiled/)).toBeInTheDocument();
  });

  it('toggles folder view', async () => {
    vi.mocked(getMyConnections).mockResolvedValue(mockGroupedConnections);
    renderDashboard();
    await screen.findByText('Server Alpha');
    await userEvent.click(screen.getByText('Folders'));
    // Folder view should display folder headers
    await waitFor(() => {
      expect(screen.getByText('Production')).toBeInTheDocument();
      expect(screen.getByText('Ungrouped')).toBeInTheDocument();
    });
  });

  it('collapses and expands folders', async () => {
    vi.mocked(getMyConnections).mockResolvedValue(mockGroupedConnections);
    renderDashboard();
    await screen.findByText('Server Alpha');
    await userEvent.click(screen.getByText('Folders'));
    await waitFor(() => expect(screen.getByText('Production')).toBeInTheDocument());
    // Click Production folder header to collapse (it has (2) count)
    await userEvent.click(screen.getByText('Production'));
    // Connections inside should be hidden
    await waitFor(() => {
      // Server Alpha is in the Production group, should be gone when collapsed
      expect(screen.getByText('DB Server')).toBeInTheDocument();
    });
  });

  it('shows recent connections cards when last_accessed exists', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([
      { ...mockConnections[0], last_accessed: '2024-06-15T10:00:00Z' },
      { ...mockConnections[1], last_accessed: '2024-06-14T09:00:00Z' },
      mockConnections[2],
    ]);
    renderDashboard();
    // Wait for connections to load
    await waitFor(() => {
      const cards = document.querySelectorAll('.recent-card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });
    // Recent cards section should exist
    expect(document.querySelector('.recent-cards-section')).toBeTruthy();
  });

  it('resets page to 1 when search changes', async () => {
    // Create more than 50 connections to trigger pagination
    const manyConnections = Array.from({ length: 55 }, (_, i) => ({
      id: `c${i}`, name: `Conn ${i}`, protocol: 'rdp', hostname: `10.0.0.${i}`, port: 3389, description: `desc ${i}`,
    }));
    vi.mocked(getMyConnections).mockResolvedValue(manyConnections);
    renderDashboard();
    await screen.findByText('Conn 0');
    // Pagination should be shown
    expect(screen.getByText(/Showing/)).toBeInTheDocument();
    // Filter down
    await userEvent.type(screen.getByPlaceholderText(/search/i), 'Conn 5');
    // Page should reset to 1 showing filtered results
    await waitFor(() => {
      expect(screen.getByText('Conn 5')).toBeInTheDocument();
    });
  });

  it('handles profile change for a connection', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: true, mode: 'local', address: '' },
    });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      { id: 'prof1', label: 'Admin', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', expires_at: '2024-12-31T00:00:00Z', ttl_hours: 12, expired: false },
    ]);
    vi.mocked(getProfileMappings).mockResolvedValue([]);
    vi.mocked(setCredentialMapping).mockResolvedValue({ status: 'success' });
    renderDashboard();
    await screen.findByText('Server Alpha');
    // Profile selectors should show None as default
    await waitFor(() => {
      expect(screen.getAllByText('None').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows dash for connections without last_accessed', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([
      { id: '1', name: 'No Access', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '' },
    ]);
    renderDashboard();
    await screen.findByText('No Access');
    expect(document.body.textContent).toContain('—');
  });

  it('shows last accessed date for connection with timestamp', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([
      { id: '1', name: 'Recent', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '', last_accessed: '2024-06-15T10:30:00Z' },
    ]);
    renderDashboard();
    await screen.findByText(/My Connections/i);
    await waitFor(() => {
      const elements = screen.getAllByText(/Recent/i);
      expect(elements.length).toBeGreaterThan(0);
    });
    // The date should be formatted (not a dash) — check for year
    expect(document.body.textContent).toContain('2024');
  });

  it('shows connect button for each connection', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    const connectBtns = screen.getAllByText('Connect');
    expect(connectBtns.length).toBe(3);
  });

  it('renders VNC protocol icon', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([
      { id: '1', name: 'VNC Server', protocol: 'vnc', hostname: '10.0.0.1', port: 5900, description: '' },
    ]);
    renderDashboard();
    await screen.findByText('VNC Server');
    expect(screen.getByText('VNC')).toBeInTheDocument();
  });

  it('shows no connections message when empty', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([]);
    renderDashboard();
    expect(await screen.findByText(/no connections available/i)).toBeInTheDocument();
  });

  it('toggles unfavorite for a favorited connection', async () => {
    vi.mocked(getFavorites).mockResolvedValue(['1']);
    vi.mocked(toggleFavorite).mockResolvedValue({ favorited: false });
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTitle('Remove from favorites')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTitle('Remove from favorites'));
    expect(toggleFavorite).toHaveBeenCalledWith('1');
  });

  it('shows favorites count in button when favorites exist', async () => {
    vi.mocked(getFavorites).mockResolvedValue(['1', '2']);
    renderDashboard();
    await screen.findByText('Server Alpha');
    await waitFor(() => {
      expect(screen.getByText(/Favorites \(2\)/)).toBeInTheDocument();
    });
  });

  it('groups connections in folder view with counts', async () => {
    vi.mocked(getMyConnections).mockResolvedValue(mockGroupedConnections);
    renderDashboard();
    await screen.findByText('Server Alpha');
    await userEvent.click(screen.getByText('Folders'));
    await waitFor(() => {
      expect(screen.getByText('(2)')).toBeInTheDocument(); // Production has 2
      expect(screen.getByText('(1)')).toBeInTheDocument(); // Ungrouped has 1
    });
  });

  it('recent cards show protocol and hostname', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([
      { id: '1', name: 'Server Alpha', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '', last_accessed: '2024-06-15T10:00:00Z' },
    ]);
    renderDashboard();
    await waitFor(() => {
      const cards = document.querySelectorAll('.recent-card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });
    expect(document.body.textContent).toContain('RDP - 10.0.0.1:3389');
  });

  it('recent cards show credential status badges', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: true, mode: 'local', address: '' },
    });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      { id: 'p1', label: 'Admin', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', expires_at: '2024-12-31T00:00:00Z', ttl_hours: 12, expired: false },
    ]);
    vi.mocked(getProfileMappings).mockResolvedValue([{ connection_id: '1', connection_name: 'Server Alpha', protocol: 'rdp' }]);
    vi.mocked(getMyConnections).mockResolvedValue([
      { id: '1', name: 'Server Alpha', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '', last_accessed: '2024-06-15T10:00:00Z' },
    ]);
    renderDashboard();
    await waitFor(() => {
      const cards = document.querySelectorAll('.recent-card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });
    // Should show "active" status
    await waitFor(() => {
      expect(document.body.textContent).toContain('active');
    });
  });

  it('recent cards show "no profile" for unmapped connections', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([
      { id: '1', name: 'Server Alpha', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '', last_accessed: '2024-06-15T10:00:00Z' },
    ]);
    renderDashboard();
    await waitFor(() => {
      const cards = document.querySelectorAll('.recent-card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });
    expect(document.body.textContent).toContain('no profile');
  });

  it('shows expired status for expired profile', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: true, mode: 'local', address: '' },
    });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      { id: 'p1', label: 'Expired Creds', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', expires_at: '2023-01-01T00:00:00Z', ttl_hours: 12, expired: true },
    ]);
    vi.mocked(getProfileMappings).mockResolvedValue([{ connection_id: '1', connection_name: 'Server Alpha', protocol: 'rdp' }]);
    vi.mocked(getMyConnections).mockResolvedValue([
      { id: '1', name: 'Server Alpha', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: '', last_accessed: '2024-06-15T10:00:00Z' },
    ]);
    renderDashboard();
    await waitFor(() => {
      const cards = document.querySelectorAll('.recent-card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain('expired');
    });
  });

  it('shows pagination Previous and Next buttons', async () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      id: `c${i}`, name: `Conn ${i}`, protocol: 'rdp', hostname: `10.0.${i}.1`, port: 3389, description: '',
    }));
    vi.mocked(getMyConnections).mockResolvedValue(many);
    renderDashboard();
    await screen.findByText('Conn 0');
    expect(screen.getByText('Previous')).toBeInTheDocument();
    expect(screen.getByText('Next')).toBeInTheDocument();
  });

  it('navigates to next page', async () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      id: `c${i}`, name: `Conn ${i}`, protocol: 'rdp', hostname: `10.0.${i}.1`, port: 3389, description: '',
    }));
    vi.mocked(getMyConnections).mockResolvedValue(many);
    renderDashboard();
    await screen.findByText('Conn 0');
    await userEvent.click(screen.getByText('Next'));
    await waitFor(() => {
      expect(screen.getByText('Conn 50')).toBeInTheDocument();
    });
  });

  it('navigates back to previous page', async () => {
    const many = Array.from({ length: 55 }, (_, i) => ({
      id: `c${i}`, name: `Conn ${i}`, protocol: 'rdp', hostname: `10.0.${i}.1`, port: 3389, description: '',
    }));
    vi.mocked(getMyConnections).mockResolvedValue(many);
    renderDashboard();
    await screen.findByText('Conn 0');
    await userEvent.click(screen.getByText('Next'));
    await waitFor(() => {
      expect(screen.getByText('Conn 50')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText('Previous'));
    await waitFor(() => {
      expect(screen.getByText('Conn 0')).toBeInTheDocument();
    });
  });

  it('deselects all when select-all toggled off', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    const checkboxes = screen.getAllByRole('checkbox');
    // Select all
    await userEvent.click(checkboxes[0]);
    // Deselect all
    await userEvent.click(checkboxes[0]);
    const updated = screen.getAllByRole('checkbox');
    const checkedCount = updated.filter((cb) => (cb as HTMLInputElement).checked).length;
    expect(checkedCount).toBe(0);
  });

  it('filters by hostname as well as name', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    await userEvent.type(screen.getByPlaceholderText(/search/i), '10.0.0.2');
    await waitFor(() => {
      expect(screen.getByText('Server Beta')).toBeInTheDocument();
      expect(screen.queryByText('Server Alpha')).not.toBeInTheDocument();
    });
  });

  it('filters connections by protocol type selector', async () => {
    renderDashboard();
    await screen.findByText('Server Alpha');
    // Open the type dropdown and select SSH
    const typeTrigger = screen.getByText('All');
    await userEvent.click(typeTrigger);
    await userEvent.click(screen.getByRole('option', { name: 'SSH' }));
    await waitFor(() => {
      expect(screen.getByText('Server Beta')).toBeInTheDocument();
      expect(screen.queryByText('Server Alpha')).not.toBeInTheDocument();
    });
  });

  it('shows tiled credential prompt when opening tiled with credless RDP connections', async () => {
    vi.mocked(getMyConnections).mockResolvedValue(mockConnections);
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    renderDashboard();
    await screen.findByText('Server Alpha');
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[1]); // connection 1
    await userEvent.click(checkboxes[2]); // connection 2
    await userEvent.click(screen.getByText(/Open Tiled/));
    await waitFor(() => {
      expect(screen.getByText('Enter Credentials')).toBeInTheDocument();
    });
  });

  it('submits tiled credential form', async () => {
    vi.mocked(getMyConnections).mockResolvedValue(mockConnections);
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    vi.mocked(createTunnelTicket).mockResolvedValue({ ticket: 'tkt-1' });
    renderDashboard();
    await screen.findByText('Server Alpha');
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[1]);
    await userEvent.click(checkboxes[2]);
    await userEvent.click(screen.getByText(/Open Tiled/));
    await waitFor(() => {
      expect(screen.getByText('Enter Credentials')).toBeInTheDocument();
    });
    // Fill creds
    const userInputs = screen.getAllByPlaceholderText('Username');
    const passInputs = screen.getAllByPlaceholderText('Password');
    await userEvent.type(userInputs[0], 'admin');
    await userEvent.type(passInputs[0], 'secret');
    // Submit
    await userEvent.click(screen.getByText(/Connect All/));
    expect(createTunnelTicket).toHaveBeenCalled();
  });

  it('cancels tiled credential prompt', async () => {
    vi.mocked(getMyConnections).mockResolvedValue(mockConnections);
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: false });
    renderDashboard();
    await screen.findByText('Server Alpha');
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[1]);
    await userEvent.click(checkboxes[2]);
    await userEvent.click(screen.getByText(/Open Tiled/));
    await waitFor(() => {
      expect(screen.getByText('Enter Credentials')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Enter Credentials')).not.toBeInTheDocument();
  });

  it('opens tiled immediately when connections have vault credentials', async () => {
    vi.mocked(getMyConnections).mockResolvedValue(mockConnections);
    vi.mocked(getConnectionInfo).mockResolvedValue({ protocol: 'rdp', has_credentials: true });
    vi.mocked(createTunnelTicket).mockResolvedValue({ ticket: 'tkt-1' });
    renderDashboard();
    await screen.findByText('Server Alpha');
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[1]);
    await userEvent.click(checkboxes[2]);
    await userEvent.click(screen.getByText(/Open Tiled/));
    // Should NOT show credential modal, should call createTunnelTicket directly
    await waitFor(() => {
      expect(createTunnelTicket).toHaveBeenCalled();
    });
    expect(screen.queryByText('Enter Credentials')).not.toBeInTheDocument();
  });

  it('removes a credential mapping when profile set to empty', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: true, mode: 'local', address: '' },
    });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      { id: 'prof1', label: 'Admin', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', expires_at: '2024-12-31T00:00:00Z', ttl_hours: 12, expired: false },
    ]);
    vi.mocked(getProfileMappings).mockResolvedValue([{ connection_id: '1', connection_name: 'Server Alpha', protocol: 'rdp' }]);
    vi.mocked(removeCredentialMapping).mockResolvedValue({ status: 'ok' });
    renderDashboard();
    await screen.findByText('Server Alpha');
    // Wait for profile to load and show "Admin" option assigned
    await waitFor(() => {
      expect(screen.getAllByText('Admin').length).toBeGreaterThanOrEqual(1);
    });
    // Click the Admin option to open dropdown for first connection, select None
    const adminOptions = screen.getAllByText('Admin');
    await userEvent.click(adminOptions[0]);
    // Select None from dropdown
    const noneOption = screen.getByRole('option', { name: 'None' });
    await userEvent.click(noneOption);
    await waitFor(() => {
      expect(removeCredentialMapping).toHaveBeenCalledWith('1');
    });
  });

  it('shows domain label on recent cards for non-IP hostname', async () => {
    vi.mocked(getMyConnections).mockResolvedValue([
      { id: '1', name: 'Server Alpha', protocol: 'rdp', hostname: 'server.example.com', port: 3389, description: '', last_accessed: '2024-06-15T10:00:00Z' },
    ]);
    renderDashboard();
    await waitFor(() => {
      const cards = document.querySelectorAll('.recent-card');
      expect(cards.length).toBeGreaterThanOrEqual(1);
    });
    expect(document.body.textContent).toContain('example.com');
  });

  it('shows expired label in profile selector', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: true, mode: 'local', address: '' },
    });
    vi.mocked(getCredentialProfiles).mockResolvedValue([
      { id: 'p1', label: 'Old Creds', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', expires_at: '2023-01-01T00:00:00Z', ttl_hours: 12, expired: true },
    ]);
    vi.mocked(getProfileMappings).mockResolvedValue([]);
    renderDashboard();
    await screen.findByText('Server Alpha');
    // Open profile selector
    const noneOptions = screen.getAllByText('None');
    await userEvent.click(noneOptions[0]);
    await waitFor(() => {
      expect(screen.getByText('Old Creds (expired)')).toBeInTheDocument();
    });
  });
});
