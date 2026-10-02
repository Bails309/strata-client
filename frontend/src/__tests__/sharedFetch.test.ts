import { describe, it, expect, vi, beforeEach } from "vitest";

type Mod = typeof import("../utils/sharedFetch");

/** A fresh copy of the module, standing in for another tab. */
async function tab(): Promise<Mod> {
  vi.resetModules();
  return import("../utils/sharedFetch");
}

/** Let BroadcastChannel deliver what has been posted. */
const delivered = () => new Promise((r) => setTimeout(r, 20));

describe("sharedFetch", () => {
  let a: Mod;
  beforeEach(async () => {
    a = await tab();
  });

  it("shares one in-flight request between callers in a tab", async () => {
    let release!: (v: number) => void;
    const fetcher = vi.fn(() => new Promise<number>((r) => (release = r)));
    const first = a.sharedFetch("k", 60_000, fetcher);
    const second = a.sharedFetch("k", 60_000, fetcher);
    release(7);
    expect(await first).toBe(7);
    expect(await second).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reuses a result until it is maxAge old", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetcher = vi.fn(async () => Date.now());
    await a.sharedFetch("k", 1000, fetcher);
    now.mockReturnValue(1_000_999);
    await a.sharedFetch("k", 1000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_001_000);
    await a.sharedFetch("k", 1000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("does not keep a failed fetch", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(3);
    await expect(a.sharedFetch("k", 60_000, fetcher)).rejects.toThrow("down");
    expect(await a.sharedFetch("k", 60_000, fetcher)).toBe(3);
  });

  it.runIf(typeof BroadcastChannel !== "undefined")(
    "lets another tab use the result instead of fetching",
    async () => {
      const b = await tab();
      const fetchA = vi.fn(async () => ({ pending: 2 }));
      const fetchB = vi.fn(async () => ({ pending: 99 }));
      await a.sharedFetch("approvals", 60_000, fetchA);
      await delivered();
      expect(await b.sharedFetch("approvals", 60_000, fetchB)).toEqual({ pending: 2 });
      expect(fetchB).not.toHaveBeenCalled();
    }
  );

  it.runIf(typeof BroadcastChannel !== "undefined")(
    "an invalidation in one tab makes every tab fetch again",
    async () => {
      const b = await tab();
      const fetcher = vi.fn(async () => 1);
      await a.sharedFetch("k", 60_000, fetcher);
      await delivered();
      b.invalidateSharedFetch();
      await delivered();
      await a.sharedFetch("k", 60_000, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  );

  it("drops a result whose fetch started before an invalidation", async () => {
    let release!: (v: string) => void;
    const slow = vi.fn(() => new Promise<string>((r) => (release = r)));
    const pending = a.sharedFetch("profiles", 60_000, slow);
    a.invalidateSharedFetch("profiles");
    release("old");
    expect(await pending).toBe("old");
    const fresh = vi.fn(async () => "new");
    expect(await a.sharedFetch("profiles", 60_000, fresh)).toBe("new");
  });
});
