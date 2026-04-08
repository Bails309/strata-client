import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(() => ({
      getDisplay: () => ({
        getElement: () => document.createElement('div'),
        getWidth: () => 1920,
        getHeight: () => 1080,
        scale: vi.fn(),
        onresize: null,
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendSize: vi.fn(),
      sendMouseState: vi.fn(),
      sendKeyEvent: vi.fn(),
      onstatechange: null,
      onerror: null,
    })),
    WebSocketTunnel: vi.fn(() => ({
      onerror: null,
    })),
    Mouse: Object.assign(vi.fn(() => ({
      onEach: vi.fn(),
    })), {
      Touchscreen: vi.fn(() => ({
        onEach: vi.fn(),
      })),
    }),
    Keyboard: vi.fn(() => ({
      onkeydown: null,
      onkeyup: null,
    })),
  },
}));

import SharedViewer from '../pages/SharedViewer';

describe('SharedViewer', () => {
  let rootEl: HTMLDivElement;

  beforeEach(() => {
    // SharedViewer portals into #root
    rootEl = document.createElement('div');
    rootEl.id = 'root';
    document.body.appendChild(rootEl);
  });

  afterEach(() => {
    document.body.removeChild(rootEl);
  });

  it('renders shared session banner', () => {
    render(
      <MemoryRouter initialEntries={['/shared/test-share-token']}>
        <Routes>
          <Route path="/shared/:shareToken" element={<SharedViewer />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(rootEl.textContent).toContain('Shared Session');
  });

  it('shows connecting state initially', () => {
    render(
      <MemoryRouter initialEntries={['/shared/test-share-token']}>
        <Routes>
          <Route path="/shared/:shareToken" element={<SharedViewer />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(rootEl.textContent).toContain('Connecting');
  });

  it('defaults to read-only mode', () => {
    render(
      <MemoryRouter initialEntries={['/shared/test-share-token']}>
        <Routes>
          <Route path="/shared/:shareToken" element={<SharedViewer />} />
        </Routes>
      </MemoryRouter>,
    );
    // Not in control mode — should not show "Control mode" text
    expect(rootEl.textContent).not.toContain('Control mode');
  });
});
