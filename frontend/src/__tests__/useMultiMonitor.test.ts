import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import Guacamole from 'guacamole-common-js';

// ── Mock guacamole-common-js ──────────────────────────────────────────
vi.mock('guacamole-common-js', () => {
  const mockDisplay = {
    getElement: () => document.createElement('div'),
    getWidth: () => 1920,
    getHeight: () => 1080,
    scale: vi.fn(),
    getDefaultLayer: () => ({
      getCanvas: () => document.createElement('canvas'),
    }),
    onresize: null as any,
  };
  const mockClient = {
    getDisplay: () => mockDisplay,
    sendMouseState: vi.fn(),
    sendSize: vi.fn(),
    sendKeyEvent: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    createClipboardStream: vi.fn(() => ({})),
    onclipboard: null as any,
    onfilesystem: null as any,
    onfile: null as any,
    onstatechange: null as any,
    onerror: null as any,
    onrequired: null as any,
    createArgumentValueStream: vi.fn(() => ({})),
  };

  return {
    default: {
      Client: vi.fn().mockImplementation(function () { return mockClient; }),
      WebSocketTunnel: vi.fn().mockImplementation(function () {
        return { onerror: null, onstatechange: null, oninstruction: null };
      }),
      Mouse: Object.assign(
        vi.fn().mockImplementation(function () {
          return { onEach: vi.fn(), onmousedown: null, onmouseup: null, onmousemove: null };
        }),
        {
          State: vi.fn().mockImplementation(function (
            x: number, y: number, l: boolean, m: boolean, r: boolean, u: boolean, d: boolean,
          ) {
            return { x, y, left: l, middle: m, right: r, up: u, down: d };
          }),
          Event: vi.fn(),
        },
      ),
      Keyboard: vi.fn().mockImplementation(function () {
        return { onkeydown: null, onkeyup: null, reset: vi.fn() };
      }),
    },
  };
});

// ── Mock winKeyProxy ──────────────────────────────────────────────────
vi.mock('../utils/winKeyProxy', () => ({
  createWinKeyProxy: vi.fn(() => ({
    onkeydown: vi.fn(),
    onkeyup: vi.fn(),
  })),
}));

// ── Import the hook ───────────────────────────────────────────────────
import { useMultiMonitor } from '../components/useMultiMonitor';

function makeSession(overrides: Record<string, any> = {}) {
  const tunnel = new Guacamole.WebSocketTunnel('ws://test');
  const client = new Guacamole.Client(tunnel);
  return {
    id: 'sess-1',
    connectionId: 'conn-1',
    name: 'Test Session',
    protocol: 'rdp',
    client,
    tunnel,
    displayEl: document.createElement('div'),
    keyboard: {} as any,
    createdAt: Date.now(),
    filesystems: [],
    remoteClipboard: '',
    isPoppedOut: false,
    isMultiMonitor: false,
    _multiMonitor: undefined,
    ...overrides,
  } as any;
}

function makeContainerRef() {
  const div = document.createElement('div');
  Object.defineProperty(div, 'clientWidth', { value: 1920, configurable: true });
  Object.defineProperty(div, 'clientHeight', { value: 1080, configurable: true });
  return { current: div };
}

describe('useMultiMonitor', () => {
  let originalGetScreenDetails: any;

  beforeEach(() => {
    vi.clearAllMocks();
    originalGetScreenDetails = (window as any).getScreenDetails;
  });

  afterEach(() => {
    if (originalGetScreenDetails !== undefined) {
      (window as any).getScreenDetails = originalGetScreenDetails;
    } else {
      delete (window as any).getScreenDetails;
    }
  });

  it('returns canMultiMonitor=false when Window Management API is unavailable', () => {
    delete (window as any).getScreenDetails;
    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    expect(result.current.canMultiMonitor).toBe(false);
    expect(result.current.isMultiMonitor).toBe(false);
    expect(result.current.screenCount).toBe(0);
  });

  it('returns canMultiMonitor=true when getScreenDetails is available', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    expect(result.current.canMultiMonitor).toBe(true);

    // Wait for the async permission pre-request
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.screenCount).toBe(2);
  });

  it('returns isMultiMonitor=false initially', () => {
    delete (window as any).getScreenDetails;
    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));
    expect(result.current.isMultiMonitor).toBe(false);
  });

  it('syncs isMultiMonitor from session._multiMonitor on session change', () => {
    delete (window as any).getScreenDetails;
    const session1 = makeSession({ _multiMonitor: { windows: [], cleanup: vi.fn() } });
    const session2 = makeSession({ _multiMonitor: undefined });
    const containerRef = makeContainerRef();

    const { result, rerender } = renderHook(
      ({ sess }) => useMultiMonitor(sess, containerRef),
      { initialProps: { sess: session1 } },
    );

    expect(result.current.isMultiMonitor).toBe(true);

    rerender({ sess: session2 });
    expect(result.current.isMultiMonitor).toBe(false);
  });

  it('enableMultiMonitor does nothing when session is undefined', async () => {
    (window as any).getScreenDetails = vi.fn().mockResolvedValue({
      screens: [{ availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true }],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(undefined, containerRef));

    // Clear the mount-time pre-request call
    (window as any).getScreenDetails.mockClear();

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    expect(result.current.isMultiMonitor).toBe(false);
    // enableMultiMonitor returns early when session is undefined,
    // so getScreenDetails should NOT be called from enableMultiMonitor
    expect((window as any).getScreenDetails).not.toHaveBeenCalled();
  });

  it('enableMultiMonitor does nothing when session is popped out', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);
    const session = makeSession({ isPoppedOut: true });
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    expect(result.current.isMultiMonitor).toBe(false);
  });

  it('enableMultiMonitor does nothing when already in multi-monitor mode', async () => {
    (window as any).getScreenDetails = vi.fn().mockResolvedValue({
      screens: [{ availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true }],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const session = makeSession({ _multiMonitor: { windows: [], cleanup: vi.fn() } });
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    // isMultiMonitor is already true from _multiMonitor
    expect(result.current.isMultiMonitor).toBe(true);

    // Clear the mount-time pre-request call
    (window as any).getScreenDetails.mockClear();

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    // enableMultiMonitor short-circuits when isMultiMonitor is true,
    // so getScreenDetails should NOT be called from enableMultiMonitor
    expect((window as any).getScreenDetails).not.toHaveBeenCalled();
  });

  it('enableMultiMonitor handles getScreenDetails permission denial gracefully', async () => {
    (window as any).getScreenDetails = vi.fn().mockRejectedValue(new Error('Permission denied'));
    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    expect(result.current.isMultiMonitor).toBe(false);
  });

  it('enableMultiMonitor returns early when only 1 screen detected', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);
    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    expect(result.current.isMultiMonitor).toBe(false);
  });

  it('enableMultiMonitor opens secondary windows and sets isMultiMonitor=true', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const mockPopup = {
      closed: false,
      document: {
        title: '',
        body: {
          style: { margin: '', padding: '', overflow: '', background: '' },
          appendChild: vi.fn(),
        },
        createElement: vi.fn(() => {
          const canvas = document.createElement('canvas');
          Object.defineProperty(canvas, 'clientWidth', { value: 1920 });
          Object.defineProperty(canvas, 'clientHeight', { value: 1080 });
          (canvas as any).getContext = vi.fn(() => ({
            drawImage: vi.fn(),
          }));
          return canvas;
        }),
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      close: vi.fn(),
      innerWidth: 1920,
      innerHeight: 1080,
    };
    const originalOpen = window.open;
    window.open = vi.fn().mockReturnValue(mockPopup);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    expect(window.open).toHaveBeenCalled();
    expect(result.current.isMultiMonitor).toBe(true);
    expect(session.isMultiMonitor).toBe(true);
    expect(session._multiMonitor).toBeDefined();
    expect(session.client.sendSize).toHaveBeenCalled();

    // Cleanup
    window.open = originalOpen;
  });

  it('enableMultiMonitor returns early if all popups are blocked', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);
    const originalOpen = window.open;
    window.open = vi.fn().mockReturnValue(null); // blocked

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    expect(result.current.isMultiMonitor).toBe(false);

    window.open = originalOpen;
  });

  it('disableMultiMonitor restores session state', async () => {
    delete (window as any).getScreenDetails;
    const cleanupFn = vi.fn();
    const session = makeSession({
      isMultiMonitor: true,
      _multiMonitor: { windows: [], cleanup: cleanupFn },
    });
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));
    expect(result.current.isMultiMonitor).toBe(true);

    await act(async () => {
      result.current.disableMultiMonitor();
    });

    expect(cleanupFn).toHaveBeenCalled();
    expect(session.isMultiMonitor).toBe(false);
    expect(session._multiMonitor).toBeUndefined();
    expect(result.current.isMultiMonitor).toBe(false);
  });

  it('disableMultiMonitor does nothing when session is undefined', () => {
    delete (window as any).getScreenDetails;
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(undefined, containerRef));
    // Should not throw
    act(() => {
      result.current.disableMultiMonitor();
    });
  });

  it('disableMultiMonitor sends resize when originalSize was stored', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const mockPopup = {
      closed: false,
      document: {
        title: '',
        body: {
          style: { margin: '', padding: '', overflow: '', background: '' },
          appendChild: vi.fn(),
        },
        createElement: vi.fn(() => {
          const canvas = document.createElement('canvas');
          Object.defineProperty(canvas, 'clientWidth', { value: 1920 });
          Object.defineProperty(canvas, 'clientHeight', { value: 1080 });
          (canvas as any).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
          return canvas;
        }),
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      close: vi.fn(),
      innerWidth: 1920,
      innerHeight: 1080,
    };
    const originalOpen = window.open;
    window.open = vi.fn().mockReturnValue(mockPopup);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    expect(result.current.isMultiMonitor).toBe(true);
    session.client.sendSize.mockClear();

    await act(async () => {
      result.current.disableMultiMonitor();
    });

    expect(session.client.sendSize).toHaveBeenCalledWith(1920, 1080);
    expect(result.current.isMultiMonitor).toBe(false);

    window.open = originalOpen;
  });

  it('getLayout returns null when multi-monitor is not active', () => {
    delete (window as any).getScreenDetails;
    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));
    expect(result.current.getLayout()).toBeNull();
  });

  it('updatePrimarySize does nothing when layout is null', () => {
    delete (window as any).getScreenDetails;
    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));
    // Should not throw
    act(() => {
      result.current.updatePrimarySize(1920, 1080);
    });
  });

  it('handles Brave fingerprinted screens (all positions zeroed)', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 0, availHeight: 0, isPrimary: true },
        { availLeft: 0, availTop: 0, availWidth: 0, availHeight: 0, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    // Set fallback dimensions
    Object.defineProperty(window.screen, 'availWidth', { value: 1920, configurable: true });
    Object.defineProperty(window.screen, 'availHeight', { value: 1080, configurable: true });

    const mockPopup = {
      closed: false,
      document: {
        title: '',
        body: {
          style: { margin: '', padding: '', overflow: '', background: '' },
          appendChild: vi.fn(),
        },
        createElement: vi.fn(() => {
          const canvas = document.createElement('canvas');
          Object.defineProperty(canvas, 'clientWidth', { value: 1920 });
          Object.defineProperty(canvas, 'clientHeight', { value: 1080 });
          (canvas as any).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
          return canvas;
        }),
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      close: vi.fn(),
      innerWidth: 1920,
      innerHeight: 1080,
    };
    const originalOpen = window.open;
    window.open = vi.fn().mockReturnValue(mockPopup);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    // Should succeed despite zeroed screens — falls back to window.screen
    expect(result.current.isMultiMonitor).toBe(true);
    expect(window.open).toHaveBeenCalled();

    window.open = originalOpen;
  });

  it('handles 3 screens correctly', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
        { availLeft: 3840, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const mockPopup = {
      closed: false,
      document: {
        title: '',
        body: {
          style: { margin: '', padding: '', overflow: '', background: '' },
          appendChild: vi.fn(),
        },
        createElement: vi.fn(() => {
          const canvas = document.createElement('canvas');
          Object.defineProperty(canvas, 'clientWidth', { value: 1920 });
          Object.defineProperty(canvas, 'clientHeight', { value: 1080 });
          (canvas as any).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
          return canvas;
        }),
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      close: vi.fn(),
      innerWidth: 1920,
      innerHeight: 1080,
    };
    const originalOpen = window.open;
    window.open = vi.fn().mockReturnValue(mockPopup);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    // 2 secondary windows should be opened (3 screens - 1 primary)
    expect(window.open).toHaveBeenCalledTimes(2);
    expect(result.current.isMultiMonitor).toBe(true);

    window.open = originalOpen;
  });

  it('handles some popups blocked (partial open)', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
        { availLeft: 3840, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const mockPopup = {
      closed: false,
      document: {
        title: '',
        body: {
          style: { margin: '', padding: '', overflow: '', background: '' },
          appendChild: vi.fn(),
        },
        createElement: vi.fn(() => {
          const canvas = document.createElement('canvas');
          Object.defineProperty(canvas, 'clientWidth', { value: 1920 });
          Object.defineProperty(canvas, 'clientHeight', { value: 1080 });
          (canvas as any).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
          return canvas;
        }),
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      close: vi.fn(),
      innerWidth: 1920,
      innerHeight: 1080,
    };
    const originalOpen = window.open;
    // First popup opens, second is blocked
    window.open = vi.fn()
      .mockReturnValueOnce(mockPopup)
      .mockReturnValueOnce(null);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    // Should still enable multi-monitor with 1 of 2 secondary windows
    expect(result.current.isMultiMonitor).toBe(true);

    window.open = originalOpen;
  });

  it('updatePrimarySize sends new aggregate size to server', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const mockPopup = {
      closed: false,
      document: {
        title: '',
        body: {
          style: { margin: '', padding: '', overflow: '', background: '' },
          appendChild: vi.fn(),
        },
        createElement: vi.fn(() => {
          const canvas = document.createElement('canvas');
          Object.defineProperty(canvas, 'clientWidth', { value: 1920 });
          Object.defineProperty(canvas, 'clientHeight', { value: 1080 });
          (canvas as any).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
          return canvas;
        }),
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      close: vi.fn(),
      innerWidth: 1920,
      innerHeight: 1080,
    };
    const originalOpen = window.open;
    window.open = vi.fn().mockReturnValue(mockPopup);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    expect(result.current.isMultiMonitor).toBe(true);
    session.client.sendSize.mockClear();

    // Simulate container resize
    act(() => {
      result.current.updatePrimarySize(1600, 900);
    });

    expect(session.client.sendSize).toHaveBeenCalled();

    window.open = originalOpen;
  });

  it('updatePrimarySize skips when change is too small (< 2px)', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const mockPopup = {
      closed: false,
      document: {
        title: '',
        body: {
          style: { margin: '', padding: '', overflow: '', background: '' },
          appendChild: vi.fn(),
        },
        createElement: vi.fn(() => {
          const canvas = document.createElement('canvas');
          Object.defineProperty(canvas, 'clientWidth', { value: 1920 });
          Object.defineProperty(canvas, 'clientHeight', { value: 1080 });
          (canvas as any).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
          return canvas;
        }),
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      close: vi.fn(),
      innerWidth: 1920,
      innerHeight: 1080,
    };
    const originalOpen = window.open;
    window.open = vi.fn().mockReturnValue(mockPopup);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    session.client.sendSize.mockClear();

    // Change by only 1px — should be skipped
    act(() => {
      result.current.updatePrimarySize(1921, 1081);
    });

    expect(session.client.sendSize).not.toHaveBeenCalled();

    window.open = originalOpen;
  });

  it('getLayout returns layout when multi-monitor is active', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
        { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const mockPopup = {
      closed: false,
      document: {
        title: '',
        body: {
          style: { margin: '', padding: '', overflow: '', background: '' },
          appendChild: vi.fn(),
        },
        createElement: vi.fn(() => {
          const canvas = document.createElement('canvas');
          Object.defineProperty(canvas, 'clientWidth', { value: 1920 });
          Object.defineProperty(canvas, 'clientHeight', { value: 1080 });
          (canvas as any).getContext = vi.fn(() => ({ drawImage: vi.fn() }));
          return canvas;
        }),
        addEventListener: vi.fn(),
      },
      addEventListener: vi.fn(),
      close: vi.fn(),
      innerWidth: 1920,
      innerHeight: 1080,
    };
    const originalOpen = window.open;
    window.open = vi.fn().mockReturnValue(mockPopup);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await result.current.enableMultiMonitor();
    });

    const layout = result.current.getLayout();
    expect(layout).not.toBeNull();
    expect(layout!.tiles.length).toBe(2);
    expect(layout!.aggregateWidth).toBeGreaterThan(1920);

    window.open = originalOpen;
  });

  it('screenschange listener updates screenCount', async () => {
    let screensChangeHandler: (() => void) | null = null;
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
      ],
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'screenschange') screensChangeHandler = handler;
      }),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { result } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.screenCount).toBe(1);

    // Simulate plugging in a second monitor
    mockDetails.screens.push(
      { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false },
    );

    if (screensChangeHandler) {
      await act(async () => {
        screensChangeHandler!();
      });
    }

    expect(result.current.screenCount).toBe(2);
  });

  it('cleans up screenschange listener on unmount', async () => {
    const mockDetails = {
      screens: [
        { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: true },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    (window as any).getScreenDetails = vi.fn().mockResolvedValue(mockDetails);

    const session = makeSession();
    const containerRef = makeContainerRef();

    const { unmount } = renderHook(() => useMultiMonitor(session, containerRef));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    unmount();

    expect(mockDetails.removeEventListener).toHaveBeenCalledWith(
      'screenschange',
      expect.any(Function),
    );
  });
});
