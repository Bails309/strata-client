import { createContext, useContext, useEffect, useState } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";
import { useTheme } from "./ThemeProvider";
import { MeResponse } from "../api";

/* ── Sidebar context so other components can read the width ── */
const SidebarContext = createContext(180);
export function useSidebarWidth() {
  return useContext(SidebarContext);
}

const SIDEBAR_EXPANDED = 200; // Increased slightly for better fit
const SIDEBAR_COLLAPSED = 60;

const NAV_ITEMS = [
  {
    to: "/",
    label: "Connections",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    ),
  },
  {
    to: "/credentials",
    label: "Credentials",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
    ),
  },
  {
    to: "/admin",
    label: "Admin",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
  {
    to: "/audit",
    label: "Audit Logs",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M8 7h8M8 12h8M8 17h5" />
      </svg>
    ),
  },
  {
    to: "/approvals",
    label: "Pending Approvals",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
  {
    to: "/sessions",
    label: "Sessions",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
    ),
  },
  {
    to: "/docs",
    label: "Docs",
    icon: (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z" />
        <path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z" />
      </svg>
    ),
  },
];

export default function Layout({
  user,
  onLogout,
}: {
  user: MeResponse | null;
  onLogout: () => void;
}) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  // When inside a connected session (`/session/:id`), the sidebar is hidden
  // entirely so the remote canvas gets the full viewport width. A floating
  // chevron at the left edge lets the user pull it back in. The hidden state
  // auto-resets when the user navigates away from a session route.
  const inSession = location.pathname.startsWith("/session/");
  const [sessionHidden, setSessionHidden] = useState(true);
  useEffect(() => {
    // Re-hide the sidebar each time the user enters a new session.
    if (inSession) setSessionHidden(true);
  }, [inSession, location.pathname]);
  const hidden = inSession && sessionHidden;
  const sidebarWidth = hidden ? 0 : collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED;
  const { theme, preference, cycle } = useTheme();

  const initial = (user?.full_name || user?.username || "S").charAt(0).toUpperCase();

  return (
    <SidebarContext.Provider value={sidebarWidth}>
      <div className="flex min-h-screen">
        {/* ── Floating "show sidebar" chevron — only visible while in a
             session AND the sidebar is hidden. Mirrors the right-side
             SessionBar collapse handle. ── */}
        {hidden && (
          <button
            onClick={() => setSessionHidden(false)}
            title="Show menu"
            aria-label="Show menu"
            className="fixed top-1/2 left-0 z-[60] -translate-y-1/2 flex items-center justify-center w-6 h-16 rounded-r-md border border-l-0 border-white/10 bg-nav-bg text-txt-secondary hover:text-txt-primary hover:bg-white/5 shadow-lg transition-all duration-150"
            style={{ background: "var(--color-nav-bg)" }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}

        {/* ── Sidebar ── */}
        <aside
          className="fixed top-0 left-0 bottom-0 z-50 flex flex-col justify-between overflow-hidden transition-[width] duration-200 ease-out"
          style={{
            width: sidebarWidth,
            padding: hidden ? 0 : collapsed ? "1.25rem 0.5rem" : "1.25rem 0.75rem",
            background: "var(--color-nav-bg)",
            borderRight: hidden ? "none" : "1px solid var(--color-nav-border)",
          }}
        >
          <div className="flex flex-col gap-6">
            {/* Brand */}
            <Link
              to="/"
              className={`flex items-center gap-2 no-underline p-1 ${collapsed ? "justify-center" : ""}`}
            >
              <img
                src={theme === "dark" ? "/logo-dark.png" : "/logo-light.png"}
                alt="Strata Client"
                className="shrink-0 w-full"
              />
            </Link>

            {/* Navigation */}
            <nav className="flex flex-col gap-0.5">
              {NAV_ITEMS.filter((item) => {
                if (item.to === "/admin") {
                  return (
                    user?.can_manage_system ||
                    user?.can_manage_users ||
                    user?.can_manage_connections ||
                    user?.can_create_users ||
                    user?.can_create_user_groups ||
                    user?.can_create_connections
                  );
                }
                if (item.to === "/audit") {
                  return user?.can_manage_system || user?.can_view_audit_logs;
                }
                if (item.to === "/admin/sessions") {
                  return user?.can_manage_system;
                }
                if (item.to === "/sessions") {
                  return (
                    user?.can_view_sessions || user?.can_manage_system || user?.can_view_audit_logs
                  );
                }
                if (item.to === "/credentials") {
                  return user?.vault_configured;
                }
                if (item.to === "/approvals") {
                  return user?.vault_configured && user?.is_approver;
                }
                return true;
              }).map((item) => {
                const active =
                  item.to === "/"
                    ? location.pathname === "/" || location.pathname.startsWith("/session/")
                    : item.to === "/admin"
                      ? location.pathname === "/admin" || location.pathname.startsWith("/admin/")
                      : location.pathname.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`flex items-center gap-2.5 rounded-sm no-underline text-[0.8125rem] font-medium transition-all duration-150
                      ${collapsed ? "justify-center p-2.5" : "py-2 px-2.5"}
                      ${
                        active
                          ? "text-txt-primary bg-accent-dim font-semibold"
                          : "text-txt-secondary hover:text-txt-primary hover:bg-nav-link-hover"
                      }`}
                    title={collapsed ? item.label : undefined}
                  >
                    {item.icon}
                    {!collapsed && item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Bottom section */}
          <div
            className="flex flex-col gap-3 pt-4"
            style={{ borderTop: "1px solid var(--color-border)" }}
          >
            {/* User Profile */}
            <div className={`flex items-center gap-2.5 ${collapsed ? "justify-center" : "px-2.5"}`}>
              <div className="user-avatar-premium mesh-gradient w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold text-white shrink-0">
                {initial}
                <div className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-success border border-nav-bg" />
              </div>
              {!collapsed && (
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-semibold text-txt-primary truncate">
                    {user?.full_name || user?.username || "Guest"}
                  </span>
                  <span className="text-[0.625rem] text-txt-tertiary uppercase tracking-wider">
                    {user?.role || "User"}
                  </span>
                </div>
              )}
            </div>

            {!collapsed && (
              <div className="flex flex-col gap-2 px-2.5">
                <div className="flex items-center gap-1.5 text-[0.65rem] text-txt-tertiary">
                  <div className="w-1 h-1 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]" />
                  System Online
                </div>
                <button
                  className="btn-danger-outline w-full text-[0.7rem] py-2 font-medium"
                  onClick={onLogout}
                >
                  Sign Out
                </button>
              </div>
            )}

            <div className="flex flex-col gap-0.5">
              {/* Theme toggle */}
              <button
                className={`flex items-center gap-2.5 text-txt-secondary hover:text-txt-primary rounded-sm cursor-pointer transition-all duration-150 p-2 hover:bg-nav-link-hover ${collapsed ? "justify-center" : ""}`}
                onClick={cycle}
                title={`Theme: ${preference} (${theme})`}
              >
                {theme === "dark" ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" />
                    <line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" />
                    <line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                )}
                {!collapsed && (
                  <span className="text-[0.75rem] capitalize">
                    {preference === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}
                  </span>
                )}
              </button>

              {/* Collapse toggle */}
              <button
                className={`flex items-center gap-2.5 text-txt-secondary hover:text-txt-primary rounded-sm cursor-pointer transition-all duration-150 p-2 hover:bg-nav-link-hover ${collapsed ? "justify-center" : ""}`}
                onClick={() => setCollapsed(!collapsed)}
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    transform: collapsed ? "rotate(180deg)" : undefined,
                    transition: "transform 0.2s",
                  }}
                >
                  <polyline points="11 17 6 12 11 7" />
                  <polyline points="18 17 13 12 18 7" />
                </svg>
                {!collapsed && <span className="text-[0.75rem]">Collapse</span>}
              </button>

              {/* Hide-completely toggle — only useful while in a session, so
                   it is rendered conditionally to keep the menu uncluttered
                   on regular pages. */}
              {inSession && (
                <button
                  className={`flex items-center gap-2.5 text-txt-secondary hover:text-txt-primary rounded-sm cursor-pointer transition-all duration-150 p-2 hover:bg-nav-link-hover ${collapsed ? "justify-center" : ""}`}
                  onClick={() => setSessionHidden(true)}
                  title="Hide menu (session view)"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  {!collapsed && <span className="text-[0.75rem]">Hide menu</span>}
                </button>
              )}
            </div>
          </div>
        </aside>

        {/* ── Main Content ── */}
        <main
          className="flex-1 min-h-screen animate-fade-in transition-[margin-left] duration-200 ease-out"
          style={{ marginLeft: sidebarWidth, padding: "2rem 2.5rem" }}
        >
          <Outlet />
        </main>
      </div>
    </SidebarContext.Provider>
  );
}
