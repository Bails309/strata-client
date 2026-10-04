import { describe, it, expect, vi, beforeEach } from "vitest";

// Order-of-operations recorder shared with the Guacamole mock below.
const events: string[] = [];
let nextStreamIndex = 0;

vi.mock("guacamole-common-js", () => {
  function MockStringWriter(this: any, stream: { index: number }) {
    this.onack = null;
    this.sendText = vi.fn(() => events.push(`text:${stream.index}`));
    this.sendEnd = vi.fn(() => events.push(`end:${stream.index}`));
  }
  return {
    default: {
      StringWriter: MockStringWriter,
    },
  };
});

import {
  sendClipboardToRemote,
  resetRemoteClipboardEcho,
  installClipboardDiagnostics,
  prepareRemotePaste,
  type ClipboardTarget,
} from "../components/clipboardSync";

function makeTarget(overrides: Partial<ClipboardTarget> = {}): ClipboardTarget {
  return {
    id: "sess-1",
    protocol: "rdp",
    remoteClipboard: "",
    tunnel: { state: 1 } as any,
    client: {
      createClipboardStream: vi.fn(() => {
        const index = nextStreamIndex++;
        events.push(`open:${index}`);
        return { index };
      }),
    } as any,
    ...overrides,
  };
}

describe("clipboardSync", () => {
  beforeEach(() => {
    events.length = 0;
    nextStreamIndex = 0;
    vi.clearAllMocks();
  });

  it("serialises concurrent pushes so two clipboard streams never interleave", async () => {
    // Regression guard for the copy/paste-stops-working bug: a single click
    // on the session display fires mouseenter + mousedown + focus (and, when
    // popped out, the popup's own pair). Each used to open its own clipboard
    // stream and, because the large-payload path awaits between chunks, the
    // `blob` instructions interleaved. guacd's RDP clipboard is one shared
    // buffer, so the remote ended up with a spliced payload and a CLIPRDR
    // channel that stayed wedged until the Windows session was logged off.
    const target = makeTarget();
    const big = "a".repeat(10_000);
    const other = "b".repeat(10_000);

    const [first, second] = await Promise.all([
      sendClipboardToRemote(target, big, "mouseenter"),
      sendClipboardToRemote(target, other, "mousedown"),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);

    // Every event for stream 0 must precede the opening of stream 1.
    const openSecond = events.indexOf("open:1");
    const endFirst = events.indexOf("end:0");
    expect(openSecond).toBeGreaterThan(-1);
    expect(endFirst).toBeGreaterThan(-1);
    expect(endFirst).toBeLessThan(openSecond);
  });

  it("suppresses a duplicate of the text the remote already holds", async () => {
    const target = makeTarget({ remoteClipboard: "hello" });
    expect(await sendClipboardToRemote(target, "hello", "mousedown")).toBe(false);
    expect(target.client.createClipboardStream).not.toHaveBeenCalled();
  });

  it("suppresses a duplicate that is still queued behind an in-flight send", async () => {
    const target = makeTarget();
    const text = "c".repeat(10_000);
    const [first, second] = await Promise.all([
      sendClipboardToRemote(target, text, "mouseenter"),
      sendClipboardToRemote(target, text, "mousedown"),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(target.client.createClipboardStream).toHaveBeenCalledTimes(1);
  });

  it("force bypasses duplicate suppression for explicit paste commands", async () => {
    const target = makeTarget({ remoteClipboard: "hello" });
    expect(await sendClipboardToRemote(target, "hello", "palette", { force: true })).toBe(true);
    expect(target.client.createClipboardStream).toHaveBeenCalledTimes(1);
  });

  it("refuses to send on a closed tunnel and leaves remoteClipboard untouched", async () => {
    // Sending into a dead tunnel used to still set `remoteClipboard`, which
    // permanently suppressed every later paste of the same text.
    const target = makeTarget({ tunnel: { state: 2 } as any });
    expect(await sendClipboardToRemote(target, "hello", "paste-event")).toBe(false);
    expect(target.client.createClipboardStream).not.toHaveBeenCalled();
    expect(target.remoteClipboard).toBe("");
  });

  it("resetRemoteClipboardEcho re-primes the remote after a reconnect", async () => {
    const target = makeTarget();
    expect(await sendClipboardToRemote(target, "hello", "mousedown")).toBe(true);
    expect(await sendClipboardToRemote(target, "hello", "mousedown")).toBe(false);

    resetRemoteClipboardEcho(target, "client-connected");

    expect(await sendClipboardToRemote(target, "hello", "mousedown")).toBe(true);
    expect(target.client.createClipboardStream).toHaveBeenCalledTimes(2);
  });

  it("records a redacted diagnostic trail retrievable from the console helper", async () => {
    installClipboardDiagnostics();
    const target = makeTarget();
    await sendClipboardToRemote(target, "secret-value", "mousedown");

    const dump = globalThis.strataClipboard!.dump();
    const trail = dump.filter((e) => e.sessionId === "sess-1").map((e) => e.event);
    expect(trail).toContain("queued");
    expect(trail).toContain("stream-open");
    expect(trail).toContain("stream-end");
    // Contents must never reach the log — only lengths and a digest.
    expect(JSON.stringify(dump)).not.toContain("secret-value");
  });

  it("pushes the local clipboard before a paste shortcut is let through", async () => {
    // Alt+Tab back into the browser fires no pointer or focus push, so the
    // paste keystroke itself has to bring the remote up to date.
    const target = makeTarget({ remoteClipboard: "stale" });
    const clipboard = { readText: vi.fn(async () => "fresh") } as unknown as Clipboard;

    await prepareRemotePaste(target, clipboard);

    expect(target.remoteClipboard).toBe("fresh");
    expect(events).toEqual(["open:0", "text:0", "end:0"]);
  });

  it("does not re-send or wait when the remote already holds the local text", async () => {
    vi.useFakeTimers();
    try {
      const target = makeTarget({ remoteClipboard: "same" });
      const clipboard = { readText: vi.fn(async () => "same") } as unknown as Clipboard;

      // Resolves without the settle timer ever being advanced.
      await prepareRemotePaste(target, clipboard);

      expect(target.client.createClipboardStream).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
