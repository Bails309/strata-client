import React, { useState, useRef } from 'react';
import { UserProfileCard } from './UserProfileCard';
import { UserAccountPopover } from './UserAccountPopover';
import { SidebarUtilityDock } from './SidebarUtilityDock';

export interface SidebarFooterProps {
  displayName: string;
  roleName: string;
  email: string;
  isOnline: boolean;
  isCollapsed: boolean;
  isDark: boolean;
  onToggleTheme: () => void;
  onToggleCollapse: () => void;
  onSignOut: () => void;
  activeCheckoutsCount?: number;
  engineLatencyMs?: number;
  onOpenSettings?: () => void;
  onOpenLeases?: () => void;
}

export const SidebarFooter: React.FC<SidebarFooterProps> = ({
  displayName,
  roleName,
  email,
  isOnline,
  isCollapsed,
  isDark,
  onToggleTheme,
  onToggleCollapse,
  onSignOut,
  activeCheckoutsCount = 0,
  engineLatencyMs,
  onOpenSettings,
  onOpenLeases,
}) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const cardContainerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className={`relative border-t border-[var(--border-subtle)] bg-[var(--color-nav-bg)] backdrop-blur-md space-y-1.5 ${
        isCollapsed ? 'p-2' : 'p-2.5'
      }`}
    >
      {/* Anchor Container */}
      <div ref={cardContainerRef}>
        <UserProfileCard
          displayName={displayName}
          roleName={roleName}
          isOnline={isOnline}
          isCollapsed={isCollapsed}
          isOpen={isPopoverOpen}
          onClick={() => setIsPopoverOpen((prev) => !prev)}
        />
      </div>

      {/* Slide-Up Popover */}
      <UserAccountPopover
        isOpen={isPopoverOpen}
        onClose={() => setIsPopoverOpen(false)}
        onSignOut={onSignOut}
        userEmail={email}
        roleName={roleName}
        activeCheckoutsCount={activeCheckoutsCount}
        triggerRef={cardContainerRef}
        isCollapsed={isCollapsed}
        onOpenSettings={onOpenSettings}
        onOpenLeases={onOpenLeases}
      />

      {/* Utility Dock */}
      <SidebarUtilityDock
        isDark={isDark}
        onToggleTheme={onToggleTheme}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        engineLatencyMs={engineLatencyMs}
      />
    </div>
  );
};

export default SidebarFooter;
