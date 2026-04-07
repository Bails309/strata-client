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

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const navigate = useNavigate();

  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem('access_token');
    if (!token) {
      setAuthenticated(false);
      return;
    }

    try {
      // Validate the token by calling /api/user/me
      const res = await fetch('/api/user/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setAuthenticated(true);
      } else {
        localStorage.removeItem('access_token');
        setAuthenticated(false);
      }
    } catch {
      // Backend unreachable
      setAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  function handleLogin() {
    setAuthenticated(true);
    navigate('/');
  }

  function handleLogout() {
    localStorage.removeItem('access_token');
    setAuthenticated(false);
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
        <Route element={<Layout onLogout={handleLogout} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/admin" element={<AdminSettings />} />
          <Route path="/session/:connectionId" element={<SessionClient />} />
          <Route path="/tiled" element={<TiledView />} />
          <Route path="/observe/:sessionId" element={<NvrPlayer />} />
          <Route path="/audit" element={<AuditLogs />} />
        </Route>
        <Route path="/shared/:shareToken" element={<SharedViewer />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <SessionBar />
    </SessionManagerProvider>
  );
}
