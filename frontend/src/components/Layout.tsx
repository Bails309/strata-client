/* eslint-disable react-hooks/set-state-in-effect --
   react-hooks v7 compiler-strict suppressions: legitimate prop->state sync, session
   decoration, or render-time time/derivation patterns. See
   eslint.config.js W4-1 commentary. */
import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useTheme } from "./ThemeProvider";
import { MeResponse } from "../api";
import AdminMegaMenu from "./AdminMegaMenu";
import GlobalHeader from "./GlobalHeader";
import DashboardBackground from "./DashboardBackground";
import { SidebarFooter } from "./layout/sidebar/SidebarFooter";
import SidebarNav from "./layout/sidebar/SidebarNav";
import "./layout/sidebar/Sidebar.css";
import { useLeases, useNow, isLeaseExpired } from "./leaseStore";

/* ── Sidebar context so other components can read the width ── */
const SidebarContext = createContext(180);
export function useSidebarWidth() {
  return useContext(SidebarContext);
}

const SIDEBAR_EXPANDED = 256;
const SIDEBAR_COLLAPSED = 64;
const COLLAPSED_KEY = "strata-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function Layout({
  user,
  onLogout,
}: {
  user: MeResponse | null;
  onLogout: () => void;
}) {
  const location = useLocation();
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Storage unavailable (private mode); the choice lasts for this page only.
    }
  }, []);
  const inSession = location.pathname.startsWith("/session/");
  const [sessionHidden, setSessionHidden] = useState(true);

  useEffect(() => {
    if (inSession) setSessionHidden(true);
  }, [inSession, location.pathname]);
  const hidden = inSession && sessionHidden;

  // ── Admin Mega-Menu Flyout state ──
  const [isMegaMenuOpen, setIsMegaMenuOpen] = useState(false);
  const [isKeyboardTriggered, setIsKeyboardTriggered] = useState(false);
  const [adminItemTop, setAdminItemTop] = useState(140);
  const adminItemRef = useRef<HTMLAnchorElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 150ms intent debounce for hover
  const handleAdminMouseEnter = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      if (adminItemRef.current) {
        const rect = adminItemRef.current.getBoundingClientRect();
        setAdminItemTop(rect.top);
      }
      setIsKeyboardTriggered(false);
      setIsMegaMenuOpen(true);
    }, 150);
  }, []);

  const handleAdminMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setIsMegaMenuOpen(false);
    }, 150);
  }, []);

  const handleMegaMenuMouseEnter = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  const handleMegaMenuMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setIsMegaMenuOpen(false);
    }, 150);
  }, []);

  const handleAdminClick = () => {
    // If clicking on Admin, toggle the mega menu
    if (adminItemRef.current) {
      const rect = adminItemRef.current.getBoundingClientRect();
      setAdminItemTop(rect.top);
    }
    setIsMegaMenuOpen((prev) => !prev);
  };

  const handleAdminKeyDown = (e: React.KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
      e.preventDefault();
      if (adminItemRef.current) {
        const rect = adminItemRef.current.getBoundingClientRect();
        setAdminItemTop(rect.top);
      }
      setIsKeyboardTriggered(true);
      setIsMegaMenuOpen(true);
    }
  };

  const openMegaMenuFrom = (anchor: HTMLElement) => {
    setAdminItemTop(anchor.getBoundingClientRect().top);
    setIsKeyboardTriggered(true);
    setIsMegaMenuOpen(true);
  };

  // Close mega menu when navigating
  useEffect(() => {
    setIsMegaMenuOpen(false);
  }, [location.pathname]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  // ── Draggable chevron position for sessions ──
  const [chevronOffsetY, setChevronOffsetY] = useState(0);
  const [chevronDragging, setChevronDragging] = useState(false);
  const chevronDragRef = useRef<{ startY: number; startOffset: number } | null>(null);
  const chevronWasDragRef = useRef(false);

  const onChevronPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    chevronDragRef.current = { startY: e.clientY, startOffset: chevronOffsetY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onChevronPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!chevronDragRef.current) return;
    if (!chevronDragging) setChevronDragging(true);
    const delta = e.clientY - chevronDragRef.current.startY;
    const maxOffset = window.innerHeight / 2 - 48;
    setChevronOffsetY(
      Math.max(-maxOffset, Math.min(maxOffset, chevronDragRef.current.startOffset + delta))
    );
  };
  const onChevronPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!chevronDragRef.current) return;
    chevronWasDragRef.current = Math.abs(e.clientY - chevronDragRef.current.startY) >= 4;
    chevronDragRef.current = null;
    setChevronDragging(false);
  };
  const chevronClickGuard = (action: () => void) => () => {
    if (chevronWasDragRef.current) {
      chevronWasDragRef.current = false;
      return;
    }
    action();
  };

  const sidebarWidth = hidden ? 0 : collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED;
  const layoutSidebarWidth = inSession ? 0 : sidebarWidth;
  const { theme, cycle } = useTheme();

  // Active checkouts count
  const { profiles } = useLeases();
  const now = useNow(30_000);
  const activeCheckoutsCount = profiles
    ? profiles.filter((p) => !isLeaseExpired(p, now)).length
    : 0;

  // Real-time engine telemetry latency (ms) from Tokio session daemon
  const [engineLatencyMs, setEngineLatencyMs] = useState<number>(8);
  useEffect(() => {
    let mounted = true;
    const probe = async () => {
      try {
        const start = performance.now();
        const res = await fetch("/api/health", { method: "GET", cache: "no-store" });
        if (res.ok && mounted) {
          const rtt = Math.max(1, Math.round(performance.now() - start));
          setEngineLatencyMs(rtt);
        }
      } catch {
        // Fallback or keep current
      }
    };
    probe();
    const interval = setInterval(probe, 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Real-time online status
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return (
    <SidebarContext.Provider value={layoutSidebarWidth}>
      <div className="flex min-h-screen">
        {/* Skip to content */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[10001] focus:px-3 focus:py-2 focus:rounded focus:bg-bg-elevated focus:text-txt-primary focus:outline focus:outline-2 focus:outline-accent"
        >
          Skip to main content
        </a>

        {/* Layered canvas + constellation behind the workspace */}
        {!inSession && <DashboardBackground />}

        {/* Floating "show sidebar" chevron in session */}
        {hidden && (
          <button
            onClick={chevronClickGuard(() => setSessionHidden(false))}
            onPointerDown={onChevronPointerDown}
            onPointerMove={onChevronPointerMove}
            onPointerUp={onChevronPointerUp}
            title="Drag to reposition · Click to show menu"
            aria-label="Show menu"
            className={`fixed left-0 z-[60] flex items-center justify-center w-6 h-16 rounded-r-md text-txt-secondary hover:text-txt-primary shadow-lg ${chevronDragging ? "" : "transition-all duration-150"}`}
            style={{
              top: `calc(50% + ${chevronOffsetY}px)`,
              transform: "translateY(-50%)",
              cursor: "grab",
              touchAction: "none",
              background: theme === "dark" ? "rgba(15, 15, 20, 0.75)" : "rgba(255, 255, 255, 0.75)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              border:
                theme === "dark"
                  ? "1px solid rgba(255, 255, 255, 0.08)"
                  : "1px solid rgba(0, 0, 0, 0.08)",
              borderLeft: "none",
            }}
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

        {/* Floating "hide sidebar" chevron in session */}
        {inSession && !hidden && (
          <button
            onClick={chevronClickGuard(() => setSessionHidden(true))}
            onPointerDown={onChevronPointerDown}
            onPointerMove={onChevronPointerMove}
            onPointerUp={onChevronPointerUp}
            title="Drag to reposition · Click to hide menu"
            aria-label="Hide menu"
            className={`fixed z-[60] w-8 h-24 flex items-center justify-center rounded-r-xl text-txt-secondary hover:text-txt-primary ${chevronDragging ? "" : "transition-all duration-200"}`}
            style={{
              left: sidebarWidth,
              top: `calc(50% + ${chevronOffsetY}px)`,
              transform: "translateY(-50%)",
              cursor: "grab",
              touchAction: "none",
              background: theme === "dark" ? "rgba(15, 15, 20, 0.75)" : "rgba(255, 255, 255, 0.75)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",
              border:
                theme === "dark"
                  ? "1px solid rgba(255, 255, 255, 0.08)"
                  : "1px solid rgba(0, 0, 0, 0.08)",
              borderLeft: "none",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}

        {/* ── Single Primary Rail Sidebar (72px collapsed / 240px expanded) ── */}
        <aside
          className={`strata-sidebar fixed top-0 left-0 bottom-0 z-50 flex flex-col justify-between overflow-visible transition-[width] duration-200 ease-out ${inSession ? "is-session" : ""}`}
          style={{
            width: sidebarWidth,
            pointerEvents: hidden ? "none" : "auto",
            padding: 0,
            background: inSession
              ? theme === "dark"
                ? "rgba(15, 15, 20, 0.75)"
                : "rgba(255, 255, 255, 0.75)"
              : "var(--color-nav-bg)",
            backdropFilter: inSession ? "blur(16px)" : undefined,
            WebkitBackdropFilter: inSession ? "blur(16px)" : undefined,
            borderRight: hidden
              ? "none"
              : inSession
                ? theme === "dark"
                  ? "1px solid rgba(255, 255, 255, 0.08)"
                  : "1px solid rgba(0, 0, 0, 0.08)"
                : "1px solid var(--color-nav-border)",
            boxShadow: inSession && !hidden ? "10px 0 30px rgba(0, 0, 0, 0.4)" : undefined,
          }}
        >
          <div
            className="sb-scroll"
            style={{
              padding: hidden ? 0 : collapsed ? "0.75rem 0.5rem" : "0.75rem",
            }}
          >
            <SidebarNav
              user={user}
              isCollapsed={collapsed}
              isDark={theme === "dark"}
              onExpand={() => setCollapsed(false)}
              admin={{
                ref: adminItemRef,
                onMouseEnter: handleAdminMouseEnter,
                onMouseLeave: handleAdminMouseLeave,
                onClick: handleAdminClick,
                onKeyDown: handleAdminKeyDown,
                openFrom: openMegaMenuFrom,
              }}
            />
          </div>

          {/* ── Sidebar Footer (User Profile Card, Slide-Up Account Popover, Utility Dock) ── */}
          <SidebarFooter
            displayName={user?.full_name || user?.username || "Guest"}
            roleName={user?.role || "User"}
            email={(user as any)?.email || (user?.username ? `${user.username}@strataclient.io` : "admin@strataclient.io")}
            isOnline={isOnline}
            isCollapsed={collapsed}
            isDark={theme === "dark"}
            onToggleTheme={cycle}
            onToggleCollapse={() => setCollapsed(!collapsed)}
            onSignOut={onLogout}
            activeCheckoutsCount={activeCheckoutsCount}
            engineLatencyMs={engineLatencyMs}
          />
        </aside>

        {/* ── Admin Mega-Menu Flyout (Floating panel docked to primary rail's Admin item) ── */}
        <AdminMegaMenu
          isOpen={isMegaMenuOpen}
          onClose={() => setIsMegaMenuOpen(false)}
          user={user}
          sidebarWidth={sidebarWidth}
          anchorTop={adminItemTop}
          onMouseEnter={handleMegaMenuMouseEnter}
          onMouseLeave={handleMegaMenuMouseLeave}
          isKeyboardTriggered={isKeyboardTriggered}
          theme={theme}
        />

        {/* ── Flexible Workspace Grid Area (flex: 1 with full horizontal width) ── */}
        <div
          className="flex-1 flex flex-col min-w-0 min-h-screen transition-[margin-left] duration-200 ease-out"
          style={{ marginLeft: layoutSidebarWidth }}
        >
          {/* ── Global Top Header with Breadcrumbs ── */}
          {!inSession && <GlobalHeader user={user} />}

          {/* ── Main Content Region ── */}
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 w-full max-w-full animate-fade-in"
            style={{ padding: inSession ? 0 : "2rem 2.5rem" }}
          >
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}
