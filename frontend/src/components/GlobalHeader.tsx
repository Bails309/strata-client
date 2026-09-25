import { Link, useLocation } from "react-router-dom";
import { MeResponse } from "../api";
import { ROUTE_TO_ADMIN_TAB } from "./adminMegaMenuConfig";
import LeaseIndicator from "./LeaseIndicator";

const ADMIN_SECTION_NAMES: Record<string, string> = {
  access: "Access Control",
  "ad-sync": "AD Sync",
  sso: "SSO / OIDC",
  kerberos: "Kerberos",
  passwords: "Password Management",
  safeguard: "Safeguard JIT",
  jit: "Safeguard JIT",
  "outbound-shares": "Outbound Share Policy",
  sharing: "Outbound Share Policy",
  "dmz-links": "DMZ Links",
  dmz: "DMZ Links",
  network: "Network",
  "trusted-cas": "Trusted CAs",
  cas: "Trusted CAs",
  vdi: "VDI",
  display: "Display",
  tags: "Tags",
  notifications: "Notifications",
  recordings: "Recordings",
  audit: "Audit Logs",
  connections: "Connections",
  health: "System Health",
  vault: "Vault",
  sessions: "Active Sessions",
  security: "Security",
  "av-blocked": "AV-Blocked Files",
};

interface GlobalHeaderProps {
  user?: MeResponse | null;
  onLogout?: () => void;
  theme?: string;
  preference?: string;
  cycleTheme?: () => void;
}

export default function GlobalHeader({ user }: GlobalHeaderProps = {}) {
  const location = useLocation();

  // Construct dynamic breadcrumbs based on pathname
  const path = location.pathname;
  const breadcrumbs: Array<{ label: string; to?: string }> = [{ label: "Home", to: "/" }];

  if (path.startsWith("/admin")) {
    breadcrumbs.push({ label: "Admin Settings", to: "/admin/access" });
    const tabKey = ROUTE_TO_ADMIN_TAB[path] || path.replace("/admin/", "");
    if (tabKey && tabKey !== "admin") {
      const sectionName =
        ADMIN_SECTION_NAMES[tabKey] || tabKey.charAt(0).toUpperCase() + tabKey.slice(1);
      breadcrumbs.push({ label: sectionName });
    } else {
      breadcrumbs.push({ label: "Access Control" });
    }
  } else if (path.startsWith("/credentials")) {
    breadcrumbs.push({ label: "Credentials" });
  } else if (path.startsWith("/audit")) {
    breadcrumbs.push({ label: "Audit Logs" });
  } else if (path.startsWith("/sessions")) {
    breadcrumbs.push({ label: "Sessions" });
  } else if (path.startsWith("/approvals")) {
    breadcrumbs.push({ label: "Pending Approvals" });
  } else if (path.startsWith("/docs")) {
    breadcrumbs.push({ label: "Documentation" });
  } else if (path.startsWith("/profile")) {
    breadcrumbs.push({ label: "Profile" });
  } else if (path.startsWith("/tiled")) {
    breadcrumbs.push({ label: "Tiled View" });
  }

  return (
    <header className="h-14 shrink-0 border-b border-border bg-bg-surface/80 backdrop-blur-md sticky top-0 z-40 px-6 flex items-center justify-between transition-all">
      {/* ── Left: Dynamic Breadcrumb Trail ── */}
      <nav aria-label="Breadcrumbs" className="flex items-center gap-2 text-sm select-none">
        {breadcrumbs.map((crumb, idx) => {
          const isLast = idx === breadcrumbs.length - 1;
          return (
            <div key={crumb.label} className="flex items-center gap-2">
              {idx > 0 && <span className="text-txt-tertiary select-none">/</span>}
              {!isLast && crumb.to ? (
                <Link
                  to={crumb.to}
                  className="text-txt-secondary hover:text-txt-primary transition-colors font-medium no-underline"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-txt-primary font-semibold">{crumb.label}</span>
              )}
            </div>
          );
        })}
      </nav>

      {user?.vault_configured && <LeaseIndicator user={user} />}
    </header>
  );
}
