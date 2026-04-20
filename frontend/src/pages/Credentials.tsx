import { useEffect, useState, useCallback, useRef } from 'react';
import { useSettings } from '../contexts/SettingsContext';
import { createPortal } from 'react-dom';
import Select from '../components/Select';
import {
  getCredentialProfiles,
  createCredentialProfile,
  updateCredentialProfile,
  deleteCredentialProfile,
  getProfileMappings,
  setCredentialMapping,
  removeCredentialMapping,
  getMyConnections,
  getMyCheckouts,
  getMyManagedAccounts,
  requestCheckout,
  revealCheckoutPassword,
  retryCheckoutActivation,
  checkinCheckout,
  linkCheckoutToProfile,
  CredentialProfile,
  CredentialMapping,
  Connection,
  CheckoutRequest,
  UserAccountMapping,
} from '../api';

interface EditingProfile {
  id?: string;
  label: string;
  username: string;
  password: string;
  ttl_hours: number;
  managed_ad_dn?: string;
  friendly_name?: string;
}

export default function Credentials({ vaultConfigured }: { vaultConfigured: boolean }) {
  type Tab = 'profiles' | 'request' | 'my-checkouts';
  const [tab, setTab] = useState<Tab>('profiles');
  const [profiles, setProfiles] = useState<CredentialProfile[]>([]);
  const { formatDateTime } = useSettings();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [mappings, setMappings] = useState<Record<string, CredentialMapping[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mappingProfileId, setMappingProfileId] = useState<string | null>(null);
  const [mappingConnectionIds, setMappingConnectionIds] = useState<string[]>([]);
  const [mappingSearch, setMappingSearch] = useState('');
  const [mappingDropdownOpen, setMappingDropdownOpen] = useState(false);
  const mappingDropdownRef = useRef<HTMLDivElement>(null);
  const mappingTriggerRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [checkinId, setCheckinId] = useState<string | null>(null);
  const [activeCheckouts, setActiveCheckouts] = useState<CheckoutRequest[]>([]);
  const [allCheckouts, setAllCheckouts] = useState<CheckoutRequest[]>([]);
  const [revealedPw, setRevealedPw] = useState<Record<string, string>>({});
  const revealTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Auto-hide revealed password after 30 seconds
  const scheduleHidePassword = (id: string) => {
    if (revealTimers.current[id]) clearTimeout(revealTimers.current[id]);
    revealTimers.current[id] = setTimeout(() => {
      setRevealedPw((p) => { const { [id]: _, ...rest } = p; return rest; });
      delete revealTimers.current[id];
    }, 30000);
  };

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      Object.values(revealTimers.current).forEach(clearTimeout);
    };
  }, []);

  // Checkout request state
  const [managedAccounts, setManagedAccounts] = useState<UserAccountMapping[]>([]);
  const [selectedDn, setSelectedDn] = useState('');
  const [duration, setDuration] = useState(60);
  const [justification, setJustification] = useState('');
  const [emergencyBypass, setEmergencyBypass] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledStart, setScheduledStart] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');

  const flash = (text: string) => { setMsg(text); setTimeout(() => setMsg(''), 4000); };

  // Checkout-to-profile linking
  const [linkingProfileId, setLinkingProfileId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profs, conns] = await Promise.all([
        getCredentialProfiles(),
        getMyConnections(),
      ]);
      setProfiles(profs);
      setConnections(conns);

      // Load active checkouts
      getMyCheckouts()
        .then((all) => {
          setAllCheckouts(all);
          setActiveCheckouts(all.filter((c) => !isCheckoutExpired(c) && (c.status === 'Active' || c.status === 'Approved' || c.status === 'Pending' || c.status === 'Scheduled')));
        })
        .catch(() => {});

      // Load managed accounts for checkout request
      getMyManagedAccounts().then(setManagedAccounts).catch(() => {});

      // Load mappings for all profiles
      const m: Record<string, CredentialMapping[]> = {};
      await Promise.all(
        profs.map(async (p) => {
          try {
            m[p.id] = await getProfileMappings(p.id);
          } catch {
            m[p.id] = [];
          }
        }),
      );
      setMappings(m);
    } catch {
      setError('Failed to load credential data');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSaveProfile() {
    if (!editing) return;
    setSaving(true);
    setError('');
    try {
      if (editing.id) {
        await updateCredentialProfile(editing.id, {
          label: editing.label,
          username: editing.username || undefined,
          password: editing.password || undefined,
          ttl_hours: editing.ttl_hours,
        });
      } else {
        if (!editing.label || !editing.username || !editing.password) {
          setError('All fields are required for a new profile');
          setSaving(false);
          return;
        }
        await createCredentialProfile(editing.label, editing.username, editing.password, editing.ttl_hours);
      }
      setEditing(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteProfile(id: string) {
    if (!id) return;
    setError('');
    try {
      await deleteCredentialProfile(id);
      if (expanded === id) setExpanded(null);
      setDeletingId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function handleAddMapping() {
    if (!mappingProfileId || mappingConnectionIds.length === 0) return;
    setError('');
    try {
      for (const cid of mappingConnectionIds) {
        await setCredentialMapping(mappingProfileId, cid);
      }
      setMappingConnectionIds([]);
      setMappingSearch('');
      setMappingProfileId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Mapping failed');
    }
  }

  // Close multi-select dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (mappingTriggerRef.current?.contains(t)) return;
      if (mappingDropdownRef.current?.contains(t)) return;
      setMappingDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Position the portal dropdown below the trigger
  useEffect(() => {
    if (!mappingDropdownOpen || !mappingTriggerRef.current) return;
    const positionMenu = () => {
      const rect = mappingTriggerRef.current!.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const menuHeight = 280;
      const placeAbove = spaceBelow < menuHeight && rect.top > menuHeight;
      setMenuStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
        ...(placeAbove
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      });
    };
    positionMenu();
    window.addEventListener('scroll', positionMenu, true);
    window.addEventListener('resize', positionMenu);
    return () => {
      window.removeEventListener('scroll', positionMenu, true);
      window.removeEventListener('resize', positionMenu);
    };
  }, [mappingDropdownOpen]);

  async function handleRemoveMapping(connectionId: string) {
    setError('');
    try {
      await removeCredentialMapping(connectionId);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    }
  }

  // ── Checkout handlers ──
  const handleRequestCheckout = async () => {
    if (!selectedDn) return;
    const acct = managedAccounts.find((a) => a.managed_ad_dn === selectedDn);
    const isEmergency = emergencyBypass && !!acct && !acct.can_self_approve && !!acct.pm_allow_emergency_bypass;
    const approvalRequired = !!acct && !acct.can_self_approve;
    if (approvalRequired && justification.trim().length < 10) {
      flash(
        isEmergency
          ? 'Emergency bypass requires a justification of at least 10 characters'
          : 'A justification of at least 10 characters is required for approval-required checkouts'
      );
      return;
    }
    const effectiveDuration = isEmergency ? Math.min(duration, 30) : duration;
    let scheduledIso: string | undefined;
    if (scheduleEnabled && !isEmergency && scheduledStart) {
      const when = new Date(scheduledStart);
      if (Number.isNaN(when.getTime())) {
        flash('Invalid scheduled start time');
        return;
      }
      if (when.getTime() - Date.now() < 60_000) {
        flash('Scheduled start must be at least 1 minute in the future');
        return;
      }
      if (when.getTime() - Date.now() > 14 * 24 * 3600 * 1000) {
        flash('Scheduled start cannot be more than 14 days ahead');
        return;
      }
      scheduledIso = when.toISOString();
    }
    setSubmitting(true);
    try {
      const res = await requestCheckout({
        managed_ad_dn: selectedDn,
        ad_sync_config_id: acct?.ad_sync_config_id || undefined,
        requested_duration_mins: effectiveDuration,
        justification_comment: justification || undefined,
        emergency_bypass: isEmergency || undefined,
        scheduled_start_at: scheduledIso,
      });
      flash(
        isEmergency
          ? 'Emergency bypass approved — password activated'
          : res.status === 'Scheduled'
            ? 'Checkout scheduled — password will release at the chosen time'
            : `Checkout ${res.status === 'Approved' ? 'approved and activated' : 'submitted for approval'}`
      );
      setSelectedDn('');
      setJustification('');
      setEmergencyBypass(false);
      setScheduleEnabled(false);
      setScheduledStart('');
      load();
    } catch (e: any) {
      flash(e.message || 'Request failed');
    }
    setSubmitting(false);
  };

  const handleRevealCheckout = async (id: string) => {
    try {
      const res = await revealCheckoutPassword(id);
      setRevealedPw((p) => ({ ...p, [id]: res.password }));
      scheduleHidePassword(id);
    } catch (e: any) {
      flash(e.message || 'Failed to reveal password');
    }
  };

  const handleLinkCheckout = async (profileId: string, checkoutId: string | null) => {
    try {
      await linkCheckoutToProfile(profileId, checkoutId);
      flash(checkoutId ? 'Checkout linked to profile' : 'Checkout unlinked');
      setLinkingProfileId(null);
      await load();
    } catch (e: any) {
      flash(e.message || 'Failed to link checkout');
    }
  };

  const getTimeRemaining = (expiresAt?: string) => {
    if (!expiresAt) return '';
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const secs = Math.floor(diff / 1000);
    const hrs = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${s}s remaining`;
    if (mins > 0) return `${mins}m ${s}s remaining`;
    return `${s}s remaining`;
  };

  // Detect if an Approved/Pending checkout is stale (created_at + duration has passed)
  const isCheckoutStale = (c: CheckoutRequest) => {
    if (c.status !== 'Approved' && c.status !== 'Pending') return false;
    const deadline = new Date(c.created_at).getTime() + c.requested_duration_mins * 60000;
    return Date.now() > deadline;
  };

  // Detect if a checkout is effectively expired (status Expired, stale, or Active past expires_at)
  const isCheckoutExpired = (c: CheckoutRequest) => {
    if (c.status === 'Expired' || c.status === 'Denied' || c.status === 'CheckedIn') return true;
    if (isCheckoutStale(c)) return true;
    if (c.status === 'Active' && c.expires_at && new Date(c.expires_at!).getTime() <= Date.now()) return true;
    return false;
  };

  // Is this checkout truly active (Active status AND not past expires_at)
  const isCheckoutLive = (c: CheckoutRequest) => {
    return c.status === 'Active' && c.expires_at && new Date(c.expires_at!).getTime() > Date.now();
  };

  // Effective display status
  const getEffectiveStatus = (c: CheckoutRequest) => {
    if (c.status === 'CheckedIn') return 'Checked In';
    if (isCheckoutStale(c)) return 'Expired — activation failed';
    if (c.status === 'Active' && c.expires_at && new Date(c.expires_at!).getTime() <= Date.now()) return 'Expired';
    return c.status;
  };

  // Live countdown tick for active checkouts
  const [, setTick] = useState(0);
  useEffect(() => {
    const hasActive = allCheckouts.some((c) => isCheckoutLive(c));
    if (!hasActive) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [allCheckouts]);

  // Connections already mapped to any profile by this user
  const mappedConnectionIds = new Set(
    Object.values(mappings).flat().map((m) => m.connection_id),
  );

  const availableConnections = connections.filter((c) => !mappedConnectionIds.has(c.id));

  const filteredAvailable = availableConnections.filter((c) => {
    if (!mappingSearch) return true;
    const q = mappingSearch.toLowerCase();
    return c.name.toLowerCase().includes(q)
      || c.hostname.toLowerCase().includes(q)
      || (c.description || '').toLowerCase().includes(q)
      || c.protocol.toLowerCase().includes(q);
  });

  if (!vaultConfigured) {
    return (
      <div className="animate-fade-up" style={{ padding: '2rem', maxWidth: 800, margin: '0 auto' }}>
        <h1>Credentials</h1>
        <div className="card">
          <div className="flex items-center gap-3 text-warning">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div>
              <p className="font-semibold text-txt-primary">Vault Not Configured</p>
              <p className="text-txt-secondary text-sm mt-1">
                Credential profiles require HashiCorp Vault for secure encryption.
                Ask an administrator to configure Vault in Admin Settings.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-up" style={{ padding: '2rem', maxWidth: 900, margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="!mb-0">Credentials</h1>
          <p className="text-txt-secondary text-sm mt-1">
            Manage your saved credentials, request password checkouts, and map them to connections.
          </p>
        </div>
        {tab === 'profiles' && (
        <button
          className="btn-primary"
          onClick={() => setEditing({ label: '', username: '', password: '', ttl_hours: 12 })}
        >
          <span className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New Profile
          </span>
        </button>
        )}
      </div>

      {(msg || error) && (
        <div className={`rounded-sm mb-4 px-4 py-2 text-[0.8125rem] ${error ? 'bg-danger-dim text-danger' : 'bg-success-dim text-success'}`}>
          {error || msg}
        </div>
      )}

      <div className="tabs mb-4">
        {(['profiles', 'request', 'my-checkouts'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'tab-active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'profiles'
              ? 'Profiles'
              : t === 'request'
                ? 'Request Checkout'
                : `My Checkouts${allCheckouts.filter((c) => isCheckoutLive(c)).length ? ` (${allCheckouts.filter((c) => isCheckoutLive(c)).length})` : ''}`}
          </button>
        ))}
      </div>

      {/* ── Request Checkout ── */}
      {tab === 'request' && (
        <div className="card p-6">
          <h2 className="text-lg font-semibold mb-4">Request Password Checkout</h2>
          {managedAccounts.length === 0 ? (
            <p className="text-txt-secondary">No managed accounts assigned to you. Contact an administrator.</p>
          ) : managedAccounts.every((a) => allCheckouts.some(
              (c) => c.managed_ad_dn === a.managed_ad_dn && !isCheckoutExpired(c) && (c.status === 'Active' || c.status === 'Approved' || c.status === 'Pending' || c.status === 'Scheduled')
            )) ? (
            <p className="text-txt-secondary">All managed accounts already have active checkouts. Wait for current checkouts to expire before requesting new ones.</p>
          ) : (
            <>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">Managed Account</label>
                <Select
                  value={selectedDn}
                  onChange={setSelectedDn}
                  placeholder="Select account..."
                  options={managedAccounts
                    .filter((a) => !allCheckouts.some(
                      (c) => c.managed_ad_dn === a.managed_ad_dn && !isCheckoutExpired(c) && (c.status === 'Active' || c.status === 'Approved' || c.status === 'Pending' || c.status === 'Scheduled')
                    ))
                    .map((a) => ({
                      value: a.managed_ad_dn,
                      label: a.managed_ad_dn + (a.can_self_approve ? ' (self-approve)' : ''),
                    }))}
                />
              </div>
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">
                  Duration (minutes, 1–{emergencyBypass ? 30 : 720})
                </label>
                {(() => {
                  const durationMax = emergencyBypass ? 30 : 720;
                  const clampDuration = (n: number) => Math.min(durationMax, Math.max(1, Math.round(n || 0)));
                  return (
                    <div className="inline-flex items-stretch rounded-md border border-border bg-bg-primary overflow-hidden focus-within:border-accent/60 transition-colors">
                      <button
                        type="button"
                        className="px-3 text-lg leading-none text-txt-secondary hover:bg-border/30 hover:text-txt-primary active:bg-border/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        onClick={() => setDuration((d) => clampDuration(d - (d > 60 ? 15 : d > 10 ? 5 : 1)))}
                        disabled={duration <= 1}
                        aria-label="Decrease duration"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        className="no-spinner w-20 text-center border-0 bg-transparent focus:shadow-none focus:border-0 tabular-nums"
                        min={1}
                        max={durationMax}
                        value={duration}
                        onChange={(e) => setDuration(clampDuration(Number(e.target.value)))}
                        onBlur={(e) => setDuration(clampDuration(Number(e.target.value)))}
                      />
                      <button
                        type="button"
                        className="px-3 text-lg leading-none text-txt-secondary hover:bg-border/30 hover:text-txt-primary active:bg-border/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        onClick={() => setDuration((d) => clampDuration(d + (d >= 60 ? 15 : d >= 10 ? 5 : 1)))}
                        disabled={duration >= durationMax}
                        aria-label="Increase duration"
                      >
                        +
                      </button>
                      <span className="px-3 flex items-center text-xs text-txt-tertiary border-l border-border bg-bg-secondary/40 select-none">
                        min
                      </span>
                    </div>
                  );
                })()}
                {emergencyBypass && (
                  <p className="text-xs text-warning mt-1">
                    Emergency bypass checkouts are capped at 30 minutes.
                  </p>
                )}
              </div>
              <div className="mb-4">
                {(() => {
                  const acct = managedAccounts.find((a) => a.managed_ad_dn === selectedDn);
                  const approvalRequired = !!acct && !acct.can_self_approve;
                  const isEmergencyActive = emergencyBypass
                    && !!acct && !acct.can_self_approve && !!acct.pm_allow_emergency_bypass;
                  const justificationRequired = approvalRequired;
                  const justificationTooShort = justificationRequired && justification.trim().length < 10;
                  return (
                    <>
                      <label className="block text-sm font-medium mb-1">
                        Justification{' '}
                        {justificationRequired ? (
                          <span className={isEmergencyActive ? 'text-warning' : 'text-danger'}>
                            (required, min 10 characters)
                          </span>
                        ) : (
                          <span className="text-txt-tertiary">(optional)</span>
                        )}
                      </label>
                      <textarea
                        className={`input w-full ${justificationTooShort ? (isEmergencyActive ? 'border-warning/60' : 'border-danger/60') : ''}`}
                        rows={2}
                        value={justification}
                        onChange={(e) => setJustification(e.target.value)}
                        placeholder={
                          isEmergencyActive
                            ? 'Describe the incident and why approval cannot wait…'
                            : justificationRequired
                              ? 'Explain why you need this account — approvers will see this…'
                              : 'Reason for checkout...'
                        }
                      />
                      {justificationTooShort && (
                        <p className={`text-xs mt-1 ${isEmergencyActive ? 'text-warning' : 'text-danger'}`}>
                          {isEmergencyActive
                            ? 'Emergency bypass requires a justification of at least 10 characters.'
                            : 'Approval-required checkouts need a justification of at least 10 characters.'}
                          {justification.trim().length > 0 && ` (${justification.trim().length}/10)`}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
              <div className="mb-4">
                <label className="flex items-center gap-2 cursor-pointer text-sm font-medium mb-1">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={scheduleEnabled}
                    onChange={(e) => {
                      setScheduleEnabled(e.target.checked);
                      if (e.target.checked && !scheduledStart) {
                        // Default to 15 minutes from now, rounded to next 5
                        const d = new Date(Date.now() + 15 * 60 * 1000);
                        d.setSeconds(0, 0);
                        // Format as local datetime-local (YYYY-MM-DDTHH:mm)
                        const pad = (n: number) => n.toString().padStart(2, '0');
                        setScheduledStart(
                          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
                        );
                      }
                    }}
                  />
                  Schedule release for a future time
                </label>
                {scheduleEnabled && (
                  <div className="ml-6 mt-2">
                    <input
                      type="datetime-local"
                      className="input w-64"
                      value={scheduledStart}
                      onChange={(e) => setScheduledStart(e.target.value)}
                      min={(() => {
                        const d = new Date(Date.now() + 60 * 1000);
                        const pad = (n: number) => n.toString().padStart(2, '0');
                        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                      })()}
                    />
                    <p className="text-xs text-txt-tertiary mt-1">
                      Password will be held until the chosen time, then released automatically. Max 14 days ahead.
                    </p>
                  </div>
                )}
              </div>
              {(() => {
                const acct = managedAccounts.find((a) => a.managed_ad_dn === selectedDn);
                if (!acct || acct.can_self_approve || !acct.pm_allow_emergency_bypass || scheduleEnabled) return null;
                return (
                  <div className="mb-4 p-3 rounded border border-warning/40 bg-warning/5">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="checkbox mt-1"
                        checked={emergencyBypass}
                        onChange={(e) => {
                          setEmergencyBypass(e.target.checked);
                          if (e.target.checked && duration > 30) setDuration(30);
                        }}
                      />
                      <div>
                        <div className="text-sm font-semibold text-warning">
                          Emergency Approval Bypass (Break-Glass)
                        </div>
                        <div className="text-xs text-txt-secondary mt-0.5">
                          Skip the approval workflow and release the password immediately.
                          A justification of at least 10 characters is required, and every use
                          is recorded in the audit log.
                        </div>
                      </div>
                    </label>
                  </div>
                );
              })()}
              <button
                className={`btn ${emergencyBypass ? 'btn-warning' : 'btn-primary'}`}
                onClick={handleRequestCheckout}
                disabled={
                  !selectedDn
                  || submitting
                  || (scheduleEnabled && !scheduledStart)
                  || (!!managedAccounts.find((a) => a.managed_ad_dn === selectedDn && !a.can_self_approve)
                    && justification.trim().length < 10)
                }
              >
                {submitting
                  ? 'Submitting...'
                  : emergencyBypass
                    ? 'Emergency Checkout'
                    : scheduleEnabled
                      ? 'Schedule Checkout'
                      : 'Request Checkout'}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── My Checkouts ── */}
      {tab === 'my-checkouts' && (
        <div>
          <button className="btn btn-sm mb-4" onClick={load}>Refresh</button>
          {allCheckouts.length === 0 ? (
            <p className="text-txt-secondary">No checkout requests yet.</p>
          ) : (
            <div className="space-y-3">
              {allCheckouts.filter((c) => {
                // Hide old Expired/stale checkouts if a newer Active one exists for the same account
                if (c.status === 'Expired' || isCheckoutStale(c) || isCheckoutExpired(c)) {
                  const hasNewer = allCheckouts.some(
                    (other) => other.managed_ad_dn === c.managed_ad_dn
                      && other.id !== c.id
                      && !isCheckoutExpired(other)
                      && (other.status === 'Active' || other.status === 'Approved' || other.status === 'Pending' || other.status === 'Scheduled')
                      && new Date(other.created_at).getTime() > new Date(c.created_at).getTime()
                  );
                  return !hasNewer;
                }
                return true;
              }).map((c) => (
                <div key={c.id} className="card p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-medium">{c.friendly_name || c.managed_ad_dn}</div>
                    <div className="flex items-center gap-2">
                      {c.emergency_bypass && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-warning/20 text-warning border border-warning/40">
                          ⚡ Emergency
                        </span>
                      )}
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded ${
                          c.status === 'CheckedIn'
                            ? 'bg-accent/20 text-accent'
                            : isCheckoutExpired(c)
                              ? 'bg-danger/20 text-danger'
                              : isCheckoutLive(c)
                                ? 'bg-success/20 text-success'
                                : c.status === 'Scheduled'
                                  ? 'bg-accent/20 text-accent'
                                  : c.status === 'Pending'
                                    ? 'bg-warning/20 text-warning'
                                    : c.status === 'Denied'
                                      ? 'bg-danger/20 text-danger'
                                      : 'bg-border/20 text-txt-secondary'
                        }`}
                      >
                        {getEffectiveStatus(c)}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs text-txt-secondary mb-2">
                    Duration: {c.requested_duration_mins}m
                    {c.justification_comment && ` · ${c.justification_comment}`}
                  </div>
                  {c.status === 'Scheduled' && c.scheduled_start_at && (
                    <div className="text-xs text-accent mb-2">
                      🕒 Release scheduled for {formatDateTime(c.scheduled_start_at)}
                    </div>
                  )}
                  {isCheckoutLive(c) && (
                    <div className={`text-sm font-mono font-semibold mb-2 tabular-nums ${
                      new Date(c.expires_at!).getTime() - Date.now() < 300000 ? 'text-danger' :
                      new Date(c.expires_at!).getTime() - Date.now() < 900000 ? 'text-warning' : 'text-success'
                    }`}>
                      ⏱ {getTimeRemaining(c.expires_at)}
                    </div>
                  )}
                  {isCheckoutLive(c) && (
                    <div>
                      {revealedPw[c.id] ? (
                        <div className="bg-bg-secondary p-3 rounded font-mono text-sm break-all">
                          {revealedPw[c.id]}
                        </div>
                      ) : (
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => handleRevealCheckout(c.id)}
                        >
                          Reveal Password
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-outline ml-2 mt-2"
                        onClick={() => setCheckinId(c.id)}
                      >
                        Check In
                      </button>
                    </div>
                  )}
                  {c.status === 'Approved' && !isCheckoutLive(c) && (
                    <div className="mt-2">
                      <div className="text-xs text-warning mb-2">
                        Activation failed — the password was not set in AD. You can retry.
                      </div>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={async () => {
                          try {
                            setError('');
                            await retryCheckoutActivation(c.id);
                            await load();
                          } catch (e: any) {
                            setError(e?.message || 'Retry failed');
                          }
                        }}
                      >
                        Retry Activation
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Profiles tab ── */}
      {tab === 'profiles' && (<>


      {/* ── Create / Edit modal ── */}
      {editing && (
        <div className="card mb-6" style={{ border: '1px solid var(--color-accent)', boxShadow: 'var(--shadow-accent)' }}>
          <h2 className="!mb-4">{editing.id ? 'Edit Profile' : 'New Credential Profile'}</h2>
          <div className="form-group">
            <label>Label</label>
            <input
              value={editing.label}
              onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              placeholder="e.g. Domain Admin, SSH Dev Server"
              autoFocus
            />
          </div>
          {editing.managed_ad_dn ? (
            <div className="bg-accent/5 border border-accent/20 rounded-lg px-4 py-3 mb-2">
              <div className="text-xs font-medium text-txt-secondary uppercase tracking-wider mb-1">Managed Account</div>
              <div className="text-sm font-medium text-accent">
                {editing.friendly_name || editing.managed_ad_dn}
              </div>
              <div className="text-xs text-txt-secondary mt-1">
                This profile is automatically managed by the password checkout system.
              </div>
            </div>
          ) : editing.label.startsWith('[managed]') ? (
            <div className="bg-accent/5 border border-accent/20 rounded-lg px-4 py-3 mb-2">
              <div className="text-xs font-medium text-txt-secondary uppercase tracking-wider mb-1">Managed Account</div>
              <div className="text-xs text-txt-secondary">
                Linked to system checkout
              </div>
              <div className="text-xs text-txt-secondary mt-1">
                This profile is automatically managed by the password checkout system. Username, password, and expiry are controlled by the active checkout.
              </div>
            </div>
          ) : null}

          {(() => {
            const currentProfile = editing.id ? profiles.find((p) => p.id === editing.id) : null;
            const editLinkedCheckout = currentProfile?.checkout_id
              ? allCheckouts.find((c) => c.id === currentProfile.checkout_id)
              : null;
            const hasLinkedCheckout = !!editLinkedCheckout;
            return hasLinkedCheckout ? (
              <div className="form-group">
                <div className="bg-success/5 border border-success/20 rounded-lg px-4 py-3">
                  <div className="text-xs font-medium text-txt-secondary uppercase tracking-wider mb-1">Managed Account Linked</div>
                  <div className="text-sm font-medium">{editLinkedCheckout.managed_ad_dn}</div>
                  <div className="text-xs text-txt-secondary mt-1">
                    Username and password are managed by the checked-out account.
                    {isCheckoutLive(editLinkedCheckout) ? 
                      ` Expires ${formatDateTime(editLinkedCheckout.expires_at ?? null)} · ${getTimeRemaining(editLinkedCheckout.expires_at)}`
                      : editLinkedCheckout.status === 'CheckedIn' ? ' Checked in — password scrambled'
                      : editLinkedCheckout.status === 'Expired' || isCheckoutExpired(editLinkedCheckout) ? ' Checkout expired' : ` ${editLinkedCheckout.status}`
                    }
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div className="form-group">
                    <label>Username</label>
                    <input
                      value={editing.username}
                      onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                      placeholder={editing.id ? '(unchanged)' : 'sAMAccountName (e.g. jsmith)'}
                      autoComplete="off"
                    />
                    <p className="text-txt-tertiary text-[0.6875rem] mt-1">
                      Note: Use sAMAccountName format (e.g. jsmith), not UPN or full email address.
                    </p>
                  </div>
                  <div className="form-group">
                    <label>Password</label>
                    <input
                      type="password"
                      value={editing.password}
                      onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                      placeholder={editing.id ? '(unchanged)' : 'Enter password'}
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>Password Expiry</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={1}
                      max={12}
                      step={1}
                      value={editing.ttl_hours}
                      onChange={(e) => setEditing({ ...editing, ttl_hours: Number(e.target.value) })}
                      className="flex-1"
                      style={{ accentColor: 'var(--color-accent)' }}
                    />
                    <span className="text-txt-primary font-semibold tabular-nums w-16 text-right">
                      {editing.ttl_hours} {editing.ttl_hours === 1 ? 'hour' : 'hours'}
                    </span>
                  </div>
                  <p className="text-txt-tertiary text-xs mt-1">
                    Credentials expire after this duration and must be updated. Maximum 12 hours.
                  </p>
                </div>
              </>
            );
          })()}
          {/* Checkout linking */}
          {editing.id && (activeCheckouts.filter((c) => isCheckoutLive(c)).length > 0 || profiles.find((p) => p.id === editing.id)?.checkout_id) && (
            <div className="form-group">
              <label>Link Checked-Out Account</label>
              <p className="text-txt-tertiary text-xs mb-2">
                Populate this profile with credentials from an active password checkout. The profile's expiry will match the checkout duration.
              </p>
              {(() => {
                const currentProfile = profiles.find((p) => p.id === editing.id);
                const linkedCheckout = currentProfile?.checkout_id
                  ? allCheckouts.find((c) => c.id === currentProfile.checkout_id)
                  : null;
                return linkedCheckout ? (
                  <div className="flex items-center justify-between bg-success/5 border border-success/20 rounded-lg px-4 py-2.5">
                    <div>
                      <div className="text-sm font-medium">{linkedCheckout.managed_ad_dn}</div>
                      <div className="text-xs text-txt-secondary">
                        {isCheckoutLive(linkedCheckout)
                          ? `Expires ${formatDateTime(linkedCheckout.expires_at ?? null)} · ${getTimeRemaining(linkedCheckout.expires_at!)}`
                          : linkedCheckout.status === 'CheckedIn' ? 'Checked in — password scrambled'
                          : linkedCheckout.status === 'Expired' || isCheckoutExpired(linkedCheckout) ? 'Checkout expired' : linkedCheckout.status}
                      </div>
                    </div>
                    <button
                      className="btn !px-2 !py-1 text-xs text-danger"
                      onClick={async () => {
                        await handleLinkCheckout(editing.id!, null);
                      }}
                    >
                      Unlink
                    </button>
                  </div>
                ) : (
                  <Select
                    value=""
                    onChange={async (val) => {
                      if (val) await handleLinkCheckout(editing.id!, val);
                    }}
                    placeholder="— Select a checked-out account —"
                    options={activeCheckouts
                      .filter((c) => isCheckoutLive(c))
                      .map((c) => ({
                        value: c.id,
                        label: `${c.managed_ad_dn} — ${getTimeRemaining(c.expires_at)}`,
                      }))}
                  />
                );
              })()}
            </div>
          )}
          <div className="flex items-center gap-3 mt-2">
            <button className="btn-primary" onClick={handleSaveProfile} disabled={saving}>
              {saving ? 'Saving…' : editing.id ? 'Update' : 'Create Profile'}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Active Checkouts ── */}
      {activeCheckouts.filter((c) => isCheckoutLive(c)).length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-txt-secondary mb-3 uppercase tracking-wider">Active Checkouts</h2>
          <div className="flex flex-col gap-2">
            {activeCheckouts.filter((c) => isCheckoutLive(c)).map((co) => (
              <div key={co.id} className="card flex items-center justify-between px-5 py-3">
                <div>
                  <div className="text-sm font-medium">{co.managed_ad_dn}</div>
                  <div className="text-xs text-txt-secondary">
                    {isCheckoutLive(co)
                      ? `Expires: ${formatDateTime(co.expires_at ?? null)}`
                      : getEffectiveStatus(co)}
                    {' · '}{co.requested_duration_mins}m
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                    isCheckoutLive(co)
                      ? 'bg-success/20 text-success'
                      : 'bg-warning/20 text-warning'
                  }`}>
                    {getEffectiveStatus(co)}
                  </span>
                  {isCheckoutLive(co) && (
                    revealedPw[co.id] ? (
                      <code className="text-xs bg-bg-secondary px-2 py-1 rounded font-mono">{revealedPw[co.id]}</code>
                    ) : (
                      <button
                        className="btn btn-sm"
                        onClick={async () => {
                          try {
                            const res = await revealCheckoutPassword(co.id);
                            setRevealedPw((p) => ({ ...p, [co.id]: res.password }));
                            scheduleHidePassword(co.id);
                          } catch { /* */ }
                        }}
                      >
                        Reveal
                      </button>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Profiles list ── */}
      {profiles.length === 0 && !editing ? (
        <div className="card text-center py-12">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4 text-txt-tertiary">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
          <p className="text-txt-secondary text-sm">
            No credential profiles yet. Create one to securely store your remote server credentials.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {profiles.filter((p) => {
            // Hide [managed] profiles that are linked to another user profile
            if (p.label.startsWith('[managed]')) {
              const isLinked = profiles.some((other) => other.checkout_id && other.id !== p.id
                && allCheckouts.find((c) => c.id === other.checkout_id)?.managed_ad_dn === p.label.replace('[managed] ', ''));
              return !isLinked;
            }
            return true;
          }).map((profile) => {
            const isExpanded = expanded === profile.id;
            const profileMappings = mappings[profile.id] || [];
            const isAddingMapping = mappingProfileId === profile.id;
            const linkedCo = profile.checkout_id ? allCheckouts.find((c) => c.id === profile.checkout_id) : null;
            const linkedActive = linkedCo ? isCheckoutLive(linkedCo) : false;
            const isEffectivelyExpired = profile.expired || (linkedCo && !linkedActive);

            return (
              <div key={profile.id} className="card !p-0 !overflow-hidden" style={isEffectivelyExpired ? { borderColor: 'var(--color-danger)', borderWidth: 1 } : undefined}>
                {/* Profile header */}
                <div
                  className="flex items-center justify-between px-5 py-4 cursor-pointer transition-colors duration-150"
                  style={{ borderBottom: isExpanded ? '1px solid var(--color-border)' : 'none' }}
                  onClick={() => setExpanded(isExpanded ? null : profile.id)}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                      style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)' }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                      </svg>
                    </div>
                    <div>
                      <span className="font-semibold text-[0.9rem] text-txt-primary">{profile.label}</span>
                      <span className="text-txt-tertiary text-xs ml-3">
                        {profileMappings.length} connection{profileMappings.length !== 1 ? 's' : ''}
                      </span>
                      {linkedActive && linkedCo?.expires_at ? (
                        <span className={`ml-3 text-xs font-semibold ${
                          new Date(linkedCo.expires_at).getTime() - Date.now() < 300000 ? 'text-danger' :
                          new Date(linkedCo.expires_at).getTime() - Date.now() < 900000 ? 'text-warning' : 'text-success'
                        }`}>
                          ⏱ {getTimeRemaining(linkedCo.expires_at)}
                        </span>
                      ) : linkedCo && !linkedActive ? (
                        <span className="ml-3 text-xs font-semibold px-2 py-0.5 rounded-full bg-danger-dim text-danger">
                          {linkedCo.status === 'CheckedIn' ? 'Checked in — password scrambled' : 'Checkout expired'}
                        </span>
                      ) : profile.expired ? (
                        <span className="ml-3 text-xs font-semibold px-2 py-0.5 rounded-full bg-danger-dim text-danger">
                          Expired — update required
                        </span>
                      ) : (
                        <span className="ml-3 text-xs text-txt-tertiary">
                          Expires {formatDateTime(profile.expires_at)}
                        </span>
                      )}
                      {profile.checkout_id && (
                        <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                          🔗 Checkout linked
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="btn !px-2 !py-1 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing({ id: profile.id, label: profile.label, username: '', password: '', ttl_hours: profile.ttl_hours });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn !px-2 !py-1 text-xs text-danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletingId(profile.id);
                      }}
                    >
                      Delete
                    </button>
                    <svg
                      className={`shrink-0 text-txt-tertiary transition-transform duration-250 ${isExpanded ? 'rotate-180' : ''}`}
                      width="16" height="16" viewBox="0 0 16 16" fill="none"
                    >
                      <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </div>

                {/* Expanded: mappings */}
                {isExpanded && (
                  <div className="px-5 py-4" style={{ background: 'var(--color-surface)' }}>
                    {profileMappings.length > 0 ? (
                      <table className="w-full" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th>Connection</th>
                            <th>Protocol</th>
                            <th style={{ width: 80 }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {profileMappings.map((m) => (
                            <tr key={m.connection_id}>
                              <td className="font-medium">{m.connection_name}</td>
                              <td>
                                <span className="text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                                  style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)' }}>
                                  {m.protocol}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="btn !px-2 !py-1 text-xs text-danger"
                                  onClick={() => handleRemoveMapping(m.connection_id)}
                                >
                                  Unmap
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="text-txt-tertiary text-sm mb-3">
                        No connections mapped. Add a connection below so these credentials are used automatically.
                      </p>
                    )}

                    {/* Linked checkout badge / link controls */}
                    {!profile.label.startsWith('[managed]') && (activeCheckouts.filter((c) => isCheckoutLive(c)).length > 0 || profile.checkout_id) && (
                      <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
                        <label className="text-xs font-medium text-txt-secondary mb-2 block uppercase tracking-wider">Checked-Out Account</label>
                        {profile.checkout_id ? (() => {
                          const linked = allCheckouts.find((c) => c.id === profile.checkout_id);
                          return (
                            <div className="flex items-center justify-between bg-success/5 border border-success/20 rounded-lg px-4 py-2.5">
                              <div>
                                <div className="text-sm font-medium">{linked?.managed_ad_dn || 'Linked checkout'}</div>
                                <div className="text-xs text-txt-secondary">
                                  {linked && isCheckoutLive(linked)
                                    ? `Expires ${formatDateTime(linked.expires_at ?? null)} · ${getTimeRemaining(linked.expires_at!)}`
                                    : linked?.status === 'CheckedIn' ? 'Checked in — password scrambled'
                                    : linked?.status === 'Expired' || (linked && isCheckoutExpired(linked)) ? 'Checkout expired — credentials may be stale' : 'Unknown status'}
                                </div>
                              </div>
                              <button
                                className="btn !px-2 !py-1 text-xs text-danger"
                                onClick={() => handleLinkCheckout(profile.id, null)}
                              >
                                Unlink
                              </button>
                            </div>
                          );
                        })() : linkingProfileId === profile.id ? (
                          <div>
                            <Select
                              value=""
                              onChange={(val) => {
                                if (val) handleLinkCheckout(profile.id, val);
                              }}
                              placeholder="Select an active checkout…"
                              className="w-full mb-2"
                              options={activeCheckouts
                                .filter((c) => isCheckoutLive(c))
                                .map((c) => ({
                                  value: c.id,
                                  label: `${c.managed_ad_dn} — ${getTimeRemaining(c.expires_at)}`,
                                }))}
                            />
                            <button className="btn text-xs" onClick={() => setLinkingProfileId(null)}>Cancel</button>
                          </div>
                        ) : (
                          <button
                            className="btn text-xs"
                            onClick={() => setLinkingProfileId(profile.id)}
                          >
                            <span className="flex items-center gap-1.5">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                              </svg>
                              Link Checked-Out Account
                            </span>
                          </button>
                        )}
                      </div>
                    )}

                    {/* Add mapping */}
                    {isAddingMapping ? (
                      <div className="mt-4" style={{ borderTop: profileMappings.length > 0 ? '1px solid var(--color-border)' : 'none', paddingTop: profileMappings.length > 0 ? '1rem' : 0 }}>
                        <label className="text-xs font-medium text-txt-secondary mb-1 block">Connections</label>
                        <div className="relative">
                          <div
                            ref={mappingTriggerRef}
                            className="cs-trigger cursor-pointer min-h-[2.5rem] flex flex-wrap items-center gap-1.5 !py-1.5"
                            onClick={() => setMappingDropdownOpen(!mappingDropdownOpen)}
                          >
                            {mappingConnectionIds.map((cid) => {
                              const conn = connections.find((c) => c.id === cid);
                              return conn ? (
                                <span key={cid} className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-accent-dim)', color: 'var(--color-accent-light)' }}>
                                  {conn.name}
                                  <button
                                    type="button"
                                    className="hover:text-danger ml-0.5"
                                    onClick={(e) => { e.stopPropagation(); setMappingConnectionIds(mappingConnectionIds.filter((id) => id !== cid)); }}
                                  >
                                    ×
                                  </button>
                                </span>
                              ) : null;
                            })}
                            {mappingConnectionIds.length === 0 && (
                              <span className="text-txt-tertiary text-sm">Select connections…</span>
                            )}
                            <svg
                              className={`shrink-0 ml-auto text-txt-tertiary transition-transform duration-250 ${mappingDropdownOpen ? 'rotate-180 text-accent' : ''}`}
                              width="16" height="16" viewBox="0 0 16 16" fill="none"
                            >
                              <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </div>
                          {mappingDropdownOpen && createPortal(
                            <div ref={mappingDropdownRef} className="rounded-md shadow-lg" style={{ ...menuStyle, background: 'var(--color-surface-elevated)', border: '1px solid var(--color-glass-border)' }}>
                              <div className="p-2 pb-0">
                                <input
                                  className="input w-full !text-sm"
                                  placeholder="Search connections…"
                                  value={mappingSearch}
                                  onChange={(e) => setMappingSearch(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  autoFocus
                                />
                              </div>
                              <ul className="max-h-52 overflow-y-auto list-none m-0 p-1" role="listbox">
                                {filteredAvailable.length === 0 && (
                                  <li className="px-3 py-2 text-sm text-txt-tertiary">No matching connections</li>
                                )}
                                {filteredAvailable.map((c) => {
                                  const isSelected = mappingConnectionIds.includes(c.id);
                                  return (
                                    <li
                                      key={c.id}
                                      role="option"
                                      aria-selected={isSelected}
                                      className="cs-option flex items-center gap-2 cursor-pointer"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setMappingConnectionIds(
                                          isSelected
                                            ? mappingConnectionIds.filter((id) => id !== c.id)
                                            : [...mappingConnectionIds, c.id]
                                        );
                                      }}
                                    >
                                      <span className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 ${isSelected ? 'bg-accent border-accent' : 'border-txt-tertiary'}`} style={isSelected ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : undefined}>
                                        {isSelected && (
                                          <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                                            <path d="M3 7L6 10L11 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                          </svg>
                                        )}
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <div className="text-sm truncate">{c.name} <span className="text-txt-tertiary">({c.protocol.toUpperCase()})</span></div>
                                        {c.description && <div className="text-xs text-txt-tertiary truncate">{c.description}</div>}
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>,
                            document.body
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-3">
                          <button className="btn-primary !py-[0.55rem]" onClick={handleAddMapping} disabled={mappingConnectionIds.length === 0}>
                            Map {mappingConnectionIds.length > 0 ? `(${mappingConnectionIds.length})` : ''}
                          </button>
                          <button className="btn !py-[0.55rem]" onClick={() => { setMappingProfileId(null); setMappingConnectionIds([]); setMappingSearch(''); }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="btn text-xs mt-3"
                        onClick={() => { setMappingProfileId(profile.id); setMappingConnectionIds([]); setMappingSearch(''); }}
                      >
                        <span className="flex items-center gap-1.5">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                          </svg>
                          Add Connections
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </>)}

      {/* ── Check-In Confirmation Modal ── */}
      {checkinId && createPortal(
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setCheckinId(null)}
        >
          <div 
            className="card max-w-sm w-full mx-4 shadow-2xl scale-in"
            onClick={e => e.stopPropagation()}
            style={{ border: '1px solid rgba(var(--accent-rgb, 139, 92, 246), 0.3)' }}
          >
            <div className="flex items-center gap-3 text-accent mb-4">
              <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
                </svg>
              </div>
              <h3 className="!mb-0">Check In Account?</h3>
            </div>
            
            <p className="text-txt-secondary text-sm mb-6">
              The password will be <span className="text-txt-primary font-semibold">scrambled in Active Directory</span> and the checkout will be ended. The account will become available for checkout again.
            </p>

            <div className="flex gap-3">
              <button 
                className="btn-primary flex-1"
                onClick={async () => {
                  const id = checkinId;
                  setCheckinId(null);
                  try {
                    setError('');
                    await checkinCheckout(id);
                    setRevealedPw((prev) => { const { [id]: _, ...rest } = prev; return rest; });
                    await load();
                  } catch (e: any) {
                    setError(e?.message || 'Check-in failed');
                  }
                }}
              >
                Check In
              </button>
              <button 
                className="btn flex-1"
                onClick={() => setCheckinId(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deletingId && createPortal(
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setDeletingId(null)}
        >
          <div 
            className="card max-w-sm w-full mx-4 shadow-2xl scale-in"
            onClick={e => e.stopPropagation()}
            style={{ border: '1px solid rgba(239, 68, 68, 0.2)' }}
          >
            <div className="flex items-center gap-3 text-danger mb-4">
              <div className="w-10 h-10 rounded-full bg-danger-dim flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
              </div>
              <h3 className="!mb-0">Delete Profile?</h3>
            </div>
            
            <p className="text-txt-secondary text-sm mb-6">
              Are you sure you want to delete <span className="text-txt-primary font-semibold">{profiles.find(p => p.id === deletingId)?.label}</span>? 
              This will unmap it from <span className="text-txt-primary font-semibold">{mappings[deletingId]?.length || 0}</span> connections. This action cannot be undone.
            </p>

            <div className="flex gap-3">
              <button 
                className="btn-primary flex-1 !bg-danger hover:!bg-danger-hover border-none"
                onClick={() => handleDeleteProfile(deletingId)}
              >
                Delete Permanently
              </button>
              <button 
                className="btn flex-1"
                onClick={() => setDeletingId(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
