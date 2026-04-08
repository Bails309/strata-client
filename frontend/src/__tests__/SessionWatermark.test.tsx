import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({
  getMe: vi.fn(),
}));

import SessionWatermark from '../components/SessionWatermark';
import { getMe } from '../api';

describe('SessionWatermark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when user is not loaded yet', () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { container } = render(<SessionWatermark />);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('renders nothing when watermark is disabled', async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: 'testuser',
      client_ip: '10.0.0.1',
      watermark_enabled: false,
    });
    const { container } = render(<SessionWatermark />);
    // Even after loading, canvas should not appear
    await waitFor(() => {
      expect(container.querySelector('canvas')).toBeNull();
    });
  });

  it('renders canvas when watermark is enabled', async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: 'testuser',
      client_ip: '10.0.0.1',
      watermark_enabled: true,
    });
    const { container } = render(<SessionWatermark />);
    await waitFor(() => {
      expect(container.querySelector('canvas')).toBeTruthy();
    });
  });

  it('canvas has pointer-events none', async () => {
    (getMe as ReturnType<typeof vi.fn>).mockResolvedValue({
      username: 'testuser',
      client_ip: '10.0.0.1',
      watermark_enabled: true,
    });
    const { container } = render(<SessionWatermark />);
    await waitFor(() => {
      const canvas = container.querySelector('canvas');
      expect(canvas?.style.pointerEvents).toBe('none');
    });
  });
});
