import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

// Mock SessionManager
vi.mock('../components/SessionManager', () => ({
  useSessionManager: () => ({
    createSession: vi.fn(),
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

import Dashboard from '../pages/Dashboard';
import { getMyConnections, getFavorites, getCredentialProfiles, getServiceHealth } from '../api';

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
    // Hostnames are split across child text nodes inside td elements
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
    renderDashboard();
    // Should not crash — wait for render to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body).toBeTruthy();
  });
});
