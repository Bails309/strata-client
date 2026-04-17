import { useCallback, useEffect, useRef, useState } from 'react';
import Guacamole from 'guacamole-common-js';
import { GuacSession } from './SessionManager';
import { createWinKeyProxy } from '../utils/winKeyProxy';
import { installShortcutProxy } from '../utils/shortcutProxy';
import { installKeyboardLock, requestFullscreenWithLock } from '../utils/keyboardLock';

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
  removeShortcutProxy: () => void;
  removeKeyboardLock: () => void;
}

/** Live ScreenDetails object — fires `screenschange` when monitors change. */
let liveScreenDetails: any = null;

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
 * Build the aggregate layout from detected screens.
 *
 * All monitors are placed in a flat horizontal row at sliceY=0, ordered
 * by their physical left coordinate (primary first when positions are
 * unavailable).  Vertical offsets are intentionally ignored because
 * guacd sends a single flat resolution to the RDP/VNC server — the
 * remote OS treats it as ONE display.  Vertical offsets are ignored and
 * all monitors are placed in a flat horizontal row at sliceY=0.
 *
 * The aggregate height is capped to the **primary** monitor's height.
 * Because the remote OS sees a single display, it places the taskbar at
 * the very bottom of the aggregate.  If we used max(all heights) —
 * e.g. 1920 from a portrait monitor — the taskbar would be at y≈1890,
 * invisible on any 1080-high landscape monitors.  By capping to the
 * primary height the taskbar stays visible on the primary monitor (and
 * any same-height monitors).  Taller secondary monitors (portrait) show
 * the primary-height region of the remote desktop with black below.
 */
function buildLayout(screens: ScreenInfo[]): MonitorLayout | null {
  if (screens.length < 2) return null;

  const primary = screens.find((s) => s.isPrimary) || screens[0];

  // Detect fingerprinted positions: every screen reports left=0, top=0.
  const positionsAvailable = !screens.every((s) => s.left === 0 && s.top === 0);

  const tiles: ScreenTile[] = [];
  let primaryTile: ScreenTile | null = null;

  // Order screens: when physical positions are available, sort by
  // horizontal position (left) so the spatial left→right ordering
  // is preserved.  Otherwise, primary first then secondaries.
  let ordered: ScreenInfo[];
  if (positionsAvailable) {
    ordered = [...screens].sort((a, b) => a.left - b.left);
  } else {
    const secondaries = screens.filter((s) => s !== primary);
    ordered = [primary, ...secondaries];
  }

  // Place all monitors in a horizontal row at sliceY = 0.
  let cursorX = 0;
  for (const screen of ordered) {
    const tile: ScreenTile = { screen, sliceX: cursorX, sliceY: 0 };
    tiles.push(tile);
    if (screen === primary) primaryTile = tile;
    cursorX += screen.width;
  }

  // Cap aggregate height to the primary monitor's height so the remote
  // taskbar sits within the primary slice's visible area.
  const aggregateWidth  = cursorX;
  const aggregateHeight = primary.height;

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
  const [screenCount, setScreenCount] = useState(0);

  const secondaryWindowsRef = useRef<SecondaryWindow[]>([]);
  const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const originalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const layoutRef = useRef<MonitorLayout | null>(null);

  // Sync when session changes (e.g. switching connections)
  useEffect(() => {
    setIsMultiMonitor(!!session?._multiMonitor);
  }, [session]);

  // Feature-detect Window Management API and pre-request permission.
  // We also listen for `screenschange` on the live ScreenDetails object
  // so that the cache stays current when monitors are plugged in/out.
  useEffect(() => {
    if (!('getScreenDetails' in window)) return;
    setCanMultiMonitor(true);

    function refreshCache() {
      if (!liveScreenDetails) return;
      const screens = mapScreenDetails(liveScreenDetails);
      setScreenCount(screens.length);
    }

    // Pre-request permission (shows prompt once, browser remembers).
    // This may fail silently if the permission hasn't been granted yet
    // (no user gesture). That's fine — enableMultiMonitor will request
    // it from the click handler (user gesture) as a fallback.
    (async () => {
      try {
        liveScreenDetails = await (window as any).getScreenDetails();
        refreshCache();
        liveScreenDetails.addEventListener('screenschange', refreshCache);
      } catch { /* permission denied or no user gesture — will retry on click */ }
    })();

    return () => {
      if (liveScreenDetails) {
        liveScreenDetails.removeEventListener('screenschange', refreshCache);
      }
    };
  }, []);

  // ── Enable multi-monitor ──────────────────────────────────────────────
  // Chrome allows multiple window.open() calls from a single user gesture
  // ONLY when getScreenDetails() is called within that same gesture.
  // This is by design — getScreenDetails() signals multi-screen intent
  // and Chrome preserves user activation through its await.
  //
  // The flow is: click → await getScreenDetails() → window.open() × N.
  // All window.open() calls must happen immediately after the await with
  // minimal work in between.  Layout computation uses pre-cached data.
  const enableMultiMonitor = useCallback(async () => {
    if (!session || !containerRef.current || isMultiMonitor) return;
    if (session.isPoppedOut) return;

    // ── Step 1: Call getScreenDetails() in the click handler ──
    // This is the critical call that tells Chrome to allow multiple popups.
    // When the permission is already granted, it resolves in ~1ms and
    // Chrome preserves user activation through the await.
    let details: any;
    try {
      details = await (window as any).getScreenDetails();
    } catch {
      // Permission denied — cannot do multi-monitor
      return;
    }

    // Update the cache from the fresh details
    liveScreenDetails = details;
    const screens = mapScreenDetails(details);
    const freshLayout = buildLayout(screens);
    if (!freshLayout) return;
    setScreenCount(screens.length);

    // Attach screenschange listener (idempotent — listener is a no-op if already attached)
    details.addEventListener('screenschange', () => {
      if (liveScreenDetails === details) {
        const s = mapScreenDetails(details);
        setScreenCount(s.length);
      }
    });

    // ── Step 2: Compute adjusted layout and open popups IMMEDIATELY ──
    // Minimize work between getScreenDetails() resolution and window.open()
    // to keep within Chrome's user activation window.
    const sess = session;
    const client = sess.client;
    const display = client.getDisplay();
    const displayEl = sess.displayEl;
    const container = containerRef.current!;

    // Override primary screen dimensions with actual container size.
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const origPrimary = freshLayout.primary;
    const adjustedScreens: ScreenInfo[] = freshLayout.screens.map((s) =>
      s === origPrimary ? { ...s, width: cw, height: ch } : s,
    );
    const adjustedLayout = buildLayout(adjustedScreens);
    if (!adjustedLayout) return;
    const layout = adjustedLayout;

    // Save original size for restoration
    originalSizeRef.current = {
      width: display.getWidth(),
      height: display.getHeight(),
    };
    layoutRef.current = layout;

    // ── Open ALL secondary windows (user activation extended by getScreenDetails) ──
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
      if (!popup) {
        console.warn(`[MultiMon] Popup ${idx} blocked by browser. Try allowing popups for this site.`);
        continue;
      }
      popups.push({ popup, tile });
    }

    if (popups.length === 0) return; // All popups blocked

    // Warn if some popups were blocked
    if (popups.length < secondaryTiles.length) {
      console.warn(
        `[MultiMon] Only ${popups.length} of ${secondaryTiles.length} popups opened. ` +
        `${secondaryTiles.length - popups.length} blocked by browser. ` +
        `Allow popups for this site in browser settings, then try again.`
      );
    }

    // ── Request aggregate resolution from guacd ──
    client.sendSize(layout.aggregateWidth, layout.aggregateHeight);

    // ── Scale the display and offset so the primary region is visible ──
    // The container has overflow:hidden so only primaryW x primaryH is shown.
    // We must set display.scale() explicitly so the primary slice fills the
    // container, rather than relying solely on the resize handler (which may
    // fire asynchronously after the server responds).
    const scale = Math.min(
      containerRef.current!.clientWidth / layout.primary.width,
      containerRef.current!.clientHeight / layout.primary.height,
    );
    display.scale(scale);
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

      // Maximize the popup to fill the target screen.  window.open()
      // dimensions include browser chrome, so the inner area is smaller.
      // moveTo + resizeTo after a tick corrects placement, and we also
      // try the Fullscreen API for a truly chrome-free view.
      const popupLeft = positionsFingerprinted ? tile.sliceX : screen.left;
      const popupTop = positionsFingerprinted ? tile.sliceY : screen.top;
      try {
        popup.moveTo(popupLeft, popupTop);
        popup.resizeTo(screen.width, screen.height);
      } catch { /* cross-origin or restricted */ }

      // Try fullscreen (removes title bar + address bar entirely).
      // This can fail if the user-activation has expired — that's fine,
      // the popup still covers most of the screen.
      try {
        requestFullscreenWithLock(popup.document.documentElement).catch(() => {});
      } catch { /* Fullscreen API unavailable */ }

      const canvas = popup.document.createElement('canvas');
      canvas.width = popup.innerWidth || screen.width;
      canvas.height = popup.innerHeight || screen.height;
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

      // Sync canvas on fullscreen change (entering/exiting fullscreen resizes the window)
      popup.document.addEventListener('fullscreenchange', syncCanvasSize);

      // ── Mouse input with coordinate offset ──
      // Guacamole.Mouse reports CSS pixel coordinates relative to the
      // canvas element.  When the canvas is CSS-scaled (width/height:100%)
      // the CSS size may differ from the remote pixel slice dimensions,
      // so we scale before adding the tile offset.
      // sliceH is capped to the aggregate height so portrait monitors
      // don't read/send coordinates beyond the remote framebuffer.
      const sliceW = screen.width;
      const sliceH = Math.min(screen.height, layout.aggregateHeight);
      const mouse = new Guacamole.Mouse(canvas);
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e: Guacamole.Mouse.Event) => {
        const st = e.state;
        const cssW = canvas.clientWidth || sliceW;
        const cssH = canvas.clientHeight || sliceH;
        const remoteY = Math.min(
          Math.round(st.y * sliceH / cssH) + sourceY,
          layout.aggregateHeight - 1,
        );
        const remoteState = new Guacamole.Mouse.State(
          Math.round(st.x * sliceW / cssW) + sourceX,
          remoteY,
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
        // Ctrl+K → relay to main window to open command palette
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
          e.preventDefault();
          e.stopImmediatePropagation();
          keyboard.reset();
          window.postMessage({ type: 'strata:open-command-palette' }, '*');
          return;
        }
        e.preventDefault();
      }, true);

      // Shortcut proxy: Ctrl+Alt+Tab → Alt+Tab, Ctrl+Alt+` → Win+Tab
      const removeShortcutProxy = installShortcutProxy(
        popup.document,
        (pressed, keysym) => client.sendKeyEvent(pressed, keysym),
      );

      // Keyboard Lock: capture OS-level shortcuts in fullscreen popups
      const removeKeyboardLock = installKeyboardLock(popup.document);

      // Handle secondary window close → teardown all multi-monitor
      const pollId = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollId);
          disableMultiMonitor();
        }
      }, 500);

      secondaryWindowsRef.current.push({
        win: popup,
        canvas,
        ctx,
        sourceX,
        sourceY,
        sliceW: screen.width,
        sliceH: Math.min(screen.height, layout.aggregateHeight),
        keyboard,
        mouse,
        removeShortcutProxy,
        removeKeyboardLock,
      });
    }

    // ── Render loop ──
    // Read from the default layer's canvas each frame.  Use setInterval
    // instead of requestAnimationFrame because rAF is throttled/paused
    // when the main window loses focus to a popup — which happens
    // immediately when the user interacts with a secondary monitor window.
    //
    // We use getCanvas() on the default layer rather than display.flatten()
    // because flatten() allocates a brand-new canvas every call.  At 30fps
    // with a 4920x1080 aggregate that's ~600MB/s of allocations, starving
    // the main thread and preventing Guacamole from rendering (black screens).
    // getCanvas() returns a reference to the existing backing canvas — zero
    // allocation.
    const defaultLayer = display.getDefaultLayer();

    function renderLoop() {
      const srcCanvas = defaultLayer.getCanvas();
      if (!srcCanvas || srcCanvas.width <= 0 || srcCanvas.height <= 0) return;
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
    }
    intervalIdRef.current = setInterval(renderLoop, 33); // ~30 fps

    // ── Cursor sync ──
    // Guacamole renders the remote cursor as a CSS `cursor` property on
    // the display element (a data URL with hotspot coordinates).  This
    // doesn't automatically apply to the secondary canvas elements.
    // Use a MutationObserver to watch for style changes on the display
    // element and mirror the cursor CSS to every secondary canvas.
    const displayElement = display.getElement();
    function syncCursor() {
      const cursor = displayElement.style.cursor;
      for (const sw of secondaryWindowsRef.current) {
        if (!sw.win.closed) {
          sw.canvas.style.cursor = cursor;
        }
      }
    }
    // Initial sync
    syncCursor();
    // Watch for style attribute changes (Guacamole updates cursor via style.cursor)
    const cursorObserver = new MutationObserver(syncCursor);
    cursorObserver.observe(displayElement, { attributes: true, attributeFilter: ['style'] });

    // ── Store state (survives unmount/remount) ──
    const cleanup = () => {
      cursorObserver.disconnect();
      if (intervalIdRef.current) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
      for (const sw of secondaryWindowsRef.current) {
        sw.keyboard.onkeydown = null;
        sw.keyboard.onkeyup = null;
        sw.keyboard.reset();
        sw.mouse.onmousedown = null;
        sw.mouse.onmouseup = null;
        sw.mouse.onmousemove = null;
        sw.removeShortcutProxy();
        sw.removeKeyboardLock();
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

  // Recalculate layout when the container resizes (e.g. sidebar collapse).
  // Updates the primary tile dimensions to match the new container size,
  // recomputes the aggregate, and sends the new size to the server.
  const updatePrimarySize = useCallback((newW: number, newH: number) => {
    const layout = layoutRef.current;
    if (!layout || !session) return;

    const oldPW = layout.primary.width;
    const oldPH = layout.primary.height;
    // Skip if the primary dimensions haven't changed meaningfully (< 2px)
    if (Math.abs(newW - oldPW) < 2 && Math.abs(newH - oldPH) < 2) return;

    const origPrimary = layout.primary;
    const adjusted = buildLayout(
      layout.screens.map((s) =>
        s === origPrimary ? { ...s, width: newW, height: newH } : s,
      ),
    );
    if (!adjusted) return;

    layoutRef.current = adjusted;
    session.client.sendSize(adjusted.aggregateWidth, adjusted.aggregateHeight);
  }, [session]);

  return {
    isMultiMonitor,
    canMultiMonitor,
    /** Number of screens detected by the Window Management API */
    screenCount,
    enableMultiMonitor,
    disableMultiMonitor,
    /** Returns the current monitor layout (null if not active) */
    getLayout,
    /** Recalculate layout when the primary container resizes */
    updatePrimarySize,
  };
}
