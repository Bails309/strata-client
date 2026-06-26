/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { useEffect, useState, useCallback } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Credentials from "./pages/Credentials";
import AdminSettings from "./pages/AdminSettings";
import SessionClient from "./pages/SessionClient";
import TiledView from "./pages/TiledView";
import SharedViewer from "./pages/SharedViewer";
import AuditLogs from "./pages/AuditLogs";
import NvrPlayer from "./pages/NvrPlayer";
import Documentation from "./pages/Documentation";
import Sessions from "./pages/Sessions";
import Approvals from "./pages/Approvals";
import Layout from "./components/Layout";
import Profile from "./pages/Profile";
import { SessionManagerProvider, closeAllSessionsExternal } from "./components/SessionManager";
import SessionBar from "./components/SessionBar";
import WhatsNewModal from "./components/WhatsNewModal";
import DisclaimerModal, { TERMS_VERSION } from "./components/DisclaimerModal";
import SessionTimeoutWarning from "./components/SessionTimeoutWarning";
import ToastProvider from "./components/ToastProvider";
import CredentialProfileExpiryWatcher from "./components/CredentialProfileExpiryWatcher";
import PendingApprovalWatcher from "./components/PendingApprovalWatcher";
import VersionWatcher from "./components/VersionWatcher";
import { checkAuthStatus, logout as apiLogout, MeResponse } from "./api";
import { SettingsProvider } from "./contexts/SettingsContext";
import { UserPreferencesProvider } from "./components/UserPreferencesProvider";
import CommandPaletteProvider from "./components/CommandPaletteProvider";

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<MeResponse | null>(null);
  const navigate = useNavigate();

  const checkAuth = useCallback(async () => {
    // Bootstrap the SPA session by asking the server whether we're
    // authenticated. The HttpOnly access_token cookie travels automatically
    // because checkAuthStatus passes credentials: "include". This endpoint
    // returns 200 unconditionally so a stale cookie does not produce a
    // noisy 401 in the browser console.
    const result = await checkAuthStatus();
    if (!result.authenticated || !result.user) {
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
      navigate("/");
    } else {
      setAuthenticated(false);
    }
  }

  function handleLogout() {
    // Tear down every live tunnel BEFORE flipping auth state so the
    // backend sees clean WebSocket closes and the live-sessions list
    // updates immediately. The provider stays mounted across the
    // logout, so without this its in-memory sessions would keep
    // streaming until the browser tab closes.
    closeAllSessionsExternal();
    // Backend logout — invalidates the refresh token, clears the auth
    // cookies, and (for SSO users) returns an OIDC end-session URL we
    // must navigate to so the IdP terminates its own session. Without
    // the redirect the Keycloak SSO cookie survives and the next "Sign
    // in" silently re-authenticates without prompting for credentials.
    //
    // We do NOT await this in the non-SSO path so the UI snaps back to
    // /login immediately. For SSO users the IdP navigation requires the
    // post_logout_url from the response body, so we branch on the result.
    void apiLogout().then((res) => {
      const postLogoutUrl = res?.post_logout_url;
      if (postLogoutUrl) {
        // Full page navigation — leaves the SPA so the IdP can clear
        // its session cookies and bounce back to /login. The auth
        // state has already been wiped below; the post-redirect SPA
        // load will see no cookies and render the Login screen.
        window.location.assign(postLogoutUrl);
        return;
      }
    });
    setAuthenticated(false);
    setUser(null);
    navigate("/login");
  }

  if (authenticated === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div
            className="w-8 h-8 rounded-full animate-spin mx-auto mb-4"
            style={{
              border: "3px solid var(--color-border)",
              borderTopColor: "var(--color-accent)",
            }}
          />
          <p className="text-txt-secondary text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <SessionManagerProvider
        canShare={!!user?.can_manage_system || !!user?.can_create_sharing_profiles}
        canUseQuickShare={!!user?.can_manage_system || !!user?.can_use_quick_share}
        canUseQuickShareOutbound={!!user?.can_manage_system || !!user?.can_use_quick_share_outbound}
        outboundShareBypass={user?.outbound_share_requires_approval === false}
      >
        {!authenticated ? (
          <Routes>
            <Route path="/login" element={<Login onLogin={handleLogin} />} />
            <Route path="/shared/:shareToken" element={<SharedViewer />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        ) : (
          <SettingsProvider>
            <UserPreferencesProvider>
              {user?.terms_accepted_version !== TERMS_VERSION ? (
                <DisclaimerModal
                  onAccept={() =>
                    setUser((u) =>
                      u
                        ? {
                            ...u,
                            terms_accepted_at: new Date().toISOString(),
                            terms_accepted_version: TERMS_VERSION,
                          }
                        : u
                    )
                  }
                  onDecline={handleLogout}
                />
              ) : (
                <CommandPaletteProvider>
                  <Routes>
                    <Route element={<Layout user={user} onLogout={handleLogout} />}>
                      <Route path="/" element={<Dashboard />} />
                      <Route
                        path="/credentials"
                        element={
                          user?.vault_configured ? (
                            <Credentials vaultConfigured={true} />
                          ) : (
                            <Navigate to="/" replace />
                          )
                        }
                      />
                      <Route
                        path="/admin"
                        element={
                          user?.can_manage_system ||
                          user?.can_manage_users ||
                          user?.can_manage_connections ||
                          user?.can_create_users ||
                          user?.can_create_user_groups ||
                          user?.can_create_connections ||
                          user?.can_create_sharing_profiles ? (
                            <AdminSettings user={user} />
                          ) : (
                            <Navigate to="/" replace />
                          )
                        }
                      />
                      <Route path="/session/:connectionId" element={<SessionClient />} />
                      <Route path="/tiled" element={<TiledView />} />
                      <Route
                        path="/observe/:sessionId"
                        element={
                          user?.can_manage_system ||
                          user?.can_view_audit_logs ||
                          user?.can_view_sessions ? (
                            <NvrPlayer />
                          ) : (
                            <Navigate to="/" replace />
                          )
                        }
                      />
                      <Route
                        path="/audit"
                        element={
                          user?.can_manage_system || user?.can_view_audit_logs ? (
                            <AuditLogs />
                          ) : (
                            <Navigate to="/" replace />
                          )
                        }
                      />
                      <Route
                        path="/sessions"
                        element={
                          user?.can_view_sessions ||
                          user?.can_manage_system ||
                          user?.can_view_audit_logs ? (
                            <Sessions user={user} />
                          ) : (
                            <Navigate to="/" replace />
                          )
                        }
                      />
                      <Route
                        path="/approvals"
                        element={
                          user?.vault_configured ? (
                            <Approvals user={user} />
                          ) : (
                            <Navigate to="/" replace />
                          )
                        }
                      />
                      <Route path="/docs" element={<Documentation user={user} />} />
                      <Route path="/profile" element={<Profile />} />
                    </Route>
                    <Route path="/shared/:shareToken" element={<SharedViewer />} />
                    <Route path="/login" element={<Navigate to="/" replace />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                  <SessionBar />
                  <SessionTimeoutWarning onExpired={handleLogout} />
                  {user?.vault_configured && <CredentialProfileExpiryWatcher />}
                  {user && (user.is_approver || user.is_outbound_approver) && (
                    <PendingApprovalWatcher user={user} />
                  )}
                  <WhatsNewModal userId={user?.id} />
                  <VersionWatcher />
                </CommandPaletteProvider>
              )}
            </UserPreferencesProvider>
          </SettingsProvider>
        )}
      </SessionManagerProvider>
    </ToastProvider>
  );
}
