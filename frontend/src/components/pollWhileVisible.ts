// Copyright 2026 Strata Client Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Run `task` now, then `intervalMs` after each run finishes, but only while
 * the page is visible (PERF-15). Hidden tabs make no requests; when a tab is
 * shown or focused again it catches up at once. Runs never overlap, so a slow
 * response cannot stack requests, and the focus and visibility events that
 * arrive together cost one request.
 *
 * Returns a function that stops polling.
 */
export function pollWhileVisible(task: () => unknown, intervalMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;

  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && !document.hidden) timer = setTimeout(run, intervalMs);
  };

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      await task();
    } catch {
      // Each caller reports its own failures; one bad poll must not end polling.
    } finally {
      running = false;
      schedule();
    }
  }

  const onWake = () => {
    if (document.hidden) clearTimeout(timer);
    else void run();
  };

  void run();
  window.addEventListener("focus", onWake);
  document.addEventListener("visibilitychange", onWake);

  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener("focus", onWake);
    document.removeEventListener("visibilitychange", onWake);
  };
}
