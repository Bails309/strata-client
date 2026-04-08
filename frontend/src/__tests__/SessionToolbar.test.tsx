import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(),
    Mouse: Object.assign(vi.fn(), { Touchscreen: vi.fn() }),
  },
}));

vi.mock('../api', () => ({
  createShareLink: vi.fn(),
}));

vi.mock('../components/FileBrowser', () => ({
  default: () => <div data-testid="file-browser">FileBrowser</div>,
}));

vi.mock('../components/Select', () => ({
  default: (props: any) => <select data-testid="select">{props.children}</select>,
}));

import SessionToolbar from '../components/SessionToolbar';

function createMockSession(overrides = {}) {
  return {
    id: 'sess-1',
    name: 'Test Server',
    client: {
      getDisplay: vi.fn(() => ({
        getElement: () => document.createElement('div'),
      })),
    },
    filesystems: [],
    ...overrides,
  };
}

describe('SessionToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders share button', () => {
    const session = createMockSession();
    render(
      <SessionToolbar
        session={session as any}
        connectionId="conn-1"
      />,
    );
    expect(screen.getByTitle('Share this connection')).toBeInTheDocument();
  });

  it('renders fullscreen button', () => {
    const session = createMockSession();
    render(
      <SessionToolbar
        session={session as any}
        connectionId="conn-1"
      />,
    );
    expect(screen.getByTitle(/Fullscreen/)).toBeInTheDocument();
  });

  it('does not render file browser button when no filesystems', () => {
    const session = createMockSession({ filesystems: [] });
    render(
      <SessionToolbar
        session={session as any}
        connectionId="conn-1"
      />,
    );
    expect(screen.queryByTitle('Browse files')).toBeNull();
  });

  it('renders file browser button when filesystems exist', () => {
    const session = createMockSession({
      filesystems: [{ name: 'Drive', object: {} }],
    });
    render(
      <SessionToolbar
        session={session as any}
        connectionId="conn-1"
      />,
    );
    expect(screen.getByTitle('Browse files')).toBeInTheDocument();
  });

  it('renders pop-out button when onPopOut is provided', () => {
    const session = createMockSession();
    render(
      <SessionToolbar
        session={session as any}
        connectionId="conn-1"
        onPopOut={vi.fn()}
      />,
    );
    expect(screen.getByTitle('Pop out to separate window')).toBeInTheDocument();
  });
});
