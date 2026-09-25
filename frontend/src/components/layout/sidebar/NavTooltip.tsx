import { cloneElement, useState, type ReactElement, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

interface Props {
  label: string;
  /** Tooltips only show on the collapsed rail, where labels are hidden. */
  enabled: boolean;
  children: ReactElement<{
    onMouseEnter?: (e: SyntheticEvent<HTMLElement>) => void;
    onMouseLeave?: (e: SyntheticEvent<HTMLElement>) => void;
    onFocus?: (e: SyntheticEvent<HTMLElement>) => void;
    onBlur?: (e: SyntheticEvent<HTMLElement>) => void;
  }>;
}

/**
 * Right-pinned tooltip for the collapsed rail. Rendered in a portal with
 * fixed positioning because the rail's scroll container would clip it.
 */
export default function NavTooltip({ label, enabled, children }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  if (!enabled) return children;

  const show = (e: SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ top: r.top + r.height / 2, left: r.right + 10 });
  };
  const hide = () => setPos(null);
  const p = children.props;

  return (
    <>
      {cloneElement(children, {
        onMouseEnter: (e) => {
          p.onMouseEnter?.(e);
          show(e);
        },
        onMouseLeave: (e) => {
          p.onMouseLeave?.(e);
          hide();
        },
        onFocus: (e) => {
          p.onFocus?.(e);
          show(e);
        },
        onBlur: (e) => {
          p.onBlur?.(e);
          hide();
        },
      })}
      {pos &&
        createPortal(
          <span role="tooltip" className="sb-tooltip" style={{ top: pos.top, left: pos.left }}>
            {label}
          </span>,
          document.body
        )}
    </>
  );
}
