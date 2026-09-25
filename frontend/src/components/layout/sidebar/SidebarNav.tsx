import { useState, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { useLocation } from "react-router-dom";
import type { MeResponse } from "../../../api";
import { usePendingApprovalsCount } from "../../approvalStore";
import { useSessionManager } from "../../SessionManager";
import AdminSubtree from "./AdminSubtree";
import NavItem from "./NavItem";
import QuickJumpTrigger from "./QuickJumpTrigger";
import SidebarBrand from "./SidebarBrand";
import { visibleSections, type NavBadgeSource } from "./sidebarConfig";

export interface AdminMenuHandlers {
  ref: Ref<HTMLAnchorElement>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: (e: MouseEvent<HTMLAnchorElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLAnchorElement>) => void;
  /** Open the mega-menu from an arbitrary element (expanded-mode "All settings"). */
  openFrom: (anchor: HTMLElement) => void;
}

interface Props {
  user: MeResponse | null;
  isCollapsed: boolean;
  isDark: boolean;
  onExpand: () => void;
  admin: AdminMenuHandlers;
}

/** Brand, quick jump and the grouped navigation above the sidebar footer. */
export default function SidebarNav({ user, isCollapsed, isDark, onExpand, admin }: Props) {
  const { pathname, hash } = useLocation();
  const { sessions } = useSessionManager();
  const approvals = usePendingApprovalsCount();
  const [adminOpen, setAdminOpen] = useState(true);

  const counts: Record<NavBadgeSource, number> = {
    approvals,
    sessions: sessions.length,
  };
  const sections = visibleSections(user);

  return (
    <div className="sb-top">
      <SidebarBrand isCollapsed={isCollapsed} isDark={isDark} onExpand={onExpand} />
      <QuickJumpTrigger isCollapsed={isCollapsed} />

      <nav className="sb-nav" aria-label="Primary">
        {sections.map((section, idx) => (
          <div key={section.key} className="sb-section" role="group" aria-label={section.title}>
            {isCollapsed ? (
              idx > 0 && <div className="sb-divider" aria-hidden />
            ) : (
              <div className="sb-section-title" aria-hidden>
                {section.title}
              </div>
            )}
            {section.items.map((item) => {
              const active = item.isActive(pathname);
              const badgeCount = item.badge ? counts[item.badge] : 0;

              if (item.subItems && item.subItems.length > 0 && !isCollapsed) {
                return (
                  <AdminSubtree
                    key={item.id}
                    item={item}
                    isActive={active}
                    pathname={pathname}
                    hash={hash}
                    isOpen={adminOpen}
                    onToggle={() => setAdminOpen((o) => !o)}
                    onOpenAllSettings={admin.openFrom}
                  />
                );
              }
              if (item.id === "admin") {
                return (
                  <NavItem
                    key={item.id}
                    ref={admin.ref}
                    item={item}
                    isCollapsed={isCollapsed}
                    isActive={active}
                    onMouseEnter={admin.onMouseEnter}
                    onMouseLeave={admin.onMouseLeave}
                    onClick={admin.onClick}
                    onKeyDown={admin.onKeyDown}
                    ariaHasPopup
                  />
                );
              }
              return (
                <NavItem
                  key={item.id}
                  item={item}
                  isCollapsed={isCollapsed}
                  isActive={active}
                  badgeCount={badgeCount}
                />
              );
            })}
          </div>
        ))}
      </nav>
    </div>
  );
}
