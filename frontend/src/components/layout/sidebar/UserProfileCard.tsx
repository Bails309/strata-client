import React from "react";

export interface UserProfileCardProps {
  displayName: string;
  roleName: string;
  isOnline: boolean;
  isCollapsed: boolean;
  isOpen: boolean;
  onClick: () => void;
}

export const UserProfileCard: React.FC<UserProfileCardProps> = ({
  displayName,
  roleName,
  isOnline,
  isCollapsed,
  isOpen,
  onClick,
}) => {
  const initial = (displayName || "U").charAt(0).toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={isOpen}
      aria-haspopup="menu"
      className={`group w-full flex items-center justify-between rounded-[8px] border transition-all duration-150 outline-none cursor-pointer
        ${
          isOpen
            ? "bg-[rgba(var(--accent-rgb),0.08)] border-[rgba(var(--accent-rgb),0.4)] shadow-[0_0_12px_rgba(var(--accent-rgb),0.15)]"
            : "bg-[rgba(var(--control-rgb),0.7)] border-[var(--border-subtle)] hover:bg-[rgba(var(--accent-rgb),0.07)] hover:border-[rgba(var(--accent-rgb),0.3)]"
        }
        ${isCollapsed ? "p-2 justify-center" : "p-2.5"}`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Geometric Avatar */}
        <div className="relative shrink-0 flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--border-subtle)] bg-[rgba(var(--accent-rgb),0.1)] font-semibold text-xs text-[var(--accent-cyan)]">
          {initial}
          {/* Status Dot */}
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[var(--bg-app-base)] ${
              isOnline ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" : "bg-slate-500"
            }`}
          />
        </div>

        {/* User Details */}
        {!isCollapsed && (
          <div className="flex flex-col text-left min-w-0">
            <span className="truncate text-xs font-semibold text-[var(--text-white)] group-hover:text-[var(--accent-cyan)] transition-colors">
              {displayName}
            </span>
            <span className="truncate font-mono text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
              {roleName}
            </span>
          </div>
        )}
      </div>

      {/* Popover Caret */}
      {!isCollapsed && (
        <svg
          className={`h-4 w-4 shrink-0 text-[var(--text-secondary)] transition-transform duration-150 group-hover:text-[var(--text-white)] ${
            isOpen ? "rotate-180 text-[var(--accent-cyan)]" : ""
          }`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      )}
    </button>
  );
};

export default UserProfileCard;
