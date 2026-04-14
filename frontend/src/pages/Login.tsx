import { useEffect, useState } from 'react';
import { login, getStatus, StatusResponse } from '../api';
import { useTheme } from '../components/ThemeProvider';

interface Props {
  onLogin: () => void;
}

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    // Check for token in URL fragment (from SSO redirect).
    // We use a fragment (#token=) instead of a query parameter so the JWT
    // is never sent to servers in Referer headers or logged by proxies.
    const hash = window.location.hash;
    const tokenMatch = hash.match(/[#&]token=([^&]*)/);
    const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
    if (token) {
      // Clear the fragment to remove the token from the URL / browser history
      window.history.replaceState(null, '', window.location.pathname);
      localStorage.setItem('access_token', token);
      localStorage.setItem('token_expiry', String(Date.now() + 1200 * 1000));
      onLogin();
      return;
    }

    // Fetch system status to see enabled auth methods
    async function init() {
      try {
         const s = await getStatus();
         setStatus(s);
      } catch {
         // Fallback - show nothing or retry
      }
    }
    init();
  }, [onLogin]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await login({ username, password });
      localStorage.setItem('access_token', res.access_token);
      const ttl = res.expires_in ?? 1200;
      localStorage.setItem('token_expiry', String(Date.now() + ttl * 1000));
      onLogin();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-full max-w-[400px] animate-fade-up">
        {/* Logo */}
        <div className="text-center mb-8">
          <img
            src={theme === 'dark' ? '/logo-dark.png' : '/logo-light.png'}
            alt="Strata Client"
            className="mx-auto mb-4"
            style={{ maxWidth: 200 }}
          />
          <p className="text-txt-secondary text-sm">Sign in to manage your connections</p>
        </div>

        {/* Login Card */}
        <div className="card">
          {error && (
            <div className="rounded-sm mb-4 px-4 py-2 text-[0.8125rem] bg-danger-dim text-danger">
              {error}
            </div>
          )}

          {status?.local_auth_enabled && (
            <form onSubmit={handleSubmit} className={status.sso_enabled ? 'mb-6 pb-6 border-b border-border/50' : ''}>
              <div className="form-group">
                <label>Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="username"
                  autoFocus
                  required
                />
              </div>

              <div className="form-group">
                <label>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
              </div>

              <button
                type="submit"
                className="btn-primary w-full mt-2"
                disabled={loading || !username || !password}
                style={{ padding: '0.65rem' }}
              >
                {loading ? 'Signing in…' : 'Sign In'}
              </button>
            </form>
          )}

          {status?.sso_enabled && (
            <div className="space-y-3">
              <a
                href="/api/auth/sso/login"
                className="btn w-full border border-border bg-surface-primary hover:bg-surface-secondary flex items-center justify-center gap-3 transition-all transform hover:scale-[1.01]"
                style={{ padding: '0.65rem' }}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
                </svg>
                <span className="font-semibold text-txt-primary">Sign in with SSO</span>
              </a>
              <p className="text-[0.7rem] text-center text-txt-tertiary">
                Secure enterprise login via Keycloak / OIDC
              </p>
            </div>
          )}

          {!status && !loading && (
            <div className="text-center py-4">
              <div className="w-6 h-6 rounded-full animate-spin mx-auto mb-2 border-2 border-border border-t-accent" />
              <p className="text-xs text-txt-secondary">Locating authentication service…</p>
            </div>
          )}
        </div>

        <p className="text-center text-txt-tertiary text-xs mt-6">
          Strata Client
        </p>
      </div>
    </div>
  );
}
