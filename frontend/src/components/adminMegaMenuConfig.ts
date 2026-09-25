import { MeResponse } from "../api";

export interface MegaMenuItem {
  id: string;
  label: string;
  icon: string;
  route: string;
}

export interface MegaMenuCategory {
  category: string;
  items: MegaMenuItem[];
}

export interface MegaMenuColumn {
  categories: MegaMenuCategory[];
}

export const ADMIN_MEGA_MENU_COLUMNS: MegaMenuColumn[] = [
  {
    categories: [
      {
        category: "Identity & Access",
        items: [
          { id: "access", label: "Access", icon: "ShieldCheck", route: "/admin/access" },
          { id: "ad-sync", label: "AD Sync", icon: "RefreshCw", route: "/admin/ad-sync" },
          { id: "sso-oidc", label: "SSO / OIDC", icon: "Key", route: "/admin/sso" },
          { id: "kerberos", label: "Kerberos", icon: "Lock", route: "/admin/kerberos" },
          {
            id: "password-mgmt",
            label: "Password Mgmt",
            icon: "FileText",
            route: "/admin/passwords",
          },
          { id: "safeguard-jit", label: "Safeguard JIT", icon: "Clock", route: "/admin/jit" },
          {
            id: "outbound-share",
            label: "Outbound Share Policy",
            icon: "Share2",
            route: "/admin/sharing",
          },
        ],
      },
    ],
  },
  {
    categories: [
      {
        category: "Network & Connectivity",
        items: [
          { id: "network", label: "Network", icon: "Globe", route: "/admin/network" },
          { id: "dmz-links", label: "DMZ Links", icon: "ExternalLink", route: "/admin/dmz" },
          { id: "trusted-cas", label: "Trusted CAs", icon: "Award", route: "/admin/cas" },
          { id: "vdi", label: "VDI", icon: "Monitor", route: "/admin/vdi" },
          { id: "connections", label: "Connections", icon: "Link", route: "/admin/connections" },
        ],
      },
      {
        category: "Secrets & Security",
        items: [
          { id: "vault", label: "Vault", icon: "Database", route: "/admin/vault" },
          {
            id: "av-blocked",
            label: "AV-Blocked Files",
            icon: "FileX",
            route: "/admin/av-blocked",
          },
          { id: "security", label: "Security", icon: "Shield", route: "/admin/security" },
        ],
      },
    ],
  },
  {
    categories: [
      {
        category: "Overview",
        items: [
          { id: "health", label: "Health", icon: "Activity", route: "/admin/health" },
          { id: "sessions", label: "Sessions", icon: "BarChart2", route: "/admin/sessions" },
        ],
      },
      {
        category: "Workspace",
        items: [
          { id: "display", label: "Display", icon: "Layout", route: "/admin/display" },
          { id: "tags", label: "Tags", icon: "Tag", route: "/admin/tags" },
          {
            id: "notifications",
            label: "Notifications",
            icon: "Bell",
            route: "/admin/notifications",
          },
          { id: "recordings", label: "Recordings", icon: "Video", route: "/admin/recordings" },
        ],
      },
    ],
  },
];

export const ADMIN_MEGA_MENU_CONFIG: MegaMenuCategory[] = ADMIN_MEGA_MENU_COLUMNS.flatMap(
  (col) => col.categories
);

export function isMegaMenuItemVisible(id: string, user: MeResponse | null): boolean {
  if (!user) return false;
  if (id === "access") {
    return !!(
      user.can_manage_system ||
      user.can_manage_users ||
      user.can_manage_connections ||
      user.can_create_users ||
      user.can_create_user_groups ||
      user.can_create_connections ||
      user.can_create_sharing_profiles
    );
  }
  if (id === "tags") return !!(user.can_manage_system || user.can_manage_connections);
  if (id === "recordings") return !!(user.can_manage_system || user.can_view_sessions);
  if (id === "audit-logs") return !!(user.can_manage_system || user.can_view_audit_logs);
  if (id === "sessions") return !!(user.can_manage_system || user.can_view_audit_logs);
  if (id === "av-blocked") return !!(user.can_manage_system || user.can_view_audit_logs);
  if (id === "connections") {
    return !!(user.can_manage_system || user.can_manage_connections || user.can_create_connections);
  }
  if (id === "outbound-share") return !!user.can_manage_system;
  if (id === "vault" || id === "security") return !!user.can_manage_system;
  return !!user.can_manage_system;
}

export const ROUTE_TO_ADMIN_TAB: Record<string, string> = {
  "/admin/access": "access",
  "/admin/ad-sync": "ad-sync",
  "/admin/sso": "sso",
  "/admin/kerberos": "kerberos",
  "/admin/passwords": "passwords",
  "/admin/jit": "safeguard",
  "/admin/safeguard": "safeguard",
  "/admin/sharing": "outbound-shares",
  "/admin/outbound-shares": "outbound-shares",
  "/admin/dmz": "dmz-links",
  "/admin/dmz-links": "dmz-links",
  "/admin/network": "network",
  "/admin/cas": "trusted-cas",
  "/admin/trusted-cas": "trusted-cas",
  "/admin/vdi": "vdi",
  "/admin/display": "display",
  "/admin/tags": "tags",
  "/admin/notifications": "notifications",
  "/admin/recordings": "recordings",
  "/admin/audit": "audit",
  "/admin/connections": "connections",
  // direct tab names
  "/admin/health": "health",
  "/admin/vault": "vault",
  "/admin/sessions": "sessions",
  "/admin/security": "security",
  "/admin/av-blocked": "av-blocked",
};

export function getAdminTabFromPath(pathname: string): string {
  if (pathname === "/admin") return "access";
  const match = pathname.match(/^\/admin\/([^/?#]+)/);
  if (!match) return "";
  const sub = match[1];
  return ROUTE_TO_ADMIN_TAB[`/admin/${sub}`] || sub;
}
