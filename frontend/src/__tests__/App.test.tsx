import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet } from 'react-router-dom';
import App from '../App';
import React from 'react';

// Mock heavy child components to keep tests fast
vi.mock('../pages/Dashboard', () => ({ default: () => <div>Dashboard</div> }));
vi.mock('../pages/Login', () => ({
  default: ({ onLogin }: { onLogin: () => void }) => (
    <div>
      Login Page
      <button onClick={onLogin}>mock-login</button>
    </div>
  ),
}));
vi.mock('../pages/AdminSettings', () => ({ default: () => <div>Admin</div> }));
vi.mock('../pages/AuditLogs', () => ({ default: () => <div>Audit</div> }));
vi.mock('../pages/SessionClient', () => ({ default: () => <div>Session</div> }));
vi.mock('../pages/TiledView', () => ({ default: () => <div>Tiled</div> }));
vi.mock('../pages/SharedViewer', () => ({ default: () => <div>Shared</div> }));
vi.mock('../pages/NvrPlayer', () => ({ default: () => <div>NVR</div> }));
vi.mock('../pages/Credentials', () => ({ default: () => <div>Credentials</div> }));
vi.mock('../components/Layout', () => ({
  default: ({ onLogout }: { onLogout?: () => void }) => (
    <div>
      <Outlet />
      {onLogout && <button onClick={onLogout}>mock-logout</button>}
    </div>
  ),
}));
vi.mock('../components/SessionManager', () => ({
  SessionManagerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/SessionBar', () => ({ default: () => null }));
vi.mock('../components/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function renderApp(initialRoute = '/') {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App routing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects to /login when not authenticated', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('', { status: 401 });
    }) as unknown as typeof fetch;

    renderApp('/');
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
  });

  it('renders shared viewer without auth', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('', { status: 401 });
    }) as unknown as typeof fetch;

    renderApp('/shared/abc123');
    expect(await screen.findByText('Shared')).toBeInTheDocument();
  });

  it('renders dashboard when authenticated', async () => {
    localStorage.setItem('access_token', 'valid-token');
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: 1, username: 'admin' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderApp('/');
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('clears token and redirects on invalid token', async () => {
    localStorage.setItem('access_token', 'expired-token');
    globalThis.fetch = vi.fn(async () => {
      return new Response('', { status: 401 });
    }) as unknown as typeof fetch;

    renderApp('/');
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it('handles fetch error gracefully', async () => {
    localStorage.setItem('access_token', 'some-token');
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network error');
    }) as unknown as typeof fetch;

    renderApp('/');
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
  });

  it('shows loading spinner while auth state is pending', () => {
    localStorage.setItem('access_token', 'pending-token');
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    renderApp('/');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('logs out and redirects to login', async () => {
    localStorage.setItem('access_token', 'valid-token');
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: 1, username: 'admin' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    renderApp('/');
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    await userEvent.click(screen.getByText('mock-logout'));
    expect(await screen.findByText('Login Page')).toBeInTheDocument();
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it('calls handleLogin and navigates to dashboard', async () => {
    // Start at login
    globalThis.fetch = vi.fn(async () => {
      return new Response('', { status: 401 });
    }) as unknown as typeof fetch;

    renderApp('/login');
    await screen.findByText('Login Page');

    // Simulate login
    localStorage.setItem('access_token', 'fresh-token');
    // Success response for getMe and getSettings
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: 1, username: 'admin', branding: { name: 'Strata' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await act(async () => {
      await userEvent.click(screen.getByText('mock-login'));
    });
    
    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });
  });
});
