import { useEffect, useRef } from "react";

/**
 * Trap keyboard focus inside a modal/dialog while it is open.
 *
 * - Records the previously focused element when the trap activates and
 *   restores focus to it when the trap deactivates.
 * - Moves initial focus to the first focusable element inside the
 *   container (or to the container itself if none).
 * - Cycles Tab / Shift+Tab between the first and last focusable
 *   descendants so focus cannot leak to the page underneath.
 *
 * Usage:
 * ```tsx
 * const ref = useFocusTrap<HTMLDivElement>(isOpen);
 * return isOpen ? <div ref={ref} role="dialog">…</div> : null;
 * ```
 *
 * Pair with `role="dialog"` + `aria-modal="true"` and an Escape-to-close
 * handler. The hook does not read the Escape key — close behaviour is
 * the caller's responsibility, since some dialogs (e.g. unsaved-changes
 * guards) intentionally trap Escape too.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const containerRef = useRef<T | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "textarea:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const getFocusable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null
      );

    // Move focus into the dialog on activation if it isn't already inside.
    if (!container.contains(document.activeElement)) {
      const focusable = getFocusable();
      const target = focusable[0] ?? container;
      // Make container itself focusable as a fallback so screen readers
      // land somewhere meaningful even when the dialog has no controls.
      if (target === container && !container.hasAttribute("tabindex")) {
        container.setAttribute("tabindex", "-1");
      }
      target.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      // Restore focus to the element that opened the dialog so keyboard
      // users land back where they were (WCAG 2.4.3 Focus Order).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active]);

  return containerRef;
}
