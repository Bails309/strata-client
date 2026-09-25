import React from 'react';
import { GatewayTelemetryChip } from './GatewayTelemetryChip';

export interface SidebarUtilityDockProps {
  isDark: boolean;
  onToggleTheme: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  engineLatencyMs?: number;
}

export const SidebarUtilityDock: React.FC<SidebarUtilityDockProps> = ({
  isDark,
  onToggleTheme,
  isCollapsed,
  onToggleCollapse,
  engineLatencyMs = 8,
}) => {
  return (
    <div
      className={`flex items-center border-t border-[var(--border-subtle)] pt-2 mt-1 text-[var(--text-secondary)] ${
        isCollapsed ? 'flex-col gap-2' : 'justify-between px-1'
      }`}
    >
      {/* 1. Live Engine Telemetry Badge */}
      {!isCollapsed && (
        <GatewayTelemetryChip engineLatencyMs={engineLatencyMs} />
      )}

      {/* 2. Utility Actions */}
      <div className="flex items-center gap-1">
        {/* Theme Toggle Button */}
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label="Toggle Theme"
          className="rounded-[4px] p-1.5 text-[var(--text-secondary)] hover:bg-[rgba(var(--accent-rgb),0.07)] hover:text-[var(--text-white)] transition-colors cursor-pointer"
          title={isDark ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
        >
          {isDark ? (
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : (
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          )}
        </button>

        {/* Sidebar Collapse Toggle Button */}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          className="rounded-[4px] p-1.5 text-[var(--text-secondary)] hover:bg-[rgba(var(--accent-rgb),0.07)] hover:text-[var(--text-white)] transition-colors cursor-pointer"
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg
            className={`h-3.5 w-3.5 transform transition-transform duration-150 ${isCollapsed ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="11 17 6 12 11 7" />
            <polyline points="18 17 13 12 18 7" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default SidebarUtilityDock;
