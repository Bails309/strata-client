import type { ReactNode } from "react";
import type { MeResponse } from "../../../api";
import { isMegaMenuItemVisible } from "../../adminMegaMenuConfig";

export type NavigationSectionKey = "WORKSPACE" | "SECURITY" | "MANAGEMENT" | "RESOURCES";

/** Live counts a nav item can show as a badge. */
export type NavBadgeSource = "approvals" | "sessions";

export interface NavSubItemConfig {
  id: string;
  label: string;
  path: string;
  /** Element id on the target page to scroll to after navigating. */
  anchor?: string;
  visible: (user: MeResponse | null) => boolean;
}

export interface NavItemConfig {
  id: string;
  label: string;
  path: string;
  icon: ReactNode;
  visible: (user: MeResponse | null) => boolean;
  isActive: (pathname: string) => boolean;
  badge?: NavBadgeSource;
  subItems?: NavSubItemConfig[];
}

export interface NavSectionConfig {
  key: NavigationSectionKey;
  title: string;
  items: NavItemConfig[];
}

const svg = (children: ReactNode) => (
  <svg
    className="sb-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

const startsWith = (prefix: string) => (p: string) => p === prefix || p.startsWith(`${prefix}/`);

export const SIDEBAR_NAVIGATION: NavSectionConfig[] = [
  {
    key: "WORKSPACE",
    title: "Workspace",
    items: [
      {
        id: "connections",
        label: "Connections",
        path: "/",
        icon: svg(
          <>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </>
        ),
        visible: () => true,
        isActive: (p) => p === "/" || p.startsWith("/session/") || p === "/tiled",
      },
      {
        id: "sessions",
        label: "Sessions",
        path: "/sessions",
        icon: svg(
          <>
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </>
        ),
        visible: (u) => !!(u?.can_view_sessions || u?.can_manage_system || u?.can_view_audit_logs),
        isActive: startsWith("/sessions"),
        badge: "sessions",
      },
      {
        id: "approvals",
        label: "Pending Approvals",
        path: "/approvals",
        icon: svg(
          <>
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </>
        ),
        visible: (u) => !!((u?.vault_configured && u?.is_approver) || u?.is_outbound_approver),
        isActive: startsWith("/approvals"),
        badge: "approvals",
      },
    ],
  },
  {
    key: "SECURITY",
    title: "Security & Audit",
    items: [
      {
        id: "credentials",
        label: "Credentials & Vault",
        path: "/credentials",
        icon: svg(
          <>
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </>
        ),
        visible: (u) => !!u?.vault_configured,
        isActive: startsWith("/credentials"),
      },
      {
        id: "audit",
        label: "Audit Trail",
        path: "/audit",
        icon: svg(
          <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </>
        ),
        visible: (u) => !!(u?.can_manage_system || u?.can_view_audit_logs),
        isActive: startsWith("/audit"),
      },
    ],
  },
  {
    key: "MANAGEMENT",
    title: "Governance",
    items: [
      {
        id: "admin",
        label: "Platform Admin",
        path: "/admin",
        icon: svg(
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </>
        ),
        visible: (u) =>
          !!(
            u?.can_manage_system ||
            u?.can_manage_users ||
            u?.can_manage_connections ||
            u?.can_create_users ||
            u?.can_create_user_groups ||
            u?.can_create_connections
          ),
        isActive: startsWith("/admin"),
        subItems: [
          {
            id: "admin-connections",
            label: "Fleet Endpoints",
            path: "/admin/connections",
            visible: (u) => isMegaMenuItemVisible("connections", u),
          },
          {
            id: "admin-folders",
            label: "Connection Folders",
            path: "/admin/connections",
            anchor: "connection-folders",
            visible: (u) => isMegaMenuItemVisible("connections", u),
          },
          {
            id: "admin-roles",
            label: "Roles & RBAC",
            path: "/admin/access",
            visible: (u) => isMegaMenuItemVisible("access", u),
          },
        ],
      },
    ],
  },
  {
    key: "RESOURCES",
    title: "Resources",
    items: [
      {
        id: "docs",
        label: "Documentation",
        path: "/docs",
        icon: svg(
          <>
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </>
        ),
        visible: () => true,
        isActive: startsWith("/docs"),
      },
    ],
  },
];

/** Sections with the items this user may see; empty sections are dropped. */
export function visibleSections(user: MeResponse | null): NavSectionConfig[] {
  return SIDEBAR_NAVIGATION.map((s) => ({
    ...s,
    items: s.items
      .filter((i) => i.visible(user))
      .map((i) => (i.subItems ? { ...i, subItems: i.subItems.filter((x) => x.visible(user)) } : i)),
  })).filter((s) => s.items.length > 0);
}
