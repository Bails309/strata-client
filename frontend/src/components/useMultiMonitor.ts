import { useCallback, useEffect, useRef, useState } from 'react';
import Guacamole from 'guacamole-common-js';
import { GuacSession } from './SessionManager';
import { createWinKeyProxy } from '../utils/winKeyProxy';

/**
 * Browser-based multi-monitor support via canvas slicing.
 *
 * When enabled, the Guacamole session is resized to span the aggregate
 * bounding box of all detected screens.  The main window clips to the
 * primary monitor's region while secondary browser windows each render
 * their slice of the remote desktop via requestAnimationFrame + drawImage.
 *
 * Input (mouse / keyboard) in secondary windows is offset-translated so
 * that coordinates map correctly to the aggregate remote resolution.
 *
 * Requires the Window Management API (Chromium 100+, `getScreenDetails()`).
 * Gracefully degrades to a no-op on unsupported browsers.
 */

interface ScreenInfo {
  left: number;
  top: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

interface MonitorLayout {
  screens: ScreenInfo[];
  primary: ScreenInfo;
  aggregateWidth: number;
  aggregateHeight: number;
  originX: number;
  originY: number;
}

interface SecondaryWindow {
  win: Window;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** X offset into the remote desktop (in remote pixels) */
  sourceX: number;
  /** Y offset into the remote desktop (in remote pixels) */
  sourceY: number;
  /** Slice width in remote pixels */
  sliceW: number;
  /** Slice height in remote pixels */
  sliceH: number;
  keyboard: Guacamole.Keyboard;
  mouse: Guacamole.Mouse;
}

export function useMultiMonitor(
  session: GuacSession | undefined,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  // Derive initial state from the session (survives route changes)
  const [isMultiMonitor, setIsMultiMonitor] = useState(
    () => !!session?._multiMonitor,
  );
  const [canMultiMonitor, setCanMultiMonitor] = useState(false);

  const secondaryWindowsRef = useRef<SecondaryWindow[]>([]);
  const rafIdRef = useRef<number>(0);
  const originalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const layoutRef = useRef<MonitorLayout | null>(null);

  // Sync when session changes (e.g. switching connections)
  useEffect(() => {
    setIsMultiMonitor(!!session?._multiMonitor);
  }, [session]);

  // Feature-detect Window Management API
  useEffect(() => {
    setCanMultiMonitor('getScreenDetails' in window);
  }, []);

  // ── Enable multi-monitor ──────────────────────────────────────────────
  const enableMultiMonitor = useCallback(async () => {
    if (!session || !containerRef.current || isMultiMonitor) return;
    // Don't combine with pop-out
    if (session.isPoppedOut) return;

    const sess = session;
    const client = sess.client;
    const display = client.getDisplay();

    // 1. Detect screens
    let layout: MonitorLayout;
    try {
      const details = await (window as any).getScreenDetails();
      const screens: ScreenInfo[] = details.screens.map((s: any) => ({
        left: s.availLeft,
        top: s.availTop,
        width: s.availWidth,
        height: s.availHeight,
        isPrimary: s.isPrimary,
      }));

      if (screens.length < 2) return; // Only one screen

      const primary = screens.find((s) => s.isPrimary) || screens[0];
      const originX = Math.min(...screens.map((s) => s.left));
      const originY = Math.min(...screens.map((s) => s.top));
      const aggregateWidth = Math.max(...screens.map((s) => s.left + s.width)) - originX;
      const aggregateHeight = Math.max(...screens.map((s) => s.top + s.height)) - originY;

      layout = { screens, primary, aggregateWidth, aggregateHeight, originX, originY };
    } catch {
      return; // Permission denied or API unavailable
    }

    // 2. Save original size for restoration
    originalSizeRef.current = {
      width: display.getWidth(),
      height: display.getHeight(),
    };
    layoutRef.current = layout;

    // 3. Request aggregate resolution from guacd
    client.sendSize(layout.aggregateWidth, layout.aggregateHeight);

    // 4. Open secondary windows and set up canvas slicing + input
    const defaultLayer = display.getDefaultLayer();
    const secondaryScreens = layout.screens.filter((s) => s !== layout.primary);

    for (const screen of secondaryScreens) {
      const features = [
        `left=${screen.left}`,
        `top=${screen.top}`,
        `width=${screen.width}`,
        `height=${screen.height}`,
        'menubar=no',
        'toolbar=no',
        'location=no',
        'status=no',
      ].join(',');

      const idx = layout.screens.indexOf(screen) + 1;
      const popup = window.open('about:blank', `strata-multimon-${sess.id}-${idx}`, features);
      if (!popup) continue;

      popup.document.title = `${sess.name} — Monitor ${idx}`;
      const body = popup.document.body;
      body.style.margin = '0';
      body.style.padding = '0';
      body.style.overflow = 'hidden';
      body.style.background = '#000';
      body.style.cursor = 'none';

      const canvas = popup.document.createElement('canvas');
      canvas.width = screen.width;
      canvas.height = screen.height;
      canvas.style.display = 'block';
      body.appendChild(canvas);

      const ctx = canvas.getContext('2d')!;

      // Source coordinates: this screen's offset relative to the aggregate origin
      const sourceX = screen.left - layout.originX;
      const sourceY = screen.top - layout.originY;

      // ── Mouse input with coordinate offset ──
      const mouse = new Guacamole.Mouse(canvas);
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
        const st = e.state;
        const remoteState = new Guacamole.Mouse.State(
          st.x + sourceX,
          st.y + sourceY,
          st.left, st.middle, st.right, st.up, st.down,
        );
        client.sendMouseState(remoteState, false);
      });

      // ── Keyboard input ──
      const keyboard = new Guacamole.Keyboard(popup.document);
      const winProxy = createWinKeyProxy(
        (pressed, keysym) => client.sendKeyEvent(pressed, keysym),
      );
      keyboard.onkeydown = (keysym: number) => winProxy.onkeydown(keysym);
      keyboard.onkeyup = (keysym: number) => { winProxy.onkeyup(keysym); };

      // Key trap — prevent browser shortcuts in the secondary window
      popup.document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'F12') return;
        if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J')) return;
        e.preventDefault();
      }, true);

      // Handle secondary window close → teardown all multi-monitor
      popup.addEventListener('pagehide', () => {
        // Use setTimeout to avoid recursive state-change during event
        setTimeout(() => disableMultiMonitor(), 0);
      });

      secondaryWindowsRef.current.push({
        win: popup,
        canvas,
        ctx,
        sourceX,
        sourceY,
        sliceW: screen.width,
        sliceH: screen.height,
        keyboard,
        mouse,
      });
    }

    // 5. Start the render loop — copies slices from the default layer canvas
    function renderLoop() {
      const srcCanvas = defaultLayer.canvas;
      for (const sw of secondaryWindowsRef.current) {
        if (sw.win.closed) continue;
        try {
          sw.ctx.drawImage(
            srcCanvas,
            sw.sourceX, sw.sourceY, sw.sliceW, sw.sliceH,
            0, 0, sw.sliceW, sw.sliceH,
          );
        } catch {
          // Canvas tainted or window closed — skip this frame
        }
      }
      rafIdRef.current = requestAnimationFrame(renderLoop);
    }
    rafIdRef.current = requestAnimationFrame(renderLoop);

    // 6. Store state on the session object (survives unmount/remount)
    const cleanup = () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      for (const sw of secondaryWindowsRef.current) {
        sw.keyboard.onkeydown = null;
        sw.keyboard.onkeyup = null;
        sw.keyboard.reset();
        sw.mouse.onmousedown = null;
        sw.mouse.onmouseup = null;
        sw.mouse.onmousemove = null;
        if (!sw.win.closed) {
          try { sw.win.close(); } catch { /* ignore */ }
        }
      }
      secondaryWindowsRef.current = [];
    };

    sess._multiMonitor = {
      windows: secondaryWindowsRef.current.map((sw) => sw.win),
      cleanup,
    };
    sess.isMultiMonitor = true;
    setIsMultiMonitor(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, containerRef, isMultiMonitor]);

  // ── Disable multi-monitor ─────────────────────────────────────────────
  const disableMultiMonitor = useCallback(() => {
    if (!session) return;

    // Tear down secondary windows
    if (session._multiMonitor) {
      session._multiMonitor.cleanup();
      session._multiMonitor = undefined;
    }

    // Restore original resolution
    if (originalSizeRef.current && containerRef.current) {
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      session.client.sendSize(cw, ch);
    }
    originalSizeRef.current = null;
    layoutRef.current = null;

    session.isMultiMonitor = false;
    setIsMultiMonitor(false);
  }, [session, containerRef]);

  // Expose the layout for the main window clipping logic
  const getLayout = useCallback(() => layoutRef.current, []);

  return {
    isMultiMonitor,
    canMultiMonitor,
    enableMultiMonitor,
    disableMultiMonitor,
    /** Returns the current monitor layout (null if not active) */
    getLayout,
  };
}
