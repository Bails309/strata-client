import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(),
    StringWriter: vi.fn(() => ({
      sendText: vi.fn(),
      sendEnd: vi.fn(),
    })),
    Mouse: Object.assign(vi.fn(), { Touchscreen: vi.fn() }),
    Keyboard: vi.fn(),
    GuacObject: vi.fn(),
  },
}));

import SessionMenu from '../components/SessionMenu';

function createMockSession(overrides = {}) {
  return {
    id: 'sess-1',
    name: 'Test Server',
    client: {
      createClipboardStream: vi.fn(() => ({})),
      sendMouseState: vi.fn(),
      getDisplay: vi.fn(() => ({
        getElement: () => document.createElement('div'),
      })),
    },
    filesystems: [],
    remoteClipboard: '',
    ...overrides,
  };
}

describe('SessionMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when closed', () => {
    const session = createMockSession();
    const { container } = render(
      <SessionMenu
        session={session as any}
        isOpen={false}
        onClose={vi.fn()}
        shareUrl={null}
        onShare={vi.fn()}
        sharingEnabled={false}
      />,
    );
    expect(container.firstElementChild).toBeNull();
  });

  it('renders session name when open', () => {
    const session = createMockSession();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl={null}
        onShare={vi.fn()}
        sharingEnabled={false}
      />,
    );
    expect(screen.getByText('Test Server')).toBeInTheDocument();
  });

  it('shows clipboard section', () => {
    const session = createMockSession();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl={null}
        onShare={vi.fn()}
        sharingEnabled={false}
      />,
    );
    expect(screen.getByText('Clipboard')).toBeInTheDocument();
  });

  it('shows share button when sharing is enabled', () => {
    const session = createMockSession();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl={null}
        onShare={vi.fn()}
        sharingEnabled={true}
      />,
    );
    expect(screen.getByText('Share this Connection')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup();
    const session = createMockSession();
    const onClose = vi.fn();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={onClose}
        shareUrl={null}
        onShare={vi.fn()}
        sharingEnabled={false}
      />,
    );

    await user.click(screen.getByTitle('Close menu (Ctrl+Alt+Shift)'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows file transfer section when filesystems exist', () => {
    const session = createMockSession({
      filesystems: [{ name: 'Shared Drive', object: {} }],
    });
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl={null}
        onShare={vi.fn()}
        sharingEnabled={false}
      />,
    );
    expect(screen.getByText('File Transfer')).toBeInTheDocument();
    expect(screen.getByText('Shared Drive')).toBeInTheDocument();
  });
});
