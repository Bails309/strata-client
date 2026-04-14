import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WhatsNewModal, { WHATS_NEW_VERSION } from '../components/WhatsNewModal';

const STORAGE_KEY = 'strata-whats-new-dismissed';
const WELCOME_KEY = 'strata-welcome-dismissed';

describe('WhatsNewModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows welcome modal for first-time users', () => {
    render(<WhatsNewModal userId="user1" />);
    expect(screen.getByText('Welcome to Strata Client!')).toBeInTheDocument();
  });

  it('shows whats-new modal when welcome was already dismissed', () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    render(<WhatsNewModal userId="user1" />);
    expect(screen.getByText(`What's New in ${WHATS_NEW_VERSION}`)).toBeInTheDocument();
  });

  it('does not show modal when already dismissed for current version', () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    localStorage.setItem(`${STORAGE_KEY}-user1`, WHATS_NEW_VERSION);
    render(<WhatsNewModal userId="user1" />);
    expect(screen.queryByText(`What's New in ${WHATS_NEW_VERSION}`)).not.toBeInTheDocument();
  });

  it('does not show modal when userId is undefined', () => {
    render(<WhatsNewModal userId={undefined} />);
    expect(screen.queryByText(`What's New in ${WHATS_NEW_VERSION}`)).not.toBeInTheDocument();
  });

  it('dismisses welcome on "Let\'s Go!" click and saves to localStorage', async () => {
    render(<WhatsNewModal userId="user1" />);
    expect(screen.getByText('Welcome to Strata Client!')).toBeInTheDocument();
    await userEvent.click(screen.getByText("Let's Go!"));
    expect(screen.queryByText('Welcome to Strata Client!')).not.toBeInTheDocument();
    expect(localStorage.getItem(`${WELCOME_KEY}-user1`)).toBe('true');
    // Also proactively dismisses whats-new
    expect(localStorage.getItem(`${STORAGE_KEY}-user1`)).toBe(WHATS_NEW_VERSION);
  });

  it('dismisses whats-new on "Got it" click and saves to localStorage', async () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    render(<WhatsNewModal userId="user1" />);
    expect(screen.getByText(`What's New in ${WHATS_NEW_VERSION}`)).toBeInTheDocument();
    await userEvent.click(screen.getByText('Got it'));
    expect(screen.queryByText(`What's New in ${WHATS_NEW_VERSION}`)).not.toBeInTheDocument();
    expect(localStorage.getItem(`${STORAGE_KEY}-user1`)).toBe(WHATS_NEW_VERSION);
  });

  it('dismisses on backdrop click', async () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    render(<WhatsNewModal userId="user1" />);
    const backdrop = screen.getByText(`What's New in ${WHATS_NEW_VERSION}`).closest('.fixed');
    expect(backdrop).toBeTruthy();
    await userEvent.click(backdrop!);
    expect(screen.queryByText(`What's New in ${WHATS_NEW_VERSION}`)).not.toBeInTheDocument();
  });

  it('does not dismiss when clicking inside the modal content', async () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    render(<WhatsNewModal userId="user1" />);
    // Click inside the modal content (e.g., a section heading)
    await userEvent.click(screen.getByText('Enhanced Session Security'));
    expect(screen.getByText(`What's New in ${WHATS_NEW_VERSION}`)).toBeInTheDocument();
  });

  it('shows modal again when version changes from dismissed version', () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    localStorage.setItem(`${STORAGE_KEY}-user1`, '0.0.0-old');
    render(<WhatsNewModal userId="user1" />);
    expect(screen.getByText(`What's New in ${WHATS_NEW_VERSION}`)).toBeInTheDocument();
  });

  it('scopes dismissal per user', () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    localStorage.setItem(`${STORAGE_KEY}-other-user`, WHATS_NEW_VERSION);
    render(<WhatsNewModal userId="user1" />);
    expect(screen.getByText(`What's New in ${WHATS_NEW_VERSION}`)).toBeInTheDocument();
  });

  it('updates visibility when userId changes during lifecycle', () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    localStorage.setItem(`${STORAGE_KEY}-user1`, WHATS_NEW_VERSION);
    
    const { rerender } = render(<WhatsNewModal userId="user1" />);
    expect(screen.queryByText(`What's New in ${WHATS_NEW_VERSION}`)).not.toBeInTheDocument();

    rerender(<WhatsNewModal userId="user2" />);
    // User2 hasn't dismissed either modal yet, so welcome should show
    expect(screen.getByText('Welcome to Strata Client!')).toBeInTheDocument();
  });

  it('handles backdrop click safety when userId is missing', async () => {
    localStorage.setItem(`${WELCOME_KEY}-user1`, 'true');
    // We force the modal to be visible then remove userId
    const { rerender } = render(<WhatsNewModal userId="user1" />);
    expect(screen.getByText(`What's New in ${WHATS_NEW_VERSION}`)).toBeInTheDocument();

    rerender(<WhatsNewModal userId={undefined} />);
    // Modal should disappear because of the userId check and useEffect cleanup
    await waitFor(() => {
      expect(screen.queryByText(`What's New in ${WHATS_NEW_VERSION}`)).not.toBeInTheDocument();
    });
  });
});
