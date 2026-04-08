import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';

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
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  // We override the BrowserRouter by wrapping App in MemoryRouter.
  // But App already uses useNavigate which needs a Router ancestor.
  // Since App doesn't render its own Router, we wrap here.
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
});
