import { useCallback, useEffect, useRef, useState } from 'react';
import Guacamole from 'guacamole-common-js';
import { GuacSession } from './SessionManager';
import { createWinKeyProxy } from '../utils/winKeyProxy';

/**
 * Browser-based multi-monitor support via canvas slicing.
 *
 * When enabled, the Guacamole session is resized to span the aggregate
 * bounding box of all detected screens.  The main window clips to the
 * primary monitor's region (via negative marginLeft on the display element)
 * while secondary browser windows each render their slice of the remote
 * desktop via requestAnimationFrame + drawImage from the display element.
 *
 * Input (mouse / keyboard) in secondary windows is offset-translated so
 * that coordinates map correctly to the aggregate remote resolution.
 * The main window mouse works automatically — the display element offset
 * means getBoundingClientRect() shifts, so Guacamole.Mouse coordinates
 * naturally include the primary region offset.
 *
 * Requires the Window Management API (Chromium 100+, `getScreenDetails()`).
 * Gracefully degrades to a no-op on unsupported browsers.
 */

interface ScreenInfo {
  /** Physical screen position — used for window.open() placement only */
  left: number;
  top: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

/** Computed tile in the aggregate virtual display */
interface ScreenTile {
  screen: ScreenInfo;
  /** X offset into the aggregate remote desktop (in remote pixels) */
  sliceX: number;
  /** Y offset into the aggregate remote desktop (in remote pixels) */
  sliceY: number;
}

interface MonitorLayout {
  screens: ScreenInfo[];
  tiles: ScreenTile[];
  primary: ScreenInfo;
  primaryTile: ScreenTile;
  aggregateWidth: number;
  aggregateHeight: number;
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

/** Cached screen details — requested once on permission grant. */
let cachedScreenDetails: MonitorLayout | null = null;

/**
 * Map raw ScreenDetailed objects to ScreenInfo, falling back to
 * `window.screen` dimensions for any screen that reports 0 width/height.
 * This handles Brave (and similar) browsers that zero out `availWidth` /
 * `availHeight` in the `getScreenDetails()` API for fingerprinting
 * protection.
 */
function mapScreenDetails(details: any): ScreenInfo[] {
  const fallbackW = window.screen.availWidth;
  const fallbackH = window.screen.availHeight;
  return details.screens.map((s: any) => ({
    left: s.availLeft ?? 0,
    top: s.availTop ?? 0,
    width: (s.availWidth > 0 ? s.availWidth : fallbackW),
    height: (s.availHeight > 0 ? s.availHeight : fallbackH),
    isPrimary: !!s.isPrimary,
  }));
}

/**
 * Build the aggregate layout by placing screens in a horizontal row.
 *
 * When physical positions are available (Chrome, Edge, etc.) screens are
 * sorted by their `left` coordinate so the remote desktop layout matches
 * the user's physical monitor arrangement — e.g. if the secondary is
 * physically to the LEFT of the primary, it gets a lower sliceX.
 *
 * When all positions are zeroed (Brave / fingerprinting) we fall back to
 * placing the primary first then secondaries cumulatively.
 */
function buildLayout(screens: ScreenInfo[]): MonitorLayout | null {
  if (screens.length < 2) return null;

  const primary = screens.find((s) => s.isPrimary) || screens[0];

  // Detect fingerprinted positions: every screen reports left=0, top=0.
  const positionsAvailable = !screens.every((s) => s.left === 0 && s.top === 0);

  let ordered: ScreenInfo[];
  if (positionsAvailable) {
    // Real positions: sort all screens by physical x coordinate so the
    // remote desktop left-to-right order matches the physical layout.
    ordered = [...screens].sort((a, b) => a.left - b.left || a.top - b.top);
  } else {
    // Fingerprinted: primary first, then secondaries.
    const secondaries = screens.filter((s) => s !== primary);
    ordered = [primary, ...secondaries];
  }

  const tiles: ScreenTile[] = [];
  let cursorX = 0;
  let primaryTile: ScreenTile | null = null;

  for (const screen of ordered) {
    const tile: ScreenTile = { screen, sliceX: cursorX, sliceY: 0 };
    tiles.push(tile);
    if (screen === primary) primaryTile = tile;
    cursorX += screen.width;
  }

  const aggregateWidth = cursorX;
  const aggregateHeight = Math.max(...screens.map((s) => s.height));

  console.log('[MultiMon] buildLayout:', {
    positionsAvailable,
    screenCount: screens.length,
    screens: screens.map(s => ({ left: s.left, top: s.top, w: s.width, h: s.height, primary: s.isPrimary })),
    tiles: tiles.map(t => ({ sliceX: t.sliceX, sliceY: t.sliceY, w: t.screen.width, h: t.screen.height, primary: t.screen.isPrimary })),
    aggregateWidth,
    aggregateHeight,
  });

  return { screens, tiles, primary, primaryTile: primaryTile!, aggregateWidth, aggregateHeight };
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

  // Feature-detect Window Management API and pre-request permission.
  // Caching the layout means enableMultiMonitor can be fully synchronous
  // (no await), which keeps the user-gesture context alive so the browser
  // allows opening multiple popups.
  useEffect(() => {
    if (!('getScreenDetails' in window)) return;
    setCanMultiMonitor(true);

    // Pre-request permission (shows prompt once, browser remembers)
    (async () => {
      try {
        const details = await (window as any).getScreenDetails();
        const screens = mapScreenDetails(details);
        cachedScreenDetails = buildLayout(screens);
      } catch { /* permission denied — canMultiMonitor stays true but enable will no-op */ }
    })();
  }, []);

  // ── Enable multi-monitor ──────────────────────────────────────────────
  // This is intentionally synchronous (no await) so that all window.open()
  // calls happen within the user-gesture context and aren't popup-blocked.
  const enableMultiMonitor = useCallback(() => {
    if (!session || !containerRef.current || isMultiMonitor) return;
    if (session.isPoppedOut) return;

    // Use cached layout (pre-requested on mount). If not yet available,
    // fall back to a one-shot async request — the first click may only
    // open 1 popup (browser popup blocker) but subsequent clicks work.
    let layout = cachedScreenDetails;
    if (!layout) {
      // Async fallback — triggers permission prompt, next click uses cache
      (async () => {
        try {
          const details = await (window as any).getScreenDetails();
          const screens = mapScreenDetails(details);
          cachedScreenDetails = buildLayout(screens);
        } catch { /* ignore */ }
      })();
      return;
    }

    const sess = session;
    const client = sess.client;
    const display = client.getDisplay();
    const displayEl = sess.displayEl;

    // Override the primary screen dimensions with the actual container size.
    // In single-monitor mode, sendSize(containerW, containerH) makes the
    // remote match the viewport at 1:1 scale. We preserve that behaviour
    // for the primary slice — otherwise the physical screen resolution
    // (often larger than the browser viewport) causes heavy down-scaling.
    const cw = containerRef.current!.clientWidth;
    const ch = containerRef.current!.clientHeight;
    const origPrimary = layout.primary;
    const adjustedScreens: ScreenInfo[] = layout.screens.map((s) =>
      s === origPrimary ? { ...s, width: cw, height: ch } : s,
    );
    const adjustedLayout = buildLayout(adjustedScreens);
    if (!adjustedLayout) return;
    layout = adjustedLayout;

    // Save original size for restoration
    originalSizeRef.current = {
      width: display.getWidth(),
      height: display.getHeight(),
    };
    layoutRef.current = layout;

    // ── Open ALL secondary windows synchronously (user-gesture context) ──
    // Use the tile layout (computed cumulative offsets) for canvas slicing,
    // but use the physical screen positions for window.open() placement.
    const secondaryTiles = layout.tiles.filter((t) => t !== layout.primaryTile);
    const popups: { popup: Window; tile: ScreenTile }[] = [];

    // Detect fingerprinted positions: if ALL non-primary screens report
    // left=0 and top=0, Brave (or similar) has zeroed them out. In that
    // case, estimate placement from cumulative tile offsets.
    const nonPrimary = layout.screens.filter((s) => s !== layout.primary);
    const positionsFingerprinted = nonPrimary.length > 0 &&
      nonPrimary.every((s) => s.left === 0 && s.top === 0);

    for (const tile of secondaryTiles) {
      const screen = tile.screen;
      // Use physical position if available, otherwise tile offset.
      // tile.sliceX is the cumulative width of preceding screens, which
      // equals the physical x-coordinate for standard horizontal layouts.
      const popupLeft = positionsFingerprinted ? tile.sliceX : screen.left;
      const popupTop = positionsFingerprinted ? tile.sliceY : screen.top;
      const features = [
        `left=${popupLeft}`,
        `top=${popupTop}`,
        `width=${screen.width}`,
        `height=${screen.height}`,
        'menubar=no',
        'toolbar=no',
        'location=no',
        'status=no',
      ].join(',');

      const idx = layout.tiles.indexOf(tile) + 1;
      const popup = window.open('about:blank', `strata-multimon-${sess.id}-${idx}`, features);
      if (!popup) continue;
      popups.push({ popup, tile });
    }

    if (popups.length === 0) return; // All popups blocked

    // ── Request aggregate resolution from guacd ──
    console.log('[MultiMon] sendSize:', layout.aggregateWidth, 'x', layout.aggregateHeight);
    client.sendSize(layout.aggregateWidth, layout.aggregateHeight);

    // ── Offset the display element so the primary region is visible ──
    // The container has overflow:hidden so only primaryW x primaryH is shown.
    // The primary tile is always at sliceX=0 (placed first in buildLayout),
    // so no marginLeft offset is needed. If the layout changes in future
    // to support arbitrary primary placement, the margin would be:
    //   marginLeft = -(primaryTile.sliceX * scale)
    const scale = display.getWidth() > 0
      ? Math.min(containerRef.current!.clientWidth / layout.primary.width,
                  containerRef.current!.clientHeight / layout.primary.height)
      : 1;
    displayEl.style.marginLeft = `-${layout.primaryTile.sliceX * scale}px`;
    displayEl.style.marginTop = `-${layout.primaryTile.sliceY * scale}px`;

    // ── Configure each secondary window ──
    for (const { popup, tile } of popups) {
      const screen = tile.screen;
      const sourceX = tile.sliceX;
      const sourceY = tile.sliceY;
      const idx = layout.tiles.indexOf(tile) + 1;
      popup.document.title = `${sess.name} — Monitor ${idx}`;
      const body = popup.document.body;
      body.style.margin = '0';
      body.style.padding = '0';
      body.style.overflow = 'hidden';
      body.style.background = '#000';

      const canvas = popup.document.createElement('canvas');
      canvas.width = screen.width;
      canvas.height = screen.height;
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      body.appendChild(canvas);

      const ctx = canvas.getContext('2d')!;

      // Resize the canvas backing store when the popup window is resized.
      // The slice coordinates (remote pixels) stay the same — only the
      // local canvas resolution changes so the image fills the window.
      function syncCanvasSize() {
        const w = popup.innerWidth;
        const h = popup.innerHeight;
        if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
          canvas.width = w;
          canvas.height = h;
        }
      }
      popup.addEventListener('resize', syncCanvasSize);

      // ── Mouse input with coordinate offset ──
      // Guacamole.Mouse reports CSS pixel coordinates relative to the
      // canvas element.  When the canvas is CSS-scaled (width/height:100%)
      // the CSS size may differ from the remote pixel slice dimensions,
      // so we scale before adding the tile offset.
      const sliceW = screen.width;
      const sliceH = screen.height;
      const mouse = new Guacamole.Mouse(canvas);
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
        const st = e.state;
        const cssW = canvas.clientWidth || sliceW;
        const cssH = canvas.clientHeight || sliceH;
        const remoteState = new Guacamole.Mouse.State(
          Math.round(st.x * sliceW / cssW) + sourceX,
          Math.round(st.y * sliceH / cssH) + sourceY,
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
      const pollId = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollId);
          disableMultiMonitor();
        }
      }, 500);

      console.log(`[MultiMon] Secondary window ${idx}: sourceX=${sourceX}, sourceY=${sourceY}, sliceW=${screen.width}, sliceH=${screen.height}`);

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

    // ── Render loop ──
    // Read from the default layer's canvas via getCanvas() each frame.
    // getCanvas() is a closure over the Layer's private canvas variable,
    // so it always returns the current canvas even after a resize.
    const defaultLayer = display.getDefaultLayer();

    let frameCount = 0;
    function renderLoop() {
      const srcCanvas = defaultLayer.getCanvas();
      if (frameCount % 120 === 0) {
        console.log(`[MultiMon] Frame ${frameCount}: srcCanvas=${srcCanvas.width}x${srcCanvas.height}, layer=${defaultLayer.width}x${defaultLayer.height}`);
        for (const sw of secondaryWindowsRef.current) {
          console.log(`  -> secondary: sourceX=${sw.sourceX}, sourceY=${sw.sourceY}, sliceW=${sw.sliceW}, sliceH=${sw.sliceH}, dstCanvas=${sw.canvas.width}x${sw.canvas.height}`);
        }
      }
      frameCount++;
      for (const sw of secondaryWindowsRef.current) {
        if (sw.win.closed) continue;
        try {
          sw.ctx.drawImage(
            srcCanvas,
            sw.sourceX, sw.sourceY, sw.sliceW, sw.sliceH,
            0, 0, sw.canvas.width, sw.canvas.height,
          );
        } catch {
          // Canvas tainted or window closed — skip this frame
        }
      }
      rafIdRef.current = requestAnimationFrame(renderLoop);
    }
    rafIdRef.current = requestAnimationFrame(renderLoop);

    // ── Store state (survives unmount/remount) ──
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
      // Reset display element offset
      displayEl.style.marginLeft = '';
      displayEl.style.marginTop = '';
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

    // Tear down secondary windows and reset display offset
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
