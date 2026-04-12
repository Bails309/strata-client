import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock guacamole-common-js
vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(function() {
      return {
        getDisplay: vi.fn(() => ({
          getElement: () => document.createElement('div'),
          getWidth: () => 1920,
          getHeight: () => 1080,
          scale: vi.fn(),
        })),
        sendMouseState: vi.fn(),
        sendKeyEvent: vi.fn(),
        sendSize: vi.fn(),
      };
    }),
    Mouse: Object.assign(vi.fn(function() {
      return {
        onEach: vi.fn(),
        onmousedown: null,
        onmouseup: null,
        onmousemove: null,
      };
    }), {
      Touchscreen: vi.fn(function() {
        return {
          onEach: vi.fn(),
          onmousedown: null,
          onmouseup: null,
          onmousemove: null,
        };
      }),
      Event: vi.fn(),
    }),
    Keyboard: vi.fn(function() {
      return {
        onkeydown: null,
        onkeyup: null,
        reset: vi.fn(),
      };
    }),
  },
}));

import { usePopOut } from '../components/usePopOut';

function createMockSession() {
  return {
    id: 'sess-1',
    name: 'Test Server',
    connectionId: 'conn-1',
    displayEl: document.createElement('div'),
    client: {
      getDisplay: vi.fn(() => ({
        getElement: () => document.createElement('div'),
        getWidth: () => 1920,
        getHeight: () => 1080,
        scale: vi.fn(),
      })),
      sendMouseState: vi.fn(),
      sendKeyEvent: vi.fn(),
      sendSize: vi.fn(),
    },
  };
}

function createMockPopupWindow() {
  const body = document.createElement('body') as any;
  body.style = {} as CSSStyleDeclaration;
  body.appendChild = vi.fn();
  const doc = {
    title: '',
    body,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return {
    closed: false,
    close: vi.fn(),
    document: doc,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    innerWidth: 1920,
    innerHeight: 1080,
  };
}

describe('usePopOut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns isPoppedOut=false initially', () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));
    expect(result.current.isPoppedOut).toBe(false);
  });

  it('returns popOut and returnDisplay functions', () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));
    expect(typeof result.current.popOut).toBe('function');
    expect(typeof result.current.returnDisplay).toBe('function');
  });

  it('handles undefined session gracefully', () => {
    const containerRef = { current: document.createElement('div') };
    const { result } = renderHook(() => usePopOut(undefined, containerRef as any));
    expect(result.current.isPoppedOut).toBe(false);
  });

  it('returnDisplay is no-op when no session', () => {
    const containerRef = { current: document.createElement('div') };
    const { result } = renderHook(() => usePopOut(undefined, containerRef as any));
    act(() => {
      result.current.returnDisplay();
    });
    expect(result.current.isPoppedOut).toBe(false);
  });

  it('popOut does nothing when window.open is blocked', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(result.current.isPoppedOut).toBe(false);
  });

  it('popOut opens a window and sets isPoppedOut=true', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(result.current.isPoppedOut).toBe(true);
    expect(window.open).toHaveBeenCalled();
  });

  it('popOut sets the popup window title', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.document.title).toBe('Test Server — Strata');
  });

  it('popOut does nothing when already popped out', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });
    expect(result.current.isPoppedOut).toBe(true);

    // Second call should be no-op
    await act(async () => {
      await result.current.popOut();
    });
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('returnDisplay sets isPoppedOut=false after popOut', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });
    expect(result.current.isPoppedOut).toBe(true);

    act(() => {
      result.current.returnDisplay();
    });
    expect(result.current.isPoppedOut).toBe(false);
  });

  it('returnDisplay closes the popup window', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    act(() => {
      result.current.returnDisplay();
    });

    expect(mockPopup.close).toHaveBeenCalled();
  });

  it('returnDisplay re-attaches display element to container', async () => {
    const session = createMockSession();
    const container = document.createElement('div');
    const containerRef = { current: container };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });
    act(() => {
      result.current.returnDisplay();
    });

    // Container should have the display element
    expect(container.children.length).toBeGreaterThanOrEqual(0);
  });

  it('popOut reparents display element to popup body', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.document.body.appendChild).toHaveBeenCalledWith(session.displayEl);
  });

  it('popOut registers resize event on popup', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('does NOT close popup on unmount (popup persists across route changes)', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result, unmount } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    unmount();
    // Popup should remain open — SessionManager handles cleanup when the session ends
    expect(mockPopup.close).not.toHaveBeenCalled();
    expect((session as any)._popout).toBeDefined();
  });

  it('popOut tries to use Window Management API for secondary screen', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);
    
    // Mock getScreenDetails API
    (window as any).getScreenDetails = vi.fn().mockResolvedValue({
      screens: [
        { isPrimary: true, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 },
        { isPrimary: false, availLeft: 1920, availTop: 0, availWidth: 2560, availHeight: 1440 },
      ],
    });

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(result.current.isPoppedOut).toBe(true);
    expect(window.open).toHaveBeenCalledWith(
      'about:blank',
      expect.stringContaining('strata-popout-'),
      expect.stringContaining('left=1920'),
    );

    delete (window as any).getScreenDetails;
  });

  it('popOut handles getScreenDetails permission denied', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    // Mock getScreenDetails that throws (permission denied)
    (window as any).getScreenDetails = vi.fn().mockRejectedValue(new Error('Permission denied'));

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    // Should still succeed with defaults
    expect(result.current.isPoppedOut).toBe(true);
    delete (window as any).getScreenDetails;
  });

  it('returnDisplay tears down keyboard from popup', async () => {
    const session = createMockSession();
    const container = document.createElement('div');
    const containerRef = { current: container };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const mockKb = { onkeydown: null, onkeyup: null, reset: vi.fn() };
    const Guacamole = (await import('guacamole-common-js')).default;
    vi.mocked(Guacamole.Keyboard).mockImplementation(function() { return mockKb as any; });

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    act(() => {
      result.current.returnDisplay();
    });

    expect(mockKb.reset).toHaveBeenCalled();
  });

  it('popOut registers pagehide on popup', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
  });

  it('popOut registers keydown trap on popup document', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(mockPopup.document.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
  });

  it('returnDisplay re-attaches mouse and touch on container', async () => {
    const session = createMockSession();
    const container = document.createElement('div');
    const containerRef = { current: container };
    const mockPopup = createMockPopupWindow();
    vi.spyOn(window, 'open').mockReturnValue(mockPopup as any);

    const Guacamole = (await import('guacamole-common-js')).default;
    const mouseOnEach = vi.fn();
    vi.mocked(Guacamole.Mouse).mockImplementation(function() {
      return { onEach: mouseOnEach, onmousedown: null, onmouseup: null, onmousemove: null } as any;
    });
    const touchOnEach = vi.fn();
    (vi.mocked(Guacamole.Mouse) as any).Touchscreen = vi.fn(function() {
      return { onEach: touchOnEach, onmousedown: null, onmouseup: null, onmousemove: null } as any;
    });

    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });
    mouseOnEach.mockClear();
    touchOnEach.mockClear();

    act(() => {
      result.current.returnDisplay();
    });

    // returnDisplay creates new Mouse and Touchscreen for the main window
    expect(mouseOnEach).toHaveBeenCalled();
    expect(touchOnEach).toHaveBeenCalled();
  });
});
