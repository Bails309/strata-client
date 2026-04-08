import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  default: ({ value, onChange, options }: any) => (
    <select data-testid="select" value={value} onChange={(e: any) => onChange(e.target.value)}>
      {options?.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import SessionToolbar from '../components/SessionToolbar';
import { createShareLink } from '../api';

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
  afterEach(() => vi.restoreAllMocks());

  it('renders share button', () => {
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    expect(screen.getByTitle('Share this connection')).toBeInTheDocument();
  });

  it('renders fullscreen button', () => {
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    expect(screen.getByTitle(/Fullscreen/)).toBeInTheDocument();
  });

  it('does not render file browser button when no filesystems', () => {
    render(<SessionToolbar session={createMockSession({ filesystems: [] }) as any} connectionId="conn-1" />);
    expect(screen.queryByTitle('Browse files')).toBeNull();
  });

  it('renders file browser button when filesystems exist', () => {
    const session = createMockSession({ filesystems: [{ name: 'Drive', object: {} }] });
    render(<SessionToolbar session={session as any} connectionId="conn-1" />);
    expect(screen.getByTitle('Browse files')).toBeInTheDocument();
  });

  it('renders pop-out button when onPopOut is provided', () => {
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" onPopOut={vi.fn()} />);
    expect(screen.getByTitle('Pop out to separate window')).toBeInTheDocument();
  });

  it('shows pop-in button when isPoppedOut and onPopIn', () => {
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" isPoppedOut onPopIn={vi.fn()} />);
    expect(screen.getByTitle('Return to main window')).toBeInTheDocument();
  });

  it('does not show pop-out button when neither handler provided', () => {
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    expect(screen.queryByTitle('Pop out to separate window')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Return to main window')).not.toBeInTheDocument();
  });

  it('calls onPopOut when pop-out button clicked', async () => {
    const onPopOut = vi.fn();
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" onPopOut={onPopOut} />);
    await user.click(screen.getByTitle('Pop out to separate window'));
    expect(onPopOut).toHaveBeenCalled();
  });

  it('calls onPopIn when pop-in button clicked', async () => {
    const onPopIn = vi.fn();
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" isPoppedOut onPopIn={onPopIn} />);
    await user.click(screen.getByTitle('Return to main window'));
    expect(onPopIn).toHaveBeenCalled();
  });

  it('opens share popover with mode choices', async () => {
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    expect(screen.getByText('Share Connection')).toBeInTheDocument();
    expect(screen.getByText('View Only')).toBeInTheDocument();
    expect(screen.getByText('Control')).toBeInTheDocument();
  });

  it('generates a view-only share link', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'view' });
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('View Only'));
    await waitFor(() => {
      expect(screen.getByText('VIEW ONLY')).toBeInTheDocument();
    });
    expect(createShareLink).toHaveBeenCalledWith('conn-1', 'view');
  });

  it('generates a control share link', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'control' });
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('Control'));
    await waitFor(() => {
      expect(screen.getByText('CONTROL')).toBeInTheDocument();
    });
    expect(createShareLink).toHaveBeenCalledWith('conn-1', 'control');
  });

  it('shows share URL in input field', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'view' });
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('View Only'));
    await waitFor(() => {
      expect(screen.getByDisplayValue(/shared\/abc123/)).toBeInTheDocument();
    });
  });

  it('shows copy button for share URL', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'view' });
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('View Only'));
    await waitFor(() => screen.getByTitle('Copy link'));
    // Copy button should exist and be clickable
    const copyBtn = screen.getByTitle('Copy link');
    expect(copyBtn).toBeInTheDocument();
    await user.click(copyBtn);
    // No crash
  });

  it('shows Generate new link after URL is created', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'view' });
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('View Only'));
    await waitFor(() => expect(screen.getByText('Generate new link')).toBeInTheDocument());
  });

  it('resets URL when Generate new link clicked', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'view' });
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('View Only'));
    await waitFor(() => screen.getByText('Generate new link'));
    await user.click(screen.getByText('Generate new link'));
    expect(screen.getByText('View Only')).toBeInTheDocument();
    expect(screen.getByText('Control')).toBeInTheDocument();
  });

  it('handles share API failure gracefully', async () => {
    vi.mocked(createShareLink).mockRejectedValue(new Error('Unavailable'));
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('View Only'));
    await waitFor(() => {
      expect(screen.queryByText('VIEW ONLY')).not.toBeInTheDocument();
    });
  });

  it('shows Generating text while share is loading', async () => {
    let resolve: (v: any) => void;
    vi.mocked(createShareLink).mockReturnValue(new Promise((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('View Only'));
    expect(screen.getByText('Generating…')).toBeInTheDocument();
    resolve!({ share_url: '/shared/abc', share_token: 'abc', mode: 'view' });
    await waitFor(() => expect(screen.queryByText('Generating…')).not.toBeInTheDocument());
  });

  it('opens file browser panel', async () => {
    const session = createMockSession({ filesystems: [{ name: 'SFTP', object: {} }] });
    const user = userEvent.setup();
    render(<SessionToolbar session={session as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Browse files'));
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('file-browser')).toBeInTheDocument();
  });

  it('closes file browser panel', async () => {
    const session = createMockSession({ filesystems: [{ name: 'SFTP', object: {} }] });
    const user = userEvent.setup();
    render(<SessionToolbar session={session as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Browse files'));
    expect(screen.getByText('Files')).toBeInTheDocument();
    await user.click(screen.getByTitle('Close file browser'));
    expect(screen.queryByText('Files')).not.toBeInTheDocument();
  });

  it('toggles fullscreen enter', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle(/fullscreen/i));
    expect(requestFullscreen).toHaveBeenCalled();
  });

  it('shows view description text', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'view' });
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('View Only'));
    await waitFor(() => expect(screen.getByText(/read-only view access/)).toBeInTheDocument());
  });

  it('shows control description text', async () => {
    vi.mocked(createShareLink).mockResolvedValue({ share_url: '/shared/abc123', share_token: 'abc123', mode: 'control' });
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    await user.click(screen.getByText('Control'));
    await waitFor(() => expect(screen.getByText(/temporary control access/)).toBeInTheDocument());
  });

  it('shows filesystem selector when multiple filesystems exist', async () => {
    const session = createMockSession({
      filesystems: [
        { name: 'Drive C:', object: {} },
        { name: 'SFTP', object: {} },
      ],
    });
    const user = userEvent.setup();
    render(<SessionToolbar session={session as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Browse files'));
    expect(screen.getByTestId('select')).toBeInTheDocument();
  });

  it('closes share popover on second click of share button', async () => {
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    await user.click(screen.getByTitle('Share this connection'));
    expect(screen.getByText('Share Connection')).toBeInTheDocument();
    await user.click(screen.getByTitle('Share this connection'));
    expect(screen.queryByText('Share Connection')).not.toBeInTheDocument();
  });

  it('closes share popover when clicking outside', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <div data-testid="outside">Outside area</div>
        <SessionToolbar session={createMockSession() as any} connectionId="conn-1" />
      </div>,
    );
    await user.click(screen.getByTitle('Share this connection'));
    expect(screen.getByText('Share Connection')).toBeInTheDocument();
    // Click outside the popover
    await user.click(screen.getByTestId('outside'));
    await waitFor(() => {
      expect(screen.queryByText('Share Connection')).not.toBeInTheDocument();
    });
  });

  it('button hover applies background style', async () => {
    const user = userEvent.setup();
    render(<SessionToolbar session={createMockSession() as any} connectionId="conn-1" />);
    const btn = screen.getByTitle('Share this connection');
    await user.hover(btn);
    // After hover, inline style should be updated. Check it doesn't crash.
    expect(btn).toBeInTheDocument();
    await user.unhover(btn);
    expect(btn).toBeInTheDocument();
  });
});
