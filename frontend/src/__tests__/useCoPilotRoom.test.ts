/**
 * Tests for `co-pilot/useCoPilotRoom` — drives the hook with a fake
 * WebSocket so we exercise welcome / roster / cursor / chat / leave /
 * join_error paths plus the send-side actions without a real socket.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCoPilotRoom } from "../co-pilot/useCoPilotRoom";

type Listener = ((ev: { data: unknown }) => void) | null;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 1;
  onmessage: Listener = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  // Helper to push a server frame into the hook.
  emit(payload: unknown) {
    this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }
}

const OWNER = "00000000-0000-0000-0000-000000000001";
const SELF = "00000000-0000-0000-0000-000000000002";
const PEER = "00000000-0000-0000-0000-000000000003";

describe("useCoPilotRoom", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    // @ts-expect-error — installing fake WebSocket for the duration of the test
    globalThis.WebSocket = FakeWebSocket;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when disabled or token missing", () => {
    renderHook(() => useCoPilotRoom(undefined, "Alice", true));
    renderHook(() => useCoPilotRoom("tok", "Alice", false));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("opens a WS, processes welcome/roster/cursor/chat/leave and exposes ready+pid", () => {
    const { result } = renderHook(() => useCoPilotRoom("tok-A", "Alice", true));
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toContain("/api/shared/copilot/tok-A");
    expect(ws.url).toContain("name=Alice");

    // Non-string frames and non-envelope frames are ignored cleanly.
    act(() => {
      ws.onmessage?.({ data: 123 as unknown as string });
      ws.onmessage?.({ data: "0000," });
      ws.onmessage?.({ data: "{not json" });
    });

    act(() => {
      ws.emit({
        type: "welcome",
        pid: SELF,
        allow_chat: true,
        allow_audio: false,
        max_participants: 6,
        protocol_version: 1,
      });
    });
    expect(result.current[0].pid).toBe(SELF);
    expect(result.current[0].ready).toBe(true);
    expect(result.current[0].allowChat).toBe(true);
    expect(result.current[0].maxParticipants).toBe(6);

    act(() => {
      ws.emit({
        type: "roster",
        participants: [
          { pid: OWNER, name: "Owner", color: "#3b82f6", is_owner: true, has_input: true },
          { pid: SELF, name: "Alice", color: "#10b981", is_owner: false, has_input: false },
        ],
      });
    });
    expect(result.current[0].roster).toHaveLength(2);
    expect(result.current[0].hasInput).toBe(false);

    // Cursor from self is ignored; cursor from peer lands in the map.
    act(() => {
      ws.emit({ type: "cursor", pid: SELF, x: 10, y: 10, ts: 1 });
      ws.emit({ type: "cursor", pid: PEER, x: 50, y: 60, ts: 2 });
    });
    expect(result.current[0].cursors.has(SELF)).toBe(false);
    expect(result.current[0].cursors.get(PEER)?.x).toBe(50);

    act(() => {
      ws.emit({ type: "chat", pid: PEER, text: "hi", ts: 3 });
    });
    expect(result.current[0].chat).toHaveLength(1);
    expect(result.current[0].chat[0].text).toBe("hi");

    // Leave for a known peer removes their cursor; leave for unknown is a noop.
    act(() => {
      ws.emit({ type: "leave", pid: PEER });
      ws.emit({ type: "leave", pid: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
    });
    expect(result.current[0].cursors.has(PEER)).toBe(false);

    act(() => {
      ws.emit({ type: "join_error", reason: "room_full" });
    });
    expect(result.current[0].joinError).toBe("room_full");

    // onclose flips ready back to false.
    act(() => {
      ws.onclose?.();
    });
    expect(result.current[0].ready).toBe(false);
  });

  it("send-side actions are gated on welcome and produce envelopes", () => {
    const { result } = renderHook(() => useCoPilotRoom("tok-B", "Bob", true));
    const ws = FakeWebSocket.instances[0];

    // Before welcome, claim/release/chat are no-ops.
    act(() => {
      result.current[1].claimInput();
      result.current[1].releaseInput();
    });
    expect(ws.sent).toEqual([]);
    expect(result.current[1].sendChat("hi")).toBe(false);

    act(() => {
      ws.emit({
        type: "welcome",
        pid: SELF,
        allow_chat: true,
        allow_audio: false,
        max_participants: 4,
        protocol_version: 1,
      });
    });

    act(() => {
      expect(result.current[1].sendChat("   ")).toBe(false); // blank text rejected
      expect(result.current[1].sendChat("hello")).toBe(true);
      result.current[1].claimInput();
      result.current[1].releaseInput();
      result.current[1].sendCursor(7.4, 9.6);
      // Second cursor inside the throttle window is dropped.
      result.current[1].sendCursor(8, 10);
    });

    const types = ws.sent.map((s) => JSON.parse(s).type);
    expect(types).toContain("chat");
    expect(types).toContain("input_claim");
    expect(types).toContain("input_release");
    expect(types).toContain("cursor");

    const cursorFrame = JSON.parse(ws.sent.find((s) => JSON.parse(s).type === "cursor")!);
    expect(cursorFrame.x).toBe(7); // rounded
    expect(cursorFrame.y).toBe(10);
  });

  it("sendChat returns false when allow_chat is false", () => {
    const { result } = renderHook(() => useCoPilotRoom("tok-C", "Carol", true));
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.emit({
        type: "welcome",
        pid: SELF,
        allow_chat: false,
        allow_audio: false,
        max_participants: 2,
        protocol_version: 1,
      });
    });
    expect(result.current[1].sendChat("hi")).toBe(false);
  });

  it("closes the WS and resets state on unmount", () => {
    const { unmount, result } = renderHook(() => useCoPilotRoom("tok-D", "Dee", true));
    const ws = FakeWebSocket.instances[0];
    act(() => {
      ws.emit({
        type: "welcome",
        pid: SELF,
        allow_chat: true,
        allow_audio: false,
        max_participants: 2,
        protocol_version: 1,
      });
    });
    expect(result.current[0].ready).toBe(true);
    unmount();
    expect(ws.closed).toBe(true);
  });
});
