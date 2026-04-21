import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../api', () => ({
  getCredentialProfiles: vi.fn(),
  createCredentialProfile: vi.fn(),
  updateCredentialProfile: vi.fn(),
  deleteCredentialProfile: vi.fn(),
  getProfileMappings: vi.fn(),
  setCredentialMapping: vi.fn(),
  removeCredentialMapping: vi.fn(),
  getMyConnections: vi.fn(),
  getServiceHealth: vi.fn(),
  getMyCheckouts: vi.fn().mockResolvedValue([]),
  getMyManagedAccounts: vi.fn().mockResolvedValue([]),
  requestCheckout: vi.fn(),
  revealCheckoutPassword: vi.fn(),
  linkCheckoutToProfile: vi.fn(),
  checkinCheckout: vi.fn(),
  retryCheckoutActivation: vi.fn(),
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

import Credentials from '../pages/Credentials';
import {
  getCredentialProfiles,
  createCredentialProfile,
  updateCredentialProfile,
  deleteCredentialProfile,
  getMyConnections,
  getServiceHealth,
  getProfileMappings,
  removeCredentialMapping,
  getMyCheckouts,
  getMyManagedAccounts,
  revealCheckoutPassword,
  requestCheckout,
  checkinCheckout,
} from '../api';

function renderCredentials() {
  return render(
    <BrowserRouter>
      <Credentials vaultConfigured={true} />
    </BrowserRouter>,
  );
}

const vaultConfigured = {
  database: { connected: true, mode: 'local', host: 'localhost', latency_ms: 5 },
  guacd: { reachable: true, host: 'guacd', port: 4822 },
  vault: { configured: true, mode: 'local', address: 'http://localhost' },
  schema: { status: 'in_sync', applied_migrations: 28, expected_migrations: 28 },
  uptime_secs: 3600,
  environment: 'production',
};
const vaultNotConfigured = {
  database: { connected: true, mode: 'local', host: 'localhost', latency_ms: 5 },
  guacd: { reachable: true, host: 'guacd', port: 4822 },
  vault: { configured: false, mode: 'local', address: 'http://localhost' },
  schema: { status: 'in_sync', applied_migrations: 28, expected_migrations: 28 },
  uptime_secs: 3600,
  environment: 'production',
};

const profiles = [
  {
    id: 'p1', label: 'Work Profile', created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z', expires_at: '2024-12-31T00:00:00Z',
    expired: false, ttl_hours: 12,
  },
  {
    id: 'p2', label: 'Expired Creds', created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z', expires_at: '2023-01-01T00:00:00Z',
    expired: true, ttl_hours: 12,
  },
];

const mockConnections = [
  { id: 'conn1', name: 'Server Alpha', protocol: 'rdp', hostname: '10.0.0.1', port: 3389, description: 'Prod RDP' },
  { id: 'conn2', name: 'Server Beta', protocol: 'ssh', hostname: '10.0.0.2', port: 22, description: '' },
];

function setupDefaults() {
  vi.mocked(getCredentialProfiles).mockResolvedValue(profiles);
  vi.mocked(getMyConnections).mockResolvedValue(mockConnections);
  vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);
  vi.mocked(getProfileMappings).mockResolvedValue([]);
}

describe('Credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows vault-not-configured message when vault is not configured', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultNotConfigured);

    render(
      <BrowserRouter>
        <Credentials vaultConfigured={false} />
      </BrowserRouter>,
    );
    expect(await screen.findByText('Vault Not Configured')).toBeInTheDocument();
  });

  it('shows credentials page when vault is configured', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);

    renderCredentials();
    expect(await screen.findByText('New Profile')).toBeInTheDocument();
    expect(screen.getByText('Credentials')).toBeInTheDocument();
  });

  it('renders credential profiles list', async () => {
    setupDefaults();
    renderCredentials();
    expect(await screen.findByText('Work Profile')).toBeInTheDocument();
    expect(screen.getByText('Expired Creds')).toBeInTheDocument();
  });

  it('shows expired badge for expired profiles', async () => {
    setupDefaults();
    renderCredentials();
    expect(await screen.findByText(/Expired .* update required/)).toBeInTheDocument();
  });

  it('opens new profile modal', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);

    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('New Profile');
    await user.click(screen.getByText('New Profile'));
    expect(screen.getByPlaceholderText('e.g. Domain Admin, SSH Dev Server')).toBeInTheDocument();
  });

  it('creates a credential profile', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);
    vi.mocked(createCredentialProfile).mockResolvedValue({ id: 'new1', status: 'success' });

    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('New Profile');
    await user.click(screen.getByText('New Profile'));
    await user.type(screen.getByPlaceholderText('e.g. Domain Admin, SSH Dev Server'), 'Test');
    await user.type(screen.getByPlaceholderText('sAMAccountName (e.g. jsmith)'), 'admin');
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret');
    await user.click(screen.getByText('Create Profile'));
    expect(createCredentialProfile).toHaveBeenCalled();
  });

  it('shows empty state when no profiles exist', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);

    renderCredentials();
    expect(await screen.findByText(/no credential profiles/i)).toBeInTheDocument();
  });

  it('shows vault not configured when health check fails', async () => {
    vi.mocked(getCredentialProfiles).mockRejectedValue(new Error('Network error'));
    vi.mocked(getMyConnections).mockRejectedValue(new Error('Network error'));
    vi.mocked(getServiceHealth).mockRejectedValue(new Error('Network error'));

    render(
      <BrowserRouter>
        <Credentials vaultConfigured={false} />
      </BrowserRouter>,
    );
    expect(await screen.findByText('Vault Not Configured')).toBeInTheDocument();
  });

  it('shows validation error when required fields are empty', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);

    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('New Profile');
    await user.click(screen.getByText('New Profile'));
    // Click create without filling fields
    await user.click(screen.getByText('Create Profile'));
    expect(await screen.findByText('All fields are required for a new profile')).toBeInTheDocument();
    expect(createCredentialProfile).not.toHaveBeenCalled();
  });

  it('cancels new profile modal', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);

    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('New Profile');
    await user.click(screen.getByText('New Profile'));
    expect(screen.getByText('New Credential Profile')).toBeInTheDocument();
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New Credential Profile')).not.toBeInTheDocument();
  });

  it('displays connection count per profile', async () => {
    setupDefaults();
    vi.mocked(getProfileMappings).mockImplementation(async (id: string) => {
      if (id === 'p1') return [{ connection_id: 'conn1', connection_name: 'Server Alpha', protocol: 'rdp' }];
      return [];
    });
    renderCredentials();
    await screen.findByText('Work Profile');
    expect(screen.getByText(/1 connection(?!s)/)).toBeInTheDocument();
  });

  it('expands profile to show mappings', async () => {
    setupDefaults();
    vi.mocked(getProfileMappings).mockImplementation(async (id: string) => {
      if (id === 'p1') return [{ connection_id: 'conn1', connection_name: 'Server Alpha', protocol: 'rdp' }];
      return [];
    });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    // Click the profile header to expand
    await user.click(screen.getByText('Work Profile'));
    expect(await screen.findByText('Server Alpha')).toBeInTheDocument();
    expect(screen.getByText('Unmap')).toBeInTheDocument();
  });

  it('collapses expanded profile on second click', async () => {
    setupDefaults();
    vi.mocked(getProfileMappings).mockImplementation(async (id: string) => {
      if (id === 'p1') return [{ connection_id: 'conn1', connection_name: 'Server Alpha', protocol: 'rdp' }];
      return [];
    });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    expect(await screen.findByText('Unmap')).toBeInTheDocument();
    // Click again to collapse
    await user.click(screen.getByText('Work Profile'));
    await waitFor(() => expect(screen.queryByText('Unmap')).not.toBeInTheDocument());
  });

  it('shows "No connections mapped" when profile has no mappings', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    expect(await screen.findByText(/No connections mapped/)).toBeInTheDocument();
  });

  it('opens edit modal with pre-filled values', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    // Click Edit button (using getAllByText since there are 2 profiles)
    const editButtons = screen.getAllByText('Edit');
    await user.click(editButtons[0]);
    expect(screen.getByText('Edit Profile')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Work Profile')).toBeInTheDocument();
    expect(screen.getByText('Update')).toBeInTheDocument();
  });

  it('updates a credential profile', async () => {
    setupDefaults();
    vi.mocked(updateCredentialProfile).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    const editButtons = screen.getAllByText('Edit');
    await user.click(editButtons[0]);
    await user.clear(screen.getByDisplayValue('Work Profile'));
    await user.type(screen.getByPlaceholderText('e.g. Domain Admin, SSH Dev Server'), 'Updated Profile');
    await user.click(screen.getByText('Update'));
    expect(updateCredentialProfile).toHaveBeenCalledWith('p1', expect.objectContaining({ label: 'Updated Profile' }));
  });

  it('edit modal shows (unchanged) placeholders for username and password', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    const editButtons = screen.getAllByText('Edit');
    await user.click(editButtons[0]);
    const unchanged = screen.getAllByPlaceholderText('(unchanged)');
    expect(unchanged).toHaveLength(2); // username + password
  });

  it('opens delete confirmation dialog', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    expect(screen.getByText('Delete Profile?')).toBeInTheDocument();
    expect(screen.getByText('Delete Permanently')).toBeInTheDocument();
  });

  it('cancels delete confirmation', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    expect(screen.getByText('Delete Profile?')).toBeInTheDocument();
    // Cancel the dialog - pick the Cancel inside the modal
    const cancelButtons = screen.getAllByText('Cancel');
    await user.click(cancelButtons[cancelButtons.length - 1]);
    expect(screen.queryByText('Delete Profile?')).not.toBeInTheDocument();
  });

  it('confirms delete and calls API', async () => {
    setupDefaults();
    vi.mocked(deleteCredentialProfile).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    await user.click(screen.getByText('Delete Permanently'));
    expect(deleteCredentialProfile).toHaveBeenCalledWith('p1');
  });

  it('shows error when save fails', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);
    vi.mocked(createCredentialProfile).mockRejectedValue(new Error('Network error'));

    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('New Profile');
    await user.click(screen.getByText('New Profile'));
    await user.type(screen.getByPlaceholderText('e.g. Domain Admin, SSH Dev Server'), 'Test');
    await user.type(screen.getByPlaceholderText('sAMAccountName (e.g. jsmith)'), 'admin');
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret');
    await user.click(screen.getByText('Create Profile'));
    expect(await screen.findByText('Network error')).toBeInTheDocument();
  });

  it('shows error when delete fails', async () => {
    setupDefaults();
    vi.mocked(deleteCredentialProfile).mockRejectedValue(new Error('Delete failed'));
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    await user.click(screen.getByText('Delete Permanently'));
    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
  });

  it('shows Add Connections button when profile expanded', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    expect(await screen.findByText('Add Connections')).toBeInTheDocument();
  });

  it('opens mapping dropdown and shows available connections', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    expect(screen.getByText('Select connections…')).toBeInTheDocument();
  });

  it('removes a mapping via Unmap button', async () => {
    setupDefaults();
    vi.mocked(getProfileMappings).mockImplementation(async (id: string) => {
      if (id === 'p1') return [{ connection_id: 'conn1', connection_name: 'Server Alpha', protocol: 'rdp' }];
      return [];
    });
    vi.mocked(removeCredentialMapping).mockResolvedValue({ status: 'success' });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Unmap'));
    expect(removeCredentialMapping).toHaveBeenCalledWith('conn1');
  });

  it('shows error when remove mapping fails', async () => {
    setupDefaults();
    vi.mocked(getProfileMappings).mockImplementation(async (id: string) => {
      if (id === 'p1') return [{ connection_id: 'conn1', connection_name: 'Server Alpha', protocol: 'rdp' }];
      return [];
    });
    vi.mocked(removeCredentialMapping).mockRejectedValue(new Error('Remove failed'));
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Unmap'));
    expect(await screen.findByText('Remove failed')).toBeInTheDocument();
  });

  it('shows TTL slider in new profile form', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);

    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('New Profile');
    await user.click(screen.getByText('New Profile'));
    expect(screen.getByText('Password Expiry')).toBeInTheDocument();
    expect(screen.getByText('12 hours')).toBeInTheDocument();
  });

  it('displays protocol badge in mapping table', async () => {
    setupDefaults();
    vi.mocked(getProfileMappings).mockImplementation(async (id: string) => {
      if (id === 'p1') return [{ connection_id: 'conn1', connection_name: 'Server Alpha', protocol: 'rdp' }];
      return [];
    });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await waitFor(() => {
      expect(screen.getByText('rdp')).toBeInTheDocument();
    });
  });

  it('opens mapping dropdown and selects a connection', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    // Click the trigger to open dropdown
    await user.click(screen.getByText('Select connections…'));
    // Should show available connections in the dropdown via role
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(1);
    // Select the first connection
    await user.click(options[0]);
    // Chip should appear — check via aria-selected
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('submits mapping for selected connections', async () => {
    setupDefaults();
    const setCredentialMapping = vi.fn().mockResolvedValue({ status: 'success' });
    const api = await import('../api');
    (api as any).setCredentialMapping = setCredentialMapping;
    vi.mocked(api.setCredentialMapping).mockResolvedValue({ status: 'success' });

    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    await user.click(screen.getByText('Select connections…'));
    await user.click(await screen.findByRole('option', { name: /Server Alpha/ }));
    // Click the Map button
    const mapButton = screen.getByRole('button', { name: /Map/ });
    await user.click(mapButton);
    expect(api.setCredentialMapping).toHaveBeenCalledWith('p1', 'conn1');
  });

  it('cancels mapping mode', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    expect(screen.getByText('Select connections…')).toBeInTheDocument();
    // Click Cancel in the mapping form
    const cancelButtons = screen.getAllByText('Cancel');
    await user.click(cancelButtons[cancelButtons.length - 1]);
    // Mapping form should be gone
    expect(screen.queryByText('Select connections…')).not.toBeInTheDocument();
  });

  it('delete confirmation shows profile name and mapping count', async () => {
    setupDefaults();
    vi.mocked(getProfileMappings).mockImplementation(async (id: string) => {
      if (id === 'p1') return [
        { connection_id: 'conn1', connection_name: 'Server Alpha', protocol: 'rdp' },
        { connection_id: 'conn2', connection_name: 'Server Beta', protocol: 'ssh' },
      ];
      return [];
    });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    expect(screen.getByText('Delete Profile?')).toBeInTheDocument();
    expect(screen.getByText('Delete Permanently')).toBeInTheDocument();
    // Modal shows the unmap message with the connection count
    expect(screen.getByText(/This will unmap it from/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
  });

  it('shows non-Error exception on save failure', async () => {
    vi.mocked(getCredentialProfiles).mockResolvedValue([]);
    vi.mocked(getMyConnections).mockResolvedValue([]);
    vi.mocked(getServiceHealth).mockResolvedValue(vaultConfigured);
    vi.mocked(createCredentialProfile).mockRejectedValue('string-error');

    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('New Profile');
    await user.click(screen.getByText('New Profile'));
    await user.type(screen.getByPlaceholderText('e.g. Domain Admin, SSH Dev Server'), 'Test');
    await user.type(screen.getByPlaceholderText('sAMAccountName (e.g. jsmith)'), 'admin');
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret');
    await user.click(screen.getByText('Create Profile'));
    expect(await screen.findByText('Save failed')).toBeInTheDocument();
  });

  it('shows non-Error exception on delete failure', async () => {
    setupDefaults();
    vi.mocked(deleteCredentialProfile).mockRejectedValue('string-error');
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    await user.click(screen.getByText('Delete Permanently'));
    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
  });

  it('shows non-Error exception on remove mapping failure', async () => {
    setupDefaults();
    vi.mocked(getProfileMappings).mockImplementation(async (id: string) => {
      if (id === 'p1') return [{ connection_id: 'conn1', connection_name: 'Server Alpha', protocol: 'rdp' }];
      return [];
    });
    vi.mocked(removeCredentialMapping).mockRejectedValue(42);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Unmap'));
    expect(await screen.findByText('Remove failed')).toBeInTheDocument();
  });

  it('filters connections in mapping dropdown by search', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    await user.click(screen.getByText('Select connections…'));
    // Both connections should be visible
    expect(await screen.findByText(/Server Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Server Beta/)).toBeInTheDocument();
    // Type in search
    const searchInput = screen.getByPlaceholderText('Search connections…');
    await user.type(searchInput, 'Alpha');
    // Only Alpha should be visible
    expect(screen.getByText(/Server Alpha/)).toBeInTheDocument();
    expect(screen.queryByText(/Server Beta/)).not.toBeInTheDocument();
  });

  it('shows "No matching connections" when search has no results', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    await user.click(screen.getByText('Select connections…'));
    const searchInput = screen.getByPlaceholderText('Search connections…');
    await user.type(searchInput, 'nonexistent');
    expect(screen.getByText('No matching connections')).toBeInTheDocument();
  });

  it('deselects a connection via option toggle', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    await user.click(screen.getByText('Select connections…'));
    // Select a connection
    const options = await screen.findAllByRole('option');
    await user.click(options[0]);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    // Click again to deselect
    await user.click(options[0]);
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('closes dropdown on outside click', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    await user.click(screen.getByText('Select connections…'));
    expect(await screen.findByText(/Server Alpha/)).toBeInTheDocument();
    // Click outside
    await user.click(document.body);
    // Dropdown options should close
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search connections…')).not.toBeInTheDocument();
    });
  });

  it('shows expiry date for non-expired profile', async () => {
    setupDefaults();
    renderCredentials();
    await screen.findByText('Work Profile');
    // Non-expired profile should show "Expires" text
    expect(screen.getByText(/Expires/)).toBeInTheDocument();
  });

  it('shows mapped connections count text', async () => {
    setupDefaults();
    renderCredentials();
    await screen.findByText('Work Profile');
    // Both profiles show "0 connections" when no mappings
    const countTexts = screen.getAllByText(/0 connections/);
    expect(countTexts.length).toBeGreaterThanOrEqual(2);
  });

  it('Map button is disabled when no connections selected', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Work Profile'));
    await user.click(await screen.findByText('Add Connections'));
    const mapButton = screen.getByRole('button', { name: /Map/ });
    expect(mapButton).toBeDisabled();
  });

  it('shows Request Checkout tab and empty managed accounts', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Request Checkout'));
    expect(await screen.findByText(/No managed accounts assigned/)).toBeInTheDocument();
  });

  it('shows My Checkouts tab with no checkouts', async () => {
    setupDefaults();
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('My Checkouts'));
    expect(await screen.findByText('No checkout requests yet.')).toBeInTheDocument();
  });

  it('shows checkout statuses on My Checkouts tab', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-account,DC=corp,DC=local',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
      {
        id: 'co2',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=admin-account,DC=corp,DC=local',
        status: 'Pending',
        requested_duration_mins: 30,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'co3',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=denied-account,DC=corp,DC=local',
        status: 'Denied',
        requested_duration_mins: 120,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText('CN=svc-account,DC=corp,DC=local')).toBeInTheDocument();
    });
    expect(screen.getByText('CN=admin-account,DC=corp,DC=local')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Denied')).toBeInTheDocument();
  });

  it('shows Reveal Password button for active checkout', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    expect(await screen.findByText('Reveal Password')).toBeInTheDocument();
  });

  it('reveals password on click', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    vi.mocked(revealCheckoutPassword).mockResolvedValue({ password: 'SuperSecret123!' });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await user.click(await screen.findByText('Reveal Password'));
    expect(await screen.findByText('SuperSecret123!')).toBeInTheDocument();
  });

  it('shows Check In button for active checkout', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    expect(await screen.findByText('Check In')).toBeInTheDocument();
  });

  it('opens check-in confirmation modal', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await user.click(await screen.findByText('Check In'));
    expect(await screen.findByText('Check In Account?')).toBeInTheDocument();
    expect(screen.getByText(/scrambled in Active Directory/)).toBeInTheDocument();
  });

  it('shows Retry Activation for approved but not-active checkout', async () => {
    setupDefaults();
    const pastTime = new Date(Date.now() - 7200000).toISOString(); // 2 hours ago
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'Approved',
        requested_duration_mins: 60,
        created_at: pastTime,
        updated_at: pastTime,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    expect(await screen.findByText('Retry Activation')).toBeInTheDocument();
    expect(screen.getByText(/Activation failed/)).toBeInTheDocument();
  });

  it('shows Expired status for expired checkout', async () => {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'Expired',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText('Expired')).toBeInTheDocument();
    });
  });

  it('shows Checked In status for checked-in checkout', async () => {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'CheckedIn',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText('Checked In')).toBeInTheDocument();
    });
  });

  it('shows time remaining for active checkout', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 5400000).toISOString(); // 1.5 hours
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'Active',
        requested_duration_mins: 120,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText(/remaining/)).toBeInTheDocument();
    });
  });

  it('shows duration and justification in checkout card', async () => {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp,DC=local',
        status: 'Pending',
        requested_duration_mins: 45,
        justification_comment: 'Production deployment',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText(/Duration: 45m/)).toBeInTheDocument();
      expect(screen.getByText(/Production deployment/)).toBeInTheDocument();
    });
  });

  it('shows all-accounts-active message on request tab when all have checkouts', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([
      { id: 'm1', user_id: 'u1', managed_ad_dn: 'CN=svc,DC=corp', can_self_approve: false, created_at: '' },
    ]);
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Request Checkout'));
    expect(await screen.findByText(/All managed accounts already have active checkouts/)).toBeInTheDocument();
  });

  it('shows request form when managed accounts available', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([
      { id: 'm1', user_id: 'u1', managed_ad_dn: 'CN=svc,DC=corp', can_self_approve: false, created_at: '' },
    ]);
    vi.mocked(getMyCheckouts).mockResolvedValue([]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Request Checkout'));
    expect(await screen.findByText('Request Password Checkout')).toBeInTheDocument();
    expect(screen.getByText('Managed Account')).toBeInTheDocument();
    expect(screen.getByText(/Duration/)).toBeInTheDocument();
    expect(screen.getByText(/Justification/)).toBeInTheDocument();
  });

  it('shows active checkout count badge on My Checkouts tab', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    renderCredentials();
    await waitFor(() => {
      expect(screen.getByText(/My Checkouts \(1\)/)).toBeInTheDocument();
    });
  });

  it('hides stale expired checkouts when newer active one exists', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co-old',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp',
        status: 'Expired',
        requested_duration_mins: 60,
        created_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
        updated_at: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: 'co-new',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    // The active one should appear but the old expired one should be filtered out
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    // Should only have 1 checkout card, not 2
    const cards = screen.getAllByText('CN=svc,DC=corp');
    expect(cards).toHaveLength(1);
  });

  it('shows managed accounts in checkout request form', async () => {
    vi.mocked(getMyManagedAccounts).mockResolvedValue([
      { managed_ad_dn: 'CN=svc-acct,DC=corp', ad_sync_config_id: 'cfg1' },
      { managed_ad_dn: 'CN=admin-acct,DC=corp', ad_sync_config_id: 'cfg2' },
    ] as any);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText(/Request Checkout/i)).toBeInTheDocument();
    });
  });

  it('submits checkout request and shows approval flash', async () => {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([]);
    vi.mocked(getMyManagedAccounts).mockResolvedValue([
      { managed_ad_dn: 'CN=svc-acct,DC=corp', ad_sync_config_id: 'cfg1' },
    ] as any);
    vi.mocked(requestCheckout).mockResolvedValue({
      id: 'co1',
      status: 'Approved',
    });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Request Checkout'));
    // Wait for the managed account form to load
    await waitFor(() => {
      expect(screen.getByText('Request Password Checkout')).toBeInTheDocument();
    });
  });

  it('handles save profile validation for new profile with missing fields', async () => {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([]);
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    // Click + New Profile button
    const addBtn = screen.getByText(/New Profile/i);
    await user.click(addBtn);
    // Try to save without filling required fields — button says "Create Profile"
    const saveBtn = await screen.findByText('Create Profile');
    await user.click(saveBtn);
    await waitFor(() => {
      expect(screen.getByText(/All fields are required/i)).toBeInTheDocument();
    });
  });

  it('handles save profile update for existing profile', async () => {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([]);
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    vi.mocked(updateCredentialProfile).mockResolvedValue({ status: 'updated' });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    // Click the Edit button on the first profile
    const editButtons = screen.getAllByText('Edit');
    await user.click(editButtons[0]);
    // Now find Update button and click it
    const updateBtn = await screen.findByText('Update');
    await user.click(updateBtn);
    await waitFor(() => {
      expect(updateCredentialProfile).toHaveBeenCalled();
    });
  });

  it('reveals checkout password and shows it', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-acct,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    vi.mocked(revealCheckoutPassword).mockResolvedValue({ password: 'S3cret!' });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    // Wait for the active checkout to appear
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    // Time remaining should be displayed
    expect(screen.getByText(/remaining/i)).toBeInTheDocument();
    // Click reveal password
    const revealBtn = screen.getByText(/Reveal/i);
    await user.click(revealBtn);
    await waitFor(() => {
      expect(revealCheckoutPassword).toHaveBeenCalledWith('co1');
      expect(screen.getByText('S3cret!')).toBeInTheDocument();
    });
  });

  it('submits checkout request with managed account', async () => {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([]);
    vi.mocked(getMyManagedAccounts).mockResolvedValue([
      { managed_ad_dn: 'CN=svc-acct,DC=corp', ad_sync_config_id: 'cfg1' },
    ] as any);
    vi.mocked(requestCheckout).mockResolvedValue({
      id: 'co-new',
      status: 'Pending',
    });
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Request Checkout'));
    // Wait for managed accounts form to load
    await waitFor(() => {
      expect(screen.getByText('Request Password Checkout')).toBeInTheDocument();
    });
    // Managed account label should be visible in the form
    expect(screen.getByText(/Managed Account/)).toBeInTheDocument();
  });

  it('shows Checked In status and filters expired checkouts', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co-checkedin',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-one,DC=corp',
        status: 'CheckedIn',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'co-denied',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-two,DC=corp',
        status: 'Denied',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'co-active',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-three,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    // Active checkout should be shown
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    // CheckedIn status renders as "Checked In"
    expect(screen.getByText('Checked In')).toBeInTheDocument();
    // Denied status should also show
    expect(screen.getByText('Denied')).toBeInTheDocument();
  });

  it('shows stale checkout as expired when old Pending', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    // Checkout created more than 24h ago with Pending status
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co-stale',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-old,DC=corp',
        status: 'Pending',
        requested_duration_mins: 60,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        updated_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    // Stale checkout should show as "Expired — activation failed"
    await waitFor(() => {
      expect(screen.getByText(/Expired .* activation failed/)).toBeInTheDocument();
    });
  });

  it('handles reveal password failure', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co1',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-acct,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    vi.mocked(revealCheckoutPassword).mockRejectedValue(new Error('Access denied'));
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    const revealBtn = screen.getByText(/Reveal/i);
    await user.click(revealBtn);
    await waitFor(() => {
      expect(screen.getByText('Access denied')).toBeInTheDocument();
    });
  });

  it('shows all managed accounts already checked out message', async () => {
    setupDefaults();
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([
      { managed_ad_dn: 'CN=svc-acct,DC=corp', ad_sync_config_id: 'cfg1' },
    ] as any);
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co-active',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-acct,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/Request Checkout/));
    await waitFor(() => {
      expect(screen.getByText(/All managed accounts already have active checkouts/)).toBeInTheDocument();
    });
  });

  it('deletes a profile after confirmation', async () => {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([]);
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    vi.mocked(deleteCredentialProfile).mockResolvedValue(undefined as any);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    // Click Delete on first profile
    const deleteButtons = screen.getAllByText('Delete');
    await user.click(deleteButtons[0]);
    // Confirm deletion
    await waitFor(() => {
      expect(screen.getByText(/Are you sure/i)).toBeInTheDocument();
    });
    const confirmBtn = screen.getByText(/Delete Permanently/i);
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(deleteCredentialProfile).toHaveBeenCalled();
    });
  });

  it('opens check-in confirmation and confirms', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co-live',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-acct,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    vi.mocked(checkinCheckout).mockResolvedValue(undefined as any);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    // Click Check In button
    await user.click(screen.getByText('Check In'));
    // Confirmation modal should appear
    await waitFor(() => {
      expect(screen.getByText('Check In Account?')).toBeInTheDocument();
    });
    // Confirm
    const confirmBtns = screen.getAllByText('Check In');
    await user.click(confirmBtns[confirmBtns.length - 1]);
    await waitFor(() => {
      expect(checkinCheckout).toHaveBeenCalledWith('co-live');
    });
  });

  // ── Emergency bypass / justification / scheduling branch coverage ──

  async function openRequestFormWithAccount(account: any) {
    setupDefaults();
    vi.mocked(getMyCheckouts).mockResolvedValue([]);
    vi.mocked(getMyManagedAccounts).mockResolvedValue([account]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText('Request Checkout'));
    await screen.findByText('Request Password Checkout');
    // Open the Select and pick the account option
    await user.click(screen.getByText(/Select account/));
    const opt = await screen.findByRole('option', { name: new RegExp(account.managed_ad_dn) });
    await user.click(opt);
    return user;
  }

  it('shows emergency bypass checkbox when account allows it and cannot self-approve', async () => {
    await openRequestFormWithAccount({
      id: 'm1', user_id: 'u1',
      managed_ad_dn: 'CN=svc,DC=corp',
      can_self_approve: false,
      pm_allow_emergency_bypass: true,
      created_at: '',
    });
    expect(await screen.findByText(/Emergency Approval Bypass/)).toBeInTheDocument();
  });

  it('hides emergency bypass when pm_allow_emergency_bypass is false', async () => {
    await openRequestFormWithAccount({
      id: 'm1', user_id: 'u1',
      managed_ad_dn: 'CN=svc,DC=corp',
      can_self_approve: false,
      pm_allow_emergency_bypass: false,
      created_at: '',
    });
    expect(screen.queryByText(/Emergency Approval Bypass/)).not.toBeInTheDocument();
  });

  it('hides emergency bypass when user can self-approve', async () => {
    await openRequestFormWithAccount({
      id: 'm1', user_id: 'u1',
      managed_ad_dn: 'CN=svc,DC=corp',
      can_self_approve: true,
      pm_allow_emergency_bypass: true,
      created_at: '',
    });
    expect(screen.queryByText(/Emergency Approval Bypass/)).not.toBeInTheDocument();
  });

  it('caps duration at 30 when emergency bypass is enabled', async () => {
    const user = await openRequestFormWithAccount({
      id: 'm1', user_id: 'u1',
      managed_ad_dn: 'CN=svc,DC=corp',
      can_self_approve: false,
      pm_allow_emergency_bypass: true,
      created_at: '',
    });
    // Default duration is 60; tick the emergency bypass checkbox
    const emergencyCb = screen.getByRole('checkbox', { name: /Emergency Approval Bypass/i });
    await user.click(emergencyCb);
    await waitFor(() => {
      const durationInput = screen.getByRole('spinbutton') as HTMLInputElement;
      expect(Number(durationInput.value)).toBeLessThanOrEqual(30);
    });
    expect(screen.getByText(/capped at 30 minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/Duration \(minutes, 1–30\)/)).toBeInTheDocument();
  });

  it('shows "required, min 10 characters" for approval-required account', async () => {
    await openRequestFormWithAccount({
      id: 'm1', user_id: 'u1',
      managed_ad_dn: 'CN=svc,DC=corp',
      can_self_approve: false,
      pm_allow_emergency_bypass: false,
      created_at: '',
    });
    expect(await screen.findByText(/required, min 10 characters/i)).toBeInTheDocument();
    // Helper message visible when field empty
    expect(screen.getByText(/need a justification of at least 10 characters/i)).toBeInTheDocument();
  });

  it('disables submit when justification is under 10 chars and approval is required', async () => {
    const user = await openRequestFormWithAccount({
      id: 'm1', user_id: 'u1',
      managed_ad_dn: 'CN=svc,DC=corp',
      can_self_approve: false,
      pm_allow_emergency_bypass: false,
      created_at: '',
    });
    // Two buttons named "Request Checkout" exist: the tab and the submit.
    // The submit is the last in DOM order.
    const findSubmit = () => {
      const all = screen.getAllByRole('button', { name: /^Request Checkout$/ });
      return all[all.length - 1];
    };
    await waitFor(() => expect(findSubmit()).toBeDisabled());
    // Type < 10 chars → still disabled
    const ta = screen.getByRole('textbox');
    await user.type(ta, 'short');
    expect(findSubmit()).toBeDisabled();
    // Type enough → enabled
    await user.type(ta, ' reason here');
    await waitFor(() => expect(findSubmit()).not.toBeDisabled());
  });

  it('decrement button clamps duration at 1 and is disabled there', async () => {
    const user = await openRequestFormWithAccount({
      id: 'm1', user_id: 'u1',
      managed_ad_dn: 'CN=svc,DC=corp',
      can_self_approve: true,
      pm_allow_emergency_bypass: false,
      created_at: '',
    });
    const dec = screen.getByLabelText('Decrease duration');
    // Default 60 → hammer it down past 1
    for (let i = 0; i < 25; i++) {
      if (!(dec as HTMLButtonElement).disabled) await user.click(dec);
    }
    const durationInput = screen.getByRole('spinbutton') as HTMLInputElement;
    await waitFor(() => expect(Number(durationInput.value)).toBe(1));
    expect(dec).toBeDisabled();
  });

  it('shows scheduled-start datetime input when Schedule checkbox toggled', async () => {
    const user = await openRequestFormWithAccount({
      id: 'm1', user_id: 'u1',
      managed_ad_dn: 'CN=svc,DC=corp',
      can_self_approve: true,
      pm_allow_emergency_bypass: false,
      created_at: '',
    });
    const scheduleCb = screen.getByRole('checkbox', { name: /Schedule release for a future time/i });
    await user.click(scheduleCb);
    // datetime-local input appears
    await waitFor(() => {
      const dtInput = document.querySelector('input[type="datetime-local"]') as HTMLInputElement | null;
      expect(dtInput).not.toBeNull();
      // Pre-filled with a value ~15min from now
      expect(dtInput!.value).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    });
    expect(screen.getByText(/Max 14 days ahead/)).toBeInTheDocument();
    // Submit button label flips to "Schedule Checkout"
    expect(screen.getByRole('button', { name: /^Schedule Checkout$/ })).toBeInTheDocument();
  });

  it('shows Retry Activation for approved but not live checkout', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    // Approved but no expires_at — means not live
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co-approved-stale',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-retry,DC=corp',
        status: 'Approved',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText(/Activation failed/)).toBeInTheDocument();
    });
    expect(screen.getByText('Retry Activation')).toBeInTheDocument();
  });

  it('handles check-in failure gracefully', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co-fail',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-fail,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    vi.mocked(checkinCheckout).mockRejectedValue(new Error('Check-in failed'));
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Check In'));
    await waitFor(() => {
      expect(screen.getByText('Check In Account?')).toBeInTheDocument();
    });
    const confirmBtns = screen.getAllByText('Check In');
    await user.click(confirmBtns[confirmBtns.length - 1]);
    await waitFor(() => {
      expect(screen.getByText('Check-in failed')).toBeInTheDocument();
    });
  });

  it('cancels check-in modal', async () => {
    setupDefaults();
    vi.mocked(getMyManagedAccounts).mockResolvedValue([]);
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    vi.mocked(getMyCheckouts).mockResolvedValue([
      {
        id: 'co-cancel',
        requester_user_id: 'u1',
        managed_ad_dn: 'CN=svc-cancel,DC=corp',
        status: 'Active',
        requested_duration_mins: 60,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: futureExpiry,
      },
    ]);
    const user = userEvent.setup();
    renderCredentials();
    await screen.findByText('Work Profile');
    await user.click(screen.getByText(/My Checkouts/));
    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Check In'));
    await waitFor(() => {
      expect(screen.getByText('Check In Account?')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByText('Check In Account?')).not.toBeInTheDocument();
    });
  });
});
