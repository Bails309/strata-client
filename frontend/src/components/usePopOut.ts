import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Guacamole from "guacamole-common-js";
import { GuacSession } from "./SessionManager";
import { createWinKeyProxy } from "../utils/winKeyProxy";
import { installShortcutProxy } from "../utils/shortcutProxy";
import { installKeyboardLock } from "../utils/keyboardLock";
import { useUserPreferences } from "./UserPreferencesProvider";
import {
  parseBinding,
  matchesBinding,
  DEFAULT_COMMAND_PALETTE_BINDING,
} from "../utils/keybindings";

/**
 * Hook that manages popping a Guacamole session out into a separate browser window.
 *
 * Pop-out state is stored on the GuacSession._popout object so that it survives
 * SessionClient unmount/remount cycles (e.g. navigating to the dashboard and
 * back).  SessionManager is responsible for closing the popup when a session
 * ends — this hook never tears down the popup on its own unmount.
 */
export function usePopOut(
  session: GuacSession | undefined,
  containerRef: React.RefObject<HTMLDivElement | null>
) {
  const navigate = useNavigate();

  // Live ref to the user's command-palette binding so the popout's key
  // trap (installed once when the popup opens) sees subsequent updates
  // without needing to be re-bound.
  const { preferences: userPrefs } = useUserPreferences();
  const commandPaletteBindingRef = useRef(
    parseBinding(userPrefs.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING)
  );
  useEffect(() => {
    commandPaletteBindingRef.current = parseBinding(
      userPrefs.commandPaletteBinding ?? DEFAULT_COMMAND_PALETTE_BINDING
    );
  }, [userPrefs.commandPaletteBinding]);

  // Derive initial state from the session — if it already has a popup open
  // (e.g. we navigated away and came back), reflect that immediately.
  const [isPoppedOut, setIsPoppedOut] = useState(
    () => !!session?._popout && !session._popout.window.closed
  );

  // Sync isPoppedOut when the session changes (switching between connections).
  useEffect(() => {
    setIsPoppedOut(!!session?._popout && !session._popout.window.closed);
  }, [session]);

  const returnDisplay = useCallback(() => {
    if (!session?._popout) return;
    const po = session._popout;

    // Tear down popup input handlers
    po.cleanup();
    po.keyboard.onkeydown = null;
    po.keyboard.onkeyup = null;
    po.keyboard.reset();
    po.mouse.onmousedown = null;
    po.mouse.onmouseup = null;
    po.mouse.onmousemove = null;
    po.touch.onmousedown = null;
    po.touch.onmouseup = null;
    po.touch.onmousemove = null;

    // Return the display element to the main window container
    const container = containerRef.current;
    if (container && session.displayEl) {
      container.innerHTML = "";
      container.appendChild(session.displayEl);

      // Re-attach mouse/touch handlers since the element moved between documents
      const mouse = new Guacamole.Mouse(session.displayEl);
      mouse.onEach(["mousedown", "mouseup", "mousemove"], (e: Guacamole.Mouse.Event) => {
        session.client.sendMouseState(e.state, true);
      });
      const touch = new Guacamole.Mouse.Touchscreen(session.displayEl);
      touch.onEach(["mousedown", "mouseup", "mousemove"], (e: Guacamole.Mouse.Event) => {
        session.client.sendMouseState(e.state, true);
      });

      // Force Guacamole to re-render display and cursor layers
      const display = session.client.getDisplay();
      const dw = display.getWidth();
      const dh = display.getHeight();
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (dw > 0 && dh > 0 && cw > 0 && ch > 0) {
        display.scale(Math.min(cw / dw, ch / dh));
      }
      session.client.sendSize(cw, ch);
    } else if (session.displayEl) {
      // No container — user navigated away from the session page while the
      // popup was open.  Adopt the display element back into the main document
      // so it isn't destroyed with the popup, then navigate to the session.
      try {
        document.adoptNode(session.displayEl);
      } catch {
        /* already in main doc */
      }
    }

    // Close the popup window
    if (!po.window.closed) {
      try {
        po.window.close();
      } catch {
        /* ignore */
      }
    }
    session._popout = undefined;
    session.isPoppedOut = false;
    setIsPoppedOut(false);

    // If the session page isn't mounted (no container), navigate back to it
    // so the display can be re-attached naturally.
    if (!container) {
      navigate(`/session/${session.connectionId}`);
    }
  }, [session, containerRef, navigate]);

  const popOut = useCallback(async () => {
    if (!session || isPoppedOut) return;
    // Narrow type for closures below
    const sess = session;

    // ── Determine target screen via Window Management API ──
    let left = Math.round(screen.availWidth * 0.1);
    let top = Math.round(screen.availHeight * 0.1);
    let width = Math.round(screen.availWidth * 0.8);
    let height = Math.round(screen.availHeight * 0.8);

    try {
      if (window.getScreenDetails) {
        const details = await window.getScreenDetails();
        if (details.screens.length > 1) {
          const secondary = details.screens.find((s) => !s.isPrimary) || details.screens[1];
          left = secondary.availLeft;
          top = secondary.availTop;
          width = secondary.availWidth;
          height = secondary.availHeight;
        }
      }
    } catch {
      // Permission denied or API unavailable — use defaults
    }

    const features = [
      `left=${left}`,
      `top=${top}`,
      `width=${width}`,
      `height=${height}`,
      "menubar=no",
      "toolbar=no",
      "location=no",
      "status=no",
    ].join(",");

    const popup = window.open("about:blank", `strata-popout-${sess.id}`, features);
    if (!popup) return; // popup blocked

    // ── Set up the popup document ──
    popup.document.title = `${sess.name} — Strata`;
    const body = popup.document.body;
    body.style.margin = "0";
    body.style.padding = "0";
    body.style.overflow = "hidden";
    body.style.background = "#000";
    body.style.width = "100vw";
    body.style.height = "100vh";
    body.style.cursor = "none";
    // Centre the displayEl inside body so any transient letterbox during
    // the popup-settle phase is symmetric rather than a stripe of black
    // pinned to the right/bottom edges. Once handleResize converges, the
    // displayEl exactly fills body and the flex layout is a no-op.
    body.style.display = "flex";
    body.style.alignItems = "center";
    body.style.justifyContent = "center";

    // ── Reparent the display element ──
    body.appendChild(sess.displayEl);

    // ── Mouse/touch handlers for the popup document ──
    const mouse = new Guacamole.Mouse(sess.displayEl);
    mouse.onEach(["mousedown", "mouseup", "mousemove"], (e: Guacamole.Mouse.Event) => {
      sess.client.sendMouseState(e.state, true);
    });

    const touch = new Guacamole.Mouse.Touchscreen(sess.displayEl);
    touch.onEach(["mousedown", "mouseup", "mousemove"], (e: Guacamole.Mouse.Event) => {
      sess.client.sendMouseState(e.state, true);
    });

    // ── Keyboard input in the popup ──
    const kb = new Guacamole.Keyboard(popup.document);
    const winProxy = createWinKeyProxy((p, k) => sess.client.sendKeyEvent(p, k));
    kb.onkeydown = (keysym: number) => {
      return winProxy.onkeydown(keysym);
    };
    kb.onkeyup = (keysym: number) => {
      winProxy.onkeyup(keysym);
    };

    // Capture-phase key trap to prevent browser shortcuts in popup
    const trapKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F12") return;
      if (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J")) return;
      // User-configurable command-palette shortcut → relay to main window.
      if (matchesBinding(e, commandPaletteBindingRef.current)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        kb.reset();
        window.postMessage({ type: "strata:open-command-palette" }, "*");
        return;
      }
      e.preventDefault();
    };
    popup.document.addEventListener("keydown", trapKeyDown, true);

    // Shortcut proxy: Ctrl+Alt+Tab → Alt+Tab, Ctrl+Alt+` → Win+Tab
    const removeShortcutProxy = installShortcutProxy(popup.document, (p, k) =>
      sess.client.sendKeyEvent(p, k)
    );

    // Keyboard Lock: capture OS-level shortcuts in fullscreen popouts
    const removeKeyboardLock = installKeyboardLock(popup.document);

    // ── Clipboard sync for the popup window ──
    // The main window's paste listener doesn't fire in the popup, so we
    // need dedicated handlers here.
    const pushClipboardPopup = async () => {
      try {
        const text = await popup.navigator.clipboard?.readText();
        if (text && text !== sess.remoteClipboard) {
          const stream = sess.client.createClipboardStream("text/plain");
          const writer = new Guacamole.StringWriter(stream);
          const CHUNK_SIZE = 4096;
          for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            writer.sendText(text.substring(i, i + CHUNK_SIZE));
          }
          writer.sendEnd();
          sess.remoteClipboard = text;
        }
      } catch {
        // Clipboard access denied in popup — ignore
      }
    };

    const handlePastePopup = (e: Event) => {
      const ce = e as ClipboardEvent;
      const text = ce.clipboardData?.getData("text/plain");
      if (text && text !== sess.remoteClipboard) {
        const stream = sess.client.createClipboardStream("text/plain");
        const writer = new Guacamole.StringWriter(stream);
        const CHUNK_SIZE = 4096;
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
          writer.sendText(text.substring(i, i + CHUNK_SIZE));
        }
        writer.sendEnd();
        sess.remoteClipboard = text;
      }
    };

    sess.displayEl.addEventListener("mouseenter", pushClipboardPopup);
    sess.displayEl.addEventListener("mousedown", pushClipboardPopup);
    popup.addEventListener("focus", pushClipboardPopup);
    popup.document.addEventListener("paste", handlePastePopup);

    // ── Handle resize in the popup ──
    //
    // Two compounding issues used to leave a permanent black band on the
    // right/bottom of the popup:
    //
    //   1. The opener's `requestAnimationFrame` fires BEFORE the popup
    //      has fully laid out its document, so `popup.innerWidth/innerHeight`
    //      are unreliable on the first read (Chrome lazily settles them).
    //   2. Every `resize` event fired during the popup's settle phase
    //      called `sendSize` immediately, putting the RDP server into a
    //      resize storm where the final committed remote resolution did
    //      not match the popup's eventual inner dimensions.
    //
    // Fixes here:
    //   - Use the popup's OWN `requestAnimationFrame` for the initial
    //     resize so we read dimensions after the popup has painted.
    //   - Track size changes with a ResizeObserver on the popup body
    //     (more reliable than the `resize` event in popups).
    //   - Debounce `sendSize` with a 150 ms trailing edge so we only ever
    //     ask the server to resize to the popup's FINAL size, not every
    //     intermediate value during a drag or open.
    //
    const display = sess.client.getDisplay();

    let pendingSendSizeId: number | null = null;
    function scheduleSendSize(cw: number, ch: number) {
      if (!popup) return;
      if (pendingSendSizeId !== null) {
        popup.clearTimeout(pendingSendSizeId);
      }
      pendingSendSizeId = popup.setTimeout(() => {
        pendingSendSizeId = null;
        if (popup && !popup.closed) {
          try {
            sess.client.sendSize(cw, ch);
          } catch (e) {
            console.warn("popup sendSize failed", e);
          }
        }
      }, 150);
    }

    function handleResize() {
      if (!popup || popup.closed) return;
      const cw = popup.innerWidth;
      const ch = popup.innerHeight;
      if (cw <= 0 || ch <= 0) return;
      const dw = display.getWidth();
      const dh = display.getHeight();
      if (dw > 0 && dh > 0) {
        // Letterbox-scale to preserve aspect ratio. With body using
        // flexbox centring above, any transient letterbox during settle
        // is symmetric.
        display.scale(Math.min(cw / dw, ch / dh));
      }
      scheduleSendSize(cw, ch);
    }

    // Rescale when the remote display resolution changes (e.g. maximising
    // a window inside the remote desktop, or our own sendSize landing).
    // Use setTimeout instead of requestAnimationFrame because rAF is
    // throttled/paused on the main window when the popup has focus.
    const prevOnResize = display.onresize;
    display.onresize = (_w: number, _h: number) => {
      setTimeout(() => handleResize(), 0);
    };

    // Use a ResizeObserver on the popup body — more reliable than the
    // `resize` event for popup windows, and fires for layout changes the
    // window-resize event misses.
    let resizeObs: ResizeObserver | null = null;
    try {
      const PopupResizeObserver = (popup as Window & typeof globalThis).ResizeObserver;
      resizeObs = new PopupResizeObserver(() => handleResize());
      resizeObs?.observe(body);
    } catch {
      // ResizeObserver not available in this popup — fall back to event
    }
    popup.addEventListener("resize", handleResize);

    // Initial sizing: wait for the popup document to actually finish
    // loading AND a popup-side animation frame to flush layout. Reading
    // popup.innerWidth/innerHeight before this point can return stale or
    // inflated opener-window values.
    const runInitialResize = () => {
      popup.requestAnimationFrame(() => {
        // One more rAF to be sure layout has committed after readyState.
        popup.requestAnimationFrame(() => handleResize());
      });
    };
    if (popup.document.readyState === "complete") {
      runInitialResize();
    } else {
      popup.addEventListener("load", runInitialResize, { once: true });
    }

    // ── Detect when the popup is moved to a different screen ──
    // The browser doesn't fire 'resize' when a window is dragged to
    // another screen without changing size.  We poll screenX/screenY
    // and the popup's devicePixelRatio to detect the move and then
    // maximize + re-scale to fill the new screen.
    let lastScreenX = popup.screenX;
    let lastScreenY = popup.screenY;
    let lastDpr = popup.devicePixelRatio;
    const screenPollId = setInterval(() => {
      if (popup.closed) {
        clearInterval(screenPollId);
        return;
      }
      const sx = popup.screenX;
      const sy = popup.screenY;
      const dpr = popup.devicePixelRatio;
      if (sx !== lastScreenX || sy !== lastScreenY || dpr !== lastDpr) {
        lastScreenX = sx;
        lastScreenY = sy;
        lastDpr = dpr;
        // Debounce: the user may still be dragging.  Wait 300ms for
        // the position to settle before resizing.
        setTimeout(() => {
          if (popup.closed) return;
          if (popup.screenX === sx && popup.screenY === sy) {
            handleResize();
          }
        }, 300);
      }
    }, 250);

    // ── Handle popup close (user closes the popup window) ──
    // Use a ref-style callback so returnDisplay always uses the latest session state
    const onUnload = () => returnDisplay();
    popup.addEventListener("pagehide", onUnload);

    // Poll in case pagehide doesn't fire reliably
    const pollId = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollId);
        returnDisplay();
      }
    }, 500);

    const cleanup = () => {
      clearInterval(pollId);
      clearInterval(screenPollId);
      if (pendingSendSizeId !== null) {
        try {
          popup.clearTimeout(pendingSendSizeId);
        } catch {
          /* popup may already be closed */
        }
        pendingSendSizeId = null;
      }
      try {
        resizeObs?.disconnect();
      } catch {
        /* ignore */
      }
      popup.removeEventListener("resize", handleResize);
      popup.removeEventListener("pagehide", onUnload);
      popup.removeEventListener("focus", pushClipboardPopup);
      // Restore previous display.onresize so the main-window effect can
      // re-register its own handler without leftover popup closures.
      display.onresize = prevOnResize ?? null;
      try {
        popup.document.removeEventListener("keydown", trapKeyDown, true);
        popup.document.removeEventListener("paste", handlePastePopup);
        removeShortcutProxy();
        removeKeyboardLock();
      } catch {
        /* popup may already be closed */
      }
      try {
        sess.displayEl.removeEventListener("mouseenter", pushClipboardPopup);
        sess.displayEl.removeEventListener("mousedown", pushClipboardPopup);
      } catch {
        /* ignore */
      }
    };

    // ── Store all pop-out state on the session (persists across route changes) ──
    sess._popout = { window: popup, keyboard: kb, mouse, touch, cleanup };
    sess.isPoppedOut = true;
    setIsPoppedOut(true);
  }, [session, isPoppedOut, returnDisplay]);

  // No cleanup on unmount — the popup window stays open when SessionClient
  // unmounts (e.g. navigating to the dashboard). SessionManager.cleanupPopout
  // handles teardown when the session actually ends.

  return { isPoppedOut, popOut, returnDisplay };
}
