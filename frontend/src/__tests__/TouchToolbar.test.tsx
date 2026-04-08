import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('guacamole-common-js', () => ({
  default: {
    Client: vi.fn(),
  },
}));

import TouchToolbar from '../components/TouchToolbar';

function createMockClient() {
  return {
    sendKeyEvent: vi.fn(),
    getDisplay: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('TouchToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders collapsed toggle button', () => {
    const client = createMockClient();
    render(<TouchToolbar client={client as any} />);
    expect(screen.getByTitle('Show keyboard shortcuts')).toBeInTheDocument();
  });

  it('expands when toggle is clicked and shows key combos', async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    render(<TouchToolbar client={client as any} />);

    await user.click(screen.getByTitle('Show keyboard shortcuts'));

    // Should show combo buttons
    expect(screen.getByTitle('Ctrl+Alt+Delete')).toBeInTheDocument();
    expect(screen.getByTitle('Windows key')).toBeInTheDocument();
    expect(screen.getByTitle('Switch windows')).toBeInTheDocument();
    expect(screen.getByTitle('Escape')).toBeInTheDocument();
  });

  it('sends key events when combo is clicked', async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    render(<TouchToolbar client={client as any} />);

    // Expand first
    await user.click(screen.getByTitle('Show keyboard shortcuts'));

    // Click Escape combo
    await user.click(screen.getByTitle('Escape'));

    // Escape keysym 0xFF1B pressed then released
    expect(client.sendKeyEvent).toHaveBeenCalledWith(1, 0xFF1B);
    expect(client.sendKeyEvent).toHaveBeenCalledWith(0, 0xFF1B);
  });

  it('sends Ctrl+Alt+Delete combo correctly', async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    render(<TouchToolbar client={client as any} />);

    await user.click(screen.getByTitle('Show keyboard shortcuts'));
    await user.click(screen.getByTitle('Ctrl+Alt+Delete'));

    // Should press 3 keys and release 3 keys (6 total calls)
    expect(client.sendKeyEvent).toHaveBeenCalledTimes(6);
  });
});
