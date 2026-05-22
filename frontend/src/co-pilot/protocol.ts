/**
 * TypeScript mirror of `backend/src/services/co_pilot.rs` envelope
 * types. Kept hand-written (rather than generated) because the surface
 * is small and we want exact control over `null` vs `undefined`
 * semantics for the optional defaults.
 *
 * Wire contract: serde external-tag with `rename_all = "snake_case"`,
 * so the discriminator is `type` and lives at the top level.
 */

/** Server-side hard cap on participants per room. Mirror of `co_pilot::MAX_PARTICIPANTS`. */
export const MAX_PARTICIPANTS = 6;

export const PROTOCOL_VERSION = 1;

/** Stable hex palette used for participant cursor colouring (round-robin). */
export const COLOR_PALETTE: readonly string[] = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
];

export interface RosterEntry {
  pid: string;
  display_name: string;
  color: string;
  has_input: boolean;
  is_owner: boolean;
}

export type CoPilotMsg =
  | {
      type: "hello";
      display_name: string;
      want_audio?: boolean;
      protocol_version?: number;
    }
  | {
      type: "welcome";
      pid: string;
      allow_chat: boolean;
      allow_audio: boolean;
      max_participants: number;
    }
  | { type: "roster"; participants: RosterEntry[] }
  | { type: "cursor"; pid: string; x: number; y: number; ts: number }
  | { type: "chat"; pid: string; text: string; ts: number }
  | { type: "input_claim"; pid: string }
  | { type: "input_release"; pid: string }
  | { type: "input_grant"; pid: string; by: string }
  | { type: "input_revoke"; by: string; reason: string }
  | { type: "audio_offer"; pid: string; to: string; sdp: string }
  | { type: "audio_answer"; pid: string; to: string; sdp: string }
  | { type: "ice"; pid: string; to: string; candidate: string }
  | { type: "leave"; pid: string }
  // Wire-only fatal — sent by the server before close on join failure.
  | { type: "join_error"; reason: "room_full" | "empty_name" | string };

/** Cheap discriminator-free check used to differentiate envelopes from Guacamole frames. */
export function looksLikeEnvelope(frame: string): boolean {
  return frame.length > 0 && frame.charCodeAt(0) === 123 /* '{' */;
}
