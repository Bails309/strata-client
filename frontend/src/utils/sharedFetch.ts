// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Background data that every open tab polls, fetched about once per
 * `maxAgeMs` however many tabs are open (PERF-15).
 *
 * A fetch runs under a Web Lock for its key and first reuses a result that
 * any tab started fetching less than `maxAgeMs` ago; results reach the
 * other tabs over a BroadcastChannel and are kept in memory only. Calls
 * made while a fetch for the same key is in flight in this tab share it.
 * Where Web Locks or BroadcastChannel are missing, each tab fetches for
 * itself.
 */

const CHANNEL_NAME = "strata-shared-fetch";

type Message =
  | { type: "result"; key: string; at: number; data: unknown }
  | { type: "invalidate"; key?: string; at: number };

/** Results, stamped with when their fetch started. */
const latest = new Map<string, { at: number; data: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();
const invalidatedAt = new Map<string, number>();
let allInvalidatedAt = 0;
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
    // Node (tests) would otherwise keep the process alive for the channel.
    (channel as { unref?: () => void } | null)?.unref?.();
    channel?.addEventListener("message", (event: MessageEvent<Message>) => {
      const m = event.data;
      if (typeof m?.at !== "number") return;
      if (m.type === "result" && typeof m.key === "string") accept(m.key, m.at, m.data);
      else if (m.type === "invalidate") forget(m.key, m.at);
    });
  }
  return channel;
}

// Listen from the start, so this tab already has whatever the others fetch.
getChannel();

/** Keep a result unless its fetch began before the key was last invalidated. */
function accept(key: string, at: number, data: unknown) {
  if (at <= Math.max(allInvalidatedAt, invalidatedAt.get(key) ?? 0)) return;
  const current = latest.get(key);
  if (!current || current.at < at) latest.set(key, { at, data });
}

function forget(key: string | undefined, at: number) {
  if (key === undefined) {
    allInvalidatedAt = Math.max(allInvalidatedAt, at);
    latest.clear();
    inFlight.clear();
  } else {
    invalidatedAt.set(key, Math.max(invalidatedAt.get(key) ?? 0, at));
    latest.delete(key);
    inFlight.delete(key);
  }
}

export function sharedFetch<T>(
  key: string,
  maxAgeMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const attempt = async (): Promise<T> => {
    const cached = latest.get(key);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.data as T;
    const at = Date.now();
    const data = await fetcher();
    accept(key, at, data);
    getChannel()?.postMessage({ type: "result", key, at, data } satisfies Message);
    return data;
  };

  getChannel();
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const run = locks ? locks.request(`${CHANNEL_NAME}:${key}`, attempt) : attempt();
  const shared: Promise<T> = run.finally(() => {
    if (inFlight.get(key) === shared) inFlight.delete(key);
  });
  inFlight.set(key, shared);
  return shared;
}

/**
 * Make the next fetch of `key` (or of everything) go to the server, in every
 * tab: after a change the user made, or when the signed-in user changes.
 */
export function invalidateSharedFetch(key?: string): void {
  const at = Date.now();
  forget(key, at);
  getChannel()?.postMessage({ type: "invalidate", key, at } satisfies Message);
}
