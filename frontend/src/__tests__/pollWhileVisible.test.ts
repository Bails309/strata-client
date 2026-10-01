import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollWhileVisible } from "../components/pollWhileVisible";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("pollWhileVisible", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it("runs at once and then after each interval", async () => {
    const task = vi.fn(async () => {});
    const stop = pollWhileVisible(task, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("never overlaps a slow run", async () => {
    let release!: () => void;
    const task = vi.fn(() => new Promise<void>((r) => (release = r)));
    const stop = pollWhileVisible(task, 100);
    await vi.advanceTimersByTimeAsync(1000);
    window.dispatchEvent(new Event("focus"));
    expect(task).toHaveBeenCalledTimes(1);
    release();
    stop();
  });

  it("pauses while hidden and catches up when shown", async () => {
    const task = vi.fn(async () => {});
    const stop = pollWhileVisible(task, 1000);
    await vi.advanceTimersByTimeAsync(0);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps polling after a failed run", async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    const stop = pollWhileVisible(task, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });
});
