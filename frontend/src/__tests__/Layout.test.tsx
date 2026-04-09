import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the api module
vi.mock('../api', () => ({
  getMe: vi.fn().mockResolvedValue({
    username: 'testadmin',
    role: 'admin',
    client_ip: '10.0.0.1',
    watermark_enabled: false,
  }),
}));

// Mock the ThemeProvider
vi.mock('../components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark', preference: 'dark', setPreference: vi.fn(), cycle: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock the SessionManager
vi.mock('../components/SessionManager', () => ({
  useSessionManager: () => ({
    sessions: [],
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    setTiledSessionIds: vi.fn(),
    setFocusedSessionIds: vi.fn(),
  }),
  SessionManagerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import Layout from '../components/Layout';

const adminUser: import('../api').MeResponse = {
  id: 'u1',
  username: 'testadmin',
  role: 'admin',
  client_ip: '10.0.0.1',
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

function renderLayout(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Layout user={adminUser} onLogout={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('Layout', () => {
  it('renders navigation links', () => {
    renderLayout();
    expect(screen.getByText('Connections')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Audit Logs')).toBeInTheDocument();
  });

  it('renders credentials link', () => {
    renderLayout();
    expect(screen.getByText('Credentials')).toBeInTheDocument();
  });

  it('renders brand logo', () => {
    renderLayout();
    const logo = screen.getByAltText('Strata Client');
    expect(logo).toBeInTheDocument();
  });

  it('shows username and role after loading', () => {
    renderLayout();
    expect(screen.getByText('testadmin')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('highlights active nav item based on route', () => {
    renderLayout('/admin');
    const adminLink = screen.getByText('Admin').closest('a');
    expect(adminLink?.className).toContain('font-semibold');
  });
});
