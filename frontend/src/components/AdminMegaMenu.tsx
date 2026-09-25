import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { MeResponse } from "../api";
import { useTheme } from "./ThemeProvider";
import {
  ADMIN_MEGA_MENU_COLUMNS,
  isMegaMenuItemVisible,
  MegaMenuItem,
  ROUTE_TO_ADMIN_TAB,
  getAdminTabFromPath,
} from "./adminMegaMenuConfig";

export function MegaMenuIcon({ name }: { name: string }) {
  switch (name) {
    case "ShieldCheck":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <polyline points="9 12 11 14 15 10" />
        </svg>
      );
    case "RefreshCw":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      );
    case "Key":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      );
    case "Lock":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      );
    case "FileText":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      );
    case "Clock":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "Share2":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      );
    case "ExternalLink":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      );
    case "Globe":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case "Award":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="12" cy="8" r="7" />
          <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
        </svg>
      );
    case "Monitor":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      );
    case "Layout":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
      );
    case "Tag":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
          <line x1="7" y1="7" x2="7.01" y2="7" />
        </svg>
      );
    case "Bell":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case "Video":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      );
    case "List":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      );
    case "Link":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      );
    case "BarChart2":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      );
    case "Activity":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      );
    case "Database":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      );
    case "Shield":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case "FileX":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9.5" y1="12.5" x2="14.5" y2="17.5" />
          <line x1="14.5" y1="12.5" x2="9.5" y2="17.5" />
        </svg>
      );
    default:
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      );
  }
}

interface AdminMegaMenuProps {
  isOpen: boolean;
  onClose: () => void;
  user: MeResponse | null;
  sidebarWidth: number;
  anchorTop?: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onSelectTab?: (tab: string) => void;
  isKeyboardTriggered?: boolean;
  theme?: "light" | "dark";
}

export default function AdminMegaMenu({
  isOpen,
  onClose,
  user,
  sidebarWidth,
  anchorTop = 140,
  onMouseEnter,
  onMouseLeave,
  onSelectTab,
  isKeyboardTriggered = false,
  theme: propTheme,
}: AdminMegaMenuProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [filterQuery, setFilterQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  // Determine active theme (from props, ThemeProvider context, or DOM fallback)
  let contextTheme: "light" | "dark" = "dark";
  try {
    const ctx = useTheme();
    if (ctx?.theme) contextTheme = ctx.theme;
  } catch {
    if (typeof document !== "undefined" && document.documentElement.classList.contains("light")) {
      contextTheme = "light";
    }
  }
  const currentTheme = propTheme || contextTheme;
  const isDark = currentTheme === "dark";

  // Focus search input when opened via keyboard
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        if (isKeyboardTriggered || searchInputRef.current) {
          searchInputRef.current?.focus();
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, isKeyboardTriggered]);

  const handleClose = useCallback(() => {
    setFilterQuery("");
    onClose();
  }, [onClose]);

  // Handle global Escape and Click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
      // Shortcut to focus search when inside menu: Cmd+K / Ctrl+K
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    const handlePointerDownOutside = (e: PointerEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDownOutside);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDownOutside);
    };
  }, [isOpen, handleClose]);

  // Filter columns based on user permissions and search query
  const filteredColumns = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return ADMIN_MEGA_MENU_COLUMNS.map((col) => {
      const filteredCategories = col.categories
        .map((cat) => {
          const visibleItems = cat.items.filter((item) => isMegaMenuItemVisible(item.id, user));
          const matchedItems = q
            ? visibleItems.filter((item) => item.label.toLowerCase().includes(q))
            : visibleItems;
          return {
            category: cat.category,
            items: matchedItems,
          };
        })
        .filter((cat) => cat.items.length > 0);

      return {
        categories: filteredCategories,
      };
    }).filter((col) => col.categories.length > 0);
  }, [filterQuery, user]);

  const hasItems = useMemo(
    () => filteredColumns.some((col) => col.categories.some((cat) => cat.items.length > 0)),
    [filteredColumns]
  );

  const currentTab = getAdminTabFromPath(location.pathname);

  if (!isOpen) return null;

  const handleItemClick = (item: MegaMenuItem) => {
    if (onSelectTab) {
      const tabName = ROUTE_TO_ADMIN_TAB[item.route] || item.id;
      onSelectTab(tabName);
    }
    navigate(item.route);
    handleClose();
  };

  // Clamped top offset so menu does not overflow window top/bottom
  const clampedTop = Math.max(16, Math.min(anchorTop - 40, window.innerHeight - 560));

  return (
    <div
      ref={menuContainerRef}
      tabIndex={-1}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="menu"
      aria-label="Admin Navigation Mega-Menu"
      className={`fixed z-[1000] w-[780px] max-w-[calc(100vw-100px)] rounded-xl border shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 ${
        isDark ? "border-[rgba(58,206,239,0.18)] text-white" : "border-slate-200/90 text-slate-800"
      }`}
      style={{
        left: sidebarWidth + 8,
        top: clampedTop,
        background: isDark ? "rgba(11, 19, 31, 0.96)" : "rgba(255, 255, 255, 0.98)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: isDark
          ? "0 24px 48px -12px rgba(0, 0, 0, 0.65), 0 0 15px -3px rgba(58, 206, 239, 0.25)"
          : "0 20px 40px -10px rgba(0, 0, 0, 0.14), 0 0 0 1px rgba(0, 0, 0, 0.06)",
      }}
    >
      {/* ── Header Slot: Integrated Search Input ── */}
      <div
        className={`p-3 border-b ${
          isDark ? "border-white/10 bg-white/[0.02]" : "border-slate-200/80 bg-slate-50/70"
        }`}
      >
        <div className="relative flex items-center">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`absolute left-3 w-4 h-4 pointer-events-none ${
              isDark ? "text-[#94A3B8]" : "text-slate-400"
            }`}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Filter settings... [Cmd+K]"
            className={`w-full text-sm rounded-lg pl-9 pr-14 py-2 border transition-all focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent ${
              isDark
                ? "bg-white/[0.04] text-txt-primary placeholder-[#94A3B8]/60 border-white/10"
                : "bg-white text-slate-900 placeholder-slate-400 border-slate-200 shadow-xs"
            }`}
            aria-label="Filter administration settings"
          />
          <span
            className={`absolute right-3 px-1.5 py-0.5 rounded text-[10px] font-mono select-none border ${
              isDark
                ? "text-[#94A3B8] bg-white/[0.06] border-white/10"
                : "text-slate-500 bg-slate-100 border-slate-200"
            }`}
          >
            ⌘K
          </span>
        </div>
      </div>

      {/* ── Column Taxonomy: CSS Grid 3 Columns ── */}
      <div className="p-5 grid grid-cols-3 gap-6 max-h-[70vh] overflow-y-auto">
        {!hasItems ? (
          <div
            className={`col-span-3 py-8 text-center text-sm ${
              isDark ? "text-[#94A3B8]" : "text-slate-500"
            }`}
          >
            No settings found matching &ldquo;{filterQuery}&rdquo;
          </div>
        ) : (
          filteredColumns.map((col, colIdx) => (
            <div key={colIdx} className="flex flex-col gap-6">
              {col.categories.map((group) => (
                <div key={group.category} className="flex flex-col">
                  {/* Category Heading: 11px uppercase, medium weight */}
                  <div
                    className={`text-[11px] uppercase tracking-wider mb-2.5 px-2 select-none ${
                      isDark
                        ? "text-[#94A3B8] opacity-60 font-medium"
                        : "text-slate-500 font-semibold"
                    }`}
                  >
                    {group.category}
                  </div>

                  {/* Items List */}
                  <div className="flex flex-col gap-1" role="none">
                    {group.items.map((item) => {
                      const itemTab = ROUTE_TO_ADMIN_TAB[item.route] || item.id;
                      const isActive =
                        location.pathname === item.route ||
                        (currentTab !== "" && currentTab === itemTab);

                      return (
                        <button
                          key={item.id}
                          role="menuitem"
                          onClick={() => handleItemClick(item)}
                          className={`h-9 px-2 flex items-center justify-between rounded-sm text-[13px] transition-all duration-150 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 select-none ${
                            isActive
                              ? isDark
                                ? "text-[#FFFFFF] font-medium"
                                : "text-accent font-semibold"
                              : isDark
                                ? "text-[#94A3B8] hover:text-[#FFFFFF] hover:bg-white/[0.05]"
                                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                          }`}
                          style={{
                            borderLeft: isActive
                              ? "3px solid var(--color-accent)"
                              : "3px solid transparent",
                            background: isActive
                              ? "linear-gradient(90deg, var(--color-accent-dim) 0%, transparent 100%)"
                              : undefined,
                            paddingLeft: isActive ? "5px" : "8px",
                          }}
                          title={item.label}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={`shrink-0 transition-colors ${
                                isActive
                                  ? "text-accent"
                                  : isDark
                                    ? "text-[#94A3B8] group-hover:text-white"
                                    : "text-slate-400 group-hover:text-slate-700"
                              }`}
                            >
                              <MegaMenuIcon name={item.icon} />
                            </span>
                            <span className="truncate">{item.label}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* ── Footer hints ── */}
      <div
        className={`px-5 py-2.5 border-t flex items-center justify-between text-[11px] ${
          isDark
            ? "border-white/5 bg-white/[0.01] text-[#94A3B8]/70"
            : "border-slate-200/80 bg-slate-50/70 text-slate-500"
        }`}
      >
        <span>
          Press{" "}
          <kbd
            className={`px-1 py-0.5 rounded text-[10px] font-mono border ${
              isDark
                ? "bg-white/5 border-white/10 text-[#94A3B8]"
                : "bg-white border-slate-200 text-slate-600 shadow-2xs"
            }`}
          >
            Esc
          </kbd>{" "}
          to close
        </span>
        <span>Reclaim 250px+ layout flow</span>
      </div>
    </div>
  );
}
