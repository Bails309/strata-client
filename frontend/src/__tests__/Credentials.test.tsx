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
} from '../api';

function renderCredentials() {
  return render(
    <BrowserRouter>
      <Credentials vaultConfigured={true} />
    </BrowserRouter>,
  );
}

const vaultConfigured = {
  database: { connected: true, mode: 'local', host: 'localhost' },
  guacd: { reachable: true, host: 'guacd', port: 4822 },
  vault: { configured: true, mode: 'local', address: 'http://localhost' }
};
const vaultNotConfigured = {
  database: { connected: true, mode: 'local', host: 'localhost' },
  guacd: { reachable: true, host: 'guacd', port: 4822 },
  vault: { configured: false, mode: 'local', address: 'http://localhost' }
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
    await user.type(screen.getByPlaceholderText('jsmith'), 'admin');
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
    await user.type(screen.getByPlaceholderText('jsmith'), 'admin');
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
    await user.type(screen.getByPlaceholderText('jsmith'), 'admin');
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
});
