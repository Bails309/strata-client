import { useId } from "react";
import { Link } from "react-router-dom";
import type { NavItemConfig, NavSubItemConfig } from "./sidebarConfig";

interface Props {
  item: NavItemConfig;
  isActive: boolean;
  pathname: string;
  hash: string;
  isOpen: boolean;
  onToggle: () => void;
  /** Opens the full admin mega-menu, anchored to the clicked element. */
  onOpenAllSettings: (anchor: HTMLElement) => void;
}

/** Scroll to an element the target page renders after navigation settles. */
function scrollToAnchor(id: string, attempt = 0) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (attempt < 60) requestAnimationFrame(() => scrollToAnchor(id, attempt + 1));
}

function isSubActive(
  sub: NavSubItemConfig,
  all: NavSubItemConfig[],
  pathname: string,
  hash: string
) {
  if (pathname !== sub.path) return false;
  if (sub.anchor) return hash === `#${sub.anchor}`;
  // A plain link is active unless a sibling on the same path claims the hash.
  return !all.some((s) => s !== sub && s.path === sub.path && s.anchor && hash === `#${s.anchor}`);
}

/** Expanded-mode admin entry: a disclosure row with an inline sub-tree. */
export default function AdminSubtree({
  item,
  isActive,
  pathname,
  hash,
  isOpen,
  onToggle,
  onOpenAllSettings,
}: Props) {
  const listId = useId();
  const subItems = item.subItems ?? [];

  return (
    <div className="sb-group">
      <button
        type="button"
        className={`sb-item sb-disclosure${isActive ? " is-active" : ""}`}
        aria-expanded={isOpen}
        aria-controls={listId}
        onClick={onToggle}
      >
        {item.icon}
        <span className="sb-item-label">{item.label}</span>
        <svg
          className={`sb-chevron${isOpen ? " sb-chevron-open" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {isOpen && (
        <ul id={listId} className="sb-subtree">
          {subItems.map((sub) => {
            const active = isSubActive(sub, subItems, pathname, hash);
            return (
              <li key={sub.id}>
                <Link
                  to={sub.anchor ? `${sub.path}#${sub.anchor}` : sub.path}
                  onClick={() => sub.anchor && scrollToAnchor(sub.anchor)}
                  aria-current={active ? "page" : undefined}
                  className={`sb-subitem${active ? " is-active" : ""}`}
                >
                  {sub.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className="sb-subitem sb-subitem-more"
              aria-haspopup="menu"
              onClick={(e) => onOpenAllSettings(e.currentTarget)}
            >
              All admin settings…
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
