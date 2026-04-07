import { createContext, useContext, useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useTheme } from './ThemeProvider';

/* ── Sidebar context so other components can read the width ── */
const SidebarContext = createContext(180);
export function useSidebarWidth() { return useContext(SidebarContext); }

const SIDEBAR_EXPANDED = 180;
const SIDEBAR_COLLAPSED = 56;

const NAV_ITEMS = [
  { to: '/', label: 'Connections', icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M12 5l7 7-7 7"/>
    </svg>
  )},
  { to: '/admin', label: 'Admin', icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  )},
  { to: '/audit', label: 'Audit Logs', icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7h8M8 12h8M8 17h5"/>
    </svg>
  )},
];

export default function Layout({ onLogout }: { onLogout: () => void }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const sidebarWidth = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED;
  const { theme, preference, cycle } = useTheme();

  return (
    <SidebarContext.Provider value={sidebarWidth}>
      <div className="flex min-h-screen">
        {/* ── Sidebar ── */}
        <aside
          className="fixed top-0 left-0 bottom-0 z-50 flex flex-col justify-between overflow-hidden transition-[width] duration-200 ease-out"
          style={{
            width: sidebarWidth,
            padding: collapsed ? '1.25rem 0.5rem' : '1.25rem 0.75rem',
            background: 'var(--color-nav-bg)',
            borderRight: '1px solid var(--color-nav-border)',
          }}
        >
          <div className="flex flex-col gap-6">
            {/* Brand */}
            <Link to="/" className={`flex items-center gap-2 no-underline p-1 ${collapsed ? 'justify-center' : ''}`}>
              <div className="w-7 h-7 rounded-lg shrink-0 flex items-center justify-center text-white text-xs font-extrabold tracking-tighter"
                style={{ background: 'var(--color-accent)' }}>
                S
              </div>
              {!collapsed && <span className="text-base font-bold tracking-tight text-txt-primary">Strata</span>}
              {!collapsed && (
                <span className="text-[0.55rem] font-semibold text-accent-light bg-accent-dim px-1.5 py-0.5 rounded-full uppercase tracking-wide">
                  Client
                </span>
              )}
            </Link>

            {/* Navigation */}
            <nav className="flex flex-col gap-0.5">
              {NAV_ITEMS.map((item) => {
                const active = item.to === '/'
                  ? location.pathname === '/' || location.pathname.startsWith('/session/')
                  : location.pathname.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`flex items-center gap-2.5 rounded-sm no-underline text-[0.8125rem] font-medium transition-all duration-150
                      ${collapsed ? 'justify-center p-2' : 'py-2 px-2.5'}
                      ${active
                        ? 'text-txt-primary bg-accent-dim font-semibold'
                        : 'text-txt-secondary hover:text-txt-primary hover:bg-nav-link-hover'
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
          <div className="flex flex-col items-center gap-2 pt-4" style={{ borderTop: '1px solid var(--color-border)' }}>
            {!collapsed && (
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold text-white"
                style={{ background: 'var(--color-accent)' }}>
                S
              </div>
            )}
            {!collapsed && (
              <div className="flex items-center gap-1.5 text-[0.7rem] text-txt-tertiary">
                <div className="w-1.5 h-1.5 rounded-full bg-success" style={{ boxShadow: '0 0 8px rgba(52, 211, 153, 0.4)' }} />
                Connected
              </div>
            )}
            {!collapsed && (
              <button className="btn-ghost w-full text-xs text-center" onClick={onLogout}>Sign Out</button>
            )}

            {/* Theme toggle */}
            <button
              className="w-full flex items-center justify-center gap-2 text-txt-secondary hover:text-txt-primary rounded-sm cursor-pointer transition-all duration-150 p-2 hover:bg-nav-link-hover"
              onClick={cycle}
              title={`Theme: ${preference} (${theme})`}
            >
              {theme === 'dark' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              )}
              {!collapsed && (
                <span className="text-xs capitalize">{preference === 'system' ? 'System' : theme === 'dark' ? 'Dark' : 'Light'}</span>
              )}
            </button>

            {/* Collapse toggle */}
            <button
              className="w-full flex items-center justify-center text-txt-secondary hover:text-txt-primary rounded-sm cursor-pointer transition-all duration-150 p-2 hover:bg-nav-link-hover"
              onClick={() => setCollapsed(!collapsed)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: collapsed ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }}>
                <polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" />
              </svg>
            </button>
          </div>
        </aside>

        {/* ── Main Content ── */}
        <main
          className="flex-1 min-h-screen animate-fade-in transition-[margin-left] duration-200 ease-out"
          style={{ marginLeft: sidebarWidth, padding: '2rem 2.5rem' }}
        >
          <Outlet />
        </main>
      </div>
    </SidebarContext.Provider>
  );
}
