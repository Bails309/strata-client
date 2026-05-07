// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vanilla-DOM command palette for popout windows.
 *
 * The main-window palette (CommandPalette.tsx) is deeply tied to React
 * context (UserPreferences, SessionManager, Router). Spinning up a second
 * React root inside the popup with all of those providers — and keeping
 * them in sync with the opener — is a substantially larger change. For
 * the common case (Ctrl+K in a popout to switch to a different remote)
 * we render a minimal palette directly in the popup document and relay
 * the user's selection back to the opener via postMessage. The opener's
 * SessionManager / Router then opens the chosen connection in the main
 * window exactly as if Ctrl+K had been pressed there.
 *
 * The popup is `about:blank`, opened by `window.open()` from the same
 * origin, so it shares the opener's JS realm and cookies. We can call
 * the opener's `getMyConnections()` directly.
 *
 * Keyboard handling: this palette intentionally does NOT register its own
 * document keydown listener. Doing so would race against Guacamole's own
 * capture-phase listener that the popout already installs on the popup
 * document. Instead, the popout's `trapKeyDown` (which is registered
 * BEFORE Guacamole.Keyboard) calls `handleKeyDown(e)` while the palette
 * is open and stops propagation so Guacamole never sees palette keys.
 */
import { Connection, getMyConnections } from "../api";

export interface PopoutPalette {
  /** Open the palette (idempotent). */
  open: () => void;
  /** True while the palette overlay is mounted. */
  isOpen: () => boolean;
  /**
   * Handle a keydown while the palette is open. Returns true if the
   * palette consumed the event (Escape / Arrow / Enter) — the caller
   * should `preventDefault` in that case. For other keys the caller
   * must NOT preventDefault so the <input> can receive characters.
   */
  handleKeyDown: (e: KeyboardEvent) => boolean;
  /** Close the palette and remove its DOM. */
  destroy: () => void;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function createPopoutPalette(popup: Window, opener: Window): PopoutPalette {
  let overlay: HTMLDivElement | null = null;
  let connections: Connection[] = [];
  let connectionsLoaded = false;
  let connectionsLoading: Promise<void> | null = null;
  let selectedIndex = 0;
  let filtered: Connection[] = [];
  let renderFn: (() => void) | null = null;
  let inputEl: HTMLInputElement | null = null;

  const ensureConnections = (): Promise<void> => {
    if (connectionsLoaded) return Promise.resolve();
    if (connectionsLoading) return connectionsLoading;
    connectionsLoading = getMyConnections()
      .then((list) => {
        connections = list;
        connectionsLoaded = true;
      })
      .catch(() => {
        connections = [];
      })
      .finally(() => {
        connectionsLoading = null;
      });
    return connectionsLoading;
  };

  const close = () => {
    if (!overlay) return;
    try {
      overlay.remove();
    } catch {
      /* ignore */
    }
    overlay = null;
    renderFn = null;
    inputEl = null;
  };

  const choose = (c: Connection) => {
    try {
      opener.postMessage({ type: "strata:open-connection", id: c.id }, opener.location.origin);
    } catch {
      /* opener may be gone */
    }
    close();
    try {
      opener.focus();
    } catch {
      /* ignore */
    }
    try {
      popup.blur();
    } catch {
      /* ignore */
    }
  };

  const open = () => {
    if (overlay || popup.closed) return;

    const doc = popup.document;
    overlay = doc.createElement("div");
    overlay.setAttribute("data-strata-popout-palette", "");
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,0.55)",
      "z-index:2147483647",
      "display:flex",
      "align-items:flex-start",
      "justify-content:center",
      "padding-top:10vh",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
      "color:#f3f4f6",
      // Body inherits `cursor: none` (set by usePopOut so the remote's
      // cursor sprite is the only visible pointer). Override here so
      // the user can see where they are clicking inside the palette.
      "cursor:default",
      // Defensive: explicitly enable pointer events. Without this an
      // ancestor with `pointer-events:none` (or a future change to body)
      // would prevent the overlay from receiving clicks.
      "pointer-events:auto",
    ].join(";");
    // Click anywhere on the dimmed backdrop (but not on the panel) closes
    // the palette — standard modal behaviour.
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });

    const panel = doc.createElement("div");
    panel.style.cssText = [
      "background:#1f2937",
      "width:640px",
      "max-width:92vw",
      "border-radius:10px",
      "box-shadow:0 20px 60px rgba(0,0,0,0.6)",
      "overflow:hidden",
      "border:1px solid #374151",
    ].join(";");

    const input = doc.createElement("input");
    input.type = "text";
    input.placeholder = "Search connections…";
    input.style.cssText = [
      "width:100%",
      "box-sizing:border-box",
      "padding:14px 16px",
      "background:transparent",
      "border:0",
      "border-bottom:1px solid #374151",
      "color:#f3f4f6",
      "outline:none",
      "font-size:15px",
      "cursor:text",
    ].join(";");

    const list = doc.createElement("div");
    list.style.cssText = "max-height:50vh;overflow-y:auto;";

    panel.appendChild(input);
    panel.appendChild(list);
    overlay.appendChild(panel);
    doc.body.appendChild(overlay);

    const render = () => {
      const q = input.value.trim().toLowerCase();
      filtered = q
        ? connections.filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              c.hostname.toLowerCase().includes(q) ||
              c.protocol.toLowerCase().includes(q)
          )
        : connections.slice();
      if (selectedIndex >= filtered.length) selectedIndex = 0;

      list.innerHTML = "";
      if (filtered.length === 0) {
        const empty = doc.createElement("div");
        empty.textContent = connectionsLoaded ? "No connections." : "Loading…";
        empty.style.cssText = "padding:18px 16px;color:#9ca3af;font-size:13px;";
        list.appendChild(empty);
        return;
      }
      filtered.forEach((c, i) => {
        const row = doc.createElement("div");
        row.dataset.index = String(i);
        row.style.cssText = [
          "padding:10px 16px",
          "cursor:pointer",
          `background:${i === selectedIndex ? "#374151" : "transparent"}`,
          "border-bottom:1px solid #111827",
          "pointer-events:auto",
        ].join(";");
        row.innerHTML =
          `<div style="font-weight:500;font-size:14px;pointer-events:none">${escapeHtml(c.name)}</div>` +
          `<div style="font-size:12px;color:#9ca3af;margin-top:2px;pointer-events:none">` +
          `${escapeHtml(c.protocol.toUpperCase())} · ${escapeHtml(c.hostname)}` +
          `</div>`;
        list.appendChild(row);
      });
    };

    // Event delegation on the list element. Using a single capture-phase
    // listener avoids per-row handlers that can be lost on re-render and
    // also makes it easy to ensure the click reaches us before any other
    // popup-document listener.
    list.addEventListener(
      "mousedown",
      (e) => {
        let el = e.target as HTMLElement | null;
        while (el && el !== list && !el.dataset?.index) {
          el = el.parentElement;
        }
        if (!el || !el.dataset?.index) return;
        const idx = Number(el.dataset.index);
        const c = filtered[idx];
        if (!c) return;
        // mousedown rather than click so the popup doesn't lose focus to a
        // transient native focus shift before we postMessage to opener.
        e.preventDefault();
        e.stopPropagation();
        choose(c);
      },
      true
    );
    list.addEventListener(
      "mousemove",
      (e) => {
        let el = e.target as HTMLElement | null;
        while (el && el !== list && !el.dataset?.index) {
          el = el.parentElement;
        }
        if (!el || !el.dataset?.index) return;
        const idx = Number(el.dataset.index);
        if (idx !== selectedIndex && idx >= 0 && idx < filtered.length) {
          selectedIndex = idx;
          render();
        }
      },
      true
    );

    input.addEventListener("input", () => {
      selectedIndex = 0;
      render();
    });

    renderFn = render;
    inputEl = input;
    render();
    void ensureConnections().then(() => {
      if (overlay) render();
    });

    // Focus the input on the next frame — focusing immediately can race
    // with the popup's own focus management.
    setTimeout(() => {
      try {
        input.focus();
      } catch {
        /* ignore */
      }
    }, 0);
  };

  const handleKeyDown = (e: KeyboardEvent): boolean => {
    if (!overlay || !renderFn) return false;
    if (e.key === "Escape") {
      close();
      return true;
    }
    if (e.key === "ArrowDown") {
      if (filtered.length > 0) {
        selectedIndex = (selectedIndex + 1) % filtered.length;
        renderFn();
      }
      return true;
    }
    if (e.key === "ArrowUp") {
      if (filtered.length > 0) {
        selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
        renderFn();
      }
      return true;
    }
    if (e.key === "Enter") {
      const c = filtered[selectedIndex];
      if (c) choose(c);
      return true;
    }
    // If the input has focus we don't need to do anything — letting the
    // event reach the input naturally will produce the character. If
    // focus has drifted (e.g. after a row mouseenter) bring it back so
    // typing always lands in the search field.
    if (inputEl && popup.document.activeElement !== inputEl) {
      try {
        inputEl.focus();
      } catch {
        /* ignore */
      }
    }
    return false;
  };

  return {
    open,
    isOpen: () => overlay !== null,
    handleKeyDown,
    destroy: close,
  };
}
