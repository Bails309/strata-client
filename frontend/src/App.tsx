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
import Layout from './components/Layout';
import { SessionManagerProvider } from './components/SessionManager';
import SessionBar from './components/SessionBar';
import WhatsNewModal from './components/WhatsNewModal';
import { getMe, MeResponse } from './api';

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

    try {
      const data = await getMe();
      setUser(data);
      setAuthenticated(true);
    } catch {
      localStorage.removeItem('access_token');
      setAuthenticated(false);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  async function handleLogin() {
    await checkAuth();
    navigate('/');
  }

  function handleLogout() {
    localStorage.removeItem('access_token');
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

  if (!authenticated) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={handleLogin} />} />
        <Route path="/shared/:shareToken" element={<SharedViewer />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <SessionManagerProvider>
      <Routes>
        <Route element={<Layout user={user} onLogout={handleLogout} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/credentials" element={user?.vault_configured ? <Credentials vaultConfigured={true} /> : <Navigate to="/" replace />} />
          <Route path="/admin" element={(user?.can_manage_system || user?.can_manage_users || user?.can_manage_connections || user?.can_create_users || user?.can_create_user_groups || user?.can_create_connections || user?.can_create_connection_folders || user?.can_create_sharing_profiles) ? <AdminSettings user={user} /> : <Navigate to="/" replace />} />
          <Route path="/session/:connectionId" element={<SessionClient canShare={user?.can_manage_system || user?.can_create_sharing_profiles || false} />} />
          <Route path="/tiled" element={<TiledView />} />
          <Route path="/observe/:sessionId" element={<NvrPlayer />} />
          <Route path="/audit" element={(user?.can_manage_system || user?.can_view_audit_logs) ? <AuditLogs /> : <Navigate to="/" replace />} />
        </Route>
        <Route path="/shared/:shareToken" element={<SharedViewer />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <SessionBar />
      <WhatsNewModal userId={user?.id} />
    </SessionManagerProvider>
  );
}
