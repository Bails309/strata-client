/* Pending-approval count published by PendingApprovalWatcher, so the
   sidebar badge reuses its poll instead of starting another. */
import { useSyncExternalStore } from "react";

let count = 0;
const listeners = new Set<() => void>();

export function publishPendingApprovals(n: number): void {
  if (n === count) return;
  count = n;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingApprovalsCount(): number {
  return useSyncExternalStore(subscribe, () => count);
}
