import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import React, { useRef } from 'react';
import { UserProfileCard } from '../components/layout/sidebar/UserProfileCard';
import { UserAccountPopover } from '../components/layout/sidebar/UserAccountPopover';
import { GatewayTelemetryChip } from '../components/layout/sidebar/GatewayTelemetryChip';
import { SidebarUtilityDock } from '../components/layout/sidebar/SidebarUtilityDock';
import { SidebarFooter } from '../components/layout/sidebar/SidebarFooter';

describe('UserProfileCard', () => {
  it('renders geometric avatar with initial and status dot', () => {
    render(
      <UserProfileCard
        displayName="Alice Smith"
        roleName="administrator"
        isOnline={true}
        isCollapsed={false}
        isOpen={false}
        onClick={vi.fn()}
      />
    );

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText('administrator')).toBeInTheDocument();
  });

  it('hides display name and role when collapsed', () => {
    render(
      <UserProfileCard
        displayName="Alice Smith"
        roleName="administrator"
        isOnline={true}
        isCollapsed={true}
        isOpen={false}
        onClick={vi.fn()}
      />
    );

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument();
    expect(screen.queryByText('administrator')).not.toBeInTheDocument();
  });

  it('triggers onClick when clicked', async () => {
    const handleClick = vi.fn();
    render(
      <UserProfileCard
        displayName="Bob"
        roleName="operator"
        isOnline={false}
        isCollapsed={false}
        isOpen={false}
        onClick={handleClick}
      />
    );

    await userEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});

describe('UserAccountPopover', () => {
  function PopoverWrapper(props: Partial<React.ComponentProps<typeof UserAccountPopover>>) {
    const triggerRef = useRef<HTMLDivElement>(null);
    return (
      <MemoryRouter>
        <div>
          <div ref={triggerRef} data-testid="trigger">
            Trigger
          </div>
          <div data-testid="outside">Outside</div>
          <UserAccountPopover
            isOpen={true}
            onClose={vi.fn()}
            onSignOut={vi.fn()}
            userEmail="alice@strataclient.io"
            roleName="Security Admin"
            activeCheckoutsCount={3}
            triggerRef={triggerRef}
            {...props}
          />
        </div>
      </MemoryRouter>
    );
  }

  it('renders user email, role, and active leases count', () => {
    render(<PopoverWrapper />);

    expect(screen.getByText('alice@strataclient.io')).toBeInTheDocument();
    expect(screen.getByText('Security Admin')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/Profile & Settings/i)).toBeInTheDocument();
    expect(screen.getByText(/Active Leases/i)).toBeInTheDocument();
    expect(screen.queryByText(/Preferences/i)).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Sign Out/i })).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(<PopoverWrapper isOpen={false} />);
    expect(screen.queryByText('alice@strataclient.io')).not.toBeInTheDocument();
  });

  it('calls onSignOut when Sign Out menuitem is clicked', async () => {
    const handleSignOut = vi.fn();
    render(<PopoverWrapper onSignOut={handleSignOut} />);

    const signoutBtn = screen.getByRole('menuitem', { name: /Sign Out/i });
    await userEvent.click(signoutBtn);
    expect(handleSignOut).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when clicking outside popover and trigger', () => {
    const handleClose = vi.fn();
    render(<PopoverWrapper onClose={handleClose} />);

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});

describe('GatewayTelemetryChip', () => {
  it('renders latency ms value and daemon status tooltip', () => {
    render(<GatewayTelemetryChip engineLatencyMs={14} />);

    expect(screen.getByText('14ms')).toBeInTheDocument();
    expect(screen.getByText('Tokio Session Daemon')).toBeInTheDocument();
    expect(screen.getByText('Rust In-Process Gateway')).toBeInTheDocument();
    expect(screen.getByText('Status: Active & Connected')).toBeInTheDocument();
  });
});

describe('SidebarUtilityDock', () => {
  it('renders telemetry chip, theme button, and collapse button when expanded', () => {
    render(
      <SidebarUtilityDock
        isDark={true}
        onToggleTheme={vi.fn()}
        isCollapsed={false}
        onToggleCollapse={vi.fn()}
        engineLatencyMs={8}
      />
    );

    expect(screen.getByText('8ms')).toBeInTheDocument();
    expect(screen.getByTitle(/Switch to Light Theme/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Collapse sidebar/i)).toBeInTheDocument();
  });

  it('hides telemetry chip when collapsed and updates titles', () => {
    render(
      <SidebarUtilityDock
        isDark={false}
        onToggleTheme={vi.fn()}
        isCollapsed={true}
        onToggleCollapse={vi.fn()}
        engineLatencyMs={8}
      />
    );

    expect(screen.queryByText('8ms')).not.toBeInTheDocument();
    expect(screen.getByTitle(/Switch to Dark Theme/i)).toBeInTheDocument();
    expect(screen.getByTitle(/Expand sidebar/i)).toBeInTheDocument();
  });
});

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toggles the account popover on clicking user profile card', async () => {
    render(
      <MemoryRouter>
        <SidebarFooter
          displayName="Super Admin"
          roleName="admin"
          email="admin@strataclient.io"
          isOnline={true}
          isCollapsed={false}
          isDark={true}
          onToggleTheme={vi.fn()}
          onToggleCollapse={vi.fn()}
          onSignOut={vi.fn()}
          activeCheckoutsCount={2}
          engineLatencyMs={6}
        />
      </MemoryRouter>
    );

    // Initially popover is closed
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // Click profile card to open popover
    const profileCardBtn = screen.getByRole('button', { name: /Super Admin/i });
    await userEvent.click(profileCardBtn);

    // Popover is now visible
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('admin@strataclient.io')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    // Clicking profile card again closes it
    await userEvent.click(profileCardBtn);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('fires onSignOut from within the popover', async () => {
    const handleSignOut = vi.fn();
    render(
      <MemoryRouter>
        <SidebarFooter
          displayName="Super Admin"
          roleName="admin"
          email="admin@strataclient.io"
          isOnline={true}
          isCollapsed={false}
          isDark={true}
          onToggleTheme={vi.fn()}
          onToggleCollapse={vi.fn()}
          onSignOut={handleSignOut}
        />
      </MemoryRouter>
    );

    const profileCardBtn = screen.getByRole('button', { name: /Super Admin/i });
    await userEvent.click(profileCardBtn);

    const signoutBtn = screen.getByRole('menuitem', { name: /Sign Out/i });
    await userEvent.click(signoutBtn);

    expect(handleSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders cleanly in collapsed mode', () => {
    render(
      <MemoryRouter>
        <SidebarFooter
          displayName="Super Admin"
          roleName="admin"
          email="admin@strataclient.io"
          isOnline={true}
          isCollapsed={true}
          isDark={true}
          onToggleTheme={vi.fn()}
          onToggleCollapse={vi.fn()}
          onSignOut={vi.fn()}
        />
      </MemoryRouter>
    );

    // Displays initial
    expect(screen.getByText('S')).toBeInTheDocument();
    // Does not display user details in collapsed mode
    expect(screen.queryByText('Super Admin')).not.toBeInTheDocument();
    // Latency chip hidden
    expect(screen.queryByText('ms')).not.toBeInTheDocument();
  });
});
