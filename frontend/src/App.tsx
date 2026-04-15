import { useEffect, useState, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Credentials from './pages/Credentials';
import AdminSettings from './pages/AdminSettings';
import SessionClient from './pages/SessionClient';
import TiledView from './pages/TiledView';
import SharedViewer from './pages/SharedViewer';
import AuditLogs from './pages/AuditLogs';
import NvrPlayer from './pages/NvrPlayer';
import Documentation from './pages/Documentation';
import Sessions from './pages/Sessions';
import Layout from './components/Layout';
import { SessionManagerProvider } from './components/SessionManager';
import SessionBar from './components/SessionBar';
import WhatsNewModal from './components/WhatsNewModal';
import SessionTimeoutWarning from './components/SessionTimeoutWarning';
import { checkAuthStatus, MeResponse } from './api';
import { SettingsProvider } from './contexts/SettingsContext';

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<MeResponse | null>(null);
  const navigate = useNavigate();

  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem('access_token');
    if (!token) {
      setAuthenticated(false);
      return;
    }

    // Use /api/auth/check which always returns 200 (never 401).
    // This avoids the browser logging a noisy 401 in the console when the
    // token is stale, expired, or signed with a rotated key.
    const result = await checkAuthStatus();
    if (!result.authenticated || !result.user) {
      localStorage.removeItem('access_token');
      localStorage.removeItem('token_expiry');
      setAuthenticated(false);
      return;
    }

    setUser(result.user);
    setAuthenticated(true);
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  /** Called by the Login component after a successful login POST. */
  async function handleLogin() {
    const result = await checkAuthStatus();
    if (result.authenticated && result.user) {
      setUser(result.user);
      setAuthenticated(true);
      navigate('/');
    } else {
      localStorage.removeItem('access_token');
      localStorage.removeItem('token_expiry');
      setAuthenticated(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('token_expiry');
    setAuthenticated(false);
    setUser(null);
    navigate('/login');
  }

  if (authenticated === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-8 h-8 rounded-full animate-spin mx-auto mb-4"
            style={{ border: '3px solid var(--color-border)', borderTopColor: 'var(--color-accent)' }} />
          <p className="text-txt-secondary text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <SettingsProvider>
      <SessionManagerProvider>
        {!authenticated ? (
          <Routes>
            <Route path="/login" element={<Login onLogin={handleLogin} />} />
            <Route path="/shared/:shareToken" element={<SharedViewer />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        ) : (
          <>
            <Routes>
              <Route element={<Layout user={user} onLogout={handleLogout} />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/credentials" element={user?.vault_configured ? <Credentials vaultConfigured={true} /> : <Navigate to="/" replace />} />
                <Route path="/admin" element={(user?.can_manage_system || user?.can_manage_users || user?.can_manage_connections || user?.can_create_users || user?.can_create_user_groups || user?.can_create_connections || user?.can_create_connection_folders || user?.can_create_sharing_profiles) ? <AdminSettings user={user} /> : <Navigate to="/" replace />} />
                <Route path="/session/:connectionId" element={<SessionClient />} />
                <Route path="/tiled" element={<TiledView />} />
                <Route path="/observe/:sessionId" element={(user?.can_manage_system || user?.can_view_audit_logs) ? <NvrPlayer /> : <Navigate to="/" replace />} />
                <Route path="/audit" element={(user?.can_manage_system || user?.can_view_audit_logs) ? <AuditLogs /> : <Navigate to="/" replace />} />
                <Route path="/sessions" element={(user?.can_view_sessions || user?.can_manage_system || user?.can_view_audit_logs) ? <Sessions user={user} /> : <Navigate to="/" replace />} />
                <Route path="/docs" element={<Documentation />} />
              </Route>
              <Route path="/shared/:shareToken" element={<SharedViewer />} />
              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <SessionBar />
            <SessionTimeoutWarning onExpired={handleLogout} />
            <WhatsNewModal userId={user?.id} />
          </>
        )}
      </SessionManagerProvider>
    </SettingsProvider>
  );
}
