import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock guacamole-common-js
vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(),
    Mouse: Object.assign(vi.fn(() => ({
      onEach: vi.fn(),
      onmousedown: null,
      onmouseup: null,
      onmousemove: null,
    })), {
      Touchscreen: vi.fn(() => ({
        onEach: vi.fn(),
        onmousedown: null,
        onmouseup: null,
        onmousemove: null,
      })),
      Event: vi.fn(),
    }),
    Keyboard: vi.fn(() => ({
      onkeydown: null,
      onkeyup: null,
      reset: vi.fn(),
    })),
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

describe('usePopOut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // Should not throw
    act(() => {
      result.current.returnDisplay();
    });
    expect(result.current.isPoppedOut).toBe(false);
  });

  it('popOut does nothing when window.open is blocked', async () => {
    const session = createMockSession();
    const containerRef = { current: document.createElement('div') };
    // window.open returns null (popup blocked)
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => usePopOut(session as any, containerRef as any));

    await act(async () => {
      await result.current.popOut();
    });

    expect(result.current.isPoppedOut).toBe(false);
    vi.restoreAllMocks();
  });
});
