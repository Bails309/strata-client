import { useState } from 'react';
import { login } from '../api';
import { useTheme } from '../components/ThemeProvider';

interface Props {
  onLogin: () => void;
}

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { theme } = useTheme();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await login({ username, password });
      localStorage.setItem('access_token', res.access_token);
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
          <form onSubmit={handleSubmit}>
            {error && (
              <div className="rounded-sm mb-4 px-4 py-2 text-[0.8125rem] bg-danger-dim text-danger">
                {error}
              </div>
            )}

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
        </div>

        <p className="text-center text-txt-tertiary text-xs mt-6">
          Default credentials: admin / admin
        </p>
      </div>
    </div>
  );
}
