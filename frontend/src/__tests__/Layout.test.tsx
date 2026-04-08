import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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

function renderLayout(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Layout onLogout={vi.fn()} />
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
});
