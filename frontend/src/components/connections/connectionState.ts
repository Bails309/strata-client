/* Host reachability, credential lease and session runtime are independent
   signals; each gets its own type so the UI never folds them into one dot. */
import type { CheckoutRequest, Connection, CredentialProfile } from "../../api";
import type { GuacSession } from "../SessionManager";
import { isLeaseExpired } from "../leaseStore";

export type HostHealth = "ONLINE" | "OFFLINE" | "UNKNOWN";

export const HOST_HEALTH_LABEL: Record<HostHealth, string> = {
  ONLINE: "Reachable",
  OFFLINE: "Unreachable",
  UNKNOWN: "Unchecked",
};

export type CredentialLeaseStatus = "VALID" | "EXPIRED" | "UNASSIGNED";

export type SessionRuntimeState = "DISCONNECTED" | "CONNECTING" | "CONNECTED";

export interface TargetCredentialLease {
  status: CredentialLeaseStatus;
  accountName: string | null;
  expiresAt?: string;
  ttlRemainingSeconds?: number;
}

export interface TargetSessionState {
  state: SessionRuntimeState;
  sessionId?: string;
  connectedAt?: string;
  elapsedSeconds?: number;
}

export interface ConnectionTargetState {
  health: HostHealth;
  lease: TargetCredentialLease;
  session: TargetSessionState;
}

export function isCheckoutLive(c: CheckoutRequest, now = Date.now()): boolean {
  return c.status === "Active" && !!c.expires_at && Date.parse(c.expires_at) > now;
}

export function deriveHealth(conn: Pick<Connection, "health_status">): HostHealth {
  if (conn.health_status === "online") return "ONLINE";
  if (conn.health_status === "offline") return "OFFLINE";
  return "UNKNOWN";
}

export function deriveLease(
  profile: CredentialProfile | undefined,
  checkouts: CheckoutRequest[],
  now = Date.now()
): TargetCredentialLease {
  if (!profile) return { status: "UNASSIGNED", accountName: null };
  const accountName = profile.label;
  if (isLeaseExpired(profile, now)) return { status: "EXPIRED", accountName };

  let expiresMs = Date.parse(profile.expires_at);
  if (profile.checkout_id) {
    const checkout = checkouts.find((c) => c.id === profile.checkout_id);
    if (checkout) {
      if (!isCheckoutLive(checkout, now)) return { status: "EXPIRED", accountName };
      expiresMs = Math.min(expiresMs, Date.parse(checkout.expires_at!));
    }
  }
  if (!Number.isFinite(expiresMs)) return { status: "VALID", accountName };
  return {
    status: "VALID",
    accountName,
    expiresAt: new Date(expiresMs).toISOString(),
    ttlRemainingSeconds: Math.max(0, Math.floor((expiresMs - now) / 1000)),
  };
}

export function deriveSession(
  session: GuacSession | undefined,
  now = Date.now()
): TargetSessionState {
  if (!session || session.error) return { state: "DISCONNECTED" };
  // Guacamole.Tunnel.State: 0 CONNECTING, 1 OPEN, 2 CLOSED, 3 UNSTABLE.
  const tunnelState = session.tunnel?.state;
  if (tunnelState === 2) return { state: "DISCONNECTED" };
  return {
    state: tunnelState === 0 ? "CONNECTING" : "CONNECTED",
    sessionId: session.id,
    connectedAt: new Date(session.createdAt).toISOString(),
    elapsedSeconds: Math.max(0, Math.floor((now - session.createdAt) / 1000)),
  };
}

/** "<1m", "12m", "3h 5m", "2d 4h". */
export function formatDuration(secs: number): string {
  const mins = Math.floor(secs / 60);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
