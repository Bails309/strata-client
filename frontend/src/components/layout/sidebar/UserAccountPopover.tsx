import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export interface UserAccountPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSignOut: () => void;
  userEmail: string;
  roleName: string;
  activeCheckoutsCount?: number;
  triggerRef: React.RefObject<HTMLDivElement | null>;
  isCollapsed?: boolean;
  onOpenSettings?: () => void;
  onOpenLeases?: () => void;
}

export const UserAccountPopover: React.FC<UserAccountPopoverProps> = ({
  isOpen,
  onClose,
  onSignOut,
  userEmail,
  roleName,
  activeCheckoutsCount = 0,
  triggerRef,
  isCollapsed = false,
  onOpenSettings,
  onOpenLeases,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        isOpen &&
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      role="menu"
      className={`absolute bottom-[calc(100%+8px)] z-50 overflow-hidden rounded-[8px] border border-[var(--border-subtle)] sb-surface p-1.5 shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 duration-150 ${
        isCollapsed ? 'left-2 w-56' : 'left-2 right-2'
      }`}
    >
      {/* Principal Identity Context */}
      <div className="border-b border-[var(--border-subtle)] px-3 py-2">
        <div className="truncate text-xs font-semibold text-[var(--text-white)]">{userEmail}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="font-mono text-[10px] text-[var(--text-secondary)]">Role:</span>
          <span className="rounded-[3px] bg-[rgba(var(--accent-rgb),0.1)] px-1.5 py-0.5 font-mono text-[9px] font-semibold text-[var(--accent-cyan)]">
            {roleName}
          </span>
        </div>
      </div>

      {/* Quick Access Menu List */}
      <div className="py-1">
        <button
          type="button"
          role="menuitem"
          className="w-full flex items-center justify-between rounded-[4px] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[rgba(var(--accent-rgb),0.07)] hover:text-[var(--text-white)] transition-colors cursor-pointer text-left"
          onClick={() => {
            if (onOpenSettings) {
              onOpenSettings();
            } else {
              navigate('/profile');
            }
            onClose();
          }}
        >
          <span className="flex items-center gap-2">
            <span>👤</span> Profile & Settings
          </span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="w-full flex items-center justify-between rounded-[4px] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[rgba(var(--accent-rgb),0.07)] hover:text-[var(--text-white)] transition-colors cursor-pointer text-left"
          onClick={() => {
            if (onOpenLeases) {
              onOpenLeases();
            } else {
              navigate('/credentials');
            }
            onClose();
          }}
        >
          <span className="flex items-center gap-2">
            <span>🔑</span> Active Leases
          </span>
          {activeCheckoutsCount > 0 && (
            <span className="rounded-full bg-amber-500/15 border border-amber-500/30 px-1.5 text-[10px] font-bold text-[var(--accent-amber)]">
              {activeCheckoutsCount}
            </span>
          )}
        </button>
      </div>

      {/* Demoted Sign Out Action */}
      <div className="border-t border-[var(--border-subtle)] pt-1">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onSignOut();
          }}
          className="w-full flex items-center gap-2 rounded-[4px] px-3 py-1.5 text-xs font-medium text-[var(--status-expired-text)] hover:bg-rose-500/10 transition-colors cursor-pointer text-left"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign Out
        </button>
      </div>
    </div>
  );
};

export default UserAccountPopover;
