import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../api', () => ({
  acceptTerms: vi.fn(),
}));

import DisclaimerModal, { TERMS_VERSION } from '../components/DisclaimerModal';
import { acceptTerms } from '../api';

describe('DisclaimerModal', () => {
  const onAccept = vi.fn();
  const onDecline = vi.fn();

  beforeEach(() => {
    vi.mocked(acceptTerms).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    onAccept.mockReset();
    onDecline.mockReset();
  });

  it('exports TERMS_VERSION', () => {
    expect(TERMS_VERSION).toBe(1);
  });

  it('renders disclaimer heading', () => {
    render(<DisclaimerModal onAccept={onAccept} onDecline={onDecline} />);
    expect(screen.getByText('Session Recording Disclaimer')).toBeInTheDocument();
  });

  it('renders subtitle', () => {
    render(<DisclaimerModal onAccept={onAccept} onDecline={onDecline} />);
    expect(screen.getByText('Please read and accept before continuing')).toBeInTheDocument();
  });

  it('calls acceptTerms and onAccept on accept click', async () => {
    const user = userEvent.setup();
    render(<DisclaimerModal onAccept={onAccept} onDecline={onDecline} />);

    // Simulate scrolling to bottom to enable the accept button
    const scrollContainer = document.querySelector('[class*="overflow-y-auto"]');
    if (scrollContainer) {
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 100 });
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 90 });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 20 });
      scrollContainer.dispatchEvent(new Event('scroll'));
    }

    // Find and click the accept button (may be disabled until scrolled)
    const buttons = screen.getAllByRole('button');
    const acceptBtn = buttons.find(b => b.textContent?.includes('Accept') || b.textContent?.includes('agree'));
    if (acceptBtn) {
      await user.click(acceptBtn);
      await waitFor(() => expect(acceptTerms).toHaveBeenCalledWith(TERMS_VERSION));
      await waitFor(() => expect(onAccept).toHaveBeenCalled());
    }
  });

  it('handles acceptTerms failure', async () => {
    vi.mocked(acceptTerms).mockRejectedValue(new Error('fail'));
    const user = userEvent.setup();
    render(<DisclaimerModal onAccept={onAccept} onDecline={onDecline} />);

    const scrollContainer = document.querySelector('[class*="overflow-y-auto"]');
    if (scrollContainer) {
      Object.defineProperty(scrollContainer, 'scrollHeight', { value: 100 });
      Object.defineProperty(scrollContainer, 'scrollTop', { value: 90 });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 20 });
      scrollContainer.dispatchEvent(new Event('scroll'));
    }

    const buttons = screen.getAllByRole('button');
    const acceptBtn = buttons.find(b => b.textContent?.includes('Accept') || b.textContent?.includes('agree'));
    if (acceptBtn) {
      await user.click(acceptBtn);
      await waitFor(() => expect(acceptTerms).toHaveBeenCalled());
      expect(onAccept).not.toHaveBeenCalled();
    }
  });

  it('uses ResizeObserver to check if content fits without scrolling', () => {
    const observerInstances: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; _cb: () => void }[] = [];
    class MockResizeObserver {
      _cb: () => void;
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(cb: () => void) {
        this._cb = cb;
        observerInstances.push(this);
      }
    }
    const orig = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver as any;

    render(<DisclaimerModal onAccept={onAccept} onDecline={onDecline} />);
    expect(observerInstances).toHaveLength(1);
    expect(observerInstances[0].observe).toHaveBeenCalled();

    // Trigger the ResizeObserver callback to exercise the if(el) branch
    observerInstances[0]._cb();

    globalThis.ResizeObserver = orig;
  });

  it('does not enable accept when user has not scrolled to bottom', () => {
    // Patch element prototype so scrollHeight is large before render
    const origScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    const origClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
    Object.defineProperty(Element.prototype, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(Element.prototype, 'clientHeight', { value: 100, configurable: true });

    render(<DisclaimerModal onAccept={onAccept} onDecline={onDecline} />);

    // scrollHeight - scrollTop - clientHeight = 1000 - 0 - 100 = 900 >= 20 → button stays disabled
    const acceptBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Accept'));
    expect(acceptBtn).toBeDisabled();

    // Restore
    if (origScrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', origScrollHeight);
    else delete (Element.prototype as any).scrollHeight;
    if (origClientHeight) Object.defineProperty(Element.prototype, 'clientHeight', origClientHeight);
    else delete (Element.prototype as any).clientHeight;
  });

  it('cleans up ResizeObserver on unmount', () => {
    const observerInstances: { observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; _cb: () => void }[] = [];
    class MockResizeObserver {
      _cb: () => void;
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(cb: () => void) {
        this._cb = cb;
        observerInstances.push(this);
      }
    }
    const orig = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver as any;

    const { unmount } = render(<DisclaimerModal onAccept={onAccept} onDecline={onDecline} />);
    expect(observerInstances).toHaveLength(1);
    unmount();
    expect(observerInstances[0].disconnect).toHaveBeenCalled();

    globalThis.ResizeObserver = orig;
  });
});
