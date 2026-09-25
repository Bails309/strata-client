import { Link } from "react-router-dom";

interface Props {
  isCollapsed: boolean;
  isDark: boolean;
  onExpand: () => void;
}

/**
 * Full wordmark when expanded. The collapsed rail uses the favicon, which is
 * the emblem on its own, rather than cropping the combined logo.
 */
export default function SidebarBrand({ isCollapsed, isDark, onExpand }: Props) {
  return (
    <div className={`sb-brand${isCollapsed ? " sb-brand-collapsed" : ""}`}>
      {isCollapsed ? (
        <button
          type="button"
          className="sb-brand-emblem"
          onClick={onExpand}
          aria-label="Expand navigation"
          title="Expand navigation"
        >
          <img src="/favicon.png" alt="Strata Client" />
        </button>
      ) : (
        <>
          <div className="sb-brand-glow" aria-hidden />
          <Link to="/" className="sb-brand-link" aria-label="Strata Client home">
            <img src={isDark ? "/logo-dark.png" : "/logo-light.png"} alt="Strata Client" />
          </Link>
        </>
      )}
    </div>
  );
}
