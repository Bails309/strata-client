import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateSso: vi.fn(),
  getKerberosRealms: vi.fn(),
  createKerberosRealm: vi.fn(),
  updateKerberosRealm: vi.fn(),
  deleteKerberosRealm: vi.fn(),
  updateRecordings: vi.fn(),
  updateVault: vi.fn(),
  updateAuthMethods: vi.fn(),
  getServiceHealth: vi.fn(),
  getMetrics: vi.fn(),
  getRoles: vi.fn(),
  createRole: vi.fn(),
  getConnections: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  deleteConnection: vi.fn(),
  getConnectionGroups: vi.fn(),
  createConnectionGroup: vi.fn(),
  updateConnectionGroup: vi.fn(),
  deleteConnectionGroup: vi.fn(),
  getUsers: vi.fn(),
  getActiveSessions: vi.fn(),
  getAdSyncConfigs: vi.fn(),
  createAdSyncConfig: vi.fn(),
  updateAdSyncConfig: vi.fn(),
  deleteAdSyncConfig: vi.fn(),
  triggerAdSync: vi.fn(),
  testAdSyncConnection: vi.fn(),
  testSsoConnection: vi.fn(),
  getAdSyncRuns: vi.fn(),
}));

import AdminSettings from '../pages/AdminSettings';
import { getSettings, getRoles, getConnections, getConnectionGroups, getUsers, getServiceHealth, getMetrics } from '../api';

function renderAdmin() {
  return render(
    <BrowserRouter>
      <AdminSettings />
    </BrowserRouter>,
  );
}

describe('AdminSettings', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockResolvedValue({});
    vi.mocked(getRoles).mockResolvedValue([]);
    vi.mocked(getConnections).mockResolvedValue([]);
    vi.mocked(getConnectionGroups).mockResolvedValue([]);
    vi.mocked(getUsers).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: false, mode: '', address: '' },
    });
    vi.mocked(getMetrics).mockResolvedValue({
      active_sessions: 0,
      total_bytes_from_guacd: 0,
      total_bytes_to_guacd: 0,
      sessions_by_protocol: {},
      guacd_pool_size: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders heading', async () => {
    renderAdmin();
    expect(await screen.findByText('Admin Settings')).toBeInTheDocument();
  });

  it('renders all tab buttons', () => {
    renderAdmin();
    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.getByText('SSO / OIDC')).toBeInTheDocument();
    expect(screen.getByText('Kerberos')).toBeInTheDocument();
    expect(screen.getByText('Vault')).toBeInTheDocument();
    expect(screen.getByText('Recordings')).toBeInTheDocument();
    expect(screen.getByText('Access')).toBeInTheDocument();
    expect(screen.getByText('AD Sync')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
  });

  it('defaults to health tab', () => {
    renderAdmin();
    const healthBtn = screen.getByText('Health');
    expect(healthBtn.className).toContain('tab-active');
  });

  it('switches tabs on click', async () => {
    renderAdmin();
    const ssoBtn = screen.getByText('SSO / OIDC');
    await userEvent.click(ssoBtn);
    expect(ssoBtn.className).toContain('tab-active');
    // Health should no longer be active
    expect(screen.getByText('Health').className).not.toContain('tab-active');
  });

  it('shows error when API fails', async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error('fail'));
    renderAdmin();
    expect(await screen.findByText('Failed to load settings')).toBeInTheDocument();
  });
});
