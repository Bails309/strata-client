/* Shared snapshot of the user's credential profiles ("leases").
   CredentialProfileExpiryWatcher owns the polling and publishes each fetch
   here, so the header indicator and lease drawer never poll on their own. */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CredentialProfile } from "../api";

const MANAGED_PREFIX = "[managed] ";

/** Drops `[managed]` profiles whose account is already reached through a
 *  profile linked to its checkout; that profile carries the same lease. */
export function withoutLinkedManagedProfiles(profiles: CredentialProfile[]): CredentialProfile[] {
  const linkedDns = new Set(
    profiles.flatMap((p) => (p.managed_ad_dn ? [p.managed_ad_dn.toLowerCase()] : []))
  );
  return profiles.filter(
    (p) =>
      !p.label.startsWith(MANAGED_PREFIX) ||
      !linkedDns.has(p.label.slice(MANAGED_PREFIX.length).toLowerCase())
  );
}

interface LeaseSnapshot {
  profiles: CredentialProfile[] | null;
  fetchedAt: number;
}

let snapshot: LeaseSnapshot = { profiles: null, fetchedAt: 0 };
let refresher: (() => Promise<void>) | null = null;
const listeners = new Set<() => void>();

export function publishLeases(profiles: CredentialProfile[]): void {
  snapshot = { profiles, fetchedAt: Date.now() };
  listeners.forEach((l) => l());
}

/** Registers the function that re-fetches profiles; returns an unregister. */
export function registerLeaseRefresher(fn: () => Promise<void>): () => void {
  refresher = fn;
  return () => {
    if (refresher === fn) refresher = null;
  };
}

/** Re-fetch now (e.g. after a bulk extend / check-in). */
export async function refreshLeases(): Promise<void> {
  if (refresher) await refresher();
}

export function resetLeases(): void {
  snapshot = { profiles: null, fetchedAt: 0 };
  refresher = null;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLeases(): LeaseSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Current time, refreshed every `intervalMs` so relative labels stay fresh. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export type LeaseKind = "local" | "jit" | "checkout";

/** Toast keys used by the expiry watcher; the lease manager clears them. */
export const EXPIRED_TOAST = "cred-expiry:expired";
export const WARNING_TOAST = "cred-expiry:warning";

export function leaseKind(p: CredentialProfile): LeaseKind {
  if (p.kind === "safeguard") return "jit";
  if (p.checkout_id) return "checkout";
  return "local";
}

/** Only Safeguard JIT leases can be re-issued without user input. */
export function canRenewInPlace(p: CredentialProfile): boolean {
  return leaseKind(p) === "jit";
}

export function isLeaseExpired(p: CredentialProfile, now = Date.now()): boolean {
  const at = Date.parse(p.expires_at);
  return p.expired || (Number.isFinite(at) && at <= now);
}

/** "just now", "3m ago", "2h ago", "4d ago". */
export function formatAgo(ms: number, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - ms) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "45s", "12m", "3h 5m", "2d 4h". */
export function formatLeft(ms: number, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((ms - now) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** "less than a minute", "12 minutes", "3 hours 5 minutes", "6 days". Rounds to
 *  the nearest minute so a lease polled a few ms late still reads "6 days". */
export function formatRemaining(ms: number, now = Date.now()): string {
  const totalMins = Math.round(Math.max(0, ms - now) / 60_000);
  if (totalMins < 1) return "less than a minute";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0)
    return hours ? `${plural(days, "day")} ${plural(hours, "hour")}` : plural(days, "day");
  if (hours > 0)
    return mins ? `${plural(hours, "hour")} ${plural(mins, "minute")}` : plural(hours, "hour");
  return plural(mins, "minute");
}
