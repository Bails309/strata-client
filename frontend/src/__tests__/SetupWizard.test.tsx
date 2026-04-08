import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

// Mock the api module
vi.mock('../api', () => ({
  initialize: vi.fn().mockResolvedValue({ status: 'ok' }),
}));

import SetupWizard from '../pages/SetupWizard';

function renderSetup(onComplete = vi.fn()) {
  return render(
    <BrowserRouter>
      <SetupWizard onComplete={onComplete} />
    </BrowserRouter>,
  );
}

describe('SetupWizard', () => {
  it('renders setup heading', () => {
    renderSetup();
    expect(screen.getByText('Strata Client Setup')).toBeInTheDocument();
  });

  it('has vault mode options', () => {
    renderSetup();
    // The setup wizard should have vault configuration options
    expect(screen.getByText(/local/i)).toBeInTheDocument();
  });

  it('calls onComplete after successful initialization', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderSetup(onComplete);

    // Find and click the submit/initialize button
    const btn = screen.getByRole('button', { name: /initialize|setup|continue|save/i });
    await user.click(btn);

    // Wait for the async action
    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it('shows error on initialization failure', async () => {
    const { initialize } = await import('../api');
    (initialize as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Connection refused'));

    const user = userEvent.setup();
    renderSetup();

    const btn = screen.getByRole('button', { name: /initialize|setup|continue|save/i });
    await user.click(btn);

    expect(await screen.findByText('Connection refused')).toBeInTheDocument();
  });
});
