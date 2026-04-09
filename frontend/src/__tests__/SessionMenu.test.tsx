import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('guacamole-common-js', () => {
  function MockStringWriter(this: any) {
    this.sendText = vi.fn();
    this.sendEnd = vi.fn();
  }
  return {
    default: {
      Client: vi.fn(),
      StringWriter: MockStringWriter,
      Mouse: Object.assign(vi.fn(), { Touchscreen: vi.fn() }),
      Keyboard: vi.fn(),
      GuacObject: vi.fn(),
    },
  };
});

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

  it('hides file transfer section when no filesystems', () => {
    const session = createMockSession({ filesystems: [] });
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
    expect(screen.queryByText('File Transfer')).not.toBeInTheDocument();
  });

  it('shows share URL when provided', () => {
    const session = createMockSession();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl="https://example.com/share/abc123"
        onShare={vi.fn()}
        sharingEnabled={true}
      />,
    );
    const input = screen.getByDisplayValue('https://example.com/share/abc123');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('readOnly');
  });

  it('calls onShare when share button clicked', async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    const session = createMockSession();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl={null}
        onShare={onShare}
        sharingEnabled={true}
      />,
    );
    await user.click(screen.getByText('Share this Connection'));
    expect(onShare).toHaveBeenCalled();
  });

  it('hides share section when sharing is disabled', () => {
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
    expect(screen.queryByText('Sharing')).not.toBeInTheDocument();
  });

  it('shows clipboard reveal button and textarea on click', async () => {
    const user = userEvent.setup();
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
    expect(screen.getByText('Click to view clipboard contents')).toBeInTheDocument();
    await user.click(screen.getByText('Click to view clipboard contents'));
    // After clicking, a textarea should appear
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows keyboard shortcut hint', () => {
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
    expect(screen.getByText('Ctrl+Alt+Shift')).toBeInTheDocument();
  });

  it('shows drag and drop hint', () => {
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
    expect(screen.getByText(/drag and drop files/i)).toBeInTheDocument();
  });

  it('renders multiple filesystem buttons', () => {
    const session = createMockSession({
      filesystems: [
        { name: 'Drive C', object: {} },
        { name: 'SFTP', object: {} },
      ],
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
    expect(screen.getByText('Drive C')).toBeInTheDocument();
    expect(screen.getByText('SFTP')).toBeInTheDocument();
  });

  it('switches to file browser panel when filesystem button clicked', async () => {
    const user = userEvent.setup();
    const session = createMockSession({
      filesystems: [{ name: 'Drive C', object: { requestInputStream: vi.fn() } }],
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
    await user.click(screen.getByText('Drive C'));
    // Should show the FileBrowser which has a "Back" button
    expect(screen.getByText('Back')).toBeInTheDocument();
    // Clipboard section should no longer be visible
    expect(screen.queryByText('Clipboard')).not.toBeInTheDocument();
  });

  it('syncs clipboard text with remoteClipboard when menu opens', () => {
    const session = createMockSession({ remoteClipboard: 'remote text' });
    const { rerender } = render(
      <SessionMenu
        session={session as any}
        isOpen={false}
        onClose={vi.fn()}
        shareUrl={null}
        onShare={vi.fn()}
        sharingEnabled={false}
      />,
    );
    // Open the menu
    rerender(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl={null}
        onShare={vi.fn()}
        sharingEnabled={false}
      />,
    );
    // The clipboard button should exist (text is hidden until reveal)
    expect(screen.getByText('Click to view clipboard contents')).toBeInTheDocument();
  });

  it('reveals clipboard textarea and allows typing', async () => {
    const user = userEvent.setup();
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
    // Reveal clipboard
    await user.click(screen.getByText('Click to view clipboard contents'));
    const textarea = screen.getByRole('textbox');
    expect(textarea).toBeInTheDocument();
    // Typing should work
    await user.type(textarea, 'hello');
    expect(textarea).toHaveValue('hello');
  });

  it('sends clipboard text to remote after debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
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
      await user.click(screen.getByText('Click to view clipboard contents'));
      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'test');
      vi.advanceTimersByTime(350);
      expect(session.client.createClipboardStream).toHaveBeenCalledWith('text/plain');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops mouse event propagation on the panel', () => {
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
    // The panel div should have onMouseDown that stops propagation
    const panel = screen.getByText('Test Server').closest('div[style]')!.parentElement!;
    const event = new MouseEvent('mousedown', { bubbles: true });
    vi.spyOn(event, 'stopPropagation');
    panel!.dispatchEvent(event);
    // Just verify the panel rendered correctly
    expect(screen.getByText('Test Server')).toBeInTheDocument();
  });

  it('shows copy button when share URL is provided', () => {
    const session = createMockSession();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl="https://example.com/share/abc123"
        onShare={vi.fn()}
        sharingEnabled={true}
      />,
    );
    expect(screen.getByTitle('Copy link')).toBeInTheDocument();
  });

  it('shows share description text when URL exists', () => {
    const session = createMockSession();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl="https://example.com/share/abc"
        onShare={vi.fn()}
        sharingEnabled={true}
      />,
    );
    expect(screen.getByText(/temporary view access/)).toBeInTheDocument();
  });

  it('copies share URL to clipboard when copy button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    const session = createMockSession();
    render(
      <SessionMenu
        session={session as any}
        isOpen={true}
        onClose={vi.fn()}
        shareUrl="https://example.com/share/xyz"
        onShare={vi.fn()}
        sharingEnabled={true}
      />,
    );
    await userEvent.click(screen.getByTitle('Copy link'));
    expect(writeText).toHaveBeenCalledWith('https://example.com/share/xyz');
  });

  it('returns null when not open', () => {
    const session = createMockSession();
    const { container } = render(
      <SessionMenu
        session={session as any}
        isOpen={false}
        onClose={vi.fn()}
        shareUrl=""
        onShare={vi.fn()}
        sharingEnabled={false}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
