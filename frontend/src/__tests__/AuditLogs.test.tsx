import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getAuditLogs } from '../api';

// Mock the api module
vi.mock('../api', () => ({
  getAuditLogs: vi.fn().mockResolvedValue([
    {
      id: 1,
      created_at: '2026-01-15T10:30:00Z',
      action_type: 'auth.login',
      user_id: 'abc-123',
      username: 'admin',
      details: { ip: '192.168.1.1' },
      current_hash: 'abcdef1234567890abcdef1234567890',
      previous_hash: '',
    },
    {
      id: 2,
      created_at: '2026-01-15T11:00:00Z',
      action_type: 'settings.update',
      user_id: 'abc-123',
      username: 'admin',
      details: { key: 'sso_enabled' },
      current_hash: 'fedcba0987654321fedcba0987654321',
      previous_hash: 'abcdef1234567890abcdef1234567890',
    },
  ]),
}));

import AuditLogs from '../pages/AuditLogs';

describe('AuditLogs', () => {
  it('renders heading', () => {
    render(<AuditLogs />);
    expect(screen.getByText('Audit Logs')).toBeInTheDocument();
  });

  it('renders column headers', () => {
    render(<AuditLogs />);
    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.getByText('Timestamp')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('Hash')).toBeInTheDocument();
  });

  it('displays audit log entries after fetch', async () => {
    render(<AuditLogs />);
    // Wait for the async data to appear
    expect(await screen.findByText('auth.login')).toBeInTheDocument();
    expect(await screen.findByText('settings.update')).toBeInTheDocument();
    const adminCells = await screen.findAllByText('admin');
    expect(adminCells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders pagination controls', () => {
    render(<AuditLogs />);
    expect(screen.getByText('Previous')).toBeInTheDocument();
    expect(screen.getByText('Next')).toBeInTheDocument();
    expect(screen.getByText('Page 1')).toBeInTheDocument();
  });

  it('Previous button is disabled on page 1', () => {
    render(<AuditLogs />);
    const prev = screen.getByText('Previous');
    expect(prev).toBeDisabled();
  });

  it('navigates to next page', async () => {
    // Return 50 items so the Next button is enabled (disabled when < 50)
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      created_at: '2026-01-15T10:30:00Z',
      action_type: 'auth.login',
      user_id: 'abc-123',
      username: 'admin',
      details: { ip: '192.168.1.1' },
      current_hash: 'abcdef1234567890abcdef1234567890',
      previous_hash: '',
    }));
    vi.mocked(getAuditLogs).mockResolvedValue(fullPage);

    const user = userEvent.setup();
    render(<AuditLogs />);

    // Wait for data to load so Next becomes enabled
    await screen.findAllByText('auth.login');
    await user.click(screen.getByText('Next'));
    expect(screen.getByText('Page 2')).toBeInTheDocument();
  });
});
