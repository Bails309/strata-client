import { useCallback, useEffect, useRef, useState } from "react";
import type { CoPilotMsg, RosterEntry } from "./protocol";
import { looksLikeEnvelope } from "./protocol";

/**
 * Per-participant live cursor position. Decays after `CURSOR_TTL_MS`
 * with no fresh update — prevents stuck cursors when a peer drops.
 */
export interface RemoteCursor {
  pid: string;
  x: number;
  y: number;
  ts: number;
}

const CURSOR_TTL_MS = 8_000;
/** Soft cap on the in-memory chat ring so a long session can't OOM. */
const MAX_CHAT_HISTORY = 200;

export interface ChatMessage {
  /** Local-only id: server doesn't echo a stamp, so we synthesise one. */
  id: string;
  pid: string;
  text: string;
  ts: number;
}

export interface CoPilotRoomState {
  /** `null` until the server has issued a `Welcome`. */
  pid: string | null;
  allowChat: boolean;
  allowAudio: boolean;
  maxParticipants: number;
  roster: RosterEntry[];
  cursors: Map<string, RemoteCursor>;
  chat: ChatMessage[];
  hasInput: boolean;
  /** Last fatal join error, if any. */
  joinError: string | null;
  /** `true` once the WS is open AND `Welcome` has been received. */
  ready: boolean;
}

export interface CoPilotRoomActions {
  sendCursor: (x: number, y: number) => void;
  sendChat: (text: string) => boolean;
  claimInput: () => void;
  releaseInput: () => void;
}

/** Throttle cursor sends to ~30 Hz to keep the WS quiet. */
const CURSOR_THROTTLE_MS = 1000 / 30;

/**
 * Manages the co-pilot WebSocket for one participant. The screen +
 * input tunnel is a separate WS owned by `SharedViewer.tsx`; the two
 * are correlated server-side via the `pid` we obtain here.
 *
 * When `asOwner` is true, the hook connects to the authenticated owner
 * endpoint at `/api/user/shared/copilot/:share_token` instead of the
 * public `/api/shared/copilot/:share_token`. The server verifies the
 * caller owns the share and joins the room with `is_owner = true`,
 * which unlocks owner force-grant and the implicit input-token hold.
 */
export function useCoPilotRoom(
  shareToken: string | undefined,
  displayName: string,
  enabled: boolean,
  asOwner: boolean = false
): [CoPilotRoomState, CoPilotRoomActions] {
  const [pid, setPid] = useState<string | null>(null);
  const [allowChat, setAllowChat] = useState(false);
  const [allowAudio, setAllowAudio] = useState(false);
  const [maxParticipants, setMaxParticipants] = useState(1);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [cursors, setCursors] = useState<Map<string, RemoteCursor>>(() => new Map());
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pidRef = useRef<string | null>(null);
  const lastCursorSentRef = useRef(0);

  // Sweep stale cursors so a peer that dropped without a clean leave
  // doesn't leave a frozen pointer on screen.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      const now = Date.now();
      setCursors((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [k, v] of next) {
          if (now - v.ts > CURSOR_TTL_MS) {
            next.delete(k);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !shareToken) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Owner uses the authenticated endpoint so the server joins the
    // room with `is_owner = true`. Viewers use the public endpoint and
    // pass their display name in the query string (owner's name comes
    // from `AuthUser` server-side).
    const path = asOwner
      ? `/api/user/shared/copilot/${encodeURIComponent(shareToken)}`
      : `/api/shared/copilot/${encodeURIComponent(shareToken)}?name=${encodeURIComponent(
          displayName || "Guest"
        )}`;
    const url = `${proto}//${window.location.host}${path}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      if (!looksLikeEnvelope(ev.data)) return;
      let msg: CoPilotMsg;
      try {
        msg = JSON.parse(ev.data) as CoPilotMsg;
      } catch {
        return;
      }
      switch (msg.type) {
        case "welcome":
          pidRef.current = msg.pid;
          setPid(msg.pid);
          setAllowChat(msg.allow_chat);
          setAllowAudio(msg.allow_audio);
          setMaxParticipants(msg.max_participants);
          setReady(true);
          break;
        case "roster":
          setRoster(msg.participants);
          break;
        case "cursor": {
          if (msg.pid === pidRef.current) break;
          setCursors((prev) => {
            const next = new Map(prev);
            next.set(msg.pid, { pid: msg.pid, x: msg.x, y: msg.y, ts: Date.now() });
            return next;
          });
          break;
        }
        case "chat":
          setChat((prev) => {
            const entry: ChatMessage = {
              id: `${msg.pid}-${msg.ts}-${prev.length}`,
              pid: msg.pid,
              text: msg.text,
              ts: msg.ts,
            };
            const next = [...prev, entry];
            return next.length > MAX_CHAT_HISTORY
              ? next.slice(next.length - MAX_CHAT_HISTORY)
              : next;
          });
          break;
        case "leave":
          setCursors((prev) => {
            if (!prev.has(msg.pid)) return prev;
            const next = new Map(prev);
            next.delete(msg.pid);
            return next;
          });
          break;
        case "join_error":
          setJoinError(msg.reason);
          break;
        // input_grant / input_revoke are reflected via the `has_input`
        // flag in the next Roster broadcast, so no extra handling here.
        default:
          break;
      }
    };

    ws.onclose = () => {
      setReady(false);
    };

    return () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
      pidRef.current = null;
      setReady(false);
      setPid(null);
      setRoster([]);
      setCursors(new Map());
    };
    // shareToken / displayName are read once at connect time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, shareToken]);

  const send = useCallback((msg: CoPilotMsg) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore — closed mid-flight */
    }
  }, []);

  const sendCursor = useCallback(
    (x: number, y: number) => {
      const now = Date.now();
      if (now - lastCursorSentRef.current < CURSOR_THROTTLE_MS) return;
      lastCursorSentRef.current = now;
      const self = pidRef.current;
      if (!self) return;
      send({ type: "cursor", pid: self, x: Math.round(x), y: Math.round(y), ts: now });
    },
    [send]
  );

  const sendChat = useCallback(
    (text: string) => {
      const self = pidRef.current;
      const trimmed = text.trim();
      if (!self || !trimmed || !allowChat) return false;
      send({ type: "chat", pid: self, text: trimmed, ts: Date.now() });
      return true;
    },
    [send, allowChat]
  );

  const claimInput = useCallback(() => {
    const self = pidRef.current;
    if (!self) return;
    send({ type: "input_claim", pid: self });
  }, [send]);

  const releaseInput = useCallback(() => {
    const self = pidRef.current;
    if (!self) return;
    send({ type: "input_release", pid: self });
  }, [send]);

  const hasInput = roster.find((p) => p.pid === pid)?.has_input ?? false;

  return [
    {
      pid,
      allowChat,
      allowAudio,
      maxParticipants,
      roster,
      cursors,
      chat,
      hasInput,
      joinError,
      ready,
    },
    { sendCursor, sendChat, claimInput, releaseInput },
  ];
}
