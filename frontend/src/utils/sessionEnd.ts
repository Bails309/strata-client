/**
 * How to present the end of a remote session.
 *
 * The gateway ends a session with a Guacamole `error` instruction whose
 * status code says what kind of end it was (sign-out, idle timeout,
 * network loss, ...) and whose text says what happened. The code picks
 * the title; the text is shown as-is.
 */

/** Guacamole status codes the gateway ends sessions with. */
export const SessionEndStatus = {
  SERVER_ERROR: 0x0200,
  UPSTREAM_TIMEOUT: 0x0202,
  UPSTREAM_ERROR: 0x0203,
  UPSTREAM_NOT_FOUND: 0x0207,
  UPSTREAM_UNAVAILABLE: 0x0208,
  SESSION_CONFLICT: 0x0209,
  SESSION_TIMEOUT: 0x020a,
  SESSION_CLOSED: 0x020b,
  CLIENT_UNAUTHORIZED: 0x0301,
  CLIENT_FORBIDDEN: 0x0303,
} as const;

export interface SessionEndInfo {
  /** Heading for the full-screen overlay. */
  title: string;
  /** Short label for the session thumbnail. */
  label: string;
  /** Terminated by a Strata administrator; reconnecting is not offered. */
  terminatedByAdmin: boolean;
}

const BY_STATUS: Record<number, [title: string, label: string]> = {
  [SessionEndStatus.SESSION_CLOSED]: ["Session Ended", "Ended Remotely"],
  [SessionEndStatus.SESSION_TIMEOUT]: ["Session Timed Out", "Idle Timeout"],
  [SessionEndStatus.SESSION_CONFLICT]: ["Session Disconnected", "Disconnected Remotely"],
  [SessionEndStatus.UPSTREAM_TIMEOUT]: ["Connection Lost", "Connection Lost"],
  [SessionEndStatus.UPSTREAM_ERROR]: ["Connection Lost", "Connection Lost"],
  [SessionEndStatus.UPSTREAM_NOT_FOUND]: ["Connection Lost", "Connection Lost"],
  [SessionEndStatus.UPSTREAM_UNAVAILABLE]: ["Connection Refused", "Connection Refused"],
  [SessionEndStatus.CLIENT_UNAUTHORIZED]: ["Access Denied", "Access Denied"],
  [SessionEndStatus.CLIENT_FORBIDDEN]: ["Access Denied", "Access Denied"],
};

export function describeSessionEnd(message: string, code?: number): SessionEndInfo {
  const lower = message.toLowerCase();
  if (lower.includes("terminated")) {
    return { title: "Session Terminated", label: "Terminated by Admin", terminatedByAdmin: true };
  }
  const known = code === undefined ? undefined : BY_STATUS[code];
  if (known) {
    return { title: known[0], label: known[1], terminatedByAdmin: false };
  }
  // No status: a clean close with nothing said, or a client-side failure.
  if (lower.includes("session has ended")) {
    return { title: "Session Ended", label: "Ended", terminatedByAdmin: false };
  }
  if (lower.startsWith("connection lost")) {
    return { title: "Connection Lost", label: "Connection Lost", terminatedByAdmin: false };
  }
  return {
    title: "Connection Error",
    label: code === undefined ? "Connection Lost" : "Connection Error",
    terminatedByAdmin: false,
  };
}
