import { useCallback, useEffect, useState } from 'react';
import Guacamole from 'guacamole-common-js';
import { GuacSession } from './SessionManager';

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
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  // Derive initial state from the session — if it already has a popup open
  // (e.g. we navigated away and came back), reflect that immediately.
  const [isPoppedOut, setIsPoppedOut] = useState(() => !!session?._popout && !session._popout.window.closed);

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
      container.innerHTML = '';
      container.appendChild(session.displayEl);

      // Re-attach mouse/touch handlers since the element moved between documents
      const mouse = new Guacamole.Mouse(session.displayEl);
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
        session.client.sendMouseState(e.state, true);
      });
      const touch = new Guacamole.Mouse.Touchscreen(session.displayEl);
      touch.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
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
    }

    // Close the popup window
    if (!po.window.closed) {
      try { po.window.close(); } catch { /* ignore */ }
    }
    session._popout = undefined;
    session.isPoppedOut = false;
    setIsPoppedOut(false);
  }, [session, containerRef]);

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
      if ('getScreenDetails' in window) {
        const details: ScreenDetails = await (window as any).getScreenDetails();
        if (details.screens.length > 1) {
          const secondary =
            details.screens.find((s: any) => !s.isPrimary) || details.screens[1];
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
      'menubar=no',
      'toolbar=no',
      'location=no',
      'status=no',
    ].join(',');

    const popup = window.open('about:blank', `strata-popout-${sess.id}`, features);
    if (!popup) return; // popup blocked

    // ── Set up the popup document ──
    popup.document.title = `${sess.name} — Strata`;
    const body = popup.document.body;
    body.style.margin = '0';
    body.style.padding = '0';
    body.style.overflow = 'hidden';
    body.style.background = '#000';
    body.style.width = '100vw';
    body.style.height = '100vh';
    body.style.cursor = 'none';

    // ── Reparent the display element ──
    body.appendChild(sess.displayEl);

    // ── Mouse/touch handlers for the popup document ──
    const mouse = new Guacamole.Mouse(sess.displayEl);
    mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
      sess.client.sendMouseState(e.state, true);
    });

    const touch = new Guacamole.Mouse.Touchscreen(sess.displayEl);
    touch.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
      sess.client.sendMouseState(e.state, true);
    });

    // ── Keyboard input in the popup ──
    const kb = new Guacamole.Keyboard(popup.document);
    kb.onkeydown = (keysym: number) => {
      sess.client.sendKeyEvent(1, keysym);
      return true;
    };
    kb.onkeyup = (keysym: number) => {
      sess.client.sendKeyEvent(0, keysym);
    };

    // Capture-phase key trap to prevent browser shortcuts in popup
    const trapKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F12') return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) return;
      e.preventDefault();
    };
    popup.document.addEventListener('keydown', trapKeyDown, true);

    // ── Handle resize in the popup ──
    const display = sess.client.getDisplay();

    function handleResize() {
      if (!popup || popup.closed) return;
      const cw = popup.innerWidth;
      const ch = popup.innerHeight;
      if (cw <= 0 || ch <= 0) return;
      const dw = display.getWidth();
      const dh = display.getHeight();
      if (dw > 0 && dh > 0) {
        display.scale(Math.min(cw / dw, ch / dh));
      }
      sess.client.sendSize(cw, ch);
    }

    popup.addEventListener('resize', handleResize);
    requestAnimationFrame(() => handleResize());

    // ── Handle popup close (user closes the popup window) ──
    // Use a ref-style callback so returnDisplay always uses the latest session state
    const onUnload = () => returnDisplay();
    popup.addEventListener('pagehide', onUnload);

    // Poll in case pagehide doesn't fire reliably
    const pollId = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollId);
        returnDisplay();
      }
    }, 500);

    const cleanup = () => {
      clearInterval(pollId);
      popup.removeEventListener('resize', handleResize);
      popup.removeEventListener('pagehide', onUnload);
      try { popup.document.removeEventListener('keydown', trapKeyDown, true); } catch { /* popup may already be closed */ }
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

// Window Management API type augmentation
interface ScreenDetails {
  screens: ScreenDetailed[];
  currentScreen: ScreenDetailed;
}

interface ScreenDetailed {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  isPrimary: boolean;
  label: string;
}
