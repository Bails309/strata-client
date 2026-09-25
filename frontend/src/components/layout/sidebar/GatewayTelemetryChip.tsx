import React from 'react';

export interface GatewayTelemetryChipProps {
  engineLatencyMs?: number;
}

export const GatewayTelemetryChip: React.FC<GatewayTelemetryChipProps> = ({
  engineLatencyMs = 8,
}) => {
  return (
    <div
      className="group relative inline-flex items-center gap-1.5 rounded-[4px] bg-[rgba(var(--accent-rgb),0.04)] border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:border-emerald-500/30 hover:text-[var(--text-primary)] transition-colors cursor-help"
      title="Session Engine Health"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
      <span className="font-mono">{engineLatencyMs}ms</span>

      {/* Hover Tooltip */}
      <div className="pointer-events-none absolute bottom-full left-0 mb-1 hidden w-44 rounded-[4px] border border-[var(--border-subtle)] sb-surface p-2 text-[10px] text-[var(--text-primary)] shadow-xl group-hover:block z-50">
        <div className="font-semibold text-[var(--text-white)]">Tokio Session Daemon</div>
        <div className="text-[var(--text-secondary)] mt-0.5">Rust In-Process Gateway</div>
        <div className="text-[var(--status-connected)] mt-1">Status: Active & Connected</div>
      </div>
    </div>
  );
};

export default GatewayTelemetryChip;
