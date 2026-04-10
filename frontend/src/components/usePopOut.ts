import { useCallback, useEffect, useRef, useState } from 'react';
import Guacamole from 'guacamole-common-js';
import { GuacSession } from './SessionManager';

/**
 * Hook that manages popping a Guacamole session out into a separate browser window.
 *
 * Uses the Window Management API (getScreenDetails) when available to
 * position the popup on a secondary monitor automatically.
 *
 * Reparents the existing display element into the popup — no new tunnel
 * or connection is created, the session continues seamlessly.
 */
export function usePopOut(
  session: GuacSession | undefined,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const [isPoppedOut, setIsPoppedOut] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const keyboardRef = useRef<Guacamole.Keyboard | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const mouseRef = useRef<Guacamole.Mouse | null>(null);
  const touchRef = useRef<Guacamole.Mouse.Touchscreen | null>(null);

  // Track the session that was actually popped out, so returnDisplay works
  // correctly even when the parent component's current session changes.
  const poppedSessionRef = useRef<GuacSession | null>(null);

  const returnDisplay = useCallback(() => {
    const poppedSession = poppedSessionRef.current;
    if (!poppedSession) return;

    // Tear down popup keyboard
    if (keyboardRef.current) {
      keyboardRef.current.onkeydown = null;
      keyboardRef.current.onkeyup = null;
      keyboardRef.current.reset();
      keyboardRef.current = null;
    }

    // Tear down popup mouse/touch handlers
    if (mouseRef.current) {
      mouseRef.current.onmousedown = null;
      mouseRef.current.onmouseup = null;
      mouseRef.current.onmousemove = null;
      mouseRef.current = null;
    }
    if (touchRef.current) {
      touchRef.current.onmousedown = null;
      touchRef.current.onmouseup = null;
      touchRef.current.onmousemove = null;
      touchRef.current = null;
    }

    // Return the display element to the main window container
    const container = containerRef.current;
    if (container && poppedSession.displayEl) {
      container.innerHTML = '';
      container.appendChild(poppedSession.displayEl);

      // Re-attach mouse/touch handlers since the element moved between documents
      const mouse = new Guacamole.Mouse(poppedSession.displayEl);
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
        poppedSession.client.sendMouseState(e.state, true);
      });
      const touch = new Guacamole.Mouse.Touchscreen(poppedSession.displayEl);
      touch.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
        poppedSession.client.sendMouseState(e.state, true);
      });

      // Force Guacamole to re-render display and cursor layers
      const display = poppedSession.client.getDisplay();
      const dw = display.getWidth();
      const dh = display.getHeight();
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (dw > 0 && dh > 0 && cw > 0 && ch > 0) {
        display.scale(Math.min(cw / dw, ch / dh));
      }
      poppedSession.client.sendSize(cw, ch);
    }

    // Close the popup window
    const popup = popupRef.current;
    if (popup && !popup.closed) {
      try { popup.close(); } catch { /* ignore */ }
    }
    popupRef.current = null;
    poppedSessionRef.current = null;
    cleanupRef.current = null;
    setIsPoppedOut(false);
  }, [containerRef]);

  const popOut = useCallback(async () => {
    if (!session || isPoppedOut) return;

    // ── Determine target screen via Window Management API ──
    let left = Math.round(screen.availWidth * 0.1);
    let top = Math.round(screen.availHeight * 0.1);
    let width = Math.round(screen.availWidth * 0.8);
    let height = Math.round(screen.availHeight * 0.8);

    try {
      if ('getScreenDetails' in window) {
        const details: ScreenDetails = await (window as any).getScreenDetails();
        if (details.screens.length > 1) {
          // Pick the first non-primary screen
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

    const popup = window.open('about:blank', `strata-popout-${session.id}`, features);
    if (!popup) return; // popup blocked

    popupRef.current = popup;
    poppedSessionRef.current = session;

    // ── Set up the popup document ──
    popup.document.title = `${session.name} — Strata`;
    const body = popup.document.body;
    body.style.margin = '0';
    body.style.padding = '0';
    body.style.overflow = 'hidden';
    body.style.background = '#000';
    body.style.width = '100vw';
    body.style.height = '100vh';
    body.style.cursor = 'none';

    // ── Reparent the display element ──
    body.appendChild(session.displayEl);

    // ── Mouse/touch handlers for the popup document ──
    const mouse = new Guacamole.Mouse(session.displayEl);
    mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
      session.client.sendMouseState(e.state, true);
    });
    mouseRef.current = mouse;

    const touch = new Guacamole.Mouse.Touchscreen(session.displayEl);
    touch.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
      session.client.sendMouseState(e.state, true);
    });
    touchRef.current = touch;

    // ── Keyboard input in the popup ──
    const kb = new Guacamole.Keyboard(popup.document);
    keyboardRef.current = kb;

    kb.onkeydown = (keysym: number) => {
      session.client.sendKeyEvent(1, keysym);
      return true;
    };
    kb.onkeyup = (keysym: number) => {
      session.client.sendKeyEvent(0, keysym);
    };

    // Capture-phase key trap to prevent browser shortcuts in popup
    const trapKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F12') return;
      if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) return;
      e.preventDefault();
    };
    popup.document.addEventListener('keydown', trapKeyDown, true);

    // ── Handle resize in the popup ──
    const display = session.client.getDisplay();

    function handleResize() {
      if (!popup || popup.closed || !session) return;
      const cw = popup.innerWidth;
      const ch = popup.innerHeight;
      if (cw <= 0 || ch <= 0) return;
      const dw = display.getWidth();
      const dh = display.getHeight();
      if (dw > 0 && dh > 0) {
        display.scale(Math.min(cw / dw, ch / dh));
      }
      session.client.sendSize(cw, ch);
    }

    popup.addEventListener('resize', handleResize);
    // Initial fit
    requestAnimationFrame(() => handleResize());

    // ── Handle popup close ──
    const onUnload = () => {
      // The user closed the popup window — return display to main window
      returnDisplay();
    };
    popup.addEventListener('pagehide', onUnload);

    // Poll in case pagehide doesn't fire reliably
    const pollId = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollId);
        returnDisplay();
      }
    }, 500);

    cleanupRef.current = () => {
      clearInterval(pollId);
      popup.removeEventListener('resize', handleResize);
      popup.removeEventListener('pagehide', onUnload);
      popup.document.removeEventListener('keydown', trapKeyDown, true);
    };

    setIsPoppedOut(true);
  }, [session, isPoppedOut, returnDisplay]);

  // Clean up on unmount only — NOT on session change.
  // When the user navigates to a different connection, the session changes but
  // the pop-out should stay open until explicitly returned or unmounted.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;

      // Tear down popup keyboard
      if (keyboardRef.current) {
        keyboardRef.current.onkeydown = null;
        keyboardRef.current.onkeyup = null;
        keyboardRef.current.reset();
        keyboardRef.current = null;
      }

      // Tear down popup mouse/touch handlers
      if (mouseRef.current) {
        mouseRef.current.onmousedown = null;
        mouseRef.current.onmouseup = null;
        mouseRef.current.onmousemove = null;
        mouseRef.current = null;
      }
      if (touchRef.current) {
        touchRef.current.onmousedown = null;
        touchRef.current.onmouseup = null;
        touchRef.current.onmousemove = null;
        touchRef.current = null;
      }

      if (popupRef.current && !popupRef.current.closed) {
        try { popupRef.current.close(); } catch { /* ignore */ }
      }
      popupRef.current = null;
      setIsPoppedOut(false);
    };
  }, []);

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
