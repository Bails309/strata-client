import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  getMyConnections,
  getServiceHealth,
  getProfileMappings,
} from '../api';

function renderCredentials() {
  return render(
    <BrowserRouter>
      <Credentials />
    </BrowserRouter>,
  );
}

describe('Credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows vault-not-configured message when vault is not configured', async () => {
    (getCredentialProfiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getMyConnections as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getServiceHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      vault: { configured: false },
    });

    renderCredentials();

    await waitFor(() => {
      expect(screen.getByText('Vault Not Configured')).toBeInTheDocument();
    });
  });

  it('shows credentials page when vault is configured', async () => {
    (getCredentialProfiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getMyConnections as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getServiceHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      vault: { configured: true },
    });

    renderCredentials();

    await waitFor(() => {
      expect(screen.getByText('New Profile')).toBeInTheDocument();
    });
    expect(screen.getByText('Credentials')).toBeInTheDocument();
  });

  it('renders credential profiles list', async () => {
    (getCredentialProfiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'p1', label: 'Work Profile', created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z', expires_at: '2024-12-31T00:00:00Z',
        expired: false, ttl_hours: 12,
      },
    ]);
    (getMyConnections as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getServiceHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      vault: { configured: true },
    });
    (getProfileMappings as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderCredentials();

    await waitFor(() => {
      expect(screen.getByText('Work Profile')).toBeInTheDocument();
    });
  });

  it('shows vault not configured when health check fails', async () => {
    (getCredentialProfiles as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    (getMyConnections as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    (getServiceHealth as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    renderCredentials();

    // When all API calls fail, vaultConfigured stays false (initial state)
    await waitFor(() => {
      expect(screen.getByText('Vault Not Configured')).toBeInTheDocument();
    });
  });
});
