import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('guacamole-common-js', () => ({
  default: {
    BlobReader: vi.fn(function() {
      return {
        onend: null,
        getBlob: vi.fn(() => new Blob()),
      };
    }),
    BlobWriter: vi.fn(function() {
      return {
        onprogress: null,
        oncomplete: null,
        onerror: null,
        sendBlob: vi.fn(),
      };
    }),
    StringReader: vi.fn(function() {
      return {
        ontext: null,
        onend: null,
      };
    }),
    GuacObject: vi.fn(),
  },
}));

import FileBrowser from '../components/FileBrowser';

function createMockFilesystem(streamCallback?: (stream: any, mimetype: string) => void) {
  return {
    name: 'Shared Drive',
    object: {
      requestInputStream: vi.fn((_path: string, cb: (stream: any, mimetype: string) => void) => {
        if (streamCallback) {
          streamCallback({ onack: null }, 'application/vnd.glyptodon.guacamole.stream-index+json');
        }
        cb({ onack: null }, 'application/vnd.glyptodon.guacamole.stream-index+json');
      }),
      createOutputStream: vi.fn(() => ({})),
    },
  };
}

describe('FileBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders filesystem name', () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(screen.getByText('Shared Drive')).toBeInTheDocument();
  });

  it('renders back button', () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(screen.getByText('Back')).toBeInTheDocument();
  });

  it('calls onClose when back is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={onClose} />);

    await user.click(screen.getByText('Back'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders upload button', () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(screen.getByText('Upload Files')).toBeInTheDocument();
  });

  it('requests root directory on mount', () => {
    const fs = createMockFilesystem();
    render(<FileBrowser filesystem={fs as any} onClose={vi.fn()} />);
    expect(fs.object.requestInputStream).toHaveBeenCalledWith('/', expect.any(Function));
  });
});
