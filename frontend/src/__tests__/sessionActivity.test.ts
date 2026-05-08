import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  notifySessionActivity,
  SESSION_ACTIVITY_EVENT,
} from "../components/sessionActivity";

describe("sessionActivity bus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Anchor the system clock; module-level throttle state from a prior
    // test is invalidated by jumping the clock far ahead.
    vi.setSystemTime(new Date(2030, 0, 1, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches the bus event on the window", () => {
    const handler = vi.fn();
    window.addEventListener(SESSION_ACTIVITY_EVENT, handler);
    notifySessionActivity();
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_ACTIVITY_EVENT, handler);
  });

  it("throttles repeated calls to at most one event per second", () => {
    const handler = vi.fn();
    window.addEventListener(SESSION_ACTIVITY_EVENT, handler);
    // Jump forward so the previous test's throttle entry is stale.
    vi.setSystemTime(new Date(2030, 0, 2, 12, 0, 0));
    notifySessionActivity();
    notifySessionActivity();
    notifySessionActivity();
    expect(handler).toHaveBeenCalledTimes(1);

    // Advance system clock past the 1s throttle window
    vi.setSystemTime(new Date(2030, 0, 2, 12, 0, 2));
    notifySessionActivity();
    expect(handler).toHaveBeenCalledTimes(2);
    window.removeEventListener(SESSION_ACTIVITY_EVENT, handler);
  });
});
