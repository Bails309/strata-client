import type { ReactNode } from "react";
import type { Connection } from "../../api";
import { formatDuration, HOST_HEALTH_LABEL, type ConnectionTargetState } from "./connectionState";

interface Props {
  conn: Connection;
  state: ConnectionTargetState;
  icon: ReactNode;
  lastAccessedLabel?: string;
  healthCheckedLabel?: string;
  onConnect: () => void;
  onResume: () => void;
  onDisconnect: () => void;
  onRenewAndConnect: () => void;
}

function KeyIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M11.5 11.5 21 2M17 6l3 3M15 8l2 2" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}

/** Quick-connect card: reachability, lease and live session shown separately. */
export default function ConnectionCard({
  conn,
  state,
  icon,
  lastAccessedLabel,
  healthCheckedLabel,
  onConnect,
  onResume,
  onDisconnect,
  onRenewAndConnect,
}: Props) {
  const { health, lease, session } = state;
  const isLive = session.state === "CONNECTED";
  const hasSession = session.state !== "DISCONNECTED";
  const isOffline = health === "OFFLINE";

  return (
    <div
      className={`recent-card${isLive ? " is-live" : ""}`}
      data-testid={`recent-card-${conn.id}`}
    >
      <div className="rc-body">
        <div className="rc-header">
          <div className="rc-identity">
            <div className="recent-card-icon-badge">{icon}</div>
            <div className="min-w-0">
              <h3 className="recent-card-title">{conn.name}</h3>
              <p className="rc-address">
                {conn.protocol.toUpperCase()} · {conn.hostname}:{conn.port}
              </p>
            </div>
          </div>

          {isLive ? (
            <span className="rc-live-pill">
              <span className="rc-dot animate-pulse" aria-hidden />
              LIVE
            </span>
          ) : session.state === "CONNECTING" ? (
            <span className="rc-health" data-health="unknown">
              Connecting…
            </span>
          ) : (
            <span
              className="rc-health"
              data-health={health.toLowerCase()}
              title={healthCheckedLabel ? `Checked: ${healthCheckedLabel}` : "Not yet checked"}
            >
              <span className="rc-dot" aria-hidden />
              {HOST_HEALTH_LABEL[health]}
            </span>
          )}
        </div>

        <div className="rc-lease-row">
          {lease.status === "VALID" && (
            <span className="rc-lease" data-lease="valid" title={lease.accountName ?? undefined}>
              <KeyIcon />
              <span className="rc-lease-text">
                {lease.accountName} · Valid
                {lease.ttlRemainingSeconds !== undefined &&
                  ` (${formatDuration(lease.ttlRemainingSeconds)} left)`}
              </span>
            </span>
          )}
          {lease.status === "EXPIRED" && (
            <span className="rc-lease" data-lease="expired" title={lease.accountName ?? undefined}>
              <AlertIcon />
              <span className="rc-lease-text">{lease.accountName || "Lease"} · Expired</span>
            </span>
          )}
          {lease.status === "UNASSIGNED" && (
            <span className="rc-lease" data-lease="unassigned">
              <UserIcon />
              <span className="rc-lease-text">Manual / prompt authentication</span>
            </span>
          )}
        </div>

        {lastAccessedLabel && (
          <p className="recent-card-meta">
            Last accessed: <span className="recent-card-meta-value">{lastAccessedLabel}</span>
          </p>
        )}
      </div>

      <div className="rc-actions">
        {hasSession ? (
          <>
            <button
              type="button"
              className="btn-connect-glass flex-1"
              data-variant="resume"
              onClick={onResume}
            >
              Resume
            </button>
            <button
              type="button"
              className="btn-connect-glass"
              data-variant="danger"
              onClick={onDisconnect}
            >
              Disconnect
            </button>
          </>
        ) : lease.status === "EXPIRED" ? (
          <button
            type="button"
            className="btn-connect-glass w-full"
            data-variant="renew"
            onClick={onRenewAndConnect}
            disabled={isOffline}
            title={isOffline ? "Host is unreachable" : undefined}
          >
            Renew Lease &amp; Connect
          </button>
        ) : (
          <button
            type="button"
            className="btn-connect-glass w-full"
            onClick={onConnect}
            disabled={isOffline}
            title={isOffline ? "Host is unreachable" : undefined}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="none"
              aria-hidden
            >
              <polygon points="5,3 19,12 5,21" />
            </svg>
            Connect
          </button>
        )}
      </div>
    </div>
  );
}
