/* Small portal-mounted dropdown menu (escapes the table's overflow clip). */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

export default function FleetMenu({
  trigger,
  triggerLabel,
  triggerClassName,
  items,
  header,
  align = "right",
  disabled,
}: {
  trigger: ReactNode;
  triggerLabel: string;
  triggerClassName: string;
  items: MenuItem[];
  header?: string;
  align?: "left" | "right";
  disabled?: boolean;
}) {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos, close]);

  const open = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos(
      align === "right"
        ? { top: r.bottom + 4, right: window.innerWidth - r.right }
        : { top: r.bottom + 4, left: r.left }
    );
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        disabled={disabled}
        onClick={() => (pos ? close() : open())}
      >
        {trigger}
      </button>
      {pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fleet-menu"
            role="menu"
            aria-label={triggerLabel}
            style={{ top: pos.top, left: pos.left, right: pos.right }}
          >
            {header && <div className="fleet-menu-header">{header}</div>}
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`fleet-menu-item ${item.danger ? "fleet-menu-danger" : ""}`}
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
