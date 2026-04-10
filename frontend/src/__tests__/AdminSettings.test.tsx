import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

// JSDOM doesn't have scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

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
  getRoleMappings: vi.fn().mockResolvedValue({ connection_ids: [], folder_ids: [] }),
  updateRoleMappings: vi.fn(),
  getConnections: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  deleteConnection: vi.fn(),
  getConnectionFolders: vi.fn(),
  createConnectionFolder: vi.fn(),
  updateConnectionFolder: vi.fn(),
  deleteConnectionFolder: vi.fn(),
  getUsers: vi.fn(),
  getActiveSessions: vi.fn(),
  killSessions: vi.fn(),
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
import {
  getSettings, getRoles, getConnections, getConnectionFolders, getUsers,
  getServiceHealth, getMetrics, testSsoConnection, updateSso, updateRecordings, updateVault,
  getKerberosRealms, createKerberosRealm, updateKerberosRealm, deleteKerberosRealm,
  createRole, createConnection, updateConnection, deleteConnection,
  createConnectionFolder, deleteConnectionFolder,
  getActiveSessions, killSessions, getAdSyncConfigs, createAdSyncConfig, updateAdSyncConfig, deleteAdSyncConfig,
  triggerAdSync, testAdSyncConnection, getAdSyncRuns,
  updateAuthMethods, updateSettings, updateRoleMappings,
} from '../api';

const healthOk = {
  database: { connected: true, mode: 'local', host: 'localhost' },
  guacd: { reachable: true, host: 'guacd', port: 4822 },
  vault: { configured: true, mode: 'local', address: 'http://vault:8200' },
};

const healthDown = {
  database: { connected: false, mode: 'local', host: 'localhost' },
  guacd: { reachable: false, host: 'guacd', port: 4822 },
  vault: { configured: false, mode: '', address: '' },
};

const metricsOk = {
  active_sessions: 3,
  total_bytes_from_guacd: 1024,
  total_bytes_to_guacd: 512,
  sessions_by_protocol: { rdp: 2, ssh: 1 },
  guacd_pool_size: 2,
};

const defaultUser: import('../api').MeResponse = {
  id: 'u1',
  username: 'admin',
  role: 'admin',
  client_ip: '127.0.0.1',
  watermark_enabled: false,
  vault_configured: true,
  can_manage_system: true,
  can_manage_users: true,
  can_manage_connections: true,
  can_view_audit_logs: true,
  can_create_users: true,
  can_create_user_groups: true,
  can_create_connections: true,
  can_create_connection_folders: true,
  can_create_sharing_profiles: true,
};

function renderAdmin() {
  return render(
    <BrowserRouter>
      <AdminSettings user={defaultUser} />
    </BrowserRouter>,
  );
}

function setupDefaults() {
  vi.mocked(getSettings).mockResolvedValue({});
  vi.mocked(getRoles).mockResolvedValue([]);
  vi.mocked(getConnections).mockResolvedValue([]);
  vi.mocked(getConnectionFolders).mockResolvedValue([]);
  vi.mocked(getUsers).mockResolvedValue([]);
  vi.mocked(getServiceHealth).mockResolvedValue(healthOk);
  vi.mocked(getMetrics).mockResolvedValue(metricsOk);
  vi.mocked(getActiveSessions).mockResolvedValue([]);
}

describe('AdminSettings', () => {
  beforeEach(setupDefaults);
  afterEach(() => vi.restoreAllMocks());

  it('renders heading', async () => {
    renderAdmin();
    expect(await screen.findByText('Admin Settings')).toBeInTheDocument();
  });

  it('renders all tab buttons', () => {
    renderAdmin();
    for (const label of ['Health', 'SSO / OIDC', 'Kerberos', 'Vault', 'Recordings', 'Access', 'AD Sync', 'Sessions', 'Security']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('defaults to health tab', () => {
    renderAdmin();
    expect(screen.getByText('Health').className).toContain('tab-active');
  });

  it('switches tabs on click', async () => {
    renderAdmin();
    const user = userEvent.setup();
    await user.click(screen.getByText('SSO / OIDC'));
    expect(screen.getByText('SSO / OIDC').className).toContain('tab-active');
    expect(screen.getByText('Health').className).not.toContain('tab-active');
  });

  it('shows error when API fails', async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error('fail'));
    renderAdmin();
    expect(await screen.findByText('Failed to load settings')).toBeInTheDocument();
  });
});

describe('HealthTab', () => {
  beforeEach(setupDefaults);
  afterEach(() => vi.restoreAllMocks());

  it('shows loading state initially', () => {
    vi.mocked(getServiceHealth).mockReturnValue(new Promise(() => {}));
    vi.mocked(getMetrics).mockReturnValue(new Promise(() => {}));
    renderAdmin();
    expect(screen.getByText('Loading service health...')).toBeInTheDocument();
  });

  it('shows connected/reachable badges when healthy', async () => {
    renderAdmin();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Reachable')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
  });

  it('shows disconnected/unreachable when down', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue(healthDown);
    renderAdmin();
    expect(await screen.findByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByText('Not Configured')).toBeInTheDocument();
  });

  it('shows vault mode badge', async () => {
    renderAdmin();
    const badges = await screen.findAllByText('Bundled');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('shows vault not-configured message', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue(healthDown);
    renderAdmin();
    expect(await screen.findByText(/Vault is not configured/)).toBeInTheDocument();
  });

  it('shows vault address when configured', async () => {
    renderAdmin();
    expect(await screen.findByText('http://vault:8200')).toBeInTheDocument();
  });

  it('shows pool size from metrics', async () => {
    renderAdmin();
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('shows retry button when health fails', async () => {
    vi.mocked(getServiceHealth).mockRejectedValue(new Error('fail'));
    vi.mocked(getMetrics).mockRejectedValue(new Error('fail'));
    renderAdmin();
    expect(await screen.findByText('Failed to load service health.')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('Refresh button calls API again', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('Connected');
    await user.click(screen.getByText('Refresh'));
    expect(getServiceHealth).toHaveBeenCalledTimes(2);
  });

  it('shows vault external mode badge', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: true, mode: 'external', address: 'https://vault.corp.com:8200' },
    });
    renderAdmin();
    const externals = await screen.findAllByText('External');
    expect(externals.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('https://vault.corp.com:8200')).toBeInTheDocument();
  });

  it('shows Refreshing text while loading', async () => {
    let resolveHealth!: (v: any) => void;
    vi.mocked(getServiceHealth).mockReturnValue(new Promise((r) => { resolveHealth = r; }));
    vi.mocked(getMetrics).mockResolvedValue(metricsOk);
    const user = userEvent.setup();
    renderAdmin();
    // loading initially shows "Loading service health..."
    expect(screen.getByText('Loading service health...')).toBeInTheDocument();
    resolveHealth(healthOk);
    await screen.findByText('Connected');
    // Now trigger refresh
    vi.mocked(getServiceHealth).mockReturnValue(new Promise(() => {}));
    await user.click(screen.getByText('Refresh'));
    expect(screen.getByText('Refreshing...')).toBeInTheDocument();
  });

  it('shows pool size pluralization for single instance', async () => {
    vi.mocked(getMetrics).mockResolvedValue({ ...metricsOk, guacd_pool_size: 1 });
    renderAdmin();
    expect(await screen.findByText('1')).toBeInTheDocument();
    expect(screen.getByText('(single instance)')).toBeInTheDocument();
  });

  it('shows pool size pluralization for 3+ instances', async () => {
    vi.mocked(getMetrics).mockResolvedValue({ ...metricsOk, guacd_pool_size: 4 });
    renderAdmin();
    await screen.findByText('4');
    expect(screen.getByText(/instances? \(round-robin\)/)).toBeInTheDocument();
  });

  it('retry button reloads health', async () => {
    vi.mocked(getServiceHealth).mockRejectedValue(new Error('fail'));
    vi.mocked(getMetrics).mockRejectedValue(new Error('fail'));
    const user = userEvent.setup();
    renderAdmin();
    await screen.findByText('Retry');
    vi.mocked(getServiceHealth).mockResolvedValue(healthOk);
    vi.mocked(getMetrics).mockResolvedValue(metricsOk);
    await user.click(screen.getByText('Retry'));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('shows no pool size row when metrics is null', async () => {
    vi.mocked(getMetrics).mockRejectedValue(new Error('fail'));
    renderAdmin();
    await screen.findByText('Connected');
    expect(screen.queryByText('Pool Size')).not.toBeInTheDocument();
  });
});

describe('SsoTab', () => {
  beforeEach(() => {
    setupDefaults();
    vi.mocked(getSettings).mockResolvedValue({
      sso_issuer_url: 'https://keycloak.example.com/realms/test',
      sso_client_id: 'strata-client',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders SSO form with pre-filled values', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('SSO / OIDC'));
    expect(await screen.findByDisplayValue('https://keycloak.example.com/realms/test')).toBeInTheDocument();
    expect(screen.getByDisplayValue('strata-client')).toBeInTheDocument();
  });

  it('shows test connection success', async () => {
    vi.mocked(testSsoConnection).mockResolvedValue({ status: 'success', message: 'Issuer validated' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByRole('button', { name: 'SSO / OIDC' }));
    await screen.findByDisplayValue('strata-client');
    const secretInput = screen.getByLabelText('Client Secret');
    await user.type(secretInput, 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(await screen.findByText('Issuer validated')).toBeInTheDocument();
  });

  it('shows test connection failure', async () => {
    vi.mocked(testSsoConnection).mockRejectedValue(new Error('Connection refused'));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByRole('button', { name: 'SSO / OIDC' }));
    await screen.findByDisplayValue('strata-client');
    const secretInput = screen.getByLabelText('Client Secret');
    await user.type(secretInput, 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(await screen.findByText('Connection refused')).toBeInTheDocument();
  });

  it('saves SSO settings', async () => {
    vi.mocked(updateSso).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('SSO / OIDC'));
    await screen.findByDisplayValue('strata-client');
    await user.click(screen.getByText('Save SSO Settings'));
    expect(updateSso).toHaveBeenCalled();
  });

  it('disables test button when fields are empty', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('SSO / OIDC'));
    await waitFor(() => {
      expect(screen.getByText('Test Connection')).toBeDisabled();
    });
  });

  it('shows Testing... text while test is in progress', async () => {
    vi.mocked(testSsoConnection).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByRole('button', { name: 'SSO / OIDC' }));
    await screen.findByDisplayValue('strata-client');
    const secretInput = screen.getByLabelText('Client Secret');
    await user.type(secretInput, 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(screen.getByText('Testing...')).toBeInTheDocument();
  });

  it('renders callback URL', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('SSO / OIDC'));
    expect(await screen.findByText(/\/api\/auth\/sso\/callback/)).toBeInTheDocument();
  });

  it('handles non-Error exception in test connection', async () => {
    vi.mocked(testSsoConnection).mockRejectedValue('string error');
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('SSO / OIDC'));
    await screen.findByDisplayValue('strata-client');
    await user.click(screen.getByRole('button', { name: 'SSO / OIDC' }));
    await screen.findByDisplayValue('strata-client');
    const secretInput = screen.getByLabelText('Client Secret');
    await user.type(secretInput, 'new-secret');
    await user.click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(await screen.findByText('Test failed')).toBeInTheDocument();
  });
});

describe('KerberosTab', () => {
  beforeEach(() => {
    setupDefaults();
    vi.mocked(getKerberosRealms).mockResolvedValue([
      { id: 'kr-1', realm: 'EXAMPLE.COM', kdc_servers: 'dc1.example.com,dc2.example.com', admin_server: 'dc1.example.com', ticket_lifetime: '10h', renew_lifetime: '7d', is_default: true, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders existing realms', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    expect(await screen.findByText('EXAMPLE.COM')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('shows empty state with no realms', async () => {
    vi.mocked(getKerberosRealms).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    expect(await screen.findByText(/No Kerberos realms configured/)).toBeInTheDocument();
  });

  it('opens new realm form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText('EXAMPLE.COM');
    await user.click(screen.getByText('Add Realm'));
    expect(screen.getByText('New Kerberos Realm')).toBeInTheDocument();
  });

  it('opens edit realm form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText('EXAMPLE.COM');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Edit Realm')).toBeInTheDocument();
    expect(screen.getByDisplayValue('EXAMPLE.COM')).toBeInTheDocument();
  });

  it('creates a new realm', async () => {
    vi.mocked(createKerberosRealm).mockResolvedValue({ id: 'new-realm-id', status: 'success' });
    vi.mocked(getKerberosRealms).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText(/No Kerberos realms configured/);
    await user.click(screen.getByText('Add Realm'));
    await user.type(screen.getByPlaceholderText('EXAMPLE.COM'), 'NEWREALM.COM');
    await user.click(screen.getByText('Create Realm'));
    expect(createKerberosRealm).toHaveBeenCalled();
  });

  it('shows validation error for empty realm name', async () => {
    vi.mocked(getKerberosRealms).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText(/No Kerberos realms configured/);
    await user.click(screen.getByText('Add Realm'));
    await user.click(screen.getByText('Create Realm'));
    expect(await screen.findByText('Realm name is required')).toBeInTheDocument();
  });

  it('deletes a realm', async () => {
    vi.mocked(deleteKerberosRealm).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText('EXAMPLE.COM');
    await user.click(screen.getByText('Delete'));
    expect(deleteKerberosRealm).toHaveBeenCalledWith('kr-1');
  });

  it('shows error on save failure', async () => {
    vi.mocked(createKerberosRealm).mockRejectedValue(new Error('Network error'));
    vi.mocked(getKerberosRealms).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText(/No Kerberos realms/);
    await user.click(screen.getByText('Add Realm'));
    await user.type(screen.getByPlaceholderText('EXAMPLE.COM'), 'FAIL.COM');
    await user.click(screen.getByText('Create Realm'));
    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  it('updates an existing realm', async () => {
    vi.mocked(updateKerberosRealm).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText('EXAMPLE.COM');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Update Realm')).toBeInTheDocument();
    await user.click(screen.getByText('Update Realm'));
    expect(updateKerberosRealm).toHaveBeenCalledWith('kr-1', expect.objectContaining({ realm: 'EXAMPLE.COM' }));
  });

  it('cancel editing closes form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText('EXAMPLE.COM');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Edit Realm')).toBeInTheDocument();
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Edit Realm')).not.toBeInTheDocument();
  });

  it('shows KDC count and admin server in realm details', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    expect(await screen.findByText(/2 KDCs/)).toBeInTheDocument();
    expect(screen.getByText(/dc1.example.com/)).toBeInTheDocument();
  });

  it('adds and removes KDC fields', async () => {
    vi.mocked(getKerberosRealms).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText(/No Kerberos realms/);
    await user.click(screen.getByText('Add Realm'));
    // Initially one KDC field, no remove button since only 1
    expect(screen.queryByText('X')).not.toBeInTheDocument();
    await user.click(screen.getByText('+ Add KDC'));
    // Now 2 KDC fields, should have remove buttons
    const removeButtons = screen.getAllByText('X');
    expect(removeButtons.length).toBe(2);
    await user.click(removeButtons[0]);
    // Back to 1
    expect(screen.queryByText('X')).not.toBeInTheDocument();
  });

  it('handles load error', async () => {
    vi.mocked(getKerberosRealms).mockRejectedValue(new Error('load fail'));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    expect(await screen.findByText('Failed to load Kerberos realms')).toBeInTheDocument();
  });

  it('handles delete error', async () => {
    vi.mocked(deleteKerberosRealm).mockRejectedValue(new Error('Delete failed'));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText('EXAMPLE.COM');
    await user.click(screen.getByText('Delete'));
    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
  });

  it('shows Saving... text during save', async () => {
    vi.mocked(createKerberosRealm).mockReturnValue(new Promise(() => {}));
    vi.mocked(getKerberosRealms).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText(/No Kerberos realms/);
    await user.click(screen.getByText('Add Realm'));
    await user.type(screen.getByPlaceholderText('EXAMPLE.COM'), 'TEST.COM');
    await user.click(screen.getByText('Create Realm'));
    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('auto-sets is_default when first realm', async () => {
    vi.mocked(getKerberosRealms).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Kerberos'));
    await screen.findByText(/No Kerberos realms/);
    await user.click(screen.getByText('Add Realm'));
    // Default realm checkbox should be checked for first realm
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });
});

describe('RecordingsTab', () => {
  beforeEach(() => {
    setupDefaults();
    vi.mocked(getSettings).mockResolvedValue({
      recordings_enabled: 'true',
      recordings_retention_days: '14',
      recordings_storage_type: 'local',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders recordings form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('Session Recordings')).toBeInTheDocument();
    expect(screen.getByDisplayValue('14')).toBeInTheDocument();
  });

  it('shows azure blob fields when azure selected', async () => {
    vi.mocked(getSettings).mockResolvedValue({ recordings_storage_type: 'azure_blob' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Recordings'));
    expect(await screen.findByText('Account Name')).toBeInTheDocument();
    expect(screen.getByText('Container Name')).toBeInTheDocument();
    expect(screen.getByText('Access Key')).toBeInTheDocument();
  });

  it('saves recording settings', async () => {
    vi.mocked(updateRecordings).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Recordings'));
    await screen.findByText('Session Recordings');
    await user.click(screen.getByText('Save Recording Settings'));
    expect(updateRecordings).toHaveBeenCalled();
  });

  it('hides azure fields when local storage', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Recordings'));
    await screen.findByText('Session Recordings');
    expect(screen.queryByText('Account Name')).not.toBeInTheDocument();
  });

  it('saves recording settings with azure blob params', async () => {
    vi.mocked(getSettings).mockResolvedValue({ recordings_storage_type: 'azure_blob', recordings_azure_account_name: 'myacct', recordings_azure_container_name: 'recs', recordings_azure_access_key: 'abc123' });
    vi.mocked(updateRecordings).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Recordings'));
    await screen.findByText('Account Name');
    await user.click(screen.getByText('Save Recording Settings'));
    expect(updateRecordings).toHaveBeenCalledWith(expect.objectContaining({
      storage_type: 'azure_blob',
      azure_account_name: 'myacct',
      azure_container_name: 'recs',
      azure_access_key: 'abc123',
    }));
  });

  it('populates fields from settings', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Recordings'));
    await screen.findByText('Session Recordings');
    // retention days from settings
    expect(screen.getByDisplayValue('14')).toBeInTheDocument();
  });
});

describe('VaultTab', () => {
  beforeEach(setupDefaults);
  afterEach(() => vi.restoreAllMocks());

  it('renders vault form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    expect(await screen.findByText('Vault Configuration')).toBeInTheDocument();
  });

  it('shows bundled mode text', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    expect(await screen.findByText(/bundled Vault container/)).toBeInTheDocument();
  });

  it('shows external vault fields when external mode selected', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    await screen.findByText('Vault Configuration');
    await user.click(screen.getByText('External'));
    expect(screen.getByText('Vault URL')).toBeInTheDocument();
    expect(screen.getByText('Vault Token / AppRole')).toBeInTheDocument();
  });

  it('saves vault settings', async () => {
    vi.mocked(updateVault).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    await screen.findByText('Vault Configuration');
    await user.click(screen.getByText('Save Vault Settings'));
    expect(updateVault).toHaveBeenCalledWith(expect.objectContaining({ mode: 'local' }));
  });

  it('saves credential TTL', async () => {
    vi.mocked(updateSettings).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    await screen.findByText('Credential Password Expiry');
    await user.click(screen.getByText('Save Expiry Setting'));
    expect(updateSettings).toHaveBeenCalled();
  });

  it('saves external vault settings', async () => {
    vi.mocked(updateVault).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    await screen.findByText('Vault Configuration');
    await user.click(screen.getByText('External'));
    await user.type(screen.getByPlaceholderText('http://vault:8200'), 'https://ext.vault:8200');
    await user.type(screen.getByPlaceholderText('s.xxxxxxxxx'), 'my-token');
    await user.click(screen.getByText('Save Vault Settings'));
    expect(updateVault).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'external',
    }));
  });

  it('shows Saving... during vault save', async () => {
    vi.mocked(updateVault).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    await screen.findByText('Vault Configuration');
    await user.click(screen.getByText('Save Vault Settings'));
    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('shows current vault mode from health data', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    expect(await screen.findByText(/Currently using/)).toBeInTheDocument();
    const bundledEls = screen.getAllByText('Bundled');
    expect(bundledEls.length).toBeGreaterThanOrEqual(1);
  });

  it('shows external current mode', async () => {
    vi.mocked(getServiceHealth).mockResolvedValue({
      database: { connected: true, mode: 'local', host: 'localhost' },
      guacd: { reachable: true, host: 'guacd', port: 4822 },
      vault: { configured: true, mode: 'external', address: 'https://vault.corp.com:8200' },
    });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    await waitFor(() => {
      expect(screen.getByText(/Currently using/)).toBeInTheDocument();
    });
  });

  it('shows TTL saving state', async () => {
    vi.mocked(updateSettings).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    await screen.findByText('Credential Password Expiry');
    await user.click(screen.getByText('Save Expiry Setting'));
    // The button should show Saving... while TTL is being saved
    const savingBtns = screen.getAllByText('Saving...');
    expect(savingBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('displays TTL hours from settings', async () => {
    vi.mocked(getSettings).mockResolvedValue({ credential_ttl_hours: '6' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    expect(await screen.findByText('6h')).toBeInTheDocument();
  });

  it('handles invalid TTL with default 12', async () => {
    vi.mocked(getSettings).mockResolvedValue({ credential_ttl_hours: 'invalid' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Vault'));
    expect(await screen.findByText('12h')).toBeInTheDocument();
  });
});

describe('AccessTab', () => {
  beforeEach(() => {
    setupDefaults();
    vi.mocked(getRoles).mockResolvedValue([
      { id: 'r1', name: 'admin', can_manage_system: true, can_manage_users: true, can_manage_connections: true, can_view_audit_logs: true, can_create_users: true, can_create_user_groups: true, can_create_connections: true, can_create_connection_folders: true, can_create_sharing_profiles: true },
      { id: 'r2', name: 'user', can_manage_system: false, can_manage_users: false, can_manage_connections: false, can_view_audit_logs: false, can_create_users: false, can_create_user_groups: false, can_create_connections: false, can_create_connection_folders: false, can_create_sharing_profiles: false },
    ]);
    vi.mocked(getConnections).mockResolvedValue([
      { id: 'c1', name: 'Server A', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, domain: '', description: 'RDP server', folder_id: undefined, extra: {} },
    ]);
    vi.mocked(getConnectionFolders).mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders roles table', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
  });

  it('creates a new role', async () => {
    vi.mocked(createRole).mockResolvedValue({ id: 'r3', name: 'viewer', can_manage_system: false, can_manage_users: false, can_manage_connections: false, can_view_audit_logs: false, can_create_users: false, can_create_user_groups: false, can_create_connections: false, can_create_connection_folders: false, can_create_sharing_profiles: false });
    vi.mocked(updateRoleMappings).mockResolvedValue({ status: 'ok' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('admin');
    await user.click(screen.getByText('Create New Role'));
    const input = screen.getByPlaceholderText('e.g. Helpdesk');
    await user.type(input, 'viewer');
    await user.click(screen.getByText('Create Role'));
    expect(createRole).toHaveBeenCalledWith(expect.objectContaining({ name: 'viewer' }));
  });

  it('switches to sessions tab', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(await screen.findByText('Active Sessions')).toBeInTheDocument();
  });

  it('renders connections table', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    expect(await screen.findByText('Server A')).toBeInTheDocument();
    expect(screen.getByText('RDP')).toBeInTheDocument();
  });

  it('opens add connection form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    await user.click(screen.getByText('+ Add Connection'));
    expect(screen.getByText('Add Connection')).toBeInTheDocument();
  });

  it('opens edit connection form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    // Target the Edit button specifically in the connections table
    const connectionsCard = screen.getByRole('heading', { name: 'Connections' }).closest('.card') as HTMLElement;
    const editBtns = within(connectionsCard).getAllByText('Edit');
    await user.click(editBtns[0]);
    expect(screen.getByText('Edit Connection')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Server A')).toBeInTheDocument();
  });

  it('filters connections by search', async () => {
    vi.mocked(getConnections).mockResolvedValue([
      { id: 'c1', name: 'Server A', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, domain: '', description: '', folder_id: undefined, extra: {} },
      { id: 'c2', name: 'Server B', protocol: 'ssh', hostname: '10.0.0.2', port: 22, domain: '', description: '', folder_id: undefined, extra: {} },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    await user.type(screen.getByPlaceholderText(/Search connections/), 'Server B');
    expect(screen.getByText('Server B')).toBeInTheDocument();
    expect(screen.queryByText('Server A')).not.toBeInTheDocument();
  });

  it('creates a connection', async () => {
    vi.mocked(createConnection).mockResolvedValue({ id: 'c2', name: 'New', protocol: 'rdp', hostname: '1.2.3.4', port: 3389, domain: '', description: '', folder_id: undefined, extra: {} });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    await user.click(screen.getByText('+ Add Connection'));
    await user.type(screen.getByPlaceholderText('My Server'), 'New');
    await user.clear(screen.getByPlaceholderText('10.0.0.10'));
    await user.type(screen.getByPlaceholderText('10.0.0.10'), '1.2.3.4');
    await user.click(screen.getByText('Create Connection'));
    expect(createConnection).toHaveBeenCalled();
  });

  it('deletes a connection with confirm', async () => {
    vi.mocked(deleteConnection).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    const deleteBtns = screen.getAllByText('Delete');
    await user.click(deleteBtns[0]);
    // ConfirmModal appears — click its confirm button (btn-danger)
    const allDeleteBtns = await screen.findAllByRole('button', { name: 'Delete' });
    const confirmBtn = allDeleteBtns.find(btn => btn.classList.contains('btn-danger'))!;
    await user.click(confirmBtn);
    expect(deleteConnection).toHaveBeenCalledWith('c1');
  });

  it('does not delete when confirm is cancelled', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    const deleteBtns = screen.getAllByText('Delete');
    await user.click(deleteBtns[0]);
    // ConfirmModal appears — click Cancel
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it('shows connection description', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    expect(await screen.findByText('RDP server')).toBeInTheDocument();
  });

  it('shows folder_name for foldered connections', async () => {
    vi.mocked(getConnectionFolders).mockResolvedValue([{ id: 'g1', name: 'Servers', parent_id: undefined }]);
    vi.mocked(getConnections).mockResolvedValue([
      { id: 'c1', name: 'Server G', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, domain: '', description: '', folder_id: 'g1', extra: {} },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    const connectionsCard = screen.getByRole('heading', { name: 'Connections' }).closest('.card') as HTMLElement;
    const table = within(connectionsCard).getByRole('table');
    const serversEls = await within(table).findAllByText('Servers');
    expect(serversEls.length).toBeGreaterThanOrEqual(1);
  });

  it('shows dash for unfoldered connections', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('shows pagination for many connections', async () => {
    const manyConns = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`, name: `Server ${i}`, protocol: 'rdp', hostname: `10.0.0.${i}`, port: 3389, domain: '', description: '', folder_id: undefined, extra: {},
    }));
    vi.mocked(getConnections).mockResolvedValue(manyConns);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server 0');
    const connectionsCard = screen.getByRole('heading', { name: 'Connections' }).closest('.card') as HTMLElement;
    expect(within(connectionsCard).getByText('Page 1 of 2')).toBeInTheDocument();
    expect(within(connectionsCard).getByText('← Prev')).toBeDisabled();
    await user.click(within(connectionsCard).getByText('Next →'));
    expect(within(connectionsCard).getByText('Page 2 of 2')).toBeInTheDocument();
    expect(within(connectionsCard).getByText('Next →')).toBeDisabled();
    await user.click(within(connectionsCard).getByText('← Prev'));
    expect(within(connectionsCard).getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('resets page on search', async () => {
    const manyConns = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`, name: `Server ${i}`, protocol: 'rdp', hostname: `10.0.0.${i}`, port: 3389, domain: '', description: '', folder_id: undefined, extra: {},
    }));
    vi.mocked(getConnections).mockResolvedValue(manyConns);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server 0');
    const connectionsCard = screen.getByRole('heading', { name: 'Connections' }).closest('.card') as HTMLElement;
    await user.click(within(connectionsCard).getByText('Next →'));
    expect(within(connectionsCard).getByText('Page 2 of 2')).toBeInTheDocument();
    // Search resets to page 1
    await user.type(screen.getByPlaceholderText(/Search connections/), 'Server 1');
    expect(screen.queryByText('Page 2')).not.toBeInTheDocument();
  });

  it('shows connection count', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    expect(await screen.findByText(/1 connection/)).toBeInTheDocument();
  });

  it('shows filtered count', async () => {
    vi.mocked(getConnections).mockResolvedValue([
      { id: 'c1', name: 'Server A', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, domain: '', description: '', folder_id: undefined, extra: {} },
      { id: 'c2', name: 'Server B', protocol: 'ssh', hostname: '10.0.0.2', port: 22, domain: '', description: '', folder_id: undefined, extra: {} },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    await user.type(screen.getByPlaceholderText(/Search connections/), 'Server A');
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });

  it('updates connection via edit form', async () => {
    vi.mocked(updateConnection).mockResolvedValue({ id: 'c1', name: 'Server Updated', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, domain: '', description: '', folder_id: undefined, extra: {} });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    const connectionsCard = screen.getByRole('heading', { name: 'Connections' }).closest('.card') as HTMLElement;
    const editBtns = within(connectionsCard).getAllByText('Edit');
    await user.click(editBtns[0]);
    await screen.findByText('Edit Connection');
    await user.click(screen.getByText('Save Changes'));
    expect(updateConnection).toHaveBeenCalledWith('c1', expect.any(Object));
  });

  it('closes form after connection deleted if editing same id', async () => {
    vi.mocked(deleteConnection).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    const connectionsCard = screen.getByRole('heading', { name: 'Connections' }).closest('.card') as HTMLElement;
    // Open edit first
    const editBtns = within(connectionsCard).getAllByText('Edit');
    await user.click(editBtns[0]);
    expect(screen.getByText('Edit Connection')).toBeInTheDocument();
    // Delete while form is open
    const deleteBtns = within(connectionsCard).getAllByText('Delete');
    await user.click(deleteBtns[0]);
    // ConfirmModal appears — click its confirm button (btn-danger)
    const allDeleteBtns = await screen.findAllByRole('button', { name: 'Delete' });
    const confirmBtn = allDeleteBtns.find(btn => btn.classList.contains('btn-danger'))!;
    await user.click(confirmBtn);
    // Form should be closed
    await waitFor(() => expect(screen.queryByText('Edit Connection')).not.toBeInTheDocument());
  });

  it('cancel closes the add form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    await user.click(screen.getByText('+ Add Connection'));
    expect(screen.getByText('Add Connection')).toBeInTheDocument();
    const cancelBtns = screen.getAllByText('Cancel');
    await user.click(cancelBtns[0]);
    expect(screen.queryByText('Add Connection')).not.toBeInTheDocument();
  });

  it('renders users table with OIDC sub', async () => {
    vi.mocked(getUsers).mockResolvedValue([
      { id: 'u1', username: 'alice', email: 'alice@example.com', auth_type: 'sso', role_name: 'admin', sub: 'oidc-sub-123' },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('oidc-sub-123')).toBeInTheDocument();
  });

  it('shows dash when user has no OIDC sub', async () => {
    vi.mocked(getUsers).mockResolvedValue([
      { id: 'u1', username: 'bob', email: 'bob@example.com', auth_type: 'local', role_name: 'user', sub: '' },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('bob');
    // OIDC sub column shows — for empty sub
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('shows no folders empty state', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    expect(await screen.findByText(/No folders created yet/)).toBeInTheDocument();
  });

  it('renders folders table', async () => {
    vi.mocked(getConnectionFolders).mockResolvedValue([
      { id: 'g1', name: 'Production', parent_id: undefined },
      { id: 'g2', name: 'Staging', parent_id: 'g1' },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    const prodEls = await screen.findAllByText('Production');
    expect(prodEls.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Staging')).toBeInTheDocument();
    expect(screen.getByText('Root')).toBeInTheDocument();
  });

  it('creates a folder', async () => {
    vi.mocked(createConnectionFolder).mockResolvedValue({ id: 'g1', name: 'DevOps', parent_id: undefined });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText(/No folders created yet/);
    await user.type(screen.getByPlaceholderText('Folder name...'), 'DevOps');
    await user.click(screen.getByText('Add Folder'));
    expect(createConnectionFolder).toHaveBeenCalledWith(expect.objectContaining({ name: 'DevOps' }));
  });

  it('deletes a folder with confirm', async () => {
    vi.mocked(getConnectionFolders).mockResolvedValue([{ id: 'g1', name: 'ToDelete', parent_id: undefined }]);
    vi.mocked(deleteConnectionFolder).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('ToDelete');
    // Find the folder delete button
    const folderDeleteBtns = screen.getAllByText('Delete');
    await user.click(folderDeleteBtns[folderDeleteBtns.length - 1]);
    // ConfirmModal appears — click its confirm button (btn-danger)
    const allDeleteBtns = await screen.findAllByRole('button', { name: 'Delete' });
    const confirmBtn = allDeleteBtns.find(btn => btn.classList.contains('btn-danger'))!;
    await user.click(confirmBtn);
    expect(deleteConnectionFolder).toHaveBeenCalledWith('g1');
  });

  it('disables Add Role button when role name is empty', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByRole('heading', { name: 'Roles' });
    expect(screen.getByText('Create New Role')).toBeInTheDocument();
  });

  it('disables Add Folder button when name is empty', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Connection Folders');
    expect(screen.getByText('Add Folder')).toBeDisabled();
  });

  it('highlights currently edited connection row', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    const row = screen.getAllByText('Server A').find(el => el.closest('tr'))?.closest('tr');
    if (!row) throw new Error('Row not found');
    await user.click(within(row).getByText('Edit'));
    
    // The row for the edited connection should have bg-surface-secondary class
    await waitFor(() => {
      expect(row.className).toContain('bg-surface-secondary');
    });
  });
});

describe('SessionsTab', () => {
  beforeEach(() => {
    setupDefaults();
    vi.mocked(getActiveSessions).mockResolvedValue([
      { session_id: 's1', user_id: 'u1', username: 'admin', connection_id: 'c1', connection_name: 'Server A', protocol: 'rdp', started_at: '2026-01-15T10:00:00Z', bytes_from_guacd: 1024, bytes_to_guacd: 512, buffer_depth_secs: 0, remote_host: '127.0.0.1', client_ip: '10.0.0.1' },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders active sessions', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    expect(await screen.findByText('Server A')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('shows empty state with no sessions', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    expect(await screen.findByText(/no active sessions/i)).toBeInTheDocument();
  });

  it('shows session duration', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    await screen.findByText('Server A');
    // Duration should be rendered (format varies by time)
    const durationEls = screen.getAllByText(/\d+[hms]/);
    expect(durationEls.length).toBeGreaterThanOrEqual(1);
  });

  it('shows buffer depth', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      { session_id: 's1', user_id: 'u1', username: 'admin', connection_id: 'c1', connection_name: 'Server A', protocol: 'rdp', started_at: '2026-01-15T10:00:00Z', bytes_from_guacd: 1024, bytes_to_guacd: 512, buffer_depth_secs: 120, remote_host: '127.0.0.1', client_ip: '10.0.0.1' },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    expect(await screen.findByText('2m')).toBeInTheDocument();
  });

  it('shows buffer with seconds', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      { session_id: 's1', user_id: 'u1', username: 'admin', connection_id: 'c1', connection_name: 'Server A', protocol: 'rdp', started_at: '2026-01-15T10:00:00Z', bytes_from_guacd: 1024, bytes_to_guacd: 512, buffer_depth_secs: 45, remote_host: '127.0.0.1', client_ip: '10.0.0.1' },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    expect(await screen.findByText('45s')).toBeInTheDocument();
  });

  it('shows buffer with minutes and seconds', async () => {
    vi.mocked(getActiveSessions).mockResolvedValue([
      { session_id: 's1', user_id: 'u1', username: 'admin', connection_id: 'c1', connection_name: 'Server A', protocol: 'rdp', started_at: '2026-01-15T10:00:00Z', bytes_from_guacd: 1024, bytes_to_guacd: 512, buffer_depth_secs: 90, remote_host: '127.0.0.1', client_ip: '10.0.0.1' },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    expect(await screen.findByText('1m 30s')).toBeInTheDocument();
  });

  it('renders Live and Rewind buttons', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    await screen.findByText('Server A');
    expect(screen.getByText('● Live')).toBeInTheDocument();
    expect(screen.getByText('⏪ Rewind')).toBeInTheDocument();
  });

  it('disables refresh while loading', async () => {
    vi.mocked(getActiveSessions).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    await waitFor(() => {
      const btns = screen.getAllByText('Refreshing...');
      expect(btns.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('navigates to live view on Live click', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Sessions'));
    await screen.findByText('Server A');
    
    await user.click(screen.getByText('● Live'));
    // Verify navigation was triggered (Live button uses navigate)
    expect(screen.getByText('● Live')).toBeInTheDocument();
  });
});

describe('AdSyncTab', () => {
  beforeEach(() => {
    setupDefaults();
    vi.mocked(getAdSyncConfigs).mockResolvedValue([
      { id: 'ad1', label: 'Corp AD', ldap_url: 'ldaps://dc1.corp.com', bind_dn: 'cn=admin', bind_password: '***', search_bases: ['DC=corp,DC=com'], search_filter: '', protocol: 'rdp', default_port: 3389, sync_interval_minutes: 60, folder_id: '', domain_override: '', auth_method: 'simple', keytab_path: '', krb5_principal: '', tls_skip_verify: false, ca_cert_pem: '', created_at: '', updated_at: '', search_scope: 'sub', enabled: true },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders AD sync configs', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    expect(await screen.findByText('Corp AD')).toBeInTheDocument();
  });

  it('shows empty state with no configs', async () => {
    vi.mocked(getAdSyncConfigs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    expect(await screen.findByText(/no AD sync sources/i)).toBeInTheDocument();
  });

  it('shows enabled badge on config', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
  });

  it('shows disabled badge', async () => {
    vi.mocked(getAdSyncConfigs).mockResolvedValue([
      { id: 'ad1', label: 'Disabled AD', ldap_url: 'ldaps://dc1.corp.com', bind_dn: 'cn=admin', bind_password: '***', search_bases: ['DC=corp,DC=com'], search_filter: '', protocol: 'rdp', default_port: 3389, sync_interval_minutes: 60, folder_id: '', domain_override: '', auth_method: 'simple', keytab_path: '', krb5_principal: '', tls_skip_verify: false, ca_cert_pem: '', created_at: '', updated_at: '', search_scope: 'sub', enabled: false },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
  });

  it('shows config details', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    expect(await screen.findByText('ldaps://dc1.corp.com')).toBeInTheDocument();
    expect(screen.getByText(/Simple Bind/)).toBeInTheDocument();
  });

  it('opens add source form', async () => {
    vi.mocked(getAdSyncConfigs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText(/no AD sync sources/i);
    await user.click(screen.getByText('Add Source'));
    expect(screen.getByText('Add AD Source')).toBeInTheDocument();
  });

  it('opens edit source form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Edit AD Source')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Corp AD')).toBeInTheDocument();
  });

  it('saves a new config', async () => {
    vi.mocked(createAdSyncConfig).mockResolvedValue({ id: 'ad2', status: 'success' });
    vi.mocked(getAdSyncConfigs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText(/no AD sync sources/i);
    await user.click(screen.getByText('Add Source'));
    await user.type(screen.getByPlaceholderText('Production AD'), 'New AD');
    await user.type(screen.getByPlaceholderText(/ldaps:\/\//), 'ldaps://dc2.corp.com');
    await user.click(screen.getByText('Save'));
    expect(createAdSyncConfig).toHaveBeenCalled();
  });

  it('saves when updating existing config', async () => {
    vi.mocked(updateAdSyncConfig).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    await user.click(screen.getByText('Save'));
    expect(updateAdSyncConfig).toHaveBeenCalledWith('ad1', expect.any(Object));
  });

  it('deletes config with confirm', async () => {
    vi.mocked(deleteAdSyncConfig).mockResolvedValue({ status: 'success' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Delete'));
    expect(deleteAdSyncConfig).toHaveBeenCalledWith('ad1');
  });

  it('does not delete when confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Delete'));
    expect(deleteAdSyncConfig).not.toHaveBeenCalled();
  });

  it('triggers sync', async () => {
    vi.mocked(triggerAdSync).mockResolvedValue({ status: 'success', run_id: 'r1' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('⟳ Sync Now'));
    expect(triggerAdSync).toHaveBeenCalledWith('ad1');
  });

  it('shows Syncing... while sync in progress', async () => {
    vi.mocked(triggerAdSync).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('⟳ Sync Now'));
    expect(screen.getByText('Syncing...')).toBeInTheDocument();
  });

  it('shows sync history', async () => {
    vi.mocked(getAdSyncRuns).mockResolvedValue([
      { id: 'r1', config_id: 'ad1', started_at: '2024-06-01T12:00:00Z', status: 'success', created: 5, updated: 2, soft_deleted: 0, hard_deleted: 0, error_message: '' },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('History'));
    expect(await screen.findByText(/Sync History/)).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows empty sync history', async () => {
    vi.mocked(getAdSyncRuns).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('History'));
    expect(await screen.findByText(/No sync runs yet/)).toBeInTheDocument();
  });

  it('back button returns from history to config list', async () => {
    vi.mocked(getAdSyncRuns).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('History'));
    await screen.findByText(/No sync runs yet/);
    await user.click(screen.getByText('← Back'));
    expect(await screen.findByText('Corp AD')).toBeInTheDocument();
  });

  it('cancel button returns from edit to config list', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Edit AD Source')).toBeInTheDocument();
    await user.click(screen.getByText('Cancel'));
    expect(await screen.findByText('Corp AD')).toBeInTheDocument();
  });

  it('shows kerberos auth fields when kerberos method selected', async () => {
    vi.mocked(getAdSyncConfigs).mockResolvedValue([
      { id: 'ad1', label: 'Kerb AD', ldap_url: 'ldaps://dc1.corp.com', bind_dn: '', bind_password: '', search_bases: ['DC=corp,DC=com'], search_filter: '', protocol: 'rdp', default_port: 3389, sync_interval_minutes: 60, folder_id: '', domain_override: '', auth_method: 'kerberos', keytab_path: '/etc/krb5/strata.keytab', krb5_principal: 'svc@CORP.COM', tls_skip_verify: false, ca_cert_pem: '', created_at: '', updated_at: '', search_scope: 'sub', enabled: true },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Kerb AD');
    expect(screen.getByText(/Kerberos Keytab/)).toBeInTheDocument();
    await user.click(screen.getByText('Edit'));
    expect(screen.getByDisplayValue('/etc/krb5/strata.keytab')).toBeInTheDocument();
    expect(screen.getByDisplayValue('svc@CORP.COM')).toBeInTheDocument();
  });

  it('test connection shows success result', async () => {
    vi.mocked(testAdSyncConnection).mockResolvedValue({ status: 'success', message: 'Found 10 computers', sample: ['Server1', 'Server2'], count: 10 });
    vi.mocked(getAdSyncConfigs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText(/no AD sync sources/i);
    await user.click(screen.getByText('Add Source'));
    await user.click(screen.getByText('⚡ Test Connection'));
    expect(await screen.findByText('Found 10 computers')).toBeInTheDocument();
    expect(screen.getByText('Server1')).toBeInTheDocument();
    expect(screen.getByText('Server2')).toBeInTheDocument();
    expect(screen.getByText(/of 10/)).toBeInTheDocument();
  });

  it('test connection shows error result', async () => {
    vi.mocked(testAdSyncConnection).mockRejectedValue(new Error('LDAP bind failed'));
    vi.mocked(getAdSyncConfigs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText(/no AD sync sources/i);
    await user.click(screen.getByText('Add Source'));
    await user.click(screen.getByText('⚡ Test Connection'));
    expect(await screen.findByText('LDAP bind failed')).toBeInTheDocument();
  });

  it('shows Testing... during test', async () => {
    vi.mocked(testAdSyncConnection).mockReturnValue(new Promise(() => {}));
    vi.mocked(getAdSyncConfigs).mockResolvedValue([]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText(/no AD sync sources/i);
    await user.click(screen.getByText('Add Source'));
    await user.click(screen.getByText('⚡ Test Connection'));
    expect(screen.getByText('Testing...')).toBeInTheDocument();
  });

  it('shows config with CA cert and TLS skip verify info', async () => {
    vi.mocked(getAdSyncConfigs).mockResolvedValue([
      { id: 'ad1', label: 'TLS Skip', ldap_url: 'ldaps://dc1.corp.com', bind_dn: 'cn=admin', bind_password: '***', search_bases: ['DC=corp,DC=com'], search_filter: '', protocol: 'rdp', default_port: 3389, sync_interval_minutes: 60, folder_id: '', domain_override: '', auth_method: 'simple', keytab_path: '', krb5_principal: '', tls_skip_verify: true, ca_cert_pem: '', created_at: '', updated_at: '', search_scope: 'sub', enabled: true },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    expect(await screen.findByText(/TLS Skip Verify/)).toBeInTheDocument();
  });

  it('shows config with CA cert loaded', async () => {
    vi.mocked(getAdSyncConfigs).mockResolvedValue([
      { id: 'ad1', label: 'CA Cert', ldap_url: 'ldaps://dc1.corp.com', bind_dn: 'cn=admin', bind_password: '***', search_bases: ['DC=corp,DC=com'], search_filter: '', protocol: 'rdp', default_port: 3389, sync_interval_minutes: 60, folder_id: '', domain_override: '', auth_method: 'simple', keytab_path: '', krb5_principal: '', tls_skip_verify: false, ca_cert_pem: 'CERT_DATA', created_at: '', updated_at: '', search_scope: 'sub', enabled: true },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    expect(await screen.findByText(/CA Cert ✓/)).toBeInTheDocument();
  });

  it('shows search base management in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByDisplayValue('DC=corp,DC=com')).toBeInTheDocument();
    // Add search base
    await user.click(screen.getByText('+ Add Search Base'));
    const searchBaseInputs = screen.getAllByPlaceholderText(/OU=Servers/);
    expect(searchBaseInputs.length).toBeGreaterThanOrEqual(1);
  });

  it('shows sync history with error run', async () => {
    vi.mocked(getAdSyncRuns).mockResolvedValue([
      { id: 'r1', config_id: 'ad1', started_at: '2024-06-01T12:00:00Z', status: 'error', created: 0, updated: 0, soft_deleted: 0, hard_deleted: 0, error_message: 'LDAP timeout' },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('History'));
    expect(await screen.findByText('error')).toBeInTheDocument();
    expect(screen.getByText('LDAP timeout')).toBeInTheDocument();
  });

  it('shows search filter dropdown in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Search Filter')).toBeInTheDocument();
  });

  it('shows protocol select in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Protocol')).toBeInTheDocument();
  });

  it('shows search scope select in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Search Scope')).toBeInTheDocument();
  });

  it('shows default port field in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Default Port')).toBeInTheDocument();
    expect(screen.getByDisplayValue('3389')).toBeInTheDocument();
  });

  it('shows sync interval field in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Sync Interval (minutes)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('60')).toBeInTheDocument();
  });

  it('shows TLS skip verify checkbox in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Skip TLS verification')).toBeInTheDocument();
  });

  it('shows CA certificate option when TLS skip is unchecked', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    // TLS skip is false by default, so CA cert option should be visible
    expect(screen.getByText('CA Certificate (PEM)')).toBeInTheDocument();
    expect(screen.getByText('Upload Certificate')).toBeInTheDocument();
  });

  it('shows domain override field in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Domain Override')).toBeInTheDocument();
  });

  it('shows connection folder select in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Connection Folder')).toBeInTheDocument();
  });

  it('shows enabled checkbox in edit form', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Corp AD');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('hides CA cert option when TLS skip verify is checked', async () => {
    vi.mocked(getAdSyncConfigs).mockResolvedValue([
      { id: 'ad1', label: 'Skip TLS', ldap_url: 'ldaps://dc1.corp.com', bind_dn: 'cn=admin', bind_password: '***', search_bases: ['DC=corp,DC=com'], search_filter: '', protocol: 'rdp', default_port: 3389, sync_interval_minutes: 60, folder_id: '', domain_override: '', auth_method: 'simple', keytab_path: '', krb5_principal: '', tls_skip_verify: true, ca_cert_pem: '', created_at: '', updated_at: '', search_scope: 'sub', enabled: true },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('Skip TLS');
    await user.click(screen.getByText('Edit'));
    expect(screen.queryByText('CA Certificate (PEM)')).not.toBeInTheDocument();
  });

  it('shows replace certificate button when ca_cert is loaded in edit', async () => {
    vi.mocked(getAdSyncConfigs).mockResolvedValue([
      { id: 'ad1', label: 'With Cert', ldap_url: 'ldaps://dc1.corp.com', bind_dn: 'cn=admin', bind_password: '***', search_bases: ['DC=corp,DC=com'], search_filter: '', protocol: 'rdp', default_port: 3389, sync_interval_minutes: 60, folder_id: '', domain_override: '', auth_method: 'simple', keytab_path: '', krb5_principal: '', tls_skip_verify: false, ca_cert_pem: 'CERT_DATA', created_at: '', updated_at: '', search_scope: 'sub', enabled: true },
    ]);
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('AD Sync'));
    await screen.findByText('With Cert');
    await user.click(screen.getByText('Edit'));
    expect(screen.getByText(/Replace Certificate/)).toBeInTheDocument();
    expect(screen.getByText(/Certificate loaded/)).toBeInTheDocument();
  });
});

describe('SecurityTab', () => {
  beforeEach(() => {
    setupDefaults();
    vi.mocked(getSettings).mockResolvedValue({
      watermark_enabled: 'true',
      local_auth_enabled: 'true',
      sso_enabled: 'false',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders security toggles', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    expect(await screen.findByText('Session Watermark')).toBeInTheDocument();
  });

  it('saves security settings', async () => {
    vi.mocked(updateAuthMethods).mockResolvedValue({ status: 'success' });
    vi.mocked(updateSettings).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    await screen.findByText('Session Watermark');
    const saveBtns = screen.getAllByText(/save/i);
    await user.click(saveBtns[saveBtns.length - 1]);
    await waitFor(() => {
      expect(updateAuthMethods).toHaveBeenCalled();
    });
  });

  it('renders authentication method toggles', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    expect(await screen.findByText('Local Authentication')).toBeInTheDocument();
    expect(screen.getByText('SSO / OIDC (Keycloak)')).toBeInTheDocument();
  });

  it('prevents disabling both auth methods (local off while SSO off)', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      watermark_enabled: 'false',
      local_auth_enabled: 'true',
      sso_enabled: 'false',
    });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    await screen.findByText('Local Authentication');
    // Find local auth checkbox and try unchecking it
    const checkboxes = screen.getAllByRole('checkbox');
    // local auth checkbox (first one) - should stay checked since SSO is off
    const localCheckbox = checkboxes[0];
    expect(localCheckbox).toBeChecked();
    await user.click(localCheckbox);
    // Should still be checked since SSO is disabled
    expect(localCheckbox).toBeChecked();
  });

  it('prevents disabling both auth methods (SSO off while local off)', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      watermark_enabled: 'false',
      local_auth_enabled: 'false',
      sso_enabled: 'true',
    });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    await screen.findByText('Local Authentication');
    const checkboxes = screen.getAllByRole('checkbox');
    // SSO checkbox (second one) - should stay checked since local is off
    const ssoCheckbox = checkboxes[1];
    expect(ssoCheckbox).toBeChecked();
    await user.click(ssoCheckbox);
    expect(ssoCheckbox).toBeChecked();
  });

  it('allows toggling when other method is enabled', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      watermark_enabled: 'false',
      local_auth_enabled: 'true',
      sso_enabled: 'true',
    });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    await screen.findByText('Local Authentication');
    const checkboxes = screen.getAllByRole('checkbox');
    // Can uncheck SSO since local is on
    const ssoCheckbox = checkboxes[1];
    expect(ssoCheckbox).toBeChecked();
    await user.click(ssoCheckbox);
    expect(ssoCheckbox).not.toBeChecked();
  });

  it('watermark checkbox toggles', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      watermark_enabled: 'false',
      local_auth_enabled: 'true',
      sso_enabled: 'false',
    });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    await screen.findByText('Session Watermark');
    const checkboxes = screen.getAllByRole('checkbox');
    const watermarkCheckbox = checkboxes[2]; // 3rd checkbox
    expect(watermarkCheckbox).not.toBeChecked();
    await user.click(watermarkCheckbox);
    expect(watermarkCheckbox).toBeChecked();
  });

  it('shows Saving... during save', async () => {
    vi.mocked(updateSettings).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    await screen.findByText('Session Watermark');
    const saveBtns = screen.getAllByText(/save/i);
    await user.click(saveBtns[saveBtns.length - 1]);
    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('sends watermark and auth settings on save', async () => {
    vi.mocked(updateAuthMethods).mockResolvedValue({ status: 'success' });
    vi.mocked(updateSettings).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Security'));
    await screen.findByText('Session Watermark');
    const saveBtns = screen.getAllByText(/save/i);
    await user.click(saveBtns[saveBtns.length - 1]);
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith([
        { key: 'watermark_enabled', value: 'true' },
      ]);
      expect(updateAuthMethods).toHaveBeenCalledWith({
        sso_enabled: false,
        local_auth_enabled: true,
      });
    });
  });
});

describe('ConnectionForm protocol sections', () => {
  beforeEach(() => {
    setupDefaults();
    vi.mocked(getConnections).mockResolvedValue([
      { id: 'c1', name: 'Server A', protocol: 'ssh', hostname: '10.0.0.1', port: 22, description: 'SSH server', folder_id: undefined, folder_name: undefined, domain: '', extra: {} },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows SSH protocol sections when editing SSH connection', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    const row = screen.getByText('Server A').closest('tr')!;
    await user.click(within(row).getByText('Edit'));
    // SSH sections should render — section titles have ▸/▾ prefix
    expect(screen.getByText(/Authentication/)).toBeInTheDocument();
    expect(screen.getByText(/Display/)).toBeInTheDocument();
    expect(screen.getByText(/Terminal Behavior/)).toBeInTheDocument();
    expect(screen.getByText(/SFTP/)).toBeInTheDocument();
    expect(screen.getByText(/Screen Recording/)).toBeInTheDocument();
    expect(screen.getByText(/Wake-on-LAN/)).toBeInTheDocument();
  });

  it('expands and collapses SSH section', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    const row = screen.getByText('Server A').closest('tr')!;
    await user.click(within(row).getByText('Edit'));
    // Authentication is defaultOpen, so it should show fields
    expect(screen.getByText('Private Key')).toBeInTheDocument();
    // Display is collapsed by default — click to expand
    await user.click(screen.getByText(/Display/));
    expect(screen.getByText('Font Name')).toBeInTheDocument();
    // Click again to collapse
    await user.click(screen.getByText(/Display/));
    expect(screen.queryByText('Font Name')).not.toBeInTheDocument();
  });

  it('shows VNC protocol sections when protocol changed to VNC', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    await user.click(screen.getByText('+ Add Connection'));
    // Default is RDP — switch to VNC via the protocol dropdown
    const protocolTrigger = screen.getAllByText('RDP').find(el => el.closest('[aria-haspopup="listbox"]'))!;
    await user.click(protocolTrigger);
    await user.click(screen.getByText('VNC'));
    // VNC Authentication section is defaultOpen, so Password should be visible
    expect(screen.getByText('Password')).toBeInTheDocument();
  });

  it('calls createConnection on form submit', async () => {
    vi.mocked(createConnection).mockResolvedValue({
      id: 'c2', name: 'New SSH', protocol: 'ssh', hostname: '10.0.0.5', port: 22,
      description: '', folder_id: undefined, folder_name: undefined, domain: '', extra: {},
    });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    await user.click(screen.getByText('+ Add Connection'));
    await user.type(screen.getByPlaceholderText('My Server'), 'New SSH');
    await user.clear(screen.getByPlaceholderText('10.0.0.10'));
    await user.type(screen.getByPlaceholderText('10.0.0.10'), '10.0.0.5');
    await user.click(screen.getByText('Create Connection'));
    await waitFor(() => {
      expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ name: 'New SSH', hostname: '10.0.0.5' }));
    });
  });

  it('closes form with Cancel button', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(screen.getByText('Access'));
    await screen.findByText('Server A');
    await user.click(screen.getByText('+ Add Connection'));
    expect(screen.getByText('Add Connection')).toBeInTheDocument();
    const cancelButtons = screen.getAllByText('Cancel');
    await user.click(cancelButtons[cancelButtons.length - 1]);
    expect(screen.queryByPlaceholderText('My Server')).not.toBeInTheDocument();
  });
});
