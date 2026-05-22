import { describe, it, expect } from "vitest";
import {
  COLOR_PALETTE,
  MAX_PARTICIPANTS,
  PROTOCOL_VERSION,
  looksLikeEnvelope,
  type CoPilotMsg,
  type RosterEntry,
} from "../co-pilot/protocol";

describe("co-pilot/protocol", () => {
  it("exposes the room hard cap as a positive integer matching the backend constant", () => {
    expect(MAX_PARTICIPANTS).toBe(6);
    expect(Number.isInteger(MAX_PARTICIPANTS)).toBe(true);
  });

  it("declares a stable protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("exports an 8-colour hex palette with no duplicates", () => {
    expect(COLOR_PALETTE).toHaveLength(8);
    expect(new Set(COLOR_PALETTE).size).toBe(8);
    for (const c of COLOR_PALETTE) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  describe("looksLikeEnvelope", () => {
    it("returns true for any frame starting with '{'", () => {
      expect(looksLikeEnvelope('{"type":"cursor"}')).toBe(true);
      expect(looksLikeEnvelope("{")).toBe(true);
      expect(looksLikeEnvelope('{ "x": 1 }')).toBe(true);
    });

    it("returns false for Guacamole frames and other non-JSON inputs", () => {
      expect(looksLikeEnvelope("4.sync,13.1700000000000;")).toBe(false);
      expect(looksLikeEnvelope("3.nop;")).toBe(false);
      expect(looksLikeEnvelope("[")).toBe(false);
      expect(looksLikeEnvelope("hello")).toBe(false);
    });

    it("returns false for the empty string", () => {
      expect(looksLikeEnvelope("")).toBe(false);
    });
  });

  it("accepts every documented envelope variant at the type level", () => {
    const samples: CoPilotMsg[] = [
      { type: "hello", display_name: "Alice", want_audio: false, protocol_version: 1 },
      { type: "welcome", pid: "p1", allow_chat: true, allow_audio: false, max_participants: 6 },
      { type: "roster", participants: [] },
      { type: "cursor", pid: "p1", x: 1, y: 2, ts: 3 },
      { type: "chat", pid: "p1", text: "hi", ts: 0 },
      { type: "input_claim", pid: "p1" },
      { type: "input_release", pid: "p1" },
      { type: "input_grant", pid: "p1", by: "p0" },
      { type: "input_revoke", by: "p0", reason: "owner takeover" },
      { type: "audio_offer", pid: "p1", to: "p2", sdp: "v=0" },
      { type: "audio_answer", pid: "p2", to: "p1", sdp: "v=0" },
      { type: "ice", pid: "p1", to: "p2", candidate: "candidate:1 ..." },
      { type: "leave", pid: "p1" },
      { type: "join_error", reason: "room_full" },
      { type: "join_error", reason: "empty_name" },
    ];
    expect(samples).toHaveLength(15);
    // Touch the discriminator on every variant so the union really
    // round-trips through a real read, not just a type-only annotation.
    for (const env of samples) {
      expect(typeof env.type).toBe("string");
    }
  });

  it("matches the RosterEntry shape used in roster envelopes", () => {
    const entry: RosterEntry = {
      pid: "p1",
      display_name: "Alice",
      color: COLOR_PALETTE[0],
      has_input: true,
      is_owner: false,
    };
    expect(entry.color).toBe("#3b82f6");
    expect(entry.has_input).toBe(true);
    expect(entry.is_owner).toBe(false);
  });
});
