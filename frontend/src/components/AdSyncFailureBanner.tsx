import { useEffect, useState } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { getFailingAdSyncs, type FailingAdSync } from "../api";
import { pollWhileVisible } from "./pollWhileVisible";

const POLL_MS = 60_000;

/** "45 minutes", "3 hours", "2 days": how long a source has been failing. */
export function failingFor(since: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - new Date(since).getTime()) / 60_000));
  const [n, unit] =
    minutes < 90
      ? [minutes, "minute"]
      : minutes < 36 * 60
        ? [Math.round(minutes / 60), "hour"]
        : [Math.round(minutes / 1440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Names every enabled AD sync source that has failed since its last
 * successful run. Renders nothing while all sources are healthy, or for a
 * user who cannot read AD sync status.
 */
export default function AdSyncFailureBanner({
  reloadKey = 0,
  linkToAdSync = false,
  onViewHistory,
  onFailingChange,
}: {
  /** Change to refetch at once, e.g. after "Sync Now". */
  reloadKey?: number;
  linkToAdSync?: boolean;
  onViewHistory?: (configId: string) => void;
  onFailingChange?: (failing: FailingAdSync[]) => void;
}) {
  const [failing, setFailing] = useState<FailingAdSync[]>([]);
  const inRouter = useInRouterContext();

  useEffect(() => {
    let cancelled = false;
    const stop = pollWhileVisible(async () => {
      try {
        const rows = (await getFailingAdSyncs()) ?? [];
        if (cancelled) return;
        setFailing(rows);
        onFailingChange?.(rows);
      } catch {
        // 403 for non-admins, or a transient error: show nothing.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [reloadKey, onFailingChange]);

  if (failing.length === 0) return null;

  return (
    <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-semibold text-danger">
            {failing.length === 1
              ? "An AD sync source is failing"
              : `${failing.length} AD sync sources are failing`}
          </p>
          <p className="mt-1 text-txt-secondary">
            Connections from {failing.length === 1 ? "this source are" : "these sources are"} not
            being created, updated or removed until the sync succeeds again.
          </p>
          <ul className="mt-2 space-y-2">
            {failing.map((f) => (
              <li key={f.config_id}>
                <span className="font-medium text-txt-primary">{f.label}</span>{" "}
                <span className="text-txt-secondary">
                  ({f.protocol.toUpperCase()}): failing for {failingFor(f.failing_since)},{" "}
                  {f.failures} failed {f.failures === 1 ? "run" : "runs"}
                </span>
                {f.last_error && (
                  <code className="mt-1 block break-words text-xs text-danger">
                    {f.last_error}
                  </code>
                )}
                {onViewHistory && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm mt-1"
                    onClick={() => onViewHistory(f.config_id)}
                  >
                    History
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
        {linkToAdSync && inRouter && (
          <Link to="/admin/ad-sync" className="btn btn-secondary btn-sm shrink-0">
            Open AD Sync
          </Link>
        )}
      </div>
    </div>
  );
}
