import { forwardRef, type KeyboardEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import type { NavBadgeSource, NavItemConfig } from "./sidebarConfig";
import NavTooltip from "./NavTooltip";

const BADGE_TEXT: Record<NavBadgeSource, (n: number) => string> = {
  approvals: (n) => `${n} pending`,
  sessions: (n) => `${n} open in this browser`,
};

interface Props {
  item: NavItemConfig;
  isCollapsed: boolean;
  isActive: boolean;
  badgeCount?: number;
  /** Shown instead of the default trailing content (used for the Admin chevron). */
  trailing?: React.ReactNode;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLAnchorElement>) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  ariaHasPopup?: boolean;
}

const NavItem = forwardRef<HTMLAnchorElement, Props>(function NavItem(
  {
    item,
    isCollapsed,
    isActive,
    badgeCount = 0,
    trailing,
    onClick,
    onKeyDown,
    onMouseEnter,
    onMouseLeave,
    ariaHasPopup,
  },
  ref
) {
  const badge = item.badge && badgeCount > 0 ? item.badge : null;
  const badgeText = badge ? BADGE_TEXT[badge](badgeCount) : "";
  const tooltip = badge ? `${item.label} · ${badgeText}` : item.label;
  const shown = badgeCount > 99 ? "99+" : String(badgeCount);

  // An item with a popup (Admin) shows its flyout instead of a tooltip.
  return (
    <NavTooltip label={tooltip} enabled={isCollapsed && !ariaHasPopup}>
      <Link
        ref={ref}
        to={item.path}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        aria-current={isActive ? "page" : undefined}
        aria-label={isCollapsed ? tooltip : undefined}
        aria-haspopup={ariaHasPopup ? "menu" : undefined}
        className={`sb-item${isCollapsed ? " sb-tile" : ""}${isActive ? " is-active" : ""}`}
      >
        {item.icon}
        {!isCollapsed && <span className="sb-item-label">{item.label}</span>}

        {badge === "approvals" &&
          (isCollapsed ? (
            <span className="sb-badge-dot sb-badge-amber" aria-hidden>
              {badgeCount > 9 ? "9+" : badgeCount}
            </span>
          ) : (
            <span className="sb-badge sb-badge-amber">
              {shown}
              <span className="sr-only"> pending</span>
            </span>
          ))}
        {badge === "sessions" &&
          (isCollapsed ? (
            <span className="sb-pulse sb-pulse-pinned" aria-hidden />
          ) : (
            <span className="sb-badge sb-badge-cyan">
              <span className="sb-pulse" aria-hidden />
              {shown}
              <span className="sr-only"> open in this browser</span>
            </span>
          ))}
        {!isCollapsed && trailing}
      </Link>
    </NavTooltip>
  );
});

export default NavItem;
