import { useEffect, useState, useCallback } from 'react';
import {
  MeResponse,
  CheckoutRequest,
  getPendingApprovals,
  decideCheckout,
} from '../api';

function cnFromDn(dn: string): string {
  const m = dn.match(/^CN=((?:\\.|[^,])+)/i);
  return m ? m[1].replace(/\\(.)/g, '$1') : dn;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Approvals({ user: _user }: { user: MeResponse }) {
  const [pending, setPending] = useState<CheckoutRequest[]>([]);
  const [msg, setMsg] = useState('');
  const [deciding, setDeciding] = useState<string | null>(null);

  const flash = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 4000);
  };

  const loadPending = useCallback(async () => {
    try { setPending(await getPendingApprovals()); } catch { /* */ }
  }, []);

  useEffect(() => { loadPending(); }, [loadPending]);

  const handleDecide = async (id: string, approved: boolean) => {
    setDeciding(id);
    try {
      await decideCheckout(id, approved);
      flash(approved ? 'Checkout approved' : 'Checkout denied');
      loadPending();
    } catch (e: any) {
      flash(e.message || 'Decision failed');
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="animate-fade-up" style={{ padding: '2rem', maxWidth: 900, margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="!mb-0">Pending Approvals</h1>
          <p className="text-txt-secondary text-sm mt-1">
            Review and approve or deny password checkout requests.
          </p>
        </div>
        <button className="btn" onClick={loadPending}>Refresh</button>
      </div>

      {msg && (
        <div className="rounded-md mb-4 px-4 py-2 bg-success-dim text-success">{msg}</div>
      )}

      {pending.length === 0 ? (
        <div className="card text-center py-12">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4 text-txt-tertiary">
            <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
          <p className="text-txt-secondary text-sm">No pending approvals.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((p) => (
            <div key={p.id} className="card overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 pt-4 pb-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold"
                       style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent)' }}>
                    {(p.requester_username || '?')[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">
                      {p.requester_username || p.requester_user_id}
                    </div>
                    <div className="text-xs text-txt-tertiary">{timeAgo(p.created_at)}</div>
                  </div>
                </div>
                <span className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full"
                      style={{ background: 'var(--color-warning-dim)', color: 'var(--color-warning)' }}>
                  Pending
                </span>
              </div>

              {/* Body */}
              <div className="px-5 pb-4">
                {/* Account */}
                <div className="mb-3">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-txt-tertiary mb-1">Account</div>
                  <div className="text-sm font-medium">{cnFromDn(p.managed_ad_dn)}</div>
                  <div className="text-xs text-txt-tertiary mt-0.5 break-all">{p.managed_ad_dn}</div>
                </div>

                {/* Details row */}
                <div className="flex gap-6 mb-3">
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-wider text-txt-tertiary mb-1">Duration</div>
                    <div className="text-sm">
                      {p.requested_duration_mins >= 60
                        ? `${Math.floor(p.requested_duration_mins / 60)}h ${p.requested_duration_mins % 60 ? `${p.requested_duration_mins % 60}m` : ''}`
                        : `${p.requested_duration_mins}m`}
                    </div>
                  </div>
                </div>

                {/* Justification */}
                {p.justification_comment && (
                  <div className="mb-3">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-txt-tertiary mb-1">Justification</div>
                    <div className="text-sm rounded-md px-3 py-2 italic"
                         style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-glass-border)' }}>
                      "{p.justification_comment}"
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-2"
                     style={{ borderTop: '1px solid var(--color-glass-border)' }}>
                  <button
                    className="btn btn-sm btn-success"
                    disabled={deciding === p.id}
                    onClick={() => handleDecide(p.id, true)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5"><path d="M20 6L9 17l-5-5"/></svg>
                    Approve
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={deciding === p.id}
                    onClick={() => handleDecide(p.id, false)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mr-1.5"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
                    Deny
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
